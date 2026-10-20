// Shared fixtures of the list authoring tests (phase 4c3b1): the real session, list transport, paint gate and render
// helpers in a fresh window, with only HTTP (a route table) and the host identity held by the test. The authoring
// modules themselves are pure or presenters: nothing installs itself, and every DOM write goes through the paint gate
// (the DOM-write spy fails the test otherwise).
import strict from 'node:assert/strict';

/** Values from the page's realm compared by content (their prototypes are the window's, not node's). */
const plainOf = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/** node's strict assert, with deepEqual/notDeepEqual comparing plain data across realms. */
export const assert = Object.assign(Object.create(strict), {
  deepEqual: (actual, expected, message) => strict.deepEqual(plainOf(actual), plainOf(expected), message),
  notDeepEqual: (actual, expected, message) => strict.notDeepEqual(plainOf(actual), plainOf(expected), message)
});
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot } from '../../helpers/harness.mjs';
export { deferred } from '../../helpers/harness.mjs';
import { installDomWriteSpy } from '../../helpers/dom-write-spy.mjs';

export const BASE_MODULES = ['core/navigation.js', 'core/session.js', 'arr/lists/list-api.js', 'arr/lists/list-paint.js', 'arr/lists/list-render.js'];
export const AUTHORING_MODULES = [
  'arr/lists/list-order-model.js', 'arr/lists/list-authoring-model.js', 'arr/lists/list-metadata.js', 'arr/lists/list-surface.js',
  'arr/lists/list-actions.js', 'arr/lists/list-search.js', 'arr/lists/list-granularity.js', 'arr/lists/list-picker.js'
];

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));

/**
 * English strings the authoring presenters need that en.json does not have yet. b1 does not edit shared locale files
 * (D50: the coordinator adds them to en.json only); the test that compares every module's KEYS with this table is the
 * handoff. Each value is the proposed English text.
 */
export const PROPOSED_KEYS = Object.freeze({
  arr_lists_author_move_up: 'Move up',
  arr_lists_author_move_down: 'Move down',
  arr_lists_author_note: 'Edit note',
  arr_lists_author_link: 'Link to a title',
  arr_lists_author_remove: 'Remove',
  arr_lists_author_note_label: 'Note for {title}',
  arr_lists_author_note_label_guarded: 'Note for this entry',
  arr_lists_author_note_count: '{count} of {max}',
  arr_lists_author_err_title: 'Enter a title of 1 to 200 characters.',
  arr_lists_author_err_year: 'Enter a year between 1870 and 2100.',
  arr_lists_author_err_date: 'Enter a date as YYYY-MM-DD.',
  arr_lists_author_err_note: 'A note can have at most 300 characters.',
  arr_lists_author_err_type: 'Choose a movie or a show.',
  arr_lists_author_custom_title: 'Title',
  arr_lists_author_custom_type: 'Type',
  arr_lists_author_custom_year: 'Year',
  arr_lists_author_custom_date: 'Release date',
  arr_lists_author_custom_note: 'Note',
  arr_lists_search_label: 'Search for a title',
  arr_lists_search_empty: 'Nothing found.',
  arr_lists_search_failed: "Search isn't available right now.",
  arr_lists_search_custom_only: "Search isn't available for your account. You can still add a custom entry.",
  arr_lists_search_no_tmdb: 'Custom entry only',
  arr_lists_gran_label: 'What to add',
  arr_lists_gran_movie: 'The movie',
  arr_lists_gran_series: 'The whole show',
  arr_lists_gran_season: 'One season',
  arr_lists_gran_episodes: 'Episodes of one season',
  arr_lists_gran_specials: 'Specials (season 0)',
  arr_lists_gran_season_n: 'Season {number}',
  arr_lists_gran_episode_n: 'Episode {number}',
  arr_lists_gran_loading: 'Loading…',
  arr_lists_gran_unavailable: "Seasons and episodes can't be listed right now. You can add the whole show.",
  arr_lists_gran_partial: 'Only some seasons could be listed.',
  arr_lists_gran_limit: 'At most {count} episodes in one entry.',
  arr_lists_gran_scope_lost: "The season or episodes asked for can't be listed right now, so nothing is chosen.",
  arr_lists_picker_label: 'Add to',
  arr_lists_picker_playlists: 'Playlists',
  arr_lists_picker_collections: 'Collections',
  arr_lists_picker_owned_by: '{name} ({owner})',
  arr_lists_picker_new_playlist: 'New playlist…',
  arr_lists_picker_new_collection: 'New collection…',
  arr_lists_picker_name: 'Name',
  arr_lists_picker_public: 'Anyone on this server can see it',
  arr_lists_picker_position: 'Position',
  arr_lists_picker_end: 'At the end',
  arr_lists_picker_start: 'At the start',
  arr_lists_picker_failed: "Your lists can't be read right now.",
  arr_lists_picker_added: 'Added to {list}.',
  arr_lists_picker_added_real: 'Added from your library to {list}.',
  arr_lists_picker_added_partly: 'Added to {list}: some of it from your library.',
  arr_lists_picker_skipped: 'Not added to {list}: it is already there.',
  arr_lists_picker_open_list: 'Open {list}'
});

/** JE.t as the real one behaves for English: en.json, then the proposed keys; an unknown key fails the test. */
export function translate(key, params) {
  const text = en[key] ?? PROPOSED_KEYS[key];
  if (text === undefined) throw new Error(`missing English key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

export const LIST = 'a'.repeat(32);
export const LIST2 = 'b'.repeat(32);
export const COLL = 'c'.repeat(32);
export const ITEM = n => n.toString(16).padStart(32, '0');
export const P = n => 'f' + String(n).padStart(31, '0');

/** An entry as GET acquire/lists/{id} answers it. */
export function ph(id, extra = {}) {
  return {
    id, token: `p:${id}`, kind: 'movie', mediaType: 'movie', tmdbId: 100, title: `Title ${id.slice(-2)}`, year: 2001,
    releaseDate: '2001-05-01', released: true, posterPath: '/p.jpg', episodes: [], filledCount: 0, addedByMe: false,
    addedAt: '2026-10-10T00:00:00Z', titleKey: 'movie:tmdb:100', edition: 'standard', status: null, actions: [],
    expectedCount: 0, airedCount: 0, ...extra
  };
}

/** A playlist view. */
export function view(placeholders, order, extra = {}) {
  return { listId: LIST, listKind: 'playlist', rev: 1, canEdit: false, nativeCanEdit: false, actions: [], statusShown: true, swapIn: false, reconciling: false, placeholders, order, ...extra };
}

/**
 * A harness with the real base modules (and the authoring modules unless `authoring: false`), HTTP answered by `route`.
 * @returns {Object} Harness pieces: h, calls, identity (switch with signIn), settle, spy.
 */
export function setupAuthoring(t, { route, config = {}, JE = {}, authoring = true, extra = [], spoiler, strict = true } = {}) {
  const calls = [];
  const identity = { user: 'user-a', server: 'server-a', token: 'token-a' };
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#/details?id=' + LIST,
    apiClient: {
      getCurrentUserId: () => identity.user, accessToken: () => identity.token, serverId: () => identity.server,
      getItems: async () => ({ Items: [] })
    },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/JellyfinEnhanced/, '') + u.search;
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      const headers = init.headers || {};
      const call = { method, path, body, auth: headers.Authorization || headers.authorization || '' };
      if (calls.length < 200) calls.push(call);
      const answer = route ? await route(method, path, body, call) : null;
      if (answer) return answer;
      return new Response(JSON.stringify({ error: true, code: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    },
    JE: {
      pluginConfig: { ArrListsEnabled: true, ...config },
      t: translate,
      ...(spoiler ? { spoilerBlur: spoiler } : {}),
      ...JE
    }
  });
  t.after(() => h.close());
  if (strict) h.JE.strictOwners = true;
  const spy = installDomWriteSpy(h.window);
  t.after(() => {
    assert.equal(spy.violations.length, 0, 'list DOM writes outside paint(): ' + JSON.stringify(spy.violations.slice(0, 2)));
    assert.equal(spy.overflow(), 0);
  });
  for (const m of BASE_MODULES) h.load(m);
  if (authoring) for (const m of AUTHORING_MODULES) h.load(m);
  for (const m of extra) h.load(m);
  /** Signs another person (or server) in: the real session module sees it at its next check. */
  const signIn = (user, server = identity.server) => {
    identity.user = user;
    identity.server = server;
    identity.token = `token-${user}`;
    h.JE.session.checkNow('test');
  };
  /** Lets microtasks and short timers run. */
  const settle = async (ms = 12) => { for (let i = 0; i < 4; i++) await sleep(ms / 4); };
  const lp = () => h.JE.internals.arrListPages;
  /** A connected mount point for a presenter (the test's own node; JE never adds it). */
  const mount = () => {
    const node = h.document.createElement('div');
    node.className = 'test-mount';
    h.document.body.appendChild(node);
    return node;
  };
  return { h, JE: h.JE, calls, identity, signIn, settle, lp, mount, spy, document: h.document, window: h.window };
}

/** An owner as the operation contract has it: current() until ended. */
export function owner(name = 'op') {
  let live = true;
  return { name, current: () => live, end() { live = false; } };
}

/** A JSON answer. */
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A bounded effect log for one case (at most `cap` recent records, the rest only counted).
 * @param {number} cap Cap.
 */
export function effectLog(cap = 200) {
  const records = [];
  let dropped = 0;
  return {
    push(record) { if (records.length >= cap) { records.shift(); dropped++; } records.push(record); },
    get records() { return records; },
    get dropped() { return dropped; }
  };
}
