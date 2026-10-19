const { expect } = require('@playwright/test');
const en = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');
const ITEM = 'c'.repeat(32);
const AS_OF = '2026-10-12T10:00:00Z';

/** Builds a composed status using ArrStatusService's public DTO shape. */
function status(id, stage, code, extra = {}) {
  return { key: `movie:tmdb:${id}`, kind: 'movie', stage, reason: { code, params: {} },
    quiet: false, attention: code === 'stalled', actions: [],
    journey: [{ stage: 'asked', state: 'done' }, { stage, state: 'current' }], ...extra };
}
/** Builds one RequestsHubService entry; only the ready copy has a playable Jellyfin id. */
function entry(id, title, group, stage, code, extra = {}) {
  return { key: `movie:tmdb:${id}`, kind: 'movie', tmdbId: id, title, year: 2026,
    request: 'approved', askedAt: AS_OF, group, status: status(id, stage, code), ...extra };
}
/** Fresh independent DTOs per test, based on Acquire services and existing frontend fixtures. */
function dataFor(admin = true, origin = 'http://127.0.0.1:4179') {
  const importing = status(2, 'almostReady', 'importing', {
    itemId: ITEM,
    ...(admin ? { admin: { variants: [{ instanceId: 'r1', instance: 'Fixture Radarr', kind: 'Radarr',
      stage: 'almostReady', reason: { code: 'importing' }, messages: ['Import in progress'] }] } } : {})
  });
  const rows = [entry(1, 'Downloading Film', 'onTheWay', 'downloading', 'downloading', {
    status: status(1, 'downloading', 'downloading', { progress: { percent: 42, etaSeconds: 720 } })
  }), entry(2, 'Importing Film', 'onTheWay', 'almostReady', 'importing'),
  entry(3, 'Ready Film', 'ready', 'ready', 'ready', { itemId: 'd'.repeat(32), readyAt: AS_OF }),
  entry(4, 'Stalled Film', 'onTheWay', 'downloading', 'stalled')];
  const card = { id: 'r1', name: 'Fixture Radarr', kind: 'Radarr', role: 'standard',
    url: origin + '/fixture-radarr', version: '6.0.4', live: { expected: true, connection: { state: 'Connected', since: AS_OF }, webhook: false },
    queue: 3, queueAttention: 1, queueAsOf: AS_OF, health: 'ok', healthIssues: 0,
    disks: [{ path: '/fixture/movies', usedPercent: 94, free: 40e9, total: 7e11, low: true, accessible: true }] };
  const download = { instanceId: 'r1', instance: card.name, kind: 'Radarr', downloadId: 'stub-download', ids: [1],
    title: 'Stalled Film', status: 'warning', state: 'downloading', health: 'warning', percent: 42,
    client: 'Fixture client', quality: 'WEBDL-1080p', release: 'Stalled.Film.2026.1080p',
    messages: ['No progress reported'], problem: 'download_stalled', actions: ['remove', 'remove_with_data', 'search'] };
  return {
    status: { contact: 'Dad', lookingHours: 24, items: [importing] },
    hub: { contact: 'Dad', lookingHours: 24, seerr: { configured: true, loaded: true, unavailable: true },
      arr: { unavailable: true }, more: true, mine: rows.filter(row => row.group !== 'ready'),
      soon: [entry(5, 'Coming Film', 'notOut', 'notOut', 'not_released', { nextDay: '2099-11-14' })],
      ready: [rows[2]], ...(admin ? { admin: { hub: true, downloads: true, calendar: false } } : {}) },
    manage: { key: importing.key, kind: 'movie', tmdbId: 2, title: 'Importing Film', status: importing,
      instances: [{ id: 'r1', name: card.name, kind: 'Radarr', role: 'standard', url: origin + '/fixture-radarr',
        live: true, readable: true, inArr: true, arrId: 2, monitored: true, path: '/fixture/movies/Importing Film',
        queue: [{ state: 'importPending', percent: 100, client: 'Fixture client' }], queueTotal: 4,
        downloads: [download], downloadsTotal: 1, queueAsOf: AS_OF,
        timeline: [{ event: 'added', at: AS_OF }, { event: 'grabbed', at: AS_OF }] }],
      copies: [], requests: [{ at: AS_OF, status: 'approved', by: 'Sam', seasons: [] }] },
    overview: { instances: [card], needsAttention: [{ id: 'stalled', code: 'download_stalled', severity: 'warning',
      instanceId: 'r1', instance: card.name, title: download.title, key: 'movie:tmdb:4', since: AS_OF,
      params: { pct: '42' }, fixes: ['remove_search', 'open_in_arr'], arrLink: '/activity/queue', downloadId: download.downloadId }],
      next24h: [{ title: 'Fixture Series', season: 1, episode: 6, at: AS_OF, instance: card.name }],
      downloading: 3, waitingForOk: 1, days: [{ date: '2026-10-12', grabs: 2, imports: 1 }], seerr: true },
    activity: { instances: [card], queue: [download], truncated: true,
      history: [{ instanceId: 'r1', instance: card.name, event: 'downloadFolderImported', title: 'Ready Film', date: AS_OF, quality: 'Bluray-1080p' }] },
    system: { instances: [{ card, appName: 'Radarr', health: [{ source: 'Fixture', type: 'warning', message: 'Fixture source stale' }],
      diskSpace: [], tasks: [{ name: 'RSS Sync', interval: 30, lastExecution: AS_OF, nextExecution: AS_OF }] }],
      seerr: { lastReadAt: AS_OF, lastError: 'Fixture read failed', truncated: true, reportedTotal: 250, readLimit: 200 },
      seerrRequests: 200, bridge: { targetedRefresh: true, refreshes: 1, found: 1, recent: [],
        notInJellyfin: [{ instanceId: 'r1', instance: card.name, title: 'Importing Film', arrPath: '/fixture/movies/Importing Film/file.mkv',
          jellyfinPath: '/media/Importing Film/file.mkv', importedAt: AS_OF, problem: 'not_scanned', library: 'Movies' }],
        missingTitles: { titles: [], counts: {} }, pathDoctor: [] }, settings: { libraryPendingMinutes: 10, lowDiskPercent: 10, seerrHandoffGraceMinutes: 15 } },
    audit: { entries: [{ time: AS_OF, userName: 'Fixture admin', action: 'queue.search', target: 'Stalled Film', outcome: 'succeeded', message: 'Fixture action' }] },
    inbox: { unread: 2, more: true, items: [
      { id: 2, kind: 'ready', createdAt: AS_OF, read: false, params: { title: 'Ready Film' }, itemId: 'd'.repeat(32), link: '#/requests' },
      { id: 1, kind: 'attention', createdAt: AS_OF, read: false, params: { title: 'Stalled Film', code: 'download_stalled' }, link: '#/requests?tab=overview' }
    ] },
    prefs: { prefs: { toasts: false, ready: true, episodes: true, declined: true, autoFollowRequests: true,
      ntfy: false, email: false, quietHours: false, timeZone: 'UTC' },
      channels: { ntfy: { available: false }, email: { available: false } }, contact: 'Dad', admin },
    follows: { follows: [], muted: [], requested: [] }
  };
}

/**
 * Intercepts every plugin route used by the loaded arr modules, including action routes.
 * Also names legacy arr pluginFetch routes so future embedding cannot silently reach a server.
 * Unknown plugin paths/methods are recorded and fail teardown even if production swallows errors.
 * @param {import('@playwright/test').Page} page Browser page.
 * @param {{admin?: boolean, origin: string}} options Fixture identity.
 * @returns {Promise<Object>} Mutable data, requests, failures and one-response hold helper.
 */
async function installArrRoutes(page, { admin = true, origin, extra = [], patterns = [] } = {}) {
  const data = dataFor(admin, origin);
  const unexpected = [], requests = [], holds = new Map();
  const outcome = { status: 'Succeeded', message: 'Fixture done', readBack: 'Finished' };
  const routes = new Map([
    ['GET /acquire/hub', () => data.hub], ['GET /acquire/status', () => data.status],
    ['GET /arr/admin/manage', () => data.manage],
    ...['overview', 'activity', 'system'].map(tab => [`GET /arr/admin/hub/${tab}`, () => data[tab]]),
    ['GET /arr/admin/audit', () => data.audit],
    ...['/arr/admin/manage/search', '/arr/admin/queue/action', '/arr/admin/hub/search', '/arr/admin/bridge/scan'].map(path => [`POST ${path}`, () => outcome]),
    ['POST /arr/admin/queue/confirm', () => ({ token: 'fixture-confirm', expiresAt: '2099-11-14T00:00:00Z', download: data.activity.queue[0] })],
    ['GET /acquire/notify/inbox', () => data.inbox], ['POST /acquire/notify/read', () => ({ changed: 2, unread: 0 })],
    ['GET /acquire/follows', () => data.follows], ['PUT /acquire/follows', request => ({ key: request.postDataJSON().key, following: request.postDataJSON().on })],
    ['POST /acquire/remind', () => ({ reminded: true })],
    ['GET /acquire/notify/prefs', () => data.prefs], ['PUT /acquire/notify/prefs', request => {
      Object.assign(data.prefs.prefs, request.postDataJSON()); return data.prefs;
    }],
    ['POST /acquire/notify/ntfy/topic', () => data.prefs], ['POST /acquire/notify/email', () => ({ sent: true })],
    ['DELETE /acquire/notify/email', () => data.prefs], ['POST /acquire/notify/email/verify', () => data.prefs],
    ['POST /acquire/notify/test', () => ({ sent: true })],
    ['POST /acquire/changes', () => ({ epoch: 'fixture-epoch', cursor: 1, keys: [], reset: false })],
    ['GET /arr/queue', () => ({ instances: [], items: [] })], ['GET /arr/history', () => ({ items: [] })],
    ['GET /arr/requests', () => ({ items: [] })], ['GET /arr/calendar', () => ({ events: [] })],
    ['GET /arr/calendar/user-data', () => ({})], ['POST /arr/calendar/user-data', () => ({})],
    ['GET /items/by-providers', () => null], ['GET /arr/series-slugs', () => ({})], ['GET /arr/movie-instances', () => ({})],
    ...extra
  ]);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (!url.pathname.startsWith('/JellyfinEnhanced/')) return route.continue();
    const path = url.pathname.slice('/JellyfinEnhanced'.length);
    const key = `${request.method()} ${path}`;
    requests.push(key);
    const handler = routes.get(key)
      || (request.method() === 'GET' && /^\/acquire\/status\/item\/[a-z0-9]+$/.test(path) ? () => data.status : null)
      || (request.method() === 'POST' && /^\/arr\/requests\/\d+\/(approve|decline|delete)$/.test(path) ? () => outcome : null)
      || patterns.find(([method, pattern]) => method === request.method() && pattern.test(path))?.[2];
    if (!handler) { unexpected.push(key); return route.fulfill({ status: 500, json: { code: 'unexpected_fixture_request' } }); }
    const held = holds.get(key);
    if (held) { holds.delete(key); held.started(); await held.promise; }
    // Honour the change feed's long-poll wait without busy-looping; wait=0 primes immediately.
    if (path === '/acquire/changes' && request.postDataJSON()?.wait) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const answer = handler(request, url);
    // Phase-3 request routes answer with a real HTTP status: {__status, body}.
    if (answer && typeof answer === 'object' && '__status' in answer) await route.fulfill({ status: answer.__status, json: answer.body });
    else await route.fulfill({ json: answer });
  });
  return { data, requests, unexpected,
    /** Holds exactly the next response; tests must release it in finally. */
    hold(key) {
      let release, started;
      const promise = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { started = resolve; });
      holds.set(key, { promise, started });
      return { release, requested };
    },
    /** Asserts the strict route allowlist after the test. */
    check() { expect(unexpected, 'unexpected plugin requests').toEqual([]); }
  };
}
module.exports = { installArrRoutes, dataFor, en, ITEM };
