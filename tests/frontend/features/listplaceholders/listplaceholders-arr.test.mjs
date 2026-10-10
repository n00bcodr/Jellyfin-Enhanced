import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot, plain } from '../../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

const OPTIONS = {
  radarr: [{ id: 0, name: 'Movies', key: '0123456789abcdef', qualityProfiles: [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }], rootFolders: [{ path: '/movies', freeSpace: 2 * 1024 ** 4, accessible: true }] }],
  sonarr: [
    { id: 0, name: 'Broken', key: '1111111111111111', qualityProfiles: [], rootFolders: [], error: 'arr_unreachable', message: "Couldn't reach Broken." },
    { id: 1, name: 'TV <b>', key: 'feedfacecafebeef', qualityProfiles: [{ id: 1, name: 'Any' }, { id: 6, name: 'HD - 720p/1080p' }], rootFolders: [{ path: '/tv', accessible: true }, { path: '/anime', accessible: true }] }
  ],
  minimumAvailability: ['announced', 'inCinemas', 'released'],
  seriesTypes: ['standard', 'daily', 'anime']
};

const movie = { id: 'a'.repeat(32), kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013 };
const season = { id: 'b'.repeat(32), kind: 'season', mediaType: 'tv', tmdbId: 110492, title: 'Peacemaker', seasonNumber: 2, episodes: [] };
const episodes = { id: 'c'.repeat(32), kind: 'episodes', mediaType: 'tv', tmdbId: 110492, tvdbId: 391153, title: 'Peacemaker', seasonNumber: 1, episodes: [{ s: 1, e: 3 }, { s: 1, e: 5 }, { s: 2, e: 1 }] };
const custom = { id: 'd'.repeat(32), kind: 'custom', mediaType: 'movie', title: 'Rumoured' };

/**
 * Loads the real Seerr modal + the arr module with a stubbed JE (real en.json strings).
 * `reply(path, options)` answers JE.core.api.plugin; anything outside /list-placeholders/arr fails the test.
 */
function setup(t, { admin = true, enabled = true, arrEnabled = true, reply, preset } = {}) {
  const calls = [];
  const toasts = [];
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: enabled, ListPlaceholdersArrEnabled: arrEnabled },
    currentSettings: { isAdmin: admin },
    translations: en,
    escapeHtml,
    t: (key, params = {}) => {
      let text = en[key] ?? key;
      for (const [name, value] of Object.entries(params)) text = text.replace(new RegExp(`{${name}}`, 'g'), value);
      return text.replace(/\{\{icon:[a-zA-Z]+\}\}\s*/g, '');
    },
    session: { userScopedKey: (base) => `${base}:user-a` },
    toast: (html, ms) => toasts.push({ html, ms }),
    core: {
      api: {
        plugin: async (path, options = {}) => {
          calls.push({ path, options: plain({ ...options, signal: undefined }) });
          if (!path.startsWith('/list-placeholders/arr/')) throw new Error(`Unexpected route ${path}`);
          if (!reply) throw new Error(`No reply for ${path}`);
          return reply(path, options);
        }
      }
    },
    ...(preset ? { listPlaceholders: preset } : {})
  };
  const h = createHarness({ JE, apiClient: { serverAddress: () => 'http://jf.example:8096/' } });
  t.after(() => h.close());
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/listplaceholders/listplaceholders-arr.js');
  return { ...h, arr: h.JE.listPlaceholders.arr, calls, toasts };
}

/** Waits until `predicate()` is truthy (modal timers, promise chains). */
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const query = (path) => Object.fromEntries(new URL(`http://x${path}`).searchParams);

test('loading defines the API only: no network, no DOM, keeps an existing JE.listPlaceholders', async (t) => {
  const existing = { api: { marker: true } };
  const h = setup(t, { preset: existing });
  await sleep(320);
  assert.equal(h.calls.length, 0);
  assert.equal(h.document.body.children.length, 0);
  assert.equal(h.JE.listPlaceholders, existing);
  assert.equal(h.JE.listPlaceholders.api.marker, true);
  assert.equal(typeof h.arr.openAddDialog, 'function');
  assert.equal(typeof h.arr.lookup, 'function');
});

test('admin gating: only admins with both switches on get the action', async (t) => {
  for (const [opts, expected] of [[{}, true], [{ admin: false }, false], [{ enabled: false }, false], [{ arrEnabled: false }, false]]) {
    const h = setup(t, opts);
    assert.equal(h.arr.isAvailable(), expected, JSON.stringify(opts));
    assert.equal(h.arr.menuItemFor(movie) !== null, expected);
    assert.equal(h.arr.createAddButton(season) !== null, expected);
  }
  const viewer = setup(t, { admin: false });
  assert.equal(await viewer.arr.openAddDialog(movie), null);
  assert.equal((await viewer.arr.searchCandidates('steel')).length, 0);
  assert.equal(viewer.calls.length, 0);
  assert.equal(viewer.document.querySelector('.jellyseerr-season-modal'), null);
});

test('services, scopes and menu labels follow the placeholder kind', (t) => {
  const { arr } = setup(t);
  assert.equal(arr.serviceFor(movie), 'radarr');
  assert.equal(arr.serviceFor(season), 'sonarr');
  assert.equal(arr.serviceFor(custom), null);
  assert.equal(arr.serviceFor({ kind: 'movie', title: 'x' }), null);
  assert.equal(arr.serviceFor({ mediaType: 'movie', imdbId: 'tt0770828' }), 'radarr');
  assert.equal(arr.serviceFor({ mediaType: 'tv', tvdbId: 5 }), 'sonarr');
  assert.equal(arr.serviceFor({ mediaType: 'person', tmdbId: 5 }), null);
  assert.equal(arr.menuItemFor(custom), null);
  assert.equal(arr.menuItemFor(movie).label, 'Add to Radarr');
  assert.equal(arr.menuItemFor(season).label, 'Add to Sonarr');
  assert.deepEqual(plain(arr.scopeOf(movie)), { scope: 'movie' });
  assert.deepEqual(plain(arr.scopeOf({ ...season, kind: 'series', seasonNumber: undefined })), { scope: 'series' });
  assert.deepEqual(plain(arr.scopeOf(season)), { scope: 'season', seasonNumber: 2 });
  // Episodes of another season never leak into a single-season scope.
  assert.deepEqual(plain(arr.scopeOf(episodes)), { scope: 'episodes', seasonNumber: 1, episodes: [{ s: 1, e: 3 }, { s: 1, e: 5 }] });
  assert.equal(arr.scopeOf({ ...episodes, episodes: [{ s: 4, e: 1 }] }), null);
  assert.deepEqual(plain(arr.scopeOf({ mediaType: 'tv', tmdbId: 1, title: 'Show' })), { scope: 'series' });
  assert.equal(arr.describeScope(season), 'Monitors season 2 only. Other seasons and new ones stay unmonitored.');
  assert.equal(arr.describeScope(episodes), 'Monitors only S01E03, S01E05. Everything else stays unmonitored.');
  assert.equal(arr.describeScope(movie), 'Adds the movie, monitored.');
});

test('request bodies carry exactly the scope and the choices', (t) => {
  const { arr } = setup(t);
  const choices = { instance: 1, instanceName: 'TV', qualityProfileId: 6, rootFolderPath: '/tv', search: true, minimumAvailability: 'inCinemas', seriesType: 'anime' };
  assert.deepEqual(plain(arr.buildAddBody(movie, { ...choices, instance: 0, instanceName: 'Movies' }, 'r1')), {
    requestId: 'r1', mediaType: 'movie', instance: 0, instanceName: 'Movies', qualityProfileId: 6, rootFolderPath: '/tv', scope: 'movie', search: true, tmdbId: 49521, minimumAvailability: 'inCinemas'
  });
  assert.deepEqual(plain(arr.buildAddBody(season, choices, 'r2')), {
    requestId: 'r2', mediaType: 'tv', instance: 1, instanceName: 'TV', qualityProfileId: 6, rootFolderPath: '/tv', scope: 'season', search: true, tmdbId: 110492, seasonNumber: 2, seriesType: 'anime'
  });
  const ep = arr.buildAddBody(episodes, { ...choices, search: false, seriesType: '' }, 'r3');
  assert.deepEqual(plain(ep), {
    requestId: 'r3', mediaType: 'tv', instance: 1, instanceName: 'TV', qualityProfileId: 6, rootFolderPath: '/tv', scope: 'episodes', search: false, tmdbId: 110492, tvdbId: 391153, seasonNumber: 1, episodes: [{ s: 1, e: 3 }, { s: 1, e: 5 }]
  });
  const moviePlus = arr.buildAddBody({ ...movie, tvdbId: 9, imdbId: 'TT0770828' }, { ...choices, minimumAvailability: 'bogus' }, 'r4');
  assert.equal(moviePlus.tvdbId, undefined);
  assert.equal(moviePlus.imdbId, 'tt0770828');
  assert.equal(moviePlus.minimumAvailability, 'released');
  assert.equal(arr.buildAddBody(custom, choices), null);
  assert.match(arr.buildAddBody(movie, choices).requestId, /^[A-Za-z0-9_-]{1,64}$/);
});

test('dialog: picks a working instance, restores the remembered choice, posts the add and remembers again', async (t) => {
  let addBody;
  const h = setup(t, {
    reply: async (path, options) => {
      if (path === '/list-placeholders/arr/options?type=tv') return OPTIONS;
      if (path.startsWith('/list-placeholders/arr/lookup')) return { instance: { id: 1, name: 'TV <b>' }, results: [{ mediaType: 'tv', tvdbId: 391153, inArr: true }] };
      if (path === '/list-placeholders/arr/add') {
        addBody = options.body;
        return {
          result: 'added', title: 'Peace<maker>', arrPath: '/series/peacemaker', searched: true,
          instance: { service: 'sonarr', id: 1, name: 'TV <b>', instanceUrl: 'http://sonarr:8989', urlMappings: 'http://other|http://nope\nhttp://jf.example:8096|https://sonarr.example/' }
        };
      }
      throw new Error(path);
    }
  });
  h.window.localStorage.setItem('je-lp-arr-choice:user-a', JSON.stringify({ 'sonarr|feedfacecafebeef': { qualityProfileId: 6, rootFolderPath: '/anime', seriesType: 'daily', search: true } }));
  const done = [];
  const opened = h.arr.openAddDialog(season, { onDone: (r) => done.push(r) });
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/anime', 'pickers');
  await until(() => doc.querySelector('.je-lp-arr-state').textContent.length > 0, 'arr state');

  assert.equal(doc.querySelector('.jellyseerr-season-title').textContent, 'Add to Sonarr');
  assert.equal(doc.querySelector('.jellyseerr-season-subtitle').textContent, 'Peacemaker');
  assert.equal(doc.querySelector('.je-lp-arr-scope-text').textContent, 'Monitors season 2 only. Other seasons and new ones stay unmonitored.');
  const instance = doc.querySelector('#je-lp-arr-instance');
  assert.deepEqual([...instance.options].map((o) => o.textContent), ['Broken', 'TV <b>']);
  assert.equal(instance.value, '1');
  assert.equal(doc.querySelector('#je-lp-arr-quality').value, '6');
  assert.equal(doc.querySelector('#je-lp-arr-series-type').value, 'daily');
  assert.equal(doc.querySelector('#je-lp-arr-search').checked, true);
  assert.equal(doc.querySelector('#je-lp-arr-availability'), null);
  assert.equal(doc.querySelector('.je-lp-arr-state').textContent, 'Already in TV <b>: this adds monitoring for the part above.');
  assert.deepEqual(query(h.calls.find((c) => c.path.includes('/lookup')).path.split('lookup')[1]), { type: 'tv', term: 'tmdb:110492', instance: '1' });
  assert.ok(h.calls.every((c) => c.options.skipRetry === true));

  doc.querySelector('#je-lp-arr-quality').value = '1';
  doc.querySelector('#je-lp-arr-quality').dispatchEvent(new h.window.Event('change'));
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  const result = await opened;

  assert.equal(result.result, 'added');
  assert.deepEqual(done.map((r) => r.result), ['added']);
  assert.equal(addBody.mediaType, 'tv');
  assert.equal(addBody.instance, 1);
  assert.equal(addBody.instanceName, 'TV <b>');
  assert.equal(addBody.instanceKey, 'feedfacecafebeef');
  assert.equal(addBody.instanceRef, undefined);
  assert.equal(addBody.qualityProfileId, 1);
  assert.equal(addBody.rootFolderPath, '/anime');
  assert.equal(addBody.scope, 'season');
  assert.equal(addBody.seasonNumber, 2);
  assert.equal(addBody.seriesType, 'daily');
  assert.equal(addBody.search, true);
  assert.match(addBody.requestId, /^[A-Za-z0-9_-]+$/);
  const addCall = h.calls.find((c) => c.path === '/list-placeholders/arr/add');
  assert.equal(addCall.options.method, 'POST');

  // Toast: escaped title/instance, link through the URL mapping for this Jellyfin address.
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].html, /Added Peace&lt;maker&gt; to TV &lt;b&gt; and started a search/);
  assert.match(h.toasts[0].html, /href="https:\/\/sonarr\.example\/series\/peacemaker"/);
  assert.doesNotMatch(h.toasts[0].html, /<maker>|TV <b>/);

  const saved = JSON.parse(h.window.localStorage.getItem('je-lp-arr-choice:user-a'));
  assert.deepEqual(saved['sonarr|feedfacecafebeef'], { qualityProfileId: 1, rootFolderPath: '/anime', seriesType: 'daily', search: true });
  assert.deepEqual(saved['sonarr:last'], { identity: 'feedfacecafebeef' });
  // Only the TV options were asked for.
  assert.deepEqual(h.calls.filter((c) => c.path.includes('/options')).map((c) => c.path), ['/list-placeholders/arr/options?type=tv']);
  await until(() => !doc.querySelector('.jellyseerr-season-modal'), 'modal closed');
});

test('dialog: a broken instance blocks the add, a failed add keeps the dialog and its requestId', async (t) => {
  const bodies = [];
  let fail = true;
  const h = setup(t, {
    reply: async (path, options) => {
      if (path === '/list-placeholders/arr/options?type=movie') return { ...OPTIONS, radarr: [{ ...OPTIONS.sonarr[0], name: 'Bad' }, { ...OPTIONS.radarr[0], id: 1 }] };
      if (path.startsWith('/list-placeholders/arr/lookup')) throw Object.assign(new Error('HTTP 502'), { status: 502 });
      bodies.push(options.body);
      if (fail) {
        fail = false;
        throw Object.assign(new Error('HTTP 502'), { status: 502, responseJSON: { code: 'arr_unreachable', message: 'x' } });
      }
      return { result: 'already_exists', title: 'Man of Steel', instance: { name: 'Movies' } };
    }
  });
  const opened = h.arr.openAddDialog(movie);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
  const primary = doc.querySelector('.jellyseerr-modal-button-primary');
  assert.equal(doc.querySelector('#je-lp-arr-instance').value, '1');
  assert.equal(doc.querySelector('#je-lp-arr-availability').value, 'released');
  assert.equal(primary.disabled, false);

  const instance = doc.querySelector('#je-lp-arr-instance');
  instance.value = '0';
  instance.dispatchEvent(new h.window.Event('change'));
  assert.equal(primary.disabled, true);
  assert.equal(doc.querySelector('.je-lp-arr-message').textContent, "Couldn't reach Radarr. Check that it is running.");
  instance.value = '1';
  instance.dispatchEvent(new h.window.Event('change'));
  assert.equal(primary.disabled, false);
  assert.equal(doc.querySelector('.je-lp-arr-message').textContent, '');

  primary.click();
  await until(() => doc.querySelector('.je-lp-arr-message').textContent.length > 0, 'error message');
  assert.equal(doc.querySelector('.je-lp-arr-message').textContent, "Couldn't reach Radarr. Check that it is running.");
  assert.equal(primary.disabled, false);
  assert.equal(primary.textContent, 'Add to Radarr');
  assert.ok(doc.querySelector('.jellyseerr-season-modal'));

  primary.click();
  const result = await opened;
  assert.equal(result.result, 'already_exists');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[0].minimumAvailability, 'released');
  assert.match(h.toasts[0].html, /Man of Steel is already in Movies/);
});

test('dialog: nothing configured or options failing leaves the add disabled; cancel resolves null', async (t) => {
  const h = setup(t, { reply: async (path) => (path.includes('/options') ? { ...OPTIONS, sonarr: [] } : {}) });
  const opened = h.arr.openAddDialog(episodes);
  await until(() => h.document.querySelector('.je-lp-arr-message')?.textContent.length > 0, 'message');
  assert.equal(h.document.querySelector('.je-lp-arr-message').textContent, 'No Sonarr instance is set up in Jellyfin Enhanced.');
  assert.equal(h.document.querySelector('.jellyseerr-modal-button-primary').disabled, true);
  h.document.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(await opened, null);
  assert.ok(h.calls.every((c) => c.path !== '/list-placeholders/arr/add'));

  const failing = setup(t, { reply: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'forbidden' } }); } });
  const second = failing.arr.openAddDialog(movie);
  await until(() => failing.document.querySelector('.je-lp-arr-message')?.textContent.length > 0, 'message');
  assert.equal(failing.document.querySelector('.je-lp-arr-message').textContent, "Adding to Radarr isn't available to you.");
  failing.document.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(await second, null);
});

/** Options where every instance answered (the only kind the client caches). */
const HEALTHY = { ...OPTIONS, sonarr: [OPTIONS.sonarr[1]] };

test('options are cached for a minute and shared while in flight, per type', async (t) => {
  let count = 0;
  const h = setup(t, { reply: async () => { count++; await sleep(5); return HEALTHY; } });
  await Promise.all([h.arr.getOptions(), h.arr.getOptions()]);
  await h.arr.getOptions();
  assert.equal(count, 1);
  await h.arr.getOptions({ force: true });
  assert.equal(count, 2);
  await Promise.all([h.arr.getOptions({ type: 'movie' }), h.arr.getOptions({ type: 'movie' }), h.arr.getOptions({ type: 'tv' })]);
  await h.arr.getOptions({ type: 'tv' });
  assert.equal(count, 4);
  assert.deepEqual(h.calls.map((c) => c.path), ['/list-placeholders/arr/options', '/list-placeholders/arr/options', '/list-placeholders/arr/options?type=movie', '/list-placeholders/arr/options?type=tv']);
});

test('options with a failed instance are never reused: the next dialog asks again', async (t) => {
  let answer = OPTIONS;
  const h = setup(t, { reply: async () => answer });
  assert.equal((await h.arr.getOptions({ type: 'tv' })).sonarr[0].error, 'arr_unreachable');
  // Sonarr was started meanwhile: the reopened dialog sees it at once, not a minute later.
  answer = HEALTHY;
  assert.equal((await h.arr.getOptions({ type: 'tv' })).sonarr[0].error, undefined);
  await h.arr.getOptions({ type: 'tv' });
  assert.equal(h.calls.length, 2);
  // A failing instance replaces a cached healthy answer only once fetched (force), and isn't kept either.
  answer = OPTIONS;
  await h.arr.getOptions({ type: 'tv', force: true });
  answer = HEALTHY;
  await h.arr.getOptions({ type: 'tv' });
  assert.equal(h.calls.length, 4);
});

test('dialog: an add refused for stale settings drops the cached options; other failures keep them', async (t) => {
  let code = 'instance_changed';
  const h = setup(t, {
    reply: async (path) => {
      if (path.includes('/options')) return HEALTHY;
      if (path.includes('/lookup')) return { results: [] };
      throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code, message: 'x' } });
    }
  });
  const optionCalls = () => h.calls.filter((c) => c.path.includes('/options')).length;
  for (const [failure, refetched] of [['instance_changed', true], ['invalid_quality_profile', true], ['invalid_root_folder', true], ['arr_unreachable', true], ['arr_timeout', true], ['arr_rejected', false]]) {
    code = failure;
    await h.arr.getOptions({ type: 'tv' });
    const before = optionCalls();
    h.arr.openAddDialog(season);
    const doc = h.document;
    await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/tv', 'pickers');
    assert.equal(optionCalls(), before, `${failure}: the dialog used the cached options`);
    doc.querySelector('.jellyseerr-modal-button-primary').click();
    await until(() => doc.querySelector('.je-lp-arr-message').textContent.length > 0, 'error');
    doc.querySelector('.jellyseerr-modal-button-secondary').click();
    await until(() => !doc.querySelector('.jellyseerr-season-modal'), 'modal closed');
    await h.arr.getOptions({ type: 'tv' });
    assert.equal(optionCalls(), before + (refetched ? 1 : 0), failure);
  }
});

test('a Radarr dialog never waits for a hanging Sonarr options call', async (t) => {
  const h = setup(t, {
    reply: async (path) => {
      if (path === '/list-placeholders/arr/options?type=tv') return new Promise(() => {}); // Sonarr never answers
      if (path === '/list-placeholders/arr/options?type=movie') return { ...OPTIONS, sonarr: [] };
      return { results: [] };
    }
  });
  h.arr.getOptions({ type: 'tv' }).catch(() => {});
  h.arr.openAddDialog(movie);
  await until(() => h.document.querySelector('#je-lp-arr-root')?.value === '/movies', 'radarr pickers');
  assert.equal(h.document.querySelector('.jellyseerr-modal-button-primary').disabled, false);
});

test('"Add title" helpers: merged arr candidates, placeholder conversion and lookups', async (t) => {
  const h = setup(t, {
    reply: async (path) => {
      const q = query(path.split('lookup')[1]);
      if (q.type === 'movie') return { instance: { service: 'radarr', id: 0, name: 'Movies' }, results: [{ mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', year: 2013, posterPath: '/p.jpg', overview: 'o', releaseDate: '2013-06-12', imdbId: 'tt0770828' }] };
      throw Object.assign(new Error('HTTP 404'), { status: 404, responseJSON: { code: 'not_configured' } });
    }
  });
  const candidates = await h.arr.searchCandidates('  man of steel ');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'arr');
  assert.equal(candidates[0].instance.name, 'Movies');
  assert.deepEqual(query(h.calls[0].path.split('lookup')[1]), { type: 'movie', term: 'man of steel' });
  assert.deepEqual(query(h.calls[1].path.split('lookup')[1]), { type: 'tv', term: 'man of steel' });
  assert.deepEqual(plain(h.arr.toPlaceholder(candidates[0])), {
    kind: 'movie', mediaType: 'movie', tmdbId: 49521, title: 'Man of Steel', imdbId: 'tt0770828', year: 2013, releaseDate: '2013-06-12', posterPath: '/p.jpg', overview: 'o'
  });
  assert.deepEqual(plain(h.arr.toPlaceholder({ mediaType: 'tv', tmdbId: 7, tvdbId: 8, title: 'Show' })), { kind: 'series', mediaType: 'tv', tmdbId: 7, title: 'Show', tvdbId: 8 });
  assert.equal(h.arr.toPlaceholder({ mediaType: 'tv', tvdbId: 8, title: 'No TMDB' }), null);
  assert.equal((await h.arr.searchCandidates('   ')).length, 0);
  assert.equal(h.calls.length, 2);

  await h.arr.lookup('tvdb:1', 'tv', { instance: 2 }).catch(() => {});
  assert.deepEqual(query(h.calls[2].path.split('lookup')[1]), { type: 'tv', term: 'tvdb:1', instance: '2' });
});

test('result and error messages escape everything and say what happened', (t) => {
  const { arr } = setup(t);
  const base = { title: '<img src=x onerror=alert(1)>', instance: { name: 'S&S', instanceUrl: 'javascript:alert(1)', urlMappings: '' }, arrPath: '/x' };
  const added = arr.resultMessage({ ...base, result: 'monitoring_added', missingEpisodes: [{ s: 1, e: 9 }] });
  assert.doesNotMatch(added, /<img/);
  assert.match(added, /&lt;img src=x onerror=alert\(1\)&gt;: monitoring added in S&amp;S/);
  assert.match(added, /Not in S&amp;S yet: S01E09/);
  assert.doesNotMatch(added, /href=/); // never a javascript: link
  assert.match(arr.resultMessage({ ...base, result: 'already_monitored' }), /is already monitored in S&amp;S/);
  assert.match(arr.resultMessage({ ...base, result: 'added', searched: false }), /^Added /);
  assert.equal(arr.arrLink({ arrPath: '/movie/1', instance: { instanceUrl: 'http://radarr:7878/', urlMappings: '' } }), 'http://radarr:7878/movie/1');
  assert.equal(arr.arrLink({ instance: { instanceUrl: 'http://radarr' } }), null);

  assert.equal(arr.errorMessage({ status: 409, responseJSON: { code: 'instance_changed' } }, 'sonarr'), 'The Sonarr settings changed meanwhile. Close this window and try again.');
  assert.equal(arr.errorMessage({ status: 404, responseJSON: { message: 'disabled' } }, 'radarr'), "Adding to Radarr isn't available to you.");
  assert.equal(arr.errorMessage({ status: 404, responseJSON: { code: 'season_not_found', message: 'TV doesn\'t know season 7 of <x>' } }, 'sonarr'), 'TV doesn&#039;t know season 7 of &lt;x&gt;');
  assert.equal(arr.errorMessage(new Error('offline'), 'radarr'), 'Adding to Radarr failed. Try again.');
});

/** A promise with its resolve/reject exposed. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Counts history.back() calls (still performing them). */
function countBacks(h) {
  const history = h.window.history;
  const original = history.back.bind(history);
  const counter = { count: 0 };
  history.back = () => { counter.count++; original(); };
  return counter;
}

const TWO_SONARRS = {
  ...OPTIONS,
  sonarr: [
    { id: 0, name: 'Sonarr', key: 'aaaaaaaaaaaaaaaa', qualityProfiles: [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }], rootFolders: [{ path: '/tv' }] },
    { id: 1, name: 'Sonarr', key: 'bbbbbbbbbbbbbbbb', qualityProfiles: [{ id: 1, name: 'Any' }, { id: 7, name: '2160p' }], rootFolders: [{ path: '/tv' }, { path: '/tv4k' }] }
  ]
};

test('dialog: while an add runs, nothing can submit it again or change it', async (t) => {
  const pending = deferred();
  const bodies = [];
  const h = setup(t, {
    reply: async (path, options) => {
      if (path.includes('/options')) return TWO_SONARRS;
      if (path.includes('/lookup')) return { results: [] };
      bodies.push(options.body);
      return pending.promise;
    }
  });
  const backs = countBacks(h);
  const opened = h.arr.openAddDialog(season);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/tv', 'pickers');
  const primary = doc.querySelector('.jellyseerr-modal-button-primary');
  const quality = doc.querySelector('#je-lp-arr-quality');
  const instance = doc.querySelector('#je-lp-arr-instance');
  assert.equal(instance.disabled, false);

  primary.click();
  await until(() => bodies.length === 1, 'add sent');
  assert.equal(primary.disabled, true);
  assert.equal(primary.textContent, 'Adding…');
  for (const id of ['#je-lp-arr-instance', '#je-lp-arr-quality', '#je-lp-arr-root', '#je-lp-arr-series-type', '#je-lp-arr-search']) {
    assert.equal(doc.querySelector(id).disabled, true, id);
  }
  // Change events (e.g. fired by a select that was open) never re-enable the button or switch instance.
  quality.value = '4';
  quality.dispatchEvent(new h.window.Event('change'));
  instance.value = '1';
  instance.dispatchEvent(new h.window.Event('change'));
  assert.equal(primary.disabled, true);
  assert.deepEqual([...quality.options].map((o) => o.value), ['1', '4']);
  // Even a forced click (modal.js calls onSave on every click event) is ignored.
  primary.disabled = false;
  primary.click();
  await sleep(10);
  assert.equal(bodies.length, 1);

  pending.resolve({ result: 'added', title: 'Peacemaker', instance: { name: 'Sonarr' } });
  assert.equal((await opened).result, 'added');
  await until(() => !doc.querySelector('.jellyseerr-season-modal'), 'modal closed');
  assert.equal(backs.count, 1);
  assert.equal(h.toasts.length, 1);
});

test('dialog: a failed add unlocks the pickers again', async (t) => {
  const h = setup(t, {
    reply: async (path) => {
      if (path.includes('/options')) return TWO_SONARRS;
      if (path.includes('/lookup')) return { results: [] };
      throw Object.assign(new Error('HTTP 502'), { status: 502, responseJSON: { code: 'arr_redirect', message: 'x' } });
    }
  });
  h.arr.openAddDialog(season);
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/tv', 'pickers');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => doc.querySelector('.je-lp-arr-message').textContent.length > 0, 'error');
  assert.equal(doc.querySelector('.je-lp-arr-message').textContent, 'Sonarr redirected the request. In Jellyfin Enhanced, set its URL to the address it redirects to (often https).');
  for (const id of ['#je-lp-arr-instance', '#je-lp-arr-quality', '#je-lp-arr-root', '#je-lp-arr-series-type', '#je-lp-arr-search', '.jellyseerr-modal-button-primary']) {
    assert.equal(doc.querySelector(id).disabled, false, id);
  }
  assert.equal(doc.querySelector('.jellyseerr-modal-button-primary').textContent, 'Add to Sonarr');
});

test('dialog: a result arriving after the dialog was closed toasts but never navigates', async (t) => {
  const pending = deferred();
  const h = setup(t, {
    reply: async (path) => {
      if (path.includes('/options')) return OPTIONS;
      if (path.includes('/lookup')) return { results: [] };
      return pending.promise;
    }
  });
  const backs = countBacks(h);
  const done = [];
  const opened = h.arr.openAddDialog(movie, { onDone: (r) => done.push(r) });
  const doc = h.document;
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/movies', 'pickers');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => h.calls.some((c) => c.path.endsWith('/add')), 'add sent');
  doc.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await opened, null);
  assert.equal(backs.count, 1);

  pending.resolve({ result: 'added', title: 'Man of Steel', instance: { name: 'Movies' } });
  await until(() => h.toasts.length === 1, 'late toast');
  await sleep(20);
  assert.equal(backs.count, 1);
  assert.deepEqual(done.map((r) => r.result), ['added']);
});

test('dialog: same-named instances keep separate remembered choices', async (t) => {
  const h = setup(t, {
    reply: async (path) => {
      if (path.includes('/options')) return TWO_SONARRS;
      if (path.includes('/lookup')) return { results: [] };
      return { result: 'added', title: 'Peacemaker', instance: { name: 'Sonarr' } };
    }
  });
  h.window.localStorage.setItem('je-lp-arr-choice:user-a', JSON.stringify({
    'sonarr|aaaaaaaaaaaaaaaa': { qualityProfileId: 4, rootFolderPath: '/tv' },
    'sonarr:last': { identity: 'bbbbbbbbbbbbbbbb' },
    'sonarr|bbbbbbbbbbbbbbbb': { qualityProfileId: 7, rootFolderPath: '/tv4k' }
  }));
  const doc = h.document;
  let opened = h.arr.openAddDialog(season);
  await until(() => doc.querySelector('#je-lp-arr-root')?.value === '/tv4k', 'second instance preselected');
  assert.equal(doc.querySelector('#je-lp-arr-instance').value, '1');
  assert.equal(doc.querySelector('#je-lp-arr-quality').value, '7');

  // Switch to the first "Sonarr": its own choice comes back, then the add remembers it under its own key.
  const instance = doc.querySelector('#je-lp-arr-instance');
  instance.value = '0';
  instance.dispatchEvent(new h.window.Event('change'));
  assert.equal(doc.querySelector('#je-lp-arr-quality').value, '4');
  doc.querySelector('.jellyseerr-modal-button-primary').click();
  await opened;
  const saved = JSON.parse(h.window.localStorage.getItem('je-lp-arr-choice:user-a'));
  assert.deepEqual(saved['sonarr:last'], { identity: 'aaaaaaaaaaaaaaaa' });
  assert.equal(saved['sonarr|bbbbbbbbbbbbbbbb'].qualityProfileId, 7);
  assert.equal(saved['sonarr|bbbbbbbbbbbbbbbb'].rootFolderPath, '/tv4k');
  assert.equal(saved['sonarr|aaaaaaaaaaaaaaaa'].qualityProfileId, 4);
  assert.equal(h.calls.find((c) => c.path.endsWith('/add')).options.body.instanceKey, 'aaaaaaaaaaaaaaaa');
  await until(() => !doc.querySelector('.jellyseerr-season-modal'), 'modal closed');

  opened = h.arr.openAddDialog(season);
  await until(() => doc.querySelector('#je-lp-arr-instance')?.value === '0' && doc.querySelector('#je-lp-arr-quality')?.value === '4', 'last used preselected');
  doc.querySelector('.jellyseerr-modal-button-secondary').click();
  assert.equal(await opened, null);
});
