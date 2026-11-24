import { AuthApiError, throwIfAborted, type RequestOptions } from '../../auth/api';
export type Citation={sourceId:string;materialId:string;version:number;quote:string;start:number;end:number;page:number|null};
export type Source={sourceId:string;materialId:string;version:number;title:string;body:string;pageProvenance:string};
export type Card={id:string;front:string;back:string;version:number;position:number;citations:Citation[]};
export type Deck={id:string;studySetId:string;title:string;version:number;generationJobId:string|null;sourceSnapshots:Source[];cardCount?:number;reviewSummary?:{newCount:number;dueCount:number}};
export type Session={id:string;deckId:string;status:'in_progress'|'completed';version:number;nextIndex:number;cards:Card[];updatedAt:string};
export type Detail={deck:Deck;cards:Card[];lastSession:Session|null;metrics:{kind:'self_rated';totalReviews:number;ratings:Record<string,number>;lastReviewedAt:string|null;lastRating:string|null}};
export type Job={id:string;kind:string;status:string;errorCode:string|null;result:{title:string;cards?:{front:string;back:string;citations:Citation[]}[]}|null};
export type Request=<T>(path:string,options?:RequestOptions)=>Promise<T>;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const bad=()=>new AuthApiError('invalid_response','闪卡服务返回了无法读取的资料，请重试。',502);
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validCard=(v:unknown):v is Card=>object(v)&&uuid.test(v.id)&&typeof v.front==='string'&&typeof v.back==='string'&&Number.isInteger(v.version)&&v.version>0&&Array.isArray(v.citations)&&v.citations.every((c:unknown)=>object(c)&&typeof c.sourceId==='string'&&uuid.test(c.materialId)&&Number.isInteger(c.version)&&typeof c.quote==='string'&&Number.isInteger(c.start)&&Number.isInteger(c.end)&&(c.page===null||Number.isInteger(c.page)));
export function createFlashcardsApi(request:Request,setId:string){
 if(!uuid.test(setId))throw bad();
 const root=`/v1/study/sets/${setId}/flashcard-decks`,generations=`/v1/study/sets/${setId}/generations`;
 const send=async(path:string,options:RequestOptions={})=>{throwIfAborted(options.signal);const result=await request<unknown>(path,options);throwIfAborted(options.signal);return result;};
 const deck=(v:unknown):Deck=>{if(!object(v)||!uuid.test(v.id)||v.studySetId!==setId||typeof v.title!=='string'||!Number.isInteger(v.version)||v.version<1||!Array.isArray(v.sourceSnapshots))throw bad();return v as Deck;};
 const session=(v:unknown):Session=>{if(!object(v)||!uuid.test(v.id)||!uuid.test(v.deckId)||!['in_progress','completed'].includes(v.status)||!Number.isInteger(v.version)||!Array.isArray(v.cards)||!v.cards.every(validCard)||!Number.isInteger(v.nextIndex)||v.nextIndex<0||v.nextIndex>v.cards.length)throw bad();return v as Session;};
 const field=(v:unknown,key:string)=>{if(!object(v)||!(key in v))throw bad();return v[key];};
 const job=(v:unknown):Job=>{if(!object(v)||!uuid.test(v.id)||v.studySetId!==setId||v.kind!=='flashcards'||!['queued','running','succeeded','failed','cancelled','interrupted'].includes(v.status))throw bad();return v as Job;};
 const target=(id:string)=>{if(!uuid.test(id))throw bad();return `${root}/${id}`;};
 return {
  async list(cursor?:string,signal?:AbortSignal){const v=await send(root+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''),{signal});if(!object(v)||!Array.isArray(v.items)||(v.nextCursor!==null&&!uuid.test(v.nextCursor)))throw bad();return {items:v.items.map(deck),nextCursor:v.nextCursor as string|null};},
  async get(id:string,signal?:AbortSignal):Promise<Detail>{const v=await send(target(id),{signal});if(!object(v)||!Array.isArray(v.cards)||!v.cards.every(validCard)||!object(v.metrics)||v.metrics.kind!=='self_rated')throw bad();return {deck:deck(v.deck),cards:v.cards,lastSession:v.lastSession===null?null:session(v.lastSession),metrics:v.metrics as Detail['metrics']};},
  async create(body:{clientRequestId:string;title:string},signal?:AbortSignal){return deck(field(await send(root,{method:'POST',body,signal}),'deck'));},
  async rename(id:string,body:{version:number;title:string},signal?:AbortSignal){return deck(field(await send(target(id),{method:'PATCH',body,signal}),'deck'));},
  async saveCard(id:string,cardId:string|null,body:Record<string,unknown>,signal?:AbortSignal){const v=field(await send(target(id)+'/cards'+(cardId?'/'+cardId:''),{method:cardId?'PATCH':'POST',body,signal}),'card');if(!validCard(v))throw bad();return v;},
  async start(id:string,body:{clientRequestId:string},signal?:AbortSignal){return session(field(await send(target(id)+'/sessions',{method:'POST',body,signal}),'session'));},
  async getSession(id:string,sessionId:string,signal?:AbortSignal){if(!uuid.test(sessionId))throw bad();const result=session(field(await send(target(id)+'/sessions/'+sessionId,{signal}),'session'));if(result.deckId!==id)throw bad();return result;},
  async review(id:string,sessionId:string,body:Record<string,unknown>,signal?:AbortSignal){return session(field(await send(target(id)+'/sessions/'+sessionId+'/reviews',{method:'POST',body,signal}),'session'));},
  async jobs(signal?:AbortSignal):Promise<Job[]>{const v=await send(generations+'?limit=100',{signal});if(!object(v)||!Array.isArray(v.items))throw bad();return v.items.filter((j:unknown)=>object(j)&&j.kind==='flashcards').map(job);},
  async generate(body:Record<string,unknown>,signal?:AbortSignal){return job(field(await send(generations,{method:'POST',body,signal}),'job'));},
  async cancel(id:string,signal?:AbortSignal){return job(field(await send(generations+'/'+id+'/cancel',{method:'POST',body:{},signal}),'job'));},
  async materialize(body:{clientRequestId:string;jobId:string},signal?:AbortSignal){return deck(field(await send(root+'/materialize',{method:'POST',body,signal}),'deck'));},
 };
}
export type FlashcardsApi=ReturnType<typeof createFlashcardsApi>;
