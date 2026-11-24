import { AuthApiError, throwIfAborted, type RequestOptions } from '../../auth/api.ts';
export type Mistake = {
    quizId: string;
    questionIndex: number;
    quizTitle: string;
    prompt: string;
    type: string;
    wrongCount: number;
    firstWrongCount: number;
    finalWrongCount: number;
    latestSubmittedAt: string;
    latestReview: null | {
        id: string;
        correct: boolean;
        submittedAt: string;
    };
};
export type Review = {
    id: string;
    studySetId: string;
    quizId: string;
    title: string;
    status: 'in_progress' | 'submitted';
    version: number;
    questions: {
        index: number;
        originalQuestionIndex: number;
        prompt: string;
        type: string;
        options: string[];
        selectedAnswerIndex: number | null;
        correctAnswerIndex?: number;
        correct?: boolean;
        explanation?: string;
        citations?: {
            sourceId: string;
            materialId: string;
            version: number;
            quote: string;
            page: number | null;
        }[];
        sourceSnapshots?: {
            sourceId: string;
            title: string;
            body: string;
            version: number;
        }[];
        firstAnswerIndex?: number;
    }[];
    score: null | {
        total: number;
        firstCorrect: number;
        finalCorrect: number;
        firstCorrectRate: number;
        finalScore: number;
    };
};
export type History = {
    id: string;
    quizId: string;
    title: string;
    status: string;
    questionCount: number;
    answeredCount: number;
    score: Review['score'];
    createdAt: string;
};
export type Origin = {
    attemptId: string;
    questionIndex: number;
    firstWrong: boolean;
    finalWrong: boolean;
    firstAnswerIndex: number;
    finalAnswerIndex: number;
    submittedAt: string;
    question: {
        prompt: string;
        options: string[];
        answerIndex: number;
        explanation: string;
        citations: {
            sourceId: string;
            quote: string;
            version: number;
            page: number | null;
        }[];
    };
    sourceSnapshots: {
        sourceId: string;
        title: string;
        body: string;
        version: number;
    }[];
};
export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const bad = () => new AuthApiError('invalid_response', '无法读取错题服务返回的内容，请重新读取。', 502);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
export function parseMistakeReview(v: Review, set: string): Review {
    if (!v || typeof v.title !== 'string' || !uuid.test(v.id) || v.studySetId !== set || !uuid.test(v.quizId) || !count(v.version) || v.version < 1 || !['in_progress', 'submitted'].includes(v.status) || !Array.isArray(v.questions) || v.questions.length < 1 || v.questions.length > 20)
        throw bad();
    if (v.questions.some((q, i) => !q || q.index !== i || !count(q.originalQuestionIndex) || q.originalQuestionIndex > 19 || typeof q.prompt !== 'string' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6 || q.options.some(o => typeof o !== 'string') || !(q.selectedAnswerIndex === null || (count(q.selectedAnswerIndex) && q.selectedAnswerIndex < q.options.length)) || q.selectedAnswerIndex === null && (q.correctAnswerIndex !== undefined || q.correct !== undefined || q.explanation !== undefined)))
        throw bad();
    if ((v.score !== null && (typeof v.score !== 'object' || Array.isArray(v.score))) || v.score === undefined || (v.status === 'submitted') !== (v.score !== null))
        throw bad();
    if (v.score && (!count(v.score.total) || v.score.total !== v.questions.length || !count(v.score.firstCorrect) || !count(v.score.finalCorrect) || v.score.firstCorrect > v.score.total || v.score.finalCorrect > v.score.total || v.score.firstCorrectRate !== Math.round(v.score.firstCorrect * 1000 / v.score.total) / 10 || v.score.finalScore !== Math.round(v.score.finalCorrect * 1000 / v.score.total) / 10))
        throw bad();
    if (v.questions.some(q => q.selectedAnswerIndex !== null && (!count(q.correctAnswerIndex) || q.correctAnswerIndex >= q.options.length || typeof q.correct !== 'boolean' || q.correct !== (q.selectedAnswerIndex === q.correctAnswerIndex) || typeof q.explanation !== 'string' || !count(q.firstAnswerIndex) || q.firstAnswerIndex >= q.options.length || !Array.isArray(q.citations) || !Array.isArray(q.sourceSnapshots)))) throw bad();
    if (v.status === 'submitted' && v.questions.some(q=>q.selectedAnswerIndex === null)) throw bad();
    return v;
}
export function createMistakeApi(request: <T>(path: string, options?: RequestOptions) => Promise<T>, set: string, signal: AbortSignal | (() => AbortSignal)) {
    if (!uuid.test(set))
        throw bad();
    const root = `/v1/study/sets/${set}`;
    const send = async <T,>(path: string, options: RequestOptions = {}) => {
        const active = typeof signal === 'function' ? signal() : signal;
        throwIfAborted(active);
        const v = await request<T>(root + path, { ...options, signal: active });
        throwIfAborted(active);
        return v;
    };
    const id = (v: string) => {
        if (!uuid.test(v))
            throw bad();
        return v;
    };
    const review = async (path: string, options?: RequestOptions) => parseMistakeReview((await send<{
        review: Review;
    }>(path, options)).review, set);
    return {
        list: async (options: {
            quizId?: string;
            attemptId?: string;
            cursor?: string;
        } = {}) => {
            const query = new URLSearchParams(Object.entries(options).filter((entry): entry is [
                string,
                string
            ] => typeof entry[1] === 'string')).toString();
            const v = await send<{
                enabled: boolean;
                items: Mistake[];
                nextCursor: string | null;
            }>('/mistakes' + (query ? '?' + query : ''));
            if (!v || typeof v.enabled !== 'boolean' || !Array.isArray(v.items) || !(v.nextCursor === null || typeof v.nextCursor === 'string') || v.items.some(x => !uuid.test(x.quizId) || !count(x.questionIndex) || x.questionIndex > 19 || typeof x.prompt !== 'string' || !count(x.wrongCount) || x.wrongCount < 1 || !count(x.firstWrongCount) || !count(x.finalWrongCount)))
                throw bad();
            return v;
        },
        detail: async (quiz: string, index: number, cursor?: string) => {
            const v = await send<{origins:Origin[];nextCursor:string|null}>(`/mistakes/${id(quiz)}/${index}${cursor?'?cursor='+id(cursor):''}`);
            if(!v || !Array.isArray(v.origins) || !(v.nextCursor===null || uuid.test(v.nextCursor)) || v.origins.some(o=>!o || !uuid.test(o.attemptId) || o.questionIndex!==index || typeof o.firstWrong!=='boolean' || typeof o.finalWrong!=='boolean' || !o.question || typeof o.question.prompt!=='string' || !Array.isArray(o.question.options) || !count(o.question.answerIndex) || o.question.answerIndex>=o.question.options.length || typeof o.question.explanation!=='string' || !Array.isArray(o.question.citations) || o.question.citations.some(c=>!c || typeof c.quote!=='string' || !count(c.version)) || !Array.isArray(o.sourceSnapshots) || o.sourceSnapshots.some(s=>!s || typeof s.body!=='string')))throw bad();
            return v;
        },
        history: async (cursor?:string) => {
            const v=await send<{items:History[];nextCursor:string|null}>('/mistake-reviews'+(cursor?'?cursor='+id(cursor):''));
            if(!v || !Array.isArray(v.items) || !(v.nextCursor===null || uuid.test(v.nextCursor)) || v.items.some(h=>!h || !uuid.test(h.id) || !uuid.test(h.quizId) || typeof h.title!=='string' || !['in_progress','submitted'].includes(h.status) || !count(h.questionCount) || h.questionCount<1 || h.questionCount>20 || !count(h.answeredCount) || h.answeredCount>h.questionCount || (h.status==='submitted')!==(h.score!==null)))throw bad();
            return v;
        },
        start: (body: Record<string, unknown>) => review('/mistake-reviews', { method: 'POST', body }),
        get: async (reviewId: string) => {const v=await review('/mistake-reviews/' + id(reviewId));if(v.id!==reviewId)throw bad();return v;},
        answer: (r: Review, index: number, choice: number, clientRequestId: string) => review(`/mistake-reviews/${id(r.id)}/answers`, { method: 'POST', body: { version: r.version, questionIndex: index, answerIndex: choice, clientRequestId } }),
        submit: (r: Review, clientRequestId: string) => review(`/mistake-reviews/${id(r.id)}/submit`, { method: 'POST', body: { version: r.version, clientRequestId } })
    };
}
