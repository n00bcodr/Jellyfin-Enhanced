import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// The Report issue icon on a details page: one per page view however many times the page asks for
// it (Jellyfin's viewshow and the reporter's own first look overlap on a fresh load), never one for
// the title the viewer has already left, and always in the same place in the action row.

const ROW = '<div id="itemDetailPage"><div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button><button class="btnMoreCommands detailButton">More</button></div></div>';
const ICONS = '.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * The issue reporter on a details page whose item reads and Seerr status the test answers by hand.
 * @param {object} t Test context.
 * @param {object} [options] Options.
 * @param {boolean} [options.active] Whether Seerr's status says it is up.
 * @param {string} [options.html] Page markup.
 * @returns {object} Harness, the reporter, the pending item reads and the row's classes.
 */
function page(t, { active = true, html = ROW } = {}) {
  const reads = [];
  const seerr = { active };
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#!/details?id=a',
    html,
    JE: {
      pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      t: key => key,
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true }) },
    },
    apiClient: {
      getItem: (_user, id) => { const d = deferred(); reads.push({ id, ...d }); return d.promise; },
      ajax: async () => ({ active: seerr.active }),
      getUrl: path => path,
    },
  });
  t.after(() => h.close());
  h.load('core/mutation-queue.js');
  h.load('core/ui-kit.js');
  h.load('jellyseerr/issue-reporter.js');
  const row = () => [...h.document.querySelector('.mainDetailButtons').children].map(n => n.className.split(' ').find(c => /^(btn|je-|jellyseerr-)/.test(c)));
  return { ...h, get NATIVE() { return h.NATIVE; }, reporter: h.JE.jellyseerrIssueReporter, reads, row, seerr };
}

const movie = id => ({ Id: id, Type: 'Movie', Name: `Movie ${id}`, ProviderIds: { Tmdb: id === 'a' ? '603' : '604' } });

test('overlapping looks at a page add one Report issue icon', async t => {
  const h = page(t);
  const calls = [h.reporter.tryAddButton(), h.reporter.tryAddButton(), h.reporter.tryAddButton()];
  await tick();
  // Answer every item read that was made (one per look before the fix).
  for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
  const answers = await Promise.all(calls);
  assert.deepEqual(answers, [true, true, true]);
  assert.equal(h.document.querySelectorAll(ICONS).length, 1);
  assert.deepEqual(h.row(), ['btnPlay', 'jellyseerr-report-issue-icon', 'btnMoreCommands']);
  // A later look finds it and adds nothing.
  assert.equal(await h.reporter.tryAddButton(), true);
  assert.equal(h.reads.length, 0);
  assert.equal(h.document.querySelectorAll(ICONS).length, 1);
});

test('overlapping looks while Seerr is down add one unavailable icon', async t => {
  const h = page(t, { active: false });
  const calls = [h.reporter.tryAddButton(), h.reporter.tryAddButton()];
  await tick();
  for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
  await Promise.all(calls);
  assert.equal(h.document.querySelectorAll(ICONS).length, 1);
  assert.ok(h.document.querySelector('.jellyseerr-report-unavailable-icon'));
});

test('a look that answers after the viewer moved to another title adds nothing for the old one', async t => {
  const h = page(t);
  const first = h.reporter.tryAddButton();
  await tick();
  // Jellyfin shows the next title in the same page element before the first read answers.
  h.window.location.hash = '#!/details?id=b';
  const second = h.reporter.tryAddButton();
  await tick();
  const [readA, readB] = h.reads.splice(0);
  readB.resolve(movie('b'));
  assert.equal(await second, true);
  readA.resolve(movie('a'));
  assert.equal(await first, false);
  const icons = h.document.querySelectorAll(ICONS);
  assert.equal(icons.length, 1);
  assert.equal(icons[0].dataset.jeItemId, 'b');
});

test('a page element Jellyfin reuses for the next title gets that title\'s icon, not the last one\'s', async t => {
  const h = page(t);
  const first = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('a'));
  await first;
  h.window.location.hash = '#!/details?id=b';
  const second = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('b'));
  assert.equal(await second, true);
  const icons = h.document.querySelectorAll(ICONS);
  assert.equal(icons.length, 1);
  assert.equal(icons[0].dataset.jeItemId, 'b');
});

test('Hide, Report issue and Spoiler Guard stand in one order before More…, whichever arrives first', async t => {
  const orders = [];
  for (const arrival of [['report', 'spoiler', 'hide'], ['spoiler', 'report', 'hide'], ['hide', 'spoiler', 'report']]) {
    const h = page(t);
    const add = cls => {
      const b = h.document.createElement('button');
      b.className = `button-flat detailButton ${cls}`;
      h.JE.core.ui.placeDetailAction(h.document.querySelector('.mainDetailButtons'), b);
    };
    for (const what of arrival) {
      if (what === 'hide') add('je-detail-hide-btn');
      else if (what === 'spoiler') add('je-spoiler-blur-btn');
      else {
        const call = h.reporter.tryAddButton();
        await tick();
        h.reads.shift().resolve(movie('a'));
        await call;
      }
    }
    // Placing a button that already stands right moves nothing.
    const spoiler = h.document.querySelector('.je-spoiler-blur-btn');
    const moved = [];
    new h.window.MutationObserver(m => moved.push(...m)).observe(h.document.querySelector('.mainDetailButtons'), { childList: true });
    h.JE.core.ui.placeDetailAction(h.document.querySelector('.mainDetailButtons'), spoiler);
    await tick();
    assert.equal(moved.length, 0);
    orders.push(h.row());
  }
  const expected = ['btnPlay', 'je-detail-hide-btn', 'jellyseerr-report-issue-icon', 'je-spoiler-blur-btn', 'btnMoreCommands'];
  assert.deepEqual(orders, [expected, expected, expected]);
});

test('on a row without More… (a native page) the icon stands before Spoiler Guard and the buttons the arr surfaces append', async t => {
  const h = page(t, { html: '<div id="itemDetailPage"><div class="mainDetailButtons"><div class="je-native-absent-primary"></div><button class="je-spoiler-pending-detail">S</button><button class="je-notify-follow-details">N</button><button class="je-manage-open">M</button></div></div>' });
  const call = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('a'));
  await call;
  assert.deepEqual(h.row(), ['je-native-absent-primary', 'jellyseerr-report-issue-icon', 'je-spoiler-pending-detail', 'je-notify-follow-details', 'je-manage-open']);
});

// Q-3I-10: an action row replaced by a copy of itself carries dead copies of JE's buttons (a copy
// has none of the original's listeners). Each module counts only the buttons it drew itself, so the
// copies go and one working button stands in its usual place.

for (const active of [true, false]) {
  test(`a row replaced by a copy of itself gets one working ${active ? 'Report issue' : 'unavailable'} icon at the next look`, async t => {
    const h = page(t, { active });
    const opened = [];
    h.reporter.showReportModal = (...args) => opened.push(args);
    const toasts = [];
    h.JE.toast = (...args) => toasts.push(args);
    const first = h.reporter.tryAddButton();
    await tick();
    h.reads.shift().resolve(movie('a'));
    assert.equal(await first, true);
    const row = h.document.querySelector('.mainDetailButtons');
    const copy = row.cloneNode(true);
    row.replaceWith(copy);
    const dead = copy.querySelector(ICONS);
    const look = h.reporter.tryAddButton();
    await tick();
    for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
    assert.equal(await look, true);
    const icons = h.document.querySelectorAll(ICONS);
    assert.equal(icons.length, 1, 'one icon');
    assert.equal(dead.isConnected, false, 'the dead copy is gone');
    assert.deepEqual(h.row(), ['btnPlay', active ? 'jellyseerr-report-issue-icon' : 'jellyseerr-report-unavailable-icon', 'btnMoreCommands']);
    icons[0].click();
    if (active) assert.deepEqual(opened.map(a => a[0]), ['603'], 'the icon opens the issue dialog');
    else assert.deepEqual(toasts, [['jellyseerr_report_unavailable_seerr_down', 4000]], 'the icon says why');
    // A later look keeps the icon. The working one is simply found; the unavailable one is checked
    // again (Seerr may answer now) and, Seerr still down, stays as it is.
    const later = h.reporter.tryAddButton();
    if (!active) {
      await tick();
      for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
    }
    assert.equal(await later, true);
    assert.equal(h.reads.length, 0);
    assert.deepEqual([...h.document.querySelectorAll(ICONS)], [icons[0]]);
  });
}

test('an icon the reporter did not draw (a copy kept beside its own) is removed at the next look', async t => {
  const h = page(t);
  const opened = [];
  h.reporter.showReportModal = (...args) => opened.push(args);
  const first = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('a'));
  await first;
  const own = h.document.querySelector(ICONS);
  own.before(own.cloneNode(true));
  assert.equal(await h.reporter.tryAddButton(), true);
  assert.deepEqual([...h.document.querySelectorAll(ICONS)], [own]);
  own.click();
  assert.equal(opened.length, 1);
});

const DETAILS = '<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="itemMiscInfo itemMiscInfo-primary"><div class="mediaInfoItem">2025</div></div>'
  + '<div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button><button class="btnMoreCommands detailButton">More</button></div></div>';

/**
 * A library details page with JE's three row buttons: Hide and Spoiler Guard (features-details-page.js
 * and spoilerguard/detail-button.js, run on the page's mutations) and Report issue (on viewshow).
 * @param {object} t Test context.
 * @returns {object} Harness, the runs and what each button's click reached.
 */
function libraryPage(t) {
  const debounced = {};
  const hidden = [], guarded = [], opened = [];
  const item = id => ({ Id: id, Type: 'Movie', Name: `Movie ${id}`, ProviderIds: { Tmdb: id === 'a' ? '603' : '604' } });
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#!/details?id=a',
    html: DETAILS,
    globals: { requestAnimationFrame: fn => { fn(); return 1; } },
    JE: {
      pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true, SpoilerBlurEnabled: true },
      currentSettings: {},
      t: key => key,
      jellyseerrAPI: { checkUserStatus: async () => ({ active: true, userFound: true }) },
      hiddenContent: {
        getSettings: () => ({ enabled: true, showHideButtons: true, showButtonDetails: true }),
        isHidden: () => false,
        confirmAndHide: data => hidden.push(data.itemId),
      },
      helpers: {
        getItemCached: async id => item(id),
        debounce: (fn, wait) => { debounced[wait] = fn; return () => {}; },
        createObserver: () => {}, onViewPage: () => {}, addCSS: () => {},
      },
      core: { navigation: { onViewPage: () => {}, onNavigate: () => {} } },
      internals: {
        spoilerGuard: {
          isStateLoaded: () => true,
          kindOf: () => 'movie',
          isEnabledForKind: () => false,
          enableForMovie: id => { guarded.push(id); return new Promise(() => {}); },
        },
      },
    },
    apiClient: { ajax: async () => ({ active: true }) },
  });
  t.after(() => h.close());
  h.load('core/mutation-queue.js');
  h.load('core/ui-kit.js');
  h.load('enhanced/spoilerguard/detail-button.js');
  h.JE.spoilerBlur = { addSpoilerBlurButton: h.JE.internals.spoilerGuard.addSpoilerBlurButton };
  h.load('enhanced/itemdetails/features-details-page.js');
  h.load('jellyseerr/issue-reporter.js');
  const reporter = h.JE.jellyseerrIssueReporter;
  reporter.showReportModal = (...args) => opened.push(args);
  const row = () => [...h.document.querySelector('.mainDetailButtons').children].map(n => n.className.split(' ').find(c => /^(btn|je-|jellyseerr-)/.test(c)));
  // The page's mutations settle (Hide and Spoiler Guard) and Jellyfin's viewshow (Report issue).
  const look = async () => {
    debounced[100]();
    await reporter.tryAddButton();
    await new Promise(resolve => setImmediate(resolve));
  };
  return { ...h, get NATIVE() { return h.NATIVE; }, look, row, hidden, guarded, opened };
}

test('a library row replaced by a copy of itself gets working Hide, Report issue and Spoiler Guard back, in their places', async t => {
  const h = libraryPage(t);
  await h.look();
  await h.look();
  const expected = ['btnPlay', 'je-detail-hide-btn', 'jellyseerr-report-issue-icon', 'je-spoiler-blur-btn', 'btnMoreCommands'];
  assert.deepEqual(h.row(), expected);
  for (let round = 1; round <= 2; round++) {
    const row = h.document.querySelector('.mainDetailButtons');
    row.replaceWith(row.cloneNode(true));
    await h.look();
    assert.deepEqual(h.row(), expected, `round ${round}: one of each, in order`);
    h.document.querySelector('.je-detail-hide-btn').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.hidden.length, round, `round ${round}: Hide works`);
    h.document.querySelector('.jellyseerr-report-issue-icon').click();
    assert.equal(h.opened.length, round, `round ${round}: Report issue works`);
    const spoiler = h.document.querySelector('.je-spoiler-blur-btn');
    spoiler.click();
    assert.equal(h.guarded.length, round, `round ${round}: Spoiler Guard works`);
    // The toggle in flight keeps it disabled; let the next round click a fresh one.
    spoiler.disabled = false;
  }
});

test('a page element reused for the next title gets a Hide button for that title, not the last one\'s', async t => {
  const h = libraryPage(t);
  await h.look();
  await h.look();
  h.window.location.hash = '#!/details?id=b';
  await h.look();
  await h.look();
  const hides = h.document.querySelectorAll('.je-detail-hide-btn');
  assert.equal(hides.length, 1);
  hides[0].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.hidden, ['b']);
});

// Q-3I-11: the unavailable icon explains why when pressed. It used to be a disabled button, which a
// browser never sends a click, so its toast never showed. It is now aria-disabled with the same
// look: a press (click, or Enter/Space, which a browser turns into a click on a button) shows the
// toast and does nothing else.

test('the unavailable icon explains why when pressed and does nothing else', async t => {
  const h = page(t, { active: false });
  const toasts = [];
  h.JE.toast = (...args) => toasts.push(args);
  const opened = [];
  h.reporter.showReportModal = (...args) => opened.push(args);
  const look = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('a'));
  assert.equal(await look, true);
  // Same place in the row as before.
  assert.deepEqual(h.row(), ['btnPlay', 'jellyseerr-report-unavailable-icon', 'btnMoreCommands']);
  const icon = h.document.querySelector('.jellyseerr-report-unavailable-icon');
  assert.equal(icon.tagName, 'BUTTON', 'a real button, so Enter and Space press it');
  assert.equal(icon.disabled, false, 'not disabled: a disabled button gets no click');
  assert.equal(icon.getAttribute('aria-disabled'), 'true', 'still announced as unavailable');
  assert.ok(icon.tabIndex >= 0, 'reachable from the keyboard');
  assert.equal(icon.getAttribute('aria-label'), 'jellyseerr_report_unavailable_seerr_down');
  assert.equal(icon.title, 'jellyseerr_report_unavailable_seerr_down');
  let bubbled = 0;
  h.document.querySelector('.mainDetailButtons').addEventListener('click', () => bubbled++);
  const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  icon.dispatchEvent(click);
  assert.deepEqual(toasts, [['jellyseerr_report_unavailable_seerr_down', 4000]], 'the toast says why');
  assert.equal(click.defaultPrevented, true);
  assert.equal(bubbled, 0, 'the press goes no further');
  assert.equal(opened.length, 0, 'no issue dialog');
  icon.click();
  assert.equal(toasts.length, 2, 'every press explains');
});

test('a page showing the unavailable icon gets the working one at its next look once Seerr answers again', async t => {
  const h = page(t, { active: false });
  const opened = [];
  h.reporter.showReportModal = (...args) => opened.push(args);
  const first = h.reporter.tryAddButton();
  await tick();
  h.reads.shift().resolve(movie('a'));
  assert.equal(await first, true);
  const unavailable = h.document.querySelector('.jellyseerr-report-unavailable-icon');
  assert.ok(unavailable);
  // Still down: the next look keeps the one unavailable icon.
  const again = h.reporter.tryAddButton();
  await tick();
  for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
  assert.equal(await again, true);
  assert.deepEqual([...h.document.querySelectorAll(ICONS)], [unavailable]);
  // Seerr answers again (Back to the same title: the same page element, a new look).
  h.seerr.active = true;
  const back = h.reporter.tryAddButton();
  await tick();
  for (const r of h.reads.splice(0)) r.resolve(movie(r.id));
  assert.equal(await back, true);
  const icons = h.document.querySelectorAll(ICONS);
  assert.equal(icons.length, 1, 'one icon');
  assert.ok(icons[0].classList.contains('jellyseerr-report-issue-icon'), 'the working icon');
  assert.equal(unavailable.isConnected, false, 'the unavailable icon is gone');
  assert.deepEqual(h.row(), ['btnPlay', 'jellyseerr-report-issue-icon', 'btnMoreCommands'], 'in the same place');
  icons[0].click();
  assert.deepEqual(opened.map(a => a[0]), ['603']);
  // From then on a look finds it and reads nothing.
  assert.equal(await h.reporter.tryAddButton(), true);
  assert.equal(h.reads.length, 0);
});

/**
 * The reporter with the real Seerr API module: the viewer's status read waits for the test, and every
 * Seerr read is recorded with the user it was sent as.
 */
function sessionPage(t) {
  let user = 'user-a'; let epoch = 1; const switches = []; const sent = []; const status = [];
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#!/details?id=a',
    html: ROW,
    JE: {
      pluginConfig: { JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      t: key => key,
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => switches.push(fn) },
      core: { api: { fetch: async url => {
        sent.push([user, url]);
        if (url.includes('/user-status')) { const d = deferred(); status.push(d); return d.promise; }
        return { mediaInfo: { id: 9 } };
      } } },
    },
    apiClient: {
      getCurrentUserId: () => user,
      getItem: async (_user, id) => movie(id),
      ajax: async () => ({ active: true }),
      getUrl: path => path,
    },
  });
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.load('jellyseerr/api.js');
  h.JE.jellyseerrAPI.surfaceUserStatusBanner = () => {};
  h.load('jellyseerr/issue-reporter.js');
  return { ...h, get NATIVE() { return h.NATIVE; }, reporter: h.JE.jellyseerrIssueReporter, sent, status,
    switchUser() { user = 'user-b'; epoch++; switches.forEach(fn => fn()); } };
}

test('a Report setup whose status read is cancelled by a user switch ends; it never continues as the new user', async t => {
  const h = sessionPage(t);
  const look = h.reporter.tryAddButton();
  await tick();
  assert.equal(h.status.length, 1);
  h.switchUser();
  // The shared transport cancels the outgoing user's read.
  h.status[0].reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  assert.equal(await look, false);
  assert.equal(h.document.querySelectorAll(ICONS).length, 0, 'no Report button with the previous user\'s item metadata');
  assert.deepEqual(h.sent.filter(([, url]) => !url.includes('/user-status')), [], 'no reportContext lookup sent as the new user');
});

test('a Report icon placed for the previous user is replaced at the next look', async t => {
  const h = sessionPage(t);
  const first = h.reporter.tryAddButton(); await tick();
  h.status[0].resolve({ active: true, userFound: true, canReportIssues: true });
  assert.equal(await first, true);
  const old = h.document.querySelector('.jellyseerr-report-issue-icon');
  h.switchUser();
  const second = h.reporter.tryAddButton(); await tick();
  h.status[1]?.resolve({ active: true, userFound: true, canReportIssues: true });
  assert.equal(await second, true);
  const icons = h.document.querySelectorAll(ICONS);
  assert.equal(icons.length, 1);
  assert.notEqual(icons[0], old);
});

test('controls: a same-session Report setup still places one working icon', async t => {
  const h = sessionPage(t);
  const look = h.reporter.tryAddButton(); await tick();
  h.status[0].resolve({ active: true, userFound: true, canReportIssues: true });
  assert.equal(await look, true);
  assert.equal(h.document.querySelectorAll('.jellyseerr-report-issue-icon').length, 1);
  assert.ok(h.sent.some(([user, url]) => user === 'user-a' && url.includes('/movie/603')));
});
