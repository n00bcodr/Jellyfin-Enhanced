import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function load(h) { for (const f of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(f); }
function core(t, options = {}) { const h = createHarness(options); t.after(() => h.close()); h.allowConsoleError(/./); load(h); return h; }
test('R13: a confirmed build mismatch does not cause one handshake per later answer',async t=>{
 let handshakes=0;
 const h=core(t,{JE:{pageBuild:'page',serverBuild:'page',t:k=>k},fetch:async()=>{handshakes++;return new Response('v',{headers:{'X-JE-Build':'newer','Cache-Control':'no-store'}});}});
 for(let i=0;i<20;i++) {h.JE.core.build.noteAnswer(new Response('{}',{headers:{'X-JE-Build':'newer','Cache-Control':'private, max-age=1800'}})); await settle();}
 assert.equal(handshakes,1);
});
test('R13: two refuted kept builds do not repeatedly handshake',async t=>{
 let handshakes=0;
 const h=core(t,{JE:{pageBuild:'page',serverBuild:'page',t:k=>k},fetch:async()=>{handshakes++;return new Response('v',{headers:{'X-JE-Build':'page','Cache-Control':'no-store'}});}});
 for(let i=0;i<20;i++) { h.JE.core.build.noteAnswer(new Response('{}',{headers:{'X-JE-Build':i%2?'old-a':'old-b','Cache-Control':'private, max-age=1800'}})); await settle(); }
 assert.ok(handshakes<=2);
});
test('build-owner: a handshake answered after a server switch has no effect',async t=>{
  let server='server-a';const held=deferred();
  const h=createHarness({JE:{pageBuild:'current',serverBuild:'current',t:k=>k},apiClient:{serverId:()=>server},fetch:()=>held.promise});
  t.after(()=>h.close());load(h);
  const pending=h.JE.core.build.hint('previous');
  server='server-b';h.JE.session.checkNow('switch server');
  held.resolve(new Response('1.0',{headers:{'X-JE-Build':'newer-on-server-a','Cache-Control':'no-store'}}));
  await pending;
  assert.equal(h.document.querySelector('.je-reload-notice'),null,'server B runs current; A cannot tell B to reload');
});
test('build-cache: a cacheable handshake response is not fresh proof',async t=>{
  const h=createHarness({JE:{pageBuild:'current',serverBuild:'current',t:k=>k},fetch:async()=>new Response('1.0',{headers:{'X-JE-Build':'previous','Cache-Control':'public, max-age=1800','Age':'60'}})});
  t.after(()=>h.close());load(h);await h.JE.core.build.hint('previous');
  assert.equal(h.document.querySelector('.je-reload-notice'),null,'the legacy cached /version response cannot establish the running build');
});
test('control: a proven refusal stays refused and a current handshake can show its notice',async t=>{
  const h=createHarness({JE:{pageBuild:'current',serverBuild:'current'},fetch:async()=>new Response('1.0',{headers:{'X-JE-Build':'newer','Cache-Control':'no-store'}})});t.after(()=>h.close());load(h);
  const error=await h.JE.core.userWrite.send(h.JE.core.userWrite.origin(),()=>Promise.reject(Object.assign(new Error('refused'),{status:422}))).catch(e=>e);
  assert.equal(h.JE.core.userWrite.outcome(error),'refused');await h.JE.core.build.hint('newer');assert.ok(h.document.querySelector('.je-reload-notice'));
});
