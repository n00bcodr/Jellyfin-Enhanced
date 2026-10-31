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
        requests.push({ id, body: JSON.parse(request.data) });
        if (hold) await new Promise(resolve => pending.push(resolve));
        const kind = answer(id);
        if (kind instanceof Error) throw kind;
        return playback(kind);
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
    hosts, requests, idle, observers, userChange, renderer,
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
    // The browser profile: containers and codecs from canPlayType, an HLS fallback, a stable hash.
    const profile = dp.profile();
    assert.ok(profile.DirectPlayProfiles.some(p => p.Container === 'mp4,m4v'));
    assert.equal(profile.TranscodingProfiles[0].Protocol, 'hls');
    assert.match(dp.profileHash(), /^[0-9a-f]{8}$/);
    dp.setProfile({ DirectPlayProfiles: [] });
    assert.notEqual(dp.profileHash(), null);
    assert.deepEqual(dp.profile(), { DirectPlayProfiles: [] });
  } finally { h.close(); }
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
