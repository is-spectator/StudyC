import test from 'node:test';
import assert from 'node:assert/strict';
import { authApi } from './api.ts';
import { requestWithSession } from './session-state.ts';

test('authenticated SSE decodes split UTF-8/CRLF frames and closes after done', async () => {
  const text = ': heartbeat\r\n\r\nevent: progress\r\ndata: {"text":"水循环"}\r\n\r\nevent: done\r\ndata: {"jobId":"one"}\r\n\r\n';
  const encoded = new TextEncoder().encode(text), events = [];
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 5) controller.enqueue(encoded.slice(i,i+5)); }, cancel() { cancelled = true; } });
  await authApi('/v1/study/sets/one/events', { onEvent: event => events.push(event) }, async (_path, options) => {
    assert.equal(options.headers.get('accept'), 'text/event-stream');
    assert.equal(options.credentials, 'same-origin');
    return new Response(body, { headers: { 'content-type':'text/event-stream' } });
  });
  assert.deepEqual(events.map(event => [event.event,event.data]), [['progress',{text:'水循环'}],['done',{jobId:'one'}]]);
  assert.equal(cancelled,true);
});

test('stream HTML, malformed data and premature EOF never count as completion', async () => {
  for (const [content,type] of [['<html>oops</html>','text/html'],['data: nope\n\n','text/event-stream'],['event: progress\ndata: {}\n\n','text/event-stream']]) {
    await assert.rejects(authApi('/v1/study/test/events', { onEvent() {} }, async () => new Response(content,{headers:{'content-type':type}})), error => ['invalid_response','connection_lost'].includes(error.code));
  }
});

test('a late streaming event from the old account is rejected before rendering', async () => {
  const state = { session:{current:{userId:'11111111-1111-4111-8111-111111111111',csrfToken:'a'.repeat(43)}},epoch:{current:1},preview:{current:false},mounted:{current:true},clearIdentity(){assert.fail('must not clear new identity');},reverify(){assert.fail();} };
  let deliveries = 0;
  await assert.rejects(requestWithSession('/v1/study/test/events',{onEvent(){deliveries++;}},state,async (_path, options) => {
    options.onEvent({event:'progress',data:{text:'old'}});
    state.epoch.current++;
    options.onEvent({event:'progress',data:{text:'late'}});
  }), error => error.code === 'account_mismatch');
  assert.equal(deliveries,1);
});


test('cumulative snapshots allow a full answer but retain an 8 MiB stream limit', async () => {
  const frame = new TextEncoder().encode('event: progress\ndata: '+JSON.stringify({text:'水'.repeat(8000)})+'\n\n');
  const run = async count => authApi('/v1/study/test/events', { onEvent() {} }, async () => new Response(new ReadableStream({ start(controller) {
    for (let i=0;i<count;i++) controller.enqueue(frame);
    controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n')); controller.close();
  } }), {headers:{'content-type':'text/event-stream'}}));
  await run(260);
  await assert.rejects(run(360), error => error.code === 'invalid_response' && error.message.includes('大小限制'));
});
