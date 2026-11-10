// Splash screen and login image: the two pre-login scripts plugin.js loads by URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { chromeJs, fakeClock } from './helpers.mjs';

function splash(t, config = { EnableCustomSplashScreen: true }, html = '') {
  const clock = fakeClock();
  const h = createHarness({ html, JE: { pluginConfig: config }, globals: clock.globals });
  t.after(() => h.close());
  h.load(chromeJs('others/splashscreen.js'));
  return { ...h, clock, splash: () => h.document.querySelectorAll('.je-loading') };
}

test('splash: preemptive styles install at load and the public facades exist', t => {
  const h = splash(t);
  assert.ok(h.document.getElementById('je-preempt-styles'));
  assert.ok(h.document.documentElement.classList.contains('je-splash-booting'));
  assert.equal(typeof h.JE.initializeSplashScreen, 'function');
  assert.equal(typeof h.JE.hideSplashScreen, 'function');
});

test('splash: disabled config removes every boot block without showing a splash', t => {
  const h = splash(t, {});
  h.JE.initializeSplashScreen();
  assert.equal(h.splash().length, 0);
  assert.equal(h.document.getElementById('je-preempt-styles'), null);
  assert.equal(h.document.getElementById('je-permanent-block'), null);
  assert.equal(h.document.documentElement.classList.contains('je-splash-booting'), false);
});

test('splash: shows until the UI appears, completes the bar, then removes itself and competing loaders', async t => {
  const h = splash(t);
  h.JE.initializeSplashScreen();
  assert.equal(h.splash().length, 1);
  assert.ok(h.document.body.classList.contains('je-splash-active'));
  await h.clock.advance(1500);
  const bar = h.document.getElementById('je-progress-bar');
  assert.ok(parseFloat(bar.style.width) > 0 && parseFloat(bar.style.width) <= 95, bar.style.width);
  h.document.body.insertAdjacentHTML('beforeend', '<div id="page-loader"></div>');
  await h.clock.advance(0);
  assert.equal(h.document.getElementById('page-loader'), null, 'media-bar loader is blocked');
  h.document.body.insertAdjacentHTML('beforeend', '<div id="mainAnimatedPage"></div>');
  await h.clock.advance(0);
  assert.equal(bar.style.width, '100%');
  await h.clock.advance(300 + 400);
  assert.equal(h.splash().length, 0);
  assert.equal(h.document.getElementById('je-splash-styles'), null);
  assert.equal(h.document.body.classList.contains('je-splash-active'), false);
});

test('splash: the 20 s hard timeout hides a splash whose UI never becomes ready', async t => {
  const h = splash(t);
  h.JE.initializeSplashScreen();
  await h.clock.advance(19999);
  assert.equal(h.splash().length, 1);
  await h.clock.advance(1 + 300 + 400);
  assert.equal(h.splash().length, 0);
});

// CHR-SPLASH-1: plugin.js initializes on the early script load and again after config.
test('CHR-SPLASH-1 splash: a second initialization after the splash completed does not leave a permanent overlay', async t => {
  const h = splash(t, { EnableCustomSplashScreen: true }, '<div id="mainAnimatedPage"></div>');
  h.JE.initializeSplashScreen();
  await h.clock.advance(1000);
  assert.equal(h.splash().length, 0, 'first splash completed');
  h.JE.initializeSplashScreen();
  h.JE.hideSplashScreen();
  await h.clock.advance(25000);
  assert.equal(h.splash().length, 0, 'no black overlay is left covering the UI');
});

// CHR-SPLASH-2: the configured URL is an attribute, never parsed markup.
test('CHR-SPLASH-2 splash: a configured image URL cannot inject attributes or elements', t => {
  const url = '/logo.png" onerror="window.__splashInjected=1" data-x="';
  const h = splash(t, { EnableCustomSplashScreen: true, SplashScreenImageUrl: url });
  h.JE.initializeSplashScreen();
  const img = h.document.querySelector('.je-loading img');
  assert.equal(img.getAttribute('src'), url);
  assert.equal(img.hasAttribute('onerror'), false);
  assert.equal(img.getAttribute('alt'), 'Server Logo');
});

const loginHtml = (users = [['alice', 'u1', '/Users/u1/Images/Primary?tag=t&quality=40']]) => `
  <div id="divUsers">${users.map(([name, id, image]) => `<div class="cardContent" data-username='${name.replace(/'/g, '&#39;')}' data-userid="${id}"><div class="cardImageContainer" style="background-image: url(&quot;${image}&quot;)"></div></div>`).join('')}</div>
  <form class="manualLoginForm"><label for="txtManualName">User</label><div class="inputContainer"><input id="txtManualName"></div></form>`;
function login(t, { html = loginHtml(), user = null } = {}) {
  const clock = fakeClock();
  const client = { _currentUser: user };
  const h = createHarness({ html, JE: {}, apiClient: client, globals: clock.globals });
  t.after(() => h.close());
  h.load(chromeJs('extras/login-image.js'));
  const select = async (name) => {
    const input = h.document.getElementById('txtManualName');
    input.value = name;
    input.dispatchEvent(new h.window.Event('input'));
    await clock.advance(60);
  };
  return { ...h, clock, client: h.window.ApiClient, select, image: () => h.document.querySelector('#userProfileImageContainer img') };
}

test('login image: selecting a user shows their high-quality avatar and hides the name field', async t => {
  const h = login(t);
  await h.clock.advance(150);
  await h.select('alice');
  const img = h.image();
  assert.ok(img);
  assert.equal(new URL(img.src).searchParams.get('quality'), '90');
  assert.equal(new URL(img.src).searchParams.has('tag'), false);
  assert.equal(h.document.getElementById('txtManualName').style.display, 'none');
  assert.equal(h.document.querySelector('label[for="txtManualName"]').style.display, 'none');
  await h.select('');
  assert.equal(h.document.getElementById('userProfileImageContainer'), null);
  assert.equal(h.document.getElementById('txtManualName').style.display, '');
});

test('login image: cards load progressively once each and a signed-in page is left alone', async t => {
  const h = login(t);
  const card = h.document.querySelector('.cardImageContainer');
  assert.equal(card.dataset.progressiveLoaded, 'true');
  assert.equal(card.querySelectorAll('.progressive-blur-overlay').length, 1);
  assert.match(card.style.backgroundImage, /quality=90/);
  h.document.getElementById('divUsers').appendChild(h.document.createElement('span'));
  await h.clock.advance(0);
  assert.equal(card.querySelectorAll('.progressive-blur-overlay').length, 1);
  const signedIn = login(t, { user: { Id: 'u1' } });
  assert.equal(signedIn.document.querySelector('.progressive-blur-overlay'), null);
});

// CHR-LOGIN-1: usernames are matched exactly, not interpolated into a CSS selector.
test('CHR-LOGIN-1 login image: a username with quotes or backslashes still shows its avatar', async t => {
  const name = 'Bob "The" \\Builder';
  const h = login(t, { html: loginHtml([[name, 'u9', '/Users/u9/Images/Primary?tag=x']]) });
  await h.clock.advance(150);
  await h.select(name);
  assert.ok(h.image(), 'avatar shown');
  assert.match(h.image().src, /Users\/u9\/Images\/Primary/);
});

// CHR-LOGIN-2: Jellyfin renders a new login view after an in-app sign-out without reloading the script.
test('CHR-LOGIN-2 login image: after signing in and out, the newly rendered login form is decorated', async t => {
  const h = login(t);
  await h.clock.advance(150);
  h.client._currentUser = { Id: 'u1' };
  h.document.body.innerHTML = '<div class="homePage"></div>';
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  await h.clock.advance(200);
  h.client._currentUser = null;
  h.document.body.innerHTML = loginHtml([['carol', 'u3', '/Users/u3/Images/Primary?tag=c']]);
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange'));
  await h.clock.advance(300);
  await h.select('carol');
  assert.ok(h.image(), 'avatar shown on the re-rendered login form');
  assert.equal(h.document.querySelector('.cardImageContainer').dataset.progressiveLoaded, 'true');
});
