import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuizApi } from './api.ts';
const setId = '11111111-1111-4111-8111-111111111111';
const quizId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const clientRequestId = '44444444-4444-4444-8444-444444444444';
const attempt = { id: attemptId, quizId, studySetId: setId, title: '合成测验', mode: 'exam', status: 'in_progress', version: 1, score: null,
  questions: [{ index: 0, type: 'single_choice', prompt: '合成问题', options: ['A', 'B'], selectedAnswerIndex: null }] };
test('exam responses with accidentally exposed answer keys or feedback are rejected', async () => {
  for (const extra of [{ correctAnswerIndex: 0 }, { correct: true }, { explanation: '答案' }, { citations: [] }, { history: [] }]) {
    const api = createQuizApi(async () => ({ attempt: { ...attempt, questions: [{ ...attempt.questions[0], ...extra }] } }), setId, new AbortController().signal);
    await assert.rejects(api.resume(quizId, attemptId), error => error.code === 'invalid_response');
  }
});
test('late responses from an aborted account/set lifetime are discarded', async () => {
  const controller = new AbortController(); let release;
  const api = createQuizApi(() => new Promise(resolve => { release = resolve; }), setId, controller.signal);
  const result = api.resume(quizId, attemptId); controller.abort(); release({ attempt });
  await assert.rejects(result, error => error.name === 'AbortError');
});
test('answers preserve their idempotency/version intent and are never automatically retried', async () => {
  let calls = 0;
  const api = createQuizApi(async (path, options) => {
    calls++; assert.equal(path, `/v1/study/sets/${setId}/quizzes/${quizId}/attempts/${attemptId}/answers`);
    assert.deepEqual(options.body, { questionIndex: 0, answerIndex: 1, version: 1, clientRequestId });
    throw new Error('connection lost after a possible commit');
  }, setId, new AbortController().signal);
  await assert.rejects(api.answer(attempt, 0, 1, clientRequestId)); assert.equal(calls, 1);
});
test('submitted exams allow result review while pre-submission responses stay hidden', async () => {
  const completed = { ...attempt, status: 'submitted', score: { total: 1, firstCorrect: 1, finalCorrect: 1, firstCorrectRate: 100, finalScore: 100 }, questions: [{ ...attempt.questions[0], correctAnswerIndex: 0, explanation: '解释', citations: [], correct: true }] };
  const api = createQuizApi(async () => ({ attempt: completed }), setId, new AbortController().signal);
  assert.equal((await api.resume(quizId, attemptId)).questions[0].correctAnswerIndex, 0);
});
