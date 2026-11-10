import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';
function setup(t,pluginConfig){const h=createHarness({JE:{pluginConfig,cdn:{flagSvg:code=>`/flags/${code}.svg`},t:key=>key==='audio_language_no_dialogue'?'No dialogue':key}});t.after(()=>h.close());h.load('core/media-language.js');return h.JE.core.mediaLanguage;}
test('audio flag resolution honors explicit regions, scripts, aliases and unknown languages',t=>{
 const m=setup(t);
 for(const [input,expected] of [['en','gb'],['en-US','us'],['en-UK','gb'],['pt','pt'],['pt-BR','br'],['pob','br'],['es-419','mx'],['en-419','gb'],['zh-Hant','tw'],['zh-Hans','cn'],['ja-Hans','jp'],['pt-XA','pt'],['und-US',null],['eo-FR',null],['ca-ES','es-ct'],['zxx-US','zxx'],[null,null],[{Code:'fra'},'fr'],[{name:'Japanese'},'jp'],['nb','no'],['nob','no'],['nn','no'],['nno','no'],['nb-NO','no'],['yue','hk'],['gsw','ch'],['ga','ie'],['gle','ie'],[{name:'Cantonese'},'hk']]) assert.equal(m.resolveFlag(input),expected,JSON.stringify(input));
});
test('merging regional variants resolves every tag to its base language flag',t=>{
 const m=setup(t,{LanguageTagsMergeRegions:true});
 for(const [input,expected] of [['en','gb'],['en-US','gb'],['en-UK','gb'],['pt-BR','pt'],['es-419','es'],['zh-Hant','cn'],['ca-ES','es-ct'],['zxx-US','zxx'],['und-US',null],[{name:'Japanese'},'jp']]) assert.equal(m.resolveFlag(input),expected,JSON.stringify(input));
});
test('audio preference matching canonicalizes ISO names while preserving region constraints',t=>{
 const m=setup(t);
 for(const [stream,wanted,options,expected] of [['deu','de',{},true],['ger','deu',{},true],['nno','nb',{},true],['tgl','fil',{},true],['en-UK','en-GB',{},true],['pt','pt-BR',{},true],['pt','pt-BR',{requireRegion:true},false],['pt-PT','pt-BR',{},false],['pt-BR','pt',{},true],['ja','en',{},false],['','en',{},false]])assert.equal(m.matchesLanguage(stream,wanted,options),expected,`${stream}/${wanted}`);
});
test('no-dialogue flags remain self-contained and localized; regular flags use CDN',t=>{
 const m=setup(t);assert.match(m.flagSrc('zxx'),/^data:image\/svg\+xml,/);assert.equal(m.flagSrc('br'),'/flags/br.svg');assert.equal(m.displayName('zxx'),'No dialogue');assert.equal(m.displayName('en'),'English');
});

test('scores and language names follow the user locale while matching keeps English names', t => {
 for (const [locale, text, expected] of [[undefined, '8.1', '8.1'], ['de', '8.1', '8,1'], ['de-CH', '8.1', '8.1'], ['fr-CA', '81%', '81%'], ['ar-SA', '8.1', '٨٫١'], ['fa', '81%', '۸۱%'], ['de', '—', '—']]) {
  const h = createHarness({ JE: { currentSettings: { displayLanguage: locale }, t: key => key } });
  t.after(() => h.close());
  h.load('core/media-language.js');
  assert.equal(h.JE.core.mediaLanguage.formatNumberText(text), expected, `${locale} ${text}`);
 }
 const h = createHarness({ JE: { currentSettings: { displayLanguage: 'fr' }, t: key => key } });
 t.after(() => h.close());
 h.load('core/media-language.js');
 assert.equal(h.JE.core.mediaLanguage.localName('ja'), 'japonais');
 assert.equal(h.JE.core.mediaLanguage.displayName('ja'), 'Japanese');
});

// Shared with TagCacheSubtitleLanguagesTests (Shared/Media/TrackRoles.cs).
const roles = JSON.parse(readFileSync(new URL('../../fixtures/track-roles.json', import.meta.url)));
test('commentary and audio-description titles are secondary audio in every listed script', t => {
 const m = setup(t);
 for (const row of roles.cases) assert.equal(m.isSecondaryAudio({ Title: row.title, DisplayTitle: row.displayTitle }), row.secondary, JSON.stringify(row));
});
test('a track whose titles Spoiler Guard stripped keeps the role the server read from them', t => {
 const m = setup(t);
 assert.equal(m.isSecondaryAudio({ Role: 'secondary' }), true);
 assert.equal(m.isSecondaryAudio({ Role: null, Title: null, DisplayTitle: null }), false);
 assert.equal(m.isSecondaryAudio({ Title: 'Main', DisplayTitle: 'Japanese - TrueHD 7.1' }), false);
});
