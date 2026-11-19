import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// Upstream 40738412 (tests/frontend/features/features-leavingsoon-request-cards.test.mjs): the Leaving soon page's cards
// in the Requests page's layout, what a deletion request would delete, the approve confirm with a note, and the dates.
// Here the page is client/src/features/media-tags/leaving-soon, shipped inside tags/tag-item-menu.js.

const DAY = 86400000;
const A = 'a'.repeat(32);

/** The Leaving soon page over the real UI kit, with the plugin's list route mocked. */
function setup(t, data) {
  const calls = [];
  const h = createHarness({
    html: '<div id="host"></div>',
    JE: {
      pluginConfig: { LeavingSoonPageEnabled: true, LeavingSoonProvider: 'reclaimerr', ToastDuration: 1500 },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      session: { onUserChange: () => {} },
    },
    apiClient: {
      getCurrentUser: async () => ({ Policy: { IsAdministrator: true } }),
      ajax: async ({ type, url, data: body }) => {
        const path = new URL(url).pathname.replace('/JellyfinEnhanced/', '');
        calls.push({ type, path, body: body ? JSON.parse(body) : null });
        if (path === 'leaving-soon/list') return data;
        return { ok: true };
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js', 'core/dom-observer.js', 'tags/tag-item-menu.js']) h.load(file);
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const $ = (sel) => h.document.querySelector(sel);
  const $$ = (sel) => Array.from(h.document.querySelectorAll(sel));
  return { ...h, calls, settle, $, $$ };
}

const base = { provider: 'reclaimerr', admin: true, canRequest: true, actions: true, requests: [], mine: [], items: [] };

test('a request says what it would delete, approving names that scope and carries the note, and a failed deletion stays visible', async t => {
  const series = { mediaType: 'series', requestedBy: 'x', status: 'pending', title: 'Sherlock', year: 2010 };
  const h = setup(t, {
    ...base,
    requests: [
      { ...series, id: 1, scope: 'season', seasonNumber: 2 },
      { ...series, id: 2, scope: 'episode', seasonNumber: 2, episodeNumber: 5 },
      { id: 3, title: 'Jailer 2', mediaType: 'movie', requestedBy: 'x', status: 'pending', scope: 'movie_version', versionResolution: '2160p', versionSize: 3 * 1073741824 },
      { ...series, id: 4, scope: 'series', status: 'approved', executionError: 'Radarr refused the delete' },
      { ...series, id: 5, scope: 'series', status: 'approved', deferred: true },
    ],
  });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const cards = h.$$('.je-ls-reqcard');
  assert.equal(cards[0].querySelector('.je-ls-scope').textContent, 'leavingsoon_scope_season:2');
  assert.equal(cards[1].querySelector('.je-ls-scope').textContent, 'leavingsoon_scope_episode:2|5');
  assert.equal(cards[2].querySelector('.je-ls-scope').textContent, 'leavingsoon_scope_version · 2160p · 3.0 GB');
  assert.equal(cards[3].querySelector('.je-ls-chip').textContent, 'leavingsoon_status_failed');
  assert.equal(cards[3].querySelector('.je-ls-err').textContent, 'Radarr refused the delete');
  assert.equal(cards[3].querySelectorAll('.je-ls-icon-btn').length, 0, 'an approved request is not reviewed again');
  assert.equal(cards[4].querySelector('.je-ls-chip').textContent, 'leavingsoon_status_deferred');

  cards[0].querySelector('.je-ls-icon-btn.approve').click();
  assert.equal(cards[0].querySelector('.je-ls-warn').textContent, 'leavingsoon_confirm_delete_scope:leavingsoon_scope_season:2', 'the warning names the season');
  cards[0].querySelector('.je-ls-note-input').value = '  gone in a week  ';
  cards[0].querySelector('.je-ls-btn.danger').click();
  await h.settle();
  assert.deepEqual(h.calls.find(c => c.path === 'reclaimerr/requests/1/approve').body, { note: 'gone in a week' });

  cards[2].querySelector('.je-ls-icon-btn.approve').click();
  assert.equal(cards[2].querySelector('.je-ls-warn').textContent, 'leavingsoon_confirm_delete_scope:leavingsoon_scope_version · 2160p · 3.0 GB');
});

test('the page says so when the requests could not be read, and a leaving card shows its date and a one-version note', async t => {
  const h = setup(t, { ...base, requestsUnavailable: true, items: [{ id: A, name: 'Jailer 2', type: 'Movie', year: 2026, deleteAt: Date.now() + 5 * DAY, versionOnly: true, size: 3 * 1073741824 }] });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.equal(h.$('.je-ls-notice').textContent, 'leavingsoon_requests_unavailable');
  const card = h.$('.je-ls-card');
  assert.equal(card.querySelector('.je-ls-scope').textContent, 'leavingsoon_one_version');
  assert.match(card.textContent, /leavingsoon_leaves_on:.* · 3.0 GB/, 'the date and the size share a line');
  assert.equal(card.querySelector('.je-ls-year').textContent, '(2026)');
});

test('dates read like the Requests page: day, short month, year for the leave date, and "ago" for a recent request', async t => {
  const fixed = Date.UTC(2026, 11, 10, 12);
  const h = setup(t, {
    ...base,
    items: [{ id: A, name: 'DC', type: 'Movie', year: 2026, deleteAt: fixed }],
    requests: [
      { id: 1, title: 'Recent', mediaType: 'movie', requestedBy: 'x', status: 'pending', createdAt: new Date(Date.now() - 3 * DAY).toISOString() },
      { id: 2, title: 'Old', mediaType: 'movie', requestedBy: 'x', status: 'pending', createdAt: '2026-01-05T10:00:00Z' },
    ],
  });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.match(h.$('.je-ls-card').textContent, /10 Dec 2026/, 'not a numeric 12/10/2026');
  const [recent, old] = h.$$('.je-ls-reqcard');
  assert.match(recent.textContent, /requests_days_ago/);
  assert.match(old.textContent, /05 Jan 2026/);
});

// Not in upstream: its page hides an administrator's note from the requester whenever the note ends " in Jellyfin" or
// " in Jellyfin)", which is also how the server appends "(Approved by NAME in Jellyfin)" to a note typed by an
// administrator who is not acting as themself, so that note never reached the requester. Here only the attribution goes.
test('a requester reads the note an administrator wrote, without the "by NAME in Jellyfin" attribution', async t => {
  const own = { mediaType: 'movie', title: 'Crash', status: 'approved' };
  const h = setup(t, {
    ...base,
    admin: false,
    actions: false,
    mine: [
      { ...own, id: 1, adminNotes: 'gone in a week (Approved by Admin in Jellyfin)' },
      { ...own, id: 2, adminNotes: 'Denied by Admin in Jellyfin', status: 'denied' },
      { ...own, id: 3, adminNotes: 'Not on Netflix or in Jellyfin' },
      { ...own, id: 4, adminNotes: 'Not on Netflix or in Jellyfin)' },
    ],
  });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const notes = h.$$('.je-ls-reqcard').map(c => Array.from(c.querySelectorAll('.je-ls-note')).map(n => n.textContent).join('/'));
  assert.deepEqual(notes, ['gone in a week', '', 'Not on Netflix or in Jellyfin', 'Not on Netflix or in Jellyfin)']);
});

// Not in upstream: its page takes any absolute poster address Reclaimerr names, which can be a host the browser never
// asked before (REVIEW.md: no new request to a host other than the Jellyfin server). Here an absolute address is used
// only on TMDB's image host, the one the page already used for a relative path.
test('a request\'s poster is the item\'s own, else TMDB\'s, and never another host Reclaimerr names', async t => {
  const r = { mediaType: 'movie', requestedBy: 'x', status: 'pending' };
  const h = setup(t, {
    ...base,
    requests: [
      { ...r, id: 1, title: 'Own', itemId: 'e'.repeat(32), posterPath: '/p.jpg' },
      { ...r, id: 2, title: 'Path', posterPath: '/p.jpg' },
      { ...r, id: 3, title: 'Tmdb', posterPath: 'https://image.tmdb.org/t/p/w500/q.jpg' },
      { ...r, id: 4, title: 'Other', posterPath: 'http://reclaimerr.lan:8000/api/media/poster/4' },
      { ...r, id: 5, title: 'Bad', posterPath: 'javascript:alert(1)' },
    ],
  });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const src = h.$$('.je-ls-reqcard').map(c => c.querySelector('.je-ls-poster img')?.getAttribute('src') ?? null);
  assert.match(src[0], /Items\/e{32}\/Images\/Primary/);
  assert.equal(src[1], 'https://image.tmdb.org/t/p/w185/p.jpg');
  assert.equal(src[2], 'https://image.tmdb.org/t/p/w500/q.jpg');
  assert.equal(src[3], null, 'no request to the Reclaimerr host');
  assert.equal(src[4], null);
});
