import type { Card, Source } from './api';
export const ratingLabels = { again: '还没记住', hard: '有些吃力', good: '基本记住', easy: '很熟悉' };
export type Rating = keyof typeof ratingLabels;
export type SpacedSession = {
  schemaVersion: 1; mode: 'spaced_review'; id: string; deckId: string; studySetId: string;
  ruleVersion: 'studyc-srs-v1'; status: 'in_progress' | 'completed'; version: number; nextIndex: number;
  cards: Card[]; sourceSnapshots: Source[]; reviewedCount: number; skippedCount: number;
  current: null | { cardId: string; position: number; staleReason: 'card_changed' | 'already_reviewed' | null; ratingIntervalsSeconds: Record<Rating, number> | null };
};
export type SpacedQueue = {
  metrics: { totalReviews: number; ratings: Record<Rating, number> }; enabled: boolean;
  newCount: number; dueCount: number; nextDueAt: string | null;
  lastSession: null | { id: string; nextIndex: number; total: number };
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const bad = () => new Error('无法读取复习记录，请重新读取。');
/** Validate both modes before either recovery request; never silently select one. */
export function reviewSelection(search: string) {
  const params = new URLSearchParams(search);
  const keys = ['flashcardSession', 'spacedReviewSession'];
  if (keys.some(k => params.getAll(k).length > 1) || keys.every(k => params.has(k))) throw new Error('复习模式链接冲突，请返回卡组重新进入。');
  for (const key of keys) if (params.has(key) && !uuid.test(params.get(key)!)) throw new Error('复习链接无效，请返回卡组重新进入。');
  return { free: params.get('flashcardSession'), spaced: params.get('spacedReviewSession') };
}
function validSource(s: unknown) {
  return record(s) && typeof s.sourceId === 'string' && uuid.test(s.materialId) && count(s.version) && s.version > 0 && typeof s.title === 'string' && typeof s.body === 'string';
}
function validCitation(c: unknown) {
  return record(c) && typeof c.sourceId === 'string' && uuid.test(c.materialId) && count(c.version) && c.version > 0 && typeof c.quote === 'string' && count(c.start) && count(c.end) && c.end > c.start && (c.page === null || (count(c.page) && c.page > 0));
}
export function parseSpacedSession(value: unknown, setId: string, deckId: string): SpacedSession {
  if (!record(value)) throw bad();
  const v = value;
  if (v.schemaVersion !== 1 || v.mode !== 'spaced_review' || v.ruleVersion !== 'studyc-srs-v1'
    || !uuid.test(v.id) || v.studySetId !== setId || v.deckId !== deckId || !count(v.version) || v.version < 1
    || !Array.isArray(v.cards) || v.cards.length < 1 || v.cards.length > 20 || !Array.isArray(v.sourceSnapshots) || !v.sourceSnapshots.every(validSource)
    || !count(v.nextIndex) || v.nextIndex > v.cards.length || !count(v.reviewedCount) || !count(v.skippedCount)
    || v.reviewedCount + v.skippedCount !== v.nextIndex
    || v.status !== (v.nextIndex === v.cards.length ? 'completed' : 'in_progress')) throw bad();
  if (!v.cards.every((c: unknown) => record(c) && uuid.test(c.id) && typeof c.front === 'string' && typeof c.back === 'string' && count(c.version) && c.version > 0 && count(c.position) && Number.isInteger(c.effectiveStage) && c.effectiveStage >= -1 && c.effectiveStage <= 5 && (c.expectedScheduleRevision === null || (count(c.expectedScheduleRevision) && c.expectedScheduleRevision > 0)) && Array.isArray(c.citations) && c.citations.every(validCitation))) throw bad();
  if (v.status === 'completed') { if (v.current !== null) throw bad(); }
  else {
    const c = v.current;
    if (!record(c) || c.cardId !== v.cards[v.nextIndex].id || c.position !== v.nextIndex || ![null,'card_changed','already_reviewed'].includes(c.staleReason)) throw bad();
    if (c.staleReason !== null) { if (c.ratingIntervalsSeconds !== null) throw bad(); }
    else if (!record(c.ratingIntervalsSeconds) || !Object.keys(ratingLabels).every(k => count(c.ratingIntervalsSeconds[k]) && c.ratingIntervalsSeconds[k] > 0)) throw bad();
  }
  return v as SpacedSession;
}
export function parseSpacedQueue(v: unknown): SpacedQueue {
  if (!record(v) || typeof v.enabled !== 'boolean' || !count(v.newCount) || !count(v.dueCount) || !(v.nextDueAt === null || date(v.nextDueAt))
    || !record(v.metrics) || !count(v.metrics.totalReviews) || !record(v.metrics.ratings)
    || !Object.keys(ratingLabels).every(k => count(v.metrics.ratings[k]))
    || Object.keys(ratingLabels).reduce((sum,k)=>sum+v.metrics.ratings[k],0) !== v.metrics.totalReviews) throw bad();
  if (v.lastSession !== null && (!record(v.lastSession) || !uuid.test(v.lastSession.id) || !count(v.lastSession.nextIndex) || !count(v.lastSession.total) || v.lastSession.total < 1 || v.lastSession.total > 20 || v.lastSession.nextIndex >= v.lastSession.total)) throw bad();
  return v as SpacedQueue;
}
