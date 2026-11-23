import { AuthApiError, throwIfAborted, type RequestOptions } from '../../auth/api.ts';
export interface Citation { sourceId: string; materialId: string; version: number; quote: string; start: number; end: number; page: number | null }
export interface Source { sourceId: string; materialId: string; title: string; version: number; body: string }
export interface Question { index: number; type: 'single_choice' | 'true_false'; prompt: string; options: string[]; selectedAnswerIndex: number | null; correctAnswerIndex?: number; correct?: boolean; explanation?: string; citations?: Citation[]; history?: { answerIndex: number; correct: boolean; createdAt: string }[] }
export interface Quiz { id: string; studySetId: string; title: string; questionCount: number; createdAt: string }
export interface AttemptSummary { id: string; mode: 'practice' | 'exam'; status: 'in_progress' | 'submitted'; createdAt: string; answeredCount: number; questionCount: number; firstCorrect: number | null; finalCorrect: number | null }
export interface Attempt { id: string; quizId: string; studySetId: string; title: string; mode: 'practice' | 'exam'; status: 'in_progress' | 'submitted'; version: number; questions: Question[]; sourceSnapshots?: Source[]; score: { total: number; firstCorrect: number; finalCorrect: number; firstCorrectRate: number; finalScore: number } | null }
export interface Generation { id: string; studySetId: string; kind: string; status: string; errorCode: string | null }
export interface GenerationInput { clientRequestId: string; kind: 'quiz'; sources: { materialId: string; version: number }[]; config: { language: 'zh-CN' | 'en'; singleChoiceCount: number; trueFalseCount: number } }
interface Page<T> { items: T[]; nextCursor: string | null }
type Request = <T>(path: string, options?: RequestOptions) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new AuthApiError('invalid_response', '测验服务返回了无效数据，请重新读取。', 502);
const target = (value: string) => { if (!uuid.test(value)) throw invalid(); return value.toLowerCase(); };
export function createQuizApi(request: Request, set: string, signal: AbortSignal | (() => AbortSignal)) {
  const root = `/v1/study/sets/${target(set)}`;
  async function send<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const current = typeof signal === 'function' ? signal() : signal;
    throwIfAborted(current);
    const value = await request<T>(path, { ...options, signal: current });
    throwIfAborted(current);
    return value;
  }
  const quiz = (value: { quiz: Quiz }) => { if (!value?.quiz || !uuid.test(value.quiz.id) || value.quiz.studySetId !== set) throw invalid(); return value.quiz; };
  const attempt = (value: { attempt: Attempt }) => {
    const a = value?.attempt;
    if (!a || !uuid.test(a.id) || a.studySetId !== set || !Number.isInteger(a.version) || !Array.isArray(a.questions) || a.questions.length < 1 || a.questions.length > 20
      || a.questions.some((q, index) => q.index !== index || typeof q.prompt !== 'string' || !Array.isArray(q.options) || q.options.length < 2)) throw invalid();
    if (a.mode === 'exam' && a.status === 'in_progress' && (a.score !== null || a.questions.some(q => q.correctAnswerIndex !== undefined || q.correct !== undefined || q.explanation !== undefined || q.citations !== undefined || q.history !== undefined))) throw invalid();
    return a;
  };
  return {
    list: (cursor?: string) => send<Page<Quiz>>(`${root}/quizzes${cursor ? `?cursor=${target(cursor)}` : ''}`),
    generations: () => send<Page<Generation>>(`${root}/generations?limit=50`),
    generate: async (body: GenerationInput) => (await send<{ job: Generation }>(`${root}/generations`, { method: 'POST', body })).job,
    generation: async (id: string) => (await send<{ job: Generation }>(`${root}/generations/${target(id)}`)).job,
    materialize: async (id: string, clientRequestId: string) => quiz(await send<{ quiz: Quiz }>(`${root}/quizzes`, { method: 'POST', body: { generationId: target(id), clientRequestId } })),
    get: async (id: string) => quiz(await send<{ quiz: Quiz }>(`${root}/quizzes/${target(id)}`)),
    history: (quizId: string, cursor?: string) => send<Page<AttemptSummary>>(`${root}/quizzes/${target(quizId)}/attempts${cursor ? `?cursor=${target(cursor)}` : ''}`),
    start: async (id: string, mode: 'practice' | 'exam', clientRequestId: string) => attempt(await send<{ attempt: Attempt }>(`${root}/quizzes/${target(id)}/attempts`, { method: 'POST', body: { mode, clientRequestId } })),
    resume: async (quizId: string, attemptId: string) => attempt(await send<{ attempt: Attempt }>(`${root}/quizzes/${target(quizId)}/attempts/${target(attemptId)}`)),
    answer: async (a: Attempt, questionIndex: number, answerIndex: number, clientRequestId: string) => attempt(await send<{ attempt: Attempt }>(`${root}/quizzes/${target(a.quizId)}/attempts/${target(a.id)}/answers`, { method: 'POST', body: { questionIndex, answerIndex, version: a.version, clientRequestId } })),
    submit: async (a: Attempt, clientRequestId: string) => attempt(await send<{ attempt: Attempt }>(`${root}/quizzes/${target(a.quizId)}/attempts/${target(a.id)}/submit`, { method: 'POST', body: { version: a.version, clientRequestId } })),
  };
}
