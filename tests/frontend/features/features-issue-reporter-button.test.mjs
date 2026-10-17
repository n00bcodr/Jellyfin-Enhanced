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
      ajax: async () => ({ active }),
      getUrl: path => path,
    },
  });
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.load('jellyseerr/issue-reporter.js');
  const row = () => [...h.document.querySelector('.mainDetailButtons').children].map(n => n.className.split(' ').find(c => /^(btn|je-|jellyseerr-)/.test(c)));
  return { ...h, reporter: h.JE.jellyseerrIssueReporter, reads, row };
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
