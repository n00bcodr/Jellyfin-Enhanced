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

/**
 * Status Tags with the direct-play module. PlaybackInfo answers come from
 * `answer(id)` (a kind for playback(), or a function throwing), each request
 * is recorded, and may be held until released. Idle slices only run when a
 * test calls slice(); IntersectionObserver entries only when it calls
 * intersect() (or, with autoIntersect, on observe).
 */
function setup(t, { settings = {}, plugin = {}, cards = 3, answer = () => 'transcode', hold = false, autoIntersect = true, store = null } = {}) {
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
        if (request.url.includes('status-tags/trending')) return { source: null, movies: {}, series: {} };
        const id = /Items\/([^/]+)\/PlaybackInfo/.exec(request.url)?.[1];
        assert.ok(id, `unexpected request ${request.url}`);
        assert.equal(request.type, 'POST');
        requests.push({ id, body: JSON.parse(request.data), url: request.url });
        network.open++;
        network.peak = Math.max(network.peak, network.open);
        try {
          if (hold) await new Promise(resolve => pending.push(resolve));
          const kind = answer(id);
          if (kind instanceof Error) throw kind;
          return playback(kind);
        } finally { network.open--; }
      },
    },
  });
  t.after(() => h.close());
  let now = NOW;
  h.window.Date.now = () => now;
  h.document.documentElement.setAttribute('lang', 'en-US');
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-direct-play.js', 'tags/status-vocabulary.js', 'tags/statustags.js']) h.load(file);
  h.JE.initializeStatusTags();
  const hosts = [...h.document.querySelectorAll('.je-tag-host')];
  const renderer = renderers.get('status');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return Object.assign(h, {
    hosts, requests, idle, observers, userChange, renderer, network,
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
function capturedBrowser(t, kase, { userAgent = WEB_PROFILE.userAgent, apiClient = {} } = {}) {
  const h = createHarness({
    JE: { t: translate, session: { getUserId: () => 'u1' } },
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
