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
  assert.match(calls[0],/JA|ja-JP/);assert.match(calls[0],/\/locales\/ja-JP.json$/);assert.match(calls[1],/\/locales\/en.json$/);
  await h.JE.loadTranslations();assert.equal(calls.length,2);
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
test('non-English locales fall back to English for missing and empty keys without corrupting either cache',async t=>{
  const en={a:'A',b:'B',c:'C'},de={a:'Ä',b:'',d:'D'};const h=setup(t,async url=>jsonResponse(url.endsWith('/en.json')?en:de));
  h.window.localStorage.setItem('a-language','de');
  assert.deepEqual(plain(await h.JE.loadTranslations()),{a:'Ä',b:'B',c:'C',d:'D'});
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('JE_translation_de_test-v1')),de);
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('JE_translation_en_test-v1')),en);
});
test('English users load only the English file',async t=>{
  const calls=[];const h=setup(t,async url=>{calls.push(url);return jsonResponse({ok:'OK'});});
  h.window.localStorage.setItem('a-language','en');assert.equal((await h.JE.loadTranslations()).ok,'OK');
  assert.equal(calls.length,1);assert.match(calls[0],/\/locales\/en.json$/);
});
test('English fallback failure returns the user locale unchanged',async t=>{
  const h=setup(t,async url=>{if(url.endsWith('/en.json'))throw new Error('offline');return jsonResponse({a:'Ä',b:''});});
  h.window.localStorage.setItem('a-language','de');assert.deepEqual(plain(await h.JE.loadTranslations()),{a:'Ä',b:''});
});
for(const [stored,requested,primary] of [['en-gb','en-GB','en-GB'],['de-AT','de-AT','de']])test(`regional ${stored} resolves ${primary} as primary with English underneath`,async t=>{
  // Mirrors the server locale route: a missing regional file is served from its base language.
  const files={en:{hi:'Hello',only_en:'English only'},'en-GB':{hi:'en-GB'},de:{hi:'de'}};const calls=[];
  const h=setup(t,async url=>{calls.push(url);const code=(url.match(/\/JellyfinEnhanced\/locales\/([^/]+)\.json$/)||[])[1];
    const body=code&&(files[code]||files[code.split('-')[0]]);return body?jsonResponse(body):jsonResponse({},404);});
  h.window.localStorage.setItem('a-language',stored);
  assert.deepEqual(plain(await h.JE.loadTranslations()),{hi:primary,only_en:'English only'});
  assert.match(calls[0],new RegExp(`/JellyfinEnhanced/locales/${requested}\\.json$`));assert.match(calls[1],/\/JellyfinEnhanced\/locales\/en\.json$/);assert.equal(calls.length,2);
});
