import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
async function setup(t,item,config={}){
 const idle=[],views=[];let disconnects=0,calls=0;
 const h=createHarness({url:'http://jellyfin.test/web/#!/details?id=one',html:'<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',globals:{requestIdleCallback:fn=>idle.push(fn)},JE:{pluginConfig:{LetterboxdEnabled:true,ShowLetterboxdLinkAsText:true,...config},cdn:{selfhst:path=>`/cdn/${path}`},helpers:{getItemCached:async()=>{calls++;return typeof item==='function'?item():item;},getExternalLinkIconSize:()=>25,createObserver:()=>({disconnect:()=>disconnects++}),onViewPage:fn=>views.push(fn)}}});
 t.after(()=>h.close());h.load('others/letterboxd-links.js');await h.JE.initializeLetterboxdLinksScript();
 return Object.assign(h,{idle,views,calls:()=>calls,disconnects:()=>disconnects});
}
test('Letterboxd disabled integration does not register observers or fetch',async t=>{const h=await setup(t,{}, {LetterboxdEnabled:false});assert.equal(h.idle.length,0);assert.equal(h.views.length,0);assert.equal(h.calls(),0);});
for(const [item,path] of [[{Type:'Movie',ProviderIds:{Imdb:'tt123'}},'imdb/tt123'],[{Type:'Person',Name:'Léa Seydoux'},'actor/lea-seydoux']])test(`Letterboxd ${item.Type} links use safe external attributes and correct identifiers`,async t=>{
 const h=await setup(t,item);await h.idle.shift()();const a=h.document.querySelector('.letterboxd-link');assert.equal(a.href,`https://letterboxd.com/${path}`);assert.equal(a.rel,'noopener noreferrer');assert.equal(a.target,'_blank');assert.equal(a.textContent,'Letterboxd');
 h.views[0]();await h.idle.shift()();assert.equal(h.document.querySelectorAll('.letterboxd-link').length,1);assert.equal(h.calls(),1);
});
test('Letterboxd icon mode and fresh same-item DOM rerender remain supported',async t=>{
 const h=await setup(t,{Type:'Movie',ProviderIds:{Imdb:'tt1'}},{ShowLetterboxdLinkAsText:false});await h.idle.shift()();assert.equal(h.document.querySelector('a').style.getPropertyValue('--je-icon-size'),'25px');
 h.document.querySelector('#itemDetailPage').innerHTML='<div class="itemExternalLinks"></div>';const added=new Promise(resolve=>{const observer=new h.window.MutationObserver(()=>{if(h.document.querySelector('.letterboxd-link')){observer.disconnect();resolve();}});observer.observe(h.document.body,{childList:true,subtree:true});});h.views[0]();h.idle.shift()();await added;assert.ok(h.document.querySelector('.letterboxd-link'));assert.equal(h.calls(),2);
});
for(const item of [{Type:'Series'},{Type:'Movie',ProviderIds:{}},{Type:'Person',Name:'!!!'}])test(`Letterboxd unsupported ${JSON.stringify(item)} is cached without markup`,async t=>{
 const h=await setup(t,item);await h.idle.shift()();h.views[0]();await h.idle.shift()();assert.equal(h.document.querySelector('a'),null);assert.equal(h.calls(),1);
});
test('Letterboxd response for previous route cannot decorate a reused current detail page',async t=>{
 const pending=deferred();const h=await setup(t,()=>pending.promise);const render=h.idle.shift()();
 h.window.history.replaceState({},'','#!/details?id=two');pending.resolve({Type:'Movie',ProviderIds:{Imdb:'tt-old'}});await render;
 assert.equal(h.document.querySelector('.letterboxd-link'),null);
});
