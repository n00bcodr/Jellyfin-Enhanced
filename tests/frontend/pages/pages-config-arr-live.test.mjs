import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The configuration page's "Live updates status" block (Requests & downloads, phase 1): run its
// real helpers in a fresh realm against a scripted admin API.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const createEl = block('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const helpers = block('        function jeArrLiveConnectionText(s) {', '        /** Reconstructs a Sonarr/Radarr');
const plain = value => JSON.parse(JSON.stringify(value));

const live = {
  enabled: true,
  instances: [
    { id: 'r1', name: 'Radarr', kind: 'Radarr', usable: true, liveUpdates: 'auto',
      signalR: { state: 'Connected', since: '2026-10-12T10:00:00Z', version: '6.0.4', reconnects: 2 },
      webhook: { secretSet: true, lastEventAt: '2026-10-12T10:05:00Z', lastEventType: 'Grab', refused: 1, silent: true } },
    { id: 's1', name: 'Sonarr <b>', kind: 'Sonarr', usable: true, liveUpdates: 'off',
      signalR: { state: 'Off' }, webhook: { secretSet: false } },
    { id: 'r2', name: 'Old', kind: 'Radarr', usable: true, liveUpdates: 'auto',
      signalR: { state: 'Waiting', lastError: 'The API key was rejected.' }, webhook: { secretSet: false } },
  ]
};

function setup(t, { confirm = true, respond } = {}) {
  const requests = [];
  const h = createHarness({
    html: '<input id="arrWebhookJellyfinUrl" value="http://jf:8096"><div id="arrLiveResult"></div>',
    apiClient: {
      ajax: async options => { requests.push(options); return respond(options); },
    },
  });
  h.window.confirm = message => { requests.push({ confirm: message }); return confirm; };
  h.window.crypto.getRandomValues = arr => arr;
  t.after(() => h.close());
  h.window.eval(`${createEl}\nfunction jeNewGuid() { return 'guid-1'; }\n${helpers}\nwindow.__je = { jeArrLiveConnectionText, jeArrLiveWebhookText, jeArrLiveStatus, jeArrLiveWebhookAction, jeArrLiveManual };`);
  return { ...h, je: h.window.__je, requests, out: () => h.document.getElementById('arrLiveResult') };
}

test('live status lists each instance with its connection, webhook and actions (text only)', async t => {
  const h = setup(t, { respond: async () => live });
  await h.je.jeArrLiveStatus();
  const rows = h.out().querySelectorAll('.je-arr-check-row');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Live connection: connected since .* · v6\.0\.4 · 2 reconnect\(s\)/);
  assert.match(rows[0].textContent, /Webhook: set up · last event .*\(Grab\) · 1 refused · no events for a day/);
  assert.ok(rows[0].classList.contains('je-arr-check-ok'));
  assert.deepEqual(plain([...rows[0].querySelectorAll('button')].map(b => b.textContent)), ['Repair webhook', 'Copy-paste set-up', 'Remove webhook']);
  // Names are text, never markup.
  assert.equal(rows[1].querySelector('b'), null);
  assert.match(rows[1].textContent, /Sonarr <b> \(Sonarr, live updates off\)/);
  assert.ok(rows[1].classList.contains('je-arr-check-off'));
  assert.deepEqual(plain([...rows[1].querySelectorAll('button')].map(b => b.textContent)), ['Set up instant updates', 'Copy-paste set-up']);
  assert.match(rows[2].textContent, /reconnecting \(The API key was rejected\.\)/);
  assert.ok(rows[2].classList.contains('je-arr-check-bad'));

  assert.equal(h.je.jeArrLiveConnectionText({ state: 'Connecting' }), 'Live connection: connecting...');
  assert.equal(h.je.jeArrLiveConnectionText(null), 'Live connection: off');
  assert.equal(h.je.jeArrLiveWebhookText({ secretSet: false }), 'Webhook: not set up (optional).');
});

test('with phase 1 off only removal is offered; a 404 explains the switch', async t => {
  const h = setup(t, { respond: async () => ({ enabled: false, instances: [{ ...live.instances[0] }] }) });
  await h.je.jeArrLiveStatus();
  assert.match(h.out().textContent, /Phase 1 is off/);
  assert.deepEqual(plain([...h.out().querySelectorAll('button')].map(b => b.textContent)), ['Remove webhook']);
  const off = setup(t, { respond: async () => { throw { status: 404 }; } });
  await off.je.jeArrLiveStatus();
  assert.match(off.out().textContent, /Save with "Requests & downloads \(new\)" turned on/);
});

test('setting up asks for consent first and sends it with the address and one key per click', async t => {
  const outcomes = [];
  const h = setup(t, { respond: async options => {
    if (options.type === 'GET') return live;
    outcomes.push(options);
    return { status: 'Succeeded', readBack: 'Webhook set up; the test event reached Jellyfin.' };
  } });
  const note = h.document.createElement('div');
  await h.je.jeArrLiveWebhookAction(live.instances[0], 'provision', note);
  assert.match(h.requests[0].confirm, /add \(or update\) a webhook named "Jellyfin Enhanced" in Radarr .* http:\/\/jf:8096\/JellyfinEnhanced\/arr\/hook\//);
  assert.equal(outcomes[0].type, 'POST');
  assert.match(outcomes[0].url, /\/JellyfinEnhanced\/arr\/admin\/instances\/r1\/webhook$/);
  assert.deepEqual(JSON.parse(outcomes[0].data), { consent: true, jellyfinUrl: 'http://jf:8096', idempotencyKey: 'guid-1' });
  assert.equal(note.textContent, '✓ Webhook set up; the test event reached Jellyfin.');

  await h.je.jeArrLiveWebhookAction(live.instances[0], 'remove', note);
  assert.equal(outcomes[1].type, 'DELETE');

  const declined = setup(t, { confirm: false, respond: async () => { throw new Error('must not be called'); } });
  await declined.je.jeArrLiveWebhookAction(live.instances[0], 'provision', note);
  assert.equal(declined.requests.filter(r => r.type).length, 0);

  const failing = setup(t, { respond: async options => { if (options.type === 'GET') return live; throw { status: 400 }; } });
  await failing.je.jeArrLiveWebhookAction(live.instances[0], 'provision', note);
  assert.match(note.textContent, /Enter Jellyfin's address as Radarr sees it/);
});

test('the copy-paste set-up shows the address, header and triggers as text', async t => {
  const h = setup(t, { respond: async () => ({ url: 'http://jf:8096/JellyfinEnhanced/arr/hook/r1', method: 'POST', headerName: 'X-JE-Hook-Secret', headerValue: '<secret>', triggers: ['On Grab', 'On File Import'] }) });
  const note = h.document.createElement('div');
  await h.je.jeArrLiveManual(live.instances[0], note);
  assert.equal(h.requests[0].type, 'POST');
  assert.match(h.requests[0].url, /\/webhook\/manual$/);
  assert.match(note.textContent, /Webhook URL: http:\/\/jf:8096\/JellyfinEnhanced\/arr\/hook\/r1/);
  assert.match(note.textContent, /X-JE-Hook-Secret = <secret>/);
  assert.match(note.textContent, /Notification Triggers: On Grab, On File Import/);
  assert.equal(note.querySelector('secret'), null);
});

test('the live status button needs only the master switch (removal must stay reachable with phase 1 off)', () => {
  const deps = new Function(`return ${block('        var PARENT_DEPS = [', '        ];').replace('var PARENT_DEPS =', '')}];`)();
  const childOf = id => deps.filter(d => d.children.includes(id)).map(d => d.parent);
  assert.deepEqual(childOf('arrLiveCheckBtn'), ['arrIntegrationEnabled']);
  assert.deepEqual(childOf('arrWebhookJellyfinUrl'), ['arrPhase1Enabled']);
});
