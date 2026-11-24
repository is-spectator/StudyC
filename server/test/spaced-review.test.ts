import {dropAdditionsAfter} from './database.js';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { randomUUID as id } from 'node:crypto';
import { openTestDb } from './database.js';
import type { Db } from '../src/db/db.js';
import { createStudySet } from '../src/services/study-data.js';
import { FlashcardService } from '../src/services/flashcards.js';
import { SpacedReviewService, schedule } from '../src/services/spaced-review.js';
import { SPACED_SQL } from '../src/db/spaced-review-schema.js';
let db: Db, f: FlashcardService, s: SpacedReviewService, user: string, set: string, deck: string, other: string, now: Date;
beforeAll(async () => { db = await openTestDb(); const [r] = await db.query<{
    present: boolean;
}>("SELECT to_regclass('study_flashcard_schedules') IS NOT NULL AS present"); if (!r!.present)
    await db.exec(SPACED_SQL); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.query('DELETE FROM users'); const rows = await db.query<{
    id: string;
}>('INSERT INTO users VALUES(default,NULL,default),(default,NULL,default) RETURNING id'); user = rows[0]!.id; other = rows[1]!.id; set = (await createStudySet(db, user, { clientRequestId: id(), title: '复习测试' })).studySet.id; f = new FlashcardService(db); deck = (await f.create(user, set, { clientRequestId: id(), title: '卡组' })).deck.id; now = new Date('2026-11-24T00:00:00Z'); s = new SpacedReviewService(db, () => new Date(now)); });
async function card() { return (await f.addCard(user, set, deck, { clientRequestId: id(), front: '问题', back: '答案' })).card; }
async function start() { return (await s.start(user, set, deck, { clientRequestId: id() })).session; }
function body(v: any, rating = 'good') { return { clientRequestId: id(), version: v.version, position: v.nextIndex, cardId: v.cards[v.nextIndex].id, action: 'rate', rating }; }
it('defines all deterministic stages and cap', () => { expect(schedule(-1, 'easy')).toEqual({ stage: 1, seconds: 259200 }); for (let i = -1; i <= 5; i++) {
    expect(schedule(i, 'again')).toEqual({ stage: -1, seconds: 600 });
    expect(schedule(i, 'hard')).toEqual({ stage: 0, seconds: 86400 });
    expect(schedule(i, 'good')).toEqual({stage:Math.min(i+1,5),seconds:[1,3,7,14,30,60][Math.min(i+1,5)]!*86400});
    expect(schedule(i, 'easy')).toEqual({stage:Math.min(i+2,5),seconds:[1,3,7,14,30,60][Math.min(i+2,5)]!*86400});
} });
it('does not create empty sessions and isolates account/set/deck', async () => { await expect(start()).rejects.toMatchObject({ code: 'no_cards_due' }); await card(); await expect(s.queue(other, set, deck)).rejects.toMatchObject({ code: 'not_found' }); await expect(s.start(user, id(), deck, { clientRequestId: id() })).rejects.toMatchObject({ code: 'not_found' }); });
it('persists last card, replay and exact due boundary without altering old metrics', async () => { await card(); const v = await start(), b = body(v); const r = await s.act(user, set, deck, v.id, b); expect(r.session).toMatchObject({ status: 'completed', reviewedCount: 1, skippedCount: 0 }); expect(await s.act(user, set, deck, v.id, b)).toMatchObject({ replayed: true, outcome: r.outcome }); await expect(s.act(user, set, deck, v.id, { ...b, rating: 'easy' })).rejects.toMatchObject({ code: 'idempotency_conflict' }); expect((await f.get(user, set, deck)).metrics.totalReviews).toBe(0); now = new Date(Date.parse(r.outcome.nextDueAt!) - 1); expect(await s.queue(user, set, deck)).toMatchObject({ dueCount: 0, newCount: 0, nextDueAt: r.outcome.nextDueAt }); now = new Date(+now + 1); expect(await s.queue(user, set, deck)).toMatchObject({ dueCount: 1, nextDueAt: null }); now = new Date(+now + 1); expect((await s.queue(user, set, deck)).dueCount).toBe(1); });
it('only one of two overlapping sessions may schedule a card', async () => { await card(); const a = await start(), b = await start(); const outcomes = await Promise.all([s.act(user, set, deck, a.id, body(a)), s.act(user, set, deck, b.id, body(b))]); expect(outcomes.map(r => r.outcome.kind).sort()).toEqual(['reviewed', 'skipped']); expect(outcomes.find(r => r.outcome.kind === 'skipped')!.outcome.reason).toBe('already_reviewed'); });
it('edited version is new; frozen due session skips while free study stays valid', async () => { const c = await card(), v = await start(), free = (await f.start(user, set, deck, { clientRequestId: id() })).session; await f.editCard(user, set, deck, c.id, { version: 1, front: '新问题', back: '新答案' }); expect((await s.get(user, set, deck, v.id)).current.staleReason).toBe('card_changed'); const r = await s.act(user, set, deck, v.id, { ...body(v), action: 'skip_stale', rating: undefined }); expect(r.session).toMatchObject({ status: 'completed', reviewedCount: 0, skippedCount: 1 }); expect((await s.queue(user, set, deck)).newCount).toBe(1); expect((await f.review(user, set, deck, free.id, { clientRequestId: id(), version: 1, position: 0, cardId: c.id, rating: 'easy' })).session.status).toBe('completed'); });
it('limits fixed queue to 20 and fresh service resumes without including later cards', async () => { for (let i = 0; i < 21; i++)
    await card(); const request = { clientRequestId: id() }, v = (await s.start(user, set, deck, request)).session; expect(v.cards).toHaveLength(20); await card(); expect((await s.start(user, set, deck, request)).session.id).toBe(v.id); const r = await s.act(user, set, deck, v.id, body(v, 'again')); expect((await new SpacedReviewService(db).get(user, set, deck, v.id)).nextIndex).toBe(1); expect(r.session.cards).toHaveLength(20); expect((await s.queue(user, set, deck)).newCount).toBe(21); now = new Date(+now + 600000); expect((await s.queue(user, set, deck)).dueCount).toBe(1); });
it('keeps revision monotonic across edits and does not reset on rename', async () => { const c = await card(), a = await start(); await s.act(user, set, deck, a.id, body(a)); await f.rename(user, set, deck, { version: 1, title: '新名称' }); expect((await s.queue(user, set, deck)).newCount).toBe(0); await f.editCard(user, set, deck, c.id, { version: 1, front: '新', back: '答' }); const b = await start(); expect(b.cards[0].expectedScheduleRevision).toBe(1); await s.act(user, set, deck, b.id, body(b)); const [row] = await db.query<any>('SELECT revision FROM study_flashcard_schedules WHERE card_id=$1', [c.id]); expect(row.revision).toBe(2); });
it('rejects client time and skip for valid cards, and disables all writes', async () => { await card(); const a = await start(); await expect(s.act(user, set, deck, a.id, { ...body(a), dueAt: '2099' })).rejects.toThrow(); await expect(s.act(user, set, deck, a.id, { ...body(a), action: 'skip_stale', rating: undefined })).rejects.toMatchObject({ code: 'version_conflict' }); const off = new SpacedReviewService(db, () => now, () => false); expect((await off.queue(user, set, deck)).enabled).toBe(false); await expect(off.start(user, set, deck, { clientRequestId: id() })).rejects.toThrow('关闭'); await expect(off.act(user, set, deck, a.id, body(a))).rejects.toThrow('关闭'); });
it('enforces schedule owner guard and account deletion', async () => { const c = await card(); await expect(db.query("INSERT INTO study_flashcard_schedules VALUES($1,$2,1,1,0,'studyc-srs-v1',now(),now())", [c.id, other])).rejects.toThrow(); const a = await start(); await s.act(user, set, deck, a.id, body(a)); await db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [user]); await expect(s.queue(user, set, deck)).rejects.toMatchObject({ code: 'unauthorized' }); await db.query('DELETE FROM users WHERE id=$1', [user]); expect(await db.query('SELECT * FROM study_spaced_review_sessions')).toHaveLength(0); expect(await db.query('SELECT * FROM study_flashcard_schedules')).toHaveLength(0); });
it('upgrades a genuine v6 registry without rewriting history and detects owner guard drift', async () => { const { migrate, checkMigrations } = await import('../src/db/migrations.js'); const local = await openTestDb(); try {
    const [owner] = await local.query<{id:string}>('INSERT INTO users(id) VALUES(default) RETURNING id');
    const legacySet = (await createStudySet(local,owner!.id,{clientRequestId:id(),title:'迁移前已保存'})).studySet.id;
    const legacyService = new FlashcardService(local);
    const legacyDeck = (await legacyService.create(owner!.id,legacySet,{clientRequestId:id(),title:'既有卡组'})).deck.id;
    const legacyCard = (await legacyService.addCard(owner!.id,legacySet,legacyDeck,{clientRequestId:id(),front:'既有问题',back:'既有答案'})).card;
    const legacySession = (await legacyService.start(owner!.id,legacySet,legacyDeck,{clientRequestId:id()})).session;
    await legacyService.review(owner!.id,legacySet,legacyDeck,legacySession.id,{clientRequestId:id(),version:1,position:0,cardId:legacyCard.id,rating:'easy'});
    const legacyDetail=await legacyService.get(owner!.id,legacySet,legacyDeck);
    await dropAdditionsAfter(local,9);
    await local.exec(`DROP TABLE study_note_materializations; DROP TABLE study_note_origins; DROP TABLE study_notes; DELETE FROM studyc_schema_migrations WHERE version=9; ALTER TABLE study_generation_jobs DROP CONSTRAINT study_generation_jobs_kind_check; ALTER TABLE study_generation_jobs ADD CONSTRAINT study_generation_jobs_kind_check CHECK(kind IN ('study_outline','chat_answer','flashcards','quiz')); `);
    await local.exec('DROP TABLE study_mistake_review_events; DROP TABLE study_mistake_reviews; DROP TABLE study_mistake_facts; DROP TABLE study_spaced_review_actions; DROP TABLE study_spaced_review_sessions; DROP TABLE study_flashcard_schedules; DROP FUNCTION studyc_schedule_owner(); DELETE FROM studyc_schema_migrations WHERE version>=7;');
    const old = await local.query('SELECT * FROM studyc_schema_migrations ORDER BY version');
    await migrate(local);
    await migrate(local);
    await checkMigrations(local);
    expect(await local.query('SELECT * FROM studyc_schema_migrations WHERE version<=6 ORDER BY version')).toEqual(old);
    expect(await legacyService.get(owner!.id,legacySet,legacyDeck)).toEqual(legacyDetail);
    expect(await new SpacedReviewService(local).queue(owner!.id,legacySet,legacyDeck)).toMatchObject({newCount:1,dueCount:0,metrics:{totalReviews:0}});
    await local.exec('ALTER FUNCTION studyc_schedule_owner() SECURITY DEFINER');
    await expect(checkMigrations(local)).rejects.toThrow('owner function drift');
}
finally {
    await local.close();
} });
it('prioritizes overdue cards before new ones with stable due and id ordering', async()=>{
 const first=await card(),second=await card();let v=await start();v=(await s.act(user,set,deck,v.id,body(v,'again'))).session;await s.act(user,set,deck,v.id,body(v,'again'));
 const fresh=await card();now=new Date(+now+600000);
 const queue=await s.queue(user,set,deck),ids=[first.id,second.id].sort();expect(queue.candidates.map(c=>c.cardId)).toEqual([...ids,fresh.id]);expect(queue.candidates.map(c=>c.kind)).toEqual(['due','due','new']);expect((await start()).cards.map((c:any)=>c.id)).toEqual([...ids,fresh.id]);
});
it('bases overdue scheduling on the actual current review time and preserves exact interval previews',async()=>{
 await card();let v=await start();for(const [rating,days] of [['good',1],['good',3],['easy',14],['hard',1],['easy',7]] as const){
  expect(v.current.ratingIntervalsSeconds[rating]).toBe(days*86400);const submitted=+now,r=await s.act(user,set,deck,v.id,body(v,rating));expect(Date.parse(r.outcome.nextDueAt!)-submitted).toBe(days*86400000);expect(r.outcome.occurredAt).toBe(new Date(submitted).toISOString());now=new Date(Date.parse(r.outcome.nextDueAt!)+10*86400000);v=await start();
 }
});
it('keeps first action replay valid even after a newer card version has been reviewed',async()=>{
 const c=await card(),a=await start(),input=body(a),original=await s.act(user,set,deck,a.id,input);
 await f.editCard(user,set,deck,c.id,{version:1,front:'新版',back:'新版答案'});const b=await start();await s.act(user,set,deck,b.id,body(b,'easy'));
 expect((await s.act(user,set,deck,a.id,input)).outcome).toEqual(original.outcome);expect((await s.queue(user,set,deck)).metrics.totalReviews).toBe(2);
});
it('rejects foreign deck/session pairs and skipped requests are also idempotent',async()=>{
 const c=await card(),a=await start(),second=(await f.create(user,set,{clientRequestId:id(),title:'另一组'})).deck;
 await expect(s.get(user,set,second.id,a.id)).rejects.toMatchObject({code:'not_found'});await expect(s.act(other,set,deck,a.id,body(a))).rejects.toMatchObject({code:'not_found'});
 await f.editCard(user,set,deck,c.id,{version:1,front:'新',back:'答'});const input={...body(a),action:'skip_stale',rating:undefined};const r=await s.act(user,set,deck,a.id,input);expect(await s.act(user,set,deck,a.id,input)).toMatchObject({replayed:true,outcome:r.outcome});expect((await s.queue(user,set,deck)).metrics.totalReviews).toBe(0);
});
it('keeps source v1 and its original citation after the live material changes to v2',async()=>{
 const {createTextMaterial,updateTextMaterial}=await import('../src/services/study-data.js');
 const {GenerationStore}=await import('../src/generation/store.js');
 const {DEFAULT_GENERATION_POLICY,UNKNOWN_USAGE}=await import('../src/generation/types.js');
 const text='太阳辐射为水的蒸发提供能量，水蒸气冷却凝结形成云中的小水滴。';
 const material=(await createTextMaterial(db,user,set,{clientRequestId:id(),title:'来源资料',body:text})).material;
 const store=new GenerationStore(db,{...DEFAULT_GENERATION_POLICY,globalDailyRequests:1000},{provider:'openrouter',baseUrl:'https://openrouter.ai/api/v1',model:'fixture/model',outputMode:'compact',maxOutputTokens:512,timeoutMs:1000,providerOnly:[]});
 const {job}=await store.create(user,set,{clientRequestId:id(),kind:'flashcards',sources:[{materialId:material.id,version:1}],config:{language:'zh-CN',cardCount:1}});
 const claim=await store.claim();await store.settle(claim!,{status:'succeeded',errorCode:null,usage:UNKNOWN_USAGE,result:{schemaVersion:1,title:'有来源卡组',cards:[{front:'能量来自哪里？',back:'太阳辐射',citations:[{sourceId:'s1',materialId:material.id,version:1,quote:text,start:0,end:text.length,page:null}]}]}});
 const generated=(await f.materialize(user,set,{clientRequestId:id(),jobId:job.id})).deck;
 const session=(await s.start(user,set,generated.id,{clientRequestId:id()})).session;
 await updateTextMaterial(db,user,set,material.id,{version:1,body:'这是后来的资料版本，不能改写旧复习引用。'});
 const resumed=await s.get(user,set,generated.id,session.id);expect(resumed.sourceSnapshots[0]).toMatchObject({version:1,body:text});expect(resumed.cards[0].citations[0]).toMatchObject({version:1,quote:text});expect(resumed.current.staleReason).toBeNull();
});
