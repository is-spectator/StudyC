import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterGenerationProvider } from '../src/generation/provider.js';
import { partialChatAnswer } from '../src/generation/learning-output.js';
import type { ClaimedGeneration, GenerationProviderConfig, GenerationSnapshot } from '../src/generation/types.js';
const config: GenerationProviderConfig = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/model', outputMode: 'strict', maxOutputTokens: 3000, timeoutMs: 1500, providerOnly: [] };
const quote = '植物通过光合作用把太阳光中的能量转化为储存的化学能。';
const citation = { sourceId: 's1', quote };
const usage = { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, cost: 0.00001 };
function claim(promptVersion: GenerationSnapshot['promptVersion'] = 'chat-answer-v1', input: GenerationSnapshot['config'] = { language: 'zh-CN', question: '能量如何转化？', history: [] }): ClaimedGeneration {
  return { jobId: randomUUID(), attemptId: randomUUID(), userId: randomUUID(), studySetId: randomUUID(), attemptNumber: 1, leaseToken: randomUUID(), leaseExpiresAt: '2030-01-01T00:00:00Z', providerConfig: config,
    snapshot: { schemaVersion: 1, promptVersion, config: input, sources: [{ sourceId: 's1', materialId: randomUUID(), version: 3, title: '真实材料', body: quote,
      bodySha256: createHash('sha256').update(quote).digest('hex'), sourceFileId: null, pageProvenance: 'edited_material', pages: [] }] } };
}
const delta = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ id: 'gen-stream-fixture', choices: [{ delta: { content }, finish_reason: finish }] })}\r\n\r\n`;
const ending = () => `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
const answer = () => ({ answer: '植物把光能转化为化学能，并把它储存起来。', citations: [citation], insufficientEvidence: false });
function provider(response: () => Response) {
  const transport = vi.fn<typeof fetch>(async () => response());
  return { transport, service: createOpenRouterGenerationProvider({ config, apiKey: 'fixture-key-not-used-outside-tests', fetch: transport }) };
}
const streamResponse = (content: unknown) => new Response(delta(JSON.stringify(content), 'stop') + ending(), { headers: { 'content-type': 'text/event-stream' } });
const jsonResponse = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage });

describe('real upstream streaming and learning output validation', () => {
  it('persists upstream answer progress before the final frame, with fragmented UTF-8 and usage', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
    const { service, transport } = provider(() => response), progress: string[] = [];
    let first!: () => void; const observed = new Promise<void>(resolve => { first = resolve; });
    const output = answer(), encoded = JSON.stringify(output), boundary = encoded.indexOf('","citations');
    const pending = service.generate(claim(), new AbortController().signal, async value => { progress.push(value); first(); });
    const start = new TextEncoder().encode(delta(encoded.slice(0, boundary)));
    for (let i = 0; i < start.length; i += 7) controller.enqueue(start.slice(i, i + 7));
    await observed;
    expect(progress.at(-1)).toBe(output.answer);
    controller.enqueue(new TextEncoder().encode(delta(encoded.slice(boundary), 'stop') + ending())); controller.close();
    const result = await pending;
    expect(result).toMatchObject({ status: 'succeeded', result: output, usage: { state: 'reported', totalTokens: 50 } });
    const request = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(request).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(request.response_format.json_schema.name).toBe('chat_answer');
  });

  it('stops an actual unfinished upstream stream and does not fabricate a final answer or zero usage', async () => {
    let cancelled = false;
    const { service } = provider(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(delta('{"answer":"未完成'))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController(), pending = service.generate(claim(), controller.signal);
    await Promise.resolve(); controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', result: null, usage: { state: 'unknown', totalTokens: null } });
    expect(cancelled).toBe(true);
  });

  it('accepts OpenRouter accounting frames that repeat an empty delta and stop after completion', async () => {
    const finalUsage = { id: 'gen-stream-fixture', choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop', native_finish_reason: 'stop' }], usage };
    const wire = delta(JSON.stringify(answer())) + delta('', 'stop') + `data: ${JSON.stringify(finalUsage)}\n\ndata: [DONE]\n\n`;
    const progress: string[] = [];
    const { service } = provider(() => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await service.generate(claim(), new AbortController().signal, async value => { progress.push(value); })).toMatchObject({
      status: 'succeeded', errorCode: null, result: answer(),
      usage: { state: 'reported', inputTokens: 20, outputTokens: 30, totalTokens: 50, costCredits: '0.00001', providerRequestId: 'gen-stream-fixture' },
    });
    expect(progress).toEqual([answer().answer]);
  });

  it.each([
    [{ delta: { content: 'extra content' }, finish_reason: 'stop' }, 'invalid_response'],
    [{ delta: { content: ' ' }, finish_reason: 'stop' }, 'invalid_response'],
    [{ delta: { content: '', tool_calls: [{ id: 'unexpected-tool' }] }, finish_reason: 'stop' }, 'output_refused'],
    [{ delta: { content: '', function_call: { name: 'unexpected-tool' } }, finish_reason: 'stop' }, 'output_refused'],
    [{ delta: { content: '', refusal: 'refused' }, finish_reason: 'stop' }, 'output_refused'],
    [{ delta: { content: '' }, finish_reason: 'length' }, 'output_truncated'],
    [{ delta: { content: '' }, finish_reason: 'error' }, 'output_refused'],
    [{ delta: { content: {} }, finish_reason: 'stop' }, 'invalid_response'],
  ])('rejects content, refusals and bad completion frames after stop %#', async (choice, errorCode) => {
    const wire = delta(JSON.stringify(answer()), 'stop') + `data: ${JSON.stringify({ choices: [choice], usage })}\n\ndata: [DONE]\n\n`;
    const { service } = provider(() => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await service.generate(claim(), new AbortController().signal)).toMatchObject({ status: 'failed', errorCode, result: null, usage: { state: 'reported', totalTokens: 50 } });
  });

  it.each([
    delta(JSON.stringify(answer()), 'stop'),
    delta(JSON.stringify(answer())) + ending(),
  ])('rejects a complete-looking answer without both stop and DONE %#', async wire => {
    const { service } = provider(() => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    expect(await service.generate(claim(), new AbortController().signal)).toMatchObject({ status: 'failed', errorCode: 'invalid_response', result: null });
  });

  it.each([
    { ...answer(), citations: [{ sourceId: 'wrong', quote }] },
    { ...answer(), citations: [{ sourceId: 's1', quote: '这是资料里面没有出现过的一段捏造文字。' }] },
    { ...answer(), citations: [] },
    { ...answer(), citations: [{ ...citation, page: 1 }] },
    { ...answer(), insufficientEvidence: true },
  ])('rejects invalid grounding and retains charged usage %#', async output => {
    const { service } = provider(() => streamResponse(output));
    expect(await service.generate(claim(), new AbortController().signal)).toMatchObject({ status: 'failed', errorCode: 'invalid_output', result: null, usage: { state: 'reported', totalTokens: 50 } });
  });

  it.each([
    ['zh-CN', '当前资料没有提供足够的信息来回答这个问题。请补充相关资料后再试。'],
    ['en', 'The selected materials do not provide enough evidence to answer this question. Add relevant material and try again.'],
  ] as const)('normalizes insufficient evidence to an explicit %s refusal instead of trusting the model answer', async (language, expected) => {
    const output = { answer: '这是未经原文支持的任意模型陈述，不能被标为资料不足后照样作为成功答案。', citations: [], insufficientEvidence: true };
    const progress: string[] = [];
    const result = await provider(() => streamResponse(output)).service.generate(claim('chat-answer-v1', { language, question: '问题？', history: [] }), new AbortController().signal, async text => {
      // The real persistence path permits append-only upstream progress. A final
      // canonical refusal belongs in job.result, never in this stream callback.
      if (progress.length && !text.startsWith(progress.at(-1)!)) throw new Error('Progress changed an existing prefix');
      progress.push(text);
    });
    expect(result).toMatchObject({ status: 'succeeded', result: { answer: expected, citations: [], insufficientEvidence: true } });
    expect(progress).not.toContain(expected);
  });

  it('requires upstream completion and rejects truncated streams even if the answer looks complete', async () => {
    const { service } = provider(() => new Response(delta(JSON.stringify(answer()), 'length') + ending(), { headers: { 'content-type': 'text/event-stream' } }));
    expect(await service.generate(claim(), new AbortController().signal)).toMatchObject({ status: 'failed', errorCode: 'output_truncated', result: null });
  });

  it('validates exact card counts and resolves each card citation against the original snapshot', async () => {
    const task = claim('flashcards-v1', { language: 'zh-CN', cardCount: 1 });
    const card = { front: '光合作用把什么能量转化为什么能量？', back: '将光能转化为化学能。', citations: [citation] };
    const { service } = provider(() => jsonResponse({ title: '学习卡', cards: [card] }));
    expect(await service.generate(task, new AbortController().signal)).toMatchObject({ status: 'succeeded', result: { cards: [{ ...card, citations: [{ materialId: task.snapshot.sources[0]!.materialId, version: 3, page: null }] }] } });
    task.snapshot.config = { language: 'zh-CN', cardCount: 2 };
    expect(await service.generate(task, new AbortController().signal)).toMatchObject({ status: 'failed', errorCode: 'invalid_output' });
  });

  it('enforces quiz counts, option uniqueness, answer range and fixed true/false labels', async () => {
    const task = claim('quiz-v1', { language: 'zh-CN', singleChoiceCount: 1, trueFalseCount: 1 });
    const choices = { type: 'single_choice', prompt: '能量怎样转化？', options: ['光能到化学能', '化学能到光能', '热能到光能', '机械能到热能'], answerIndex: 0, explanation: '原文明确说明是光能到化学能。', citations: [citation] };
    const truth = { type: 'true_false', prompt: '光合作用把光能转化为化学能。', options: ['正确', '错误'], answerIndex: 0, explanation: '符合原文。', citations: [citation] };
    const run = (questions: unknown[]) => provider(() => jsonResponse({ title: '练习', questions })).service.generate(task, new AbortController().signal);
    expect(await run([choices, truth])).toMatchObject({ status: 'succeeded' });
    for (const questions of [[choices], [{ ...choices, answerIndex: 4 }, truth], [{ ...choices, options: ['同一', '同一', '另一', '第三'] }, truth], [choices, { ...truth, options: ['Yes', 'No'] }]]) {
      expect(await run(questions)).toMatchObject({ status: 'failed', errorCode: 'invalid_output' });
    }
  });

  it('waits for partial JSON escapes and UTF-16 pairs instead of emitting corrupted text', () => {
    expect(partialChatAnswer('{"answer":"a\\uD83D')).toBe('a');
    expect(partialChatAnswer('{"answer":"a\\uD83D\\uDE00\\n')).toBe('a😀\n');
    expect(partialChatAnswer('{"answer":"a\\')).toBe('a');
    expect(partialChatAnswer('{"citations":[]')).toBeNull();
  });
});
