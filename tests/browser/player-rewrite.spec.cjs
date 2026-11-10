const { test, expect } = require('@playwright/test');
const path = require('node:path'); const {provideFeatureContext}=require('../frontend/helpers/feature-context.cjs'); // canopy K1: ui-kit.js publishes featureContext in production; these fixtures load features without it
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/player');
async function setup(page, files) {
 await page.route('http://player.fixture/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div class="videoPlayerContainer"><video></video></div></body></html>'}));
 await page.goto('http://player.fixture/');
 await page.evaluate(() => {
  window.navigateCallbacks=[];
  window.JellyfinEnhanced={currentSettings:{},state:{},internals:{},t:k=>k,toast(){},escapeHtml:String,isVideoPage:()=>true,icon:()=>'',IconName:{PLAY:'play',FAST_FORWARD:'fast'},icons:{wrapEmoji:x=>x},
   core:{navigation:{onNavigate(fn){window.navigateCallbacks.push(fn);return ()=>{};}}},
   helpers:{onBodyMutation(_name,callback){const observer=new MutationObserver(callback);observer.observe(document.body,{childList:true,subtree:true});return {unsubscribe:()=>observer.disconnect()};}}};
  window.ApiClient={getCurrentUserId:()=> 'user',deviceId:()=> 'device',getUrl:x=>x};
 });
 await provideFeatureContext(page); for(const file of files)await page.addScriptTag({path:path.join(root,file+'.js')});
}
test('player subtitle styles apply to replacement cues and restore native style on navigation',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page,['subtitles']);
 await page.evaluate(()=>{
  const JE=window.JellyfinEnhanced;JE.applySubtitleStyles('#ffff00','#00000080',2,'monospace','none');
  const container=document.createElement('div');container.className='videoSubtitles';container.innerHTML='<div class="videoSubtitlesInner" style="color: red">First</div><div class="videoSecondarySubtitlesInner">Second</div>';document.body.append(container);
 });
 await expect(page.locator('.videoSubtitlesInner')).toHaveCSS('color','rgb(255, 255, 0)');
 await expect(page.locator('.videoSecondarySubtitlesInner')).toHaveCSS('color','rgb(255, 255, 0)');
 await page.evaluate(()=>window.navigateCallbacks.forEach(fn=>fn()));
 await expect(page.locator('.videoSubtitlesInner')).toHaveAttribute('style','color: red');expect(errors).toEqual([]);
});
test('player long press restores replaced media element at navigation without changing incoming rate',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page,['playback']);
 await page.evaluate(()=>{
  const JE=window.JellyfinEnhanced;JE.currentSettings.longPress2xEnabled=true;const video=document.querySelector('video');Object.defineProperty(video,'paused',{value:false});video.playbackRate=1.5;window.originalVideo=video;
  document.addEventListener('mousedown',JE.handleLongPressDown);document.dispatchEvent(new MouseEvent('mousedown',{clientX:0,clientY:0,button:0}));
 });
 await expect.poll(()=>page.evaluate(()=>window.originalVideo.playbackRate)).toBe(2);
 const rates=await page.evaluate(()=>{const next=document.createElement('video');next.playbackRate=0.75;window.originalVideo.replaceWith(next);window.navigateCallbacks.forEach(fn=>fn());return [window.originalVideo.playbackRate,next.playbackRate];});
 expect(rates).toEqual([1.5,0.75]);await expect(page.locator('[data-speed-overlay]')).toHaveCount(0);expect(errors).toEqual([]);
});
test('player aspect cycle follows native storage and graphical subtitle canvas',async({page})=>{
 await setup(page,['playback']);const result=await page.evaluate(()=>{const JE=window.JellyfinEnhanced,video=document.querySelector('video');const canvas=document.createElement('canvas');video.parentElement.append(canvas);const modes=[];for(let i=0;i<3;i++){JE.cycleAspect();modes.push([localStorage.getItem('aspectRatio'),video.style.objectFit,canvas.style.objectFit]);}return modes;});
 expect(result).toEqual([['cover','cover','cover'],['fill','fill','fill'],['auto','','contain']]);
});
