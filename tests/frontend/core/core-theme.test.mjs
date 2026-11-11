import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
function setup(t){const timers=new Map();let seq=0,changed,unsubscribed=0;const h=createHarness({html:'<section class="verticalSection"><span class="headerUsername">User</span><a class="lnkUserProfile"></a></section>',globals:{setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id)},JE:{cdn:{url:()=>'/JellyfinEnhanced/cdn/jellyfish/colors/'},helpers:{onBodyMutation:(id,fn)=>{changed=fn;return{unsubscribe:()=>unsubscribed++};}}}});t.after(()=>h.close());h.load('extras/theme-selector.js');return Object.assign(h,{timers,unsubscribed:()=>unsubscribed,flush:ms=>{for(const[id,timer]of[...timers])if(timer.ms===ms){timers.delete(id);timer.fn();}},change:()=>changed()});}
test('theme selector mounts once, reflects current user CSS and replaces old monitoring',t=>{
 const h=setup(t);h.window.localStorage.setItem('user-a-customCss','@import url("/JellyfinEnhanced/cdn/jellyfish/colors/ocean.css");');h.JE.initializeThemeSelector();h.change();h.flush(100);
 assert.equal(h.document.querySelector('select').value,'Ocean');assert.equal(h.document.querySelector('select').getAttribute('aria-label'),'Select theme');
 h.change();h.flush(100);assert.equal(h.document.querySelectorAll('#jellyfin-theme-selector').length,1);
 h.JE.initializeThemeSelector();assert.equal(h.unsubscribed(),1);assert.equal(h.document.querySelectorAll('#jellyfin-theme-selector-css').length,1);
});
test('theme selection stores local CDN CSS only for current user and default removes it',t=>{
 const h=setup(t);h.window.localStorage.setItem('other-customCss','keep');h.JE.initializeThemeSelector();h.change();h.flush(100);const select=h.document.querySelector('select');
 select.value='Forest';select.dispatchEvent(new h.window.Event('change'));assert.equal(h.window.localStorage.getItem('user-a-customCss'),'@import url("/JellyfinEnhanced/cdn/jellyfish/colors/forest.css");');assert.equal(h.window.localStorage.getItem('other-customCss'),'keep');assert.equal(h.window.sessionStorage.getItem('jellyfin-theme-applied'),'Forest');assert.equal(select.disabled,true);
 select.value='Default';select.dispatchEvent(new h.window.Event('change'));assert.equal(h.window.localStorage.getItem('user-a-customCss'),null);
});
test('daily-theme preference toggles accessibly without rerolling an already selected day',t=>{
 // Pin the page's clock one millisecond before UTC midnight, so the stored day and the day the page computes cannot differ.
 const h=setup(t);const RealDate=h.window.Date,now=RealDate.UTC(2026,0,1,23,59,59,999);
 h.window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
 h.window.localStorage.setItem('user-a-lastRandomThemeDate',new h.window.Date().toISOString().split('T')[0]);h.JE.initializeThemeSelector();h.change();h.flush(100);const button=h.document.querySelector('#random-theme-button');
 assert.equal(button.getAttribute('aria-pressed'),'false');button.click();assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(h.window.localStorage.getItem('user-a-randomThemeEnabled'),'true');button.click();assert.equal(button.getAttribute('aria-pressed'),'false');
});
test('theme selection changes only its own block and never drops the user\'s own custom CSS',t=>{
 const h=setup(t),own='.card { border-radius: 0; }\n/* my tweaks */',key='user-a-customCss',ls=h.window.localStorage;ls.setItem(key,own);
 h.JE.initializeThemeSelector();h.change();h.flush(100);const select=h.document.querySelector('select');assert.equal(select.value,'Default');
 select.value='Forest';select.dispatchEvent(new h.window.Event('change'));
 const forest=ls.getItem(key);assert.ok(forest.endsWith(own),forest);assert.ok(forest.startsWith('/*'),'the theme import stays first so the browser applies it');
 assert.match(forest,/@import url\("\/JellyfinEnhanced\/cdn\/jellyfish\/colors\/forest\.css"\);/);
 select.value='Ocean';select.dispatchEvent(new h.window.Event('change'));
 const ocean=ls.getItem(key);assert.ok(ocean.endsWith(own),ocean);assert.doesNotMatch(ocean,/forest\.css/);assert.match(ocean,/ocean\.css/);
 h.document.getElementById('jellyfin-theme-selector').remove();h.change();h.flush(100);assert.equal(h.document.querySelector('select').value,'Ocean');
 const again=h.document.querySelector('select');again.value='Default';again.dispatchEvent(new h.window.Event('change'));assert.equal(ls.getItem(key),own);
 // A value the selector wrote before it marked its block (the import alone) is still replaced, not stacked.
 ls.setItem(key,'@import url("/JellyfinEnhanced/cdn/jellyfish/colors/ocean.css");');h.document.getElementById('jellyfin-theme-selector').remove();h.change();h.flush(100);
 const legacy=h.document.querySelector('select');assert.equal(legacy.value,'Ocean');legacy.value='Mint';legacy.dispatchEvent(new h.window.Event('change'));
 assert.doesNotMatch(ls.getItem(key),/ocean\.css/);assert.match(ls.getItem(key),/mint\.css/);
 // ...also when the user added their own CSS below that import.
 ls.setItem(key,'@import url("/JellyfinEnhanced/cdn/jellyfish/colors/ocean.css");\n'+own);h.document.getElementById('jellyfin-theme-selector').remove();h.change();h.flush(100);
 const extended=h.document.querySelector('select');assert.equal(extended.value,'Ocean');extended.value='Mint';extended.dispatchEvent(new h.window.Event('change'));
 assert.doesNotMatch(ls.getItem(key),/ocean\.css/);assert.match(ls.getItem(key),/mint\.css/);assert.ok(ls.getItem(key).endsWith(own));
});
