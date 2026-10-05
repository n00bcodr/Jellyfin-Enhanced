import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';

function setup(t) {
  const h = createHarness({html:'<video></video><button id="randomItemButton"></button><button class="btnSubtitles"></button>', JE:{
    pluginConfig:{}, currentSettings:{autoPauseEnabled:false,autoResumeEnabled:true},
    state:{activeShortcuts:{PlayRandomItem:'R',SubtitleMenu:'S',JumpToPercentage:''}},
    isVideoPage:()=>false, attachSeekTracker(){}, injectGlobalStyles(){},addPluginMenuButton(){},addUserMenuLink(){},addRandomButton(){},applySavedStylesWhenReady(){},
    helpers:{createObserver(){},throttle:fn=>fn,onBodyMutation(){}}
  }});
  t.after(()=>h.close());h.load('enhanced/events.js');
  h.press=(key,modifiers={})=>{const e=new h.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...modifiers});h.JE.keyListener(e);return e;};
  return h;
}

test('history issue 55 Command-R preserves browser refresh without selecting random media',t=>{
  const h=setup(t);let clicks=0;h.document.getElementById('randomItemButton').onclick=()=>clicks++;
  for(const modifier of [{metaKey:true},{ctrlKey:true},{altKey:true}]) {
    assert.equal(h.press('r',modifier).defaultPrevented,false);assert.equal(clicks,0);
  }
  assert.equal(h.press('r').defaultPrevented,true);assert.equal(clicks,1);
});

test('history issue 1 subtitle shortcut closes an existing sheet rather than reopening it',t=>{
  const h=setup(t);h.JE.isVideoPage=()=>true;let opens=0;h.document.querySelector('.btnSubtitles').onclick=()=>opens++;
  h.document.body.insertAdjacentHTML('beforeend','<div class="dialogBackdrop dialogBackdropOpened"></div><div class="dialogContainer"><div class="actionSheetContent"><div class="actionSheetTitle">Subtitles</div></div></div>');
  h.press('s');assert.equal(opens,0);assert.equal(h.document.querySelector('.dialogContainer'),null);assert.equal(h.document.querySelector('.dialogBackdrop'),null);
  h.press('s');assert.equal(opens,1);
});

test('history issue 163 disabled auto pause respects tab changes and only resumes its own pause',t=>{
  const h=setup(t);const video=h.document.querySelector('video');let paused=false,hidden=false,pauses=0,plays=0;
  Object.defineProperty(video,'paused',{get:()=>paused});Object.defineProperty(h.document,'hidden',{get:()=>hidden});
  video.pause=()=>{pauses++;paused=true;};video.play=()=>{plays++;paused=false;return Promise.resolve();};
  h.JE.initializeEnhancedScript();const visibility=value=>{hidden=value;h.document.dispatchEvent(new h.window.Event('visibilitychange'));};
  visibility(true);assert.equal(pauses,0);visibility(false);assert.equal(plays,0);
  h.JE.currentSettings.autoPauseEnabled=true;visibility(true);assert.equal(pauses,1);visibility(false);assert.equal(plays,1);
  paused=true;visibility(true);visibility(false);assert.equal(plays,1);
  h.JE.currentSettings.autoPauseEnabled=false;paused=false;visibility(true);assert.equal(pauses,1);
});
