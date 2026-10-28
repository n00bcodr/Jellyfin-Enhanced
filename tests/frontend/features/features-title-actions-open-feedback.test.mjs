// Phase 2 menu-open feedback (perf-menu-open FIX BRIEF 1–3): every press on More, Request and More Info draws an owned,
// title-free loading shell in its own frame, before any read; the title and its choices are published into that same
// surface only after the viewer's admission, and a closed, refused or superseded opening never paints. The entry and
// sheet reads that need nothing from each other run together, decorative page reads wait in the low lane behind them,
// and the request sheet reuses a season list it read a moment ago. Real core transport and owners; only fetch is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jsRoot } from '../helpers/harness.mjs';
import { setup, mount, delivered, settle, moreInfo } from '../helpers/title-actions-scopes.mjs';

const SEASONS = [200, { seasons: [{ season_number: 1, episode_count: 10, air_date: '2011-04-17' }, { season_number: 2, episode_count: 10, air_date: '2012-04-01' }] }];

/** The card harness: one absent title card ("The Matrix") with its More control. */
async function cardHarness(t) {
  const h = setup(t, { card: true }); h.a.initialize(); await settle();
  return { h, card: h.document.querySelector('.card'), more: h.document.querySelector('.card .je-card-more') };
}

test('row More: a title-free shell is drawn in the press frame, and the choices are drawn into it once admitted', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  const admission = h.hold('GET', '/title-actions/');
  h.click(h.row().querySelector('.je-actions-more'));
  // No await: the press's own frame.
  const shell = h.document.querySelector('.je-actions-shell');
  assert.ok(shell, 'a loading shell is drawn before any read answers');
  assert.equal(shell.getAttribute('aria-busy'), 'true');
  assert.equal(shell.querySelectorAll('.je-actions-entry').length, 0, 'no choice before admission');
  assert.ok(shell.querySelector('.je-actions-close'), 'the shell can be closed at once');
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'nothing is published while the admission is pending');
  admission.resolve();
  await delivered();
  const sheet = h.document.querySelector('.je-actions-sheet');
  assert.equal(sheet, shell, 'the same owned surface becomes the sheet');
  assert.equal(sheet.hasAttribute('aria-busy'), false);
  assert.ok(sheet.querySelectorAll('.je-actions-entry').length > 0);
  assert.equal(h.document.querySelector('.je-actions-shell'), null);
  assert.equal(h.document.activeElement, sheet.querySelector('.je-actions-entry:not(:disabled)'), 'focus moves to the first choice');
});

test('card More: the title appears only after admission, and no per-title read leaves before it answers', async t => {
  const { h, more } = await cardHarness(t);
  const admission = h.hold('GET', '/title-actions/');
  const status = h.hold('GET', '/acquire/status');
  const statusBefore = h.sent('GET', '/acquire/status').length;
  h.click(more);
  const shell = h.document.querySelector('.je-actions-shell');
  assert.ok(shell);
  await delivered();
  assert.equal(shell.textContent.includes('The Matrix'), false, 'no title before the admission answers');
  assert.equal(h.sent('GET', '/acquire/status').length, statusBefore, 'the title status is not read while the admission is pending');
  admission.resolve();
  await delivered();
  assert.equal(h.sent('GET', '/acquire/status').length, statusBefore + 1, 'read once the title is admitted');
  assert.equal(shell.querySelector('.je-actions-subtitle').textContent, 'The Matrix', 'the admitted title is named while its details load');
  assert.equal(shell.querySelectorAll('.je-actions-entry').length, 0);
  status.resolve();
  await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), shell);
  assert.ok(shell.querySelector('.je-actions-entry'));
});

test('a refused opening takes its shell away, publishes nothing and gives focus back', async t => {
  const { h, more } = await cardHarness(t);
  const admission = h.hold('GET', '/title-actions/');
  more.focus();
  h.click(more);
  assert.ok(h.document.querySelector('.je-actions-shell'));
  admission.resolve({ allowed: false });
  await delivered();
  assert.equal(h.document.querySelector('.je-actions-shell'), null);
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.equal(h.document.querySelector('.je-actions-shell-backdrop'), null);
  assert.equal(h.document.activeElement, more);
});

test('closing the shell while loading ends the opening: its late reads never draw a sheet', async t => {
  const { h, more } = await cardHarness(t);
  const admission = h.hold('GET', '/title-actions/');
  h.click(more);
  h.click(h.document.querySelector('.je-actions-shell .je-actions-close'));
  assert.equal(h.document.querySelector('.je-actions-shell'), null);
  admission.resolve();
  await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.equal(h.document.querySelector('.je-actions-backdrop, .je-actions-shell-backdrop'), null);
});

test('Escape closes a loading shell too, and the row opening it belonged to draws nothing later', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  const admission = h.hold('GET', '/title-actions/');
  h.click(h.row().querySelector('.je-actions-more'));
  h.key(h.document.activeElement, 'Escape');
  assert.equal(h.document.querySelector('.je-actions-shell'), null);
  admission.resolve();
  await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
});

test('a superseded opening never paints into the newer opening\'s shell or sheet', async t => {
  const { h } = await cardHarness(t);
  // Two current openings (the page under a shell takes no press, so the newer one comes from the surface's own API):
  // each mounts its shell; the older one's late answer must not draw into the newer one's.
  const olderOwner = h.a.generation(), newerOwner = h.a.generation();
  const older = h.a.pending(null, olderOwner);
  const newer = h.a.pending(null, newerOwner);
  assert.equal(older.backdrop.isConnected, false, 'the newer shell replaced the older one');
  const entries = [{ id: 'share', group: 'other', icon: 'share', label: 'Share', run() {} }];
  assert.equal(h.a.show({ name: 'Older' }, entries, null, olderOwner, { shell: older }), false);
  assert.equal(h.document.querySelector('.je-actions-sheet'), null, 'nothing drawn by the superseded opening');
  assert.equal(newer.sheet.querySelectorAll('.je-actions-entry').length, 0);
  assert.equal(newer.subtitle.textContent, '');
  h.a.titled(older, 'Older');
  assert.equal(newer.subtitle.textContent, '', 'the older opening cannot name the newer shell');
  assert.equal(h.a.show({ name: 'Newer' }, entries, null, newerOwner, { shell: newer }), true);
  assert.equal(h.document.querySelector('.je-actions-sheet'), newer.sheet);
  assert.equal(newer.subtitle.textContent, 'Newer');
  // A stale opening's cleanup leaves the newer sheet alone.
  h.a.discard(older);
  assert.equal(h.document.querySelector('.je-actions-sheet'), newer.sheet);
});

test('a sheet entry shows that it is working in the press frame while its action is admitted', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  h.click(h.row().querySelector('.je-actions-more')); await delivered();
  const entry = h.document.querySelector('.je-actions-entry[data-action="request"]');
  assert.ok(entry, 'the sheet offers Request');
  const admission = h.hold('GET', '/title-actions/');
  h.click(entry);
  assert.equal(entry.getAttribute('aria-busy'), 'true', 'busy before the admission answers');
  admission.resolve({ allowed: false });
  await delivered();
  assert.equal(entry.hasAttribute('aria-busy'), false, 'a refused action leaves the entry as it was');
  assert.equal(h.document.querySelector('.je-sheet, .je-sheet-shell'), null, 'nothing opened for a refused action');
});

test('a row control (the bar\'s Request) shows that it is working while its action is admitted', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  const control = h.row().querySelector('[data-je-action-kind="request"]');
  assert.ok(control, 'the row has its adapted Request');
  const admission = h.hold('GET', '/title-actions/');
  h.click(control);
  assert.equal(control.getAttribute('aria-busy'), 'true', 'busy before the admission answers');
  admission.resolve({ allowed: false });
  await delivered();
  assert.equal(control.hasAttribute('aria-busy'), false);
  assert.equal(h.document.querySelector('.je-sheet, .je-sheet-shell'), null, 'nothing opened for a refused action');
});

test('decorative page reads in flight do not hold the admission of a More press in the client queue', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  // Four rating reads of the page (as many as the client sends at once) that do not answer.
  const gates = [601, 602, 604, 605].map(id => h.hold('GET', `/native-details/title/movie/${id}/ratings`));
  const reads = [601, 602, 604, 605].map(id => h.JE.internals.moreInfoModal.fetchRatings(id, 'movie', { publicDetails: true }));
  await delivered();
  const before = h.sent('GET', '/title-actions/').length;
  h.click(h.row().querySelector('.je-actions-more'));
  await delivered();
  assert.equal(h.sent('GET', '/title-actions/').length, before + 1, 'the admission is sent while the decorative reads are still out');
  await delivered();
  assert.ok(h.document.querySelector('.je-actions-sheet'), 'the sheet is drawn without waiting for them');
  gates.forEach(g => g.resolve({}));
  await Promise.all(reads);
});

test('the decorative page reads are sent on the low lane', () => {
  // Each caller's read of decoration the page draws later (FIX BRIEF 2): never the menu's own admission or state.
  const sites = {
    'awards/awards.js': /api\.plugin\(`\/awards\/[^;]*priority: 'low'/,
    'others/mdblist-ratings.js': /api\.plugin\(`\/mdblist-ratings\/[^;]*priority: 'low'/,
    'elsewhere/reviews.js': /api\.fetch\(url, \{ cacheKey: `tmdb:\$\{path\}`, priority: 'low' \}\)/,
    'jellyseerr/item-details.js': /const fetchOptions = \{ signal, priority: 'low' \};/,
    'jellyseerr/nativedetails/native-details.js': /api\.plugin\(path, \{ skipCache: true, priority: 'low' \}\)/,
    'tags/peopletags.js': /api\.plugin\(path, \{ signal, skipRetry: true, bound: action\?\.bound\?\.\(\), priority: 'low' \}\)/,
    'jellyseerr/moreinfo/more-info-modal-data.js': /fetchPublic\(`\/title\/[^;]*\/ratings`, \{ priority: 'low' \}\)/,
  };
  for (const [file, pattern] of Object.entries(sites)) assert.match(readFileSync(resolve(jsRoot, file), 'utf8'), pattern, file);
  const reviews = readFileSync(resolve(jsRoot, 'elsewhere/reviews.js'), 'utf8');
  assert.match(reviews, /api\.plugin\(`\/reviews\/\$\{mediaType\}\/\$\{tmdbId\}`, \{ priority: 'low' \}\)/, 'user reviews');
  assert.match(readFileSync(resolve(jsRoot, 'tags/peopletags.js'), 'utf8'), /peopleInfoPath\(chunk\), \{ signal: ctl\.signal, skipRetry: true, priority: 'low' \}/, 'people prefetch');
});

/** Opens the series request sheet the way a title action does (the press's owner). */
function openSeries(h, owner) {
  return h.JE.arrAskSheet.open({ key: 'tv:tmdb:1399', kind: 'series', name: 'Game of Thrones' }, { operation: owner });
}

test('request sheet: a shell with its Cancel is drawn before the capabilities answer, and its reads start together', async t => {
  const h = setup(t);
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  const caps = h.hold('GET', '/acquire/requests/me');
  const opening = openSeries(h, h.NATIVE);
  const shell = h.document.querySelector('.je-sheet-shell');
  assert.ok(shell, 'the shell is drawn in the press frame');
  assert.equal(shell.getAttribute('aria-busy'), 'true');
  assert.ok(shell.querySelector('.je-sheet-secondary'), 'Cancel is there at once');
  assert.equal(h.document.querySelector('.je-sheet'), null);
  assert.equal(h.document.querySelector('.je-sheet-primary'), null, 'no submission control before the facts are in');
  await delivered();
  assert.equal(h.sent('GET', '/acquire/requests/quota').length, 1, 'quota is read alongside the capabilities');
  assert.equal(h.sent('GET', '/acquire/requests/check').length, 1, 'the standard check is read alongside the capabilities');
  assert.equal(h.sent('GET', '/tmdb/tv/1399').length, 1, 'the seasons are read alongside the capabilities');
  const backdrop = shell.parentElement;
  caps.resolve();
  await delivered();
  const sheet = h.document.querySelector('.je-sheet');
  assert.ok(sheet);
  assert.equal(sheet.parentElement, backdrop, 'the sheet is built into the shell\'s surface');
  assert.equal(h.document.querySelector('.je-sheet-shell'), null);
  h.JE.arrAskSheet.close();
  assert.equal(await opening, null);
});

test('request sheet: Cancel while loading ends the opening; no sheet is built when its reads answer', async t => {
  const h = setup(t);
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  const caps = h.hold('GET', '/acquire/requests/me');
  const opening = openSeries(h, h.NATIVE);
  h.click(h.document.querySelector('.je-sheet-shell .je-sheet-secondary'));
  assert.equal(h.document.querySelector('.je-sheet-shell'), null);
  caps.resolve();
  assert.equal(await opening, null);
  await delivered();
  assert.equal(h.document.querySelector('.je-sheet'), null);
  assert.equal(h.document.querySelector('.je-sheet-backdrop, .je-sheet-shell-backdrop'), null);
});

test('request sheet: no submission is offered while its title check is pending, and the check it answers decides', async t => {
  const h = setup(t);
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  const check = h.hold('GET', '/acquire/requests/check');
  const opening = openSeries(h, h.NATIVE);
  await delivered();
  assert.ok(h.document.querySelector('.je-sheet-shell'), 'still loading: capabilities and quota answered, the check did not');
  assert.equal(h.document.querySelector('.je-sheet-primary'), null);
  check.resolve({ check: { canRequest: false, blocked: { reason: 'blocked_rule', rules: [] } } });
  await delivered();
  const primary = h.document.querySelector('.je-sheet-primary');
  assert.ok(primary);
  assert.ok(primary.hidden || primary.disabled, 'a blocked title offers no live submission');
  h.JE.arrAskSheet.close();
  await opening;
});

test('a newer request-sheet opening supersedes a loading one; the older answer builds nothing', async t => {
  const h = setup(t);
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  h.respond('GET', '/tmdb/tv/1400', [200, { seasons: [1, 2, 3].map(n => ({ season_number: n, episode_count: 8, air_date: `201${n}-01-01` })) }]);
  const firstCaps = h.hold('GET', '/acquire/requests/me');
  const first = openSeries(h, h.NATIVE);
  const older = h.document.querySelector('.je-sheet-shell');
  const second = h.JE.arrAskSheet.open({ key: 'tv:tmdb:1400', kind: 'series', name: 'Another' }, { operation: h.NATIVE });
  assert.equal(older.isConnected, false, 'the newer press replaced the older shell');
  assert.ok(h.document.querySelector('.je-sheet-shell'));
  assert.equal(await first, null);
  firstCaps.resolve();
  await delivered();
  assert.equal(h.document.querySelectorAll('.je-sheet').length, 1);
  assert.equal(h.document.querySelectorAll('.je-sheet .je-sheet-check input').length, 3, 'only the newer opening (three seasons) built its sheet');
  h.JE.arrAskSheet.close();
  await second;
});

test('request sheet: reopening the same series reuses the season list it read; another account reads again', async t => {
  const h = setup(t);
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  for (let i = 0; i < 2; i++) {
    const opening = openSeries(h, h.NATIVE);
    await delivered();
    assert.ok(h.document.querySelector('.je-sheet'));
    h.JE.arrAskSheet.close(); await opening;
  }
  assert.equal(h.sent('GET', '/tmdb/tv/1399').length, 1, 'one season read for two openings');
  h.switchUser(); await delivered();
  const opening = openSeries(h, h.NATIVE);
  await delivered();
  h.JE.arrAskSheet.close(); await opening;
  assert.equal(h.sent('GET', '/tmdb/tv/1399').length, 2, 'the list is not carried across accounts');
});

test('More Info: a title-free shell is drawn at once and becomes the window in place', async t => {
  const h = setup(t);
  const details = h.hold('GET', '/jellyseerr/movie/603');
  const opening = h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  const shell = h.document.querySelector('.je-more-info-shell');
  assert.ok(shell, 'the shell is drawn before the details answer');
  assert.equal(shell.getAttribute('aria-busy'), 'true');
  assert.equal(moreInfo(h), null);
  assert.equal(shell.textContent.includes('Matrix'), false);
  assert.ok(shell.querySelector('.je-more-info-shell-close'));
  details.resolve();
  await opening; await delivered();
  assert.equal(moreInfo(h), shell, 'the same surface is the window');
  assert.equal(shell.hasAttribute('aria-busy'), false);
  assert.ok(shell.getAttribute('aria-labelledby'), 'named by its title');
  assert.ok(shell.textContent.includes('The Matrix'));
});

test('More Info: closing the shell while loading means no window opens when the details answer', async t => {
  const h = setup(t);
  const details = h.hold('GET', '/jellyseerr/movie/603');
  const opening = h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  h.click(h.document.querySelector('.je-more-info-shell-close'));
  assert.equal(h.document.querySelector('.je-more-info-shell'), null);
  details.resolve();
  await opening; await delivered();
  assert.equal(moreInfo(h), null);
});

test('More Info: a superseded opening draws nothing; only the newest opening\'s window appears', async t => {
  const h = setup(t);
  const movie = h.hold('GET', '/jellyseerr/movie/603');
  const show = h.hold('GET', '/jellyseerr/tv/1399');
  const first = h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE);
  const second = h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE);
  assert.equal(h.document.querySelectorAll('.je-more-info-shell').length, 1);
  movie.resolve();
  await first; await delivered();
  assert.equal(moreInfo(h), null, 'the older answer opened no window');
  assert.ok(h.document.querySelector('.je-more-info-shell'), 'the newer shell is still loading');
  show.resolve();
  await second; await delivered();
  assert.equal(moreInfo(h)?.dataset.tmdbId, '1399');
});

test('with Seerr off, the Seerr quota is not asked for (no 503 and no console error on JE-mode pages)', async t => {
  const h = setup(t);
  h.JE.pluginConfig.JellyseerrEnabled = false;
  assert.equal(await h.JE.jellyseerrAPI.fetchUserQuota(), null);
  assert.equal(h.sent('GET', '/jellyseerr/quota').length, 0);
});

// Review round 2 (PMR-1 to PMR-4), the reviewer's probes as regressions.

test('PMR-3: a busy More entry takes one submission; a second press while it is admitted does nothing', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  h.click(h.row().querySelector('.je-actions-more')); await delivered();
  let shares = 0;
  Object.defineProperty(h.window.navigator, 'share', { configurable: true, value: async () => { shares++; } });
  const gate = h.hold('GET', '/title-actions/');
  const entry = h.document.querySelector('.je-actions-entry[data-action="share"]');
  h.click(entry); h.click(entry);
  assert.equal(entry.getAttribute('aria-busy'), 'true');
  gate.resolve(); await delivered();
  assert.equal(shares, 1, 'one busy entry dispatches Share once');
});

test('PMR-3: a busy adapted bar control takes one submission, and is pressable again once it settles', async t => {
  const h = setup(t);
  h.respond('GET', '/title-actions/', [200, { allowed: true, itemId: 'a'.repeat(32) }]);
  let opens = 0; h.JE.titleDetails.openItem = () => { opens++; };
  h.a.initialize(); mount(h); await delivered();
  const control = h.row().querySelector('[data-je-action-kind="open"]');
  assert.ok(control);
  const gate = h.hold('GET', '/title-actions/');
  h.click(control); h.click(control);
  assert.equal(control.getAttribute('aria-busy'), 'true');
  gate.resolve(); await delivered();
  assert.equal(opens, 1, 'one busy bar control dispatches Open once');
  assert.equal(control.hasAttribute('aria-busy'), false);
  h.click(control); await delivered();
  assert.equal(opens, 2, 'a settled control takes the next press');
});

test('PMR-4: the visible compact Request shows busy in the press frame and clears when its action settles', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await delivered();
  const gate = h.hold('GET', '/title-actions/');
  const proxy = h.row().querySelector('.je-actions-row .je-actions-primary');
  assert.ok(proxy);
  h.click(proxy);
  assert.equal(proxy.getAttribute('aria-busy'), 'true', 'the visible pressed control shows the busy feedback');
  h.click(proxy);
  assert.equal(h.sent('GET', '/title-actions/').filter(r => r[2].startsWith('/title-actions/movie/603')).length >= 1, true);
  gate.resolve({ allowed: false }); await delivered();
  assert.equal(proxy.hasAttribute('aria-busy'), false, 'cleared with its source after the refusal');
  assert.equal(h.document.querySelector('.je-sheet, .je-sheet-shell'), null);
});

test('PMR-1: a More opening fetches no title facts before admission answers (and none after a refusal)', async t => {
  const h = setup(t, { card: true }); h.a.initialize(); await delivered();
  const gate = h.hold('GET', '/title-actions/');
  const before = h.sent('GET', '/acquire/status').length;
  h.click(h.document.querySelector('.card .je-card-more'));
  await delivered();
  assert.equal(h.sent('GET', '/acquire/status').length - before, 0, 'no per-title status read while admission remains unanswered');
  gate.resolve({ allowed: false }); await delivered();
  assert.equal(h.sent('GET', '/acquire/status').length - before, 0, 'nor after the refusal');
});

test('PMR-2: a refused row opening never reads report context or runs providers', async t => {
  const h = setup(t); h.a.initialize();
  let reports = 0, providers = 0;
  const reportContext = h.JE.jellyseerrAPI.reportContext;
  h.JE.jellyseerrAPI.reportContext = async (...args) => { reports++; return reportContext(...args); };
  h.a.register('pmr-probe', async () => { providers++; return null; });
  const gate = h.hold('GET', '/title-actions/');
  mount(h);
  h.click(h.row().querySelector('.je-actions-more, .je-actions-wide-more'));
  gate.resolve({ allowed: false }); await delivered();
  assert.equal(h.document.querySelector('.je-actions-sheet'), null);
  assert.deepEqual({ reports, providers, titleReads: h.sent('GET', '/jellyseerr/movie/603').length }, { reports: 0, providers: 0, titleReads: 0 });
});

// Review round 3 (PMR2-1): a closed row opening swallows its late error as it swallows its late success.

test('PMR2-1: a row opening closed before admission shows no late error and reads nothing more', async t => {
  const h = setup(t); h.a.initialize();
  let providers = 0;
  h.a.register('pmr2-closed', () => { providers++; return null; });
  const gate = h.hold('GET', '/title-actions/');
  mount(h);
  h.click(h.row().querySelector('.je-actions-more, .je-actions-wide-more'));
  await delivered();
  h.click(h.document.querySelector('.je-actions-close'));
  // The title's Seerr record read fails once (the late error), then answers again.
  let failed = false;
  h.respond('GET', '/jellyseerr/movie/603', () => failed ? null : (failed = true, [403, {}]));
  const before = h.toasts.length;
  gate.resolve(); await delivered();
  assert.equal(h.document.querySelector('.je-actions-shell, .je-actions-sheet'), null);
  assert.deepEqual(h.toasts.slice(before), [], 'a cancelled opening shows no failure after the viewer closed it');
  // (The row's own setup reads its Report control's title record: that is the row's, not the closed opening's.)
  assert.equal(providers, 0, 'the closed opening runs no provider');
  // The row itself is still live: a new press opens its sheet.
  h.click(h.row().querySelector('.je-actions-more, .je-actions-wide-more')); await delivered();
  assert.ok(h.document.querySelector('.je-actions-sheet'), 'the row opens again');
});

test('PMR2-1: an operation submitted from a row sheet outlives the sheet closing', async t => {
  const h = setup(t);
  h.respond('GET', '/title-actions/', [200, { allowed: true, itemId: 'a'.repeat(32) }]);
  let opens = 0; h.JE.titleDetails.openItem = () => { opens++; };
  h.a.initialize(); mount(h); await delivered();
  h.click(h.row().querySelector('.je-actions-more, .je-actions-wide-more')); await delivered();
  const gate = h.hold('GET', '/title-actions/');
  h.click(h.document.querySelector('.je-actions-entry[data-action="open"]'));
  gate.resolve(); await delivered();
  assert.equal(opens, 1, 'Open runs after its sheet closed for it');
});

// ---- UX3R-3 (review round 1): a whole absent-title session in Jellyfin Enhanced mode sends Seerr nothing ----

const JE_SEERR_OFF = { JellyseerrEnabled: false, SeerrAvailable: false, ArrRequestsJeMode: true, NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } };

/** Rows, cards, More sheets, More Info (movie and series), the request sheet and every quota caller, one after another. */
async function absentTitleSession(h) {
  h.a.initialize(); mount(h); await delivered();
  h.click(h.row().querySelector('.je-actions-more')); await settle();
  h.key(h.document.activeElement, 'Escape'); await settle();
  const more = h.document.querySelector('.card .je-card-more');
  if (more) { h.click(more); await settle(); h.key(h.document.activeElement, 'Escape'); await settle(); }
  await h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.NATIVE); await settle();
  h.JE.jellyseerrMoreInfo.close(); await settle();
  await h.JE.jellyseerrMoreInfo.open(1399, 'tv', undefined, h.NATIVE); await settle();
  h.JE.jellyseerrMoreInfo.close(); await settle();
  h.respond('GET', '/tmdb/tv/1399', SEASONS);
  const series = h.JE.arrAskSheet.open({ key: 'tv:tmdb:1399', kind: 'series', name: 'Game of Thrones' }, { operation: h.NATIVE });
  await settle(); h.JE.arrAskSheet.close(); await series;
  const movie = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }, { operation: h.NATIVE });
  await settle(); h.JE.arrAskSheet.close(); await movie;
  // The request and season windows and the quota dialog all read the quota this way.
  assert.equal(await h.JE.jellyseerrAPI.fetchUserQuota(), null);
  assert.equal(await h.JE.jellyseerrAPI.fetchUserQuota({ skipCache: true }), null);
}

test('UX3R-3: with Seerr off, a full absent-title session in JE mode sends no request to any Seerr route', async t => {
  const h = setup(t, { card: true, beforeLoad: h => Object.assign(h.JE.pluginConfig, JE_SEERR_OFF) });
  h.respond('GET', '/native-details/title/movie/603', [200, { id: 603, title: 'The Matrix', mediaInfo: { status: 1 } }]);
  h.respond('GET', '/native-details/title/tv/1399', [200, { id: 1399, name: 'Game of Thrones', seasons: [{ seasonNumber: 1 }], mediaInfo: { status: 1 } }]);
  await absentTitleSession(h);
  assert.ok(h.requests.length > 10, 'the session did its JE reads');
  assert.ok(h.sent('GET', '/native-details/title/').length >= 2, 'More Info read the public details');
  assert.deepEqual(h.requests.filter(r => r[2].startsWith('/jellyseerr/')).map(r => r[1] + ' ' + r[2]), []);
});

test('UX3R-3: with Seerr on but Jellyfin Enhanced handling requests, nothing asks Seerr for a quota', async t => {
  const h = setup(t, { card: true, beforeLoad: h => Object.assign(h.JE.pluginConfig, { ...JE_SEERR_OFF, JellyseerrEnabled: true, SeerrAvailable: true }) });
  h.respond('GET', '/native-details/title/movie/603', [200, { id: 603, title: 'The Matrix', mediaInfo: { status: 1 } }]);
  h.respond('GET', '/native-details/title/tv/1399', [200, { id: 1399, name: 'Game of Thrones', seasons: [{ seasonNumber: 1 }], mediaInfo: { status: 1 } }]);
  await absentTitleSession(h);
  assert.equal(h.sent('GET', '/jellyseerr/quota').length, 0);
});

test('UX3R-3 control: Seerr handling requests still reads the viewer\'s Seerr quota for its request windows', async t => {
  const h = setup(t);
  h.respond('GET', '/jellyseerr/quota', [200, { movie: { limit: 5, used: 1 }, tv: { limit: 5, used: 0 } }]);
  assert.ok(await h.JE.jellyseerrAPI.fetchUserQuota({ skipCache: true }));
  assert.equal(h.sent('GET', '/jellyseerr/quota').length, 1);
});
