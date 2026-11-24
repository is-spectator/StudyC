import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { GenerationStore } from '../generation/store.js';
import type { SharedRateLimiter } from '../runtime/rate-limit.js';
import { FlashcardService } from '../services/flashcards.js';
import type { StudyEnv } from './auth.js';
import { StudyInputError } from '../services/study-data.js';
import { readJson } from './study.js';
const uuid=z.uuid().transform(v=>v.toLowerCase());
export function registerFlashcardRoutes(app:Hono<StudyEnv>,db:Db,_generationStore:GenerationStore|undefined,limits:SharedRateLimiter):void {
 const service=new FlashcardService(db),root='/v1/study/sets/:setId/flashcard-decks';
 const ids=(c:Context<StudyEnv>)=>[c.get('userId'),uuid.parse(c.req.param('setId'))] as const;
 const deck=(c:Context<StudyEnv>)=>uuid.parse(c.req.param('deckId'));
 const input=async(c:Context<StudyEnv>)=>{await limits.consume('write',c.get('userId'),120);return readJson(c,32*1024);};
 app.get(root,async c=>{const query=z.object({cursor:uuid.optional()}).strict().parse(c.req.query());if(Object.values(c.req.queries()).some(v=>v.length!==1))throw new StudyInputError('分页参数无效。');return c.json(await service.list(...ids(c),query.cursor));});
 app.post(root,async c=>{const result=await service.create(...ids(c),await input(c));return c.json(result,result.replayed?200:201);});
 app.post(`${root}/materialize`,async c=>{const result=await service.materialize(...ids(c),await input(c));return c.json(result,result.replayed?200:201);});
 app.get(`${root}/:deckId`,async c=>c.json(await service.get(...ids(c),deck(c))));
 app.patch(`${root}/:deckId`,async c=>c.json({deck:await service.rename(...ids(c),deck(c),await input(c))}));
 app.post(`${root}/:deckId/cards`,async c=>{const result=await service.addCard(...ids(c),deck(c),await input(c));return c.json(result,result.replayed?200:201);});
 app.patch(`${root}/:deckId/cards/:cardId`,async c=>c.json({card:await service.editCard(...ids(c),deck(c),uuid.parse(c.req.param('cardId')),await input(c))}));
 app.post(`${root}/:deckId/sessions`,async c=>{const result=await service.start(...ids(c),deck(c),await input(c));return c.json(result,result.replayed?200:201);});
 app.get(`${root}/:deckId/sessions/:sessionId`,async c=>c.json({session:await service.getSession(...ids(c),deck(c),uuid.parse(c.req.param('sessionId')))}));
 app.post(`${root}/:deckId/sessions/:sessionId/reviews`,async c=>{const result=await service.review(...ids(c),deck(c),uuid.parse(c.req.param('sessionId')),await input(c));return c.json(result,result.replayed?200:201);});
}
