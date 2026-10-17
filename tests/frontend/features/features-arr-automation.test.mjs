// Requests & downloads, phase 4a: the administrator Overview's Automation card (admin-automation.js),
// rendered by the real modules from crafted GET /arr/admin/automation/status bodies, its two actions
// (breaker reset, migration notice dismiss), and how the Overview tab reads and redraws it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const STATUS = '/arr/admin/automation/status';
const USER = '0123456789abcdef0123456789abcdef';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const iso = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const status = (extra = {}) => ({
  phase4: { enabled: true, effective: true }, engine: { enabled: true, effective: true }, shadowOverride: false, killAll: false, backend: 'je',
  contract: { backend: 'je', guarantees: [], notGuaranteed: [], unavailableRecipes: [] },
  recipes: [], targets: [], budgets: [], held: {}, migration: null, accountingUnavailable: false, ...extra
});
const target = (id, name, extra = {}) => ({ id, name, kind: 'sonarr', killed: false, breakerFailures: 0, breakerOpenUntil: null, ...extra });

/** The status helper, admin-render.js and admin-automation.js in one realm, with a scripted plugin API. */
function unit(t, answer) {
  const calls = [];
  const warnings = [];
  const session = {};
  const h = createHarness({
    JE: {
      pluginConfig: { ArrStatusEnabled: true },
      t: translate,
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const out = await answer(path, options, calls.length);
            if (out instanceof Error) throw out;
            return out;
          }
        }
      },
      session: { onUserChange: (name, fn) => { session[name] = fn; } }
    }
  });
  t.after(() => h.close());
  h.window.console.warn = (...args) => warnings.push(args.map(String).join(' '));
  for (const m of ['arr/status/status-core.js', 'arr/admin/admin-render.js', 'arr/admin/admin-automation.js']) h.load(m);
  const A = h.JE.internals.arrHub.admin;
  return { ...h, A, calls, warnings, session };
}

const httpError = code => Object.assign(new Error(`HTTP ${code}`), { status: code });
const lines = card => [...card.querySelectorAll('.je-ops-auto-line, li')].map(n => n.textContent);

test('every key the Automation card uses exists in en.json, with every recipe, mode, reason, category and held reason', () => {
  const source = readFileSync(resolve(jsRoot, 'arr/admin/admin-automation.js'), 'utf8');
  const keys = [...source.matchAll(/'(arr_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 50, String(keys.length));
  for (const key of keys) assert.ok(key in en, key);
  const families = {
    arr_auto_recipe_: ['auto_season', 'auto_movie', 'keep_up', 'list_acquire_ahead', 'release_day', 'list_sync', 'list_sync_requests'],
    arr_auto_mode_: ['off', 'shadow', 'ask', 'auto'],
    arr_auto_reason_: ['shadow_override', 'engine_off', 'recipe_off', 'requests_off', 'seerr_unsupported', 'automation_killed'],
    arr_auto_budget_: ['household_add', 'instance_search', 'seerr_post', 'source_fetch', 'delta_work', 'backfill_search'],
    arr_auto_held_: ['shadow_override', 'phase4_off', 'automation_killed', 'recipe_paused', 'breaker_open', 'budget_exhausted', 'accounting_unavailable', 'low_disk', 'disk_unknown', 'approval_required', 'seerr_unsupported']
  };
  for (const [prefix, values] of Object.entries(families)) for (const v of values) assert.ok(`${prefix}${v}` in en, `${prefix}${v}`);
});

test('the card is null before any status and when nothing applies (engine off, no rollout guard, no pending notice)', async t => {
  let body = status({ engine: { enabled: false, effective: false }, migration: { kind: 'upgrade', at: iso(-60), autoSeason: true, autoMovie: false, notice: 'seen', grants: [] } });
  const h = unit(t, () => body);
  assert.equal(h.A.automationCard(), null);
  let changes = 0;
  await h.A.refreshAutomation(() => changes++);
  assert.equal(h.A.automationCard(), null);
  // Hidden before and after: nothing to redraw.
  assert.equal(changes, 0);
  body = status();
  await h.A.refreshAutomation(() => changes++);
  assert.ok(h.A.automationCard());
  assert.equal(changes, 1);
  // The same answer again changes nothing on screen.
  await h.A.refreshAutomation(() => changes++);
  assert.equal(changes, 1);
});

test('rollout guard, engine, kill switches and the recipes\' effective modes with their reasons', async t => {
  const body = status({
    shadowOverride: true, engine: { enabled: true, effective: false }, killAll: true,
    targets: [target('s1', 'Sonarr', { killed: true }), target('r1', 'Radarr <b>4K</b>', { killed: true }), target('r2', 'Radarr')],
    recipes: [
      { id: 'auto_season', mode: 'auto', effective: 'shadow', reason: 'shadow_override', killed: false, legacy: true, requiresDirect: false },
      { id: 'auto_movie', mode: 'off', effective: 'off', reason: null, killed: false, legacy: true, requiresDirect: false },
      { id: 'release_day', mode: 'auto', effective: 'off', reason: 'seerr_unsupported', killed: false, legacy: false, requiresDirect: true },
      { id: 'keep_up', mode: 'auto', effective: null, reason: null, killed: false, legacy: false, requiresDirect: false }
    ]
  });
  const h = unit(t, () => body);
  await h.A.refreshAutomation(() => {});
  const card = h.A.automationCard();
  assert.equal(card.tagName, 'SECTION');
  assert.ok(card.classList.contains('je-ops-box') && card.classList.contains('je-ops-automation'));
  assert.equal(card.getAttribute('role'), 'region');
  assert.equal(card.getAttribute('aria-label'), 'Automation');
  assert.equal(card.querySelector('h2').textContent, 'Automation');
  const banner = card.querySelector('.je-ops-banner.je-ops-banner-unknown');
  assert.equal(banner.textContent, 'Rollout guard on: automatic requests are only recorded (Shadow), nothing automatic is sent.');
  const text = lines(card);
  assert.ok(text.includes('Automation engine off'));
  assert.ok(text.includes('Kill switch on: no automatic request is sent.'));
  // Names are text, never HTML.
  assert.ok(text.includes('Stopped for: Sonarr, Radarr <b>4K</b>'));
  assert.equal(card.querySelectorAll('b').length, 0);
  assert.deepEqual([...card.querySelectorAll('.je-ops-auto-list li')].map(li => li.textContent), [
    'Next season keeper: Shadow (rollout guard)',
    'Collection completer: Off',
    'Release-day search: Off (not available with Seerr)'
  ]);
  // Nothing about budgets, breakers, held requests or the Seerr boundary when none applies.
  assert.equal(card.querySelectorAll('button').length, 0);
  assert.ok(!text.some(s => /Seerr handles|Status only|read-back|Waiting automatic/.test(s)));
});

test('fields the server leaves out when null (Jellyfin omits nulls) read as null', async t => {
  // No effective/reason on recipes, no breakerOpenUntil on targets, no nextSlotAt/resetAt on
  // budgets and no migration at all.
  const body = status({
    recipes: [{ id: 'auto_season', mode: 'auto', killed: false, legacy: true, requiresDirect: false }, { id: 'auto_movie', mode: 'auto', effective: 'auto', killed: false, legacy: true, requiresDirect: false }],
    targets: [{ id: 's1', name: 'Sonarr', kind: 'sonarr', killed: false, breakerFailures: 0 }],
    budgets: [{ category: 'instance_search', scope: 's1', scopeName: 'Sonarr', window: '1h', used: 2, limit: 2, uncertain: 0, reserved: false }]
  });
  delete body.migration;
  const h = unit(t, () => body);
  await h.A.refreshAutomation(() => {});
  const card = h.A.automationCard();
  assert.deepEqual([...card.querySelectorAll('.je-ops-auto-list li')].map(li => li.textContent), ['Collection completer: Auto']);
  assert.equal(card.querySelector('button'), null);
  assert.ok(lines(card).includes('Searches (Sonarr, 1h): 2/2 used'));
  assert.ok(!lines(card).some(s => s.includes('undefined') || s.includes('null')));
  // Engine off with no migration block: nothing to show.
  body.engine = { enabled: false, effective: false };
  await h.A.refreshAutomation(() => {});
  assert.equal(h.A.automationCard(), null);
});

test('Seerr boundary and status-only lines follow the backend', async t => {
  let body = status({ backend: 'seerr' });
  const h = unit(t, () => body);
  await h.A.refreshAutomation(() => {});
  let text = lines(h.A.automationCard());
  assert.ok(text.includes('Automation engine on'));
  assert.ok(text.some(s => s.startsWith('Seerr handles requests: automation counts only the requests Jellyfin Enhanced sends to Seerr')));
  assert.ok(text.some(s => s.endsWith('Release-day searches need Sonarr/Radarr handling.')));
  body = status({ backend: 'status_only' });
  await h.A.refreshAutomation(() => {});
  text = lines(h.A.automationCard());
  assert.ok(text.includes('Status only: no automatic request is made.'));
  assert.ok(!text.some(s => s.startsWith('Seerr handles')));
});

test('full budgets say when there is room again; reserved ones are skipped; uncertain sends are counted once', async t => {
  const next = iso(90);
  const body = status({
    budgets: [
      { category: 'household_add', scope: 'household', scopeName: 'Household', window: '24h', used: 5, limit: 5, uncertain: 2, nextSlotAt: next, resetAt: iso(-600), reserved: false },
      { category: 'instance_search', scope: 's1', scopeName: 'Sonarr', window: '1h', used: 3, limit: 10, uncertain: 1, nextSlotAt: null, resetAt: iso(-30), reserved: false },
      { category: 'seerr_post', scope: 'household', scopeName: null, window: '1h', used: 4, limit: 4, uncertain: 0, nextSlotAt: null, resetAt: null, reserved: false },
      { category: 'backfill_search', scope: 'household', scopeName: 'Household', window: '24h', used: 0, limit: 0, uncertain: 9, nextSlotAt: null, resetAt: null, reserved: true }
    ]
  });
  const h = unit(t, () => body);
  await h.A.refreshAutomation(() => {});
  const text = lines(h.A.automationCard());
  const time = h.A.when(next);
  assert.ok(time.length > 4, time);
  assert.ok(text.includes(`Household adds (Household, 24h): 5/5 used, room again ${time}`), text.join('\n'));
  assert.ok(text.includes('Requests sent to Seerr (household, 1h): 4/4 used'));
  assert.ok(!text.some(s => s.startsWith('Searches') || s.startsWith('Backfill')));
  // The same send counts in several budgets: the largest count, the reserved budget left out.
  assert.ok(text.includes('2 automatic sends waiting for a read-back (counted until settled)'));

  body.budgets = [{ ...body.budgets[1], uncertain: 1 }];
  await h.A.refreshAutomation(() => {});
  assert.ok(lines(h.A.automationCard()).includes('1 automatic send waiting for a read-back (counted until settled)'));
});

test('an open breaker says until when and Try again now resets it, then the status is read again', async t => {
  const until = iso(20);
  let open = true;
  const gate = deferred();
  const h = unit(t, async (path, options) => {
    if (path === STATUS) return status({ targets: [target('s1', 'Sonarr', { breakerFailures: 5, breakerOpenUntil: open ? until : null }), target('r1', 'Radarr')] });
    if (path === '/arr/admin/automation/breakers/reset') { await gate.promise; open = false; return { reset: true }; }
    throw new Error(`unexpected ${path}`);
  });
  let changes = 0;
  await h.A.refreshAutomation(() => changes++);
  let card = h.A.automationCard();
  h.document.body.appendChild(card);
  const row = card.querySelector('.je-ops-auto-row');
  assert.equal(row.querySelector('.je-ops-auto-line').textContent, `Sonarr: paused after repeated failures until ${h.A.when(until)}`);
  const button = row.querySelector('button.je-ops-btn');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'Try again now');
  assert.equal(button.dataset.jeFocus, 'automation:breaker:s1');
  assert.equal(card.querySelectorAll('button').length, 1);
  button.click();
  // Busy while the POST runs; a second press sends nothing.
  card = h.A.automationCard();
  const busy = card.querySelector('[data-je-focus="automation:breaker:s1"]');
  assert.equal(busy.getAttribute('aria-disabled'), 'true');
  assert.equal(busy.textContent, 'Working…');
  busy.click();
  button.click();
  gate.resolve();
  for (let i = 0; i < 20 && h.A.automationCard()?.querySelector('button'); i++) await wait(5);
  const posts = h.calls.filter(c => c.options?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), { path: '/arr/admin/automation/breakers/reset', options: { method: 'POST', body: { target: 's1' }, skipRetry: true } });
  assert.equal(h.calls.filter(c => c.path === STATUS).length, 2);
  assert.equal(h.A.automationCard().querySelector('button'), null);
  assert.ok(changes >= 3);
});

test('waiting automatic requests are listed by reason; zero counts and unknown reasons stay readable', async t => {
  const h = unit(t, () => status({ held: { budget_exhausted: 3, low_disk: 0, approval_required: 1, something_new: 2 } }));
  await h.A.refreshAutomation(() => {});
  const text = lines(h.A.automationCard());
  assert.ok(text.includes('Waiting automatic requests: 3 (budget used up)'));
  assert.ok(text.includes('Waiting automatic requests: 1 (waiting for an OK)'));
  assert.ok(text.includes('Waiting automatic requests: 2 (something_new)'));
  assert.ok(!text.some(s => s.includes('low disk')));
});

test('the migration notice names the Managers kept on Auto and Got it dismisses it', async t => {
  let notice = 'pending';
  const h = unit(t, (path, options) => {
    if (path === STATUS) return status({ engine: { enabled: false, effective: false }, migration: { kind: 'upgrade', at: iso(-5), autoSeason: true, autoMovie: false, notice, grants: [{ userId: 'u1', name: 'Dad', source: 'legacy', at: iso(-5) }, { userId: 'u2', name: '<i>Mum</i>', source: 'legacy', at: iso(-5) }] } });
    if (path === '/arr/admin/automation/notice/dismiss') { notice = 'seen'; return { dismissed: true }; }
    throw new Error(`unexpected ${path}`);
  });
  let changes = 0;
  await h.A.refreshAutomation(() => changes++);
  const card = h.A.automationCard();
  const text = lines(card);
  assert.ok(text.includes('Automation engine off'));
  assert.ok(text.includes('Automatic requests were moved to recipe modes: next season Auto, next movie Off.'));
  assert.ok(text.includes('These Managers keep their automatic requests without an OK (recorded when their old automatic requests were on): Dad, <i>Mum</i>.'));
  assert.equal(card.querySelectorAll('i').length, 0);
  const got = card.querySelector('[data-je-focus="automation:notice"]');
  assert.equal(got.textContent, 'Got it');
  got.click();
  for (let i = 0; i < 20 && h.A.automationCard(); i++) await wait(5);
  const post = h.calls.find(c => c.options?.method === 'POST');
  assert.equal(post.path, '/arr/admin/automation/notice/dismiss');
  assert.deepEqual(JSON.parse(JSON.stringify(post.options)), { method: 'POST', body: {}, skipRetry: true });
  // Engine off and the notice seen: the card goes away.
  assert.equal(h.A.automationCard(), null);
  assert.ok(changes >= 3);
});

test('a failed action keeps the card, says so beside the button and lets it be pressed again', async t => {
  let fail = true;
  const h = unit(t, path => {
    if (path === STATUS) return status({ migration: { kind: 'upgrade', at: iso(-5), autoSeason: false, autoMovie: true, notice: 'pending', grants: [] } });
    return fail ? httpError(503) : { dismissed: true };
  });
  await h.A.refreshAutomation(() => {});
  assert.ok(lines(h.A.automationCard()).includes('Automatic requests were moved to recipe modes: next season Off, next movie Auto.'));
  assert.ok(!lines(h.A.automationCard()).some(s => s.startsWith('These Managers')));
  h.A.automationCard().querySelector('[data-je-focus="automation:notice"]').click();
  for (let i = 0; i < 20 && !h.A.automationCard().querySelector('.je-ops-bad[role="status"]'); i++) await wait(5);
  const card = h.A.automationCard();
  assert.equal(card.querySelector('.je-ops-auto-notice .je-ops-bad').textContent, 'That didn\'t go through. Try again in a moment.');
  assert.equal(card.querySelector('[data-je-focus="automation:notice"]').getAttribute('aria-disabled'), null);
  assert.ok(h.warnings.some(w => w.includes('automation action failed (503)')));
  fail = false;
  card.querySelector('[data-je-focus="automation:notice"]').click();
  for (let i = 0; i < 20 && h.A.automationCard()?.querySelector('.je-ops-bad'); i++) await wait(5);
  assert.equal(h.A.automationCard().querySelector('.je-ops-bad'), null);
});

test('accounting unavailable is said plainly', async t => {
  const h = unit(t, () => status({ accountingUnavailable: true }));
  await h.A.refreshAutomation(() => {});
  const card = h.A.automationCard();
  assert.equal(card.querySelector('.je-ops-banner').textContent, 'Automation can\'t count its budgets right now (database unavailable): nothing automatic is sent.');
});

test('a failed read hides the card without an error (403 and 404 quietly, others with one warning)', async t => {
  let answer = status();
  const h = unit(t, () => answer);
  let changes = 0;
  await h.A.refreshAutomation(() => changes++);
  assert.ok(h.A.automationCard());
  assert.equal(changes, 1);
  for (const [error, warned] of [[httpError(403), 0], [httpError(404), 0], [new Error('offline'), 1]]) {
    answer = status();
    await h.A.refreshAutomation(() => changes++);
    answer = error;
    const before = h.warnings.length;
    await h.A.refreshAutomation(() => changes++);
    assert.equal(h.A.automationCard(), null);
    assert.equal(h.warnings.length - before, warned);
  }
  assert.ok(h.warnings[0].includes('could not read the automation status (offline)'));
  // Appear, hide, three times over: one redraw each.
  assert.equal(changes, 6);
  // An empty answer hides it too.
  answer = null;
  await h.A.refreshAutomation(() => {});
  assert.equal(h.A.automationCard(), null);
});

test('one read at a time: asks while a read runs share it', async t => {
  const gates = [];
  const h = unit(t, () => { const d = deferred(); gates.push(d); return d.promise; });
  const first = h.A.refreshAutomation(() => {});
  const second = h.A.refreshAutomation(() => {});
  assert.equal(first, second);
  await wait(0);
  assert.equal(h.calls.length, 1);
  gates[0].resolve(status());
  await first;
  assert.ok(h.A.automationCard());
  const third = h.A.refreshAutomation(() => {});
  await wait(0);
  assert.equal(h.calls.length, 2);
  gates[1].resolve(status({ shadowOverride: true }));
  await third;
  assert.ok(h.A.automationCard().querySelector('.je-ops-banner'));
});

test('another person signing in drops the shown status and a late answer for the last one', async t => {
  const gates = [];
  const h = unit(t, () => { const d = deferred(); gates.push(d); return d.promise; });
  const first = h.A.refreshAutomation(() => {});
  await wait(0);
  gates[0].resolve(status());
  await first;
  assert.ok(h.A.automationCard());
  const late = h.A.refreshAutomation(() => {});
  await wait(0);
  h.session['arr-hub-admin-automation']();
  assert.equal(h.A.automationCard(), null);
  gates[1].resolve(status({ shadowOverride: true }));
  await late;
  assert.equal(h.A.automationCard(), null);
  // The next read is the new person's own.
  const next = h.A.refreshAutomation(() => {});
  await wait(0);
  assert.equal(h.calls.length, 3);
  gates[2].reject(httpError(403));
  await next;
  assert.equal(h.A.automationCard(), null);
});

// ------------------------------------------------------------- through the real Requests page

const MODULES = [
  'arr/live/arr-intent.js',
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js',
  'arr/admin/admin-styles.js', 'arr/admin/admin-render.js', 'arr/admin/admin-automation.js', 'arr/admin/admin-tabs.js',
  'arr/hub/hub-page.js'
];

function page(t, responses) {
  const calls = [];
  const h = createHarness({
    html: '<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>',
    url: 'http://jellyfin.test/web/index.html#/requests?tab=overview',
    apiClient: { getCurrentUserId: () => USER, serverAddress: () => 'http://jellyfin.test' },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrManageDrawerEnabled: true },
      t: translate,
      helpers: { debounce: fn => fn, onSidebarRebuilt: () => {} },
      jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'http://seerr.test' },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            if (path === '/acquire/hub') return { contact: 'Dad', lookingHours: 24, seerr: { configured: true, loaded: true, unavailable: false }, mine: [], soon: [], ready: [], admin: { downloads: true, calendar: true, hub: true } };
            const answer = await responses(path, options);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      calendarPage: { renderForCustomTab: () => {} },
      downloadsPage: { renderForCustomTab: () => {} },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  t.after(() => {
    h.JE.internals?.arrHub?.admin?.leave?.();
    h.close();
  });
  for (const m of MODULES) h.load(m);
  return { ...h, calls };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

const overview = () => ({ instances: [{ id: 's1', name: 'Sonarr', kind: 'Sonarr', role: 'standard', url: 'http://sonarr:8989', version: '4', live: { expected: false }, queue: 0, queueAttention: 0, health: 'ok', healthIssues: 0, disks: [] }], needsAttention: [], next24h: [], downloading: 0, waitingForOk: 0, days: [] });

test('the Overview reads the automation status with its tab, shows the card first, and focus survives its redraw', async t => {
  let open = true;
  const h = page(t, path => {
    if (path === '/arr/admin/hub/overview') return overview();
    if (path === '/arr/admin/hub/activity') return { instances: [], queue: [], history: [] };
    if (path === STATUS) return status({ targets: [target('s1', 'Sonarr', { breakerOpenUntil: open ? iso(15) : null })] });
    if (path === '/arr/admin/automation/breakers/reset') { open = false; return { reset: true }; }
    return null;
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-automation'));
  const main = h.document.querySelector('.je-ops-main');
  assert.ok(main.firstElementChild.classList.contains('je-ops-automation'));
  assert.ok(main.querySelector('.je-ops-cards'));
  assert.equal(h.calls.filter(c => c.path === STATUS).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(c => c.path === STATUS).options)), { skipRetry: true });

  // A re-read of the tab reads the card again; the same answer keeps the focused button focused.
  const reset = h.document.querySelector('[data-je-focus="automation:breaker:s1"]');
  reset.focus();
  await h.JE.internals.arrHub.admin.refresh();
  await until(() => h.calls.filter(c => c.path === STATUS).length === 2);
  assert.equal(h.document.activeElement?.dataset?.jeFocus, 'automation:breaker:s1');

  // Other tabs never read it.
  const before = h.calls.filter(c => c.path === STATUS).length;
  h.document.querySelector('.je-hub-tab[data-tab="activity"]').click();
  await until(() => h.calls.some(c => c.path === '/arr/admin/hub/activity'));
  await wait(20);
  assert.equal(h.calls.filter(c => c.path === STATUS).length, before);

  // Back on the Overview, Try again now resets the breaker and the card redraws without it.
  h.document.querySelector('.je-hub-tab[data-tab="overview"]').click();
  await until(() => h.document.querySelector('[data-je-focus="automation:breaker:s1"]'));
  h.document.querySelector('[data-je-focus="automation:breaker:s1"]').click();
  await until(() => !h.document.querySelector('[data-je-focus="automation:breaker:s1"]'));
  assert.ok(h.calls.some(c => c.path === '/arr/admin/automation/breakers/reset' && c.options.body.target === 's1'));
  assert.ok(h.document.querySelector('.je-ops-automation'));
});

test('an Overview whose automation status is refused shows no card and no error', async t => {
  const h = page(t, path => {
    if (path === '/arr/admin/hub/overview') return overview();
    if (path === STATUS) return httpError(403);
    return null;
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-ops-cards') && h.calls.some(c => c.path === STATUS));
  await wait(20);
  assert.equal(h.document.querySelector('.je-ops-automation'), null);
  assert.equal(h.document.querySelector('.je-ops-banner-error'), null);
});
