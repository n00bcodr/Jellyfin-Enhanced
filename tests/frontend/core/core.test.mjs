import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse, plain } from '../helpers/harness.mjs';

function setup(t, options = {}, modules = ['navigation', 'session', 'api-client']) {
  const h = createHarness(options); t.after(() => h.close());
  for (const name of modules) h.load(`core/${name}.js`);
  return h;
}

test('navigation reports changed URLs once across push, replace and duplicate events', t => {
  const { window, JE } = setup(t, {}, ['navigation']);
  let calls = 0; const off = JE.core.navigation.onNavigate(() => calls++);
  window.history.pushState({}, '', '#!/details?id=1');
  window.dispatchEvent(new window.Event('popstate'));
  window.dispatchEvent(new window.Event('hashchange'));
  window.history.pushState({}, '', window.location.href);
  assert.equal(calls, 1);
  window.history.replaceState({}, '', '#!/details?id=2'); assert.equal(calls, 2);
  off(); window.history.pushState({}, '', '#!/home'); assert.equal(calls, 2);
});

test('view fallback preserves event target, filters pages and fetches the URL item', async t => {
  const { window, JE, document } = setup(t, { html: '<div class="libraryPage" data-type="item" id="view"></div>',
    url: 'http://jellyfin.test/web/#!/details?id=abc', apiClient: { getItem: async (user,id) => ({ user,id }) } }, ['navigation']);
  let value, wrong = 0;
  const off = JE.core.navigation.onViewPage((...args) => { value = args; }, { pages: ['item'], fetchItem: true });
  JE.core.navigation.onViewPage(() => wrong++, { pages: ['home'] });
  const el = document.querySelector('#view');
  el.dispatchEvent(new window.CustomEvent('viewshow', { bubbles: true, detail: { type: 'item' } }));
  assert.equal(value[0], 'item'); assert.equal(value[1], el);
  assert.deepEqual(await value[3], { user: 'user-a', id: 'abc' }); assert.equal(wrong, 0);
  off(); assert.equal(JE.core.navigation.getViewHandlerCount(), 1);
});

test('Emby hook preserves original handler and emits one view notification', t => {
  let original = 0, seen = 0;
  const { window, JE } = setup(t, { globals: { Emby: { Page: { onViewShow() { original++; } } } } }, ['navigation']);
  JE.core.navigation.onViewPage(() => seen++);
  window.document.dispatchEvent(new window.CustomEvent('viewshow'));
  window.Emby.Page.onViewShow('home'); assert.equal(original, 1); assert.equal(seen, 1);
});

test('lifecycle releases all resource kinds, listeners, and preserves hooks across remounts', t => {
  const { JE, window } = setup(t, {}, ['navigation','lifecycle']);
  const handle = JE.core.lifecycle.register('feature'); const calls = [];
  assert.equal(JE.core.lifecycle.register('feature'), handle);
  for (const method of ['abort', 'disconnect', 'unsubscribe']) handle.track({ [method]: () => calls.push(method) });
  handle.track(() => calls.push('cleanup'));
  const ignored = () => calls.push('ignored'); handle.track(ignored); handle.untrack(ignored);
  handle.addListener(window, 'probe', () => calls.push('event'));
  handle.onTeardown(() => calls.push('hook')); handle.teardownOn('navigate');
  window.history.pushState({}, '', '#!/one'); window.dispatchEvent(new window.Event('probe'));
  assert.deepEqual(calls, ['abort','disconnect','unsubscribe','cleanup','hook']);
  window.history.pushState({}, '', '#!/two'); assert.equal(calls.at(-1), 'hook'); assert.equal(calls.length, 6);
  assert.equal(JE.core.lifecycle.get('missing'), null);
});

test('session resets synchronously before credentials change and invalidates stale epochs', t => {
  let user = 'a', token = 'a-token'; const order = [];
  const { JE, window } = setup(t, { apiClient: {
    getCurrentUserId: () => user, accessToken: () => token,
    setAuthenticationInfo(nextToken, nextUser) { order.push('auth'); token = nextToken; user = nextUser; return 42; }
  } }, ['navigation','session']);
  const epoch = JE.session.getEpoch();
  JE.session.onUserChange('test', change => { order.push(`reset:${token}:${change.userId}`); });
  window.document.addEventListener('je:user-changed', () => order.push('event'));
  assert.equal(window.ApiClient.setAuthenticationInfo('b-token','b'), 42);
  assert.deepEqual(order, ['reset:a-token:b','event','auth']);
  assert.equal(JE.session.isCurrent(epoch), false); assert.equal(JE.session.getUserId(), 'b');
  window.ApiClient.setAuthenticationInfo(null,null); assert.equal(JE.session.getUserId(), null);
});

test('server changes reset same-user identity; removed handlers stay removed', t => {
  let server = 'one'; let count = 0;
  const { JE } = setup(t, { apiClient: { serverId: () => server } }, ['navigation','session']);
  const off = JE.session.onUserChange('feature', () => count++);
  server = 'two'; JE.session.checkNow('test'); assert.equal(count,1);
  off(); server = 'three'; JE.session.checkNow('test'); assert.equal(count,1);
});

test('authenticated requests resolve plugin paths, JSON bodies, and compatible headers', async t => {
  let request;
  const { JE } = setup(t, { fetch: async (...args) => { request = args; return jsonResponse({ ok: true }); } });
  assert.deepEqual(plain(await JE.core.api.plugin('/preferences', { method: 'POST', body: { language: '日本語' } })), { ok: true });
  assert.equal(request[0], 'http://jellyfin.test/JellyfinEnhanced/preferences');
  assert.equal(request[1].headers.Authorization, 'MediaBrowser Token="test-token"');
  assert.equal(request[1].headers['X-Jellyfin-User-Id'], 'user-a');
  assert.equal(request[1].headers['X-Emby-Token'], 'test-token');
  assert.equal(request[1].body, '{"language":"日本語"}');
});

test('plain concurrent GETs deduplicate transport but isolate mutable results', async t => {
  const pending = deferred(); let calls = 0;
  const { JE } = setup(t, { fetch: () => { calls++; return pending.promise; } });
  const a = JE.core.api.fetch('/same'), b = JE.core.api.fetch('/same');
  assert.equal(calls, 1); pending.resolve(jsonResponse({ nested: { value: 1 } }));
  const [one,two] = await Promise.all([a,b]); one.nested.value = 2; assert.equal(two.nested.value,1);
});

test('custom headers and writes do not accidentally share requests', async t => {
  let calls = 0; const { JE } = setup(t, { fetch: async () => { calls++; return jsonResponse({}); } });
  await Promise.all([JE.core.api.fetch('/x',{headers:{variant:'a'}}),JE.core.api.fetch('/x',{headers:{variant:'b'}}),
    JE.core.api.fetch('/x',{method:'POST'}),JE.core.api.fetch('/x',{method:'POST'})]);
  assert.equal(calls,4);
});

test('response cache expires, evicts least-recently-used entries, and selectively clears', t => {
  const { JE, window } = setup(t); const m = JE.core.api.manager;
  let now = 100; window.Date.now = () => now; m.CONFIG.cache.maxEntries = 2; m.CONFIG.cache.ttlMs = 10;
  m.setCache('a',1); m.setCache('b',2); assert.equal(m.getCached('a'),1); m.setCache('c',3);
  assert.equal(m.getCached('b'),null); m.clearCacheMatching('c'); assert.equal(m.getCached('c'),null);
  now = 110; assert.equal(m.getCached('a'),null);
});

test('late previous-user response cannot repopulate cleared cache', async t => {
  let user = 'a'; const pending = deferred();
  const { JE } = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: () => pending.promise });
  JE.core.api.manager.setCache('old',{private:true});
  const request = JE.core.api.fetch('/private',{cacheKey:'private'});
  user = 'b'; JE.session.checkNow('test'); pending.resolve(jsonResponse({owner:'a'})); await request;
  assert.equal(JE.core.api.manager.getCached('private'),null); assert.equal(JE.core.api.manager.getCached('old'),null);
});

test('a request made after a user switch never joins the previous user\'s in-flight request', async t => {
  let user = 'a'; const responses = [];
  const { JE } = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: () => { const response = deferred(); responses.push(response); return response.promise; } });
  const old = JE.core.api.fetch('/private').catch(() => null);
  await new Promise(done => setImmediate(done));
  user = 'b'; JE.session.checkNow('test');
  const fresh = JE.core.api.fetch('/private');
  await new Promise(done => setImmediate(done));
  assert.equal(responses.length, 2);
  responses[0].resolve(jsonResponse({ owner: 'a' })); responses[1].resolve(jsonResponse({ owner: 'b' }));
  assert.equal((await fresh).owner, 'b'); await old;
});

test('user switch cancels queued writes before they can use new credentials', async t => {
  let user = 'a', calls = 0; const pending = deferred();
  const { JE } = setup(t, { apiClient: { getCurrentUserId: () => user }, fetch: () => { calls++; return pending.promise; } });
  JE.core.api.manager.CONFIG.concurrency.maxConcurrent = 1;
  const running = JE.core.api.fetch('/one');
  const queued = JE.core.api.fetch('/write',{method:'POST'});
  const rejected = assert.rejects(queued,{name:'AbortError'});
  user = 'b'; JE.session.checkNow('test'); await rejected;
  pending.resolve(jsonResponse({})); await running; assert.equal(calls,1);
});

test('aborted queued requests release their place without consuming transport', async t => {
  const pending = deferred(); let calls = 0;
  const { JE,window } = setup(t,{fetch:()=>{calls++; return calls===1?pending.promise:Promise.resolve(jsonResponse({ok:true}));}});
  JE.core.api.manager.CONFIG.concurrency.maxConcurrent=1;
  const running=JE.core.api.fetch('/one'); const controller=new window.AbortController();
  const queued=JE.core.api.fetch('/two',{signal:controller.signal});
  const rejected=assert.rejects(queued,{name:'AbortError'}); controller.abort(); await rejected;
  pending.resolve(jsonResponse({})); await running; assert.equal(calls,1);
  // The aborted entry must have left the queue: otherwise it takes the freed slot and never returns it.
  const third=JE.core.api.fetch('/three');
  const outcome=await Promise.race([third,new Promise(done=>setTimeout(()=>done('hung'),1000))]);
  assert.notEqual(outcome,'hung','a later request must still get a slot');
  assert.equal(calls,2);
});

for (const status of [400,401,403,404]) test(`HTTP ${status} does not retry`,async t=>{
  let calls=0; const {JE}=setup(t,{fetch:async()=>{calls++;return jsonResponse({message:'denied'},status);}});
  await assert.rejects(JE.core.api.fetch('/denied')); assert.equal(calls,1);
});

test('retryable failures recover with bounded retry count',async t=>{
  let calls=0; const {JE}=setup(t,{fetch:async()=>++calls===1?jsonResponse({},503):jsonResponse({ok:true})});
  Object.assign(JE.core.api.manager.CONFIG.retry,{baseDelayMs:0,jitterFactor:0});
  assert.equal((await JE.core.api.fetch('/retry')).ok,true); assert.equal(calls,2);
});

test('empty response is supported while malformed JSON fails explicitly',async t=>{
  let body=''; const {JE}=setup(t,{fetch:async()=>new Response(body)});
  assert.deepEqual(plain(await JE.core.api.fetch('/empty')),{});
  body='broken'; await assert.rejects(JE.core.api.fetch('/broken'),{name:'SyntaxError'});
});

test('navigation aborts page signals and replacing a page signal cancels the previous request',t=>{
  const {JE,window}=setup(t); const m=JE.core.api.manager;
  const old=m.getAbortSignal('page'),next=m.getAbortSignal('page'); assert.equal(old.aborted,true);
  window.history.pushState({},'','#!/next'); assert.equal(next.aborted,true);
});

test('simultaneous DOM waits resolve independently and remove subscriptions',async t=>{
  const {JE,document}=setup(t,{},['dom-observer']); const dom=JE.core.dom;
  const a=dom.waitForElement('.target'),b=dom.waitForElement('.target'); assert.equal(dom.getBodySubscriberCount(),2);
  const el=document.createElement('div');el.className='target';document.body.append(el);
  assert.equal(await a,el);assert.equal(await b,el);assert.equal(dom.getBodySubscriberCount(),0);
});

test('DOM waits inspect all candidates and support root/predicate matching',async t=>{
  const {JE,document}=setup(t,{html:'<div class="item">old</div><section><div class="item">new</div></section>'},['dom-observer']);
  const el=await JE.core.dom.waitForElement('.item',{root:document.querySelector('section'),predicate:el=>el.textContent==='new'});
  assert.equal(el.textContent,'new');assert.equal(JE.core.dom.getBodySubscriberCount(),0);
});

test('DOM observers disconnect on teardown and do not see later changes',async t=>{
  const {JE,document}=setup(t,{},['dom-observer']);let calls=0;
  JE.core.dom.onBodyMutation('test',()=>calls++,{priority:1});
  document.body.append(document.createElement('div'));await Promise.resolve();assert.equal(calls,1);
  JE.core.dom.disconnectAllObservers();document.body.append(document.createElement('div'));await Promise.resolve();
  assert.equal(calls,1);assert.equal(JE.core.dom.getBodySubscriberCount(),0);
});

test('replacing a priority subscriber with a normal one retains other pre-paint subscribers',async t=>{
  const {JE,document}=setup(t,{},['dom-observer']);const seen=[];
  JE.core.dom.onBodyMutation('first',()=>seen.push('old'),{priority:10});
  JE.core.dom.onBodyMutation('second',()=>seen.push('second'),{priority:5});
  JE.core.dom.onBodyMutation('first',()=>seen.push('normal'));
  document.body.append(document.createElement('div'));await Promise.resolve();
  assert.deepEqual(seen,['second']);
});

test('stale subscriber handles cannot remove their replacement',async t=>{
  const {JE,document}=setup(t,{},['dom-observer']);let seen=0;
  const old=JE.core.dom.onBodyMutation('same',()=>{}, {priority:1});
  JE.core.dom.onBodyMutation('same',()=>seen++, {priority:1});old.unsubscribe();
  document.body.append(document.createElement('div'));await Promise.resolve();assert.equal(seen,1);
});

test('replacing dedicated observer with shared observer disconnects the old observer',async t=>{
  const {JE,document}=setup(t,{html:'<div id="target"></div>'},['dom-observer']);let oldCalls=0;
  const target=document.querySelector('#target');
  JE.core.dom.createObserver('same',()=>oldCalls++,target,{attributes:true});
  JE.core.dom.createObserver('same',()=>{},document.body,{childList:true,subtree:true});
  target.setAttribute('data-value','changed');await Promise.resolve();assert.equal(oldCalls,0);
});

test('refreshing an existing cache key does not evict an unrelated response',t=>{
 const {JE}=setup(t);const m=JE.core.api.manager;m.CONFIG.cache.maxEntries=2;
 m.setCache('a',1);m.setCache('b',2);m.getCached('a');m.setCache('a',3);
 assert.equal(m.getCached('b'),2);assert.equal(m.getCached('a'),3);
});

test('subscribing during priority dispatch does not revisit the current subscriber',async t=>{
 const {JE,document}=setup(t,{},['dom-observer']);let calls=0;
 JE.core.dom.onBodyMutation('first',()=>{calls++;if(calls===1)JE.core.dom.onBodyMutation('new',()=>{}, {priority:2});},{priority:1});
 document.body.append(document.createElement('div'));await Promise.resolve();assert.equal(calls,1);
});
