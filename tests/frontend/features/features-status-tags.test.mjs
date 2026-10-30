import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const MINUTE = 60 * 1000;
const card = id => `<div class="card" data-id="${id}"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>`;

/**
 * Status Tags over the real tag-renderer factory, with a controllable clock
 * and a queue of trending endpoint answers (an Error entry rejects).
 */
function setup(t, answers) {
  const renderers = new Map();
  const calls = [];
  /** clearProcessed / scheduleScan calls: a reinitialize asks the pipeline to render every card again. */
  const rescans = [];
  const h = createHarness({
    html: card('a') + card('b'),
    JE: {
      currentSettings: { statusTagsEnabled: true },
      pluginConfig: { StatusTagsEnabled: true, TagCacheServerMode: false },
      t: key => key,
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() { rescans.push('clear'); }, scheduleScan() { rescans.push('scan'); } }
    },
    apiClient: {
      ajax: async ({ url }) => {
        calls.push(url);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    }
  });
  t.after(() => h.close());
  let now = Date.UTC(2026, 9, 30);
  h.window.Date.now = () => now;
  h.load('core/ui-kit.js');
  h.load('core/tag-renderer-base.js');
  h.load('tags/statustags.js');
  h.JE.initializeStatusTags();
  const hosts = [...h.document.querySelectorAll('.je-tag-host')];
  const old = now - 400 * 24 * 60 * MINUTE;
  return Object.assign(h, {
    calls, hosts, rescans,
    advance: ms => { now += ms; },
    render: (el, tmdb) => renderers.get('status').render(el, { Id: `m${tmdb}`, Type: 'Movie', ProviderIds: { Tmdb: String(tmdb) }, DateCreated: old, PremiereDate: old }),
    badge: el => el.querySelector('.status-tag')?.textContent ?? null,
    settle: () => new Promise(resolve => setImmediate(resolve))
  });
}

test('a refreshed trending list re-badges the cards already on the page', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} },
    { source: 'tmdb-day', movies: { 2: 1 }, series: {} }
  ]);
  await h.settle();
  h.render(h.hosts[0], 1); h.render(h.hosts[1], 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  assert.equal(h.badge(h.hosts[1]), null);

  h.advance(29 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 1, 'a usable list is kept for 30 minutes');

  h.advance(2 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.badge(h.hosts[0]), null, 'a title that dropped off loses its rank');
  assert.equal(h.hosts[0].querySelector('.status-overlay-container'), null);
  assert.equal(h.badge(h.hosts[1]), '#1 Today', 'a newly trending title gets its rank');
});

test('a trending answer that lands after the cache was dropped does not redraw the old cards', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} }
  ]);
  const renderer = h.JE.tagPipeline.getRenderer('status');
  // Rendered while the list is still loading: no badge yet, card tracked.
  h.render(h.hosts[0], 1);
  assert.equal(h.badge(h.hosts[0]), null);
  // The pipeline drops its cache (Spoiler Guard / access change, user switch)
  // and removes every overlay before re-rendering from replacement entries.
  renderer.onServerCacheRefresh(null);
  h.hosts[0].querySelectorAll('.status-overlay-container').forEach(n => n.remove());
  await h.settle();
  assert.equal(h.badge(h.hosts[0]), null, 'the stale record must not be redrawn by the late answer');
  // Rendered again from the replacement entry: badged from the list now in hand.
  delete h.hosts[0].closest('.card').dataset.jeStatusTagged;
  h.render(h.hosts[0], 1);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
});

test('a replacement cache swapped in under the cards reinitializes the status badges', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} }
  ]);
  await h.settle();
  const renderer = h.JE.tagPipeline.getRenderer('status');
  h.render(h.hosts[0], 1);
  // A season card: not a trending candidate, but just as stale after a replacement.
  renderer.render(h.hosts[1], { Id: 's1', Type: 'Season', DateCreated: h.window.Date.now() - 400 * 24 * 60 * MINUTE, LatestEpisodeAdded: h.window.Date.now() - 60 * MINUTE });
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  assert.equal(h.badge(h.hosts[1]), 'New Episode');
  // Tag Styles target each badge kind through data-je-status.
  assert.equal(h.hosts[0].querySelector('.status-tag').dataset.jeStatus, 'trending');
  assert.equal(h.hosts[1].querySelector('.status-tag').dataset.jeStatus, 'newEpisode');
  renderer.onServerCacheRefresh(null, { replaced: true });
  assert.equal(h.badge(h.hosts[0]), null, 'every status overlay is removed');
  assert.equal(h.badge(h.hosts[1]), null);
  assert.deepEqual(h.rescans, ['clear', 'scan'], 'the pipeline is asked to render the cards again');
  // The pipeline renders them again from the replacement entries.
  renderer.render(h.hosts[1], { Id: 's1', Type: 'Season', DateCreated: h.window.Date.now() - 400 * 24 * 60 * MINUTE, LatestEpisodeAdded: h.window.Date.now() - 300 * 24 * 60 * MINUTE });
  assert.equal(h.badge(h.hosts[1]), null, 'drawn from the new dates: no longer a new episode');
});

test('a replaced or updated server cache also drops the fallback entries it had cached', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: {}, series: {} }
  ]);
  await h.settle();
  const renderer = h.JE.tagPipeline.getRenderer('status');
  const now = h.window.Date.now();
  const season = { Id: 's1', Type: 'Season', DateCreated: now - 400 * 24 * 60 * MINUTE, LatestEpisodeAdded: now - 60 * MINUTE };
  renderer.render(h.hosts[0], season);
  assert.equal(h.badge(h.hosts[0]), 'New Episode');
  h.hosts[0].querySelector('.status-overlay-container').remove();
  delete h.hosts[0].closest('.card').dataset.jeStatusTagged;
  assert.equal(renderer.renderFromCache(h.hosts[0], 's1'), true, 'a fresh fallback entry is a hit');
  h.hosts[0].querySelector('.status-overlay-container').remove();
  delete h.hosts[0].closest('.card').dataset.jeStatusTagged;
  renderer.onServerCacheRefresh(null, { replaced: true });
  assert.equal(renderer.renderFromCache(h.hosts[0], 's1'), false, 'after a replacement the old entry is not served');
  assert.equal(h.badge(h.hosts[0]), null);
  renderer.render(h.hosts[0], season);
  delete h.hosts[0].closest('.card').dataset.jeStatusTagged;
  h.hosts[0].querySelector('.status-overlay-container').remove();
  renderer.onServerCacheRefresh(['s1']);
  assert.equal(renderer.renderFromCache(h.hosts[0], 's1'), false, 'a delta drops just the entries it replaced');
});

test('a replacement cache does not draw anything while Status Tags is off', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} }
  ]);
  await h.settle();
  const renderer = h.JE.tagPipeline.getRenderer('status');
  h.render(h.hosts[0], 1);
  h.JE.currentSettings.statusTagsEnabled = false;
  renderer.onServerCacheRefresh(null, { replaced: true });
  assert.deepEqual(h.rescans, [], 'no re-render is requested for a disabled group');
});

test('a dropped cache (the pipeline re-renders) marks every record stale and leaves the overlays to the pipeline', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} },
    { source: 'tmdb-day', movies: {}, series: {} }
  ]);
  await h.settle();
  h.render(h.hosts[0], 1);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  h.JE.tagPipeline.getRenderer('status').onServerCacheRefresh(null);
  assert.equal(h.badge(h.hosts[0]), '#3 Today', 'the pipeline removes overlays itself on this path');
  assert.deepEqual(h.rescans, []);
  h.advance(31 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today', 'stale record: not redrawn by the refresh');
});

test('delta bookkeeping stays bounded: past the cap everything is marked stale instead', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} },
    { source: 'tmdb-day', movies: {}, series: {} }
  ]);
  await h.settle();
  h.render(h.hosts[0], 1);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  const ids = Array.from({ length: 2001 }, (_, i) => `x${i}`);
  h.JE.tagPipeline.getRenderer('status').onServerCacheRefresh(ids);
  h.advance(31 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.badge(h.hosts[0]), '#3 Today', 'marked stale wholesale rather than remembering 2001 ids');
});

test('a card detached during a delta is still stale when it comes back', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} },
    { source: 'tmdb-day', movies: {}, series: {} }
  ]);
  await h.settle();
  h.render(h.hosts[0], 1); h.render(h.hosts[1], 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  const cardA = h.hosts[0].closest('.card');
  const parent = cardA.parentNode;
  parent.removeChild(cardA);
  h.JE.tagPipeline.getRenderer('status').onServerCacheRefresh(['m1']);
  parent.appendChild(cardA);
  h.advance(31 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today', 'left alone until the pipeline renders it again');
});

test('a delta that replaced an item stops the trending pass re-badging it from old dates', async t => {
  const h = setup(t, [
    { source: 'tmdb-day', movies: { 1: 3 }, series: {} },
    { source: 'tmdb-day', movies: { 2: 1 }, series: {} }
  ]);
  await h.settle();
  h.render(h.hosts[0], 1); h.render(h.hosts[1], 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today');
  assert.equal(h.badge(h.hosts[1]), null);
  h.JE.tagPipeline.getRenderer('status').onServerCacheRefresh(['m1']);
  h.advance(31 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.badge(h.hosts[0]), '#3 Today', 'forgotten by the delta: left alone until the pipeline renders it again');
  assert.equal(h.badge(h.hosts[1]), '#1 Today', 'still tracked: re-badged from the new list');
});

test('an empty or failed trending answer is retried after 5 minutes, not 30', async t => {
  const h = setup(t, [
    { source: null, movies: {}, series: {} },
    new Error('upstream down'),
    { source: 'seerr-week', movies: { 1: 2 }, series: {} }
  ]);
  h.allowConsoleError(/trending/);
  await h.settle();
  h.render(h.hosts[0], 1);
  assert.equal(h.badge(h.hosts[0]), null);

  h.advance(4 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 1, 'no retry inside the short interval');

  h.advance(2 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 2, 'an empty answer is retried after 5 minutes');

  h.advance(6 * MINUTE); h.render(h.hosts[1], 2); await h.settle();
  assert.equal(h.calls.length, 3, 'a failed fetch is retried after 5 minutes');
  assert.equal(h.badge(h.hosts[0]), '#2 This Week', 'cards drawn before the list arrived are upgraded');
});
