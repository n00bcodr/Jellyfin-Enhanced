// Shared fixture of the Requests page's phase-3 tests (Approvals, Household, My requests ledger
// rows, the home chip bar): the real modules over a fetch fixture, a recording change feed and a
// switchable user.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from './harness.mjs';

export const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
export const HUB_MODULES = [
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js',
  'arr/hub/hub-extra-core.js', 'arr/hub/hub-extra-styles.js', 'arr/hub/hub-approvals.js', 'arr/hub/hub-household.js', 'arr/household/household-rules.js',
  'arr/hub/hub-mine-ledger.js', 'arr/hub/hub-chipbar.js', 'arr/hub/hub-page.js', 'arr/ask/ask-core.js'
];
export const USER = '0123456789abcdef0123456789abcdef';

export function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

export function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** Waits (up to 15 s: the full suite can run under heavy load) until `check` is true. */
export async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

/**
 * The Requests page with the phase-3 modules over a fetch fixture: `routes(method, path, body)`
 * answers {status, body} (or a promise of one); the hub's own read answers `hub`.
 */
export function setupHub(t, { hash = '#/requests', html = '', me = { role: 'manager', contact: 'Dad' }, routes = () => null, hub = null, config = {}, layoutTv = false } = {}) {
  const fetches = [];
  const subscriptions = [];
  const navigation = [];
  const toasts = [];
  const userChange = [];
  let epoch = 0;
  const fetch = async (url, options = {}) => {
    const path = String(url).replace('http://jellyfin.test/JellyfinEnhanced', '');
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    fetches.push({ method, path, body });
    let answer = path === '/acquire/requests/me' ? { status: me ? 200 : 403, body: me ? { me } : { reason: 'feature_disabled' } } : null;
    answer = (await routes(method, path, body, fetches.length)) || answer || { status: 404, body: { outcome: 'denied', reason: 'not_found' } };
    return { status: answer.status, text: async () => (answer.body == null ? '' : JSON.stringify(answer.body)) };
  };
  const h = createHarness({
    html: `<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage">${html}</div></div>`,
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => USER, getImageUrl: (id, o) => `/Items/${id}/Images/${o.type}` },
    fetch,
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrRequestsEnabled: true, ...config },
      t: translate,
      toast: text => toasts.push(text),
      escapeHtml: s => String(s),
      helpers: { debounce: fn => fn, onSidebarRebuilt: () => {} },
      core: {
        api: { plugin: async (path) => (path === '/acquire/hub' ? (hub || { contact: 'Dad', seerr: { configured: true, loaded: true }, mine: [], soon: [], ready: [] }) : null) },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: {
        live: { position: () => ({ epoch: 'e1', cursor: 1 }) },
        onStatusChange(keys, cb) {
          const sub = { keys: [...keys], cb, active: true };
          subscriptions.push(sub);
          return () => { sub.active = false; };
        }
      },
      session: { getEpoch: () => epoch, isCurrent: () => true, onUserChange: (name, fn) => userChange.push(fn) }
    }
  });
  if (layoutTv) h.document.documentElement.classList.add('layout-tv');
  // Reads still answering when a test ends settle before the window closes.
  t.after(async () => { await wait(50); h.close(); });
  for (const m of HUB_MODULES) h.load(m);
  return {
    ...h, fetches, subscriptions, navigation, toasts,
    live: () => subscriptions.filter(s => s.active),
    /** Fires the feed for a key on every live subscription that follows it. */
    bump(key) { for (const s of subscriptions.filter(x => x.active && x.keys.includes(key))) s.cb([key]); },
    /** Switches user: a new session epoch, then every user-change listener. */
    switchUser() { epoch++; userChange.forEach(fn => fn()); },
    page: () => h.document.getElementById('je-requests-hub-page'),
    calls: (method, path) => fetches.filter(f => f.method === method && (typeof path === 'string' ? f.path === path : path.test(f.path)))
  };
}
