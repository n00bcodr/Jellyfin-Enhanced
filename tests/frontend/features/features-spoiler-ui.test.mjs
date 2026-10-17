import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

function setup(t, html = '') {
  const h = createHarness({html});
  t.after(() => h.close());
  h.window.Date.now = () => 100000000;
  return h;
}

test('spoiler disable snooze is isolated per user and expires at exact boundary', t => {
  const h = setup(t); let user = 'a';
  h.window.ApiClient.getCurrentUserId = () => user;
  h.load('enhanced/spoilerguard/snooze.js');
  const api = h.JE.internals.spoilerGuard;
  assert.equal(api.isDisableSnoozed(), false);
  api.setDisableSnooze(); assert.equal(api.isDisableSnoozed(), true);
  user = 'b'; assert.equal(api.isDisableSnoozed(), false);
  user = null; api.setDisableSnooze(); assert.equal(h.window.localStorage.length, 1);
  user = 'a'; h.window.Date.now = () => 100900000;
  assert.equal(api.isDisableSnoozed(), false);
  assert.equal(h.window.localStorage.length, 0);
});

for (const value of ['NaN', 'Infinity', '-1', '0', '999999999999']) {
  test(`spoiler snooze rejects corrupt or implausible expiry ${value}`, t => {
    const h = setup(t); h.load('enhanced/spoilerguard/snooze.js');
    h.window.localStorage.setItem('je-spoiler-disable-snooze:user-a', value);
    assert.equal(h.JE.internals.spoilerGuard.isDisableSnoozed(), false);
    assert.equal(h.window.localStorage.length, 0);
  });
}

test('spoiler image refresh preserves URL parameters and replaces prior cache buster', t => {
  const h = setup(t); h.load('enhanced/spoilerguard/image-refresh.js');
  const bust = h.JE.internals.spoilerGuard.bustSpoilerImageUrl;
  for (const url of ['/Items/aa/Images/Primary?tag=abc&_sbcb=123&quality=90', '/Items/aa/Images/Primary?_sbcb=123&tag=abc&quality=90']) {
    const actual = new URL(bust(url, '_sbcb=456'), h.window.location.href);
    assert.equal(actual.searchParams.get('tag'), 'abc');
    assert.equal(actual.searchParams.get('quality'), '90');
    assert.deepEqual(actual.searchParams.getAll('_sbcb'), ['456']);
  }
  assert.equal(bust('/branding/logo.png', '_sbcb=456'), '/branding/logo.png');
});

test('spoiler refresh updates responsive image width and density candidates and backgrounds', t => {
  const h = setup(t, `<img id="density" src="/Items/aa/Images/Primary" srcset="/Items/aa/Images/Primary?q=1 1x, /Items/aa/Images/Primary?q=2 2x">
    <img id="width" src="/branding/logo.png" srcset="/Items/bb/Images/Primary?q=1 100w, /Items/bb/Images/Primary?q=2 200w">
    <picture><source srcset="/Items/cc/Images/Primary 300w"><img src="/branding/logo.png"></picture>
    <div id="background" style="background-image:url('/Items/dd/Images/Backdrop?tag=keep')"></div>`);
  h.load('enhanced/spoilerguard/image-refresh.js');
  h.JE.internals.spoilerGuard.refreshSpoilerableImages();
  for (const selector of ['#density', '#width', 'source']) {
    const srcset = h.document.querySelector(selector).getAttribute('srcset');
    for (const candidate of srcset.split(',')) {
      const [url, descriptor] = candidate.trim().split(/\s+/);
      assert.equal(new URL(url, h.window.location.href).searchParams.get('_sbcb'), '100000000');
      assert.match(descriptor, /^\d+[wx]$/);
    }
  }
  assert.equal(h.document.querySelector('#width').getAttribute('src'), '/branding/logo.png');
  assert.match(h.document.querySelector('#background').getAttribute('style'), /tag=keep&_sbcb=100000000/);
});

function settingsTab(t, pluginConfig, prefs = {}) {
  const h = setup(t);
  const saved = [];
  Object.assign(h.JE, { pluginConfig: { SpoilerBlurEnabled: true, ...pluginConfig }, t: key => key, icon: () => '', IconName: { BLUR_ON: 'blur_on' } });
  h.JE.internals = { spoilerGuard: { getUserPrefs: () => ({ ...prefs }), whenLoaded: async () => {}, isLoadOk: () => true, setUserPrefs: async next => { saved.push(next); } } };
  h.load('enhanced/spoilerguard/settings-tab.js');
  const ctx = { presetBoxBackground: 'black', toggleAccentColor: 'white', help: h.document.body, resetAutoCloseTimer() {} };
  h.document.body.innerHTML = h.JE.internals.spoilerGuard.buildSettingsHtml(ctx);
  return { h, ctx, saved, ids: [...h.document.querySelectorAll('input[id^="sbPref"]')].map(box => box.id) };
}

test('spoiler settings seek-preview row follows the admin trickplay switch and sits after Reviews', t => {
  const { ids } = settingsTab(t, { SpoilerAdvancedMode: true });
  assert.equal(ids.indexOf('sbPrefHideTrickplay'), ids.indexOf('sbPrefHideReviews') + 1);
  assert.equal(ids.indexOf('sbPrefUseAdvancedCategories'), ids.indexOf('sbPrefHideTrickplay') + 1);
  assert.equal(settingsTab(t, { SpoilerBlurTrickplay: false }).ids.includes('sbPrefHideTrickplay'), false);
});

test('spoiler settings seek-preview row reflects and saves the per-user opt-out', async t => {
  const { h, ctx, saved } = settingsTab(t, { SpoilerBlurTrickplay: true }, { HideTrickplay: false, HideReviews: null });
  const box = h.document.getElementById('sbPrefHideTrickplay');
  assert.equal(box.checked, false);
  assert.equal(box.dataset.pref, 'HideTrickplay');
  h.JE.internals.spoilerGuard.wireSettings(ctx);
  await new Promise(resolve => setTimeout(resolve, 0)); // let the initial preference sync finish
  assert.equal(box.checked, false);
  box.checked = true;
  box.dispatchEvent(new h.window.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saved, [{ HideTrickplay: null, HideReviews: null }]);
});
