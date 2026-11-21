import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setStorageAccount, captureStorageSession, appStorage } from '../lib/account-storage.ts';
import { acknowledgesAttempt, createDraftStore } from './drafts.ts';
const data = new Map();
const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
  removeItem: key => data.delete(key), get length() { return data.size; }, key: index => [...data.keys()][index] ?? null };
globalThis.localStorage = storage;
const alice='11111111-1111-4111-8111-111111111111',bob='22222222-2222-4222-8222-222222222222';
const set='33333333-3333-4333-8333-333333333333',otherSet='44444444-4444-4444-8444-444444444444',note='55555555-5555-4555-8555-555555555555';
const draft = () => ({ format:1,studySetId:set,materialId:note,title:'我的笔记',body:'尚未同步\n😀',baseVersion:3,requestId:'66666666-6666-4666-8666-666666666666',updatedAt:Date.now() });
const writerA = '77777777-7777-4777-8777-777777777777';
const writerB = '88888888-8888-4888-8888-888888888888';
const logical = (material = note) => `sf-k12:cloud-draft:${set}:${material}`;
const physical = (writer, account = alice, material = note) => `clyna-study:account:${account}:${logical(material)}${writer ? ':' + writer : ''}`;
beforeEach(() => { data.clear(); globalThis.localStorage = storage; setStorageAccount(null); setStorageAccount(alice); });

test('drafts stay bound to account, set and material and are never silently uploaded', () => {
  const store = createDraftStore();
  const valid = captureStorageSession(), d = draft();
  assert.equal(store.writeDraft(d), true);
  assert.deepEqual(store.readDraft(set, note).draft, d);
  assert.equal(store.readDraft(otherSet, note).draft, null);
  setStorageAccount(bob);
  assert.equal(valid(), false);
  assert.equal(createDraftStore().readDraft(set, note).draft, null);
  setStorageAccount(alice);
  assert.equal(createDraftStore().readDraft(set, note).draft.body, d.body);
  setStorageAccount(null);
  assert.equal(store.writeDraft(d), false);
  assert.equal(store.readDraft(set, note).draft, null);
});

test('two writers never overwrite each other and a successful save cannot delete an independent tab draft', () => {
  const a = createDraftStore(writerA), b = createDraftStore(writerB);
  a.readDraft(set, note); b.readDraft(set, note);
  const da = { ...draft(), body: 'A 未同步', updatedAt: 1 }, db = { ...draft(), body: 'B 未同步', updatedAt: 2 };
  assert.equal(a.writeDraft(da), true);
  assert.equal(b.writeDraft(db), true);
  assert.deepEqual(a.readDraft(set, note).draft, da, 'own draft wins even when another tab is newer');
  assert.deepEqual(b.readDraft(set, note).draft, db);
  assert.equal(a.clearDraft(set, note), true);
  assert.equal(data.has(physical(writerA)), false);
  assert.equal(JSON.parse(data.get(physical(writerB))).body, db.body);
  assert.deepEqual(createDraftStore().readDraft(set, note).draft, db);
});

test('recovery selects the newest other writer and retains its original until acknowledgement', () => {
  const a = createDraftStore(writerA), b = createDraftStore(writerB);
  a.readDraft(set, note); b.readDraft(set, note);
  a.writeDraft({ ...draft(), body: 'older', updatedAt: 1 });
  b.writeDraft({ ...draft(), body: 'newer', updatedAt: 2 });
  const recovered = createDraftStore();
  assert.equal(recovered.readDraft(set, note).draft.body, 'newer');
  recovered.writeDraft({ ...draft(), body: 'newest local edit', updatedAt: 3 });
  assert.equal(JSON.parse(data.get(physical(writerB))).body, 'newer');
  assert.equal(recovered.clearDraft(set, note), true);
  assert.equal(data.has(physical(writerB)), false);
  assert.equal(data.has(physical(writerA)), true, 'independent older drafts are not ours to delete');
});

test('changed recovery sources survive exact comparison instead of being deleted by the recovering tab', () => {
  const a = createDraftStore(writerA), b = createDraftStore(writerB);
  a.writeDraft({ ...draft(), body: 'source', updatedAt: 1 });
  assert.equal(b.readDraft(set, note).draft.body, 'source');
  b.writeDraft({ ...draft(), body: 'B edit', updatedAt: 2 });
  a.writeDraft({ ...draft(), body: 'A later edit', updatedAt: 3 });
  assert.equal(b.clearDraft(set, note), false);
  assert.equal(JSON.parse(data.get(physical(writerA))).body, 'A later edit');
  assert.equal(data.has(physical(writerB)), false);
  assert.equal(b.writeDraft({ ...draft(), body: 'B continues editing', updatedAt: 4 }), true);
  assert.equal(JSON.parse(data.get(physical(writerB))).body, 'B continues editing');
  assert.equal(JSON.parse(data.get(physical(writerA))).body, 'A later edit');
});

test('an original active writer can continue after a recovering editor acknowledged its unchanged snapshot', () => {
  const a = createDraftStore(writerA), b = createDraftStore(writerB);
  a.writeDraft({ ...draft(), body: 'original', updatedAt: 1 });
  b.readDraft(set, note);
  b.writeDraft({ ...draft(), body: 'recovered and saved', updatedAt: 2 });
  assert.equal(b.clearDraft(set, note), true);
  assert.equal(data.has(physical(writerA)), false);
  assert.equal(a.writeDraft({ ...draft(), body: 'new edit in original tab', updatedAt: 3 }), true);
  assert.equal(JSON.parse(data.get(physical(writerA))).body, 'new edit in original tab');
});

test('multi-reload recovery carries bounded lineage and does not resurrect acknowledged ancestors', () => {
  const a = createDraftStore(writerA);
  a.writeDraft({ ...draft(), updatedAt: 1 });
  const b = createDraftStore(writerB);
  const fromA = b.readDraft(set, note).draft;
  b.writeDraft({ ...fromA, body: 'B update', updatedAt: 2 });
  const c = createDraftStore();
  const fromB = c.readDraft(set, note).draft;
  assert.equal(fromB.body, 'B update');
  c.writeDraft({ ...fromB, body: 'C update', updatedAt: 3 });
  assert.equal(c.clearDraft(set, note), true);
  assert.equal(data.size, 0);
  assert.equal(createDraftStore().readDraft(set, note).draft, null);
});

test('a persisted pending save wins over its unchanged text timestamp after another reload', () => {
  const a = createDraftStore(writerA), original = { ...draft(), updatedAt: 1 };
  a.writeDraft(original);
  const b = createDraftStore(writerB);
  b.readDraft(set, note);
  const pending = { version: original.baseVersion, title: original.title, body: original.body };
  b.writeDraft({ ...original, pending });
  const restored = createDraftStore().readDraft(set, note).draft;
  assert.deepEqual(restored.pending, pending);
  assert.equal(restored.updatedAt, original.updatedAt);
});

test('an ancestor edited after recovery is preserved across a further page reload', () => {
  const a = createDraftStore(writerA);
  a.writeDraft({ ...draft(), body: 'A initial', updatedAt: 1 });
  const b = createDraftStore(writerB);
  b.readDraft(set, note);
  b.writeDraft({ ...draft(), body: 'B draft', updatedAt: 2 });
  const c = createDraftStore();
  c.readDraft(set, note);
  c.writeDraft({ ...draft(), body: 'C draft', updatedAt: 3 });
  a.writeDraft({ ...draft(), body: 'A changed', updatedAt: 4 });
  assert.equal(c.clearDraft(set, note), false);
  assert.equal(JSON.parse(data.get(physical(writerA))).body, 'A changed');
});

test('late cleanup and writes cannot cross an automatic account switch or a new session for the same account', () => {
  const old = createDraftStore(writerA);
  old.writeDraft(draft());
  const aliceRaw = data.get(physical(writerA));
  setStorageAccount(bob);
  const current = createDraftStore(writerB);
  current.writeDraft({ ...draft(), body: 'Bob draft' });
  const bobRaw = data.get(physical(writerB, bob));
  assert.equal(old.clearDraft(set, note), false);
  assert.equal(old.writeDraft({ ...draft(), body: 'late Alice write' }), false);
  assert.equal(data.get(physical(writerA)), aliceRaw);
  assert.equal(data.get(physical(writerB, bob)), bobRaw);
  setStorageAccount(alice);
  assert.equal(old.clearDraft(set, note), false, 'returning account does not revive an old callback');
  assert.equal(createDraftStore().readDraft(set, note).draft.body, draft().body);
});

test('malformed legacy records stay exportable and block replacement until explicit unchanged discard', () => {
  data.set(physical(), 'not json');
  const store = createDraftStore(writerA);
  assert.match(store.readDraft(set, note).warning, /原记录仍保留/);
  assert.equal(store.writeDraft(draft()), false);
  assert.equal(data.get(physical()), 'not json');
  assert.ok(appStorage.keys().includes(logical()));
  assert.equal(store.clearDraft(set, note), true);
  assert.equal(store.writeDraft(draft()), true);
});

test('changed corrupt records and modified own snapshots are never overwritten or silently discarded', () => {
  data.set(physical(), 'broken-1');
  const blockedStore = createDraftStore(writerA);
  blockedStore.readDraft(set, note);
  data.set(physical(), 'broken-2');
  assert.equal(blockedStore.clearDraft(set, note), false);
  assert.equal(blockedStore.writeDraft(draft()), false);
  assert.equal(data.get(physical()), 'broken-2');
  data.clear();
  const owner = createDraftStore(writerB);
  owner.writeDraft(draft());
  data.set(physical(writerB), 'externally changed');
  assert.equal(owner.writeDraft(draft()), false);
  assert.equal(owner.clearDraft(set, note), false);
  assert.equal(data.get(physical(writerB)), 'externally changed');
});

test('corrupt retry identity or out-of-scope cleanup metadata stays blocked and cannot remove another resource', () => {
  for (const changes of [{ requestId: [draft().requestId] }, { pending: false },
    { _draftRevision: writerA, _draftSources: [{ key: `sf-k12:cloud-draft:${otherSet}:${note}:${writerB}`, revision: writerB }] }]) {
    data.clear();
    const raw = JSON.stringify({ ...draft(), ...changes });
    data.set(physical(), raw);
    appStorage.setItem(`sf-k12:cloud-draft:${otherSet}:${note}:${writerB}`, 'another resource backup');
    const store = createDraftStore();
    assert.equal(store.readDraft(set, note).blocked, true);
    assert.equal(store.writeDraft(draft()), false);
    assert.equal(data.get(physical()), raw);
    store.clearDraft(set, note);
    assert.equal(appStorage.getItem(`sf-k12:cloud-draft:${otherSet}:${note}:${writerB}`), 'another resource backup');
  }
});

test('legacy single-key recovery is compatible and cleanup never touches old business records', () => {
  const d = draft();
  data.set(physical(), JSON.stringify(d));
  appStorage.setItem('sf-k12:materials', 'legacy business data');
  const store = createDraftStore();
  assert.deepEqual(store.readDraft(set, note).draft, d);
  assert.equal(store.writeDraft({ ...d, body: 'edited' }), true);
  assert.equal(data.has(physical()), true);
  assert.equal(store.clearDraft(set, note), true);
  assert.equal(data.has(physical()), false);
  assert.equal(appStorage.getItem('sf-k12:materials'), 'legacy business data');
});

test('quota failures and absent storage never report durable writes', () => {
  const store = createDraftStore();
  globalThis.localStorage = { ...storage, setItem: () => { throw new Error('quota'); } };
  assert.equal(store.writeDraft(draft()), false);
  globalThis.localStorage = undefined;
  assert.equal(createDraftStore().writeDraft(draft()), false);
});

test('recovery metadata is bounded without silently truncating ancestors', () => {
  let latest;
  for (let index = 0; index < 33; index++) {
    latest = createDraftStore();
    latest.readDraft(set, note);
    assert.equal(latest.writeDraft({ ...draft(), updatedAt: index + 1 }), true);
    for (const raw of data.values()) assert.ok(JSON.parse(raw)._draftSources.length <= 32);
  }
  const next = createDraftStore();
  assert.ok(next.readDraft(set, note).draft);
  assert.equal(next.writeDraft({ ...draft(), updatedAt: 34 }), false);
  assert.equal(next.clearDraft(set, note), true, 'cloud acknowledgement can still retire the complete lineage');
  assert.equal(data.size, 0);
});

test('lost PATCH response acknowledged only by matching text AND the next expected version',()=>{
 const pending={version:3,title:'  我的笔记 ',body:'正文'};
 assert.equal(acknowledgesAttempt({version:4,title:'我的笔记',body:'正文'},pending),true);
 assert.equal(acknowledgesAttempt({version:5,title:'我的笔记',body:'正文'},pending),false);
 assert.equal(acknowledgesAttempt({version:4,title:'我的笔记',body:'其他人内容'},pending),false);
 assert.equal(acknowledgesAttempt({version:4,title:'我的笔记',body:'正文'}),false);
});
test('create retries persist their immutable intent independently of subsequent edits',()=>{
  const store = createDraftStore();
  const d={...draft(),materialId:'new',baseVersion:null};d.pending={clientRequestId:d.requestId,title:'首次意图',body:'首次正文'};d.title='之后改的名称';
  assert.equal(store.writeDraft(d),true);
  const restored = createDraftStore();
  assert.equal(restored.readDraft(set,'new').draft.pending.title,'首次意图');
  assert.equal(restored.readDraft(set,'new').draft.requestId,d.requestId);
  restored.clearDraft(set,'new');assert.equal(createDraftStore().readDraft(set,'new').draft,null);
});
