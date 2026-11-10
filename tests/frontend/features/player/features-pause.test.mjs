import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHarness,deferred} from '../../helpers/harness.mjs';
function setup(t,enabled=true){
 let subscriptions=0,releases=0;const handlers=[];const h=createHarness({JE:{session:{onUserChange:(key,fn)=>handlers.push(fn)},currentSettings:{pauseScreenEnabled:enabled,pauseScreenDelaySeconds:0},t:key=>key,helpers:{onBodyMutation:()=>{subscriptions++;return {unsubscribe:()=>releases++};}}}});
 h.window.localStorage.setItem('jellyfin_credentials',JSON.stringify({Servers:[{Id:'wrong',UserId:'other',AccessToken:'wrong'},{Id:'server-a',UserId:'user-a',AccessToken:'test'}]}));
 h.load('core/ui-kit.js');h.load('enhanced/player/now-playing.js');h.load('enhanced/player/pausescreen.js');t.after(()=>h.close());return {...h,switchUser:()=>handlers.forEach(fn=>fn()),counts:()=>({subscriptions,releases})};
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
test('pause overlay keeps remote keys on TV layout and Back closes only the overlay',t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;h.document.documentElement.classList.add('layout-tv');
 let reached=0;h.document.addEventListener('keydown',()=>reached++);
 const press=(init)=>{const e=new h.window.KeyboardEvent('keydown',{bubbles:true,cancelable:true,...init});h.document.dispatchEvent(e);return e;};
 p.showOverlay();
 for(const key of ['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'])assert.equal(press({key}).defaultPrevented,true,key);
 assert.equal(reached,0);
 press({key:'ArrowRight'});assert.equal(h.document.activeElement,p.closeButton);
 press({key:'ArrowLeft'});assert.equal(h.document.activeElement,p.overlayContent);
 press({key:'ArrowUp'});press({key:'Enter',code:'Enter'});assert.equal(p.overlay.getAttribute('aria-hidden'),'true');assert.equal(p._dismissedThisPause,true);
 p._dismissedThisPause=false;p.showOverlay();press({key:'Escape'});assert.equal(p.overlay.getAttribute('aria-hidden'),'true');assert.equal(p._dismissedThisPause,true);
 p._dismissedThisPause=false;p.showOverlay();press({key:'Unidentified',keyCode:10009});assert.equal(p.overlay.getAttribute('aria-hidden'),'true');
 assert.equal(reached,0);
});
test('pause overlay leaves arrow keys alone outside the TV layout',t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;p.showOverlay();
 const e=new h.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});h.document.dispatchEvent(e);
 assert.equal(e.defaultPrevented,false);assert.equal(p.overlay.getAttribute('aria-hidden'),'false');
});

const A='a'.repeat(32),B='b'.repeat(32);
const src=id=>`http://jellyfin.test/Videos/${id}/stream.mp4?static=true`;
const flush=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
function playing(t,{current=src(A),sessions=null}={}){
 const h=setup(t);
 h.window.ApiClient.serverAddress=()=>'http://jellyfin.test';h.window.ApiClient.deviceId=()=>'device-1';
 h.window.ApiClient.ajax=async()=>sessions;
 h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;
 p.firstAvailableBlobURL=async()=>null;p.fetchWithRetry=async url=>({Overview:'overview '+(url.includes(A)?'A':url.includes(B)?'B':'?')});
 h.document.body.innerHTML=`<div class="videoOsdBottom"><button class="btnUserRating" data-id="${A}"></button></div><div class="videoPlayerContainer"><video></video></div>`;
 const video=h.document.querySelector('video');let currentSrc=current,paused=false;
 Object.defineProperty(video,'currentSrc',{get:()=>currentSrc});Object.defineProperty(video,'paused',{get:()=>paused});Object.defineProperty(video,'duration',{get:()=>2700});
 return {h,p,video,setSource:value=>{currentSrc=value;},pause:async()=>{paused=true;video.dispatchEvent(new h.window.Event('pause'));await flush();},overlay:()=>p.overlay.getAttribute('aria-hidden'),plot:()=>p.overlayPlot.textContent};
}
test('a source change on the same video element drops the previous item before the next pause',async t=>{
 const x=playing(t);x.p.checkForVideoChanges();await flush();
 assert.equal(x.plot(),'overview A');
 x.setSource(src(B));x.video.dispatchEvent(new x.h.window.Event('loadstart'));
 assert.equal(x.p.currentItemId,null);assert.equal(x.plot(),'');
 await x.pause();
 assert.equal(x.p.currentItemId,B);assert.equal(x.plot(),'overview B');assert.equal(x.overlay(),'false');
});
test('the OSD button holding the previous item never decides what the overlay describes',async t=>{
 const x=playing(t,{current:'blob:http://jellyfin.test/1'});x.p.checkForVideoChanges();await flush();
 assert.equal(x.p.currentItemId,null);
 await x.pause();
 assert.equal(x.p.currentItemId,null);assert.equal(x.plot(),'');assert.equal(x.overlay(),'true');
});
test('a blob stream is identified by the one matching server session with the same runtime',async t=>{
 const session=(id,ticks)=>[{DeviceId:'device-1',NowPlayingItem:{Id:id,RunTimeTicks:ticks}},{DeviceId:'other',NowPlayingItem:{Id:A,RunTimeTicks:1}}];
 const ok=playing(t,{current:'blob:http://jellyfin.test/1',sessions:session(B,27000000000)});ok.p.checkForVideoChanges();await ok.pause();
 assert.equal(ok.p.currentItemId,B);assert.equal(ok.plot(),'overview B');assert.equal(ok.overlay(),'false');
 const mismatch=playing(t,{current:'blob:http://jellyfin.test/1',sessions:session(B,36000000000)});mismatch.p.checkForVideoChanges();await mismatch.pause();
 assert.equal(mismatch.p.currentItemId,null);assert.equal(mismatch.overlay(),'true');
 const ambiguous=playing(t,{current:'blob:http://jellyfin.test/1',sessions:[...session(B,27000000000),...session(A,27000000000)]});ambiguous.p.checkForVideoChanges();await ambiguous.pause();
 assert.equal(ambiguous.p.currentItemId,null);assert.equal(ambiguous.overlay(),'true');
});
test('a late response for the previous item cannot fill the overlay after a source change',async t=>{
 const x=playing(t);const gate=deferred();
 x.p.fetchWithRetry=async url=>{if(url.includes(A)){await gate.promise;return {Overview:'overview A'};}return {Overview:'overview B'};};
 x.p.checkForVideoChanges();await flush();
 x.setSource(src(B));x.video.dispatchEvent(new x.h.window.Event('loadstart'));await x.pause();
 gate.resolve();await flush();
 assert.equal(x.p.currentItemId,B);assert.equal(x.plot(),'overview B');
});
// Upstream 19cfe99a (#1036): ids and the image tag are encoded in the pause screen's image URLs.
test('pause screen image URLs encode the item ids and the image tag, and leave ordinary ids as they are',t=>{
 const h=setup(t);h.JE.initializePauseScreen();const p=h.JE.pauseScreenInstance;
 const item={ImageTags:{Logo:'tag&x=1'},ParentId:'par/ent?x',SeriesId:'ser#ies'};
 assert.deepEqual([...p.getLogoUrls(item,'http://local','it/em')],['http://local/Items/it%2Fem/Images/Logo?tag=tag%26x%3D1','http://local/Items/par%2Fent%3Fx/Images/Logo','http://local/Items/ser%23ies/Images/Logo']);
 assert.deepEqual([...p.getDiscUrls(item,'http://local','it/em')],['http://local/Items/it%2Fem/Images/Disc','http://local/Items/par%2Fent%3Fx/Images/Disc','http://local/Items/ser%23ies/Images/Disc']);
 assert.deepEqual([...p.getBackdropUrls(item,'http://local','it/em')],['http://local/Items/it%2Fem/Images/Backdrop','http://local/Items/par%2Fent%3Fx/Images/Backdrop','http://local/Items/ser%23ies/Images/Backdrop']);
 const plain={ImageTags:{Logo:'0123abcd'},SeriesId:'f137a2dd21bbc1b99aa5c0f6bf02a805'};
 assert.deepEqual([...p.getLogoUrls(plain,'http://local','0ff8461bed0a2658ec63487586efdbd3')],['http://local/Items/0ff8461bed0a2658ec63487586efdbd3/Images/Logo?tag=0123abcd','http://local/Items/f137a2dd21bbc1b99aa5c0f6bf02a805/Images/Logo']);
});

// jellyfin-web starts a playback in this order: the <video> is created while the details route is still current,
// then the route changes to the player. That navigation resets the player lifetimes (features/player/lifetime.ts).
// `requests` is what reaches the network: the item, then one HEAD probe per candidate image.
function starting(t){
 const x=playing(t);const requests=[];const P='c'.repeat(32),S='d'.repeat(32);
 x.h.JE.isVideoPage=()=>x.h.window.location.hash.startsWith('#/video');
 delete x.p.fetchWithRetry;delete x.p.firstAvailableBlobURL;
 x.h.window.fetch=async(url,options={})=>{
  const path=new URL(url).pathname;requests.push(`${options.method||'GET'} ${path}`);
  if(options.method==='HEAD')return new Response(null,{status:404});
  return new Response(JSON.stringify({Id:A,Overview:'overview A',ParentId:P,SeriesId:S}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const navigate=async hash=>{x.h.window.location.hash=hash;await flush();};
 return {...x,requests,navigate,item:`GET /Items/${A}`,probes:()=>requests.filter(r=>r.startsWith('HEAD '))};
}
test('starting a playback requests the item and probes each image once, although the route changes after the video appears',async t=>{
 const x=starting(t);
 x.p.checkForVideoChanges();await flush();
 assert.deepEqual(x.requests.filter(r=>r===x.item),[x.item]);
 const probed=x.probes();
 assert.equal(probed.length,8,'Logo of the parent and series; Disc and Backdrop of the item, parent and series');
 assert.equal(new Set(probed).size,8);
 await x.navigate('#/video');
 x.p.checkForVideoChanges();await flush();
 assert.equal(x.p.currentVideo,x.video);assert.equal(x.p.readyItemId,A);
 assert.deepEqual(x.requests.filter(r=>r===x.item),[x.item],'the item is requested once per playback start');
 assert.deepEqual(x.probes(),probed,'no image is probed a second time');
 await x.pause();
 assert.equal(x.overlay(),'false');assert.equal(x.plot(),'overview A');
});
test('leaving the player route drops the playback at once, while its video is still in the page',async t=>{
 const x=starting(t);
 await x.navigate('#/video');x.p.checkForVideoChanges();await flush();
 assert.equal(x.p.currentVideo,x.video);assert.equal(x.plot(),'overview A');
 await x.navigate('#/home');
 assert.equal(x.video.isConnected,true);
 assert.equal(x.p.currentVideo,null);assert.equal(x.p.currentItemId,null);assert.equal(x.plot(),'');assert.equal(x.overlay(),'true');
});
