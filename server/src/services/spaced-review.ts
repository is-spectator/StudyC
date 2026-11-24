import {requireVisibleSet} from './set-visibility.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Db, Queryable } from '../db/db.js';
import { requireActiveUser } from './identity.js';
import { DomainError } from './errors.js';
import { StudyError } from './study-data.js';
const uuid = z.uuid().transform(v => v.toLowerCase());
const startInput = z.object({ clientRequestId: uuid }).strict();
const actionInput = z.object({ clientRequestId: uuid, version: z.number().int().positive(), position: z.number().int().min(0).max(19), cardId: uuid, action: z.enum(['rate', 'skip_stale']), rating: z.enum(['again', 'hard', 'good', 'easy']).optional() }).strict().refine(v => v.action === 'rate' ? !!v.rating : v.rating === undefined);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const conflict = () => new DomainError('version_conflict', '复习进度已经变化，请重新读取。');
const mismatch = () => new StudyError('idempotency_conflict', '请求标识已用于其他操作。');
const missing = () => new DomainError('not_found', '没有找到这份复习记录。');
export const RULE = 'studyc-srs-v1';
export function schedule(stage: number, rating: string) { const next = rating === 'again' ? -1 : rating === 'hard' ? 0 : Math.min(stage + (rating === 'easy' ? 2 : 1), 5); return { stage: next, seconds: next === -1 ? 600 : [1, 3, 7, 14, 30, 60][next]! * 86400 }; }
type Row = Record<string, any>;
export class SpacedReviewService {
    constructor(private db: Db, private clock = () => new Date(), private enabled = () => process.env.STUDYC_SRS_ENABLED !== 'false') { }
    private writable() { if (!this.enabled())
        throw new DomainError('invalid_input', '到期复习已关闭，已有记录保留，可返回自由翻卡。'); }
    private async owned(q: Queryable, user: string, set: string, deck: string) { await requireVisibleSet(q, user, set); const [d] = await q.query<Row>('SELECT * FROM study_flashcard_decks WHERE user_id=$1 AND study_set_id=$2 AND id=$3', [user, set, deck]); if (!d)
        throw missing(); return d; }
    private async cards(q: Queryable, user: string, set: string, deck: string) { return q.query<Row>(`SELECT c.*,s.revision AS schedule_revision,s.card_version AS schedule_card_version,s.stage,s.due_at FROM study_flashcards c LEFT JOIN study_flashcard_schedules s ON s.card_id=c.id AND s.user_id=c.user_id WHERE c.user_id=$1 AND c.study_set_id=$2 AND c.deck_id=$3 ORDER BY c.position,c.id`, [user, set, deck]); }
    private async read(q: Queryable, user: string, set: string, deck: string, id: string) { const [row] = await q.query<Row>('SELECT * FROM study_spaced_review_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND id=$4', [user, set, deck, id]); if (!row)
        throw missing(); return row; }
    private async decorate(q: Queryable, row: Row) { const s = structuredClone(row.data), c = s.cards[s.nextIndex];
        s.createdAt ??= row.created_at.toISOString();
        if (!s.updatedAt) {
            const [last] = await q.query<Row>("SELECT outcome->>'occurredAt' AS occurred_at FROM study_spaced_review_actions WHERE user_id=$1 AND session_id=$2 ORDER BY position DESC LIMIT 1", [row.user_id,row.id]);
            s.updatedAt = last?.occurred_at ?? s.createdAt;
        }
        s.current = null; if (c) {
        const [live] = await q.query<Row>('SELECT c.version,s.revision FROM study_flashcards c LEFT JOIN study_flashcard_schedules s ON s.card_id=c.id AND s.user_id=c.user_id WHERE c.id=$1 AND c.user_id=$2 AND c.study_set_id=$3 AND c.deck_id=$4', [c.id, row.user_id, row.study_set_id, row.deck_id]);
        const staleReason = !live || live.version !== c.version ? 'card_changed' : (live.revision ?? null) !== c.expectedScheduleRevision ? 'already_reviewed' : null;
        s.current = { cardId: c.id, position: s.nextIndex, staleReason, ratingIntervalsSeconds: staleReason ? null : Object.fromEntries(['again', 'hard', 'good', 'easy'].map(r => [r, schedule(c.effectiveStage, r).seconds])) };
    } return s; }
    async queue(user: string, set: string, deck: string) { return this.db.tx(async (q) => { await this.owned(q, user, set, deck); const now = this.clock(), cards = await this.cards(q, user, set, deck), fresh = cards.filter(c => c.schedule_card_version !== c.version), due = cards.filter(c => c.schedule_card_version === c.version && c.due_at <= now).sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id)), future = cards.filter(c => c.schedule_card_version === c.version && c.due_at > now).sort((a, b) => a.due_at - b.due_at); const sessions = await q.query<Row>("SELECT * FROM study_spaced_review_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND data->>'status'='in_progress' ORDER BY created_at DESC,id DESC LIMIT 1", [user, set, deck]); const ratings = await q.query<Row>(`SELECT a.outcome->>'appliedRating' AS rating,count(*)::int AS count FROM study_spaced_review_actions a JOIN study_spaced_review_sessions r ON r.id=a.session_id AND r.user_id=a.user_id WHERE r.user_id=$1 AND r.study_set_id=$2 AND r.deck_id=$3 AND a.outcome->>'kind'='reviewed' GROUP BY a.outcome->>'appliedRating'`, [user, set, deck]); return { metrics: { totalReviews: ratings.reduce((n, r) => n + r.count, 0), ratings: Object.fromEntries(['again', 'hard', 'good', 'easy'].map(k => [k, ratings.find(r => r.rating === k)?.count ?? 0])) }, enabled: this.enabled(), serverNow: now.toISOString(), newCount: fresh.length, dueCount: due.length, nextDueAt: future[0]?.due_at.toISOString() ?? null, lastSession: sessions[0] ? { id: sessions[0].id, nextIndex: sessions[0].data.nextIndex, total: sessions[0].data.cards.length } : null, candidates: [...due, ...fresh].slice(0, 20).map(c => ({ cardId: c.id, cardVersion: c.version, kind: c.schedule_card_version === c.version ? 'due' : 'new' })) }; }); }
    async start(user: string, set: string, deck: string, raw: unknown) { this.writable(); const input = startInput.parse(raw), digest = hash([set, deck]); return this.db.tx(async (q) => { const d = await this.owned(q, user, set, deck); const [old] = await q.query<Row>('SELECT * FROM study_spaced_review_sessions WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]); if (old) {
        if (old.digest !== digest)
            throw mismatch();
        return { session: await this.decorate(q, old), replayed: true };
    } const now = this.clock(), all = await this.cards(q, user, set, deck), due = all.filter(c => c.schedule_card_version === c.version && c.due_at <= now).sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id)), fresh = all.filter(c => c.schedule_card_version !== c.version); const cards = [...due, ...fresh].slice(0, 20).map(c => ({ id: c.id, front: c.front, back: c.back, version: c.version, position: c.position, citations: c.citations, effectiveStage: c.schedule_card_version === c.version ? c.stage : -1, expectedScheduleRevision: c.schedule_revision ?? null })); if (!cards.length)
        throw new DomainError('no_cards_due', '现在没有待复习卡片。'); const [row] = await q.query<Row>('INSERT INTO study_spaced_review_sessions(user_id,study_set_id,deck_id,client_request_id,digest,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *', [user, set, deck, input.clientRequestId, digest, JSON.stringify({ schemaVersion: 1, mode: 'spaced_review', studySetId: set, deckId: deck, status: 'in_progress', version: 1, ruleVersion: RULE, nextIndex: 0, cards, sourceSnapshots: d.source_snapshots, reviewedCount: 0, skippedCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() })]); row!.data.id = row!.id; await q.query('UPDATE study_spaced_review_sessions SET data=$2::jsonb WHERE id=$1', [row!.id, JSON.stringify(row!.data)]); return { session: await this.decorate(q, row!), replayed: false }; }, user); }
    async get(user: string, set: string, deck: string, id: string) { return this.db.tx(async (q) => { await this.owned(q, user, set, deck); return this.decorate(q, await this.read(q, user, set, deck, id)); }); }
    async act(user: string, set: string, deck: string, id: string, raw: unknown) { this.writable(); const input = actionInput.parse(raw), digest = hash([set, deck, id, input.version, input.position, input.cardId, input.action, input.rating ?? null]); return this.db.tx(async (q) => { await this.owned(q, user, set, deck); const row = await this.read(q, user, set, deck, id); const [old] = await q.query<Row>('SELECT * FROM study_spaced_review_actions WHERE user_id=$1 AND client_request_id=$2', [user, input.clientRequestId]); if (old) {
        if (old.digest !== digest)
            throw mismatch();
        return { outcome: old.outcome, session: await this.decorate(q, row), replayed: true };
    } const s = await this.decorate(q, row), card = s.cards[s.nextIndex]; if (s.status !== 'in_progress' || s.version !== input.version || s.nextIndex !== input.position || card?.id !== input.cardId)
        throw conflict(); const reason = s.current.staleReason; if (input.action === 'skip_stale' && !reason)
        throw conflict(); const now = this.clock(), [before] = await q.query<Row>('SELECT * FROM study_flashcard_schedules WHERE user_id=$1 AND card_id=$2', [user, card.id]); let after: Row | null = null; const next = reason ? null : schedule(card.effectiveStage, input.rating!); if (next) {
        const [value] = await q.query<Row>(`INSERT INTO study_flashcard_schedules(card_id,user_id,card_version,revision,stage,rule_version,due_at,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(card_id) DO UPDATE SET card_version=excluded.card_version,revision=excluded.revision,stage=excluded.stage,rule_version=excluded.rule_version,due_at=excluded.due_at,reviewed_at=excluded.reviewed_at RETURNING *`, [card.id, user, card.version, (before?.revision ?? 0) + 1, next.stage, RULE, new Date(now.getTime() + next.seconds * 1000), now]);
        after = value!;
    } const outcome = { kind: reason ? 'skipped' : 'reviewed', reason: reason ?? null, cardId: card.id, position: s.nextIndex, appliedRating: reason ? null : input.rating, occurredAt: now.toISOString(), nextDueAt: after?.due_at.toISOString() ?? null }; await q.query('INSERT INTO study_spaced_review_actions(user_id,session_id,position,client_request_id,digest,outcome,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)', [user, id, s.nextIndex, input.clientRequestId, digest, JSON.stringify(outcome), JSON.stringify(before ?? null), JSON.stringify(after)]); delete s.current; s.updatedAt = now.toISOString(); s.nextIndex++; s.version++; s.reviewedCount += reason ? 0 : 1; s.skippedCount += reason ? 1 : 0; s.status = s.nextIndex === s.cards.length ? 'completed' : 'in_progress'; row.data = s; await q.query('UPDATE study_spaced_review_sessions SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(s)]); return { outcome, session: await this.decorate(q, row), replayed: false }; }, user); }
}
