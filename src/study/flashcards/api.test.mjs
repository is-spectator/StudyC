import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlashcardsApi} from './api.ts';
const set='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',deckId='33333333-3333-4333-8333-333333333333';
const sample={id:jobId,studySetId:set,kind:'flashcards',status:'succeeded',savedDeckId:deckId,errorCode:null,result:{title:'保存的卡组',cards:[]}};
test('generation records use an authoritative saved output independently from loaded deck pages',async()=>{
 const seen=[],api=createFlashcardsApi(async path=>{seen.push(path);return {items:[sample],nextCursor:null};},set);
 assert.deepEqual(await api.jobs(),[sample]);assert.deepEqual(seen,[`/v1/study/sets/${set}/flashcard-decks?view=generations`]);
});
test('generation records reject missing, invalid or impossible saved output references',async()=>{
 const {savedDeckId,...missing}=sample;
 for(const record of [missing,{...sample,savedDeckId:'external-link'},{...sample,status:'running'},{...sample,studySetId:deckId},{...sample,kind:'quiz'}]){
  const api=createFlashcardsApi(async()=>({items:[record],nextCursor:null}),set);
  await assert.rejects(api.jobs(),{code:'invalid_response'});
 }
 const api=createFlashcardsApi(async()=>({items:[{...sample,savedDeckId:null}],nextCursor:null}),set);
 assert.equal((await api.jobs())[0].savedDeckId,null);
});
