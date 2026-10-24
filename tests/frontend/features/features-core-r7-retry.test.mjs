import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';
const flush=async(n=10)=>{for(let i=0;i<n;i++)await nextTurn();};
const revised=(data,revision,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','X-JE-Revision':revision}});
function core(h){for(const m of ['core/navigation.js','core/session.js','core/access-revision.js','core/api-client.js'])h.load(m);}

test('a retry of an old sign-in must not send or take a revision in the new sign-in',async t=>{
 let user='user-a'; const seen=[]; const timers=[];
 const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>`credential-${user}`},fetch:async(_url,options)=>{
   seen.push(options.headers.Authorization);
   return seen.length===1?revised({},'a=A;hc=A;sg=A',503):revised({},'a=A;hc=A;sg=A');
 }});t.after(()=>h.close());
 const real=h.window.setTimeout.bind(h.window);
 h.window.setTimeout=(fn,ms,...args)=>{if(ms>=300&&ms<=1000){timers.push(()=>fn(...args));return 9876;}return real(fn,ms,...args);};
 core(h); h.JE.core.revision.noteRevision('a=A;hc=A;sg=A');
 const pending=h.JE.core.api.plugin('/retry-across-signin').catch(e=>e);
 await flush(); assert.equal(seen.length,1);assert.equal(timers.length,1);
 user='user-b';h.JE.session.checkNow('switch');h.JE.core.revision.noteRevision('a=B;hc=B;sg=B');
 timers.shift()(); const ended=await pending;assert.equal(ended.name,"AbortError");
 assert.equal(seen.length,1,`old request sent again after sign-in: ${seen.length} sends; current revision=${h.JE.core.revision.access()}`);
 assert.equal(h.JE.core.revision.access(),'B');
});

test('r7 retry from the old sign-in must not claim a new observation for old credentials',async t=>{
  let user='user-a';let attempts=0;let oldAuth;
  const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>user},fetch:async(_url,opts)=>{
    attempts++;oldAuth=opts.headers.Authorization;
    if(attempts===1) {
      user='user-b';h.JE.session.checkNow('switch');
      h.JE.core.revision.noteRevision('a=b;hc=b;sg=b');
      return new Response('{}',{status:503});
    }
    return new Response('{"private":"A"}',{headers:{'X-JE-Revision':'a=a;hc=a;sg=a'}});
  }});
  t.after(()=>h.close());
  for(const m of ['core/navigation.js','core/session.js','core/access-revision.js','core/api-client.js'])h.load(m);
  h.JE.core.revision.noteRevision('a=a;hc=a;sg=a');
  const ended=await h.JE.core.api.plugin('/probe').catch(error=>error);
  assert.equal(ended.name,'AbortError');assert.equal(attempts,1,'old credentials are never sent again');
  assert.match(oldAuth,/user-a/);
  assert.equal(h.JE.core.revision.access(),'b','a retry with A credentials must not adopt As header as Bs current revision');
});

