import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../helpers/harness.mjs';
function setup(t,enabled=true){
 let subscriptions=0,releases=0;const handlers=[];const h=createHarness({JE:{session:{onUserChange:(key,fn)=>handlers.push(fn)},currentSettings:{pauseScreenEnabled:enabled},t:key=>key,helpers:{onBodyMutation:()=>{subscriptions++;return {unsubscribe:()=>releases++};}}}});
 h.window.localStorage.setItem('jellyfin_credentials',JSON.stringify({Servers:[{Id:'wrong',UserId:'other',AccessToken:'wrong'},{Id:'server-a',UserId:'user-a',AccessToken:'test'}]}));
 h.load('enhanced/player/pausescreen.js');t.after(()=>h.close());return {...h,switchUser:()=>handlers.forEach(fn=>fn()),counts:()=>({subscriptions,releases})};
}
test('disabled pause screen creates no DOM or observers',t=>{const h=setup(t,false);h.JE.initializePauseScreen();assert.equal(h.JE.pauseScreenInstance,undefined);assert.deepEqual(h.counts(),{subscriptions:0,releases:0});});
test('pause screen uses active server credentials and has one instance after repeated initialization',t=>{
 const h=setup(t);h.JE.initializePauseScreen();const first=h.JE.pauseScreenInstance;assert.equal(first.userId,'user-a');assert.equal(first.token,'test');
 h.JE.initializePauseScreen();assert.equal(h.document.querySelectorAll('#pause-screen-overlay').length,1);assert.deepEqual(h.counts(),{subscriptions:1,releases:0});
 h.JE.pauseScreenInstance.destroy();assert.equal(h.document.querySelector('#pause-screen-overlay'),null);assert.deepEqual(h.counts(),{subscriptions:1,releases:1});
});
test('pause overlay restores focus and destroy removes keyboard capture',t=>{
 const h=setup(t);h.document.body.innerHTML='<button id="prior">Prior</button>';h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;const prior=h.document.getElementById('prior');prior.focus();p.showOverlay();
 assert.equal(p.overlay.getAttribute('aria-hidden'),'false');assert.equal(h.document.activeElement,p.overlayContent);p.hideOverlay();assert.equal(h.document.activeElement,prior);
 p.showOverlay();p.destroy();p.overlay.setAttribute('aria-hidden','false');const event=new h.window.KeyboardEvent('keydown',{code:'Space',bubbles:true,cancelable:true});h.document.dispatchEvent(event);assert.equal(event.defaultPrevented,false);
});
test('pause metadata renders untrusted rating and overview as text',async t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;p.firstAvailableBlobURL=async()=>null;
 const malicious='<img src=x onerror="alert(1)">';await p.displayItemInfo({OfficialRating:malicious,Overview:malicious,RunTimeTicks:54000000000},'http://local','item');
 assert.equal(p.overlayPlot.textContent,malicious);assert.equal(p.overlayDetails.querySelector('img'),null);assert.match(p.overlayDetails.textContent,/1h 30m/);assert.ok(p.overlayDetails.textContent.includes(malicious));
});
test('pause metadata failure shows translated fallback and clears previous text',async t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;p.overlayPlot.textContent='old';p.fetchWithRetry=async()=>{throw new Error('offline');};h.expectConsoleError(/Error fetching item info/);await p.fetchItemInfo('item');assert.equal(p.overlayPlot.textContent,'pausescreen_fetch_error');
});

test('pause initialization after external overlay removal releases original observers',t=>{
 const h=setup(t);h.JE.initializePauseScreen();h.JE.pauseScreenInstance.overlay.remove();h.JE.initializePauseScreen();assert.deepEqual(h.counts(),{subscriptions:2,releases:1});
});
test('pause metadata arriving after user switch cannot restore old-user data',async t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;const pending=deferred();p.fetchWithRetry=()=>pending.promise;p.firstAvailableBlobURL=async()=>null;
 h.window.ApiClient.serverAddress=()=> 'http://local';p.showOverlay();const request=p.fetchItemInfo('secret');h.switchUser();pending.resolve({Overview:'old-user secret'});await request;
 assert.equal(p.overlay.getAttribute('aria-hidden'),'true');assert.equal(p.overlayPlot.textContent,'');assert.equal(p.itemCache.size,0);
});
