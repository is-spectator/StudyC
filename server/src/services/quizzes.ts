import {requireVisibleSet} from './set-visibility.js';
import { collectMistakes } from './mistakes.js';
import { createHash } from 'node:crypto';
import type { Db, Queryable } from '../db/db.js';
import type { GenerationStore } from '../generation/store.js';
import { GenerationError, type GenerationCitation, type SourceSnapshot } from '../generation/types.js';
import { requireActiveUser } from './identity.js';

export type QuizGenerationReader = Pick<GenerationStore, 'get'>;
export interface QuizQuestion { type: 'single_choice' | 'true_false'; prompt: string; options: string[]; answerIndex: number; explanation: string; citations: GenerationCitation[] }
interface QuizSnapshot { title: string; questions: QuizQuestion[]; sources: SourceSnapshot[] }
interface QuizRow { id: string; user_id: string; study_set_id: string; generation_id: string; client_request_id: string; title: string; questions: QuizQuestion[]; source_snapshot: { sources: SourceSnapshot[] }; created_at: Date }
interface AttemptRow { id: string; user_id: string; quiz_id: string; client_request_id: string; mode: 'practice' | 'exam'; status: 'in_progress' | 'submitted'; version: number; snapshot: QuizSnapshot; answers: Record<string, number>; first_correct: number | null; final_correct: number | null; created_at: Date; updated_at: Date; submitted_at: Date | null }
interface EventRow { attempt_id: string; client_request_id: string; request_digest: string; kind: 'answer' | 'submit'; question_index: number | null; answer_index: number | null; correct: boolean | null; version_after: number; created_at: Date }
function error(code: ConstructorParameters<typeof GenerationError>[0], message: string): never { throw new GenerationError(code, message); }
const missing = (): never => error('not_found', '没有找到这份测验或作答记录。');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value: Date | string) => new Date(value).toISOString();
const lock = (user: string) => `studyc:quizzes:${user}`;
const publicQuestion = (question: QuizQuestion, index: number) => ({ index, type: question.type, prompt: question.prompt, options: question.options });
async function scope(q: Queryable, user: string, set: string) { return requireVisibleSet(q,user,set); }
async function quizRow(q: Queryable, user: string, set: string, quizId: string): Promise<QuizRow> {
  const [quiz] = await q.query<QuizRow>('SELECT * FROM study_quizzes WHERE id=$1 AND user_id=$2 AND study_set_id=$3', [quizId, user, set]);
  return quiz ?? missing();
}
async function attemptRow(q: Queryable, user: string, quizId: string, attemptId: string): Promise<AttemptRow> {
  const [attempt] = await q.query<AttemptRow>('SELECT * FROM study_quiz_attempts WHERE id=$1 AND user_id=$2 AND quiz_id=$3', [attemptId, user, quizId]);
  return attempt ?? missing();
}
function presentQuiz(quiz: QuizRow) {
  return { id: quiz.id, studySetId: quiz.study_set_id, generationId: quiz.generation_id, title: quiz.title,
    questionCount: quiz.questions.length, questions: quiz.questions.map(publicQuestion),
    sources: quiz.source_snapshot.sources.map(({ body: _body, ...source }) => source), createdAt: iso(quiz.created_at) };
}
async function presentAttempt(q: Queryable, attempt: AttemptRow, set: string) {
  const events = await q.query<EventRow>("SELECT * FROM study_quiz_events WHERE attempt_id=$1 AND user_id=$2 AND kind='answer' ORDER BY version_after", [attempt.id, attempt.user_id]);
  const total = attempt.snapshot.questions.length;
  return { id: attempt.id, quizId: attempt.quiz_id, studySetId: set, title: attempt.snapshot.title, mode: attempt.mode, status: attempt.status, version: attempt.version,
    questions: attempt.snapshot.questions.map((question, index) => {
      const selected = attempt.answers[String(index)] ?? null;
      const visible = attempt.status === 'submitted' || (attempt.mode === 'practice' && selected !== null);
      return { ...publicQuestion(question, index), selectedAnswerIndex: selected, ...(visible ? {
        correctAnswerIndex: question.answerIndex, correct: selected === question.answerIndex, explanation: question.explanation, citations: question.citations,
        history: events.filter(event => event.question_index === index).map(event => ({ answerIndex: event.answer_index, correct: event.correct, createdAt: iso(event.created_at) })),
      } : {}) };
    }),
    ...(attempt.mode === 'practice' || attempt.status === 'submitted' ? { sourceSnapshots: attempt.snapshot.sources } : {}),
    score: attempt.status === 'submitted' ? { total, firstCorrect: attempt.first_correct!, finalCorrect: attempt.final_correct!,
      firstCorrectRate: Math.round(attempt.first_correct! * 1000 / total) / 10, finalScore: Math.round(attempt.final_correct! * 1000 / total) / 10 } : null,
    createdAt: iso(attempt.created_at), updatedAt: iso(attempt.updated_at), submittedAt: attempt.submitted_at ? iso(attempt.submitted_at) : null };
}
export type QuizView = ReturnType<typeof presentQuiz>;
export type QuizAttemptView = Awaited<ReturnType<typeof presentAttempt>>;

export async function materializeQuiz(db: Db, generations: QuizGenerationReader | undefined, user: string, set: string, input: { clientRequestId: string; generationId: string }) {
  const requestHash = digest({ set, generationId: input.generationId });
  if (!generations) error('service_unavailable', '生成服务暂不可用。');
  // Read outside the quiz transaction: the generation store has its own lock/transaction.
  const generated = await generations.get(user, set, input.generationId);
  const result = generated.result as unknown as { schemaVersion: number; title: string; questions?: QuizQuestion[] } | null;
  if ((generated.kind as string) !== 'quiz' || generated.status !== 'succeeded' || !result || result.schemaVersion !== 1 || !Array.isArray(result.questions)
    || result.questions.length < 1 || result.questions.length > 20 || !generated.inputSnapshot) error('job_conflict', '测验尚未生成成功，请等待或重新生成。');
  const questions = result.questions!;
  if (questions.some(question => !['single_choice', 'true_false'].includes(question.type) || !Array.isArray(question.options)
    || question.options.length < 2 || question.options.length > 6 || !Number.isInteger(question.answerIndex)
    || question.answerIndex < 0 || question.answerIndex >= question.options.length || !question.citations?.length)) error('invalid_input', '生成题目无效。');
  return db.tx(async q => {
    await scope(q, user, set);
    const [sameRequest] = await q.query<{ quiz_id: string; request_digest: string }>('SELECT quiz_id,request_digest FROM study_quiz_materializations WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
    if (sameRequest) {
      if (sameRequest.request_digest !== requestHash) error('idempotency_conflict', '该请求标识已用于另一份测验。');
      return { quiz: presentQuiz(await quizRow(q, user, set, sameRequest.quiz_id)), replayed: true };
    }
    const [existing] = await q.query<QuizRow>('SELECT * FROM study_quizzes WHERE user_id=$1 AND generation_id=$2', [user, input.generationId]);
    const [created] = existing ? [existing] : await q.query<QuizRow>(`INSERT INTO study_quizzes(user_id,study_set_id,generation_id,client_request_id,title,questions,source_snapshot)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`, [user, set, input.generationId, input.clientRequestId, result.title, JSON.stringify(questions), JSON.stringify(generated.inputSnapshot)]);
    // Bind every accepted request, including a second entry point to an existing generation.
    await q.query('INSERT INTO study_quiz_materializations(user_id,quiz_id,client_request_id,request_digest) VALUES($1,$2,$3,$4)', [user, created!.id, input.clientRequestId, requestHash]);
    return { quiz: presentQuiz(created!), replayed: Boolean(existing) };
  }, lock(user));
}
export async function getQuiz(db: Db, user: string, set: string, quizId: string) {
  return db.tx(async q => { await scope(q, user, set); return presentQuiz(await quizRow(q, user, set, quizId)); }, lock(user));
}
export async function listQuizzes(db: Db, user: string, set: string, options: { limit: number; cursor?: string }) {
  return db.tx(async q => {
    await scope(q, user, set);
    if (options.cursor) await quizRow(q, user, set, options.cursor);
    const rows = await q.query<QuizRow>(`SELECT * FROM study_quizzes WHERE user_id=$1 AND study_set_id=$2
      ${options.cursor ? 'AND (created_at,id)<(SELECT created_at,id FROM study_quizzes WHERE id=$4)' : ''} ORDER BY created_at DESC,id DESC LIMIT $3`, [user, set, options.limit + 1, ...(options.cursor ? [options.cursor] : [])]);
    return { items: rows.slice(0, options.limit).map(quiz => ({ id: quiz.id, studySetId: set, title: quiz.title, questionCount: quiz.questions.length, createdAt: iso(quiz.created_at) })), nextCursor: rows.length > options.limit ? rows[options.limit - 1]!.id : null };
  }, lock(user));
}
export async function startQuizAttempt(db: Db, user: string, set: string, quizId: string, input: { clientRequestId: string; mode: 'practice' | 'exam' }) {
  return db.tx(async q => {
    await scope(q, user, set); const quiz = await quizRow(q, user, set, quizId);
    const [existing] = await q.query<AttemptRow>('SELECT * FROM study_quiz_attempts WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
    if (existing) {
      if (existing.quiz_id !== quizId || existing.mode !== input.mode) error('idempotency_conflict', '同一次作答请求的模式已变化。');
      return { attempt: await presentAttempt(q, existing, set), replayed: true };
    }
    const snapshot: QuizSnapshot = { title: quiz.title, questions: quiz.questions, sources: quiz.source_snapshot.sources };
    const [created] = await q.query<AttemptRow>(`INSERT INTO study_quiz_attempts(user_id,quiz_id,client_request_id,mode,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`, [user, quizId, input.clientRequestId, input.mode, JSON.stringify(snapshot)]);
    return { attempt: await presentAttempt(q, created!, set), replayed: false };
  }, lock(user));
}
export async function getQuizAttempt(db: Db, user: string, set: string, quizId: string, attemptId: string) {
  return db.tx(async q => { await scope(q, user, set); await quizRow(q, user, set, quizId); return presentAttempt(q, await attemptRow(q, user, quizId, attemptId), set); }, lock(user));
}
export async function listQuizAttempts(db: Db, user: string, set: string, quizId: string, options: { limit: number; cursor?: string }) {
  return db.tx(async q => {
    await scope(q, user, set); await quizRow(q, user, set, quizId);
    if (options.cursor) await attemptRow(q, user, quizId, options.cursor);
    const rows = await q.query<AttemptRow>(`SELECT * FROM study_quiz_attempts WHERE user_id=$1 AND quiz_id=$2
      ${options.cursor ? 'AND (created_at,id)<(SELECT created_at,id FROM study_quiz_attempts WHERE id=$4)' : ''} ORDER BY created_at DESC,id DESC LIMIT $3`, [user, quizId, options.limit + 1, ...(options.cursor ? [options.cursor] : [])]);
    return { items: rows.slice(0, options.limit).map(attempt => ({ id: attempt.id, mode: attempt.mode, status: attempt.status, createdAt: iso(attempt.created_at), submittedAt: attempt.submitted_at ? iso(attempt.submitted_at) : null, answeredCount: Object.keys(attempt.answers).length, questionCount: attempt.snapshot.questions.length,
      finalCorrect: attempt.final_correct, firstCorrect: attempt.first_correct })), nextCursor: rows.length > options.limit ? rows[options.limit - 1]!.id : null };
  }, lock(user));
}
export async function answerQuiz(db: Db, user: string, set: string, quizId: string, attemptId: string, input: { clientRequestId: string; version: number; questionIndex: number; answerIndex: number }) {
  return mutateAttempt(db, user, set, quizId, attemptId, input, 'answer');
}
export async function submitQuiz(db: Db, user: string, set: string, quizId: string, attemptId: string, input: { clientRequestId: string; version: number }) {
  return mutateAttempt(db, user, set, quizId, attemptId, input, 'submit');
}
async function mutateAttempt(db: Db, user: string, set: string, quizId: string, attemptId: string, input: { clientRequestId: string; version: number; questionIndex?: number; answerIndex?: number }, kind: 'answer' | 'submit') {
  const requestHash = digest({ set, quizId, attemptId, kind, ...input });
  return db.tx(async q => {
    await scope(q, user, set); await quizRow(q, user, set, quizId);
    const attempt = await attemptRow(q, user, quizId, attemptId);
    const [event] = await q.query<EventRow>('SELECT * FROM study_quiz_events WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
    if (event) {
      if (event.request_digest !== requestHash) error('idempotency_conflict', '同一次提交的内容发生了变化。');
      return { attempt: await presentAttempt(q, attempt, set), replayed: true };
    }
    if (attempt.status === 'submitted') {
      if (kind === 'submit') return { attempt: await presentAttempt(q, attempt, set), replayed: true };
      error('job_conflict', '这次测验已提交，请开始新的练习。');
    }
    if (attempt.version !== input.version) error('version_conflict', '另一页面已更新这次作答，请重新读取后继续。');
    if (attempt.version >= 2147483647) error('job_conflict', '这次作答无法继续更新。');
    let correct: boolean | null = null;
    if (kind === 'answer') {
      const question = attempt.snapshot.questions[input.questionIndex ?? -1];
      if (!question || !Number.isInteger(input.answerIndex) || input.answerIndex! < 0 || input.answerIndex! >= question.options.length) error('invalid_input', '答案选项无效。');
      correct = question.answerIndex === input.answerIndex;
      attempt.answers[String(input.questionIndex)] = input.answerIndex!;
      await q.query('UPDATE study_quiz_attempts SET answers=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1', [attemptId, JSON.stringify(attempt.answers)]);
    } else {
      if (Object.keys(attempt.answers).length !== attempt.snapshot.questions.length) error('invalid_input', '还有未作答的题目，请完成后提交。');
      const events = await q.query<EventRow>("SELECT * FROM study_quiz_events WHERE attempt_id=$1 AND kind='answer' ORDER BY version_after", [attemptId]);
      const first = new Map<number, boolean>();
      for (const value of events) if (!first.has(value.question_index!)) first.set(value.question_index!, value.correct!);
      const firstCorrect = [...first.values()].filter(Boolean).length;
      const finalCorrect = attempt.snapshot.questions.filter((question, index) => question.answerIndex === attempt.answers[String(index)]).length;
      await q.query("UPDATE study_quiz_attempts SET status='submitted',version=version+1,first_correct=$2,final_correct=$3,submitted_at=now(),updated_at=now() WHERE id=$1", [attemptId, firstCorrect, finalCorrect]);
    }
    await q.query(`INSERT INTO study_quiz_events(user_id,attempt_id,client_request_id,request_digest,kind,question_index,answer_index,correct,version_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [user, attemptId, input.clientRequestId, requestHash, kind, input.questionIndex ?? null, input.answerIndex ?? null, correct, attempt.version + 1]);
    if (kind === 'submit') await collectMistakes(q,user,attemptId);
    return { attempt: await presentAttempt(q, await attemptRow(q, user, quizId, attemptId), set), replayed: false };
  }, lock(user));
}
