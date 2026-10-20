import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

const tick = () => new Promise(r => setTimeout(r, 20));
const ID = '0123456789abcdef0123456789abcdef';

/** A settings answer as the server sends it (both OFF by default). */
function answer(overrides = {}) {
  return {
    playlist: { enabled: true, optedIn: false, state: 'off', reason: null, playlistId: null, entries: 0, retentionDays: 30, canRemove: false, ...(overrides.playlist || {}) },
    messages: { enabled: false, optedIn: false, recent: { accepted: 0, suppressed: 0, unknown: 0 }, ...(overrides.messages || {}) },
  };
}

/** The Ready section in a realm, with a scripted server and a switchable account epoch. */
function setup({ config = { ArrReadyPlaylistEnabled: true }, reply = () => answer() } = {}) {
  let epoch = 1;
  const calls = [];
  const h = createHarness({
    JE: {
      t: (k, p) => (p ? k + JSON.stringify(p) : k),
      pluginConfig: config,
      session: { getEpoch: () => epoch },
      core: { api: { plugin: (path, options) => { calls.push({ path, method: options.method, body: options.body }); return reply(path, options); } } },
    },
  });
  h.load('arr/ready/ready-settings.js');
  const R = h.JE.internals.arrReady;
  h.document.body.innerHTML = R.buildSettingsHtml();
  const host = () => h.document.querySelector('.je-arr-ready');
  return { ...h, R, calls, host, open: () => R.wireSettings({ help: h.document.body }), switchAccount: () => { epoch++; } };
}

test('the section exists only while a Ready feature is on, the playlist one without notifications', () => {
  const off = setup({ config: {} });
  try { assert.equal(off.R.buildSettingsHtml(), ''); } finally { off.close(); }
  const playlistOnly = setup({ config: { ArrReadyPlaylistEnabled: true, ArrNotificationsEnabled: false } });
  try { assert.match(playlistOnly.R.buildSettingsHtml(), /data-pane="ready-to-watch"/); } finally { playlistOnly.close(); }
  const messagesOnly = setup({ config: { ArrReadyMessagesEnabled: true } });
  try { assert.match(messagesOnly.R.buildSettingsHtml(), /arr_ready_panel_title/); } finally { messagesOnly.close(); }
});

test('both choices start off and a change is saved as just that field', async () => {
  const h = setup({
    config: { ArrReadyPlaylistEnabled: true, ArrReadyMessagesEnabled: true },
    reply: (path, o) => (o.method === 'PUT' ? answer({ playlist: { optedIn: true, state: 'active' }, messages: { enabled: true } }) : answer({ messages: { enabled: true } })),
  });
  try {
    h.open(); await tick();
    const boxes = h.host().querySelectorAll('input[type=checkbox]');
    assert.equal(boxes.length, 2);
    assert.ok([...boxes].every(b => !b.checked));
    assert.match(h.host().textContent, /arr_ready_playlist_desc\{"days":30\}/);
    boxes[0].checked = true; boxes[0].dispatchEvent(new h.window.Event('change'));
    await tick();
    assert.deepEqual(plain(h.calls.at(-1)), { path: '/acquire/ready', method: 'PUT', body: { readyPlaylist: true } });
    assert.equal(h.host().querySelector('[data-je-focus="ready-playlist"]').checked, true);
    assert.match(h.host().textContent, /arr_ready_state_making/);
    h.host().querySelector('[data-je-focus="ready-messages"]').checked = true;
    h.host().querySelector('[data-je-focus="ready-messages"]').dispatchEvent(new h.window.Event('change'));
    await tick();
    assert.deepEqual(plain(h.calls.at(-1).body), { nativeReadyMessages: true });
  } finally { h.close(); }
});

test('the messages choice is independent of the playlist one', async () => {
  const h = setup({ config: { ArrReadyMessagesEnabled: true }, reply: () => answer({ playlist: { enabled: false }, messages: { enabled: true, optedIn: true, recent: { accepted: 2, suppressed: 1, unknown: 1 } } }) });
  try {
    h.open(); await tick();
    assert.equal(h.host().querySelector('[data-je-focus="ready-playlist"]'), null);
    assert.equal(h.host().querySelector('[data-je-focus="ready-messages"]').checked, true);
    assert.match(h.host().textContent, /arr_ready_messages_recent\{"accepted":2,"suppressed":2\}/);
  } finally { h.close(); }
});

test('a failed save puts the control back as it was and says so', async () => {
  const h = setup({ reply: (path, o) => (o.method === 'PUT' ? Promise.reject(Object.assign(new Error('x'), { status: 503 })) : answer()) });
  try {
    h.open(); await tick();
    const box = h.host().querySelector('[data-je-focus="ready-playlist"]');
    box.checked = true; box.dispatchEvent(new h.window.Event('change'));
    await tick();
    assert.equal(h.host().querySelector('[data-je-focus="ready-playlist"]').checked, false);
    assert.match(h.host().textContent, /arr_ready_save_failed/);
  } finally { h.close(); }
});

test('an answer that arrives after the account changed is dropped', async () => {
  const first = deferred();
  const h = setup({ reply: () => first.promise });
  try {
    h.open();
    h.switchAccount();
    first.resolve(answer({ playlist: { optedIn: true, state: 'active', playlistId: ID, entries: 3 } }));
    await tick();
    assert.match(h.host().textContent, /arr_ready_panel_loading/);
    assert.equal(h.host().querySelector('input'), null);
  } finally { h.close(); }
});

test('an older answer arriving after a newer one is dropped', async () => {
  const slow = deferred();
  let n = 0;
  const h = setup({ reply: () => (n++ === 0 ? slow.promise : answer()) });
  try {
    h.open();
    h.open();
    await tick();
    slow.resolve(answer({ playlist: { optedIn: true, state: 'privacy' } }));
    await tick();
    assert.doesNotMatch(h.host().textContent, /arr_ready_state_privacy/);
    assert.equal(h.host().querySelector('[data-je-focus="ready-playlist"]').checked, false);
  } finally { h.close(); }
});

test('each state reads as what the person can do about it', async () => {
  for (const [p, text] of [
    [{ optedIn: true, state: 'active', playlistId: ID, entries: 4 }, /arr_ready_state_active\{"count":4\}/],
    [{ optedIn: false, state: 'off', playlistId: ID, canRemove: true }, /arr_ready_state_off_kept/],
    [{ state: 'deleted' }, /arr_ready_state_deleted/],
    [{ state: 'removed' }, /arr_ready_state_removed/],
    [{ state: 'renew', playlistId: ID }, /arr_ready_state_renew/],
    [{ state: 'privacy', playlistId: ID, canRemove: true }, /arr_ready_state_privacy/],
  ]) {
    const h = setup({ reply: () => answer({ playlist: p }) });
    try {
      h.open(); await tick();
      assert.match(h.host().textContent, text);
      const link = h.host().querySelector('a[href]');
      if (p.playlistId && p.state !== 'privacy') assert.equal(link.getAttribute('href'), '#/details?id=' + ID);
      else assert.equal(link, null);
    } finally { h.close(); }
  }
});

// 4f review round 2: a bound playlist that isn't JE's any more (deleted and made again with the same id) is "lost".
test('a playlist replaced by another with the same name reads as lost, with no link and no Remove', async () => {
  const h = setup({ reply: () => answer({ playlist: { optedIn: false, state: 'lost', reason: 'identity', canRemove: false } }) });
  try {
    h.open(); await tick();
    assert.match(h.host().textContent, /arr_ready_state_lost/);
    assert.equal(h.host().querySelector('a[href]'), null);
    assert.doesNotMatch(h.host().textContent, /arr_ready_remove|arr_ready_forget/);
  } finally { h.close(); }
});

test('a playlist id that is not a plain id never becomes a link', async () => {
  const h = setup({ reply: () => answer({ playlist: { optedIn: true, state: 'active', playlistId: 'javascript:alert(1)' } }) });
  try {
    h.open(); await tick();
    assert.equal(h.host().querySelector('a'), null);
  } finally { h.close(); }
});

test('Remove needs a second press and then removes once', async () => {
  const h = setup({
    reply: (path) => (path === '/acquire/ready/remove'
      ? { outcome: 'removed', status: answer({ playlist: { state: 'removed' } }) }
      : answer({ playlist: { optedIn: false, state: 'off', playlistId: ID, canRemove: true } })),
  });
  try {
    h.open(); await tick();
    const button = h.host().querySelector('[data-je-focus="ready-remove"]');
    button.click();
    await tick();
    assert.equal(h.calls.filter(c => c.path === '/acquire/ready/remove').length, 0);
    assert.equal(button.textContent, 'arr_ready_remove_confirm');
    button.click();
    await tick();
    assert.equal(h.calls.filter(c => c.path === '/acquire/ready/remove').length, 1);
    assert.match(h.host().textContent, /arr_ready_removed/);
    assert.match(h.host().textContent, /arr_ready_state_removed/);
    assert.equal(h.host().querySelector('[data-je-focus="ready-remove"]'), null);
  } finally { h.close(); }
});

test('a shared playlist is offered as "stop managing", and Remove reports it was kept (4f review round 1)', async () => {
  const h = setup({
    reply: (path) => (path === '/acquire/ready/remove'
      ? { outcome: 'kept', status: answer({ playlist: { state: 'removed', reason: 'kept' } }) }
      : answer({ playlist: { optedIn: true, state: 'privacy', reason: 'shared', playlistId: ID, canRemove: true } })),
  });
  try {
    h.open(); await tick();
    const button = h.host().querySelector('[data-je-focus="ready-remove"]');
    assert.equal(button.textContent, 'arr_ready_forget');
    button.click(); await tick();
    button.click(); await tick();
    assert.match(h.host().textContent, /arr_ready_kept/);
    assert.match(h.host().textContent, /arr_ready_state_kept/);
    assert.doesNotMatch(h.host().textContent, /arr_ready_removed|arr_ready_state_removed/);
  } finally { h.close(); }
});

test('a Remove the server didn\'t make says so instead of claiming it was removed', async () => {
  const h = setup({
    reply: (path) => (path === '/acquire/ready/remove'
      ? { outcome: 'changed', status: answer({ playlist: { optedIn: true, state: 'active', playlistId: ID, canRemove: true } }) }
      : answer({ playlist: { optedIn: true, state: 'active', playlistId: ID, canRemove: true } })),
  });
  try {
    h.open(); await tick();
    const button = h.host().querySelector('[data-je-focus="ready-remove"]');
    assert.equal(button.textContent, 'arr_ready_remove');
    button.click(); await tick();
    button.click(); await tick();
    assert.match(h.host().textContent, /arr_ready_save_failed/);
    assert.doesNotMatch(h.host().textContent, /arr_ready_removed/);
  } finally { h.close(); }
});

test('focus stays on the same control across a re-render (keyboard and TV remotes)', async () => {
  const h = setup({ reply: (path, o) => (o.method === 'PUT' ? answer({ playlist: { optedIn: true, state: 'active', playlistId: ID } }) : answer()) });
  try {
    h.open(); await tick();
    const box = h.host().querySelector('[data-je-focus="ready-playlist"]');
    box.focus();
    box.checked = true; box.dispatchEvent(new h.window.Event('change'));
    await tick();
    assert.equal(h.document.activeElement?.dataset?.jeFocus, 'ready-playlist');
  } finally { h.close(); }
});

test('a server that can\'t answer shows a plain message, no controls', async () => {
  const h = setup({ reply: () => Promise.reject(new Error('offline')) });
  try {
    h.open(); await tick();
    assert.match(h.host().textContent, /arr_ready_panel_unavailable/);
    assert.equal(h.host().querySelector('input'), null);
  } finally { h.close(); }
});
