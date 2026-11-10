import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse, plain } from '../helpers/harness.mjs';
function setup(t, fetch, apiClient={}) {
  const h=createHarness({JE:{pluginVersion:'test-v1',cdn:{url:(source,path)=>`http://jellyfin.test/cdn/${source}/${path}`}},apiClient:{getCurrentUser:()=>({Id:'a'}),...apiClient},fetch});
  t.after(()=>h.close());h.load('enhanced/translations.js');return h;
}
test('translations normalize per-user language and cache the bundled Unicode response',async t=>{
  const calls=[]; const h=setup(t,async url=>{calls.push(url);return jsonResponse({greeting:'こんにちは {name}'});});
  h.window.localStorage.setItem('a-language','JA-jp');
  assert.deepEqual(plain(await h.JE.loadTranslations()),{greeting:'こんにちは {name}'});
  assert.match(calls[0],/JA|ja-JP/);assert.match(calls[0],/\/locales\/ja-JP.json$/);
  assert.match(calls[1],/\/locales\/en.json$/,'English is loaded once as the per-key fallback');
  await h.JE.loadTranslations();assert.equal(calls.length,2,'both come from the cache the second time');
});
test('a locale missing a key falls back to the English string for that key only',async t=>{
  const h=setup(t,async url=>url.endsWith('/en-GB.json')?jsonResponse({colour:'Colour',shared:'GB wins'}):url.endsWith('/en.json')?jsonResponse({colour:'Color',shared:'en loses',status_tag_just_added:'Just Added'}):jsonResponse({},404));
  h.window.localStorage.setItem('a-language','en-GB');
  const tr=plain(await h.JE.loadTranslations());
  assert.equal(tr.colour,'Colour');assert.equal(tr.shared,'GB wins');assert.equal(tr.status_tag_just_added,'Just Added');
});
test('translations use Jellyfin document language when no local preference exists',async t=>{
  const calls=[];const h=setup(t,async url=>{calls.push(url);return jsonResponse({yes:'Oui'});});
  h.document.documentElement.lang='fr';await h.JE.loadTranslations();assert.match(calls[0],/\/fr.json$/);
});
test('corrupt current-version cache refetches and old-version entries are removed',async t=>{
  let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({ok:'OK'});});const store=h.window.localStorage;
  store.setItem('JE_translation_en_test-v1','{broken');store.setItem('JE_translation_ts_en_test-v1',String(Date.now()));
  store.setItem('JE_translation_en_old','{}');store.setItem('unrelated','keep');
  assert.equal((await h.JE.loadTranslations()).ok,'OK');assert.equal(calls,1);
  assert.equal(store.getItem('JE_translation_en_old'),null);assert.equal(store.getItem('unrelated'),'keep');
});
for(const [label,age,expired] of [['a minute short of',24*60*60*1000-60*1000,false],['a minute past',24*60*60*1000+60*1000,true]])test(`translations cached ${label} 24 hours ${expired?'are fetched again':'are reused'}`,async t=>{
  let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({ok:'fresh'});});const store=h.window.localStorage;
  store.setItem('JE_translation_en_test-v1',JSON.stringify({ok:'cached'}));store.setItem('JE_translation_ts_en_test-v1',String(Date.now()-age));
  assert.equal((await h.JE.loadTranslations()).ok,expired?'fresh':'cached');assert.equal(calls,expired?1:0);
});
test('translation fallback stays on the local proxy and supports English fallback',async t=>{
  const calls=[];const h=setup(t,async url=>{calls.push(url);return url.endsWith('/en.json')?jsonResponse({ok:'OK'}):jsonResponse({},404);});
  h.window.localStorage.setItem('a-language','zz');assert.equal((await h.JE.loadTranslations()).ok,'OK');
  assert.ok(calls.every(url=>url.startsWith('http://jellyfin.test/')));assert.ok(calls.some(url=>url.includes('/cdn/locales/')));
});
test('unavailable translation sources resolve to an empty dictionary without poisoning cache',async t=>{
  const h=setup(t,async()=>{throw new Error('offline');});h.expectConsoleError(/Failed to load translations from any source/);assert.deepEqual(plain(await h.JE.loadTranslations()),{});
  assert.equal(h.window.localStorage.length,0);
});
// The locale decoder checks a dictionary without copying it (perf-runtime); what it accepts and rejects is unchanged.
test('a cached locale holding a non-string value is discarded and fetched again',async t=>{
  let calls=0;const h=setup(t,async()=>{calls++;return jsonResponse({ok:'fresh'});});const store=h.window.localStorage;
  store.setItem('JE_translation_en_test-v1',JSON.stringify({ok:'cached',broken:{nested:true}}));store.setItem('JE_translation_ts_en_test-v1',String(Date.now()));
  assert.deepEqual(plain(await h.JE.loadTranslations()),{ok:'fresh'});assert.equal(calls,1);
  assert.equal(store.getItem('JE_translation_en_test-v1'),JSON.stringify({ok:'fresh'}));
});
test('a served locale holding a non-string value is not used or cached',async t=>{
  const h=setup(t,async url=>url.includes('/cdn/')?jsonResponse({},404):jsonResponse({ok:'OK',count:3}));
  h.expectConsoleError(/Failed to load translations from any source/);
  assert.deepEqual(plain(await h.JE.loadTranslations()),{});assert.equal(h.window.localStorage.length,0);
});
test('a locale key named __proto__ stays an ordinary entry and changes no prototype',async t=>{
  const h=setup(t,async()=>new Response('{"__proto__":"text","ok":"OK"}',{status:200,headers:{'Content-Type':'application/json'}}));
  const tr=await h.JE.loadTranslations();
  assert.equal(tr.ok,'OK');assert.equal(Object.getOwnPropertyDescriptor(tr,'__proto__')?.value,'text');
  assert.deepEqual(Object.keys(tr),['__proto__','ok']);assert.equal(h.window.Object.prototype.ok,undefined);
  assert.equal(JSON.parse(h.window.localStorage.getItem('JE_translation_en_test-v1')).ok,'OK');
});
// Guard: the first decoder copied every key with Object.defineProperty, about 4 ms of main thread per page load
// (two locales of ~1,400 keys, cold code). The count of property definitions must not grow with the dictionary.
test('loading a locale does not define its keys one property at a time',async t=>{
  const keys=1500;const big=Object.fromEntries(Array.from({length:keys},(_,i)=>[`key_${i}`,`text ${i}`]));
  const h=setup(t,async()=>jsonResponse(big));
  const real=h.window.Object.defineProperty;let defined=0;
  h.window.Object.defineProperty=function(...args){defined++;return real.apply(this,args);};
  t.after(()=>{h.window.Object.defineProperty=real;});
  assert.equal(Object.keys(await h.JE.loadTranslations()).length,keys);   // fetched
  assert.equal(Object.keys(await h.JE.loadTranslations()).length,keys);   // from the cache
  assert.ok(defined<keys/10,`${defined} Object.defineProperty calls while loading a ${keys}-key locale twice`);
});
