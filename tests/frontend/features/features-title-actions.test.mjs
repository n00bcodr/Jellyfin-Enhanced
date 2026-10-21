import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

function setup(t, extra = {}) {
  const calls = [];
  let user = 'user-a';
  const h = createHarness({
    html: '<button id="opener">More</button><div id="host"></div>',
    JE: {
      t: k => k,
      pluginConfig: { NativeAbsentDetails: { enabled: true }, NativeAbsentDetailsEnabled: true },
      core: { api: { plugin: async path => { calls.push(path); return { allowed: true, id: 603, title: 'Title' }; } } },
      titleDetails: { openKey: (...args) => calls.push(args) },
      ...extra,
    }, apiClient: { getCurrentUserId: () => user },
  });
  t.after(() => { h.JE.titleActions?.dispose?.(); h.close(); });
  h.load('arr/actions/title-actions.js');
  h.load('arr/actions/title-actions-sheet.js');
  return { ...h, get NATIVE() { return h.NATIVE; }, calls, actions: h.JE.titleActions, switchUser: () => { user = 'user-b'; } };
}

test('typed provider identity preserves movie, series and exact child scopes; rejects invented IDs', t => {
  const { actions: a } = setup(t);
  assert.equal(a.context({ mediaType: 'movie', id: 603 }).key, 'movie:tmdb:603');
  const tv = a.context({ mediaType: 'tv', id: 603, season: 2, episode: 4 });
  assert.equal(tv.key, 'tv:tmdb:603:s2:e4');
  assert.equal(tv.titleKey, 'tv:tmdb:603');
  for (const data of [{ id: 603 }, { mediaType: 'person', id: 603 }, { mediaType: 'movie', id: -1 }, { mediaType: 'movie', id: 603, season: 1 }, { mediaType: 'tv', id: 603, episode: 2 }]) assert.equal(a.context(data), null);
});

test('a retained native Request reads its displayed title when invoked after metadata arrives', async t => {
  let requested;
  const h = setup(t, { arrAsk: { enabled: () => true, me: async () => ({}), canAsk: () => true }, arrAskSheet: { open: input => { requested = input; } } });
  const root = h.document.querySelector('#host');
  const entries = await h.actions.entries(h.actions.fromKey('movie:tmdb:603'), { root });
  root.innerHTML = '<div class="nameContainer"><h1 class="itemName">The Matrix</h1></div>';
  entries.find(e => e.id === 'request').run();
  assert.equal(requested.name, 'The Matrix');
  assert.equal(requested.key, 'movie:tmdb:603');
});

test('shared links contain only stable identity and scope, never sender data or credentials', t => {
  const { actions: a } = setup(t);
  const link = a.shareUrl(a.context({ mediaType: 'tv', id: 603, season: 2, episode: 4, title: 'SECRET', jeSpoiler: { guarded: true } }));
  assert.match(link, /jeTitle=tv%3Atmdb%3A603%3As2%3Ae4/);
  assert.doesNotMatch(link, /SECRET|token|guarded|user-a/);
});

test('receiver authenticates and resolves under their own public title projection', async t => {
  const { actions: a, calls } = setup(t);
  await a.receive('tv:tmdb:603:s2:e4');
  assert.equal(calls[0], '/title-actions/tv/603?season=2&episode=4');
  assert.ok(calls.some(c => typeof c === 'string' && c.includes('/season/2')));
  assert.equal(calls.at(-1)[0], 'tv:tmdb:603:s2:e4');
  assert.equal(calls.at(-1)[1].owner.current(), true, 'the key lookup carries the receive generation as its owner');
});

test('revoked receiver access never navigates', async t => {
  let navigated = false;
  const { actions: a } = setup(t, { core: { api: { plugin: async () => { throw new Error('403'); } } }, titleDetails: { openKey: () => { navigated = true; } } });
  assert.equal(await a.receive('movie:tmdb:603'), false);
  assert.equal(navigated, false);
});

test('receiver identity switch during body read rejects stale navigation', async t => {
  const gate = deferred();
  const { actions: a, switchUser, calls } = setup(t, { core: { api: { plugin: () => gate.promise } } });
  const pending = a.receive('movie:tmdb:603');
  switchUser(); gate.resolve({ id: 603 });
  assert.equal(await pending, false);
  assert.equal(calls.length, 0);
});

test('no list entry renders until its owner registers; unregister removes capability', async t => {
  const { actions: a } = setup(t);
  const c = a.context({ mediaType: 'movie', id: 603 });
  assert.equal((await a.entries(c)).some(e => e.id === 'list'), false);
  const release = a.register('list', async () => ({ id: 'list', group: 'view', label: 'Add to collection', run() {} }));
  assert.equal((await a.entries(c)).filter(e => e.id === 'list').length, 1);
  release();
  assert.equal((await a.entries(c)).some(e => e.id === 'list'), false);
});

test('absent capability menu never offers file mutations or fake favourite', async t => {
  const { actions: a } = setup(t);
  const entries = await a.entries(a.context({ mediaType: 'movie', id: 603 }));
  assert.deepEqual(plain(entries.map(e => e.id)), ['share']);
});

test('sheet keyboard and TV directions trap focus and Back restores opener', t => {
  const h = setup(t);
  const { actions: a, document: d } = h;
  const opener = d.querySelector('#opener'); opener.focus();
  a.show({ name: 'Title' }, [{ id: 'one', group: 'view', label: 'One', run() {} }, { id: 'two', group: 'view', label: 'Two', run() {} }], opener, a.generation());
  const dialog = d.querySelector('[role="dialog"]');
  assert.ok(dialog);
  const one = dialog.querySelector('[data-action="one"]');
  // The viewer's keys (a script's key event moves and dismisses nothing: D46S2-R12-3).
  one.focus(); h.key(one, 'ArrowDown');
  assert.equal(d.activeElement.dataset.action, 'two');
  h.key(d.activeElement, 'Escape');
  assert.equal(d.querySelector('[role="dialog"]'), null);
  assert.equal(d.activeElement, opener);
});

test('sheet source proxies use the original handler and reflect disabled/pressed state', t => {
  const { actions: a, click, document: d } = setup(t);
  const source = d.createElement('button'); let writes = 0;
  source.textContent = 'Played'; source.setAttribute('aria-pressed', 'true');
  source.onclick = () => { writes++; }; d.body.append(source);
  a.show({ name: 'Title' }, [{ id: 'played', group: 'watch', source, label: 'Played' }], d.querySelector('#opener'), a.generation());
  click(d.querySelector('[data-action="played"]'));
  assert.equal(writes, 1);
  source.disabled = true;
  a.show({}, [{ id: 'played', group: 'watch', source, label: 'Played' }], undefined, a.generation());
  assert.equal(d.querySelector('[data-action="played"]').disabled, true);
});

test('a naturally sized native row uses available parent space without compact/wide oscillation', async t => {
  const { actions: a, document: d, load } = setup(t);
  load('arr/actions/title-actions-hosts.js');
  const root = d.createElement('div'); root.innerHTML = '<div class="detailRibbon"><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnUserRating">Favourite</button><button class="btnPlaystate">Played</button></div></div>'; d.body.append(root);
  const row = root.querySelector('.mainDetailButtons');
  row.getBoundingClientRect = () => ({ width: row.classList.contains('je-actions-compact') ? 900 : 180 });
  row.parentElement.getBoundingClientRect = () => ({ width: 1000 });
  a.mountRow(row, root, null);
  for (let n = 0; n < 4; n++) a.scan();
  assert.equal(row.classList.contains('je-actions-compact'), false, 'the original controls fit within their parent');
  assert.equal(row.querySelector('.je-actions-row'), null);
});

test('Report presents its owner issue count once alongside a stable action label', t => {
  const { actions: a, document: d } = setup(t);
  const source = d.createElement('button'); source.title = '1 Open Issues - Report issue';
  source.innerHTML = '<span class="jellyseerr-issue-count-badge">1</span>'; d.body.append(source);
  a.show({}, [{ id: 'report', group: 'requests', source, label: source.title }], undefined, a.generation());
  assert.equal(d.querySelector('.je-actions-entry-label').textContent, 'jellyseerr_report_issue_button');
  assert.equal(d.querySelector('.je-actions-state').textContent, 'title_actions_open_issues');
  source.setAttribute('aria-disabled', 'true'); source.title = 'Not enough permissions to report';
  a.show({}, [{ id: 'report', group: 'requests', source, label: 'Report' }], undefined, a.generation());
  assert.equal(d.querySelector('.je-actions-reason')?.textContent, source.title);
});

test('the Report indicator owner updates one badge and removes it when issues resolve', async t => {
  let results = [{ id: 1 }];
  const h = setup(t, { pluginConfig: { JellyseerrShowIssueIndicator: true }, jellyseerrAPI: { fetchIssuesForMedia: async () => ({ results }) } });
  h.load('jellyseerr/issue-reporter.js'); const owner = h.JE.jellyseerrIssueReporter;
  const b = owner.createReportButton(h.document.body, '603', 'Title', 'movie'); h.document.body.append(b);
  await owner.applyIssueIndicator(b, '603', 'movie'); await owner.applyIssueIndicator(b, '603', 'movie');
  assert.equal(b.querySelectorAll('.jellyseerr-issue-count-badge').length, 1);
  results = []; await owner.applyIssueIndicator(b, '603', 'movie');
  assert.equal(b.querySelector('.jellyseerr-issue-count-badge'), null);
  assert.equal(b.title, 'jellyseerr_report_issue_button');
});

test('a Report indicator read cannot publish a previous user badge or style after switching', async t => {
  const gate = deferred();
  const h = setup(t, { pluginConfig: { JellyseerrShowIssueIndicator: true }, jellyseerrAPI: { fetchIssuesForMedia: () => gate.promise } });
  h.load('jellyseerr/issue-reporter.js'); const b = h.document.createElement('button'); h.document.body.append(b);
  const pending = h.JE.jellyseerrIssueReporter.applyIssueIndicator(b, '603', 'movie');
  h.switchUser(); gate.resolve({ results: [{ id: 1 }] }); await pending;
  assert.equal(b.querySelector('.jellyseerr-issue-count-badge'), null);
  assert.equal(h.document.querySelector('#je-issue-indicator-style'), null);
});

test('a successful Report clears the existing owner issue-list cache only for its submitting session', async t => {
  const cleared = [], gate = deferred(); let delayed = false;
  const h = setup(t, { requestManager: { clearCacheMatching: key => cleared.push(key) },
    core: { api: { fetch: async () => ({ mediaInfo: { id: 99 } }), plugin: async () => delayed ? gate.promise : { id: 1 } } } });
  h.load('jellyseerr/api.js');
  await h.JE.jellyseerrAPI.reportIssue(603, 'movie', 4, 'Catalogue', 0, 0, h.NATIVE);
  assert.deepEqual(cleared, ['jellyseerr:/issue']);
  delayed = true; const pending = h.JE.jellyseerrAPI.reportIssue(603, 'movie', 4, 'Catalogue', 0, 0, h.NATIVE);
  await new Promise(resolve => setImmediate(resolve)); h.switchUser(); gate.resolve({ id: 2 });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cleared.length, 1);
});

test('a sheet opened by A cannot invoke a source control as B', t => {
  const { actions: a, click, document: d, switchUser } = setup(t);
  const source = d.createElement('button'); let writes = 0; source.onclick = () => writes++; d.body.append(source);
  a.show({}, [{ id: 'native', group: 'other', source, label: 'Native' }], undefined, a.generation());
  switchUser(); click(d.querySelector('[data-action="native"]'));
  assert.equal(writes, 0);
});

test('owned controls execute before sheet teardown removes their source', t => {
  const { actions: a, click, document: d } = setup(t);
  const control = d.createElement('button'); let writes = 0; control.onclick = () => writes++;
  a.show({}, [{ id: 'guard', group: 'view', control, label: 'Guard' }], undefined, a.generation());
  click(d.querySelector('[data-action="guard"]'));
  assert.equal(writes, 1);
});

test('recycled cards get one live More button; real native cards retain their context menu', async t => {
  const { actions: a, document: d, window: w, load } = setup(t);
  const card = d.createElement('div'); card.className = 'jellyseerr-card';
  card.innerHTML = '<a data-tmdb-id="603" data-media-type="movie">Title</a>';
  d.body.append(card);
  // The host entry point is also used after a bounded mutation batch.
  load('arr/actions/title-actions-hosts.js');
  a.scan(); a.scan();
  assert.equal(card.querySelectorAll('.je-card-more').length, 1);
  card.querySelector('a').dataset.tmdbId = '604'; a.scan();
  assert.equal(card.querySelectorAll('.je-card-more').length, 1);
  assert.equal(card.querySelector('.je-card-more').dataset.jeActionKey, 'movie:tmdb:604');
  const real = d.createElement('div'); real.className = 'card'; real.dataset.id = '12345678901234567890123456789012'; d.body.append(real);
  const event = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); real.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test('Discover and search menu titles read the title separately from the displayed year', t => {
  const h = setup(t);
  h.load('arr/actions/title-actions-hosts.js');
  const card = h.document.createElement('div');
  card.className = 'je-discover-card'; card.dataset.key = 'movie:tmdb:1236045';
  card.innerHTML = '<div class="je-discover-name"><bdi>Animals</bdi><span class="je-discover-year">2026</span></div>';
  h.document.body.append(card);
  assert.equal(h.actions.cardContext(card).name, 'Animals');
});

test('Seerr card menu titles read the title link, never the overview Request button or the link tooltip', t => {
  const h = setup(t);
  h.load('arr/actions/title-actions-hosts.js');
  const card = h.document.createElement('div');
  card.className = 'card jellyseerr-card';
  // ui-cards.js order: the overview (with its Request button) is appended inside cardScalable, ahead of the title link.
  card.innerHTML = '<div class="cardScalable"><div class="jellyseerr-overview"><div class="content">Zion defends itself.</div>'
    + '<button class="jellyseerr-request-button" data-tmdb-id="55" data-media-type="movie">Request<span class="material-icons">more_horiz</span></button></div></div>'
    + '<div class="cardText cardText-first"><a class="jellyseerr-more-info-link" data-tmdb-id="55" data-media-type="movie" title="View on Seerr"><bdi>The Matrix Revolutions</bdi></a></div>';
  h.document.body.append(card);
  assert.equal(h.actions.cardContext(card).name, 'The Matrix Revolutions');
  card.querySelector('.cardText-first').remove();
  assert.equal(h.actions.cardContext(card).name, '');
  assert.equal(h.actions.cardContext(card).key, 'movie:tmdb:55');
});

test('compact row proxies originals; a cloned row is remounted; wide rows keep native controls', t => {
  const { actions: a, click, document: d, load } = setup(t);
  load('arr/actions/title-actions-hosts.js');
  const row = d.createElement('div'); row.className = 'mainDetailButtons';
  row.innerHTML = '<button class="btnPlay" aria-label="Play">Play</button><button class="btnUserRating" aria-label="Favourite">Heart</button><button class="btnPlayed" title="Played">Played</button><button class="btnMoreCommands" title="More">More</button><button class="extra" title="Plugin">Plugin</button>';
  d.body.append(row);
  row.getBoundingClientRect = () => ({ width: 288 });
  let plays = 0; row.querySelector('.btnPlay').onclick = () => plays++;
  a.mountRow(row, row, null);
  assert.equal(row.querySelectorAll('.je-actions-row').length, 1);
  click(row.querySelector('.je-actions-primary')); assert.equal(plays, 1);
  a.mountRow(row, row, null); assert.equal(row.querySelectorAll('.je-actions-more').length, 1);
  const clone = row.cloneNode(true); row.replaceWith(clone); clone.getBoundingClientRect = () => ({ width: 288 });
  clone.querySelector('.btnPlay').onclick = () => plays++;
  a.mountRow(clone, clone, null); click(clone.querySelector('.je-actions-primary')); assert.equal(plays, 2);
  clone.getBoundingClientRect = () => ({ width: 1600 }); a.mountRow(clone, clone, null);
  assert.equal(clone.classList.contains('je-actions-compact'), false);
  assert.equal(clone.querySelector('.je-actions-row'), null);
});

test('provider controls and registered extension entries are rejected after delayed user switch', async t => {
  const gate = deferred();
  const { actions: a, switchUser } = setup(t);
  a.register('list', () => gate.promise);
  const result = a.entries(a.context({ mediaType: 'movie', id: 603 }));
  switchUser(); gate.resolve({ id: 'list', label: 'List', run() {} });
  assert.deepEqual(plain(await result), []);
});

test('follow settlement cannot start a reread under a replacement identity', async t => {
  const gate = deferred(); const paths = [];
  const { JE, load, switchUser, NATIVE } = setup(t, { core: { api: { plugin: (path, options) => { paths.push([path, options]); return gate.promise; } } } });
  load('arr/notify/notify-core.js');
  const pending = JE.arrNotify.setFollow('movie:tmdb:603', true, NATIVE);
  switchUser(); gate.resolve({});
  assert.equal((await pending).ok, false);
  assert.equal(paths.length, 1);
});

test('native synthetic and provider Report owners exclude nonexistent file issue types', t => {
  let modal;
  const h = setup(t, {
    escapeHtml: String, icon: () => '', IconName: {},
    titleDetails: { parse: id => id === 'synthetic' ? { kind: 'movie', tmdbId: 603 } : null },
    jellyseerrAPI: { fetchIssuesForMedia: async () => ({ results: [] }) },
    jellyseerrModal: { create: opts => {
      modal = h.document.createElement('div'); modal.innerHTML = opts.bodyHtml;
      return { modalElement: modal, show() { h.document.body.append(modal); }, close() { modal.remove(); } };
    } },
  });
  h.load('jellyseerr/issue-reporter.js');
  for (const item of [{ Id: 'synthetic' }, { jeAbsent: true }]) {
    h.JE.jellyseerrIssueReporter.showReportModal('603', 'Title', 'movie', null, item, h.NATIVE);
    assert.deepEqual([...modal.querySelectorAll('[name="issue-type"]')].map(n => n.value), ['4']);
    modal.remove();
  }
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'Title', 'movie', null, { Id: 'real' }, h.NATIVE);
  assert.equal(modal.querySelectorAll('[name="issue-type"]').length, 4);
});

test('report modal rejects delayed submit after a live user switch', async t => {
  let options; let modal; let sends = 0;
  const h = setup(t, {
    escapeHtml: s => String(s), icon: () => '', IconName: {}, toast() {},
    jellyseerrAPI: { fetchIssuesForMedia: async () => ({ results: [] }), reportIssue: async () => { sends++; return {}; } },
    jellyseerrModal: { create: opts => {
      options = opts; modal = h.document.createElement('div'); modal.innerHTML = opts.bodyHtml;
      // The shell registers its element for its owner, as the real one does (a press inside it is that owner's).
      h.JE.openSurface(modal, () => {}, opts.operation);
      return { modalElement: modal, show() { h.document.body.append(modal); }, close() { modal.remove(); } };
    } },
  });
  h.load('jellyseerr/issue-reporter.js');
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'Title', 'movie', null, null, h.NATIVE);
  modal.querySelector('input[name="issue-type"]').checked = true;
  h.switchUser();
  await h.pressIn(modal, e => options.onSave(modal, h.document.createElement('button'), () => {}, e));
  assert.equal(sends, 0);
});

test('absent row never proxies native Play even when native DOM still contains it', t => {
  const { actions: a, document: d, load } = setup(t); load('arr/actions/title-actions-hosts.js');
  const row = d.createElement('div'); row.className = 'mainDetailButtons';
  row.innerHTML = '<button class="btnPlay" aria-label="Play">Play</button><button class="je-ask-mount-request" aria-label="Request">Request</button><button class="je-detail-hide-btn">Hide</button><button class="je-spoiler-pending-detail">Guard</button><button class="je-notify-follow">Follow</button><button class="btnPlayed">Played</button>';
  d.body.append(row); row.getBoundingClientRect = () => ({ width: 288 });
  a.mountRow(row, row, a.context({ mediaType: 'movie', id: 603 }));
  assert.equal(row.querySelector('.je-actions-primary').getAttribute('aria-label'), 'Request');
});

test('Manage retains its opening identity across the feed-position await', async t => {
  const gate = deferred(); const sends = [];
  const h = setup(t, {
    pluginConfig: { ArrManageDrawerEnabled: true }, internals: { arrManage: {} },
    arrStatus: { enabled: () => true, tr: key => key, icon: () => h.document.createElement('span'), feedPosition: () => gate.promise },
    core: { api: { plugin: async path => { sends.push(path); return {}; } } },
  });
  h.load('arr/manage/manage-drawer.js');
  const pending = h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.NATIVE });
  h.switchUser(); gate.resolve({ epoch: 'e', cursor: 1 }); await pending;
  assert.equal(sends.length, 0); h.JE.arrManage.close();
});

test('absent source proxies recheck admission and cannot send after access is revoked', async t => {
  const { actions: a, document: d } = setup(t, { core: { api: { plugin: async () => ({ allowed: false }) } } });
  const source = d.createElement('button'); let sends = 0; source.onclick = () => sends++; d.body.append(source);
  assert.equal(await a.invoke(a.context({ mediaType: 'movie', id: 603 }), { source }), false);
  assert.equal(sends, 0);
});

test('a library detail page already mounted when the bundle finishes receives the row immediately', async t => {
  let callback; let options;
  const h = setup(t, { helpers: { getItemCached: async id => ({ Id: id, Type: 'Movie', Name: 'Movie', ProviderIds: { Tmdb: '603' } }) } });
  h.JE.core.navigation = { onViewPage: (fn, opts) => { callback = fn; options = opts; if (opts?.immediate) fn('details', h.document.querySelector('#itemDetailPage')); } };
  h.window.location.hash = '#/details?id=12345678901234567890123456789012';
  h.document.body.insertAdjacentHTML('beforeend', '<div id="itemDetailPage" class="libraryPage"><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnPlayed">Played</button><button class="btnUserRating">Favourite</button><button class="extra">Extra</button></div></div>');
  h.load('arr/actions/title-actions-hosts.js'); h.JE.titleActions.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(options.immediate, true);
  assert.equal(typeof callback, 'function');
  assert.equal(h.document.querySelectorAll('.je-actions-wide-more').length, 1);
});

// D53 r2: the sheet is the offer (closing it before a press cancels); a press is an operation that outlives it.
test('a sheet closed before the press runs nothing; a press followed by closing the sheet still completes', async t => {
  const gate = deferred(); let opened = 0;
  const { actions: a, click, document: d } = setup(t, { core: { api: { plugin: () => gate.promise } } });
  a.show(a.context({ mediaType: 'movie', id: 603 }), [{ id: 'manage', group: 'requests', label: 'Manage', run() { opened++; } }], undefined, a.generation());
  const entry = d.querySelector('[data-action="manage"]');
  a.close(); click(entry); gate.resolve({ allowed: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 0, 'dismissed offer');
  a.show(a.context({ mediaType: 'movie', id: 603 }), [{ id: 'manage', group: 'requests', label: 'Manage', run() { opened++; } }], undefined, a.generation());
  click(d.querySelector('[data-action="manage"]')); a.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1, 'submitted operation');
});

test('observer reconciliation preserves restored focus on the compact More control', async t => {
  const h = setup(t); h.load('arr/actions/title-actions-hosts.js');
  const row = h.document.createElement('div'); row.className = 'mainDetailButtons';
  row.innerHTML = '<button class="btnPlay">Play</button><button class="btnUserRating">Favourite</button><button class="btnPlayed">Played</button><button class="extra">Extra</button>';
  row.getBoundingClientRect = () => ({ width: 288 }); h.document.body.append(row);
  h.JE.titleActions.mountRow(row, row, null); h.JE.titleActions.initialize();
  const more = row.querySelector('.je-actions-more');
  h.JE.titleActions.show({}, [{ id: 'one', label: 'One', group: 'view', run() {} }], more, h.NATIVE);
  h.JE.titleActions.close();
  await new Promise(resolve => h.window.requestAnimationFrame(() => h.window.requestAnimationFrame(resolve)));
  assert.equal(h.document.activeElement, more);
});

test('a More Info background made inert by its own sheet retains one live row and restores focus', async t => {
  const h = setup(t); h.load('arr/actions/title-actions-hosts.js');
  const root = h.document.createElement('div'); root.className = 'je-more-info-modal'; root.dataset.tmdbId = '603';
  root.innerHTML = '<div class="mainDetailButtons"><button data-je-action-kind="request">Request</button><button class="extra">Extra</button></div>';
  h.document.body.append(root); const row = root.firstElementChild;
  row.getBoundingClientRect = () => ({ width: 100 });
  const c = h.actions.context({ mediaType: 'movie', id: 603 });
  h.actions.mountRow(row, root, c); h.actions.initialize();
  const more = row.querySelector('.je-actions-more');
  h.actions.show(c, [{ id: 'share', label: 'Share', run() {} }], more, h.actions.generation());
  await new Promise(resolve => h.window.setTimeout(resolve, 50));
  h.actions.scan();
  assert.equal(row.querySelector('.je-actions-more'), more, 'inert is temporary background state, not expired ownership');
  h.actions.close();
  assert.equal(h.document.activeElement, more);
  assert.equal(!!root.inert, false);
});

test('More Info privacy actions retain and proxy the existing secondary owner controls', async t => {
  const h = setup(t); h.load('arr/actions/title-actions-hosts.js');
  const root = h.document.createElement('div'); root.className = 'je-more-info-modal'; root.dataset.tmdbId = '603';
  root.innerHTML = '<div class="mainDetailButtons"><button data-je-action-kind="request">Request</button></div><div><button class="je-spoiler-blur-btn" aria-pressed="true">Guard</button><button class="je-detail-hide-btn">Hide</button></div>';
  h.document.body.append(root); const row = root.firstElementChild; row.getBoundingClientRect = () => ({ width: 100 });
  let toggles = 0; const original = root.querySelector('.je-spoiler-blur-btn'); original.onclick = () => toggles++;
  h.actions.mountRow(row, root, h.actions.context({ mediaType: 'movie', id: 603 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row.querySelector('[data-je-action-kind="guard"]'), null);
  assert.equal(original.isConnected, true);
  assert.equal(original.classList.contains('je-actions-external-original'), true);
  h.click(row.querySelector('.je-actions-more')); await new Promise(resolve => setImmediate(resolve));
  const proxy = h.document.querySelector('.je-actions-entry[data-action="guard"]');
  assert.equal(proxy.getAttribute('aria-pressed'), 'true');
  h.click(proxy); await new Promise(resolve => setImmediate(resolve));
  assert.equal(toggles, 1);
});

test('a narrow More Info action mount spans the header and returns to its owner when wide', t => {
  const h = setup(t); h.load('arr/actions/title-actions-hosts.js');
  Object.defineProperty(h.window, 'innerWidth', { value: 390, writable: true });
  const root = h.document.createElement('div'); root.className = 'je-more-info-modal';
  root.innerHTML = '<div class="header-section"><div class="header-poster"></div><div class="header-info"><div class="mainDetailButtons"><button class="btnPlay">Play</button><button class="btnUserRating">Favourite</button></div><div id="secondary"></div></div></div>';
  h.document.body.append(root); const row = root.querySelector('.mainDetailButtons'), home = row.parentElement;
  home.getBoundingClientRect = () => ({ width: 100 });
  h.actions.mountRow(row, root, null);
  assert.equal(row.parentElement, root.querySelector('.header-section'));
  const more = row.querySelector('.je-actions-more'); more.focus();
  h.window.innerWidth = 1440; h.actions.mountRow(row, root, null);
  assert.equal(row.parentElement, home);
  assert.equal(row.nextElementSibling.id, 'secondary');
  assert.equal(h.document.activeElement, more);
});

test('existing modal Follow and Manage owners supply the compact row and sheet without duplicate visible controls', async t => {
  const h = setup(t, { pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true },
    arrNotify: { enabled: () => true, loadFollows: async () => {}, isFollowing: () => false },
    arrStatus: { enabled: () => true, fetchKey: async () => ({ items: [{ admin: {} }] }) }, arrManage: { open() { throw Error('must proxy original'); } } });
  h.load('arr/actions/title-actions-hosts.js');
  const root = h.document.createElement('div'); root.className = 'je-more-info-modal'; root.dataset.tmdbId = '603';
  root.innerHTML = '<div class="mainDetailButtons"><button data-je-action-kind="request">Request</button></div><button class="je-notify-follow">Notify me</button><button class="je-arr-modal-manage">Manage</button>';
  h.document.body.append(root); const row = root.firstElementChild; row.getBoundingClientRect = () => ({ width: 100 });
  let follows = 0, manages = 0;
  root.querySelector('.je-notify-follow').onclick = () => follows++;
  root.querySelector('.je-arr-modal-manage').onclick = () => manages++;
  h.actions.mountRow(row, root, h.actions.fromKey('movie:tmdb:603'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(root.querySelectorAll('.je-actions-external-original').length, 2);
  h.click(row.querySelector('.je-actions-row [data-action="follow"]')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(follows, 1);
  h.click(row.querySelector('.je-actions-more')); await new Promise(resolve => setImmediate(resolve));
  h.click(h.document.querySelector('.je-actions-entry[data-action="manage"]')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manages, 1);
});

test('Report capability follows write permission independently of issue-list read permission', async t => {
  for (const [read, write] of [[false, true], [true, false]]) {
    const h = setup(t, { pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      jellyseerrIssueReporter: {}, jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true, canViewIssues: read, canReportIssues: write }) } });
    const entry = (await h.actions.entries(h.actions.context({ mediaType: 'movie', id: 603 }))).find(e => e.id === 'report');
    assert.equal(entry.disabled, !write);
  }
});

test('admin status object supplies Manage; admission supplies only the viewer actual-copy action', async t => {
  const h = setup(t, { pluginConfig: { ArrManageDrawerEnabled: true }, arrManage: { open() {} },
    core: { api: { plugin: async () => ({ allowed: true, itemId: '12345678901234567890123456789012' }) } },
    arrStatus: { enabled: () => true, fetchKey: async () => ({ items: [{ admin: { variants: [] }, stage: 'ready' }] }) } });
  const c = h.actions.context({ mediaType: 'movie', id: 603 });
  await h.actions.admit(c, h.JE.createSessionAction());
  const ids = (await h.actions.entries(c)).map(e => e.id);
  assert.ok(ids.includes('manage')); assert.ok(ids.includes('open'));
});

test('linked reporting without a Seerr media record has an honest disabled reason', async t => {
  const h = setup(t, { pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true }, jellyseerrIssueReporter: {},
    jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true, canReportIssues: true }), reportContext: async () => ({ mediaId: null }) } });
  const report = (await h.actions.entries(h.actions.context({ mediaType: 'movie', id: 603 }))).find(e => e.id === 'report');
  assert.equal(report.disabled, true); assert.equal(report.reason, 'title_actions_report_no_record');
});

test('request proxies omit icon ligatures from their spoken and visible label', t => {
  const h = setup(t); h.load('arr/actions/title-actions-hosts.js');
  const row = h.document.createElement('div'); row.className = 'mainDetailButtons'; row.getBoundingClientRect = () => ({ width: 288 });
  row.innerHTML = '<div><button class="je-ask-mount-request"><span class="material-icons" aria-hidden="true">add</span><span>Request</span></button></div><button class="je-notify-follow">Follow</button><button class="je-detail-hide-btn">Hide</button><button class="je-spoiler-pending-detail">Guard</button>';
  h.document.body.append(row); h.JE.titleActions.mountRow(row, row, h.actions.context({ mediaType: 'movie', id: 603 }));
  assert.equal(row.querySelector('.je-actions-primary-label').textContent, 'Request');
  assert.equal(row.querySelector('.je-actions-primary').getAttribute('aria-label'), 'Request');
});
