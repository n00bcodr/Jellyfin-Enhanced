import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, mount, settle, delivered, moreInfo, seerrModal } from '../helpers/title-actions-scopes.mjs';
import { hostInput, HOSTS } from '../helpers/host-input.mjs';

// D46 slice 2 review round 11: one surface stack, host dialogs, host keys and focus, with bounded registries. A host
// dialog that arrives over a JE surface joins the stack (it is topmost: Escape and Back are the host's) and leaves it,
// with every record of it, when the host removes it. Every key jellyfin-web treats as Back (its real keyboard navigation
// and input manager, 10.11.11 and 12.2: 461, 10009, TV Escape, a gamepad's B) dismisses only the topmost JE surface and
// never reaches the host's router too. Opening a surface moves focus into it, Tab and the host's D-pad stay inside it,
// and closing gives focus back to a live opener or a sensible fallback. A reconciliation that changes nothing mints
// nothing, and ended tokens, closed surfaces and dismissed dialogs leave every registry.

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The core's registries, read through a probe planted for the test. */
const coreProbe = { 'core/session-action.js': s => s.replace('})(window.JellyfinEnhanced);',
  'JE.__registries = () => ({ scopes: [...scopes.values()].reduce((n, set) => n + set.size, 0), stack: stack.length, openings: openings.size, claims: claims.size });\n})(window.JellyfinEnhanced);') };
const liveProbe = { 'arr/actions/title-actions.js': s => s.replace('const live = new Set();',
  'const live = new Set(); A.__liveCount = () => live.size; A.__endedCount = () => [...live].filter(t => !t.current()).length;') };

async function openInfo(h) {
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  return moreInfo(h);
}

// ------------------------------------------------------------------ host dialogs on the one stack

test('R11-10: Escape on a quota dialog over More Info is the dialog\'s: the window under it stays open', async t => {
  const h = setup(t, { asks: false });
  const info = await openInfo(h);
  await h.JE.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { code: 'quota_exceeded' } }, 'movie', h.JE.ownerOf(info));
  await delivered();
  const dialog = h.document.querySelector('.dialogContainer');
  assert.ok(dialog);
  assert.equal(h.JE.isTopmostSurface(info), false, 'the host dialog is on top of the window');
  h.key(dialog.querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(info._isClosing, undefined, 'Escape in the top host dialog leaves the window open');
  assert.ok(dialog.isConnected, 'the host dialog handles its own keys');
  dialog.querySelector('button').click(); await delivered();
  assert.equal(h.JE.isTopmostSurface(info), true, 'the window is topmost again once the host removed its dialog');
  h.key(h.document.body, 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(info._isClosing, true);
});

test('R11-10: a host dialog that arrives over a JE surface without any JE opening (the host\'s own) is on the stack too', async t => {
  const h = setup(t, { asks: false, plants: coreProbe });
  const info = await openInfo(h);
  const own = h.document.createElement('div'); own.className = 'dialogContainer'; own.innerHTML = '<button>OK</button>';
  h.document.body.append(own); await delivered();
  h.key(own.querySelector('button'), 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(info._isClosing, undefined);
  own.remove(); await delivered();
  assert.equal(h.JE.__registries().stack, 1, 'released when the host removed it');
});

test('R11-10: 12 host dialogs opened and dismissed normally leave no record or node behind (bounded)', async t => {
  const h = setup(t, { asks: false, plants: coreProbe });
  const info = await openInfo(h);
  for (let i = 0; i < 12; i++) {
    await h.JE.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { code: 'quota_exceeded' } }, 'movie', h.NATIVE); await delivered();
    h.document.querySelector('.dialogContainer button').click(); await delivered();
  }
  assert.equal(h.document.querySelectorAll('.dialogContainer').length, 0);
  assert.deepEqual({ ...h.JE.__registries() }, { scopes: 1, stack: 1, openings: 0, claims: 0 }, 'only the window remains');
  h.JE.jellyseerrMoreInfo.close(); await delivered();
  assert.ok(info._isClosing);
  assert.deepEqual({ ...h.JE.__registries() }, { scopes: 0, stack: 0, openings: 0, claims: 0 });
});

// ------------------------------------------------------------------ the host's own keys (real jellyfin-web modules)

for (const host of HOSTS) {
  test(`R11-11: jellyfin-web ${host} on a TV: Escape closes More Info only; the host's router never sees it`, async t => {
    const h = setup(t, { asks: false }); const input = hostInput(h, host, { tv: true });
    h.window.history.pushState({}, '', '#!/search?query=matrix'); await delivered();
    const info = await openInfo(h);
    info.querySelector('button').focus();
    h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await wait(25); await delivered();
    assert.equal(info._isClosing, true, 'the window closes');
    assert.equal(input.back, 0, 'the same Escape never reaches the host router');
    assert.equal(h.window.location.hash, '#!/search?query=matrix');
  });

  test(`R11-11: jellyfin-web ${host}: a remote's Back (10009, 461) and a gamepad's B (196) close More Info only; the search page stays`, async t => {
    const h = setup(t, { asks: false }); const input = hostInput(h, host, { tv: true });
    h.window.history.pushState({}, '', '#!/search?query=matrix'); await delivered();
    for (const keyCode of [10009, 461, 196]) {
      const info = await openInfo(h);
      info.querySelector('button').focus();
      h.key(h.document.activeElement, 'Unidentified', { keyCode }); await wait(25); await delivered();
      assert.equal(info._isClosing, true, `${keyCode} closes the top window`);
      assert.equal(input.back, 0, `${keyCode} never reaches the host router`);
      assert.equal(h.window.location.hash, '#!/search?query=matrix');
      await wait(320);
    }
  });

  test(`R11-11 control: jellyfin-web ${host}: Back 10009 on a request form over More Info closes the form only`, async t => {
    const h = setup(t, { asks: false, advanced: true }); const input = hostInput(h, host, { tv: true });
    h.window.history.pushState({}, '', '#!/search?query=matrix'); await delivered();
    const info = await openInfo(h);
    h.click(info.querySelector('.jellyseerr-request-button')); await wait(70); await delivered();
    const form = seerrModal(h);
    form.querySelector('button').focus();
    h.key(h.document.activeElement, 'Unidentified', { keyCode: 10009 }); await wait(25); await delivered();
    assert.equal(form._isClosing, true);
    assert.ok(!info._isClosing);
    assert.equal(input.back, 0);
    assert.equal(h.window.location.hash, '#!/search?query=matrix');
  });

  test(`R11-11 control: jellyfin-web ${host} with no JE surface open: Back still reaches the host router`, async t => {
    // A router that can go back (the page has history); the gate itself is covered by the round-14 cells.
    const h = setup(t, { asks: false }); const input = hostInput(h, host, { tv: true, canGoBack: true });
    h.key(h.document.body, 'Unidentified', { keyCode: 10009 }); await delivered();
    assert.equal(input.back, 1);
  });

  test(`R11-10/11: jellyfin-web ${host}: with a host dialog over More Info, TV Back is the host's (More Info stays)`, async t => {
    const h = setup(t, { asks: false }); const input = hostInput(h, host, { tv: true, canGoBack: true });
    const info = await openInfo(h);
    await h.JE.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { code: 'quota_exceeded' } }, 'movie', h.JE.ownerOf(info));
    await delivered();
    h.key(h.document.querySelector('.dialogContainer button'), 'Unidentified', { keyCode: 10009 }); await delivered();
    assert.equal(input.back, 1, 'the host handles Back for its own dialog');
    assert.equal(info._isClosing, undefined);
  });

  test(`R11-12: jellyfin-web ${host}'s D-pad stays inside the open More Info window (its focus container)`, async t => {
    const h = setup(t, { asks: false }); const input = hostInput(h, host, { tv: true });
    const behind = h.document.createElement('button'); behind.textContent = 'Card behind'; h.document.body.prepend(behind);
    const info = await openInfo(h);
    const inside = [...info.querySelectorAll('button')].filter(b => !b.disabled);
    assert.ok(inside.length >= 2);
    // Layout for the host's geometry: the window's controls in a column, the card behind just below the first.
    const rect = (top, left = 100) => () => ({ top, left, bottom: top + 40, right: left + 100, width: 100, height: 40, x: left, y: top });
    inside.forEach((b, i) => { b.getBoundingClientRect = rect(100 + i * 200); });
    behind.getBoundingClientRect = rect(150);
    inside[0].focus();
    input.handleCommand('down');
    assert.ok(info.contains(h.document.activeElement), 'down moves to a control inside the window, never the card behind');
    assert.notEqual(h.document.activeElement, behind);
  });
}

// ------------------------------------------------------------------ focus in, contained, restored

test('R11-12: opening More Info moves focus into it; Tab and Shift+Tab stay inside; closing gives focus back to its opener', async t => {
  const h = setup(t, { asks: false });
  const opener = h.document.createElement('button'); opener.textContent = 'Open'; h.document.body.append(opener);
  const behind = h.document.createElement('button'); behind.textContent = 'Next card'; h.document.body.append(behind);
  opener.focus();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  assert.ok(info.contains(h.document.activeElement), 'focus enters the opened window');
  const controls = [...info.querySelectorAll('button, [href], input, select, textarea, [tabindex]')].filter(n => !n.disabled && n.tabIndex >= 0 && !n.closest('[hidden], [inert], .hide'));
  controls.at(-1).focus();
  h.key(h.document.activeElement, 'Tab'); await delivered();
  assert.equal(h.document.activeElement, controls[0], 'Tab past the last control wraps to the first');
  h.key(h.document.activeElement, 'Tab', { shiftKey: true }); await delivered();
  assert.equal(h.document.activeElement, controls.at(-1), 'Shift+Tab past the first wraps to the last');
  behind.focus();
  h.key(h.document.activeElement, 'Tab'); await delivered();
  assert.ok(info.contains(h.document.activeElement), 'Tab from a covered control comes back inside');
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await delivered();
  assert.equal(h.document.activeElement, opener, 'closing gives focus back to the opener');
});

test('R11-12: closing a window whose opener went gives focus to the page (a sensible fallback), not to nothing inside the closed window', async t => {
  const h = setup(t, { asks: false });
  const pageButton = h.document.createElement('button'); pageButton.textContent = 'Play'; h.page.classList.add('page'); h.page.prepend(pageButton);
  const opener = h.document.createElement('button'); h.document.body.append(opener); opener.focus();
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await delivered();
  const info = moreInfo(h);
  opener.remove();
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await delivered();
  assert.ok(info._isClosing);
  assert.ok(!info.contains(h.document.activeElement));
  assert.equal(h.document.activeElement, pageButton);
});

test('R11-12: a request form over More Info: focus moves into the form; closing it returns focus inside the window under it', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const info = await openInfo(h);
  const request = info.querySelector('.jellyseerr-request-button');
  request.focus();
  h.click(request); await wait(70); await delivered();
  const form = seerrModal(h);
  assert.ok(form.contains(h.document.activeElement));
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await delivered();
  assert.ok(form._isClosing && !info._isClosing);
  assert.ok(info.contains(h.document.activeElement), 'focus is back in the window');
});

// ------------------------------------------------------------------ bounded lifetimes

test('R11-13: 200 reconciliation passes over an unchanged row mint nothing, and navigating away releases every ended token', async t => {
  const h = setup(t, { asks: false, plants: liveProbe });
  h.a.initialize(); mount(h); await settle();
  const before = h.a.__liveCount();
  for (let i = 0; i < 200; i++) h.a.scan();
  assert.equal(h.a.__liveCount(), before, 'an unchanged row reuses its generation');
  await h.leave('#/search?query=another'); await delivered();
  assert.equal(h.a.__endedCount(), 0, 'ended tokens are released');
  assert.ok(h.a.__liveCount() <= before);
});

test('R11-13: 50 navigations between two titles keep the token registry and the surface stack flat', async t => {
  const h = setup(t, { asks: false, plants: { ...liveProbe, ...coreProbe } });
  h.a.initialize(); mount(h); await settle();
  const sizes = [];
  for (let i = 0; i < 50; i++) {
    await h.leave(i % 2 ? '#/details?id=x' : '#/details?id=y');
    mount(h); h.a.scan(); await delivered();
    sizes.push(h.a.__liveCount());
  }
  assert.ok(Math.max(...sizes) <= sizes[0] + 2, `flat: ${sizes.join(',')}`);
  assert.equal(h.JE.__registries().stack, 0);
});

test('R11 control: the host rewriting the same page\'s URL (server id, parameter order) leaves the window and its form open', async t => {
  const h = setup(t, { asks: false, advanced: true });
  const info = await openInfo(h);
  h.click(info.querySelector('.jellyseerr-request-button')); await wait(70); await delivered();
  const form = seerrModal(h);
  h.window.history.replaceState(h.window.history.state, '', '#!/details?serverId=server-a&id=x'); await delivered();
  assert.ok(!info._isClosing); assert.ok(!form._isClosing);
});
