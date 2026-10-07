/**
 * @file Catch Up shared state, helpers and data access.
 * Loads first; the other catchup-* files read from JE.internals.catchUp. Does nothing
 * unless CatchUpEnabled is on.
 */
(function () {
  'use strict';

  const JE = window.JellyfinEnhanced;
  if (!JE?.pluginConfig?.CatchUpEnabled) return;

  JE.internals = JE.internals || {};
  const internal = JE.internals.catchUp = JE.internals.catchUp || {};

  const LOG = '🪼 Jellyfin Enhanced: Catch Up:';
  const BATCH = 40;

  // State
  /** Page state. deck.start() resets it. */
  const state = {
    mode: 'Movie',        // 'Movie' | 'Series'
    queue: [],            // items waiting to be shown
    seen: new Set(),      // ids already queued this session
    undoStack: [],        // { item, dir, opts }
    dismissed: new Set(), // persisted per user in localStorage
    loading: false,
    pickerOpen: false,
  };

  // Helpers
  /** Translates, falling back to the English text when the key is missing. */
  function tt(key, fallback, params) {
    const out = typeof JE.t === 'function' ? JE.t(key, params) : key;
    if (out && out !== key) return out;
    return Object.entries(params || {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), fallback);
  }

  /** Creates an element. Text goes in through textContent because item and user names can't be trusted. */
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Material icon names, the same font the Activity page uses. */
  const ICONS = { undo: 'undo', x: 'close', info: 'info_outline', bookmark: 'bookmark_border', check: 'check', activity: 'history', refresh: 'refresh' };
  function icon(name) {
    const i = h('i', 'material-icons', ICONS[name]);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  const userId = () => ApiClient.getCurrentUserId();
  const jf = (path, options) => JE.core.api.jf(path, { skipCache: true, ...options });

  /** Primary image for an item (falls back to the series poster for seasons/episodes). */
  function imageOf(item) {
    if (item.ImageTags?.Primary) return { id: item.Id, tag: item.ImageTags.Primary };
    if (item.SeriesPrimaryImageTag) return { id: item.SeriesId, tag: item.SeriesPrimaryImageTag };
    return null;
  }
  const imageUrl = (im, width) => ApiClient.getUrl(`/Items/${im.id}/Images/Primary`, { maxWidth: width, quality: 85, tag: im.tag });

  /** Opens an item without a page reload, like the other JE pages. */
  function navigateToItem(itemId) {
    try {
      if (typeof Emby !== 'undefined' && Emby.Page?.showItem) { Emby.Page.showItem(itemId); return; }
    } catch (_) { /* fall through */ }
    window.location.hash = `#!/details?id=${itemId}`;
  }

  // Dismissed items (per user, this browser)
  const dismissKey = () => `je-catchup-dismissed-${userId()}`;
  function loadDismissed() {
    try { state.dismissed = new Set(JSON.parse(localStorage.getItem(dismissKey()) || '[]')); } catch (_) { state.dismissed = new Set(); }
  }
  function saveDismissed() {
    try { localStorage.setItem(dismissKey(), JSON.stringify([...state.dismissed])); } catch (_) { /* storage blocked */ }
  }
  const isHidden = (item) => state.dismissed.has(item.Id) || (item.SeriesId && state.dismissed.has(item.SeriesId));

  // Deck data
  /** Fetches a random batch of unwatched items; returns how many were queued. */
  async function refill() {
    if (state.loading) return 0;
    state.loading = true;
    let added = 0;
    try {
      const query = new URLSearchParams({
        IncludeItemTypes: state.mode, Recursive: 'true', Filters: 'IsUnplayed', SortBy: 'Random', Limit: String(BATCH),
        Fields: 'Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear,ChildCount',
        ImageTypeLimit: '1', EnableImageTypes: 'Primary',
      });
      const res = await jf(`/Users/${userId()}/Items?${query}`);
      for (const i of res.Items || []) {
        if (!state.seen.has(i.Id) && !isHidden(i) && imageOf(i)) { state.seen.add(i.Id); state.queue.push(i); added++; }
      }
    } finally { state.loading = false; }
    return added;
  }

  // Actions (what each swipe does in Jellyfin)
  const playedUrl = (id) => `/Users/${userId()}/PlayedItems/${id}`;
  const ratingUrl = (id) => `/Users/${userId()}/Items/${id}/Rating`;
  /** The watchlist is the Likes flag, the same one Seerr watchlist sync uses. */
  const likeId = (item) => item.SeriesId || item.Id;

  const ACTIONS = {
    right: {
      name: 'watched',
      run: (i, o) => Promise.all((o?.seasons || [i.Id]).map((id) => jf(playedUrl(id), { method: 'POST' }))),
      undo: (i, o) => Promise.all((o?.seasons || [i.Id]).map((id) => jf(playedUrl(id), { method: 'DELETE' }))),
    },
    left: {
      name: 'dismiss',
      run: async (i) => { state.dismissed.add(i.SeriesId || i.Id); saveDismissed(); },
      undo: async (i) => { state.dismissed.delete(i.SeriesId || i.Id); saveDismissed(); },
    },
    up: {
      name: 'watchlist',
      run: (i) => jf(`${ratingUrl(likeId(i))}?likes=true`, { method: 'POST' }),
      undo: (i) => jf(ratingUrl(likeId(i)), { method: 'DELETE' }),
    },
  };
  const ACT_NAME = { right: 'watched', left: 'dismiss', up: 'watchlist', down: 'open' };

  // Activity log. Best effort, never blocks the UI.
  // The server drops these when CatchUpLogEnabled is off.
  function logEvent(ev) {
    JE.core.api.plugin('/catchup/event', { method: 'POST', body: ev, skipRetry: true }).catch(() => { /* logging is optional */ });
  }
  function logSwipe(item, dir, opts, ok) {
    logEvent({
      type: 'swipe', action: ACT_NAME[dir], itemId: item.Id, ok,
      seasons: dir === 'right' && item.Type === 'Series' ? (opts?.numbers ?? ['all']) : undefined,
    });
  }

  Object.assign(internal, {
    LOG, state, tt, h, icon, userId, jf, imageOf, imageUrl, navigateToItem,
    loadDismissed, saveDismissed, isHidden, refill, ACTIONS, ACT_NAME, logEvent, logSwipe,
  });
})();
