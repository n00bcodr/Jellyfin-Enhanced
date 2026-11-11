import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {createHarness,deferred} from '../helpers/harness.mjs';
const order=JSON.parse(readFileSync('Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json','utf8'));
const movie=id=>({Id:id,Name:id,Type:'Movie',ImageTags:{Primary:'p'},UserData:{Played:false,PlayCount:0,PlaybackPositionTicks:0}});
const row=n=>({ActivityType:'Watched',UserId:'alice',UserName:'Private Alice',Timestamp:n,Item:{Id:String(n),Name:`Private movie ${n}`}});
function setup(t,{jf,plugin}={}) {
 let epoch=0;const callbacks=new Map(),calls=[];
 const h=createHarness({html:'<main></main><aside id="replacement"></aside>',JE:{internals:{},pluginConfig:{CatchUpEnabled:true,ActivityFeedEnabled:true,ActivityFeedShowWatched:true},t:()=>'',toast:()=>{},session:{getEpoch:()=>epoch,isCurrent:e=>e===epoch,onUserChange:(k,f)=>callbacks.set(k,f)},core:{ui:{skeletonGridHtml:()=>''},api:{jf:async(p,o)=>{calls.push(p);return jf?jf(p,o):p==='/Users/Me'?{Policy:{IsAdministrator:false}}:{Items:[movie('a'),movie('b')]};},plugin:async(p,o)=>{calls.push(p);return plugin?plugin(p,o):{items:[row(1)]};}}}}});
 for(const p of order.filter(p=>p.startsWith('enhanced/catchup/')&&!p.endsWith('custom-tab.js')||p==='extras/activity-page.js'))h.load(p);
 t.after(()=>h.close());
 return {...h,calls,S:h.JE.internals.catchUp,main:h.document.querySelector('main'),change(){epoch++;callbacks.forEach(f=>f());},async render(){h.JE.catchUpPage.renderPage(h.document.querySelector('main'));await tick();}};
}
test('SPR1-01: late admin authorization cannot recreate a disposed connected panel',async t=>{
 const auth=deferred();const h=setup(t,{jf:p=>p==='/Users/Me'?auth.promise:Promise.resolve({Items:[movie('a')]}),plugin:async()=>({users:[],events:[]})});
 Object.defineProperty(h.window,'innerWidth',{value:1200});await h.render();h.S.deck.dispose();assert.equal(h.main.textContent,'');
 auth.resolve({Policy:{IsAdministrator:true}});await tick();
 assert.equal(h.main.querySelector('.je-catchup-activity'),null);assert.equal(h.calls.some(p=>p.startsWith('/catchup/events')),false);
});
test('SPR1-01b: connected deck disposal stops admin polling',async t=>{
 const timers=new Map();let id=0;const h=setup(t,{jf:async p=>p==='/Users/Me'?{Policy:{IsAdministrator:true}}:{Items:[movie('a')]},plugin:async()=>({users:[],events:[]})});
 h.window.setInterval=fn=>{timers.set(++id,fn);return id;};h.window.clearInterval=n=>timers.delete(n);Object.defineProperty(h.window,'innerWidth',{value:1200});await h.render();h.S.deck.dispose();await tick();
 const before=h.calls.length;for(const fn of timers.values())fn();await tick();assert.equal(h.calls.length,before);assert.equal(timers.size,0);
});
test('SPR1-02: retired Activity containers clear private rows before identity reset',async t=>{
 const h=setup(t);await h.JE.activityPage.renderForCustomTab(h.main);const replacement=h.document.querySelector('#replacement');await h.JE.activityPage.renderForCustomTab(replacement);h.change();await tick();
 assert.equal(h.main.textContent,'');assert.equal(replacement.textContent,'');
});
test('SPR1-03: successful empty mode replaces failure text from prior mode',async t=>{
 let bad=true;const h=setup(t,{jf:async p=>{if(p==='/Users/Me')return {Policy:{IsAdministrator:false}};if(bad)throw Error('old movie failure');return {Items:[]};}});await h.render();bad=false;
 h.document.querySelector('[data-mode="Series"]').click();await tick();assert.equal(h.main.querySelector('.je-catchup-empty').textContent,'Nothing more to show here.');
});
test('SPR1-04: newer refresh owns the limit after older load-more completes',async t=>{
 const pending=deferred();let loads=0;const h=setup(t,{plugin:async p=>{loads++;if(loads===2)return pending.promise;return {items:Array.from({length:p.includes('100')?100:50},(_,n)=>row(n))};}});
 await h.JE.activityPage.renderForCustomTab(h.main);h.document.querySelector('.je-activity-more').click();h.document.querySelector('.je-activity-refresh-btn').click();await tick();pending.resolve({items:Array.from({length:100},(_,n)=>row(n))});await tick();
 h.document.querySelector('.je-activity-more').click();await tick();assert.deepEqual(h.calls.filter(p=>p.startsWith('/activity')),['/activity','/activity?limit=100','/activity?limit=100','/activity?limit=150']);
});
test('bounded expansion reaches 200 and hides Load more; denial differs from malformed streams',async t=>{
 let denied=true;const h=setup(t,{plugin:async p=>{if(p.includes('sessions')){if(denied)throw Object.assign(Error('forbidden'),{status:403});return {}; }return {items:Array.from({length:Number(p.split('=')[1]||50)},(_,n)=>row(n))};}});
 Object.assign(h.JE.pluginConfig,{ActiveStreamsEnabled:true,ActivityFeedShowActiveStreams:true});await h.JE.activityPage.renderForCustomTab(h.main);assert.equal(h.document.querySelectorAll('.je-activity-section').length,1);
 for(let n=0;n<3;n++){h.document.querySelector('.je-activity-more').click();await tick();}assert.equal(h.document.querySelectorAll('.je-activity-row').length,200);assert.equal(h.document.querySelector('.je-activity-more').hidden,true);
 denied=false;await h.JE.activityPage.renderForCustomTab(h.main);assert.equal(h.document.querySelectorAll('.je-activity-section').length,2);assert.ok(h.document.querySelector('.je-activity-error'));
});
test('real emitted API facade reconciles uncertain watched and watchlist writes without undo or duplicate POST',async t=>{
 let played=false,liked=false;const writes=[],toasts=[];
 const h=createHarness({html:'<main></main>',globals:{AbortController,AbortSignal},JE:{internals:{},pluginConfig:{CatchUpEnabled:true},t:()=>'',toast:m=>toasts.push(m)},fetch:async(url,o)=>{
  if(o.method==='POST'){writes.push(url);if(url.includes('/PlayedItems/'))played=true;if(url.includes('/Rating'))liked=true;throw Error('connection lost after server commit');}
  const data=url.endsWith('/Users/Me')?{Policy:{IsAdministrator:false}}:{Items:[movie(played?'b':'a')]};return new Response(JSON.stringify(data),{status:200});
 }});t.after(()=>h.close());h.load('core/api-client.js');for(const p of order.filter(p=>p.startsWith('enhanced/catchup/')&&!p.endsWith('custom-tab.js')))h.load(p);
 h.JE.catchUpPage.renderPage(h.document.querySelector('main'));await tick();await tick();
 h.document.querySelector('.je-catchup-buttons .r').click();for(let i=0;i<4;i++)await tick();assert.equal(played,true);assert.equal(h.JE.internals.catchUp.state.undoStack.length,0);assert.equal(h.document.querySelector('.je-catchup-card:not(.back)').item.Id,'b');
 h.document.querySelector('.je-catchup-buttons .u').click();for(let i=0;i<4;i++)await tick();assert.equal(liked,true);assert.equal(h.JE.internals.catchUp.state.undoStack.length,0);assert.equal(writes.filter(p=>!p.endsWith('/catchup/event')).length,2);assert.equal(toasts.length,2);
});
test('SPR1-04 preserves pagination with actual API GET deduplication',async t=>{
 const pending=deferred();const requests=[];let first100=true;
 const h=createHarness({html:'<main></main>',globals:{AbortController,AbortSignal},JE:{pluginConfig:{ActivityFeedEnabled:true,ActivityFeedShowWatched:true},t:()=>'',core:{ui:{skeletonGridHtml:()=>''}}},fetch:async url=>{requests.push(url);if(url.includes('limit=100')&&first100){first100=false;await pending.promise;}return new Response(JSON.stringify({items:Array.from({length:Number(url.split('=')[1]||50)},(_,n)=>row(n))}));}});t.after(()=>h.close());h.load('core/api-client.js');h.load('extras/activity-page.js');await h.JE.activityPage.renderForCustomTab(h.document.querySelector('main'));
 h.document.querySelector('.je-activity-more').click();h.document.querySelector('.je-activity-refresh-btn').click();pending.resolve();for(let i=0;i<5;i++)await tick();h.document.querySelector('.je-activity-more').click();for(let i=0;i<5;i++)await tick();assert.equal(requests.filter(p=>p.includes('limit=100')).length,1);assert.equal(requests.some(p=>p.includes('limit=150')),true);
});

for(const path of ['#/home','#!/home','#/home.html']) test('ACT-ROUTE-001: Activity header alias preserves mounted feed at '+path,async t=>{
 const h=setup(t);h.window.history.replaceState(null,'',path+'?tab=2');
 await h.JE.activityPage.renderForCustomTab(h.main);
 const before=h.main.querySelector('.je-activity-feed'), refresh=h.main.querySelector('.je-activity-refresh-btn');
 h.window.history.replaceState(null,'',path+'?tab=2&jeTab=activity');
 h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));await tick();
 assert.equal(h.main.querySelector('.je-activity-feed'),before);assert.equal(refresh.isConnected,true);
 assert.match(h.main.textContent,/Private movie/);
 const reads=h.calls.length;refresh.click();await tick();assert.equal(h.calls.length,reads+1);
 h.change();assert.equal(h.main.textContent,'','account reset still clears private feed');
});
for(const route of ['#/home?tab=3&jeTab=activity','#/home?tab=2&jeTab=calendar','#/details?id=7']) test('ACT-ROUTE-001: leaving Activity clears retained private DOM for '+route,async t=>{
 const h=setup(t);h.window.history.replaceState(null,'','#/home?tab=2&jeTab=activity');
 await h.JE.activityPage.renderForCustomTab(h.main);
 h.window.history.replaceState(null,'',route);h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));await tick();
 assert.equal(h.main.textContent,'');
});
test('ACT-ROUTE-001: pending feed response remains current across the header alias',async t=>{
 const pending=deferred(),h=setup(t,{plugin:()=>pending.promise});
 h.window.history.replaceState(null,'','#/home?tab=2');
 const rendering=h.JE.activityPage.renderForCustomTab(h.main);
 h.window.history.replaceState(null,'','#/home?tab=2&jeTab=activity');h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
 pending.resolve({items:[row(1)]});await rendering;
 assert.match(h.main.textContent,/Private movie/);
});

for(const tab of ['%32','02']) test('ACT-ROUTE-001: numeric bookmark alias tab='+tab+' survives canonical header URL',async t=>{
 const h=setup(t);h.window.history.replaceState(null,'','#/home?tab='+tab);
 await h.JE.activityPage.renderForCustomTab(h.main);
 const feed=h.main.querySelector('.je-activity-feed');
 h.window.history.replaceState(null,'','#/home?jeTab=activity&tab=2');
 h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));await tick();
 assert.equal(h.main.querySelector('.je-activity-feed'),feed);assert.match(h.main.textContent,/Private movie/);
});
