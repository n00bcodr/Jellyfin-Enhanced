// Active Streams header widget: visibility, admin-only broadcast and identity ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';
import { chromeJs, fakeSession, isBaseline, settle } from './helpers.mjs';

const playing = (extra = {}) => ({ UserId: 'u2', UserName: '<b>Viewer</b>', Client: 'Web', DeviceName: 'Chrome', UserHasPrimaryImage: true,
  NowPlayingItem: { Id: 'movie', Name: '<img src=x onerror=alert(1)>', RunTimeTicks: 600000000, ProductionYear: 2020, ImageTags: { Primary: 'tag' },
    MediaStreams: [{ Type: 'Video', Codec: 'h264', BitRate: 8000000 }, { Type: 'Audio', Codec: 'eac3' }] },
  PlayState: { IsPaused: false, PositionTicks: 300000000, PlayMethod: 'Transcode' },
  TranscodingInfo: { IsVideoDirect: false, VideoCodec: 'hevc', AudioCodec: 'aac', Bitrate: 2500000, Width: 1920, Height: 1080, Framerate: 23.976,
    CompletionPercentage: 75, TranscodeReasons: ['AudioCodecNotSupported'] }, ...extra });

function streams(t, { admin = true, allUsers = false, api, prefetched } = {}) {
  let user = 'admin-a', isAdmin = admin;
  const calls = [], navigations = [];
  const session = fakeSession(() => user);
  const h = createHarness({ html: '<div class="headerRight" id="tray"><button id="native">x</button></div>',
    apiClient: { getCurrentUserId: () => user, getImageUrl: (id, o) => `http://jellyfin.test/Items/${id}/Images/${o.type}?tag=${o.tag}` },
    JE: { pluginConfig: { ActiveStreamsEnabled: true, ActiveStreamsAllUsers: allUsers }, session, t: key => key === 'active_streams_count' ? '{count} stream|{count} streams' : '',
      takePrefetched: (name, age) => { calls.push(['prefetched', name, age]); return prefetched; },
      helpers: { isAdmin: () => isAdmin, getHeaderButtonTray: () => h.document.getElementById('tray'), getHeaderBottom: () => 60, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: { api: { plugin: async (path, options) => { calls.push([path, options]); return api ? api(path, options) : []; } },
        lifecycle: { register: () => { const resources = []; return { track: r => (resources.push(r), r), teardown: () => resources.splice(0).forEach(r => r()) }; } },
        navigation: { onNavigate: fn => { navigations.push(fn); return () => navigations.splice(navigations.indexOf(fn), 1); } } } } });
  t.after(() => {
    // The baseline stylesheet is unparseable (CHR-STREAMS-2); tolerate only that, only for the baseline comparison run.
    if (isBaseline) for (let i = h.errors.length - 1; i >= 0; i--) if (h.errors[i].message === 'Could not parse CSS stylesheet') h.errors.splice(i, 1);
    h.close();
  });
  h.load(chromeJs('extras/active-streams.js'));
  const $ = selector => h.document.querySelector(selector);
  return { ...h, calls, navigations, session, $, reads: () => calls.filter(([path]) => path === '/active-streams/sessions').length,
    posts: () => calls.filter(([path]) => path === '/active-streams/broadcast'),
    signIn(next, nextAdmin) { user = next; isAdmin = nextAdmin; },
    open() { $('#je-active-streams').click(); } };
}

test('active streams: an administrator gets the header counter, the panel and the broadcast control', async t => {
  const h = streams(t, { prefetched: [playing()] });
  h.JE.activeStreams.initialize();
  await settle();
  const button = h.$('#je-active-streams');
  assert.equal(h.$('#tray').firstElementChild, button, 'counter is inserted first in the shared tray');
  assert.deepEqual(h.calls[0], ['prefetched', 'ActiveStreamSessions', 5000]);
  assert.equal(h.reads(), 0, 'the fresh bootstrap copy serves the first count');
  assert.equal(button.title, '1 active stream');
  assert.equal(button.querySelector('.je-as-sup').textContent, '1');
  assert.ok(button.classList.contains('je-as-active'));
  assert.ok(h.$('#je-active-streams-panel .je-as-broadcast-btn'));
  assert.equal(h.$('#je-active-streams-panel').style.top, '62px');
});

test('active streams: visibility follows the admin policy and ActiveStreamsAllUsers', async t => {
  const hidden = streams(t, { admin: false });
  hidden.JE.activeStreams.initialize();
  assert.equal(hidden.$('#je-active-streams'), null);
  const viewer = streams(t, { admin: false, allUsers: true });
  viewer.JE.activeStreams.initialize();
  await settle();
  assert.ok(viewer.$('#je-active-streams'));
  assert.equal(viewer.$('.je-as-broadcast-btn'), null, 'non-admins never get the broadcast control');
});

test('active streams: opening the panel renders escaped sessions, badges, progress and the admin IP', async t => {
  const h = streams(t, { api: async () => [playing({ RemoteEndPoint: '10.0.0.5' }), { UserName: 'idle' }] });
  h.JE.activeStreams.initialize(); await settle();
  h.open(); await settle();
  const card = h.$('.je-as-card');
  assert.equal(h.$('.je-as-panel-title').textContent, '1 stream');
  assert.equal(card.querySelector('.je-as-card-title-link').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.document.querySelector('.je-as-card img[onerror]'), null);
  assert.deepEqual([...card.querySelectorAll('.je-as-badge')].map(b => b.textContent),
    ['Transcoding', 'HEVC', 'AAC', '2.5 Mbps', '1920×1080', '24fps', 'Audio Codec Not Supported', 'EAC3 → AAC']);
  assert.equal(card.querySelector('.je-as-progress-time').textContent, '0:30 / 1:00');
  assert.equal(card.querySelector('.je-as-progress-fill').style.width, '50%');
  assert.equal(card.querySelector('.je-as-transcode-fill').style.width, '75%');
  assert.ok([...card.querySelectorAll('.je-as-user span')].some(span => span.textContent === '10.0.0.5'));
  assert.match(h.$('.je-as-panel-footer').textContent, /^Updated /);
});

test('active streams: broadcast sends once without retry and reports the result', async t => {
  const h = streams(t, { api: async path => path.endsWith('broadcast') ? { sent: 2, skipped: 1, errors: ['x'] } : [] });
  h.JE.activeStreams.initialize(); await settle();
  h.open(); await settle();
  h.$('.je-as-broadcast-btn').click();
  h.$('.je-as-broadcast-textarea').value = ' Restarting ';
  h.$('.je-as-broadcast-send').click(); await settle();
  assert.deepEqual(plain(h.posts()), [['/active-streams/broadcast', { method: 'POST', body: { header: null, text: 'Restarting', timeoutMs: 10000 }, skipRetry: true }]]);
  assert.equal(h.$('.je-as-broadcast-result').textContent, 'Sent to 2 of 3 sessions (1 error)');
  assert.ok(h.$('.je-as-broadcast-result').classList.contains('je-as-broadcast-ok'));
});

test('active streams: an HTTP broadcast failure surfaces the server response body', async t => {
  const h = streams(t, { api: async path => { if (path.endsWith('broadcast')) throw Object.assign(new Error('403'), { status: 403, responseText: 'Forbidden' }); return []; } });
  h.JE.activeStreams.initialize(); await settle();
  h.open(); await settle();
  h.$('.je-as-broadcast-btn').click();
  h.$('.je-as-broadcast-textarea').value = 'hi';
  h.$('.je-as-broadcast-send').click(); await settle();
  assert.equal(h.$('.je-as-broadcast-result').textContent, 'Error: Forbidden');
});

test('active streams: an account switch tears down and the next account is rebuilt with its own policy', async t => {
  const h = streams(t);
  h.JE.activeStreams.initialize(); await settle();
  h.signIn('viewer-b', false);
  h.JE.pluginConfig.ActiveStreamsAllUsers = true;
  const epoch = h.session.change();
  assert.equal(h.$('#je-active-streams'), null);
  assert.equal(h.$('#je-active-streams-panel'), null);
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: { userId: 'viewer-b', epoch } }));
  await settle();
  assert.ok(h.$('#je-active-streams'));
  assert.equal(h.$('.je-as-broadcast-btn'), null);
});

// CHR-STREAMS-1: work started for one account must never act as or render for another.
test('CHR-STREAMS-1 active streams: a broadcast form left from an admin account cannot send as the next account', async t => {
  const h = streams(t);
  h.JE.activeStreams.initialize(); await settle();
  h.open(); await settle();
  h.$('.je-as-broadcast-btn').click();
  h.$('.je-as-broadcast-textarea').value = 'hello';
  h.signIn('viewer-b', false); // credentials replaced; the reset has not been delivered yet
  h.$('.je-as-broadcast-send').click(); await settle();
  assert.equal(h.posts().length, 0, 'no broadcast with the next account\'s credentials');
  assert.equal(h.$('#je-active-streams-panel'), null, 'the stale admin panel is removed');
});

test('CHR-STREAMS-1 active streams: an admin session read resolving after an account switch is not shown', async t => {
  const pending = deferred();
  const h = streams(t, { api: () => pending.promise });
  h.JE.activeStreams.initialize(); await settle();
  h.signIn('viewer-b', false);
  h.open();
  pending.resolve([playing({ RemoteEndPoint: '10.0.0.5' })]);
  await settle();
  assert.equal(h.document.body.textContent.includes('10.0.0.5'), false, 'admin-only IP not rendered for the next account');
  assert.equal(h.$('.je-as-card'), null);
});

// CHR-STREAMS-2: a missing selector dropped the timeout row and timeout label styles.
test('CHR-STREAMS-2 active streams: the broadcast timeout row and label styles are present', async t => {
  const h = streams(t);
  h.JE.activeStreams.initialize(); await settle();
  const rules = [...h.$('#je-active-streams-styles').sheet.cssRules].map(rule => rule.selectorText);
  assert.ok(rules.includes('.je-as-broadcast-timeout-row'));
  assert.ok(rules.includes('.je-as-broadcast-timeout-label'));
});

// CHR-STREAMS-3: a non-array body threw an unhandled TypeError instead of showing the error state.
test('CHR-STREAMS-3 active streams: a malformed sessions body shows the failure state', async t => {
  const h = streams(t, { api: async () => ({ error: 'proxy page' }) });
  let unhandled = 0; const count = () => unhandled++; process.on('unhandledRejection', count); t.after(() => process.off('unhandledRejection', count));
  h.JE.activeStreams.initialize(); await settle();
  assert.equal(unhandled, 0);
  assert.equal(h.$('#je-active-streams').title, 'Failed to fetch sessions');
  assert.ok(h.$('#je-active-streams').classList.contains('je-as-err'));
});

// CHR-STREAMS-4: boot and the user-data reload both initialize; listeners must not double.
test('CHR-STREAMS-4 active streams: repeated initialization for the same account reads once per navigation', async t => {
  const h = streams(t);
  h.JE.activeStreams.initialize(); await settle();
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: { userId: 'admin-a', epoch: h.session.epoch } }));
  await settle();
  const before = h.reads();
  for (const navigate of [...h.navigations]) navigate();
  await settle();
  assert.equal(h.reads() - before, 1);
  assert.equal(h.document.querySelectorAll('#je-active-streams').length, 1);
});

test('CHR-STREAMS-5 active streams: a stale user-data announcement for a replaced account is ignored', async t => {
  const h = streams(t);
  const stale = h.session.epoch;
  h.session.change();
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded', { detail: { userId: 'admin-a', epoch: stale } }));
  await settle();
  assert.equal(h.$('#je-active-streams'), null);
});
