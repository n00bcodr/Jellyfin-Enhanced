// Requests & downloads: searching the administrator's Activity history (words with a 300 ms pause,
// event and instance chips, Prev / Next, "the newest N of M since …" per instance), with every read
// fenced by an intent token: an answer for a search no longer asked is dropped, a reload during a
// read makes exactly one trailing read, focus and the caret survive redraws, and empty / error
// states offer Clear filters / Try again. Real modules, server answers from the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';
import { fakeClock } from '../helpers/fake-clock.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/live/arr-intent.js',
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js',
  'arr/admin/admin-styles.js', 'arr/admin/admin-render.js', 'arr/admin/admin-tabs.js',
  'arr/hub/hub-page.js'
];
const USER = '0123456789abcdef0123456789abcdef';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const iso = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const card = (id, name, kind) => ({ id, name, kind, role: 'standard', url: `http://${kind.toLowerCase()}:7878`, urlMappings: '', live: { expected: false }, queue: 0, queueAttention: 0, health: 'ok', healthIssues: 0, disks: [] });

/** The server's Activity answer for a search: 50 rows a page out of `total` rows named after the search. */
function answer(params, { total = 120, rows, coverage } = {}) {
  const q = params.get('q') || undefined;
  const event = params.get('event') || undefined;
  const instance = params.get('instance') || undefined;
  const pages = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(Math.max(1, Number(params.get('page') || 1)), pages);
  const count = Math.max(0, Math.min(50, total - (page - 1) * 50));
  const label = `${q || 'all'}|${event || 'any'}|${instance || 'every'}|p${page}`;
  return {
    instances: [card('r1', 'Radarr', 'Radarr'), card('s1', 'Sonarr', 'Sonarr')],
    queue: [],
    history: rows || Array.from({ length: count }, (_, i) => ({ instanceId: 'r1', instance: 'Radarr', event: 'grabbed', title: `${label} #${i}`, date: iso(-i - 1) })),
    historyPage: {
      q, event, instance, page, pages, total, pageSize: 50,
      coverage: coverage || [
        { instanceId: 'r1', instance: 'Radarr', held: 2000, total: 5312, since: '2026-10-03T08:00:00Z', complete: false, unread: false },
        { instanceId: 's1', instance: 'Sonarr', held: 420, total: 420, since: '2026-09-01T08:00:00Z', complete: true, unread: false }
      ]
    }
  };
}

function setup(t, { reply, globals } = {}) {
  const calls = [];
  const userChange = new Map();
  let epoch = 0;
  const h = createHarness({
    html: '<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>',
    url: 'http://jellyfin.test/web/index.html#/requests?tab=activity',
    globals,
    apiClient: { getCurrentUserId: () => USER, serverAddress: () => 'http://jellyfin.test' },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrManageDrawerEnabled: true },
      t: translate,
      helpers: { debounce: fn => fn, onSidebarRebuilt: () => {} },
      jellyseerrAPI: { resolveJellyseerrBaseUrl: () => null },
      core: {
        api: {
          plugin: async (path, options) => {
            if (path === '/acquire/hub') return { contact: 'Dad', lookingHours: 24, seerr: { configured: false }, mine: [], soon: [], ready: [], admin: { downloads: true, calendar: true, hub: true } };
            if (!path.startsWith('/arr/admin/hub/activity')) return null;
            const params = new URL(path, 'http://x').searchParams;
            const call = { path, params, options };
            calls.push(call);
            const out = reply ? reply(params, call, calls.length) : answer(params);
            if (out instanceof Error) throw out;
            return out;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: { live: { position: () => ({ epoch: 'e1', cursor: 1 }) } },
      calendarPage: { renderForCustomTab: () => {} },
      downloadsPage: { renderForCustomTab: () => {} },
      session: {
        getEpoch: () => epoch,
        isCurrent: e => e === epoch,
        onUserChange: (key, fn) => { userChange.set(key, fn); }
      }
    }
  });
  t.after(() => {
    h.JE.internals?.arrHub?.admin?.leave?.();
    h.close();
  });
  for (const m of MODULES) h.load(m);
  const A = () => h.JE.internals.arrHub.admin;
  const page = () => h.document.getElementById('je-requests-hub-page');
  const input = () => page()?.querySelector('.je-history-input');
  const type = (value) => {
    const box = input();
    box.focus();
    box.value = value;
    box.setSelectionRange(value.length, value.length);
    box.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  };
  const switchUser = () => {
    epoch++;
    for (const fn of userChange.values()) fn();
  };
  return { ...h, calls, A, page, input, type, switchUser };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(5);
  assert.ok(check(), 'condition never met');
}

const titles = (h) => [...h.page().querySelectorAll('.je-history tbody tr td:nth-child(3)')].map(td => td.firstChild.textContent);

test('the history opens on page 1 of every event with the counts, the pager and what each instance covers', async t => {
  const h = setup(t);
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('.je-history tbody tr'));
  assert.equal(h.calls[0].path, '/arr/admin/hub/activity?page=1');
  const history = h.page().querySelector('.je-history');
  assert.equal(history.querySelector('.je-history-status').textContent, '120 events');
  assert.deepEqual([...history.querySelectorAll('.je-history-coverage')].map(n => n.textContent.replace(/since .*/, 'since <date>')), [
    'Radarr: showing the newest 2,000 of 5,312 events, since <date>',
    'Sonarr: all 420 events'
  ]);
  assert.equal(history.querySelectorAll('tbody tr').length, 50);
  assert.equal(history.querySelector('.je-history-page').textContent, 'Page 1 of 3');
  assert.equal(history.querySelector('[data-je-focus="history:prev"]').getAttribute('aria-disabled'), 'true');
  assert.equal(history.querySelector('[data-je-focus="history:next"]').getAttribute('aria-disabled'), null);
  // The search box has a name; the chips say which one is on, in words and with a check mark.
  assert.equal(h.input().getAttribute('aria-label'), 'Search the history');
  assert.equal(h.input().maxLength, 100);
  const pressed = [...history.querySelectorAll('.je-history-chip[aria-pressed="true"]')].map(c => c.textContent);
  assert.deepEqual(pressed, ['checkAll events', 'checkAll instances']);
  assert.ok(history.querySelector('.je-history-chips[role="group"][aria-label="Event"]'));
});

// The pause is the page's own time (a manual clock, tests/frontend/helpers/fake-clock.mjs): with real timers a busy
// machine stretched the 120 ms wait past the 300 ms pause and the first word was read on its own (rebuild fix round 4).
test('typing searches 300 ms after the last key, once, with the caret and focus kept across redraws', async t => {
  const clock = fakeClock();
  const h = setup(t, { globals: clock.globals });
  h.JE.initializeArrStatus();
  await clock.until(() => h.input());
  h.type('du');
  await clock.advance(120);
  h.type('dune');
  const typed = clock.now();
  h.input().setSelectionRange(2, 2);
  await clock.advance(150);
  assert.equal(h.calls.length, 1, 'nothing read before the pause');
  await clock.until(() => h.calls.length === 2);
  assert.equal(clock.now() - typed, 300, 'read when the pause after the last key ends');
  assert.equal(h.calls[1].params.get('q'), 'dune');
  assert.equal(h.calls[1].params.get('page'), '1');
  await clock.until(() => titles(h)[0]?.startsWith('dune|'));
  // The same search box, still focused, the caret where it was.
  assert.equal(h.document.activeElement, h.input());
  assert.equal(h.input().value, 'dune');
  assert.equal(h.input().selectionStart, 2);
  await clock.advance(350);
  assert.equal(h.calls.length, 2, 'one read for one pause');
  // Enter searches at once; spaces around the words don't make a new search.
  h.type(' dune ');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await clock.advance(20);
  assert.equal(h.calls.length, 2);
  h.type('dune 2');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await clock.until(() => h.calls.length === 3);
  assert.equal(h.calls[2].params.get('q'), 'dune 2');
});

test('an answer for a search no longer asked is dropped, and exactly one read follows for what is asked now', async t => {
  const pending = [];
  const h = setup(t, {
    reply: (params, call, n) => {
      if (n === 1) return answer(params);
      const d = deferred();
      pending.push({ params, d });
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.input());
  h.type('alien');
  await until(() => pending.length === 1);
  // While "alien" is read the admin changes the search twice and a feed reload arrives.
  h.type('aliens');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  h.page().querySelector('[data-je-focus="history:event:failed"]').click();
  const reload = h.A().refresh(); // resolves with the read under way (and the one after it)
  // The old rows are dimmed under "Searching…" meanwhile.
  assert.equal(h.page().querySelector('.je-history-status').textContent, 'Searching…');
  assert.ok(h.page().querySelector('.je-history-body.je-history-pending[aria-busy="true"]'));
  pending[0].d.resolve(answer(pending[0].params));
  await until(() => pending.length === 2);
  await wait(30);
  assert.equal(pending.length, 2, 'one trailing read, not one per change');
  assert.deepEqual([pending[1].params.get('q'), pending[1].params.get('event')], ['aliens', 'failed']);
  // The dropped answer never showed.
  assert.ok(!titles(h).some(t => t.startsWith('alien|')));
  pending[1].d.resolve(answer(pending[1].params));
  await reload;
  await until(() => titles(h)[0]?.startsWith('aliens|failed|'));
  assert.equal(h.page().querySelector('.je-history-status').textContent, '120 events');
});

test('a late failure of an old search changes nothing; a failure of the search asked offers Try again', async t => {
  const pending = [];
  const h = setup(t, {
    reply: (params, call, n) => {
      if (n === 1) return answer(params);
      const d = deferred();
      pending.push({ params, d });
      return d.promise;
    }
  });
  h.allowConsoleError?.(/could not load/);
  h.JE.initializeArrStatus();
  await until(() => h.input());
  h.page().querySelector('[data-je-focus="history:next"]').click();
  await until(() => pending.length === 1);
  h.page().querySelector('[data-je-focus="history:event:imported"]').click();
  pending[0].d.reject(Object.assign(new Error('HTTP 502'), { status: 502 }));
  await until(() => pending.length === 2);
  assert.equal(h.A().state.failed.activity, false, 'the old page\'s failure is not this search\'s');
  assert.equal(pending[1].params.get('page'), '1', 'a new filter starts on page 1');
  pending[1].d.reject(Object.assign(new Error('HTTP 502'), { status: 502 }));
  await until(() => h.page().querySelector('.je-history-error'));
  const error = h.page().querySelector('.je-history-error');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(error.textContent, /The history couldn't be searched\./);
  // No rows of another search under the error.
  assert.equal(h.page().querySelector('.je-history tbody'), null);
  error.querySelector('[data-je-focus="history:clear"]').click();
  await until(() => pending.length === 3);
  assert.equal(pending[2].params.get('event'), null);
  pending[2].d.resolve(answer(pending[2].params));
  await until(() => titles(h)[0]?.startsWith('all|any|every|p1'));
  // Try again re-reads the search asked.
  h.page().querySelector('[data-je-focus="history:event:failed"]').click();
  await until(() => pending.length === 4);
  pending[3].d.reject(new Error('offline'));
  await until(() => h.page().querySelector('.je-history-error'));
  h.page().querySelector('[data-je-focus="history:retry"]').click();
  await until(() => pending.length === 5);
  assert.equal(pending[4].params.get('event'), 'failed');
  pending[4].d.resolve(answer(pending[4].params));
  await until(() => titles(h)[0]?.startsWith('all|failed|'));
  assert.equal(h.page().querySelector('.je-history-error'), null);
});

test('Prev / Next page through the search, focus stays on the pager, and a page past the last shows the last', async t => {
  let total = 120;
  const h = setup(t, { reply: params => answer(params, { total }) });
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('[data-je-focus="history:next"]'));
  const next = () => h.page().querySelector('[data-je-focus="history:next"]');
  next().focus();
  next().click();
  await until(() => h.page().querySelector('.je-history-page')?.textContent === 'Page 2 of 3');
  assert.equal(h.document.activeElement?.dataset.jeFocus, 'history:next');
  next().click();
  await until(() => h.page().querySelector('.je-history-page')?.textContent === 'Page 3 of 3');
  assert.equal(next().getAttribute('aria-disabled'), 'true');
  // Still focusable at the end (D-pad), and a click there reads nothing.
  assert.equal(h.document.activeElement, next());
  const before = h.calls.length;
  next().click();
  await wait(30);
  assert.equal(h.calls.length, before);
  // The history shrank: the server shows its last page, and the search asks for that page from then on.
  total = 60;
  await h.A().refresh();
  await until(() => h.page().querySelector('.je-history-page')?.textContent === 'Page 2 of 2');
  assert.equal(h.A().state.history.page, 2);
  assert.equal(h.page().querySelector('.je-history-status').textContent, '60 events');
  h.page().querySelector('[data-je-focus="history:prev"]').click();
  await until(() => h.page().querySelector('.je-history-page')?.textContent === 'Page 1 of 2');
  assert.equal(h.calls.at(-1).params.get('page'), '1');
});

test('instance chips filter the search and say what that instance covers; no match offers Clear filters', async t => {
  const h = setup(t, {
    reply: params => params.get('q') === 'zzz'
      ? answer(params, { total: 0, rows: [] })
      : params.get('instance') === 's1'
        ? answer(params, { total: 3, coverage: [{ instanceId: 's1', instance: 'Sonarr', held: 1500, since: '2026-09-01T08:00:00Z', complete: false }] })
        : answer(params)
  });
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('[data-je-focus="history:instance:s1"]'));
  h.page().querySelector('[data-je-focus="history:instance:s1"]').click();
  await until(() => h.page().querySelector('.je-history-status')?.textContent === '3 events');
  assert.equal(h.calls.at(-1).params.get('instance'), 's1');
  assert.equal(h.page().querySelector('[data-je-focus="history:instance:s1"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...h.page().querySelectorAll('.je-history-coverage')].map(n => n.textContent.replace(/since .*/, 'since <date>')), ['Sonarr: showing the newest 1,500 events, since <date>']);
  assert.equal(h.page().querySelector('.je-history-pager'), null, 'one page: no pager');
  h.type('zzz');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => h.page().querySelector('.je-history-status')?.textContent === '0 events');
  assert.match(h.page().querySelector('.je-history-body .je-ops-empty').textContent, /No events match\. Try other words or filters\./);
  h.page().querySelector('.je-history-body [data-je-focus="history:clear"]').click();
  await until(() => h.calls.at(-1).path === '/arr/admin/hub/activity?page=1');
  assert.equal(h.input().value, '');
  await until(() => h.page().querySelector('.je-history-status')?.textContent === '120 events');
});

test('words, chips and the pager put no text into markup, and the coverage line handles unread and empty instances', async t => {
  const h = setup(t, {
    reply: params => answer(params, {
      total: 1,
      rows: [{ instanceId: 'r1', instance: '<b>R</b>', event: 'downloadFailed', title: '<img src=x onerror=alert(1)>', release: 'Rel.<i>1080p</i>', message: '<script>bad()</script>', date: iso(-1) }],
      coverage: [{ instanceId: 'r1', instance: 'Radarr', held: 0, unread: true }, { instanceId: 's1', instance: 'Sonarr', held: 0, total: 0, complete: true }]
    })
  });
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('.je-history tbody tr'));
  const row = h.page().querySelector('.je-history tbody tr');
  assert.equal(row.querySelector('img, script, b, i'), null);
  assert.match(row.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(row.querySelector('.je-ops-msg').textContent, '<script>bad()</script>');
  assert.equal(row.querySelector('.je-ops-path').textContent, 'Rel.<i>1080p</i>');
  assert.equal(h.page().querySelector('.je-history-status').textContent, '1 event');
  assert.deepEqual([...h.page().querySelectorAll('.je-history-coverage')].map(n => n.textContent), ["Radarr: its history couldn't be read", 'Sonarr: no history yet']);
  h.type('<b>x</b>');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => h.calls.at(-1).params.get('q') === '<b>x</b>');
  assert.equal(h.page().querySelector('.je-history-tools b'), null);
});

test('an answer from before a user switch is dropped and the next person starts with an empty search', async t => {
  const pending = [];
  const h = setup(t, {
    reply: (params, call, n) => {
      if (n === 1) return answer(params);
      const d = deferred();
      pending.push({ params, d });
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.input());
  h.type('secret');
  h.input().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => pending.length === 1);
  h.switchUser();
  pending[0].d.resolve(answer(pending[0].params));
  await wait(30);
  assert.equal(h.A().state.data.activity, undefined, 'nothing of the previous person is kept');
  assert.deepEqual({ ...h.A().state.history, input: null, timer: null }, { q: '', event: '', instance: '', page: 1, typed: '', timer: null, input: null, failedRoute: null });
});

test('an older server\'s answer without a search block is drawn as the newest events, without the tools', async t => {
  const h = setup(t, { reply: () => ({ instances: [card('r1', 'Radarr', 'Radarr')], queue: [], history: [{ instanceId: 'r1', instance: 'Radarr', event: 'grabbed', title: 'Old', date: iso(-1), message: 'Why it failed' }] }) });
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('.je-history tbody tr'));
  assert.match(h.page().querySelector('.je-history').textContent, /The newest 1 events/);
  assert.equal(h.page().querySelector('.je-history-tools'), null);
  assert.equal(h.page().querySelector('.je-history .je-ops-msg').textContent, 'Why it failed');
});

test('the history tools have 44 px targets on phones and TV and a visible focus ring', () => {
  const source = readFileSync(resolve(jsRoot, 'arr/admin/admin-styles.js'), 'utf8');
  assert.match(source, /@media \(max-width: 600px\) \{\n {2}\.je-history-search, \.je-history-chip \{ min-height: 44px; \}/);
  assert.match(source, /\.layout-tv \.je-history-search, \.layout-tv \.je-history-chip \{ min-height: 3em;/);
  assert.match(source, /\.je-history-chip:focus-visible[^{]*\{ outline: 3px solid/);
  assert.match(source, /\.je-history-search:focus-within \{ outline: 3px solid/);
});
