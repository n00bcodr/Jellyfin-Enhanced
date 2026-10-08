import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createHarness} from '../helpers/harness.mjs';
async function setup(t,{item={Type:'Movie',ProviderIds:{Tmdb:7}},data={Found:true,Wins:1,Nominations:1,Awards:[{Name:'Academy Award for <script>bad</script>',Result:'Won',Year:2025,Recipients:['<img src=x>']},{Name:'Nomination',Result:'Nominated',Year:2024}]},enabled=true,api,parent={Type:'Series',ProviderIds:{Tmdb:9}},html='<div class="tagline"></div>'}={}){
  let hook;const calls=[];
  const h=createHarness({html:`<div id="itemDetailPage">${html}</div>`,url:'http://jellyfin.test/web/index.html#!/details?id=item',apiClient:{getItem:async(_user,id)=>id==='series'?parent:item},JE:{pluginConfig:{ShowAwards:enabled},escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),cdn:{url:(_source,path)=>`https://cdn.test/${path}`},t:(key,args)=>args?`${key} ${args.count??args.work??''}`:key,helpers:{onViewPage:fn=>{hook=fn;return()=>{};}},core:{api:{plugin:async path=>{calls.push(path);return api?api():data;}}}}});
  t.after(()=>h.close());h.window.setTimeout=fn=>{queueMicrotask(fn);return 1;};h.load('awards/awards.js');h.JE.initializeAwardsScript();
  const navigate=async()=>{if(hook){await hook(null,h.document.querySelector('#itemDetailPage'),h.window.location.hash);await nextTurn();}};
  await navigate();return {...h,calls,navigate};
}
test('awards normalize nested server fields, escape upstream strings and replace rather than duplicate banners',async t=>{
  const h=await setup(t);const banner=h.document.querySelector('.je-awards-section');assert.ok(banner);assert.match(banner.textContent,/Academy Award for <script>bad<\/script>/);assert.equal(banner.querySelector('script'),null);assert.equal(banner.querySelector('[src="x"]'),null);
  await h.navigate();assert.equal(h.document.querySelectorAll('.je-awards-section').length,1);assert.equal(h.document.querySelectorAll('#je-awards-styles').length,1);
});
for(const [Type,expected,item] of [['Person','person',{ProviderIds:{Tmdb:8}}],['Episode','tv',{SeriesId:'series'}],['Series','tv',{ProviderIds:{Tmdb:9}}]]){
  test(`awards ${Type} uses correct provider namespace`,async t=>{const h=await setup(t,{item:{Type,...item}});assert.match(h.calls[0],new RegExp(`/awards/${expected}/`));assert.ok(h.document.querySelector('.je-awards-section'));});
}
test('awards native similar-items landmark supports layouts without plugin anchors',async t=>{
  const h=await setup(t,{html:'<div id="similarCollapsible"></div>'});assert.equal(h.document.querySelector('#similarCollapsible').previousElementSibling.className,'detailSection je-awards-section');
});
for(const [name,options] of [['disabled',{enabled:false}],['not found',{data:{Found:false}}],['no awards',{data:{Found:true,Wins:0,Nominations:0}}],['upstream error',{api:async()=>{throw Error('offline');}}],['unsupported item',{item:{Type:'Audio',ProviderIds:{Tmdb:1}}}]]){
  test(`awards ${name} leaves page usable without banner`,async t=>{const h=await setup(t,options);assert.equal(h.document.querySelector('.je-awards-section'),null);assert.ok(h.document.querySelector('.tagline'));});
}
