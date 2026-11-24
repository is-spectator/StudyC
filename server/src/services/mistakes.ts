import {requireVisibleSet} from './set-visibility.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db, Queryable } from '../db/db.js';
import { MISTAKE_BACKFILL_SQL } from '../db/mistakes-schema.js';
import { requireActiveUser } from './identity.js';
import { GenerationError } from '../generation/types.js';
const uuid = z.uuid().transform(v => v.toLowerCase());
const version = z.number().int().min(1).max(2147483646);
export const mistakeStartInput = z.object({ clientRequestId: uuid, quizId: uuid, questionIndices: z.array(z.number().int().min(0).max(19)).min(1).max(20).refine(v => new Set(v).size === v.length).transform(v => v.sort((a, b) => a - b)) }).strict();
export const mistakeAnswerInput = z.object({ clientRequestId: uuid, version, questionIndex: z.number().int().min(0).max(19), answerIndex: z.number().int().min(0).max(5) }).strict();
export const mistakeSubmitInput = z.object({ clientRequestId: uuid, version }).strict();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const missing = () => new GenerationError('not_found', '没有找到这道错题或重练记录。');
const conflict = () => new GenerationError('version_conflict', '作答已在另一页面更新，请重新读取。');
const mismatch = () => new GenerationError('idempotency_conflict', '这个请求标识已经用于其他内容。');
type Row = Record<string, any>;
export async function collectMistakes(q: Queryable, user: string, attempt: string) {
    await q.query(MISTAKE_BACKFILL_SQL + ' AND a.user_id=$1 AND a.id=$2 ON CONFLICT(attempt_id,question_index) DO NOTHING', [user, attempt]);
}
export async function backfillMistakes(db: Db) {
    return db.tx(async (q) => {
        const rows = await q.query(MISTAKE_BACKFILL_SQL + ' ON CONFLICT(attempt_id,question_index) DO NOTHING RETURNING attempt_id');
        return { inserted: rows.length };
    });
}
async function scope(q: Queryable, user: string, set: string) { return requireVisibleSet(q,user,set); }
function present(row: Row) {
    const d = row.data;
    const total = d.items.length;
    return { id: row.id, studySetId: row.study_set_id, quizId: row.quiz_id, title: d.title, status: d.status, version: d.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), questions: d.items.map((item: any, index: number) => {
            const selected = d.answers[index] ?? null;
            return { index, originalQuestionIndex: item.originalIndex, type: item.question.type, prompt: item.question.prompt, options: item.question.options, selectedAnswerIndex: selected, ...(selected !== null ? { correctAnswerIndex: item.question.answerIndex, correct: selected === item.question.answerIndex, explanation: item.question.explanation, citations: item.question.citations, sourceSnapshots: item.sources, firstAnswerIndex: d.firstAnswers[index] } : {}) };
        }), score: d.status === 'submitted' ? { total, firstCorrect: d.items.filter((item: any, i: number) => d.firstAnswers[i] === item.question.answerIndex).length, finalCorrect: d.items.filter((item: any, i: number) => d.answers[i] === item.question.answerIndex).length, firstCorrectRate: Math.round(d.items.filter((item: any, i: number) => d.firstAnswers[i] === item.question.answerIndex).length * 1000 / total) / 10, finalScore: Math.round(d.items.filter((item: any, i: number) => d.answers[i] === item.question.answerIndex).length * 1000 / total) / 10 } : null };
}
export class MistakeService {
    constructor(private db: Db) {
    }
    private writable() {
        if (process.env.STUDYC_MISTAKES_ENABLED === 'false')
            throw new GenerationError('service_unavailable', '错题重练暂时关闭，已有记录和成绩保留。');
    }
    private async review(q: Queryable, user: string, set: string, id: string) {
        const [r] = await q.query<Row>('SELECT * FROM study_mistake_reviews WHERE user_id=$1 AND study_set_id=$2 AND id=$3', [user, set, id]);
        if (!r)
            throw missing();
        return r;
    }
    async list(user: string, set: string, options: {
        quizId?: string;
        attemptId?: string;
        cursor?: string;
        limit: number;
    }) {
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            if (options.quizId && !(await q.query('SELECT id FROM study_quizzes WHERE id=$1 AND user_id=$2 AND study_set_id=$3', [options.quizId, user, set])).length)
                throw missing();
            if (options.attemptId && !(await q.query("SELECT a.id FROM study_quiz_attempts a JOIN study_quizzes z ON z.id=a.quiz_id AND z.user_id=a.user_id WHERE a.id=$1 AND a.user_id=$2 AND z.study_set_id=$3 AND a.status='submitted'", [options.attemptId, user, set])).length)
                throw missing();
            let cursorQuiz: string | undefined, cursorIndex: number | undefined;
            if (options.cursor) {
                const bits = options.cursor.split(':');
                cursorQuiz = uuid.parse(bits[0]);
                cursorIndex = z.coerce.number().int().min(0).max(19).parse(bits[1]);
                if (bits.length !== 2)
                    throw new GenerationError('invalid_input', '分页标识无效。');
                if (!(await q.query('SELECT 1 FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND quiz_id=$3 AND question_index=$4', [user, set, cursorQuiz, cursorIndex])).length)
                    throw missing();
            }
            const rows = await q.query<Row>(`SELECT quiz_id,question_index,count(*)::int AS wrong_count,count(*) FILTER(WHERE first_wrong)::int AS first_wrong_count,count(*) FILTER(WHERE final_wrong)::int AS final_wrong_count FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND ($3::uuid IS NULL OR quiz_id=$3) AND ($4::uuid IS NULL OR attempt_id=$4) AND ($5::uuid IS NULL OR (quiz_id,question_index)>($5,$6)) GROUP BY quiz_id,question_index ORDER BY quiz_id,question_index LIMIT $7`, [user, set, options.quizId ?? null, options.attemptId ?? null, cursorQuiz ?? null, cursorIndex ?? null, options.limit + 1]);
            const items = [];
            for (const r of rows.slice(0, options.limit)) {
                const [latest] = await q.query<Row>('SELECT * FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND quiz_id=$3 AND question_index=$4 ORDER BY submitted_at DESC,attempt_id DESC LIMIT 1', [user, set, r.quiz_id, r.question_index]);
                const [review] = await q.query<Row>(`SELECT r.id,r.updated_at,item.value AS item,(r.data->'answers'->>p.position::text)::int AS selected FROM study_mistake_reviews r CROSS JOIN LATERAL jsonb_array_elements(r.data->'items') WITH ORDINALITY item(value,n) CROSS JOIN LATERAL (SELECT (item.n-1)::int AS position) p WHERE r.user_id=$1 AND r.study_set_id=$2 AND r.quiz_id=$3 AND r.data->>'status'='submitted' AND (item.value->>'originalIndex')::int=$4 ORDER BY r.updated_at DESC,r.id DESC LIMIT 1`, [user, set, r.quiz_id, r.question_index]);
                items.push({ quizId: r.quiz_id, questionIndex: r.question_index, quizTitle: latest!.title, prompt: latest!.question.prompt, type: latest!.question.type, wrongCount: r.wrong_count, firstWrongCount: r.first_wrong_count, finalWrongCount: r.final_wrong_count, latestSubmittedAt: latest!.submitted_at.toISOString(), latestReview: review ? { id: review.id, correct: review.selected === review.item.question.answerIndex, submittedAt: review.updated_at.toISOString() } : null });
            }
            return { enabled: process.env.STUDYC_MISTAKES_ENABLED !== 'false', items, nextCursor: rows.length > options.limit ? `${rows[options.limit - 1]!.quiz_id}:${rows[options.limit - 1]!.question_index}` : null };
        });
    }
    async detail(user: string, set: string, quiz: string, index: number, cursor?: string) {
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            let marker: Row | undefined;
            if (cursor) {
                [marker] = await q.query<Row>('SELECT * FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND quiz_id=$3 AND question_index=$4 AND attempt_id=$5', [user, set, quiz, index, cursor]);
                if (!marker)
                    throw missing();
            }
            const rows = await q.query<Row>(`SELECT * FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND quiz_id=$3 AND question_index=$4 ${marker ? 'AND (submitted_at,attempt_id)<($5,$6)' : ''} ORDER BY submitted_at DESC,attempt_id DESC LIMIT 21`, [user, set, quiz, index, ...(marker ? [marker.submitted_at, marker.attempt_id] : [])]);
            if (!rows.length && !marker)
                throw missing();
            return { origins: rows.slice(0, 20).map(r => ({ attemptId: r.attempt_id, questionIndex: r.question_index, firstWrong: r.first_wrong, finalWrong: r.final_wrong, firstAnswerIndex: r.first_answer, finalAnswerIndex: r.final_answer, question: r.question, sourceSnapshots: r.sources, submittedAt: r.submitted_at.toISOString() })), nextCursor: rows.length > 20 ? rows[19]!.attempt_id : null };
        });
    }
    async start(user: string, set: string, raw: unknown) {
        this.writable();
        const input = mistakeStartInput.parse(raw), digest = hash([set, input.quizId, input.questionIndices]);
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            const [old] = await q.query<Row>('SELECT * FROM study_mistake_reviews WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
            if (old) {
                if (old.digest !== digest)
                    throw mismatch();
                return { review: present(old), replayed: true };
            }
            const items = [];
            let title = '';
            for (const index of input.questionIndices) {
                const [r] = await q.query<Row>('SELECT * FROM study_mistake_facts WHERE user_id=$1 AND study_set_id=$2 AND quiz_id=$3 AND question_index=$4 ORDER BY submitted_at DESC,attempt_id DESC LIMIT 1', [user, set, input.quizId, index]);
                if (!r)
                    throw missing();
                title = r.title;
                items.push({ originalIndex: index, question: r.question, sources: r.sources, originAttemptId: r.attempt_id });
            }
            const [row] = await q.query<Row>('INSERT INTO study_mistake_reviews(user_id,study_set_id,quiz_id,client_request_id,digest,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *', [user, set, input.quizId, input.clientRequestId, digest, JSON.stringify({ title, items, answers: {}, firstAnswers: {}, version: 1, status: 'in_progress' })]);
            return { review: present(row!), replayed: false };
        }, `studyc:mistakes:${user}`);
    }
    async get(user: string, set: string, id: string) {
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            return present(await this.review(q, user, set, id));
        });
    }
    async history(user: string, set: string, quiz?: string, cursor?: string) {
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            if (quiz && !(await q.query('SELECT id FROM study_quizzes WHERE user_id=$1 AND study_set_id=$2 AND id=$3', [user, set, quiz])).length)
                throw missing();
            if (cursor) {
                const marker = await this.review(q, user, set, cursor);
                if (quiz && marker.quiz_id !== quiz)
                    throw missing();
            }
            const rows = await q.query<Row>(`SELECT * FROM study_mistake_reviews WHERE user_id=$1 AND study_set_id=$2 AND ($3::uuid IS NULL OR quiz_id=$3) ${cursor ? 'AND (created_at,id)<(SELECT created_at,id FROM study_mistake_reviews WHERE id=$4 AND user_id=$1)' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`, [user, set, quiz ?? null, ...(cursor ? [cursor] : [])]);
            return { items: rows.slice(0, 20).map(r => ({ id: r.id, quizId: r.quiz_id, title: r.data.title, status: r.data.status, questionCount: r.data.items.length, answeredCount: Object.keys(r.data.answers).length, score: r.data.status === 'submitted' ? present(r).score : null, createdAt: r.created_at.toISOString() })), nextCursor: rows.length > 20 ? rows[19]!.id : null };
        });
    }
    async mutate(user: string, set: string, id: string, raw: unknown, kind: 'answer' | 'submit') {
        this.writable();
        const input = kind === 'answer' ? mistakeAnswerInput.parse(raw) : mistakeSubmitInput.parse(raw), digest = hash([set, id, kind, input]);
        return this.db.tx(async (q) => {
            await scope(q, user, set);
            const r = await this.review(q, user, set, id), d = r.data;
            const [old] = await q.query<Row>('SELECT digest FROM study_mistake_review_events WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]);
            if (old) {
                if (old.digest !== digest)
                    throw mismatch();
                return { review: present(r), replayed: true };
            }
            if (d.status !== 'in_progress' || d.version !== input.version)
                throw conflict();
            let position: number | null = null, answer: number | null = null;
            if (kind === 'answer') {
                const a = mistakeAnswerInput.parse(raw);
                position = a.questionIndex;
                answer = a.answerIndex;
                const item = d.items[position];
                if (!item || answer >= item.question.options.length)
                    throw new GenerationError('invalid_input', '选项无效。');
                d.firstAnswers[position] ??= answer;
                d.answers[position] = answer;
            }
            else {
                if (Object.keys(d.answers).length !== d.items.length)
                    throw new GenerationError('invalid_input', '还有未作答的题目。');
                d.status = 'submitted';
            }
            d.version++;
            await q.query('INSERT INTO study_mistake_review_events(user_id,review_id,client_request_id,digest,kind,position,answer_index) VALUES($1,$2,$3,$4,$5,$6,$7)', [user, id, input.clientRequestId, digest, kind, position, answer]);
            const [saved] = await q.query<Row>('UPDATE study_mistake_reviews SET data=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, JSON.stringify(d)]);
            return { review: present(saved!), replayed: false };
        }, `studyc:mistakes:${user}`);
    }
}
