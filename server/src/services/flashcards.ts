import {requireVisibleSet} from './set-visibility.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, Queryable } from '../db/db.js';
import type { GenerationCitation, SourceSnapshot } from '../generation/types.js';
import { requireActiveUser } from './identity.js';
import { DomainError } from './errors.js';
import { StudyError } from './study-data.js';
const uuid = z.uuid().transform(v => v.toLowerCase());
const version = z.number().int().min(1).max(2147483646);
const text = (max: number) => z.string().refine(v => !/[\u0000\uD800-\uDFFF]/u.test(v)).refine(v => v.trim().length > 0 && Buffer.byteLength(v, 'utf8') <= max);
const title = z.string().trim().min(1).refine(v => Array.from(v).length <= 160 && !/[\u0000\uD800-\uDFFF]/u.test(v));
export const deckInput = z.object({clientRequestId:uuid,title}).strict();
export const deckUpdate = z.object({version,title}).strict();
export const cardInput = z.object({clientRequestId:uuid,front:text(2000),back:text(8000)}).strict();
export const cardUpdate = z.object({version,front:text(2000),back:text(8000)}).strict();
export const materializeInput = z.object({clientRequestId:uuid,jobId:uuid}).strict();
export const sessionInput = z.object({clientRequestId:uuid}).strict();
export const reviewInput = z.object({clientRequestId:uuid,version,cardId:uuid,position:z.number().int().min(0).max(199),rating:z.enum(['again','hard','good','easy'])}).strict();
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const missing = () => new DomainError('not_found','没有找到这份闪卡。');
const conflict = () => new DomainError('version_conflict','内容或学习进度已在另一处更新，请读取最新版本。');
const mismatch = () => new StudyError('idempotency_conflict','这次请求已使用过不同内容，请先确认上次保存结果。');
type Row = Record<string, any>;
export interface Flashcard {id:string;front:string;back:string;version:number;citations:GenerationCitation[];position:number}
export interface FlashcardSession {id:string;deckId:string;status:'in_progress'|'completed';version:number;nextIndex:number;cards:Flashcard[];updatedAt:string}
const card = (r:Row):Flashcard => ({id:r.id,front:r.front,back:r.back,version:r.version,citations:r.citations,position:r.position});
const session = (r:Row):FlashcardSession => ({id:r.id,deckId:r.deck_id,status:r.status,version:r.version,nextIndex:r.next_index,cards:r.card_snapshots,updatedAt:r.updated_at.toISOString()});
const deck = (r:Row) => ({id:r.id,studySetId:r.study_set_id,title:r.title,version:r.version,generationJobId:r.generation_job_id,sourceSnapshots:r.source_snapshots,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()});
async function ownedSet(q:Queryable,user:string,set:string) { return requireVisibleSet(q,user,set); }
async function ownedDeck(q:Queryable,user:string,set:string,id:string,lock=false):Promise<Row> {
  const [row]=await q.query<Row>(`SELECT * FROM study_flashcard_decks WHERE user_id=$1 AND study_set_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,[user,set,id]);
  if(!row)throw missing(); return row;
}
async function ownedSession(q:Queryable,user:string,set:string,deckId:string,id:string,lock=false):Promise<Row> {
  const [row]=await q.query<Row>(`SELECT * FROM study_flashcard_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND id=$4${lock?' FOR UPDATE':''}`,[user,set,deckId,id]);
  if(!row)throw missing(); return row;
}
function replay(row:Row,set:string,hash:string,deckId?:string) {
  if(row.study_set_id!==set || row.creation_digest!==hash || (deckId!==undefined&&row.deck_id!==deckId))throw mismatch();
}
export class FlashcardService {
 constructor(private readonly db:Db){}
 async list(user:string,set:string,cursor?:string) {
  if(cursor)uuid.parse(cursor);
  return this.db.tx(async q=>{await ownedSet(q,user,set);const rows=await q.query<Row>(`SELECT d.*, (SELECT count(*)::int FROM study_flashcards c WHERE c.user_id=d.user_id AND c.study_set_id=d.study_set_id AND c.deck_id=d.id) AS card_count, (SELECT count(*)::int FROM study_flashcards c LEFT JOIN study_flashcard_schedules s ON s.card_id=c.id AND s.user_id=c.user_id WHERE c.deck_id=d.id AND c.user_id=d.user_id AND (s.card_id IS NULL OR s.card_version<>c.version)) AS new_count, (SELECT count(*)::int FROM study_flashcards c JOIN study_flashcard_schedules s ON s.card_id=c.id AND s.user_id=c.user_id WHERE c.deck_id=d.id AND c.user_id=d.user_id AND s.card_version=c.version AND s.due_at<=clock_timestamp()) AS due_count FROM study_flashcard_decks d WHERE d.user_id=$1 AND d.study_set_id=$2 ${cursor?'AND d.id<$3':''} ORDER BY d.id DESC LIMIT 51`,cursor?[user,set,cursor]:[user,set]);
  return {items:rows.slice(0,50).map(r=>({...deck(r),sourceSnapshots:[],cardCount:r.card_count,reviewSummary:{newCount:r.new_count,dueCount:r.due_count}})),nextCursor:rows.length>50?rows[49]!.id:null};});
 }
 /** Saved output references are independent of deck-list pagination. */
 async savedGenerationDecks(user:string,set:string,jobIds:readonly string[]):Promise<Record<string,string>> {
  if(jobIds.length>100)throw new DomainError('invalid_input','生成记录数量过多。');
  const ids=jobIds.map(id=>uuid.parse(id));
  return this.db.tx(async q=>{
   await ownedSet(q,user,set);
   if(!ids.length)return {};
   const rows=await q.query<{job_id:string;deck_id:string}>(`SELECT j.id AS job_id,d.id AS deck_id FROM study_flashcard_decks d
    JOIN study_generation_jobs j ON j.id=d.generation_job_id AND j.user_id=d.user_id AND j.study_set_id=d.study_set_id
    WHERE d.user_id=$1 AND d.study_set_id=$2 AND j.id=ANY($3::uuid[]) AND j.kind='flashcards' AND j.status='succeeded'`,[user,set,ids]);
   return Object.fromEntries(rows.map(r=>[r.job_id,r.deck_id]));
  });
 }
 async get(user:string,set:string,id:string) {
  return this.db.tx(async q=>{await ownedSet(q,user,set);const d=await ownedDeck(q,user,set,id);
   const cards=await q.query<Row>('SELECT * FROM study_flashcards WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 ORDER BY position',[user,set,id]);
   const [last]=await q.query<Row>("SELECT * FROM study_flashcard_sessions WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 ORDER BY (status='in_progress') DESC,created_at DESC,id DESC LIMIT 1",[user,set,id]);
   const ratings=await q.query<Row>('SELECT rating,count(*)::int AS count FROM study_flashcard_reviews WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 GROUP BY rating',[user,set,id]);
   const [latest]=await q.query<Row>('SELECT created_at,rating FROM study_flashcard_reviews WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',[user,set,id]);
   return {deck:deck(d),cards:cards.map(card),lastSession:last?session(last):null,metrics:{kind:'self_rated' as const,totalReviews:ratings.reduce((sum,r)=>sum+r.count,0),ratings:Object.fromEntries(['again','hard','good','easy'].map(k=>[k,ratings.find(r=>r.rating===k)?.count??0])),lastReviewedAt:latest?.created_at.toISOString()??null,lastRating:latest?.rating??null}};
  });
 }
 async create(user:string,set:string,raw:unknown) {
  const input=deckInput.parse(raw),hash=digest([set,input.title]);
  return this.db.tx(async q=>{await ownedSet(q,user,set);const [old]=await q.query<Row>('SELECT * FROM study_flashcard_decks WHERE user_id=$1 AND client_request_id=$2',[user,input.clientRequestId]);
   if(old){replay(old,set,hash);return {deck:deck(old),replayed:true};}
   const [row]=await q.query<Row>('INSERT INTO study_flashcard_decks(user_id,study_set_id,title,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5) RETURNING *',[user,set,input.title,input.clientRequestId,hash]);return {deck:deck(row!),replayed:false};
  },user);
 }
 async rename(user:string,set:string,id:string,raw:unknown) {
  const input=deckUpdate.parse(raw);return this.db.tx(async q=>{await ownedSet(q,user,set);const current=await ownedDeck(q,user,set,id,true);if(current.version!==input.version)throw conflict();
   const [row]=await q.query<Row>('UPDATE study_flashcard_decks SET title=$4,version=version+1,updated_at=now() WHERE user_id=$1 AND study_set_id=$2 AND id=$3 RETURNING *',[user,set,id,input.title]);return deck(row!);},user);
 }
 async addCard(user:string,set:string,id:string,raw:unknown) {
  const input=cardInput.parse(raw),hash=digest([set,id,input.front,input.back]);
  return this.db.tx(async q=>{await ownedSet(q,user,set);await ownedDeck(q,user,set,id,true);const [old]=await q.query<Row>('SELECT * FROM study_flashcards WHERE user_id=$1 AND client_request_id=$2',[user,input.clientRequestId]);
   if(old){replay(old,set,hash,id);return {card:card(old),replayed:true};}
   const [count]=await q.query<{count:number}>('SELECT count(*)::int AS count FROM study_flashcards WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3',[user,set,id]);if(count!.count>=200)throw new DomainError('invalid_input','每套闪卡最多200张，请新建一套。');
   const [row]=await q.query<Row>('INSERT INTO study_flashcards(user_id,study_set_id,deck_id,position,front,back,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[user,set,id,count!.count,input.front,input.back,input.clientRequestId,hash]);return {card:card(row!),replayed:false};},user);
 }
 async editCard(user:string,set:string,id:string,cardId:string,raw:unknown) {
  const input=cardUpdate.parse(raw);return this.db.tx(async q=>{await ownedSet(q,user,set);await ownedDeck(q,user,set,id,true);const [old]=await q.query<Row>('SELECT * FROM study_flashcards WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND id=$4 FOR UPDATE',[user,set,id,cardId]);if(!old)throw missing();if(old.version!==input.version)throw conflict();
   const [row]=await q.query<Row>('UPDATE study_flashcards SET front=$5,back=$6,version=version+1,updated_at=now() WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND id=$4 RETURNING *',[user,set,id,cardId,input.front,input.back]);return card(row!);},user);
 }
 async materialize(user:string,set:string,raw:unknown) {
  const input=materializeInput.parse(raw),hash=digest([set,'generation',input.jobId]);
  return this.db.tx(async q=>{await ownedSet(q,user,set);
   const [intent]=await q.query<Row>('SELECT * FROM study_flashcard_materializations WHERE user_id=$1 AND client_request_id=$2',[user,input.clientRequestId]);if(intent){replay(intent,set,hash);return {deck:deck(await ownedDeck(q,user,set,intent.deck_id)),replayed:true};}
   const recordIntent=async(deckId:string)=>{await q.query('INSERT INTO study_flashcard_materializations(user_id,study_set_id,deck_id,generation_job_id,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6)',[user,set,deckId,input.jobId,input.clientRequestId,hash]);};
   const [job]=await q.query<Row>('SELECT * FROM study_generation_jobs WHERE user_id=$1 AND study_set_id=$2 AND id=$3 FOR SHARE',[user,set,input.jobId]);if(!job)throw missing();
   if(job.kind!=='flashcards'||job.status!=='succeeded'||!job.result)throw new DomainError('invalid_input','只有成功完成的闪卡生成任务可以保存为卡组。');
   const [existing]=await q.query<Row>('SELECT * FROM study_flashcard_decks WHERE user_id=$1 AND study_set_id=$2 AND generation_job_id=$3',[user,set,input.jobId]);if(existing){await recordIntent(existing.id);return {deck:deck(existing),replayed:true};}
   const result=job.result as {schemaVersion:number;title:string;cards:{front:string;back:string;citations:GenerationCitation[]}[]};
   const sources=job.input_snapshot.sources as SourceSnapshot[];
   if(result.schemaVersion!==1||!Array.isArray(result.cards)||result.cards.length!==job.input_snapshot.config.cardCount||result.cards.length<1||result.cards.length>20||!Array.isArray(sources))throw new DomainError('invalid_input','生成结果不完整，未创建卡组。');
   for(const source of sources){if(typeof source.body!=='string'||source.bodySha256!==createHash('sha256').update(source.body,'utf8').digest('hex')||!Array.isArray(source.pages))throw new DomainError('invalid_input','生成资料快照校验未通过。');}
   for(const c of result.cards){cardUpdate.parse({version:1,front:c.front,back:c.back});if(!Array.isArray(c.citations)||!c.citations.length||c.citations.length>3)throw new DomainError('invalid_input','生成结果缺少可验证的引用。');
    for(const cite of c.citations){const s=sources.find(s=>s.sourceId===cite.sourceId);if(!s||s.materialId!==cite.materialId||s.version!==cite.version||!Number.isInteger(cite.start)||!Number.isInteger(cite.end)||cite.start<0||cite.end<=cite.start||cite.end>s.body.length||s.body.slice(cite.start,cite.end)!==cite.quote||s.body.indexOf(cite.quote)!==cite.start||s.body.indexOf(cite.quote,cite.start+1)!==-1||Array.from(cite.quote.replace(/\s/gu,'')).length<12||cite.page!==(s.pages.find(p=>p.start<=cite.start&&p.end>=cite.end)?.page??null))throw new DomainError('invalid_input','生成结果引用校验未通过。');}
   }
   const [created]=await q.query<Row>('INSERT INTO study_flashcard_decks(user_id,study_set_id,title,client_request_id,creation_digest,generation_job_id,source_snapshots) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',[user,set,title.parse(result.title),input.clientRequestId,hash,input.jobId,JSON.stringify(sources)]);
   for(const [position,c]of result.cards.entries())await q.query('INSERT INTO study_flashcards(user_id,study_set_id,deck_id,position,front,back,citations,client_request_id,creation_digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',[user,set,created!.id,position,c.front,c.back,JSON.stringify(c.citations),randomUUID(),digest([input.jobId,position])]);
   await recordIntent(created!.id);return {deck:deck(created!),replayed:false};},user);
 }
 async start(user:string,set:string,id:string,raw:unknown) {
  const input=sessionInput.parse(raw),hash=digest([set,id]);return this.db.tx(async q=>{await ownedSet(q,user,set);await ownedDeck(q,user,set,id,true);
   const [old]=await q.query<Row>('SELECT * FROM study_flashcard_sessions WHERE user_id=$1 AND client_request_id=$2',[user,input.clientRequestId]);if(old){replay(old,set,hash,id);return {session:session(old),replayed:true};}
   const cards=await q.query<Row>('SELECT * FROM study_flashcards WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 ORDER BY position',[user,set,id]);if(!cards.length)throw new DomainError('invalid_input','先添加至少一张闪卡，再开始学习。');
   const [row]=await q.query<Row>('INSERT INTO study_flashcard_sessions(user_id,study_set_id,deck_id,client_request_id,creation_digest,card_snapshots) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',[user,set,id,input.clientRequestId,hash,JSON.stringify(cards.map(card))]);return {session:session(row!),replayed:false};},user);
 }
 async getSession(user:string,set:string,id:string,sessionId:string){return this.db.tx(async q=>{await ownedSet(q,user,set);await ownedDeck(q,user,set,id);return session(await ownedSession(q,user,set,id,sessionId));});}
 async review(user:string,set:string,id:string,sessionId:string,raw:unknown) {
  const input=reviewInput.parse(raw),hash=digest([set,id,sessionId,input.version,input.cardId,input.position,input.rating]);
  return this.db.tx(async q=>{await ownedSet(q,user,set);await ownedDeck(q,user,set,id);const current=await ownedSession(q,user,set,id,sessionId,true);
   const [old]=await q.query<Row>('SELECT * FROM study_flashcard_reviews WHERE user_id=$1 AND client_request_id=$2',[user,input.clientRequestId]);if(old){replay(old,set,hash,id);return {session:session(current),replayed:true};}
   const cards=current.card_snapshots as Flashcard[], target=cards[current.next_index];
   if(current.status!=='in_progress'||current.version!==input.version||current.next_index!==input.position||!target||target.id!==input.cardId)throw conflict();
   await q.query(`INSERT INTO study_flashcard_reviews(user_id,study_set_id,deck_id,session_id,card_id,card_version,position,rating,client_request_id,creation_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,GREATEST(clock_timestamp(),COALESCE((SELECT max(created_at)+interval '1 microsecond' FROM study_flashcard_reviews WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3),clock_timestamp())))`,[user,set,id,sessionId,target.id,target.version,input.position,input.rating,input.clientRequestId,hash]);
   const [row]=await q.query<Row>("UPDATE study_flashcard_sessions SET next_index=next_index+1,version=version+1,status=CASE WHEN next_index+1=jsonb_array_length(card_snapshots) THEN 'completed' ELSE 'in_progress' END,updated_at=now() WHERE user_id=$1 AND study_set_id=$2 AND deck_id=$3 AND id=$4 RETURNING *",[user,set,id,sessionId]);return {session:session(row!),replayed:false};},user);
 }
}
