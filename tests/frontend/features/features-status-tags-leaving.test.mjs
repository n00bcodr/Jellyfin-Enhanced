import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The two opt-in Status families: Leaving soon (server-resolved Leaving facts
// on the tag cache entry) and the web direct-play warning
// (tags/tag-direct-play.js over a mocked PlaybackInfo endpoint, with idle
// slices driven by hand).

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12);
const OLD = NOW - 400 * DAY;
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));
const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key] || key);
const card = id => `<div class="card" data-id="${id}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>`;
const movie = fields => ({ Type: 'Movie', TmdbId: '1', DateCreated: OLD, PremiereDate: OLD, ...fields });
const show = fields => ({ Type: 'Series', TmdbId: '100', DateCreated: OLD, PremiereDate: OLD, ...fields });
const episode = fields => ({ Type: 'Episode', SeriesId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', SeasonNumber: 1, EpisodeNumber: 2, DateCreated: OLD, PremiereDate: OLD, ...fields });
const leaving = deleteAt => ({ Leaving: deleteAt === undefined ? {} : { DeleteAt: deleteAt } });

/** A PlaybackInfo answer: direct play, a remux (container only) or a transcode with reasons. */
function playback(kind) {
  const streams = [{ Type: 'Video', Codec: 'hevc', Index: 0 }, { Type: 'Audio', Codec: 'dts', Index: 1 }];
  if (kind === 'direct') return { MediaSources: [{ SupportsDirectPlay: true, SupportsDirectStream: true, Container: 'mp4', MediaStreams: streams, DefaultAudioStreamIndex: 1 }] };
  if (kind === 'remux') return { MediaSources: [{ SupportsDirectPlay: false, SupportsDirectStream: true, Container: 'mkv', TranscodeReasons: ['ContainerNotSupported'], MediaStreams: streams }] };
  return { MediaSources: [{ SupportsDirectPlay: false, SupportsDirectStream: false, Container: 'mkv', TranscodeReasons: ['VideoCodecNotSupported', 'AudioCodecNotSupported'], MediaStreams: streams, DefaultAudioStreamIndex: 1 }] };
}

/** The direct-play request deadline (tag-direct-play.js DEADLINE_MS). */
const DEADLINE_MS = 15000;

/**
 * Status Tags with the direct-play module. PlaybackInfo answers come from
 * `answer(id)` (a kind for playback(), or a function throwing), each request
 * (a fetch) is recorded, and may be held until released; a held request is
 * aborted by its signal like a real fetch, unless `honourAbort` is false.
 * Request deadlines only pass when a test calls expire(). Idle slices only
 * run when a test calls slice(); IntersectionObserver entries only when it
 * calls intersect() (or, with autoIntersect, on observe).
 */
function setup(t, { settings = {}, plugin = {}, cards = 3, answer = () => 'transcode', hold = false, honourAbort = true, autoIntersect = true, store = null, apiClient = {} } = {}) {
  const renderers = new Map();
  const userChange = new Map();
  const requests = [];
  const pending = [];
  const network = { open: 0, peak: 0 };
  const idle = [];
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); if (autoIntersect) this.callback([{ target, isIntersecting: true }]); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const h = createHarness({
    html: Array.from({ length: cards }, (_, i) => card(`c${i}`)).join(''),
    globals: { IntersectionObserver: Observer, requestIdleCallback: (fn) => { idle.push(fn); return idle.length; } },
    JE: {
      currentSettings: { statusTagsEnabled: true, statusTagsTrending: false, ...settings },
      pluginConfig: { StatusTagsEnabled: true, TmdbEnabled: false, TagCacheServerMode: true, ...plugin },
      t: translate,
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userChange.set(name, fn) },
      _cacheManager: { register() {}, markDirty() {} },
      tagCacheStore: store || undefined,
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, r) => renderers.set(name, { ...r, render: (el, item, extras = {}) => r.render(el, item, { stripRevision: 'none', ...extras }) }), getRenderer: name => renderers.get(name), peekServerEntry: () => null, clearProcessed() {}, scheduleScan() {} },
    },
    apiClient: {
      getUrl: (path, params) => (params ? `${path}?${new URLSearchParams(params)}` : path),
      getCurrentUserId: () => 'user-a',
      ajax: async (request) => {
        assert.ok(request.url.includes('status-tags/trending'), `unexpected ApiClient request ${request.url}`);
        return { source: null, movies: {}, series: {} };
      },
      ...apiClient,
    },
    fetch: async (url, init) => {
      const id = /Items\/([^/]+)\/PlaybackInfo/.exec(url)?.[1];
      assert.ok(id, `unexpected request ${url}`);
      assert.equal(init.method, 'POST');
      requests.push({ id, body: JSON.parse(init.body), url, headers: init.headers, signal: init.signal });
      network.open++;
      network.peak = Math.max(network.peak, network.open);
      try {
        if (hold) {
          await new Promise((resolve, reject) => {
            pending.push(resolve);
            if (honourAbort) init.signal.addEventListener('abort', () => reject(new h.window.DOMException('The operation was aborted.', 'AbortError')), { once: true });
          });
        }
        const kind = answer(id);
        if (kind instanceof Error) throw kind;
        return { ok: true, status: 200, json: async () => playback(kind) };
      } finally { network.open--; }
    },
  });
  t.after(() => h.close());
  // Request deadlines pass by hand (expire()); every other timer is real.
  const deadlines = [];
  const realSetTimeout = h.window.setTimeout.bind(h.window);
  const realClearTimeout = h.window.clearTimeout.bind(h.window);
  h.window.setTimeout = (fn, ms, ...rest) => {
    if (ms !== DEADLINE_MS) return realSetTimeout(fn, ms, ...rest);
    const timer = { fn };
    deadlines.push(timer);
    return timer;
  };
  h.window.clearTimeout = (timer) => {
    const at = deadlines.indexOf(timer);
    if (at >= 0) deadlines.splice(at, 1);
    else realClearTimeout(timer);
  };
  let now = NOW;
  h.window.Date.now = () => now;
  h.document.documentElement.setAttribute('lang', 'en-US');
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-direct-play.js', 'tags/status-vocabulary.js', 'tags/statustags.js']) h.load(file);
  h.JE.initializeStatusTags();
  const hosts = [...h.document.querySelectorAll('.je-tag-host')];
  const renderer = renderers.get('status');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return Object.assign(h, {
    hosts, requests, idle, observers, userChange, renderer, network, deadlines,
    setNow(ms) { now = ms; },
    show(entry, host = hosts[0], id = 'item1') {
      delete host.closest('.card').dataset.jeStatusTagged;
      host.querySelectorAll('.status-overlay-container').forEach(n => n.remove());
      renderer.renderFromServerCache(host, entry, id);
      return host;
    },
    intersect(host, isIntersecting = true) { observers.forEach(o => o.callback([{ target: host, isIntersecting }])); },
    chip: (host = hosts[0]) => host.querySelector('.status-tag'),
    badge: (host = hosts[0]) => host.querySelector('.status-tag')?.textContent ?? null,
    /** Run the idle slices queued so far, with this much idle time each. */
    async slice(timeRemaining = 50) {
      const queued = idle.splice(0);
      for (const fn of queued) fn({ timeRemaining: () => timeRemaining, didTimeout: false });
      await settle(); await settle();
    },
    /** Answer every held request. */
    async release() { pending.splice(0).forEach(r => r()); await settle(); await settle(); },
    /** Answer the oldest held request. */
    async releaseOne() { pending.shift()?.(); await settle(); await settle(); },
    /** Let every pending request deadline pass. */
    async expire() { deadlines.splice(0).forEach(timer => timer.fn()); await settle(); await settle(); },
    settle,
  });
}

const LEAVING = { settings: { statusTagsLeaving: true }, plugin: { LeavingSoonAvailable: true } };

for (const [name, entry, expected] of [
  ['days left', movie(leaving(NOW + 5 * DAY)), ['leaving', 'Leaving in 5d']],
  ['tomorrow', show(leaving(NOW + DAY)), ['leaving', 'Leaving tomorrow']],
  ['today', episode(leaving(NOW + 3600000)), ['leaving', 'Leaving today']],
  ['no date', movie(leaving()), ['leaving', 'Leaving soon']],
  ['date passed', movie(leaving(NOW - DAY)), ['leaving', 'Leaving soon']],
  ['a time no Date holds reads as undated', movie(leaving(9e15)), ['leaving', 'Leaving soon']],
  ['before every other badge', movie({ ...leaving(NOW + 2 * DAY), DateCreated: NOW - DAY, PremiereDate: NOW - 2 * DAY }), ['leaving', 'Leaving in 2d']],
  ['not on a collection', { Type: 'BoxSet', DateCreated: OLD, ...leaving(NOW + 2 * DAY) }, null],
]) {
  test(`Leaving soon: ${name}`, t => {
    const h = setup(t, LEAVING);
    h.show(entry);
    assert.deepEqual(h.chip() ? [h.chip().dataset.jeStatus, h.badge()] : null, expected);
    if (expected) assert.ok(h.chip().classList.contains('status-tag--leaving'));
  });
}

test('Leaving soon is off by default, needs the server source, and reads /tag-data items and the fallback cache', t => {
  const entry = movie(leaving(NOW + 5 * DAY));
  const off = setup(t, { plugin: { LeavingSoonAvailable: true } });
  off.show(entry);
  assert.equal(off.chip(), null, 'family off by default');
  const noSource = setup(t, { settings: { statusTagsLeaving: true } });
  noSource.show(entry);
  assert.equal(noSource.chip(), null, 'no source on the server');
  const adminDefault = setup(t, { plugin: { LeavingSoonAvailable: true, StatusTagsLeaving: true } });
  adminDefault.show(entry);
  assert.equal(adminDefault.badge(), 'Leaving in 5d', 'the administrator default applies without a personal value');

  const h = setup(t, LEAVING);
  const host = h.hosts[1];
  h.renderer.render(host, { Id: 'item2', ProviderIds: { Tmdb: '2' }, ...movie(leaving(NOW + 3 * DAY)) }, {});
  assert.equal(h.badge(host), 'Leaving in 3d');
  delete host.closest('.card').dataset.jeStatusTagged;
  host.querySelectorAll('.status-overlay-container').forEach(n => n.remove());
  assert.equal(h.renderer.renderFromCache(host, 'item2'), true, 'the browser fallback copy keeps the facts');
  assert.equal(h.badge(host), 'Leaving in 3d');
});

test('Leaving soon counts local calendar days and redraws at midnight', t => {
  const h = setup(t, LEAVING);
  // 23:30 local time: an hour later is "tomorrow", not "today".
  const deleteAt = new Date(2026, 9, 31, 0, 30).getTime();
  h.setNow(new Date(2026, 9, 30, 23, 30).getTime());
  h.show(movie(leaving(deleteAt)));
  assert.equal(h.badge(), 'Leaving tomorrow');
  h.setNow(new Date(2026, 9, 31, 0, 5).getTime());
  h.JE.reinitializeStatusTags();
  h.show(movie(leaving(deleteAt)));
  assert.equal(h.badge(), 'Leaving today');
});

test('direct play: classify reads the first source, reasons from the answer or the transcoding URL', () => {
  const h = createHarness({ JE: { t: translate } });
  try {
    h.load('tags/tag-direct-play.js');
    const dp = h.JE.tagDirectPlay;
    assert.equal(dp.classify(playback('direct')).directPlay, true);
    const remux = dp.classify(playback('remux'));
    assert.deepEqual([remux.directPlay, remux.remux, remux.container], [false, true, 'mkv']);
    const transcode = dp.classify(playback('transcode'));
    assert.deepEqual([transcode.remux, transcode.video, transcode.audio], [false, 'hevc', 'dts']);
    assert.equal(dp.describe(transcode, 'Transcode'), 'Transcode: video codec hevc, audio codec dts');
    const fromUrl = dp.classify({ MediaSources: [{ SupportsDirectPlay: false, TranscodingUrl: '/videos/x/master.m3u8?TranscodeReasons=ContainerBitrateExceedsLimit,SubtitleCodecNotSupported', MediaStreams: [] }] });
    assert.deepEqual([...fromUrl.reasons], ['ContainerBitrateExceedsLimit', 'SubtitleCodecNotSupported']);
    assert.equal(dp.describe(fromUrl, 'Transcode'), 'Transcode: bitrate, subtitles');
    assert.equal(dp.describe({ ...fromUrl, reasons: ['SomethingNew'] }, 'Transcode'), 'Transcode: other');
    assert.equal(dp.classify({ MediaSources: [] }), null);
    // The profile has jellyfin-web's shape and a stable hash (its contents: the fixture test below).
    const profile = dp.profile();
    assert.ok(Array.isArray(profile.DirectPlayProfiles) && Array.isArray(profile.CodecProfiles) && Array.isArray(profile.SubtitleProfiles));
    assert.equal(profile.MaxStaticBitrate, 100000000);
    assert.match(dp.profileHash(), /^[0-9a-f]{8}$/);
    assert.equal(dp.profileHash(), dp.profileHash());
    dp.setProfile({ DirectPlayProfiles: [] });
    assert.notEqual(dp.profileHash(), null);
    assert.deepEqual(dp.profile(), { DirectPlayProfiles: [] });
  } finally { h.close(); }
});

/** A value from the page's realm as a plain one (deepEqual compares prototypes). */
const plain = value => JSON.parse(JSON.stringify(value));
const WEB_PROFILE = JSON.parse(readFileSync(new URL('../../fixtures/direct-play-web-12.1-chromium.json', import.meta.url), 'utf8'));

/**
 * The module in a browser that answers like the one the fixture was
 * captured in: its user agent, canPlayType answers (per element type),
 * speaker count, MediaSource and text tracks, and the case's local settings.
 */
function capturedBrowser(t, kase, { userAgent = WEB_PROFILE.userAgent, apiClient = {}, session = {} } = {}) {
  const h = createHarness({
    JE: { t: translate, session: { getUserId: () => 'u1', ...session } },
    apiClient: { getCurrentUserId: () => 'u1', getSavedEndpointInfo: () => ({}), ...apiClient },
    globals: {
      MediaSource: function MediaSource() {},
      AudioContext: class { constructor() { this.destination = { maxChannelCount: WEB_PROFILE.env.speakers }; } close() { return Promise.resolve(); } },
    },
  });
  t.after(() => h.close());
  Object.defineProperty(h.window.navigator, 'userAgent', { value: userAgent, configurable: true });
  const { HTMLMediaElement, HTMLAudioElement } = h.window;
  HTMLMediaElement.prototype.canPlayType = function canPlayType(type) { return kase.canPlayType[`${this instanceof HTMLAudioElement ? 'audio' : 'video'}|${type}`] ?? ''; };
  Object.defineProperty(HTMLMediaElement.prototype, 'textTracks', { get: () => (WEB_PROFILE.env.textTracks ? [] : undefined), configurable: true });
  h.window.HTMLCanvasElement.prototype.getContext = () => ({}); // Chromium draws 2D (PGS rendering needs it)
  Object.defineProperty(HTMLMediaElement.prototype, 'audioTracks', { get: () => (WEB_PROFILE.env.audioTracks ? [] : undefined), configurable: true });
  for (const [key, value] of Object.entries(kase.settings)) h.window.localStorage.setItem(key.replace(/^USER-/, 'u1-'), value);
  h.load('tags/tag-direct-play.js');
  return h;
}

for (const kase of WEB_PROFILE.cases) {
  test(`direct play: the profile is jellyfin-web 12.1's own (captured in Chromium): ${kase.name}`, t => {
    const dp = capturedBrowser(t, kase).JE.tagDirectPlay;
    assert.deepEqual(plain(dp.webProfile(kase.options)), kase.profile);
    // In use: the app host's options for a video and its (here unset) width/codec settings.
    assert.deepEqual(plain(dp.profile()), kase.profile);
    assert.equal(dp.bitrate(), kase.bitrate);
  });
}

test('direct play: the capabilities the review found missing or wrong follow jellyfin-web 12.1', t => {
  const [defaults, settings] = WEB_PROFILE.cases;
  const p = plain(capturedBrowser(t, defaults).JE.tagDirectPlay.profile());
  const codec = name => p.CodecProfiles.find(c => c.Type === 'Video' && c.Codec === name).Conditions;
  const value = (conditions, property) => conditions.find(c => c.Property === property)?.Value;
  // HDR: desktop Chrome tone-maps, so HDR10/HDR10+/HLG direct play on an SDR screen too; H.264 stays SDR.
  for (const name of ['hevc', 'vp9', 'av1']) assert.equal(value(codec(name), 'VideoRangeType'), 'SDR|HDR10|HDR10Plus|HLG');
  assert.equal(value(codec('h264'), 'VideoRangeType'), 'SDR');
  // Interlaced H.264/HEVC is not direct play in a browser; levels are bounded.
  for (const name of ['h264', 'hevc']) assert.deepEqual(codec(name).find(c => c.Property === 'IsInterlaced'), { Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true', IsRequired: false });
  assert.ok(value(codec('hevc'), 'VideoLevel') && value(codec('av1'), 'VideoLevel'));
  // Subtitles: VTT, ASS and SSA; PGS only when the user turns its rendering on.
  assert.deepEqual(p.SubtitleProfiles.map(s => s.Format), ['vtt', 'ass', 'ssa']);
  const pgs = capturedBrowser(t, settings).JE.tagDirectPlay.profile();
  assert.ok(pgs.SubtitleProfiles.some(s => s.Format === 'pgssub'));
  // MOV with H.264, MP2 audio in video, the static ceiling.
  assert.equal(p.DirectPlayProfiles.find(d => d.Container === 'mov')?.VideoCodec, 'h264');
  assert.ok(p.DirectPlayProfiles.find(d => d.Container === 'mp4,m4v').AudioCodec.split(',').includes('mp2'));
  assert.equal(p.MaxStaticBitrate, 100000000);
  // Matroska follows the browser rules, not "any Chromium": Firefox never gets it, nor does a Chromium without the canPlayType answer.
  assert.ok(p.DirectPlayProfiles.some(d => d.Container === 'mkv'));
  const firefox = capturedBrowser(t, defaults, { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }).JE.tagDirectPlay.profile();
  assert.ok(!firefox.DirectPlayProfiles.some(d => d.Container === 'mkv'));
  const noMkv = { ...defaults, canPlayType: Object.fromEntries(Object.entries(defaults.canPlayType).filter(([k]) => !/matroska|mkv/.test(k))) };
  assert.ok(!capturedBrowser(t, noMkv).JE.tagDirectPlay.profile().DirectPlayProfiles.some(d => d.Container === 'mkv'));
});

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

test('direct play: a native shell builds its profile with the ported builder, also when it answers later', async t => {
  const [defaults] = WEB_PROFILE.cases;
  const h = capturedBrowser(t, defaults);
  let handed = null;
  h.window.NativeShell = { AppHost: { getDeviceProfile: (builder, version) => { handed = { builder, version }; return Promise.resolve({ ...builder({ enableMkvProgressive: false }), Name: 'shell' }); } } };
  h.JE.tagDirectPlay.setProfile(null);
  assert.notEqual(h.JE.tagDirectPlay.profile().Name, 'shell', 'the browser profile until the shell answers');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof handed.builder, 'function');
  assert.equal(h.JE.tagDirectPlay.profile().Name, 'shell');
  assert.deepEqual(plain(h.JE.tagDirectPlay.profile().SubtitleProfiles), defaults.profile.SubtitleProfiles);
  // Its generation and inputs still hold: it stays in use, and the shell is not asked again.
  const hash = h.JE.tagDirectPlay.profileHash();
  handed = null;
  await nextTask();
  assert.equal(h.JE.tagDirectPlay.profile().Name, 'shell');
  assert.equal(h.JE.tagDirectPlay.profileHash(), hash);
  assert.equal(handed, null);
});

/** Write one fixture case's local settings for a user (null: remove them). */
function writeSettings(h, kase, user, remove = false) {
  for (const [key, value] of Object.entries(kase.settings)) {
    const name = key.replace(/^USER-/, `${user}-`);
    if (remove) h.window.localStorage.removeItem(name);
    else h.window.localStorage.setItem(name, value);
  }
}


test('direct play: the profile and its hash follow the signed-in user and the playback settings changed in this page', async t => {
  const [defaults, settings, burnIn] = WEB_PROFILE.cases;
  let user = 'u1';
  const hooks = new Map();
  const h = capturedBrowser(t, defaults, { apiClient: { getCurrentUserId: () => user }, session: { getUserId: () => user, onUserChange: (name, fn) => hooks.set(name, fn) } });
  const dp = h.JE.tagDirectPlay;
  const host = h.document.createElement('div');
  h.document.body.append(host);
  dp.track(host, 'm1', () => {}); // registers the session hook
  const a = { profile: plain(dp.profile()), hash: dp.profileHash() };
  assert.deepEqual(a.profile, defaults.profile);

  // User B keeps other per-user settings (2 channels, TS-HLS, short segments).
  // The hook runs before B's id is in place; the profile follows once it is.
  for (const [key, value] of Object.entries(settings.settings)) if (key.startsWith('USER-')) h.window.localStorage.setItem(key.replace(/^USER-/, 'u2-'), value);
  hooks.get('direct-play')();
  assert.deepEqual(plain(dp.profile()), a.profile, 'still user A until the switch completes');
  user = 'u2';
  await nextTask();
  const b = { profile: plain(dp.profile()), hash: dp.profileHash() };
  assert.notEqual(b.hash, a.hash);
  assert.notDeepEqual(b.profile, a.profile);
  assert.deepEqual(b.profile, plain(dp.webProfile(defaults.options)), "B's profile is built from B's settings");
  assert.ok(b.profile.TranscodingProfiles.some(p => p.Type === 'Video' && p.MaxAudioChannels === '2' && p.Container === 'ts'));
  assert.ok(b.profile.TranscodingProfiles.some(p => p.SegmentLength === 1));

  // B changes global playback settings mid-session: the next task's profile is jellyfin-web's own for them.
  writeSettings(h, settings, 'u2');
  assert.deepEqual(plain(dp.profile()), b.profile, 'the settings are compared once per task (the bitrate on every call)');
  await nextTask();
  assert.deepEqual(plain(dp.profile()), settings.profile);
  assert.equal(dp.bitrate(), settings.bitrate);
  writeSettings(h, settings, 'u2', true);
  writeSettings(h, burnIn, 'u2');
  await nextTask();
  assert.deepEqual(plain(dp.profile()), burnIn.profile, 'burn-in, remux and VBR settings rebuild too');
  assert.equal(dp.bitrate(), burnIn.bitrate);

  // Back to A with the same settings as before: the same profile and hash (A's stored answers apply again).
  writeSettings(h, burnIn, 'u2', true);
  hooks.get('direct-play')();
  user = 'u1';
  await nextTask();
  assert.deepEqual(plain(dp.profile()), a.profile);
  assert.equal(dp.profileHash(), a.hash);
});

test('direct play: a native shell answer for an earlier build never replaces the current profile', async t => {
  const [defaults] = WEB_PROFILE.cases;
  let user = 'u1';
  const h = capturedBrowser(t, defaults, { apiClient: { getCurrentUserId: () => user }, session: { getUserId: () => user } });
  const answers = [];
  h.window.NativeShell = { AppHost: { getDeviceProfile: (builder) => { const who = user; return new Promise(resolve => answers.push(() => resolve({ ...builder({}), Name: `shell-${who}` }))); } } };
  const dp = h.JE.tagDirectPlay;
  dp.setProfile(null);
  dp.profile();
  user = 'u2';
  await nextTask();
  dp.profile();
  assert.equal(answers.length, 2, 'built again for the next user');
  answers[1]();
  await nextTask();
  assert.equal(dp.profile().Name, 'shell-u2');
  answers[0](); // the first user's late answer
  await nextTask();
  assert.equal(dp.profile().Name, 'shell-u2');
});

test('direct play: a native answer pending across a user switch is dropped, and the next user gets their own build', async t => {
  const [defaults, settings] = WEB_PROFILE.cases;
  let user = 'u1';
  const hooks = new Map();
  const h = capturedBrowser(t, defaults, { apiClient: { getCurrentUserId: () => user }, session: { getUserId: () => user, onUserChange: (name, fn) => hooks.set(name, fn) } });
  for (const [key, value] of Object.entries(settings.settings)) if (key.startsWith('USER-')) h.window.localStorage.setItem(key.replace(/^USER-/, 'u2-'), value);
  const asked = [];
  h.window.NativeShell = { AppHost: { getDeviceProfile: (builder) => { const answer = { ...builder(defaults.options), Name: `shell-${user}` }; return new Promise(resolve => asked.push({ user, answer, resolve: () => resolve(answer) })); } } };
  const dp = h.JE.tagDirectPlay;
  dp.track(h.document.createElement('div'), 'm1', () => {}); // registers the session hook (and builds)
  dp.profile();
  assert.equal(asked.length, 1);
  // The switch completes, then the old user's answer arrives before anything asks for a profile.
  hooks.get('direct-play')();
  user = 'u2';
  asked[0].resolve();
  await nextTask();
  assert.notEqual(dp.profile().Name, 'shell-u1', "the old user's answer is never used");
  assert.equal(asked.length, 2, 'built again for the new user');
  assert.equal(asked[1].user, 'u2');
  asked[1].resolve();
  await nextTask();
  assert.equal(dp.profile().Name, 'shell-u2');
  assert.deepEqual(plain(dp.profile()), plain(asked[1].answer));
  assert.ok(dp.profile().TranscodingProfiles.some(p => p.Type === 'Video' && p.MaxAudioChannels === '2'), "built from the new user's settings");
  // And when the hook runs before the new id is in place, the answer built for the old id is dropped too.
  hooks.get('direct-play')();
  dp.profile();
  assert.equal(asked.length, 3);
  assert.equal(asked[2].user, 'u2');
  user = 'u1';
  asked[2].resolve();
  await nextTask();
  assert.notEqual(dp.profile().Name, 'shell-u2');
  assert.equal(asked.length, 4);
  assert.equal(asked[3].user, 'u1');
});

test('direct play: a setting changed while a native answer is pending drops that answer and builds again', async t => {
  const [defaults] = WEB_PROFILE.cases;
  const h = capturedBrowser(t, defaults);
  const asked = [];
  h.window.NativeShell = { AppHost: { getDeviceProfile: (builder) => { const answer = builder(defaults.options); return new Promise(resolve => asked.push(() => resolve(answer))); } } };
  const dp = h.JE.tagDirectPlay;
  dp.setProfile(null);
  dp.profile();
  assert.equal(asked.length, 1);
  // No lookup in between notices the change: the answer itself is checked against the live settings.
  h.window.localStorage.setItem('subtitleburnin', 'all');
  asked[0]();
  await nextTask();
  const fresh = plain(dp.webProfile(defaults.options));
  assert.deepEqual(fresh.SubtitleProfiles, []);
  assert.deepEqual(plain(dp.profile()), fresh, 'the old answer (with subtitle profiles) is not used');
  assert.equal(asked.length, 2, 'the shell is asked again with the new settings');
  asked[1]();
  await nextTask();
  assert.deepEqual(plain(dp.profile()), fresh);
  assert.equal(asked.length, 2);
});

test('direct play: a playback setting changed in this page asks again with the new profile', async t => {
  const h = setup(t, { settings: { statusTagsDirectPlay: true } });
  const dp = h.JE.tagDirectPlay;
  h.show(movie(), h.hosts[0], 'm1');
  await h.slice(); await h.slice();
  assert.ok(dp.peek('m1'));
  const before = dp.profileHash();
  h.window.localStorage.setItem('subtitleburnin', 'all');
  await h.settle();
  assert.notEqual(dp.profileHash(), before);
  assert.equal(dp.peek('m1'), null, 'the answer was for the previous profile');
  h.show(movie(), h.hosts[0], 'm1');
  await h.slice(); await h.slice();
  assert.equal(h.requests.length, 2);
  assert.notDeepEqual(h.requests[1].body.DeviceProfile, h.requests[0].body.DeviceProfile);
  assert.deepEqual(h.requests[1].body.DeviceProfile, plain(dp.profile()));
  assert.equal(h.badge(h.hosts[0]), 'Transcode');
});

test('direct play: off by default and for non-playable or otherwise badged cards, no request goes out', async t => {
  const off = setup(t);
  off.show(movie(), off.hosts[0], 'm1');
  await off.slice();
  assert.equal(off.requests.length, 0);
  const h = setup(t, { settings: { statusTagsDirectPlay: true } });
  h.show(show(), h.hosts[0], 's1');
  h.show(movie({ DateCreated: NOW - DAY }), h.hosts[1], 'm2'); // Just Added wins
  await h.slice();
  assert.equal(h.requests.length, 0);
  assert.equal(h.badge(h.hosts[1]), 'Just Added');
});

test('direct play: a visible card is asked about in an idle slice, with this browser\'s profile, and gets the warning with its reasons', async t => {
  const h = setup(t, { settings: { statusTagsDirectPlay: true }, answer: id => (id === 'm2' ? 'remux' : id === 'm3' ? 'direct' : 'transcode') });
  h.show(movie(), h.hosts[0], 'm1');
  h.show(episode(), h.hosts[1], 'm2');
  h.show(movie(), h.hosts[2], 'm3');
  assert.equal(h.requests.length, 0, 'nothing outside an idle slice');
  assert.equal(h.chip(), null);
  await h.slice();
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id).sort(), ['m1', 'm2', 'm3']);
  const body = h.requests[0].body;
  assert.equal(body.UserId, 'user-a');
  assert.equal(body.EnableDirectPlay, true);
  assert.equal(body.AutoOpenLiveStream, false);
  assert.deepEqual(body.DeviceProfile, JSON.parse(JSON.stringify(h.JE.tagDirectPlay.profile())));
  // The user's saved quality for this network is what is asked with, and is part of the answer's key.
  assert.equal(body.MaxStreamingBitrate, h.JE.tagDirectPlay.bitrate());
  assert.match(h.requests[0].url, new RegExp(`MaxStreamingBitrate=${body.MaxStreamingBitrate}`));
  const hash = h.JE.tagDirectPlay.profileHash();
  h.window.localStorage.setItem('maxbitrate-Video-undefined', '4000000');
  assert.equal(h.JE.tagDirectPlay.bitrate(), 4000000);
  assert.notEqual(h.JE.tagDirectPlay.profileHash(), hash);
  h.window.localStorage.removeItem('maxbitrate-Video-undefined');
  await h.slice();
  assert.equal(h.badge(h.hosts[0]), 'Transcode');
  assert.equal(h.chip(h.hosts[0]).title, 'Transcode: video codec hevc, audio codec dts');
  assert.equal(h.chip(h.hosts[0]).getAttribute('aria-label'), h.chip(h.hosts[0]).title);
  assert.equal(h.chip(h.hosts[0]).dataset.jeStatus, 'direct_play');
  assert.equal(h.badge(h.hosts[1]), "Won't direct play");
  assert.equal(h.chip(h.hosts[1]).dataset.jeCompact, 'Remux');
  assert.equal(h.chip(h.hosts[2]), null, 'direct play shows nothing');
});

test('direct play: only cards on screen, two requests at a time, a few launches per slice, and only while idle time lasts', async t => {
  const h = setup(t, { cards: 12, settings: { statusTagsDirectPlay: true }, hold: true, autoIntersect: false });
  h.hosts.forEach((host, i) => h.show(movie(), host, `m${i}`));
  await h.slice();
  assert.equal(h.requests.length, 0, 'nothing is on screen yet');
  for (const host of h.hosts.slice(0, 10)) h.intersect(host);
  h.intersect(h.hosts[3], false); // scrolled away again before its turn
  await h.slice();
  assert.equal(h.requests.length, 2, 'at most two in flight');
  await h.slice();
  assert.equal(h.requests.length, 2, 'still two: none answered');
  await h.release();
  await h.slice();
  assert.equal(h.requests.length, 4);
  await h.release();
  await h.slice(1);
  assert.equal(h.requests.length, 4, 'no idle time left: no launch');
  for (let i = 0; i < 6; i++) { await h.release(); await h.slice(); }
  const asked = h.requests.map(r => r.id);
  assert.equal(new Set(asked).size, asked.length, 'each item once');
  assert.ok(!asked.includes('m3'), 'a card that left the screen is not asked about');
  assert.ok(!asked.includes('m10') && !asked.includes('m11'), 'off-screen cards are not asked about');
  assert.equal(asked.length, 9);
});

test('direct play: answers are kept a day per item and profile, failures retry later, a user switch drops what is in flight', async t => {
  const failing = new Set(['bad']);
  const h = setup(t, { settings: { statusTagsDirectPlay: true }, answer: id => (failing.has(id) ? new Error('down') : 'transcode') });
  h.show(movie(), h.hosts[0], 'm1');
  h.show(movie(), h.hosts[1], 'm1'); // the same item on another card
  h.show(movie(), h.hosts[2], 'bad');
  await h.slice(); await h.slice(); await h.slice();
  assert.deepEqual(h.requests.map(r => r.id).sort(), ['bad', 'm1']);
  assert.equal(h.badge(h.hosts[1]), 'Transcode', 'both cards of the item get the answer');
  assert.equal(h.chip(h.hosts[2]), null, 'a failed lookup shows nothing');
  h.show(movie(), h.hosts[2], 'bad');
  await h.slice(); await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'bad').length, 1, 'not asked again before the retry delay');
  h.setNow(NOW + 10 * 60 * 1000 + 1);
  failing.clear();
  h.show(movie(), h.hosts[2], 'bad');
  await h.slice(); await h.slice(); await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'bad').length, 2, 'asked again after it');
  assert.equal(h.badge(h.hosts[2]), 'Transcode');
  h.setNow(NOW);
  // Drawn again within the day: from memory, no request.
  h.show(movie(), h.hosts[0], 'm1');
  assert.equal(h.badge(h.hosts[0]), 'Transcode');
  await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'm1').length, 1);
  // Another profile is another key.
  h.JE.tagDirectPlay.setProfile({ Name: 'restrictive', DirectPlayProfiles: [] });
  h.show(movie(), h.hosts[0], 'm1');
  assert.equal(h.chip(h.hosts[0]), null, 'no answer for this profile yet');
  await h.slice(); await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'm1').length, 2);
  assert.deepEqual(h.requests.at(-1).body.DeviceProfile, { Name: 'restrictive', DirectPlayProfiles: [] });
  // A day later the answer is asked for again.
  h.setNow(NOW + DAY + 1);
  h.show(movie(), h.hosts[0], 'm1');
  await h.slice(); await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'm1').length, 3);
  // A user switch: an answer for the previous user is never shown.
  const held = setup(t, { settings: { statusTagsDirectPlay: true }, hold: true });
  held.show(movie(), held.hosts[0], 'x1');
  await held.slice();
  assert.equal(held.requests.length, 1);
  held.userChange.get('direct-play')();
  held.userChange.get('status-tags')();
  await held.release();
  await held.slice();
  assert.equal(held.JE.tagDirectPlay.peek('x1'), null);
  assert.equal(held.chip(), null);
});

test('direct play: a reset (renderer teardown, user switch) keeps the requests still on the network in their slots until they settle', async t => {
  const h = setup(t, { cards: 6, settings: { statusTagsDirectPlay: true }, hold: true });
  const dp = h.JE.tagDirectPlay;
  h.show(movie(), h.hosts[0], 'x1');
  h.show(movie(), h.hosts[1], 'y1');
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['x1', 'y1']);
  // Torn down while both are held; the next renderer tracks new cards (and x1 again).
  dp.reset();
  h.show(movie(), h.hosts[2], 'z1');
  h.show(movie(), h.hosts[3], 'x1');
  await h.slice(); await h.slice();
  assert.equal(h.requests.length, 2, 'no third request while the two old ones are on the network');
  assert.equal(dp.stats().inFlight, 2);
  // A user switch on top of that changes nothing about the budget either.
  h.userChange.get('direct-play')();
  h.show(movie(), h.hosts[2], 'z1');
  h.show(movie(), h.hosts[3], 'x1');
  await h.slice();
  assert.equal(h.requests.length, 2);
  // The oldest settles: one slot, one new request; its stale answer is dropped.
  await h.releaseOne();
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['x1', 'y1', 'z1']);
  assert.equal(dp.peek('x1'), null, 'an answer from before the reset is never used');
  await h.releaseOne(); // y1 (stale): the second slot frees
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['x1', 'y1', 'z1', 'x1']);
  // x1 is asked once in this session: another card of it joins the lookup in flight.
  h.show(movie(), h.hosts[4], 'x1');
  await h.slice();
  assert.equal(h.requests.filter(r => r.id === 'x1').length, 2);
  await h.release(); await h.slice(); await h.slice();
  assert.equal(h.badge(h.hosts[3]), 'Transcode');
  assert.equal(h.badge(h.hosts[4]), 'Transcode', 'the joining card gets the answer too');
  assert.equal(h.network.peak, 2, 'never more than two requests on the network');
  assert.equal(dp.stats().inFlight, 0);
});

/**
 * jellyfin-apiclient's identity and its setRequestHeaders, as Jellyfin 12.1's
 * bundle has them (node_modules.jellyfin-apiclient.bundle.js).
 */
function realApiClient({ withSetRequestHeaders = true } = {}) {
  const api = {
    _appName: 'Jellyfin Web', _appVersion: '12.1.0', _deviceName: 'Chrome', _deviceId: 'TW96aWxsYS81LjAgdGVzdA11',
    _serverInfo: { AccessToken: 'session-token' },
    serverInfo() { return this._serverInfo; },
    accessToken() { return this._serverInfo.AccessToken; },
    appName() { return this._appName; },
    appVersion() { return this._appVersion; },
    deviceName() { return this._deviceName; },
    deviceId() { return this._deviceId; },
  };
  if (withSetRequestHeaders) {
    api.setRequestHeaders = function setRequestHeaders(headers) {
      const values = [];
      const accessToken = this.serverInfo().AccessToken;
      if (this._appName) values.push(`Client="${this._appName}"`);
      if (this._deviceName) values.push(`Device="${this._deviceName}"`);
      if (this._deviceId) values.push(`DeviceId="${this._deviceId}"`);
      if (this._appVersion) values.push(`Version="${this._appVersion}"`);
      if (accessToken) values.push(`Token="${accessToken}"`);
      if (values.length) headers.Authorization = `MediaBrowser ${values.join(', ')}`;
    };
  }
  return api;
}

for (const withSetRequestHeaders of [true, false]) {
  test(`direct play: a PlaybackInfo request carries ApiClient's own authorization, client and device (${withSetRequestHeaders ? 'setRequestHeaders' : 'composed from its accessors'})`, async t => {
    const h = setup(t, { settings: { statusTagsDirectPlay: true }, apiClient: realApiClient({ withSetRequestHeaders }) });
    h.show(movie(), h.hosts[0], 'm1');
    await h.slice(); await h.slice();
    assert.equal(h.requests.length, 1);
    const { headers } = h.requests[0];
    const expected = {};
    realApiClient().setRequestHeaders.call(h.window.ApiClient, expected);
    assert.equal(headers.Authorization, expected.Authorization, "the same Authorization ApiClient sends for this client");
    assert.equal(headers.Authorization, 'MediaBrowser Client="Jellyfin Web", Device="Chrome", DeviceId="TW96aWxsYS81LjAgdGVzdA11", Version="12.1.0", Token="session-token"');
    assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers.Accept, 'application/json');
    assert.equal(h.badge(h.hosts[0]), 'Transcode');
  });
}

test('direct play: when ApiClient\'s own header writer sets no Authorization, none is composed from its accessors', async t => {
  // Signed out: setRequestHeaders writes nothing, as ApiClient.ajax would send the request.
  const apiClient = realApiClient();
  apiClient.setRequestHeaders = function setRequestHeaders() {};
  const h = setup(t, { settings: { statusTagsDirectPlay: true }, apiClient });
  h.show(movie(), h.hosts[0], 'm1');
  await h.slice(); await h.slice();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys(h.requests[0].headers).sort(), ['Accept', 'Content-Type'], 'no Authorization is synthesised behind the writer\'s back');
});

test('direct play: a request that never settles is aborted at its deadline and frees its slot, also across a reset and a user switch', async t => {
  const h = setup(t, { cards: 6, settings: { statusTagsDirectPlay: true }, hold: true });
  const dp = h.JE.tagDirectPlay;
  h.show(movie(), h.hosts[0], 's1');
  h.show(movie(), h.hosts[1], 's2');
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['s1', 's2']);
  assert.equal(h.requests[0].headers.Authorization, 'MediaBrowser Token="test-token"');
  assert.ok(h.requests.every(r => !r.signal.aborted));
  assert.equal(h.deadlines.length, 2, 'each request has a deadline');
  // Neither ever answers. A reset and a user switch keep their slots; the new session waits.
  dp.reset();
  h.userChange.get('direct-play')();
  h.show(movie(), h.hosts[2], 'n1');
  h.show(movie(), h.hosts[3], 'n2');
  h.show(movie(), h.hosts[4], 'n3');
  await h.slice(); await h.slice();
  assert.equal(h.requests.length, 2);
  // The deadline aborts both: two slots free, two new requests (never more than two on the network).
  await h.expire();
  assert.ok(h.requests.slice(0, 2).every(r => r.signal.aborted));
  assert.equal(dp.stats().inFlight, 0);
  assert.equal(dp.stats().timedOut, 2);
  await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['s1', 's2', 'n1', 'n2']);
  assert.equal(h.network.peak, 2);
  // Answered ones clear their deadline; the third goes next.
  await h.release(); await h.slice(); await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['s1', 's2', 'n1', 'n2', 'n3']);
  assert.equal(h.deadlines.length, 1);
  await h.release(); await h.slice(); await h.slice();
  for (const host of h.hosts.slice(2, 5)) assert.equal(h.badge(host), 'Transcode');
  assert.equal(h.network.peak, 2);
  assert.equal(dp.stats().inFlight, 0);
});

test('direct play: a stalled item counts as failed and is asked again only after the retry delay; an answer after the deadline is ignored', async t => {
  // A fetch that ignores the abort and answers late (the slot must not wait for it).
  const h = setup(t, { cards: 3, settings: { statusTagsDirectPlay: true }, hold: true, honourAbort: false, answer: () => 'remux' });
  const dp = h.JE.tagDirectPlay;
  h.show(movie(), h.hosts[0], 'st');
  await h.slice();
  await h.expire();
  assert.ok(h.requests[0].signal.aborted);
  assert.equal(dp.stats().inFlight, 0, 'the slot frees at the deadline');
  await h.release(); // the late answer
  await h.slice();
  assert.equal(dp.peek('st'), null, 'a late answer is never used');
  assert.equal(h.chip(h.hosts[0]), null);
  assert.equal(dp.stats().failed, 1);
  assert.equal(dp.stats().answered, 0);
  h.show(movie(), h.hosts[0], 'st');
  await h.slice(); await h.slice();
  assert.equal(h.requests.length, 1, 'not asked again before the retry delay');
  h.setNow(NOW + 10 * 60 * 1000 + 1);
  h.show(movie(), h.hosts[0], 'st');
  await h.slice();
  await h.release(); await h.slice(); await h.slice();
  assert.equal(h.requests.length, 2);
  assert.equal(h.badge(h.hosts[0]), "Won't direct play");
});

test('direct play: stored answers are restored before any request, and new ones are written per scope and profile', async t => {
  const puts = [];
  const hash = { value: null };
  const store = {
    available: () => true,
    getDirectPlay: async (scope, profileHash) => {
      hash.value = profileHash;
      assert.equal(scope, 'server-a:user-a');
      return new Map([['m1', { r: { directPlay: false, remux: true, reasons: ['ContainerNotSupported'], container: 'mkv', video: 'h264', audio: 'aac' }, t: NOW - 1000 }]]);
    },
    putDirectPlay: async (scope, profileHash, values, cap) => { puts.push({ scope, profileHash, ids: [...values.keys()], cap }); },
  };
  const h = setup(t, { settings: { statusTagsDirectPlay: true }, store });
  h.show(movie(), h.hosts[0], 'm1');
  h.show(movie(), h.hosts[1], 'm2');
  await h.settle();
  await h.slice(); await h.slice(); await h.slice();
  assert.deepEqual(h.requests.map(r => r.id), ['m2'], 'the stored item is not asked about');
  assert.equal(h.badge(h.hosts[0]), "Won't direct play");
  assert.equal(h.chip(h.hosts[0]).title, "Won't direct play: container mkv");
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.deepEqual(puts, [{ scope: 'server-a:user-a', profileHash: hash.value, ids: ['m2'], cap: 2000 }]);
});
