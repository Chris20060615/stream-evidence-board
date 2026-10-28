import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwitchHttpAdapters } from '../src/twitch-http-adapters.mjs';

// Synthetic credentials, responses and injected fetch only. No real token,
// service, network, browser, account or WebSocket is used.
const CLIENT = 'syntheticboundary01';
const USER = '100';
const SESSION = 'synthetic-boundary-session';
const TOKEN = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const PRIVATE = 'SYNTHETIC_PRIVATE_BODY_CANARY';
const LIMIT = 65_536;
const encode = (value) => new TextEncoder().encode(value);
const runFile = promisify(execFile);

function body(kind) {
  return kind === 'validate'
    ? { client_id: CLIENT, user_id: USER, scopes: ['user:read:chat'], expires_in: 3_600, discarded: PRIVATE }
    : { data: [{ id: 'synthetic-subscription', status: 'enabled', type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: USER, user_id: USER }, transport: { method: 'websocket', session_id: SESSION }, discarded: PRIVATE }], discarded: PRIVATE };
}
function request() {
  return { method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/subscriptions', body: {
    type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: USER, user_id: USER }, transport: { method: 'websocket', session_id: SESSION },
  } };
}
function padded(kind, length) {
  const json = JSON.stringify(body(kind));
  return encode(json + ' '.repeat(length - encode(json).byteLength));
}
function response(kind, chunks, readOverride) {
  const stats = { reads: 0, cancels: 0, releases: 0 }; let index = 0;
  const reader = {
    read() { stats.reads += 1; return readOverride ? readOverride(stats.reads) : index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    cancel() { stats.cancels += 1; }, releaseLock() { stats.releases += 1; },
  };
  return { stats, raw: { status: kind === 'validate' ? 200 : 202, body: { getReader: () => reader } } };
}
function fixture(kind, stream, signal) {
  const credential = Object.freeze({}); const calls = [];
  const adapters = createTwitchHttpAdapters({ clientId: CLIENT, broadcasterId: USER, readerId: USER,
    resolveCredential: () => TOKEN, fetch: (url, options) => { calls.push({ url, options }); return stream.raw; },
  });
  return { calls, task: () => adapters[kind]({ credential, ...(kind === 'subscribe' ? { request: request() } : {}), ...(signal ? { signal } : {}) }) };
}
function fixed(error, code) {
  assert.ok(error instanceof Error); assert.equal(error.name, 'Error'); assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false); assert.equal(Object.hasOwn(error, 'code'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_|synthetic-boundary-session/);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_|synthetic-boundary-session/); return true;
}
function receipt(value, kind) {
  assert.equal(value.httpStatus, kind === 'validate' ? 200 : 202);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.body), true);
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_|discarded/);
  if (kind === 'validate') assert.deepEqual(value.body.scopes, ['user:read:chat']);
  else assert.equal(value.body.data[0].transport.session_id, SESSION);
}

for (const kind of ['validate', 'subscribe']) {
  test(`${kind}: actual 65536-byte Uint8Array and Buffer boundaries are accepted and projected privately`, async () => {
    for (const bytes of [padded(kind, LIMIT), Buffer.from(padded(kind, LIMIT))]) {
      const stream = response(kind, [bytes]); const f = fixture(kind, stream); receipt(await f.task(), kind);
      assert.equal(f.calls.length, 1); assert.equal(stream.stats.cancels, 0); assert.equal(stream.stats.releases, 1);
    }
  });

  test(`${kind}: real oversized typed arrays and decorated Buffers cannot spoof byteLength with a data property`, async () => {
    for (const bytes of [padded(kind, LIMIT + 1), Buffer.from(padded(kind, LIMIT + 1))]) {
      Object.defineProperty(bytes, 'byteLength', { value: 0 });
      const stream = response(kind, [bytes]); await assert.rejects(fixture(kind, stream).task(), (error) => fixed(error, 'body_limit'));
      assert.equal(stream.stats.reads, 1); assert.equal(stream.stats.cancels, 1); assert.equal(stream.stats.releases, 1);
    }
  });

  test(`${kind}: oversized byteLength accessors are never invoked and size rejection precedes malformed UTF8 decoding`, async () => {
    for (const bytes of [padded(kind, LIMIT + 1), Buffer.from(padded(kind, LIMIT + 1))]) {
      bytes[bytes.length - 1] = 0xff; let reads = 0;
      Object.defineProperty(bytes, 'byteLength', { get() { reads += 1; return 0; } });
      const stream = response(kind, [bytes]); await assert.rejects(fixture(kind, stream).task(), (error) => fixed(error, 'body_limit'));
      assert.equal(reads, 0); assert.equal(stream.stats.cancels, 1);
    }
  });

  test(`${kind}: byte accounting uses cumulative view lengths and offsets rather than backing-buffer length`, async () => {
    const backing = new Uint8Array(LIMIT + 2_048); backing.fill(0xff); const view = backing.subarray(1_024, 1_024 + LIMIT); view.set(padded(kind, LIMIT));
    receipt(await fixture(kind, response(kind, [view.subarray(0, 31_000), view.subarray(31_000)])).task(), kind);
    const large = padded(kind, LIMIT + 1); const stream = response(kind, [large.subarray(0, 31_000), large.subarray(31_000)]);
    await assert.rejects(fixture(kind, stream).task(), (error) => fixed(error, 'body_limit')); assert.equal(stream.stats.cancels, 1);
  });

  test(`${kind}: typed-array Proxy brand failures are fixed invalid_response without reading proxy properties`, async () => {
    let propertyReads = 0;
    const bytes = new Proxy(padded(kind, LIMIT + 1), { get() { propertyReads += 1; throw new Error(PRIVATE); } });
    const stream = response(kind, [bytes]); await assert.rejects(fixture(kind, stream).task(), (error) => fixed(error, 'invalid_response'));
    assert.equal(propertyReads, 0); assert.equal(stream.stats.cancels, 1);
  });

  test(`${kind}: read-result accessors cannot switch small byte counts to oversized decoder input`, async () => {
    let accesses = 0; const small = encode(' '); const large = padded(kind, LIMIT + 1);
    const chunk = { done: false }; Object.defineProperty(chunk, 'value', { enumerable: true, get() { accesses += 1; return accesses <= 2 ? small : large; } });
    const stream = response(kind, [], (reads) => reads === 1 ? chunk : { done: true });
    await assert.rejects(fixture(kind, stream).task(), (error) => fixed(error, 'invalid_response')); assert.equal(accesses, 0); assert.equal(stream.stats.reads, 1);
    const controller = new AbortController(); let inspections = 0;
    const aborting = new Proxy({ done: false, value: encode(JSON.stringify(body(kind))) }, {
      getOwnPropertyDescriptor(target, key) { inspections += 1; controller.abort(PRIVATE); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const reentry = response(kind, [], () => aborting);
    await assert.rejects(fixture(kind, reentry, controller.signal).task(), (error) => fixed(error, 'aborted'));
    assert.ok(inspections > 0); assert.equal(reentry.stats.cancels, 1); assert.equal(reentry.stats.reads, 1);
  });
}

// Isolate native unhandled-rejection observation in a child process. The child
// reports aggregate counts only, so even deliberately hostile cleanup messages
// never appear in TAP output. It imports this test's matching relative module.
async function cleanupReport(path) {
  const moduleUrl = new URL('../src/twitch-http-adapters.mjs', import.meta.url).href;
  const script = `import {createTwitchHttpAdapters} from ${JSON.stringify(moduleUrl)};
    const client=${JSON.stringify(CLIENT)}, user=${JSON.stringify(USER)}, session=${JSON.stringify(SESSION)};
    const canary=${JSON.stringify(PRIVATE)}, token=${JSON.stringify(TOKEN)};
    let unhandled=0, getterReads=0, cases=0, releases=0;
    process.on('unhandledRejection',()=>{unhandled++;});
    const flush=()=>new Promise(r=>setImmediate(r));
    for(const kind of ['validate','subscribe'])for(const mode of ['reject','never','then-getter']){
      const payload=kind==='validate'?{client_id:client,user_id:user,scopes:['user:read:chat'],expires_in:3600}:{data:[{id:'synthetic-subscription',status:'enabled',type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:user,user_id:user},transport:{method:'websocket',session_id:session}}]};
      let count=0, resolveFetch;
      const reader={read(){return count++?{done:true}:{done:false,value:new TextEncoder().encode(JSON.stringify(payload))};},cancel(){return Promise.reject(new Error(canary));},releaseLock(){releases++;return mode==='reject'?Promise.reject(new Error(canary)):mode==='never'?new Promise(()=>{}):Object.defineProperty({},'then',{get(){getterReads++;throw new Error(canary);}});}};
      const response={status:kind==='validate'?200:202,body:{getReader:()=>reader}};
      const a=createTwitchHttpAdapters({clientId:client,broadcasterId:user,readerId:user,resolveCredential:()=>token,timeoutMs:20,fetch:()=>${path === 'late' ? 'new Promise(r=>{resolveFetch=r;})' : 'response'}});
      const options={credential:{},...(kind==='subscribe'?{request:{method:'POST',url:'https://api.twitch.tv/helix/eventsub/subscriptions',body:{type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:user,user_id:user},transport:{method:'websocket',session_id:session}}}}:{})};
      try{await a[kind](options);${path === 'late' ? 'throw new Error("unexpected_success");' : ''}}
      catch(error){if(${path === 'late' ? 'error.message!=="timeout"' : 'true'})throw new Error('fixed_operation_failed');}
      ${path === 'late' ? 'resolveFetch(response);' : ''}
      await flush();await flush();cases++;
    }
    console.log(JSON.stringify({cases,releases,unhandled,getterReads}));
  `;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 4_000, windowsHide: true });
  assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /SYNTHETIC_/); return JSON.parse(result.stdout);
}

test('owned reader cleanup observes rejected native release promises without awaiting or assimilating then getters', async () => {
  assert.deepEqual(await cleanupReport('owned'), { cases: 6, releases: 6, unhandled: 0, getterReads: 0 });
});

test('late response fallback cleanup remains nonblocking and observes native release rejections privately', async () => {
  assert.deepEqual(await cleanupReport('late'), { cases: 6, releases: 6, unhandled: 0, getterReads: 0 });
});
