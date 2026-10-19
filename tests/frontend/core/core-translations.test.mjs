import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse, plain } from '../helpers/harness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
function setup(t, fetch, apiClient={}, html='') {
  const h=createHarness({html,JE:{pluginVersion:'test-v1',cdn:{url:(source,path)=>`http://jellyfin.test/cdn/${source}/${path}`}},apiClient:{getCurrentUser:()=>({Id:'a'}),...apiClient},fetch});
  t.after(()=>h.close());h.load('enhanced/translations.js');return h;
}
test('translations normalize per-user language and cache the bundled Unicode response',async t=>{
  const calls=[]; const h=setup(t,async url=>{calls.push(url);return jsonResponse({greeting:'こんにちは {name}'});});
  h.window.localStorage.setItem('a-language','JA-jp');
  assert.deepEqual(plain(await h.JE.loadTranslations()),{greeting:'こんにちは {name}'});
  assert.match(calls[0],/JA|ja-JP/);assert.match(calls[0],/\/locales\/ja-JP.json$/);
  // The second request is the bundled English base for keys ja-JP lacks; both are cached.
  assert.equal(calls.length,2);assert.match(calls[1],/\/JellyfinEnhanced\/locales\/en.json$/);
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

// Per-key English fallback: a locale missing newer keys falls back to this build's bundled en.json.
const BUNDLED_EN={greeting:'Hello',colour:'Color',listPlaceholders_add_title:'Add placeholder'};
const UPSTREAM_EN={greeting:'Hello (upstream)',colour:'Color'};
const bundled=code=>`http://jellyfin.test/JellyfinEnhanced/locales/${code}.json`;
const remote=code=>`http://jellyfin.test/cdn/locales/${code}.json`;
/** Builds a fetch fixture from a URL → response-factory map; unknown URLs are 404s. */
function routes(map,calls){return async url=>{calls.push(url);const handler=map[url];if(!handler)return jsonResponse({},404);return handler();};}
test('en-AU without a locale file uses bundled English, including keys upstream English lacks',async t=>{
  const calls=[];const h=setup(t,routes({[remote('en')]:()=>jsonResponse(UPSTREAM_EN),[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls));
  h.window.localStorage.setItem('a-language','en-AU');
  const strings=plain(await h.JE.loadTranslations());
  assert.equal(strings.listPlaceholders_add_title,'Add placeholder');
  assert.equal(strings.colour,'Color');
  assert.deepEqual(calls,[bundled('en-AU'),remote('en-AU'),remote('en'),bundled('en')]);
  // The bundled-English cache entry holds this build's en.json, never upstream's remote copy.
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('JE_translation_en_test-v1')),BUNDLED_EN);
  // Both the resolved locale and the English base are cached for this version: no requests next time.
  assert.deepEqual(plain(await h.JE.loadTranslations()),strings);assert.equal(calls.length,4);
});
test('en-GB missing a key gets English for that key and en-GB for the rest',async t=>{
  const calls=[];const h=setup(t,routes({[bundled('en-GB')]:()=>jsonResponse({greeting:'Hiya',colour:'Colour'}),[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls));
  h.window.localStorage.setItem('a-language','en-gb');
  assert.deepEqual(plain(await h.JE.loadTranslations()),{greeting:'Hiya',colour:'Colour',listPlaceholders_add_title:'Add placeholder'});
  assert.deepEqual(calls,[bundled('en-GB'),bundled('en')]);
});
test('English users make exactly one request and are never merged',async t=>{
  for(const stored of [null,'en']){
    const calls=[];const h=setup(t,routes({[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls));
    if(stored)h.window.localStorage.setItem('a-language',stored);
    assert.deepEqual(plain(await h.JE.loadTranslations()),BUNDLED_EN);
    assert.deepEqual(calls,[bundled('en')]);
    await h.JE.loadTranslations();assert.equal(calls.length,1);
  }
});
test('a failure to load bundled English keeps the resolved locale',async t=>{
  for(const failEnglish of [()=>{throw new Error('offline');},()=>jsonResponse({},500)]){
    const calls=[];const h=setup(t,routes({[bundled('fr')]:()=>jsonResponse({yes:'Oui'}),[bundled('en')]:failEnglish},calls));
    h.window.localStorage.setItem('a-language','fr');
    assert.deepEqual(plain(await h.JE.loadTranslations()),{yes:'Oui'});
    assert.equal(h.window.localStorage.getItem('JE_translation_en_test-v1'),null);
  }
});
test('upstream English fetched for an English user is not cached as the bundled English base',async t=>{
  let bundledUp=false;const calls=[];
  const h=setup(t,routes({[bundled('en')]:()=>bundledUp?jsonResponse(BUNDLED_EN):jsonResponse({},503),[remote('en')]:()=>jsonResponse(UPSTREAM_EN)},calls));
  assert.deepEqual(plain(await h.JE.loadTranslations()),UPSTREAM_EN);
  assert.equal(h.window.localStorage.getItem('JE_translation_en_test-v1'),null);
  bundledUp=true;
  assert.deepEqual(plain(await h.JE.loadTranslations()),BUNDLED_EN);
});

// The cache is keyed by the build identity (script tag `version` = `{version}-{dllTimestamp}`), so entries
// written by an earlier build of the same plugin version (e.g. the old loader's upstream `en`) are never reused.
const BUILD_TAG=build=>`<script plugin="Jellyfin Enhanced" version="test-v1-${build}"></script>`;
test('a same-version legacy en entry holding upstream English is not trusted as the bundled base',async t=>{
  for(const lang of ['ja-JP','en-GB']){
    const calls=[];const h=setup(t,routes({[remote('en')]:()=>jsonResponse(UPSTREAM_EN),[bundled('en')]:()=>jsonResponse(BUNDLED_EN),[bundled('en-GB')]:()=>jsonResponse({greeting:'Hiya'})},calls),{},BUILD_TAG('b2'));
    const store=h.window.localStorage;
    // Written by the previous loader at the same plugin version (bare-version key), plus an earlier build's entry.
    store.setItem('JE_translation_en_test-v1',JSON.stringify(UPSTREAM_EN));store.setItem('JE_translation_ts_en_test-v1',String(Date.now()));
    store.setItem('JE_translation_en_test-v1-b1',JSON.stringify(UPSTREAM_EN));store.setItem('JE_translation_ts_en_test-v1-b1',String(Date.now()));
    store.setItem('a-language',lang);
    const strings=plain(await h.JE.loadTranslations());
    assert.equal(strings.listPlaceholders_add_title,'Add placeholder',lang);
    assert.ok(calls.includes(bundled('en')),`${lang}: bundled en.json is fetched`);
    for(const legacy of ['test-v1','test-v1-b1']){assert.equal(store.getItem(`JE_translation_en_${legacy}`),null);assert.equal(store.getItem(`JE_translation_ts_en_${legacy}`),null);}
    assert.deepEqual(JSON.parse(store.getItem('JE_translation_en_test-v1-b2')),BUNDLED_EN);
    const before=calls.length;assert.deepEqual(plain(await h.JE.loadTranslations()),strings);assert.equal(calls.length,before);
  }
});
test('a same-version legacy en entry is not served to English users either',async t=>{
  const calls=[];const h=setup(t,routes({[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls),{},BUILD_TAG('b2'));
  h.window.localStorage.setItem('JE_translation_en_test-v1',JSON.stringify(UPSTREAM_EN));h.window.localStorage.setItem('JE_translation_ts_en_test-v1',String(Date.now()));
  assert.deepEqual(plain(await h.JE.loadTranslations()),BUNDLED_EN);assert.deepEqual(calls,[bundled('en')]);
});
test('the translation cache key is the script tag build identity, without a /version request',async t=>{
  const calls=[];const h=createHarness({html:BUILD_TAG('b9'),JE:{cdn:{url:(s,p)=>`http://jellyfin.test/cdn/${s}/${p}`}},apiClient:{getCurrentUser:()=>({Id:'a'})},fetch:routes({[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls)});
  t.after(()=>h.close());h.load('enhanced/translations.js');
  await h.JE.loadTranslations();
  assert.deepEqual(calls,[bundled('en')]);
  assert.ok(h.window.localStorage.getItem('JE_translation_en_test-v1-b9'));
});
// The remote-English fallback is cached for the requested code only when the bundled route said the locale is missing.
test('a transient bundled-locale failure does not pin the locale to remote English',async t=>{
  for(const failure of [()=>jsonResponse({},503),()=>{throw new Error('network blip');}]){
    let frUp=false;const calls=[];
    const h=setup(t,routes({[bundled('fr')]:()=>frUp?jsonResponse({yes:'Oui'}):failure(),[remote('en')]:()=>jsonResponse(UPSTREAM_EN),[bundled('en')]:()=>jsonResponse(BUNDLED_EN)},calls));
    h.window.localStorage.setItem('a-language','fr');
    const first=plain(await h.JE.loadTranslations());
    assert.equal(first.greeting,'Hello (upstream)');assert.equal(first.listPlaceholders_add_title,'Add placeholder');
    assert.equal(h.window.localStorage.getItem('JE_translation_fr_test-v1'),null);
    frUp=true;
    const second=plain(await h.JE.loadTranslations());
    assert.equal(second.yes,'Oui');assert.equal(second.listPlaceholders_add_title,'Add placeholder');
    assert.deepEqual(JSON.parse(h.window.localStorage.getItem('JE_translation_fr_test-v1')),{yes:'Oui'});
  }
});

// A literal "undefined" or "null" (or an empty or malformed value) is never a language: JE falls back to the
// language Jellyfin resolved for the page (the user's or the browser's), then English.
for (const junk of ['undefined', 'null', 'NULL', '', '   ', 'en_US!', 'nan']) test(`a stored language of ${JSON.stringify(junk)} falls back to Jellyfin's language`, async t => {
  const calls = []; const h = setup(t, async url => { calls.push(url); return jsonResponse({ yes: 'Oui' }); });
  h.window.localStorage.setItem('a-language', junk);
  h.document.documentElement.lang = 'fr';
  await h.JE.loadTranslations();
  assert.match(calls[0], /\/fr.json$/);
  assert.ok(calls.every(url => !/undefined|null|nan/i.test(url)), calls.join(' '));
});
test('a junk page language falls back to English', async t => {
  const calls = []; const h = setup(t, async url => { calls.push(url); return jsonResponse({ ok: 'OK' }); });
  h.window.localStorage.setItem('a-language', 'undefined');
  h.document.documentElement.lang = 'undefined';
  await h.JE.loadTranslations();
  assert.deepEqual(calls, ['http://jellyfin.test/JellyfinEnhanced/locales/en.json']);
});
test('JE.languageCode accepts language tags only', t => {
  const h = setup(t, async () => jsonResponse({}));
  const code = h.JE.languageCode;
  assert.equal(code('en-au'), 'en-AU');
  assert.equal(code(' PT-br '), 'pt-BR');
  assert.equal(code('zh-Hant-TW'), 'zh-Hant-TW');
  assert.equal(code('fr'), 'fr');
  for (const junk of ['undefined', 'null', 'Undefined', 'nan', 'true', '', ' ', 'e', 'en_US', 'en-', '../en', 'en/../../x', null, undefined, 42, {}]) assert.equal(code(junk), '', String(junk));
});

// Dashcrash §7 (integration rebuild): what JE WRITES (the shared `${userId}-language` key, its own displayLanguage) is
// a valid language tag that is also supported: a language JE ships (exactly, or its base language) or one the browser
// has locale data for. Anything else is '' (Auto). Empty stays Auto.
test('JE.supportedLanguageCode accepts only supported language tags', t => {
  const h = setup(t, async () => jsonResponse({}));
  const write = h.JE.supportedLanguageCode;
  assert.equal(typeof write, 'function');
  h.JE.pluginConfig = { SupportedLanguages: ['en', 'en-GB', 'pr', 'gsw', 'pt-BR'] };
  assert.equal(write('en-au'), 'en-AU');   // a region of a shipped language
  assert.equal(write('PT-br'), 'pt-BR');
  assert.equal(write('pr'), 'pr');         // JE's own locale, unknown to Intl
  assert.equal(write('ja'), 'ja');         // not shipped, but the browser knows it (a newer remote locale)
  for (const value of [undefined, null, '', '  ', 'undefined', 'null', 'NULL', 'nan', 'en_US', 'en-', 'e', '../en', 42, {}]) assert.equal(write(value), '', String(value));
  for (const unsupported of ['xx', 'zz-ZZ', 'qaa']) assert.equal(write(unsupported), '', unsupported);
  // Without the server's list only the browser's locale data counts.
  h.JE.pluginConfig = {};
  assert.equal(write('pr'), '');
  assert.equal(write('en-AU'), 'en-AU');
});

// Stage 1 fix round 2 (RBS1-BEH-R2-2): the complete tag's syntax first (language, then optional script, region and
// variants), then the exact or base-language match. One table with the server (tests/backend/Api/language-tags.json,
// also read by ApiDisplayLanguageTests), so the client and server rules are the same.
const LANGUAGE_TABLE = JSON.parse(readFileSync(new URL('../../backend/Api/language-tags.json', import.meta.url), 'utf8'));
const SHIPPED = readdirSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/', import.meta.url)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
test('JE.languageCode follows the shared language-tag table', t => {
  const h = setup(t, async () => jsonResponse({}));
  const wrong = LANGUAGE_TABLE.syntax.filter(([raw, expected]) => h.JE.languageCode(raw) !== expected).map(([raw, expected]) => `${raw} → ${h.JE.languageCode(raw)} (expected ${expected})`);
  assert.deepEqual(wrong, []);
});
test('JE.supportedLanguageCode follows the shared write table with the shipped languages', t => {
  const h = setup(t, async () => jsonResponse({}));
  h.JE.pluginConfig = { SupportedLanguages: SHIPPED };
  const wrong = LANGUAGE_TABLE.write.filter(([raw, expected]) => h.JE.supportedLanguageCode(raw) !== expected).map(([raw, expected]) => `${raw} → ${h.JE.supportedLanguageCode(raw)} (expected ${expected})`);
  assert.deepEqual(wrong, []);
});
