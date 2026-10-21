// Browser tabs of one person against one scripted server of their per-user documents. plugin.js, session.js, config.js and
// the feature modules a test names run unchanged; the server stores what it is sent: a whole document replaces the stored
// one (as the server's POST does), an operation changes only what it names (the PATCH routes, with the server's rules).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from './harness.mjs';

export const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
export const FILES = { 'settings.json': 'Settings', 'shortcuts.json': 'Shortcuts', 'bookmark.json': 'Bookmark', 'elsewhere.json': 'Elsewhere', 'hidden-content.json': 'HiddenContent', 'ddd-triggers.json': 'Ddd' };
const CONSENTS = ['AutoSeasonRequests', 'AutoMovieRequests', 'ListSwapIn'];
const pascal = key => key.charAt(0).toUpperCase() + key.slice(1);
const named = (doc, field) => Object.keys(doc).find(k => k.toLowerCase() === field.toLowerCase()) || pascal(field);
const canonicalId = id => String(id || '').replace(/-/g, '').toLowerCase();

/**
 * A scripted server holding each person's documents (PascalCase, as stored). `failWrites`: files whose writes fail (500).
 * `spoilerPrefs`: the person's Spoiler Guard preferences (spoilerblur.json Prefs).
 */
export function settingsServer(documents) {
  const server = { documents: structuredClone(documents), writes: [], failGets: new Set(), failWrites: new Set(), spoilerPrefs: {}, holds: [] };
  /**
   * Holds the next request of `type` (GET, PATCH, POST) to `file` ('spoiler-prefs', 'spoiler-state' for Spoiler Guard)
   * until `release()`: the server reads or applies it only then, so it answers what it holds at that moment.
   */
  server.hold = (file, type) => {
    let release;
    let arrived;
    const gate = { file, type, released: new Promise(r => { release = r; }), reached: new Promise(r => { arrived = r; }) };
    gate.arrived = arrived;
    gate.release = () => release();
    server.holds.push(gate);
    return gate;
  };
  server.apply = (file, type, body) => {
    const key = FILES[file];
    const doc = server.documents[key] || (server.documents[key] = {});
    server.writes.push({ file, type, body });
    if (type === 'POST') {
      // The server reads a posted document into its type: property names in any case, dictionary keys as sent.
      const typed = record => Object.fromEntries(Object.entries(record || {}).map(([k, v]) => [pascal(k), structuredClone(v)]));
      server.documents[key] = file === 'hidden-content.json'
        ? { Items: Object.fromEntries(Object.entries(body.items || body.Items || {}).map(([id, item]) => [id, typed(item)])), Settings: typed(body.settings || body.Settings) }
        : structuredClone(body);
      return server.documents[key];
    }
    if (file === 'hidden-content.json') {
      // The server's PATCH: items by key (a removal also takes the same item stored under another spelling of its id),
      // settings by field.
      const items = doc.Items = doc.Items || {};
      for (const removed of body.Remove || []) {
        for (const stored of Object.keys(items)) {
          if (stored === removed || canonicalId(stored) === canonicalId(removed) || (canonicalId(items[stored]?.ItemId) && canonicalId(items[stored]?.ItemId) === canonicalId(removed))) delete items[stored];
        }
      }
      for (const [id, record] of Object.entries(body.Upsert || {})) {
        items[id] = Object.fromEntries(Object.entries(record).map(([k, v]) => [pascal(k), structuredClone(v)]));
      }
      const settings = doc.Settings = doc.Settings || {};
      for (const [field, value] of Object.entries(body.Set || {})) settings[named(settings, field)] = structuredClone(value);
      return doc;
    }
    if (body.Set) {
      for (const [field, value] of Object.entries(body.Set)) {
        const name = named(doc, field);
        if (file === 'settings.json' && CONSENTS.includes(name)) continue;
        doc[name] = structuredClone(value);
      }
    }
    if (file === 'bookmark.json') {
      doc.Bookmarks = doc.Bookmarks || {};
      for (const id of body.Remove || []) delete doc.Bookmarks[id];
      for (const [id, record] of Object.entries(body.Upsert || {})) doc.Bookmarks[id] = structuredClone(record);
    }
    if (file === 'shortcuts.json') {
      doc.Shortcuts = (doc.Shortcuts || []).filter(s => !(body.Remove || []).includes(s.Name));
      for (const [name, record] of Object.entries(body.Upsert || {})) {
        const value = { ...structuredClone(record), Name: name };
        const index = doc.Shortcuts.findIndex(s => s.Name === name);
        if (index >= 0) doc.Shortcuts[index] = value; else doc.Shortcuts.push(value);
      }
    }
    if (file === 'ddd-triggers.json') {
      doc.Triggers = (doc.Triggers || []).filter(id => !(body.Remove || []).includes(id));
      for (const id of body.Add || []) if (!doc.Triggers.includes(id)) doc.Triggers.push(id);
    }
    return doc;
  };
  return server;
}

/** The server's route for one browser tab (undefined: not a per-user document route). */
export function route(server, request) {
  const path = new URL(request.url).pathname;
  const target = path.endsWith('/spoiler-blur/user-prefs') ? 'spoiler-prefs' : /\/user-settings\/user-a\/(.+)$/.exec(path)?.[1];
  const type = request.type || 'GET';
  const held = target ? server.holds.findIndex(gate => gate.file === target && gate.type === type) : -1;
  if (held >= 0) {
    const [gate] = server.holds.splice(held, 1);
    gate.arrived(request);
    // A held read is taken when it reaches the server and answered late; a held write is applied when released.
    if (type !== 'GET') return gate.released.then(() => route(server, request));
    let answer, error;
    try { answer = route(server, request); } catch (e) { error = e; }
    return gate.released.then(() => { if (error) throw error; return answer; });
  }
  if (path.endsWith('/spoiler-blur/user-prefs')) {
    server.writes.push({ file: 'spoiler-prefs', type: request.type, body: JSON.parse(request.data) });
    if (server.failWrites.has('spoiler-prefs')) throw Object.assign(new Error('write failed'), { status: 500 });
    const body = JSON.parse(request.data);
    if (request.type === 'POST') server.spoilerPrefs = structuredClone(body);
    else for (const [field, value] of Object.entries(body.Set || {})) server.spoilerPrefs[named(server.spoilerPrefs, field)] = value;
    return { success: true, prefs: structuredClone(server.spoilerPrefs) };
  }
  const m = /\/user-settings\/user-a\/(.+)$/.exec(path);
  if (!m) return undefined;
  const file = m[1];
  if (request.type === 'GET') {
    if (server.failGets.has(file)) throw new Error('offline');
    return structuredClone(server.documents[FILES[file]] || {});
  }
  if (server.failWrites.has(file)) throw Object.assign(new Error('write failed'), { status: 500 });
  if (file === 'consent') {
    const { Field, Value } = JSON.parse(request.data);
    server.documents.Settings[Field] = Value;
    return { success: true, consents: { [Field]: Value } };
  }
  const document = server.apply(file, request.type, JSON.parse(request.data));
  return { success: true, file, document: structuredClone(document) };
}

const modules = ['core/navigation.js', 'core/session.js', 'enhanced/config.js'];

/** Waits (bounded) until `predicate` holds. */
export async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 1));
  }
  assert.ok(predicate(), 'condition not reached');
}

/**
 * Boots one browser tab against `server`. `unread`: documents the boot read could not read (null in the bootstrap).
 * `extra`: more component scripts (feature modules), `publicConfig`: the plugin's public configuration, `ajax`: answers
 * for other routes (return undefined to fall through), `items`: answers for /Items, `fetch`: the window's fetch (default:
 * every request fails, as offline).
 */
export async function tab(t, server, { unread = [], extra = [], publicConfig = {}, items, ajax, html = '', fetch = async () => { throw new Error('offline'); } } = {}) {
  const list = [...modules, ...extra];
  const h = createHarness({
    html: '<script plugin="Jellyfin Enhanced" version="1.2.3"></script>' + html,
    fetch,
    apiClient: { ajax: async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/bootstrap')) {
        const UserSettings = {};
        for (const [file, key] of Object.entries(FILES)) if (key !== 'Ddd') UserSettings[key] = unread.includes(file) ? null : structuredClone(server.documents[key] || {});
        return { UserId: 'user-a', Version: '1.2.3', PublicConfig: publicConfig, PrivateConfig: null, UserSettings, ComponentScripts: list };
      }
      if (path.endsWith('/component-scripts.json')) return list;
      if (path === '/Plugins') return [];
      if (path.endsWith('/public-config') || path.endsWith('/version')) return {};
      if (ajax) { const answer = await ajax(request); if (answer !== undefined) return answer; }
      if (items && path.includes('/Items')) return items(request);
      const answer = route(server, request);
      return answer === undefined ? {} : answer;
    } }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.window.requestIdleCallback = callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; };
  const append = h.document.head.appendChild.bind(h.document.head);
  h.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    queueMicrotask(() => {
      const path = new URL(node.src).pathname;
      if (path.endsWith('/translations.js')) {
        h.load('enhanced/translations.js');
        h.window.JellyfinEnhanced.loadTranslations = async () => ({});
      } else if (path.endsWith('/bundle.js')) {
        h.window.__JE_BUNDLE_TOTAL = list.length;
        h.window.__JE_BUNDLE_MODULES = list.map(name => () => h.load(name));
      }
      node.onload?.();
    });
    return result;
  };
  // What the page reported, for a boot that never finishes.
  const reported = [];
  const consoleError = h.window.console.error.bind(h.window.console);
  h.window.console.error = (...args) => { reported.push(args.map(a => a?.stack || String(a)).join(' ')); consoleError(...args); };
  h.load('plugin.js');
  try { await until(() => h.window.JellyfinEnhanced.initialized); } catch (error) {
    throw new Error(`the tab did not finish booting: ${[...reported, ...h.errors.map(e => e?.stack || String(e))].join('\n')}`);
  }
  const toasts = [];
  h.window.JellyfinEnhanced.toast = (message, ms) => toasts.push({ message, ms });
  h.window.JellyfinEnhanced.t = key => en[key] ?? key;
  return { ...h, toasts, get JE() { return h.window.JellyfinEnhanced; } };
}
