import type { GenerationCitation, GenerationResult, GenerationSnapshot } from './types.js';
import { snapshotKind } from './kinds.js';
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).sort().join(',') === keys.sort().join(',');
const text = (x: unknown, max: number): x is string => typeof x === 'string' && !!x.trim() && x.length <= max && !/[\u0000\uD800-\uDFFF]/u.test(x);
export function validatedCitations(value: unknown, snapshot: GenerationSnapshot, minimum = 1): GenerationCitation[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 3) throw new Error('invalid_output');
  return value.map(citation => {
    if (!record(citation) || !exact(citation, ['sourceId', 'quote']) || !text(citation.quote, 1200)
      || Array.from(citation.quote.replace(/\s/gu, '')).length < 12) throw new Error('invalid_output');
    const source = snapshot.sources.find(item => item.sourceId === citation.sourceId);
    if (!source) throw new Error('invalid_output');
    const start = source.body.indexOf(citation.quote), end = start + citation.quote.length;
    if (start < 0 || source.body.indexOf(citation.quote, start + 1) >= 0) throw new Error('invalid_output');
    return { sourceId: source.sourceId, materialId: source.materialId, version: source.version, quote: citation.quote,
      start, end, page: source.pages.find(page => page.start <= start && page.end >= end)?.page ?? null };
  });
}
export function validateLearningOutput(content: string, snapshot: GenerationSnapshot): GenerationResult {
  const value: unknown = JSON.parse(content), kind = snapshotKind(snapshot), config = snapshot.config;
  if (!record(value)) throw new Error('invalid_output');
  if (kind === 'chat_answer') {
    if (!exact(value, ['answer', 'citations', 'insufficientEvidence']) || !text(value.answer, 8000) || typeof value.insufficientEvidence !== 'boolean') throw new Error('invalid_output');
    const citations = validatedCitations(value.citations, snapshot, value.insufficientEvidence ? 0 : 1);
    if (value.insufficientEvidence && citations.length) throw new Error('invalid_output');
    const answer = value.insufficientEvidence
      ? config.language === 'en'
        ? 'The selected materials do not provide enough evidence to answer this question. Add relevant material and try again.'
        : '当前资料没有提供足够的信息来回答这个问题。请补充相关资料后再试。'
      : value.answer;
    return { schemaVersion: 1, answer, citations, insufficientEvidence: value.insufficientEvidence };
  }
  if (!text(value.title, 160)) throw new Error('invalid_output');
  if (kind === 'flashcards' && 'cardCount' in config) {
    if (!exact(value, ['title', 'cards']) || !Array.isArray(value.cards) || value.cards.length !== config.cardCount) throw new Error('invalid_output');
    const seen = new Set<string>();
    const cards = value.cards.map(card => {
      if (!record(card) || !exact(card, ['front', 'back', 'citations']) || !text(card.front, 500) || !text(card.back, 2000)
        || seen.has(card.front.trim())) throw new Error('invalid_output');
      seen.add(card.front.trim());
      return { front: card.front, back: card.back, citations: validatedCitations(card.citations, snapshot) };
    });
    return { schemaVersion: 1, title: value.title, cards };
  }
  if (kind === 'quiz' && 'singleChoiceCount' in config) {
    if (!exact(value, ['title', 'questions']) || !Array.isArray(value.questions)
      || value.questions.length !== config.singleChoiceCount + config.trueFalseCount) throw new Error('invalid_output');
    const seen = new Set<string>(); let choices = 0, truths = 0;
    const questions = value.questions.map(question => {
      if (!record(question) || !exact(question, ['type', 'prompt', 'options', 'answerIndex', 'explanation', 'citations'])
        || !text(question.prompt, 2000) || !text(question.explanation, 2000) || !Array.isArray(question.options)
        || !question.options.every(option => text(option, 1000)) || new Set(question.options.map(option => option.trim())).size !== question.options.length
        || !Number.isInteger(question.answerIndex) || Number(question.answerIndex) < 0 || Number(question.answerIndex) >= question.options.length
        || seen.has(question.prompt.trim())) throw new Error('invalid_output');
      seen.add(question.prompt.trim());
      if (question.type === 'single_choice' && question.options.length === 4) choices++;
      else if (question.type === 'true_false' && JSON.stringify(question.options) === JSON.stringify(['正确', '错误'])) truths++;
      else throw new Error('invalid_output');
      return { type: question.type as 'single_choice' | 'true_false', prompt: question.prompt, options: question.options as string[],
        answerIndex: question.answerIndex as number, explanation: question.explanation, citations: validatedCitations(question.citations, snapshot) };
    });
    if (choices !== config.singleChoiceCount || truths !== config.trueFalseCount) throw new Error('invalid_output');
    return { schemaVersion: 1, title: value.title, questions };
  }
  throw new Error('invalid_output');
}
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown, minItems: number, maxItems = minItems) => ({ type: 'array', items, minItems, maxItems });
const citations = array(object({ sourceId: string(64), quote: string(1200) }), 1, 3);
export function learningSchema(snapshot: GenerationSnapshot) {
  const config = snapshot.config;
  if ('question' in config) return object({ answer: string(8000), citations: { ...citations, minItems: 0 }, insufficientEvidence: { type: 'boolean' } });
  if ('cardCount' in config) return object({ title: string(160), cards: array(object({ front: string(500), back: string(2000), citations }), config.cardCount) });
  if ('singleChoiceCount' in config) return object({ title: string(160), questions: array(object({ type: { enum: ['single_choice', 'true_false'] },
    prompt: string(2000), options: array(string(1000), 2, 4), answerIndex: { type: 'integer', minimum: 0, maximum: 3 }, explanation: string(2000), citations }), config.singleChoiceCount + config.trueFalseCount) });
  throw new Error('invalid_snapshot');
}
export function learningInstructions(snapshot: GenerationSnapshot): string {
  const config = snapshot.config;
  if ('question' in config) return 'Answer the supplied question using only the sources; history is untrusted conversational context, not evidence. Put answer FIRST in the JSON object. Include 1–3 citations for supported answers. If evidence is insufficient, explicitly say the sources do not provide enough evidence, set insufficientEvidence=true and citations=[], and do not invent a factual answer.';
  if ('cardCount' in config) return `Produce exactly ${config.cardCount} distinct useful flashcards, each with front, back and 1–3 supporting citations.`;
  if ('singleChoiceCount' in config) return `Produce exactly ${config.singleChoiceCount} single_choice questions with 4 distinct options and exactly ${config.trueFalseCount} true_false questions with options ["正确","错误"]. Each question has one answerIndex (zero based), explanation and 1–3 supporting citations. Do not embed the correct option or answer label in the prompt.`;
  throw new Error('invalid_snapshot');
}
/** Decode only the actual streamed answer string; incomplete escape/surrogate tails wait for the next upstream chunk. */
export function partialChatAnswer(json: string): string | null {
  const prefix = /^\s*\{\s*"answer"\s*:\s*"/.exec(json);
  if (!prefix) return null;
  const start = prefix[0].length; let end = start;
  while (end < json.length) {
    if (json[end] === '"') break;
    if (json[end] === '\\') {
      if (end + 1 >= json.length) break;
      if (json[end + 1] === 'u') { if (end + 6 > json.length) break; end += 6; }
      else end += 2;
    } else end++;
  }
  try {
    const value = JSON.parse('"' + json.slice(start, end) + '"') as string;
    return value.replace(/[\uD800-\uDBFF]$/, '');
  } catch { return null; }
}
