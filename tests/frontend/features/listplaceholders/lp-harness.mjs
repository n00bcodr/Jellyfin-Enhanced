// Shared setup for the list placeholders frontend tests (not a test file itself).
import { createHarness, plain } from '../../helpers/harness.mjs';

export const MODULES = [
  'listplaceholders-api.js', 'listplaceholders-styles.js', 'listplaceholders-render.js', 'listplaceholders-requests.js',
  'listplaceholders-granularity.js', 'listplaceholders-actions.js', 'listplaceholders-search.js', 'listplaceholders-picker.js',
  'listplaceholders-playlist.js', 'listplaceholders-collection.js', 'listplaceholders-parser.js', 'listplaceholders-import.js',
  'listplaceholders-source.js', 'listplaceholders-init.js'
];

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export const frames = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 20)); };

export const LIST = '639da0c2a67ecc2670e96f200244c7e3';
export const COLLECTION = 'ddea41127acb86244a2dde838267d730';
export const ITEM_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const ITEM_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const ITEM_C = 'cccccccccccccccccccccccccccccccc';

/** A placeholder DTO with defaults. */
export function ph(id, extra = {}) {
  return { id, token: `p:${id}`, kind: 'movie', mediaType: 'movie', tmdbId: 100, title: `Title ${id}`, releaseDate: '2013-08-09', released: true, episodes: [], filledCount: 0, addedByMe: true, addedAt: '2026-10-10T00:00:00Z', status: 1, ...extra };
}

/** A ListViewDto with defaults. */
export function view(extra = {}) {
  return { listId: LIST, listKind: 'playlist', rev: 1, canEdit: true, nativeCanEdit: true, seerrEnabled: true, seerrStatusReady: true, placeholders: [], order: [], ...extra };
}

/** jellyfin-web playlist row markup. */
export function realRow(id, name = id.slice(0, 4)) {
  return `<div class="listItem listItem-border" data-playlistitemid="${id}" data-id="${id}" data-serverid="s" data-type="Movie" data-playlistid="${LIST}"><span class="listViewDragHandle material-icons drag_handle"></span><div class="listItemBody"><div class="listItemBodyText">${name}</div></div></div>`;
}

/** Playlist detail page with the given real rows. */
export function playlistPage(ids) {
  return `<div class="itemDetailPage page"><div id="listChildrenCollapsible"><div id="childrenContent"><div class="itemsContainer vertical-list">${ids.map(id => realRow(id)).join('')}</div></div></div></div>`;
}

/**
 * Loads seerr-status.js and every list placeholders module into a fresh realm.
 * @param {*} t - node:test context.
 * @param {Object} options
 */
export function setup(t, { config = {}, html = '', url, plugin = async () => ({}), jellyseerrAPI = {}, jellyseerrUI = {}, globals = {}, extraJE = {}, load = true } = {}) {
  const calls = [];
  const toasts = [];
  let epoch = 0;
  const JE = {
    pluginConfig: { ListPlaceholdersEnabled: true, JellyseerrEnabled: true, ...config },
    t: (key, params) => key + (params ? JSON.stringify(params) : ''),
    escapeHtml: esc,
    toast: html => toasts.push(html),
    cdn: { url: (source, path) => `http://cdn.test/${source}/${path}` },
    session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (name, fn) => { JE.__userChange = fn; } },
    core: {
      api: { plugin: async (path, options = {}) => { calls.push([path, plain(options)]); return plugin(path, options); } },
      navigation: { onViewPage: (fn, options) => { JE.__viewHandler = fn; JE.__viewOptions = options; return () => {}; } },
      ui: { injectCss: (id, css) => { const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.appendChild(s); } }
    },
    helpers: { getItemCached: async id => JE.__items?.[id] ?? null },
    jellyseerrAPI: {
      checkUserStatus: async () => ({ active: true, userFound: true }),
      shouldShowAdvanced: () => false,
      fetchMovieDetails: async id => ({ id, title: 'details', mediaType: 'movie' }),
      requestMedia: async () => ({ id: 1 }),
      ...jellyseerrAPI
    },
    jellyseerrUI: { ...jellyseerrUI },
    ...extraJE
  };
  const h = createHarness({ html, url, JE, globals: { queueMicrotask, ...globals } });
  const document = h.document;
  t.after(() => h.close());
  if (load) {
    h.load('jellyseerr/seerr-status.js');
    for (const file of MODULES) h.load(`jellyseerr/listplaceholders/${file}`);
  }
  return {
    ...h, JE, calls, toasts,
    get lp() { return JE.internals.listPlaceholders; },
    switchUser() { epoch++; JE.__userChange?.(); },
    document
  };
}
