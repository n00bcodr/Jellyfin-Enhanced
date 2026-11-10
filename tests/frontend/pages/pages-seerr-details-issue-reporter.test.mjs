import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';
import { manualClock, sessionFixture, strictEscape } from '../helpers/seerr-details.mjs';

// issue-reporter.js with the real report dialog (jellyseerr/modal.js): the report flow,
// its TV selectors, which page gets a button, and what is left after close or an account change.
const PAGE = '<div id="itemDetailPage"><div class="detailButtons"><button class="btnMoreCommands"></button></div></div>';
const MOVIE = { Id: 'm1', Type: 'Movie', Name: 'Film', ProviderIds: { Tmdb: '603' } };

function setup(t, { items = { m1: MOVIE }, status = { active: true }, config = {}, api = {}, ajax, html = PAGE, url = 'http://jellyfin.test/web/index.html#!/details?id=m1', je = {} } = {}) {
  const { session, switchUser } = sessionFixture();
  const toasts = [], reports = [], ajaxCalls = [], itemCalls = [];
  const h = createHarness({ html, url, JE: {
    pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true, ...config }, t: key => key, escapeHtml: strictEscape, session,
    toast: (...args) => toasts.push(args), icon: name => `<i class="icon-${name}"></i>`, IconName: { VIDEO: 'video', AUDIO: 'audio', SUBTITLES: 'subs', QUESTION: 'q' },
    core: { ui: { isTvLayout: () => false } },
    helpers: { getItemCached: async id => { itemCalls.push(id); return items[id] ?? null; } },
    jellyseerrUI: { addMainStyles() {} },
    jellyseerrAPI: { fetchIssuesForMedia: async () => ({ results: [] }), fetchIssueById: async () => null,
      reportIssue: async (...args) => { reports.push(args); return { id: 1 }; }, ...api },
    ...je
  }, apiClient: { ajax: async request => {
    ajaxCalls.push(request.url);
    if (request.url.includes('/jellyseerr/status')) return status;
    return ajax ? ajax(request) : { Items: [] };
  } } });
  t.after(() => h.close());
  const clock = manualClock(h);
  h.window.history.back = () => {};
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/issue-reporter.js');
  return { ...h, R: h.JE.jellyseerrIssueReporter, clock, toasts, reports, ajaxCalls, itemCalls, switchUser,
    page: () => h.document.querySelector('#itemDetailPage'),
    dialog: () => h.document.querySelector('.jellyseerr-season-modal'),
    pickType(value) { h.document.querySelector(`input[name="issue-type"][value="${value}"]`).checked = true; },
    submit() { h.document.querySelector('.jellyseerr-modal-button-primary').click(); },
    async settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); } };
}
const seasonsReply = seasons => request => {
  if (request.url.includes('IncludeItemTypes=Season')) return { Items: seasons.map(number => ({ Id: `s${number}`, IndexNumber: number })) };
  const parent = /ParentId=s(\d+)/.exec(request.url)?.[1];
  return { Items: [1, 2].map(number => ({ IndexNumber: number, Name: `E${parent}.${number}` })) };
};
const withQuery = client => { client.getUrl = (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`; };

test('a report sends the chosen type and text, thanks the user and closes', async t => {
  const h = setup(t);
  h.R.showReportModal('603', 'Film', 'movie');
  await h.settle();
  h.submit();
  assert.deepEqual(h.toasts.pop(), ['Issue Type is required', 3000]);
  h.pickType('2');
  h.document.querySelector('#issue-message').value = 'No sound';
  h.submit();
  await h.settle();
  assert.deepEqual(plain(h.reports), [['603', 'movie', '2', 'No sound', 0, 0]]);
  assert.deepEqual(h.toasts.pop(), ['jellyseerr_report_issue_success', 3000]);
  assert.equal(h.document.body.classList.contains('jellyseerr-modal-is-open'), false);
});

for (const [name, failure, message] of [
  ['no permission', Object.assign(new Error('x'), { status: 403 }), 'jellyseerr_err_no_issue_permission'],
  ['Seerr down', Object.assign(new Error('x'), { status: 503 }), 'Jellyseerr is not available'],
  ['Seerr unreachable', Object.assign(new Error('x'), { status: 0 }), 'Jellyseerr is not available'],
  ['media unknown to Seerr', new Error('Could not find Jellyseerr media id'), 'Jellyseerr is not available'],
  ['anything else', new Error('boom'), 'jellyseerr_report_issue_error']
]) test(`a failed report (${name}) says so and lets the user try again`, async t => {
  const h = setup(t, { api: { reportIssue: async () => { throw failure; } } });
  h.expectConsoleError(/Error reporting issue/);
  h.R.showReportModal('603', 'Film', 'movie');
  h.pickType('1');
  h.submit();
  await h.settle();
  assert.deepEqual(h.toasts.pop(), [message, 4000]);
  const button = h.document.querySelector('.jellyseerr-modal-button-primary');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'jellyseerr_report_issue_submit');
});

test('an empty answer from Seerr is a failure, not a success', async t => {
  const h = setup(t, { api: { reportIssue: async () => null } });
  h.expectConsoleError(/Error reporting issue/);
  h.R.showReportModal('603', 'Film', 'movie');
  h.pickType('1');
  h.submit();
  await h.settle();
  assert.deepEqual(h.toasts.pop(), ['jellyseerr_report_issue_error', 4000]);
});

test('an account change closes the dialog: a report cannot start or finish for the new account', async t => {
  const pending = deferred();
  const h = setup(t, { api: { reportIssue: (...args) => { h.reports.push(args); return pending.promise; } } });
  h.R.showReportModal('603', 'Film', 'movie');
  h.pickType('1');
  const submit = h.document.querySelector('.jellyseerr-modal-button-primary');
  h.switchUser();
  assert.equal(h.document.body.classList.contains('jellyseerr-modal-is-open'), false);
  submit.click();
  await h.settle();
  assert.equal(h.reports.length, 0);

  const running = setup(t, { api: { reportIssue: () => pending.promise } });
  running.R.showReportModal('603', 'Film', 'movie');
  running.pickType('1');
  running.submit();
  running.switchUser();
  pending.resolve({ id: 1 });
  await running.settle();
  assert.equal(running.toasts.length, 0);
});

test('a replaced dialog factory with no close still stops the report on an account change', async t => {
  const h = setup(t);
  const { create } = h.JE.jellyseerrModal;
  h.JE.jellyseerrModal.create = options => {
    const { modalElement, show } = create(options);
    return { modalElement, show };
  };
  h.R.showReportModal('603', 'Film', 'movie');
  h.pickType('1');
  h.switchUser();
  h.submit();
  await h.settle();
  assert.equal(h.reports.length, 0);
});

test('issues that arrive after the dialog closed stay out of it', async t => {
  const list = deferred();
  let lookups = 0;
  const h = setup(t, { api: { fetchIssuesForMedia: () => list.promise, fetchIssueById: async () => { lookups++; return null; } } });
  h.R.showReportModal('603', 'Film', 'movie');
  const body = h.document.querySelector('#jellyseerr-issues-body');
  h.document.querySelector('.jellyseerr-modal-button-secondary');
  h.dialog().dispatchEvent(new h.window.Event('noop'));
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  list.resolve({ results: [{ id: 1 }] });
  await h.settle();
  assert.equal(lookups, 0);
  assert.ok(body.querySelector('#jellyseerr-issues-loading'));
});

test('season lookups stop when the dialog closes', async t => {
  const seasons = deferred();
  const asked = [];
  const h = setup(t, { items: { series: { Id: 'series', Type: 'Series', Name: 'Show' } }, ajax: request => { asked.push(request.url); return seasons.promise; } });
  withQuery(h.window.ApiClient);
  h.R.showReportModal('1', 'Show', 'tv', null, { Id: 'series', Type: 'Series' });
  await h.settle();
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  seasons.resolve({ Items: [{ Id: 's1', IndexNumber: 1 }, { Id: 's2', IndexNumber: 2 }] });
  await h.settle();
  assert.equal(asked.length, 1, 'the episode requests never start');
});

test('existing issues group by type, newest first, as text, and a new type still shows', async t => {
  const issues = [
    { id: 1, issueType: 1, status: 1, createdAt: '2026-01-01T10:00:00Z', message: '<b>old</b>', createdBy: { displayName: 'Ann' } },
    { id: 2, issueType: 1, status: 2, createdAt: '2026-02-01T10:00:00Z', createdBy: { username: 'Bob' }, comments: [{ message: 'first' }, { message: 'reply', user: { email: 'c@test' }, createdAt: '2026-02-02T10:00:00Z' }] },
    { id: 3, problemType: 3, status: 1 }, { id: 4, issueType: 9, status: 'resolved' }, { id: 5 }
  ];
  const h = setup(t, { api: { fetchIssuesForMedia: async (_id, _type, query) => { h.query = query; return { results: issues.map(({ id }) => ({ id })) }; }, fetchIssueById: async id => issues.find(issue => issue.id === id) } });
  h.R.showReportModal('603', 'Film', 'movie');
  await h.settle();
  assert.deepEqual(plain(h.query), { take: 50, filter: 'all' });
  const sections = [...h.document.querySelectorAll('.jellyseerr-issue-section')].map(section => [
    section.querySelector('.jellyseerr-issue-section-title').textContent,
    [...section.querySelectorAll('.pill-number-open, .pill-number-resolved')].map(pill => pill.textContent)
  ]);
  assert.deepEqual(sections, [['jellyseerr_report_issue_type_video', ['#2', '#1']], ['jellyseerr_report_issue_type_subtitles', ['#3']], ['Other'.length ? sections[2][0] : '', ['#4', '#5']]]);
  assert.match(h.document.querySelector('.jellyseerr-issue-message').textContent, /first/);
  assert.equal(h.document.querySelector('.jellyseerr-issue-message b'), null);
  const cards = [...h.document.querySelectorAll('.jellyseerr-issue-card')];
  assert.match(cards[0].querySelector('.jellyseerr-issue-comment-meta').textContent, /c@test/);
  assert.equal(cards[0].querySelector('.pill-status-resolved').textContent, 'jellyseerr_issue_resolved');
  assert.equal(cards[3].querySelector('.pill-status-resolved').textContent, 'Resolved');
  assert.match(cards[4].querySelector('.jellyseerr-issue-reporter').textContent, /Someone/);
  assert.equal(cards[4].querySelector('.jellyseerr-issue-date'), null);
});

test('a dialog with nothing to list says so, and a failed list says that instead', async t => {
  const h = setup(t);
  h.R.showReportModal('603', 'Film', 'movie');
  await h.settle();
  assert.equal(h.document.querySelector('.jellyseerr-issues-empty').textContent, 'jellyseerr_no_issues_yet');
  const failed = setup(t, { api: { fetchIssuesForMedia: async () => { throw new Error('offline'); } } });
  failed.expectConsoleError(/Failed to load existing issues/);
  failed.R.showReportModal('603', 'Film', 'movie');
  await failed.settle();
  assert.equal(failed.document.querySelector('.jellyseerr-issues-empty').textContent, 'jellyseerr_load_issues_error');
});

test('a series offers all seasons, and a chosen season its episodes', async t => {
  const h = setup(t, { ajax: seasonsReply([1, 2]) });
  withQuery(h.window.ApiClient);
  h.R.showReportModal('1', 'Show', 'tv', null, { Id: 'series', Type: 'Series' });
  await h.settle();
  const season = h.document.querySelector('#issue-season'), episode = h.document.querySelector('#issue-episode');
  assert.deepEqual([...season.options].map(option => option.value), ['0', '1', '2']);
  assert.equal(season.value, '0');
  assert.equal(episode.disabled, true);
  season.value = '2';
  season.dispatchEvent(new h.window.Event('change'));
  assert.deepEqual([...episode.options].map(option => option.textContent), ['jellyseerr_select_all_episodes', 'jellyseerr_report_issue_episode 1 — E2.1', 'jellyseerr_report_issue_episode 2 — E2.2']);
  assert.equal(episode.disabled, false);
  episode.value = '2';
  h.pickType('1');
  h.submit();
  await h.settle();
  assert.deepEqual(plain(h.reports[0].slice(4)), [2, 2]);
  assert.match(h.ajaxCalls.find(url => url.includes('IncludeItemTypes=Season')), /ParentId=series/);
});

test('a one-season show selects that season', async t => {
  const h = setup(t, { ajax: seasonsReply([1]) });
  withQuery(h.window.ApiClient);
  h.R.showReportModal('1', 'Show', 'tv', null, { Id: 'series', Type: 'Series' });
  await h.settle();
  assert.equal(h.document.querySelector('#issue-season').value, '1');
  assert.equal(h.document.querySelector('#issue-episode').disabled, false);
});

test('a season page and an episode page preset and lock what they are about, and the locks still report', async t => {
  const season = setup(t, { ajax: seasonsReply([1, 2]) });
  withQuery(season.window.ApiClient);
  season.R.showReportModal('1', 'Show', 'tv', null, { Id: 's2', Type: 'Season', IndexNumber: 2, SeriesId: 'series' });
  await season.settle();
  assert.equal(season.document.querySelector('#issue-season').value, '2');
  assert.equal(season.document.querySelector('#issue-season').disabled, true);
  assert.equal(season.document.querySelector('#issue-episode').disabled, false);

  const episode = setup(t, { ajax: seasonsReply([1, 2]) });
  withQuery(episode.window.ApiClient);
  episode.R.showReportModal('1', 'Show', 'tv', null, { Id: 'e', Type: 'Episode', IndexNumber: 2, ParentIndexNumber: 1, SeriesId: 'series', ParentId: 's1' });
  await episode.settle();
  episode.pickType('1');
  episode.submit();
  await episode.settle();
  assert.deepEqual(plain(episode.reports[0].slice(4)), [1, 2]);
  assert.equal(episode.document.querySelector('#issue-episode').disabled, true);
});

test('an episode never reads its season as the series', async t => {
  const h = setup(t, { ajax: seasonsReply([1]) });
  withQuery(h.window.ApiClient);
  h.R.showReportModal('1', 'Show', 'tv', null, { Id: 'e', Type: 'Episode', IndexNumber: 2, ParentIndexNumber: 1, ParentId: 'the-season' });
  await h.settle();
  assert.equal(h.ajaxCalls.filter(url => url.includes('the-season')).length, 0);
  // With no series to ask about, the dialog falls back to all seasons.
  assert.equal(h.document.querySelector('#issue-season').disabled, true);
});

test('no season list falls back to the counted seasons, or to all seasons', async t => {
  const counted = setup(t);
  counted.R.showReportModal('1', 'Show', 'tv', null, { Id: 'series', Type: 'Series', SeasonCount: 2 });
  await counted.settle();
  assert.deepEqual([...counted.document.querySelector('#issue-season').options].map(option => option.value), ['0', '1', '2']);
  // The Requests page reports with no item at all.
  const bare = setup(t);
  bare.R.showReportModal('1', 'Show', 'tv', null, null);
  await bare.settle();
  assert.deepEqual([...bare.document.querySelector('#issue-season').options].map(option => option.value), ['0']);
  assert.equal(bare.document.querySelector('#issue-season').disabled, true);
});

test('the button goes before the More menu, and opens the dialog for that title with its backdrop', async t => {
  const item = { ...MOVIE, BackdropImageTags: ['tag'] };
  const h = setup(t, { items: { m1: item } });
  assert.equal(await h.R.tryAddButton(), true);
  const button = h.document.querySelector('.jellyseerr-report-issue-icon');
  assert.equal(button.nextElementSibling.className, 'btnMoreCommands');
  assert.equal(button.getAttribute('aria-label'), 'jellyseerr_report_issue_button');
  button.click();
  assert.equal(h.document.querySelector('.jellyseerr-season-subtitle').textContent, 'Film');
  assert.match(h.document.querySelector('.jellyseerr-season-header').style.backgroundImage, /Items\/m1\/Images\/Backdrop/);
});

test('overlapping checks for one page add one button; a page left behind adds none', async t => {
  const item = deferred();
  const h = setup(t, { je: { helpers: { getItemCached: () => item.promise } } });
  const [first, second] = [h.R.tryAddButton(), h.R.tryAddButton()];
  item.resolve(MOVIE);
  assert.deepEqual([await first, await second], [true, true]);
  assert.equal(h.document.querySelectorAll('.jellyseerr-report-issue-icon').length, 1);

  const pending = deferred();
  const moved = setup(t, { je: { helpers: { getItemCached: () => pending.promise } } });
  const stale = moved.R.tryAddButton();
  moved.window.history.pushState(null, '', '#!/details?id=other');
  pending.resolve(MOVIE);
  assert.equal(await stale, false);
  assert.equal(moved.document.querySelector('.jellyseerr-report-issue-icon'), null);

  const switched = deferred();
  const account = setup(t, { je: { helpers: { getItemCached: () => switched.promise } } });
  const old = account.R.tryAddButton();
  account.switchUser();
  switched.resolve(MOVIE);
  assert.equal(await old, false);
  assert.equal(account.document.querySelector('.jellyseerr-report-issue-icon'), null);
});

for (const [name, item, reason] of [
  ['a music video', { Id: 'm1', Type: 'MusicVideo', ProviderIds: { Tmdb: '1' } }, 'unsupported'],
  ['a special season', { Id: 'm1', Type: 'Season', IndexNumber: 0, SeriesId: 's' }, 'special'],
  ['a special episode', { Id: 'm1', Type: 'Episode', ParentIndexNumber: 0, SeriesId: 's' }, 'special'],
  ['a title with no TMDB id', { Id: 'm1', Type: 'Movie' }, 'no id']
]) test(`${name} gets no button (${reason})`, async t => {
  const h = setup(t, { items: { m1: item } });
  assert.equal(await h.R.tryAddButton(), false);
  assert.equal(h.page().querySelector('.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon'), null);
});

test('a season and an episode report against their series', async t => {
  const h = setup(t, { items: { m1: { Id: 'm1', Type: 'Episode', Name: 'Ep', ParentIndexNumber: 1, SeriesId: 'series' }, series: { Id: 'series', Type: 'Series', ProviderIds: { Tmdb: '77' } } } });
  await h.R.tryAddButton();
  h.document.querySelector('.jellyseerr-report-issue-icon').click();
  h.pickType('1');
  h.submit();
  await h.settle();
  assert.equal(h.reports[0][0], '77');
  assert.equal(h.reports[0][1], 'tv');
});

test('Seerr being down shows a marked button whose click explains why', async t => {
  const h = setup(t, { status: { active: false } });
  assert.equal(await h.R.tryAddButton(), true);
  const button = h.document.querySelector('.jellyseerr-report-unavailable-icon');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.title, 'Jellyseerr is not available');
  button.click();
  assert.deepEqual(h.toasts.pop(), ['Jellyseerr is not available', 4000]);
  assert.equal(h.dialog(), null);
});

test('each unavailable reason has its own explanation', t => {
  const h = setup(t);
  const container = h.page();
  for (const [reason, toast] of [['no-tmdb', 'TMDB ID not found for this item'], ['no-both', 'TMDB ID not found and Jellyseerr is not available'], ['no-permissions', 'You do not have permissions to report issues'], ['other', 'jellyseerr_report_unavailable_toast']]) {
    h.R.createUnavailableButton(container, '', '', reason).click();
    assert.equal(h.toasts.pop()[0], toast);
  }
  assert.equal(h.R.createUnavailableButton(null, '', ''), null);
});

test('availability covers both services, and an error lets the report try', async t => {
  const series = { Id: 'x', Type: 'Series', ProviderIds: { Tmdb: '1' } };
  assert.equal(await setup(t, { status: { active: false } }).R.checkReportingAvailability({ Type: 'Movie' }), 'no-both');
  assert.equal(await setup(t).R.checkReportingAvailability({ Type: 'Movie' }), 'no-tmdb');
  assert.equal(await setup(t, { status: { active: false } }).R.checkReportingAvailability(series), 'no-jellyseerr');
  assert.equal(await setup(t).R.checkReportingAvailability(series), 'available');
  const broken = setup(t);
  broken.window.ApiClient.ajax = async () => { throw new Error('offline'); };
  assert.equal(await broken.R.checkReportingAvailability({ Type: 'Movie' }), 'available');
});

test('the fallback never lands on a title of another kind', async t => {
  const results = [{ id: 11, mediaType: 'person' }, { id: 22, mediaType: 'tv', name: 'Dune' }, { id: 33, mediaType: 'movie', title: 'Dune', releaseDate: '2021-10-22' }];
  const h = setup(t, { api: { search: async () => ({ results }) } });
  assert.equal(await h.R.getTmdbIdFallback('Dune', 'movie', { Name: 'Dune', ProviderIds: { Imdb: 'tt1' } }), '33');
  const wrongKind = setup(t, { api: { search: async () => ({ results: [{ id: 11, mediaType: 'person' }, { id: 22, mediaType: 'tv', title: 'Dune' }] }) } });
  assert.equal(await wrongKind.R.getTmdbIdFallback('Dune', 'movie', { Name: 'Dune', ProviderIds: { Imdb: 'tt1' } }), null);
  assert.equal(await wrongKind.R.getTmdbIdFallback('Dune', 'movie', { Name: 'Dune' }), null);
  const untyped = setup(t, { api: { search: async () => ({ results: [{ id: 5 }] }) } });
  assert.equal(await untyped.R.getTmdbIdFallback('Dune', 'movie', { Name: 'Dune' }), '5');
});

test('the fallback reads a TMDB link in each shape, and a search failure is no answer', async t => {
  const h = setup(t);
  assert.equal(await h.R.getTmdbIdFallback('x', 'movie', { ExternalUrls: [{ Name: 'TMDB', Url: 'https://www.themoviedb.org/tmdb/movie/42' }] }), '42');
  assert.equal(await h.R.getTmdbIdFallback('x', 'movie', { ExternalUrls: { a: 'https://tmdb.test/9' } }), '9');
  assert.equal(await h.R.getTmdbIdFallback('x', 'movie', { ExternalUrls: [{ other: 'see https://tmdb.test/8' }] }), '8');
  const failing = setup(t, { api: { search: async () => { throw new Error('offline'); } } });
  assert.equal(await failing.R.getTmdbIdFallback('x', 'movie', { Name: 'x' }), null);
  assert.equal(await failing.R.getTmdbIdFallback('x', 'movie', null), null);
});

test('open issues mark the button with a count, on a button still on the page', async t => {
  const reply = deferred();
  const h = setup(t, { config: { JellyseerrShowIssueIndicator: true }, api: { fetchIssuesForMedia: () => reply.promise } });
  await h.R.tryAddButton();
  const button = h.document.querySelector('.jellyseerr-report-issue-icon');
  reply.resolve({ results: Array.from({ length: 12 }, (_, id) => ({ id })) });
  await h.settle();
  assert.equal(button.querySelector('.jellyseerr-issue-count-badge').textContent, '9+');
  assert.ok(h.document.getElementById('je-issue-indicator-style'));
  assert.match(button.title, /^12 /);

  const late = deferred();
  const gone = setup(t, { config: { JellyseerrShowIssueIndicator: true }, api: { fetchIssuesForMedia: () => late.promise } });
  await gone.R.tryAddButton();
  const removed = gone.document.querySelector('.jellyseerr-report-issue-icon');
  removed.remove();
  late.resolve({ results: [{ id: 1 }] });
  await gone.settle();
  assert.equal(removed.querySelector('.jellyseerr-issue-count-badge'), null);
});

test('the indicator stays off unless configured', async t => {
  let asked = 0;
  const h = setup(t, { api: { fetchIssuesForMedia: async () => { asked++; return { results: [] }; } } });
  await h.R.applyIssueIndicator(h.page(), 1, 'movie');
  assert.equal(asked, 0);
});

test('initialize waits for Seerr, watches views once, and uses the bootstrap status', async t => {
  let prefetched = 0;
  const h = setup(t, { je: { takePrefetched: key => { prefetched++; assert.equal(key, 'SeerrStatus'); return { active: true }; } } });
  await h.R.initialize();
  await h.R.initialize();
  assert.equal(prefetched, 1);
  assert.equal(h.ajaxCalls.length, 0);
  h.clock.run(500);
  h.clock.run(100);
  await h.settle();
  assert.equal(h.document.querySelectorAll('.jellyseerr-report-issue-icon').length, 1);
  h.document.dispatchEvent(new h.window.Event('viewshow'));
  assert.deepEqual(h.clock.pending(), [100]);

  const inactive = setup(t, { status: { active: false } });
  await inactive.R.initialize();
  inactive.document.dispatchEvent(new inactive.window.Event('viewshow'));
  assert.deepEqual(inactive.clock.pending(), []);
});

test('with the feature off nothing runs', async t => {
  const h = setup(t, { config: { JellyseerrShowReportButton: false } });
  assert.equal(await h.R.tryAddButton(), false);
  await h.R.initialize();
  assert.equal(h.ajaxCalls.length, 0);
});

test('the public facade keeps its names', t => {
  const h = setup(t);
  for (const name of ['checkReportingAvailability', 'showReportModal', 'createReportButton', 'createUnavailableButton', 'getTmdbIdFallback', 'applyIssueIndicator', 'tryAddButton', 'initialize']) {
    assert.equal(typeof h.R[name], 'function', name);
  }
  assert.equal(h.R.createReportButton(null, 1, 'x', 'movie'), null);
});
