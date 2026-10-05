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
 const h=setup(t);h.window.localStorage.setItem('user-a-lastRandomThemeDate',new Date().toISOString().split('T')[0]);h.JE.initializeThemeSelector();h.change();h.flush(100);const button=h.document.querySelector('#random-theme-button');
 assert.equal(button.getAttribute('aria-pressed'),'false');button.click();assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(h.window.localStorage.getItem('user-a-randomThemeEnabled'),'true');button.click();assert.equal(button.getAttribute('aria-pressed'),'false');
});
