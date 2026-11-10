import { createHarness, deferred } from './harness.mjs';

/** The eight more-info scripts, in the order component-scripts.json loads them. */
export const MORE_INFO_SCRIPTS = ['styles', 'data', 'seasons', 'badges', 'render', 'actions-tv', 'actions', 'init'].map(part => `jellyseerr/moreinfo/more-info-modal-${part}.js`);

export const strictEscape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

export const movie = (id = 603, extra = {}) => ({ id, title: `Movie ${id}`, ...extra });
export const show = (id = 1399, extra = {}) => ({ id, name: `Show ${id}`, seasons: [{ seasonNumber: 1, episodeCount: 8 }, { seasonNumber: 2, episodeCount: 8 }], ...extra });

/** A session the test moves by hand: an epoch and the listeners of an account change. */
export function sessionFixture() {
  let epoch = 0;
  const handlers = new Map();
  return {
    session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (name, fn) => handlers.set(name, fn) },
    switchUser() { epoch++; for (const fn of handlers.values()) fn(); },
    /** The epoch alone: work must not rely on hearing about the change first. */
    moveEpoch() { epoch++; }
  };
}

/** Runs queued timers and animation frames by hand, so exit animations and delays are explicit. */
export function manualClock(h) {
  const timers = new Map();
  let id = 0;
  h.window.setTimeout = (fn, ms = 0) => { timers.set(++id, { fn, ms }); return id; };
  h.window.clearTimeout = key => { timers.delete(key); };
  return {
    pending: () => [...timers.values()].map(entry => entry.ms).sort((a, b) => a - b),
    run(ms) {
      for (const [key, entry] of [...timers]) {
        if (ms === undefined || entry.ms === ms) { timers.delete(key); entry.fn(); }
      }
    }
  };
}

/** The real more-info scripts over a stubbed Seerr API and UI facade. */
export function moreInfoHarness(t, { details = async id => movie(id), config = {}, api = {}, ui = {}, je = {}, html = '', ratings } = {}) {
  const { session, switchUser } = sessionFixture();
  const requests = [], seasonPicks = [], movieDialogs = [], collections = [], quotaDialogs = [], errors = [];
  const h = createHarness({
    html,
    JE: {
      pluginConfig: { TmdbEnabled: true, ...config }, userConfig: {}, t: key => key, escapeHtml: strictEscape, session,
      cdn: { flagPng: code => `/flag/${code}.png`, selfhst: path => `/cdn/${path}` },
      core: { ui: { injectCss() {}, isTvLayout: () => false }, api: { plugin: async () => ({ results: [] }), fetch: async () => ({ Items: [] }) } },
      helpers: { hydrateAvatarImages() {} },
      requestManager: { fetchWithRetry: async () => ({ json: async () => (ratings ? await ratings() : {}) }) },
      jellyseerrAPI: {
        fetchMovieDetails: id => details(id, 'movie'), fetchTvShowDetails: id => details(id, 'tv'),
        shouldShowAdvanced: () => false, followUpOptions: () => undefined, resolveJellyseerrBaseUrl: () => '', fetchUserQuota: async () => null,
        requestMedia: async (...args) => { requests.push(args); return { media: { status: 2 } }; }, ...api
      },
      jellyseerrUI: {
        icons: { request: '<i class="ic"></i>', error: '<i class="err"></i>' },
        showSeasonSelectionModal: (...args) => seasonPicks.push(args), showMovieRequestModal: (...args) => movieDialogs.push(args),
        showCollectionRequestModal: (...args) => collections.push(args), isQuotaError: () => false,
        showQuotaErrorDialog: async (...args) => quotaDialogs.push(args), buildQuotaChip: () => null, formatEtaText: () => null, ...ui
      },
      ...je
    }
  });
  t.after(() => h.close());
  h.window.CSS = { escape: value => String(value) };
  h.window.alert = message => errors.push(message);
  const clock = manualClock(h);
  h.load('jellyseerr/seerr-status.js');
  for (const script of MORE_INFO_SCRIPTS) h.load(script);
  const { internal, P } = { internal: h.JE.internals.moreInfoModal, P: h.JE.jellyseerrMoreInfo };
  return {
    ...h, internal, P, clock, switchUser, requests, seasonPicks, movieDialogs, collections, quotaDialogs, errors,
    get modal() { return internal.state.currentModal; },
    button: selector => h.document.querySelector(`.je-more-info-modal:not(.closing) ${selector}`),
    /** Marks the current modal so a later query can tell the replacement from it. */
    popup: () => h.document.querySelector('.je-4k-popup'),
    async settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
  };
}

export { deferred };
