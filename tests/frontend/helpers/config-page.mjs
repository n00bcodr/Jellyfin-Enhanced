import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from './harness.mjs';
import { repositoryRoot } from './discovery.mjs';

// The whole configuration page (markup and both inline scripts) in a fresh realm, against a scripted server: every
// request is answered from a route table, and a test can hold the next request to a route (gate) to settle it later,
// successfully or not. Saves are recorded as the bytes the page sent.
export const configPagePath = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html');

/** Markup without scripts, and the scripts in page order. */
export function configPageParts(source = readFileSync(configPagePath, 'utf8')) {
  const body = source.slice(source.indexOf('<body'), source.lastIndexOf('</body>'));
  const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const html = body.replace(/^<body[^>]*>/, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  return { html, scripts };
}

export const CULTURES = [
  { Name: 'German', DisplayName: 'German', TwoLetterISOLanguageName: 'de', ThreeLetterISOLanguageName: 'ger' },
  { Name: 'French', DisplayName: 'French', TwoLetterISOLanguageName: 'fr', ThreeLetterISOLanguageName: 'fre' },
  { Name: 'Japanese', DisplayName: 'Japanese', TwoLetterISOLanguageName: 'ja', ThreeLetterISOLanguageName: 'jpn' }
];
export const FOLDERS = [
  { Name: 'Movies', ItemId: 'aaaa0000000000000000000000000001', CollectionType: 'movies' },
  { Name: 'Shows', ItemId: 'bbbb0000000000000000000000000002', CollectionType: 'tvshows' },
  { Name: 'Kids', ItemId: 'cccc0000000000000000000000000003', CollectionType: 'movies' }
];
export const MM_USERS = [{ id: 'u1', username: 'kid', hasImage: false }, { id: 'u2', username: 'guest', hasImage: false }, { id: 'u3', username: 'gran', hasImage: false }];
export const JF_USERS = [{ Name: 'kid', Id: 'aa-11' }, { Name: 'guest', Id: 'bb-22' }, { Name: 'gran', Id: 'cc-33' }];
export const RADARR_SERVERS = [{ id: 0, name: 'Radarr' }, { id: 2, name: 'Radarr 4K' }];
export const RADARR_DETAILS = { profiles: [{ id: 4, name: 'HD' }, { id: 7, name: 'UHD' }], rootFolders: [{ path: '/movies' }, { path: '/films' }] };
export const ADD_OPTIONS = { profiles: [{ id: 4, name: 'HD' }, { id: 5, name: 'UHD' }], rootFolders: [{ path: '/data/movies' }, { path: '/data/films' }], tags: [{ id: 2, name: 'a' }, { id: 3, name: 'b' }], defaultsValid: true };
export const REGIONS = '# code\tname\nUS\tUnited States\nDE\tGermany\nNZ\tNew Zealand\nAT\tAustria\n';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * Loads the page. Routes: name -> [match(kind, url, request), answer(request)]; the answer may return a value or a
 * promise, or throw. `net.hold(name)` holds the next request to that route; the returned gate settles it.
 */
export function configPage(t, { config = {}, overrides = {}, before } = {}) {
  const server = { config: clone(config) };
  const saves = [];
  const posts = [];
  const alerts = [];
  const requests = [];
  const holds = new Map();
  const routes = {
    pluginConfig: [(kind) => kind === 'getPluginConfiguration', () => clone(server.config)],
    cultures: [(kind, url) => url.includes('/Localization/Cultures'), () => clone(CULTURES)],
    locales: [(kind, url) => url.includes('/JellyfinEnhanced/locales'), () => ['de', 'fr', 'ja']],
    mmUsers: [(kind, url) => url.includes('/MaintenanceMode/Users'), () => clone(MM_USERS)],
    // The tag-cache and Spoiler Guard lists (getJSON, in that order) and the *arr cards' linked libraries.
    virtualFolders: [(kind, url) => kind === 'getJSON' && url.includes('Library/VirtualFolders'), () => clone(FOLDERS)],
    arrLibraries: [(kind) => kind === 'getVirtualFolders', () => clone(FOLDERS)],
    users: [(kind) => kind === 'getUsers', () => clone(JF_USERS)],
    radarrServers: [(kind, url) => /\/jellyseerr\/radarr$/.test(url), () => clone(RADARR_SERVERS)],
    radarrDetails: [(kind, url) => /\/jellyseerr\/radarr\/\d+$/.test(url), () => clone(RADARR_DETAILS)],
    addOptions: [(kind, url) => url.includes('/arr/admin/manage/add-options'), () => clone(ADD_OPTIONS)],
    regions: [(kind, url) => url.includes('elsewhere-res/regions.txt'), () => ({ ok: true, text: async () => REGIONS })],
    ...overrides
  };
  const routeOf = (kind, url, request) => Object.keys(routes).find(name => routes[name][0](kind, url, request));

  async function answer(kind, url, request) {
    requests.push({ kind, url, type: request?.type || 'GET' });
    const name = routeOf(kind, url, request);
    const queue = name && holds.get(name);
    if (queue && queue.length) {
      const gate = queue.shift();
      gate.arrived(request);
      return gate.promise;
    }
    if (name) return routes[name][1](request);
    if (kind === 'fetch') return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (request?.type && request.type !== 'GET') { posts.push({ url, data: request.data ? JSON.parse(request.data) : null }); return {}; }
    return {};
  }

  const h = createHarness({
    html: configPageParts().html,
    fetch: async url => answer('fetch', String(url), { type: 'GET' }),
    apiClient: {
      getPluginConfiguration: () => answer('getPluginConfiguration', 'plugin-config', { type: 'GET' }),
      updatePluginConfiguration: async (id, value) => {
        const bytes = JSON.stringify(value);
        saves.push(bytes);
        server.config = JSON.parse(bytes);
        return {};
      },
      ajax: request => answer('ajax', request.url, request),
      getJSON: url => answer('getJSON', url, { type: 'GET' }),
      getVirtualFolders: () => answer('getVirtualFolders', 'Library/VirtualFolders', { type: 'GET' }),
      getUsers: () => answer('getUsers', 'Users', { type: 'GET' }),
      fetch: request => answer('ajax', request.url, request),
      getUrl: (path, params) => {
        const query = params ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
        return `http://jellyfin.test${path.startsWith('/') ? '' : '/'}${path}${query}`;
      }
    },
    globals: {
      Dashboard: {
        showLoadingMsg() {}, hideLoadingMsg() {}, processPluginConfigurationUpdateResult() {},
        alert(message) { alerts.push(message); }
      },
      confirm: () => true
    }
  });
  // jsdom has no canvas; the page only measures text with it.
  h.window.HTMLCanvasElement.prototype.getContext = () => null;
  // jsdom's selector engine takes milliseconds per "#id" lookup in a document this size (the page makes hundreds per
  // save): answer a plain id selector from the id index, as a browser does. Same result for the page's unique ids.
  const plainId = /^#([A-Za-z][\w-]*)$/;
  for (const proto of [h.window.Document.prototype, h.window.Element.prototype]) {
    const original = proto.querySelector;
    proto.querySelector = function (selector) {
      const m = typeof selector === 'string' && plainId.exec(selector);
      if (!m) return original.call(this, selector);
      const doc = this.ownerDocument || this;
      const el = doc.getElementById(m[1]);
      if (this === doc) return el;
      if (el && el !== this && this.contains(el)) return el;
      return original.call(this, selector); // a detached subtree, or an id outside this element
    };
  }
  h.allowConsoleError(/./);
  t.after(() => h.close());

  const $ = selector => h.document.querySelector(selector);
  const page = {
    ...h, server, saves, posts, alerts, requests, $,
    /** Holds the next request to a route until the gate settles it. */
    hold(name) {
      let resolveFn, rejectFn, arrived;
      const reached = new Promise(r => { arrived = r; });
      const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
      promise.catch(() => {});
      const gate = {
        promise, reached, arrived,
        resolve: value => { resolveFn(value === undefined ? routes[name][1]({}) : value); return page.flush(); },
        reject: (error = Object.assign(new Error(`${name} unavailable`), { status: 503 })) => { rejectFn(error); return page.flush(); }
      };
      if (!holds.has(name)) holds.set(name, []);
      holds.get(name).push(gate);
      return gate;
    },
    /** Lets every queued completion run (bounded). */
    async flush(rounds = 12) {
      for (let i = 0; i < rounds; i++) await new Promise(r => h.window.setTimeout(r, 0));
    },
    async pageshow() {
      $('#JellyfinEnhancedPage').dispatchEvent(new h.window.Event('pageshow'));
      await page.flush();
    },
    async save() {
      const before = saves.length;
      $('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { cancelable: true }));
      await page.flush(30);
      return saves.length > before ? JSON.parse(saves.at(-1)) : null;
    },
    /** The administrator picks a value: sets it and fires the events a real pick fires. */
    choose(selector, value) {
      const el = typeof selector === 'string' ? $(selector) : selector;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = value; else el.value = value;
      el.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    }
  };
  // Requests the scripts make while they evaluate (the language lists) can be held from here.
  if (before) before(page);
  for (const script of configPageParts().scripts) h.window.eval(script);
  return page;
}

/** The persisted bytes of one field of a saved configuration. */
export const fieldBytes = (config, field) => JSON.stringify(config ? config[field] : undefined);
