// Core event wiring (enhanced/events.js): shortcuts, long press, visibility, remove context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadKeyCombo } from '../helpers/harness.mjs';
import { chromeJs } from './helpers.mjs';

function events(t, { settings = {}, config = {}, video = true } = {}) {
  const calls = [];
  const record = name => (...args) => calls.push([name, ...args]);
  const h = createHarness({ html: `${video ? '<video></video>' : ''}<div class="card" data-id="item-1"><button data-action="menu"></button></div><input id="typing">`,
    JE: { pluginConfig: config, currentSettings: settings, state: { activeShortcuts: { GoToHome: 'H', CycleAudioTracks: 'A', JumpToPercentage: '5' } },
      t: key => key, toast: record('toast'), isVideoPage: () => true, showEnhancedPanel: record('panel'), cycleAudioTrack: record('audio'),
      jumpToPercentage: record('jump'), attachSeekTracker: record('seek'), detectCardSurface: () => 'Continue Watching',
      addRemoveButton: record('remove'), handleLongPressDown: record('down'), handleLongPressUp: record('up'),
      injectGlobalStyles: record('styles'), addPluginMenuButton() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, onBodyMutation: (id, callback) => { if (id === 'action-sheets') calls.sheet = callback; } } } });
  t.after(() => h.close());
  // jsdom cannot create trusted events and the gesture listeners ignore untrusted ones,
  // so record the document listeners the module installs and call them with a trusted-shaped event.
  const listeners = [];
  const add = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => { listeners.push([type, fn]); return add(type, fn, options); };
  loadKeyCombo(h); h.load(chromeJs('enhanced/events.js'));
  const key = (name, init = {}, target = h.document.body) => { const e = new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e; };
  const mouse = type => { const event = { type, isTrusted: true, button: 0, target: h.document.querySelector('video') }; for (const [name, fn] of listeners) if (name === type) fn(event); };
  return { ...h, calls, key, mouse, names: () => calls.map(([name]) => name) };
}

test('CHR-R1-006 auto-resume cannot follow a reused video onto another item', async t=>{
 const h=events(t,{settings:{autoPauseEnabled:true,autoResumeEnabled:true}});
 const v=h.document.querySelector('video'); let hidden=false, paused=false, plays=0;
 Object.defineProperty(v,'paused',{get:()=>paused});
 Object.defineProperty(h.document,'hidden',{configurable:true,get:()=>hidden});
 v.pause=()=>{paused=true}; v.play=()=>{plays++;return Promise.resolve()};
 v.src='http://jellyfin.test/old-item'; h.JE.initializeEnhancedScript();
 hidden=true;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(v.dataset.wasPlayingBeforeHidden,'true');
 v.src='http://jellyfin.test/new-item'; v.dispatchEvent(new h.window.Event('emptied'));
 hidden=false;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(plays,0);
});
test('CHR-R1-006 unchanged playback still auto-resumes', async t=>{
 const h=events(t,{settings:{autoPauseEnabled:true,autoResumeEnabled:true}});
 const v=h.document.querySelector('video'); let hidden=false, paused=false, plays=0;
 Object.defineProperty(v,'paused',{get:()=>paused});
 Object.defineProperty(h.document,'hidden',{configurable:true,get:()=>hidden});
 v.pause=()=>{paused=true}; v.play=()=>{plays++;return Promise.resolve()};
 v.src='http://jellyfin.test/old-item'; h.JE.initializeEnhancedScript();
 hidden=true;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(v.dataset.wasPlayingBeforeHidden,'true');

 hidden=false;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(plays,1);
});
test('CHR-R1-006 same-element playback cannot resume after silent token replacement', async t=>{
 const h=events(t,{settings:{autoPauseEnabled:true,autoResumeEnabled:true}});
 const v=h.document.querySelector('video'); let hidden=false, paused=false, plays=0;
 Object.defineProperty(v,'paused',{get:()=>paused});
 Object.defineProperty(h.document,'hidden',{configurable:true,get:()=>hidden});
 v.pause=()=>{paused=true}; v.play=()=>{plays++;return Promise.resolve()};
 v.src='http://jellyfin.test/old-item'; h.JE.initializeEnhancedScript();
 hidden=true;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(v.dataset.wasPlayingBeforeHidden,'true');
 h.window.ApiClient.accessToken=()=> 'new-token';
 hidden=false;h.document.dispatchEvent(new h.window.Event('visibilitychange'));
 assert.equal(plays,0);
});
