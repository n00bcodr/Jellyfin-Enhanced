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


test('CHR-R1-002 same-id client/token replacement refuses the old broadcast form', async t => {
 const h=streams(t); h.JE.activeStreams.initialize(); await settle(); h.open(); await settle();
 h.$('.je-as-broadcast-btn').click(); h.$('.je-as-broadcast-textarea').value='old form';
 h.window.ApiClient={...h.window.ApiClient,accessToken:()=> 'replacement-token'};
 h.$('.je-as-broadcast-send').click(); await settle();
 assert.equal(h.posts().length,0);
});
test('CHR-R1-003 failed panel read is unavailable without a successful timestamp', async t => {
 const h=streams(t,{api:async()=>{throw new Error('offline')}});
 h.JE.activeStreams.initialize(); await settle(); h.open(); await settle();
 assert.equal(h.$('#je-active-streams').title,'Failed to fetch sessions');
 assert.equal(h.$('.je-as-panel-empty'),null); assert.ok(h.$('.je-as-panel-error'));
 assert.equal(h.$('.je-as-panel-footer').textContent,'');
});
