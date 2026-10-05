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
  await h.JE.loadTranslations();assert.equal(calls.length,1);
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
test('translation fallback stays on the local proxy and supports English fallback',async t=>{
  const calls=[];const h=setup(t,async url=>{calls.push(url);return url.endsWith('/en.json')?jsonResponse({ok:'OK'}):jsonResponse({},404);});
  h.window.localStorage.setItem('a-language','zz');assert.equal((await h.JE.loadTranslations()).ok,'OK');
  assert.ok(calls.every(url=>url.startsWith('http://jellyfin.test/')));assert.ok(calls.some(url=>url.includes('/cdn/locales/')));
});
test('unavailable translation sources resolve to an empty dictionary without poisoning cache',async t=>{
  const h=setup(t,async()=>{throw new Error('offline');});h.expectConsoleError(/Failed to load translations from any source/);assert.deepEqual(plain(await h.JE.loadTranslations()),{});
  assert.equal(h.window.localStorage.length,0);
});
