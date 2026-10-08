import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
function setup(t){const h=createHarness({JE:{cdn:{flagSvg:code=>`/flags/${code}.svg`},t:key=>key==='audio_language_no_dialogue'?'No dialogue':key}});t.after(()=>h.close());h.load('core/media-language.js');return h.JE.core.mediaLanguage;}
test('audio flag resolution honors explicit regions, scripts, aliases and unknown languages',t=>{
 const m=setup(t);
 for(const [input,expected] of [['en','gb'],['en-US','us'],['en-UK','gb'],['pt','pt'],['pt-BR','br'],['pob','br'],['es-419','mx'],['en-419','gb'],['zh-Hant','tw'],['zh-Hans','cn'],['ja-Hans','jp'],['pt-XA','pt'],['und-US',null],['eo-FR',null],['ca-ES','es-ct'],['zxx-US','zxx'],[null,null],[{Code:'fra'},'fr'],[{name:'Japanese'},'jp']]) assert.equal(m.resolveFlag(input),expected,JSON.stringify(input));
});
test('audio preference matching canonicalizes ISO names while preserving region constraints',t=>{
 const m=setup(t);
 for(const [stream,wanted,options,expected] of [['deu','de',{},true],['ger','deu',{},true],['nno','nb',{},true],['tgl','fil',{},true],['en-UK','en-GB',{},true],['pt','pt-BR',{},true],['pt','pt-BR',{requireRegion:true},false],['pt-PT','pt-BR',{},false],['pt-BR','pt',{},true],['ja','en',{},false],['','en',{},false]])assert.equal(m.matchesLanguage(stream,wanted,options),expected,`${stream}/${wanted}`);
});
test('no-dialogue flags remain self-contained and localized; regular flags use CDN',t=>{
 const m=setup(t);assert.match(m.flagSrc('zxx'),/^data:image\/svg\+xml,/);assert.equal(m.flagSrc('br'),'/flags/br.svg');assert.equal(m.displayName('zxx'),'No dialogue');assert.equal(m.displayName('en'),'English');
});
