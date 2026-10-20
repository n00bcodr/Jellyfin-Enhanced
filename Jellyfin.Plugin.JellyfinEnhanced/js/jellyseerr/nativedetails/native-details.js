// /js/jellyseerr/nativedetails/native-details.js
//
// Native details for titles that aren't in the library (experimental, Jellyfin 12 web only).
//
// The navigator: every place that opens a title that may not be in the library goes through
// JE.titleDetails. When the server offers the capability (public config NativeAbsentDetails
// {Enabled, ContractVersion}) a title opens on Jellyfin's own details page
// (#/details?id=<synthetic id>&serverId=<this server>); otherwise, or when the page can't be
// loaded, the More Info modal opens once (never after a refusal):
//   - open(tmdbId, mediaType, scope)  the native page only (false: the caller keeps its own way);
//   - show(tmdbId, mediaType, scope)  native page, else the modal;
//   - openKey(key, options)           by provider key (requests, notifications, calendar): the
//                                      library copy the viewer can open first, else the native page
//                                      (server: GET native-details/resolve), else the modal.
// The server facade answers the page's requests for the synthetic id (no library rows). This module
// adapts the page:
//   - hides the native actions a title without files can't do (Play, Shuffle, Played, Favourite,
//     More, Download, card play/options buttons) and blocks card context menus;
//   - holds the Requests & downloads controls: the status pill and journey, Notify me, Manage, Get
//     Season N / Get it and the missing-episode rows come from the details surface (status-details,
//     ask-actions, ask-episodes), which read status by this page's id; this module adds Request (the
//     request sheet) for movies, and "Request" through the modal when the request feature is off;
//   - lays them out as Jellyfin lays out a library title of the same type: the request action (or
//     Open) leads the native action row where Play sits, the other request actions follow it as
//     icon buttons, Spoiler Guard is an icon button in the row where the library's is, and the
//     status pill (with the request's cost lines under it) heads the details section;
//   - adds what the modal shows that the native layout has no place for: the ratings row (where
//     JE's MDBList ratings sit on a library title), the information panel (status, dates, money,
//     language, countries, studios, streaming, links), the trailers and the collection card;
//   - offers Open once a copy the viewer can open arrives (a deep link to a title that is already
//     here goes straight to it);
//   - re-checks the page on every view (Back, restore) and shows a neutral refusal when the server
//     refuses the title (parental limit, no access);
//   - lets the page's names lead somewhere: the server links cast and crew to the library's person
//     page, or to a person page of their own (this module adds "Known for"; the filmography is JE's
//     person discovery row), and genres, studios and networks to the library's list page, or to a
//     discovery page (#/list?genreId|studioId=<synthetic id>: the list holds nothing, JE's discovery
//     row the titles; this module hides the list's play buttons there).
// The id format is shared with the server (Services/NativeDetails/SyntheticId.cs): 4a45ad, version
// 1, kind, TMDB id (8 hex), season (4), episode (4), FNV-1a check (8) over "<serverId>|<prefix>".
(function (JE) {
    'use strict';

    const NAMESPACE = '4a45ad';
    const VERSION = '1';
    const CONTRACT = 1;
    const KINDS = { movie: 1, series: 2, season: 3, episode: 4, person: 5, genre: 6, studio: 7, network: 8 };
    const KIND_NAMES = { 1: 'movie', 2: 'series', 3: 'season', 4: 'episode', 5: 'person', 6: 'genre', 7: 'studio', 8: 'network' };
    /** Kinds that are titles (a request key, status, the information panel); the others are pages a title links to. */
    const TITLE_KINDS = new Set(['movie', 'series', 'season', 'episode']);
    /** On a person page: the native tagline is replaced by "Known for …". */
    const PERSON_CLASS = 'je-native-absent-person';
    /** On a genre/studio/network discovery page (a native list page with nothing of the library in it). */
    const LIST_CLASS = 'je-native-absent-list';
    const PAGE_CLASS = 'je-native-absent';
    /** A refused page: only the refusal box is shown (and no backdrop). */
    const REFUSED_CLASS = 'je-native-absent-refused';
    /** On the document while a refused page shows (the shared backdrop is hidden). */
    const REFUSED_VIEW_CLASS = 'je-native-absent-refused-view';
    /** A restored page whose access is being checked again: nothing of its earlier content shows until it passes. */
    const CHECKING_CLASS = 'je-native-absent-checking';
    const STYLE_ID = 'je-native-absent-style';
    /** The page's request controls in the native action row, in Play's place (first in the row). */
    const PRIMARY_CLASS = 'je-native-absent-primary';
    /**
     * Every control this module adds to a details page (the request controls in the row, the status
     * container, Spoiler Guard, the ratings, the extras) carries its page state's token here. Only
     * that state's own nodes are live; anything else marked (a copy, what an earlier state left) is
     * dead and goes at the next look, status read or dispose.
     */
    const OWNER_ATTR = 'data-je-native';
    const HIDDEN_ACTIONS = [
        '.btnPlay', '.btnResume', '.btnReplay', '.btnShuffle', '.btnInstantMix', '.btnPlaystate', '.btnUserRating',
        '.btnDownload', '.btnMoreCommands', '.btnSplitVersions', '.btnCancelSeriesTimer', '.btnCancelTimer',
        '.cardOverlayButton', '.btnCardOptions', '.listViewUserDataButtons', '[is="emby-playstatebutton"]',
        '[is="emby-ratingbutton"]', '.listItem [data-action="playmenu"]', '.listItem [data-action="play"]',
        '.listItem [data-action="menu"]', '.listItemImageButton',
        // JE's item-id controls: Hidden Content and Spoiler Guard rules never store a synthetic id
        // (library copies in the Similar rail keep their card hide button).
        '.je-spoiler-blur-btn'
    ];
    /** A second failure of the same page within this time says so on the page (no second modal). */
    const FALLBACK_WINDOW_MS = 5000;

    /** @type {Object|null} the synthetic page shown now */
    let current = null;
    let started = false;
    /** The synthetic id the last fallback left (a second look at it must not fall back again). */
    let fellBackFrom = null;
    /** Jellyfin has moved from one page to another since it was loaded (so there is a page to go back to). */
    let navigated = false;
    /**
     * The modal still to open after an outage sent the viewer back: its timer, the viewer, and the
     * page that failed, and the page Back landed on (null until it has).
     * @type {{timer: number, user: string|null, from: string, landing: string|null}|null}
     */
    let pendingModal = null;
    /** Page states made so far (each one's token), and whether any control was ever marked. */
    let tokens = 0;
    let marked = false;

    /**
     * This server's id in the normalised form the id check uses (lower case, no dashes).
     * @returns {string} Server id, or '' when unknown.
     */
    function serverId() {
        try {
            if (typeof ApiClient === 'undefined') return '';
            const id = typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
            return String(id || '').replace(/-/g, '').toLowerCase();
        } catch {
            return '';
        }
    }

    /**
     * FNV-1a (32-bit) of a string of ASCII characters.
     * @param {string} text Text.
     * @returns {number} Unsigned hash.
     */
    function fnv(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    }

    /**
     * Fixed-width lower-case hex.
     * @param {number} value Non-negative integer.
     * @param {number} width Digits.
     * @returns {string} Hex.
     */
    function hex(value, width) {
        return (value >>> 0).toString(16).padStart(width, '0');
    }

    /**
     * The synthetic id of a title (or season/episode), person, genre, studio or network on this server.
     * @param {string} kind movie, series, season, episode, person, genre, studio or network.
     * @param {number} tmdbId TMDB id.
     * @param {number} [season] Season number.
     * @param {number} [episode] Episode number.
     * @param {string} [server] Server id (defaults to the current one).
     * @returns {string|null} 32 hex digits, or null for bad input.
     */
    function syntheticId(kind, tmdbId, season = 0, episode = 0, server = serverId()) {
        const k = KINDS[kind];
        const tmdb = Number(tmdbId);
        if (!k || !server || !Number.isInteger(tmdb) || tmdb <= 0 || tmdb > 0x7fffffff) return null;
        if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0 || season > 0xffff || episode > 0xffff) return null;
        const prefix = NAMESPACE + VERSION + hex(k, 1) + hex(tmdb, 8) + hex(season, 4) + hex(episode, 4);
        return prefix + hex(fnv(String(server).replace(/-/g, '').toLowerCase() + '|' + prefix), 8);
    }

    /**
     * Decodes a synthetic id of this server.
     * @param {string|null|undefined} id Item id (dashes allowed).
     * @param {string} [server] Server id (defaults to the current one).
     * @returns {{kind: string, tmdbId: number, season: number, episode: number}|null} Parts, or null.
     */
    function parse(id, server = serverId()) {
        const n = String(id || '').replace(/-/g, '').toLowerCase();
        if (n.length !== 32 || !n.startsWith(NAMESPACE + VERSION) || !/^[0-9a-f]{32}$/.test(n) || !server) return null;
        const prefix = n.slice(0, 24);
        if (hex(fnv(String(server).replace(/-/g, '').toLowerCase() + '|' + prefix), 8) !== n.slice(24)) return null;
        const kind = KIND_NAMES[parseInt(n.slice(7, 8), 16)];
        if (!kind) return null;
        return { kind, tmdbId: parseInt(n.slice(8, 16), 16), season: parseInt(n.slice(16, 20), 16), episode: parseInt(n.slice(20, 24), 16) };
    }

    /**
     * True for a synthetic id of this server.
     * @param {string|null|undefined} id Item id.
     * @returns {boolean} Synthetic.
     */
    function isSynthetic(id) {
        return parse(id) !== null;
    }

    /**
     * True when the server offers native details for absent titles (capability and admin switch).
     * @returns {boolean} Available.
     */
    function available() {
        const cap = JE.pluginConfig?.NativeAbsentDetails;
        return !!cap && cap.Enabled === true && cap.ContractVersion === CONTRACT && !!serverId();
    }

    // ------------------------------------------------------------------ navigator

    /**
     * Shows a details page.
     * @param {string} itemId Item id (library or synthetic).
     * @param {boolean} [replace] Replace the current history entry (a page that isn't the destination).
     * @returns {void}
     */
    function go(itemId, replace) {
        const path = `/details?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(serverId())}`;
        if (replace) {
            window.location.replace('#' + path);
            return;
        }
        try {
            if (window.Emby?.Page?.show) {
                window.Emby.Page.show(path);
            } else {
                window.location.hash = '#' + path;
            }
        } catch {
            window.location.hash = '#' + path;
        }
    }

    /**
     * The synthetic kind and id of a title (and optional season/episode).
     * @param {number|string} tmdbId TMDB id.
     * @param {string} mediaType "movie" or "tv".
     * @param {{season?: number, episode?: number}} [scope] Season/episode of a series.
     * @returns {string|null} Id.
     */
    function idOf(tmdbId, mediaType, scope) {
        if (mediaType === 'movie') return syntheticId('movie', Number(tmdbId));
        if (mediaType !== 'tv') return null;
        const season = Number.isInteger(scope?.season) ? scope.season : null;
        const episode = Number.isInteger(scope?.episode) ? scope.episode : null;
        if (season != null && episode != null) return syntheticId('episode', Number(tmdbId), season, episode);
        if (season != null) return syntheticId('season', Number(tmdbId), season);
        return syntheticId('series', Number(tmdbId));
    }

    /**
     * True when the viewer's user status (already loaded) says Seerr won't answer for them (no linked account, or
     * Seerr turned off for them) while Seerr handles requests: the server refuses them every native page, so the
     * caller's own destination (the More Info window, which says why) is the one to use.
     * @returns {boolean} Seerr refuses the viewer.
     */
    function seerrRefusesViewer() {
        return !!JE.jellyseerrAPI?.knownAccountRefusal?.() && JE.internals?.arrAskSeerr?.jeMode?.() !== true;
    }

    /**
     * Opens a title that isn't in the library on Jellyfin's own details page.
     * @param {number|string} tmdbId TMDB id.
     * @param {string} mediaType "movie" or "tv".
     * @param {{season?: number, episode?: number}} [scope] Season/episode of a series.
     * @returns {boolean} True when it navigated; false means the caller keeps its own destination.
     */
    function open(tmdbId, mediaType, scope) {
        if (!available() || seerrRefusesViewer()) return false;
        const id = idOf(tmdbId, mediaType, scope);
        if (!id) return false;
        go(id);
        return true;
    }

    /**
     * Opens the More Info modal (the fallback). Kept apart from the navigator, so a fallback can never
     * come back through it.
     * @param {number|string} tmdbId TMDB id.
     * @param {string} mediaType "movie" or "tv".
     * @returns {boolean} True when the modal was asked to open.
     */
    function openModal(tmdbId, mediaType, scope, owner) {
        const tmdb = Number(tmdbId);
        if (!(tmdb > 0) || (mediaType !== 'movie' && mediaType !== 'tv') || typeof JE.jellyseerrMoreInfo?.open !== 'function') return false;
        if (scope?.season != null) JE.jellyseerrMoreInfo.open(tmdb, mediaType, { season: scope.season, ...(scope.episode != null ? { episode: scope.episode } : {}) }, owner);
        else JE.jellyseerrMoreInfo.open(tmdb, mediaType, undefined, owner);
        return true;
    }

    /**
     * Opens a title that may not be in the library from an entry point that used to open the modal:
     * the native page when offered, otherwise the modal.
     * @param {number|string} tmdbId TMDB id.
     * @param {string} mediaType "movie" or "tv".
     * @param {{season?: number, episode?: number}} [scope] Season/episode of a series.
     * @returns {boolean} True when something opened.
     */
    function show(tmdbId, mediaType, scope) {
        if (open(tmdbId, mediaType, scope)) return true;
        // The fallback of a title page: a page the person opened, not part of any title action (native, D46S2-R6).
        return openModal(tmdbId, mediaType, scope, JE.NATIVE);
    }

    /**
     * The TMDB id a title key names directly (movie:tmdb:1 / tv:tmdb:2), or 0.
     * @param {string} key Title key.
     * @returns {number} TMDB id.
     */
    function tmdbOfKey(key) {
        const m = /^(movie|tv):tmdb:(\d+)/.exec(String(key || ''));
        return m ? Number(m[2]) : 0;
    }

    /**
     * Asks the server where a title opens for this viewer.
     * @param {Object} query Query (key/id, season, episode).
     * @returns {Promise<{itemId?: string, id?: string}|null>} Destination, or null.
     */
    async function resolve(query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
        }
        const path = `/native-details/resolve?${params.toString()}`;
        try {
            if (JE.core?.api?.plugin) return await JE.core.api.plugin(path, { skipCache: true, skipRetry: true, timeoutMs: 8000 });
            return await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`JellyfinEnhanced${path}`), dataType: 'json' });
        } catch {
            return null;
        }
    }

    /**
     * Opens a title known by provider key (Requests hub, notifications, calendar): a library copy the
     * viewer can open first (the season or episode when named), else the native page, else the modal.
     * @param {string} key Title key such as movie:tmdb:603 or tv:tvdb:81189 (season/episode suffixes allowed).
     * @param {{season?: number, episode?: number, tmdbId?: number, mediaType?: string, modal?: boolean, current?: function(): boolean}} [options] Scope and fallback identity (modal: false, no modal fallback; current: the caller's owner is still current).
     * @returns {Promise<boolean>} True when something opened.
     */
    async function openKey(key, options = {}) {
        const action = JE.createSessionAction();
        const child = /:s(\d+)(?::e(\d+))?$/.exec(String(key || ''));
        options = { ...options, ...(child ? { season: Number(child[1]), ...(child[2] != null ? { episode: Number(child[2]) } : {}) } : {}) };
        const mediaType = options.mediaType || (String(key || '').startsWith('movie:') ? 'movie' : 'tv');
        if (available() && key) {
            const answer = await resolve({ key, season: options.season, episode: options.episode });
            // A caller-owned route/mount generation (a shared link) stops here as well.
            if (!action.current() || options.current?.() === false) return false;
            if (answer?.itemId && /^[0-9a-f-]{32,36}$/i.test(answer.itemId)) {
                go(answer.itemId);
                return true;
            }
            if (answer?.id && isSynthetic(answer.id)) {
                go(answer.id);
                return true;
            }
        }
        if (options.modal === false) return false;
        return action.current() && options.current?.() !== false && openModal(options.tmdbId || tmdbOfKey(key), mediaType, options, JE.NATIVE);
    }

    // ------------------------------------------------------------------ page adapter

    /**
     * Injects the stylesheet of synthetic pages (once).
     * @returns {void}
     */
    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        const x = '.je-native-absent-extras';
        style.textContent = HIDDEN_ACTIONS.map(s => `.${PAGE_CLASS} ${s}`).join(',\n') + ' { display: none !important; }\n'
            + `.je-native-absent-actions { margin: 0.8em 0 0.4em; display: flex; flex-direction: column; gap: 0.6em; }\n`
            + `.je-native-absent-actions:empty, .je-native-absent-row:empty { display: none; }\n`
            // The request controls in the native action row: the first one leads with its label (where
            // Play sits on a library title), the rest are icon buttons like the row's own.
            + `.${PRIMARY_CLASS}, .${PRIMARY_CLASS} .je-native-absent-request, .${PRIMARY_CLASS} .je-ask-actions, .${PRIMARY_CLASS} .je-ask-mount, .${PRIMARY_CLASS} .je-ask-mount-row { display: inline-flex; flex-wrap: nowrap; align-items: center; gap: 0.4em; margin: 0; }\n`
            + `.${PRIMARY_CLASS} .je-native-absent-lead, .${PRIMARY_CLASS} .je-native-absent-lead * { white-space: nowrap; }\n`

            + `.${PRIMARY_CLASS} { margin-right: 0.4em; }\n`
            + `.${PRIMARY_CLASS}.je-native-absent-primary-empty, .${PRIMARY_CLASS}:empty, .${PRIMARY_CLASS} .je-native-absent-request:empty, .${PRIMARY_CLASS} .je-ask-mount:empty, .${PRIMARY_CLASS} .je-ask-mount-row:empty { display: none; }\n`
            + `.${PRIMARY_CLASS} .je-native-absent-lead { flex: 0 0 auto; margin: 0; min-height: 2.6em; }\n`
            + `.${PRIMARY_CLASS} .je-ask-paused-note { flex: 0 1 auto; margin: 0; padding: 0 0.9em; min-height: 2.6em; box-sizing: border-box; align-items: center; border-radius: 999px; font-size: 0.95em; }\n`
            + `.${PRIMARY_CLASS} .je-ask-paused-icon { font-size: 1.2em; }\n`
            + `.${PRIMARY_CLASS} .je-ask-paused-body { gap: 0; }\n`
            + `.${PRIMARY_CLASS} .je-ask-paused-text, .${PRIMARY_CLASS} .je-native-absent-icon > span:not(.material-icons) { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }\n`
            + `.${PRIMARY_CLASS} button.je-native-absent-icon { flex: 0 0 auto; background: transparent; border-color: transparent; color: inherit; min-width: 0; min-height: 0; border-radius: 50%; font-weight: inherit; }\n`
            + `.${PRIMARY_CLASS} button.je-native-absent-icon:hover { background: rgba(127,127,127,0.18); }\n`
            + `.${PRIMARY_CLASS} .je-native-absent-icon .material-icons { font-size: 1.6em; }\n`
            // Phones: the row fits the width (a library title's own row is icon buttons only).
            + `@media (max-width: 600px) { .${PRIMARY_CLASS} { gap: 0.2em; margin-right: 0.2em; } .${PRIMARY_CLASS} .je-native-absent-lead { padding-left: 0.7em; padding-right: 0.7em; font-size: 0.85em; } .${PRIMARY_CLASS} .je-native-absent-icon { padding-left: 0.6em !important; padding-right: 0.6em !important; } }\n`
            + `.je-native-absent-notes { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3em 0.9em; }\n`
            + `.je-native-absent-notes:empty { display: none; }\n`
            + `.je-native-absent-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6em; }\n`
            + `.je-native-absent-status:empty { display: none; }\n`
            + `.je-native-absent-btn { display: inline-flex; align-items: center; gap: 0.4em; min-height: 44px; padding: 0 1.1em; border-radius: 6px; margin: 0; }\n`
            + `.je-native-absent-btn .material-icons { font-size: 1.25em; }\n`
            + `.je-native-absent-ratings { margin: 0.4em 0; }\n`
            + `.je-native-absent-ratings .je-more-info-ratings-row { justify-content: flex-start; padding-bottom: 0; gap: 0.5rem; }\n`
            + `.je-native-absent-ratings .je-more-info-rating-badge-item { padding: 0.35rem 0.5rem 0.35rem 0; color: inherit; }\n`
            + `.je-native-absent-ratings:empty { display: none; }\n`
            + `${x} { margin: 1.5em 0 0.5em; display: flex; flex-direction: column; gap: 1.5em; }\n`
            + `${x} .je-more-info-right-panel { position: static; max-height: none; overflow: visible; max-width: 44em; }\n`
            + `${x} .je-more-info-right-panel .je-more-info-media-ratings { display: none; }\n`
            + `${x} .je-more-info-stats-panel, ${x} .je-more-info-stat-label, ${x} .je-more-info-stat-value { color: inherit; }\n`
            + `${x} .je-collection-card { max-width: 44em; }\n`
            + `${x} a[is="emby-linkbutton"] { padding: 0 !important; margin: 0 !important; }\n`
            + `${x} .je-more-info-media-facts-row { justify-content: flex-start; }\n`
            + `${x} h2.sectionTitle { margin: 0 0 0.6em; }\n`
            + `${x} .trailers-grid { display: flex; gap: 1rem; overflow-x: auto; overflow-y: hidden; padding-bottom: 0.75rem; scrollbar-width: none; -webkit-overflow-scrolling: touch; }\n`
            + `${x} .trailers-grid::-webkit-scrollbar { display: none; }\n`
            + `${x} .trailers-section h3 { display: none; }\n`
            + `${x} .trailer-item { flex: 0 0 auto; width: 200px; border-radius: 6px; overflow: hidden; background: rgba(127,127,127,0.12); border: 1px solid rgba(127,127,127,0.25); text-decoration: none; display: block; color: inherit; padding: 0 !important; margin: 0 !important; }\n`
            + `${x} .trailer-thumbnail { position: relative; aspect-ratio: 16/9; background: #000; }\n`
            + `${x} .trailer-thumbnail img { width: 100%; height: 100%; object-fit: cover; }\n`
            + `${x} .je-modal-play-button { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 46px; height: 46px; background: rgba(255,255,255,0.9); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #000; }\n`
            + `${x} .je-modal-play-button svg { width: 24px; height: 24px; margin-left: 2px; }\n`
            + `${x} .trailer-youtube-icon { position: absolute; top: 5px; right: 5px; width: 28px !important; height: 28px !important; padding: 3px; opacity: 0.7; }\n`
            + `${x} .trailer-info { padding: 0.5rem; }\n`
            + `${x} .trailer-name { font-weight: 600; font-size: 0.9rem; margin-bottom: 0.15rem; }\n`
            + `${x} .trailer-type { font-size: 0.8rem; opacity: 0.75; }\n`
            + `.je-native-absent-knownfor { opacity: 0.85; font-size: 1.05em; }\n`
            + `.je-native-absent-knownfor:empty { display: none; }\n`
            + `#itemDetailPage.${PERSON_CLASS} .tagline { display: none !important; }\n`
            // A discovery page's own list is empty by construction: no paging, play, sort or filter controls.
            + `.${LIST_CLASS} .itemsViewSettingsContainer, .${LIST_CLASS} .paging, .${LIST_CLASS} .alphaPicker { display: none !important; }\n`
            // ... and no room for that empty list above the discovery row, which becomes the page's top.
            + `.${LIST_CLASS} > :not([class*="-discovery-section"]):not(.alphaPicker):not(.je-native-absent-refusal) { min-height: 0 !important; height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; margin: 0 !important; overflow: hidden !important; }\n`
            + `.${LIST_CLASS} > [class*="-discovery-section"] { margin-top: 0 !important; border-top: 0 !important; }\n`
            + `.je-native-absent-refusal { padding: 3em 1.5em; text-align: center; font-size: 1.15em; }\n`
            // A refused page keeps nothing of the title on screen: a restored view's earlier content is hidden.
            + `#itemDetailPage.${REFUSED_CLASS} > :not(.je-native-absent-refusal) { display: none !important; }\n`
            + `html.${REFUSED_VIEW_CLASS} .backdropContainer { display: none !important; }\n`
            // A restored page being checked again: its earlier content is kept in place but not shown.
            + `#itemDetailPage.${CHECKING_CLASS} > * { visibility: hidden !important; }\n`
            + `html.${CHECKING_CLASS} .backdropContainer { visibility: hidden !important; }\n`
            + `.je-native-absent-refusal button { margin-top: 1.2em; }\n`
            + `@media (max-width: 600px) { ${x} .trailer-item { width: 170px; } }`;
        document.head.appendChild(style);
    }

    /**
     * The details id in the current URL.
     * @returns {string|null} Id.
     */
    function idFromHash() {
        const hash = window.location.hash || '';
        if (!/details/i.test(hash)) return null;
        try {
            return new URLSearchParams(hash.split('?')[1] || '').get('id');
        } catch {
            return null;
        }
    }

    /**
     * The synthetic genre/studio/network id of the list page in the current URL (#/list?genreId= or
     * studioId=), or null.
     * @returns {string|null} Id.
     */
    function listIdFromHash() {
        const hash = window.location.hash || '';
        if (!/\/list/i.test(hash)) return null;
        try {
            const params = new URLSearchParams(hash.split('?')[1] || '');
            return params.get('genreId') || params.get('studioId');
        } catch {
            return null;
        }
    }

    /**
     * Marks the list page shown now as a discovery page when its genre/studio/network id is synthetic
     * (its list, paging, play, filter and sort controls have nothing to act on there), and unmarks
     * other list pages.
     * @returns {void}
     */
    function adaptListPage() {
        const listId = listIdFromHash();
        const parts = listId ? parse(listId) : null;
        const discovery = !!parts && (parts.kind === 'genre' || parts.kind === 'studio' || parts.kind === 'network');
        if (discovery) injectStyles();
        document.querySelectorAll(`.${LIST_CLASS}`).forEach(n => n.classList.remove(LIST_CLASS));
        document.querySelectorAll('.je-native-absent-list-off').forEach(n => n.remove());
        if (!discovery) return;
        const page = document.querySelector('.page:not(.hide)');
        if (!page || page.id === 'itemDetailPage') return;
        page.classList.add(LIST_CLASS);
        // The page's only content is its discovery row: with that row switched off (an older link, a
        // bookmark, Back) it says so instead of staying blank.
        const rowOn = parts.kind === 'genre'
            ? JE.pluginConfig?.JellyseerrShowGenreDiscovery !== false
            : JE.pluginConfig?.JellyseerrShowNetworkDiscovery === true;
        if (rowOn) return;
        const box = el('div', 'je-native-absent-refusal je-native-absent-list-off');
        box.setAttribute('role', 'status');
        box.textContent = JE.t('native_details_page_unavailable');
        const inApp = cameFromApp();
        const back = el('button', 'raised button-submit emby-button', JE.t(inApp ? 'native_details_back' : 'native_details_home'));
        back.type = 'button';
        back.addEventListener('click', () => (inApp ? history.back() : goHome()));
        box.appendChild(document.createElement('br'));
        box.appendChild(back);
        page.prepend(box);
    }

    /**
     * The details page shown now.
     * @returns {HTMLElement|null} Page.
     */
    function visiblePage() {
        return document.querySelector('#itemDetailPage:not(.hide)');
    }

    /**
     * The request key of a page's title (movie, or the series for every series page).
     * @param {Object} item Item DTO.
     * @param {{kind: string, tmdbId: number}} parts Synthetic id parts.
     * @returns {string} Key.
     */
    function keyOf(item, parts) {
        if (parts.kind === 'movie') return `movie:tmdb:${parts.tmdbId}`;
        const tvdb = Number(item?.ProviderIds?.Tvdb);
        return tvdb > 0 ? `tv:tvdb:${tvdb}` : `tv:tmdb:${parts.tmdbId}`;
    }

    /**
     * An element with a class and text.
     * @param {string} tag Tag.
     * @param {string} [cls] Class.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    /**
     * A page button (44 px tall).
     * @param {string} iconName Material icon.
     * @param {string} text Label.
     * @param {string} cls Extra class.
     * @returns {HTMLButtonElement} Button.
     */
    function pageButton(iconName, text, cls) {
        const b = /** @type {HTMLButtonElement} */ (el('button', `raised emby-button je-native-absent-btn ${cls}`));
        b.type = 'button';
        b.appendChild(el('span', 'material-icons', iconName)).setAttribute('aria-hidden', 'true');
        b.appendChild(el('span', null, text));
        return b;
    }

    /**
     * The page's native action row (Play, Trailer, Favourite, More… on a library title).
     * @param {HTMLElement} page Details page.
     * @returns {HTMLElement|null} Row.
     */
    function rowOf(page) {
        return page.querySelector('.mainDetailButtons') || page.querySelector('.detailButtons');
    }

    /**
     * Marks a control as the page state's own (see OWNER_ATTR).
     * @template {HTMLElement} T
     * @param {Object} state Page state.
     * @param {T} node Control.
     * @returns {T} The control.
     */
    function own(state, node) {
        node.setAttribute(OWNER_ATTR, state.token);
        marked = true;
        return node;
    }

    /**
     * The controls a page state added to its page (each holds the rest of its parts).
     * @param {Object} state Page state.
     * @returns {HTMLElement[]} Controls.
     */
    function controlsOf(state) {
        return [state.primary, state.container, state.hide, state.spoiler, state.ratings, state.extras].filter(Boolean);
    }

    /**
     * Removes every control this module drew that isn't one of the live page state's own nodes:
     * dead copies (a row drawn anew from its old self copies them, with their marks) and whatever an
     * earlier state left behind. With no state, all of them go.
     * @param {Object|null} state Live page state.
     * @returns {void}
     */
    function sweep(state) {
        if (!marked) return;
        const live = state ? controlsOf(state) : [];
        document.querySelectorAll(`[${OWNER_ATTR}]`).forEach((n) => {
            if (!state || n.getAttribute(OWNER_ATTR) !== state.token || !live.includes(n)) n.remove();
        });
    }

    /**
     * The request controls' place in the native action row: first, where Play sits on a library
     * title. It holds the request slot (Open, the movie's Request mount, the modal's Request) and
     * then the smart actions; its first control leads with its label, the rest are icon buttons.
     * Always a new one for a new page state: one already in the row belongs to no live state.
     * @param {Object} state Page state.
     * @returns {HTMLElement|null} Slot, or null when the page has no action row.
     */
    function primaryOf(state) {
        const row = rowOf(state.page);
        if (!row) return null;
        const slot = own(state, el('div', PRIMARY_CLASS));
        slot.setAttribute('role', 'group');
        slot.setAttribute('aria-label', JE.t('arr_actions_label'));
        slot.appendChild(el('div', 'je-native-absent-request'));
        row.insertBefore(slot, row.firstElementChild);
        return slot;
    }

    /**
     * Gives the row's request controls their native look: the first (button, state chip or paused
     * line) leads with its label; the buttons after it are icon buttons like the row's own, their
     * label kept as the tooltip and accessible name.
     * @param {HTMLElement} slot Request controls in the row.
     * @returns {void}
     */
    function markRow(slot) {
        const items = [...slot.querySelectorAll('button, .je-arr-chip, .je-ask-paused-note')];
        // Nothing to show yet (or any more): the row has no gap where it would be.
        slot.classList.toggle('je-native-absent-primary-empty', !items.length);
        items.forEach((n, i) => {
            const lead = i === 0;
            const icon = !lead && n.tagName === 'BUTTON';
            n.classList.toggle('je-native-absent-lead', lead);
            n.classList.toggle('je-native-absent-icon', icon);
            n.classList.toggle('detailButton', icon);
            n.classList.toggle('button-flat', icon);
            const text = (n.querySelector('.je-ask-action-text, .je-ask-paused-title, span:not(.material-icons)')?.textContent || '').trim();
            if (icon && text && !n.title) n.title = text;
            if (n.classList.contains('je-ask-paused-note')) {
                const detail = n.querySelector('.je-ask-paused-text')?.textContent?.trim();
                if (detail) n.title = detail;
            }
        });
    }

    /**
     * The container of this module's controls at the top of the primary detail section (under the
     * title ribbon): the status slot (status-details anchorOf puts the status block there), the cost
     * lines of the request actions in the row, and the ratings until they find their place. A page
     * without an action row keeps the request slot here too. Always a new one for a new page state
     * (it sets `state.ratings` too).
     * @param {Object} state Page state.
     * @returns {HTMLElement|null} Container.
     */
    function actionsOf(state) {
        const { page, primary } = state;
        const anchor = page.querySelector('.detailPagePrimaryContent .detailSection')
            || page.querySelector('.detailPagePrimaryContent')
            || page.querySelector('.detailPagePrimaryContainer');
        if (!anchor) return null;
        const box = own(state, el('div', 'je-native-absent-actions'));
        const status = el('div', 'je-native-absent-status');
        box.appendChild(status);
        box.appendChild(el('div', 'je-native-absent-notes'));
        if (!primary) box.appendChild(el('div', 'je-native-absent-row je-native-absent-request'));
        // Ratings start here and move above the external links once drawn (mountExtras).
        state.ratings = box.appendChild(own(state, el('div', 'je-native-absent-ratings')));
        anchor.insertBefore(box, anchor.firstChild);
        // The details surface may have answered before this page's controls existed.
        page.querySelectorAll('.je-arr-status[data-je-arr-surface="details"]').forEach(n => {
            if (!box.contains(n)) status.appendChild(n);
        });
        return box;
    }

    /**
     * Puts the smart actions (ask-actions) of this page into the row's request controls, their cost
     * lines under the status, replacing the previous box. ask-actions calls this before placing a
     * box itself.
     * @param {HTMLElement} page Page.
     * @param {HTMLElement|null} box Actions, or null for none.
     * @param {HTMLElement|null} [old] The box shown until now.
     * @returns {boolean} True when the page is a native page that placed (or removed) it.
     */
    function placeActions(page, box, old) {
        const state = current;
        if (!state || state.aborted || state.page !== page || !state.primary) return false;
        restore(state);
        if (!page.contains(state.primary)) {
            // No action row to put them in: the new box goes under the status (ask-actions; a later look
            // brings it into the row), and the one the controls hold is out of date.
            dropActions(state);
            return false;
        }
        putActions(state, box, old);
        return true;
    }

    /**
     * Puts a smart-actions box (or none) into the row's request controls, which then hold that one
     * box only (the newest), its cost lines under the status.
     * @param {Object} state Page state.
     * @param {HTMLElement|null} box Actions, or null for none.
     * @param {HTMLElement|null} [old] The box shown until now.
     * @returns {void}
     */
    function putActions(state, box, old) {
        if (old && old !== box) old.remove();
        state.primary.querySelectorAll('.je-ask-actions').forEach((n) => { if (n !== box) n.remove(); });
        const notes = state.container?.querySelector('.je-native-absent-notes');
        notes?.replaceChildren();
        if (!box) return;
        if (box.parentNode !== state.primary) state.primary.appendChild(box);
        if (notes) box.querySelectorAll('.je-ask-action-cost').forEach(n => notes.appendChild(n));
        markRow(state.primary);
    }

    /**
     * Takes the smart actions out of the row's request controls, with their cost lines.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function dropActions(state) {
        state.primary?.querySelectorAll('.je-ask-actions').forEach(n => n.remove());
        state.container?.querySelector('.je-native-absent-notes')?.replaceChildren();
    }

    /**
     * After the row's request controls changed: the native look again, and no cost lines left under
     * the status once the smart actions are gone.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function syncRow(state) {
        if (!state.primary) return;
        markRow(state.primary);
        if (!state.primary.querySelector('.je-ask-actions')) state.container?.querySelector('.je-native-absent-notes')?.replaceChildren();
        focusLead(state);
    }

    /**
     * TV layout: the page's first focus is on Play on a library title. Here the request action
     * takes it when it arrives (after Jellyfin focused the row), once per page view, unless the
     * viewer has pressed a key since the page was shown.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function focusLead(state) {
        if (state.leadFocused || state.keyed || !document.documentElement.classList.contains('layout-tv')) return;
        const lead = state.primary?.querySelector('button.je-native-absent-lead:not([disabled])');
        if (!lead) return;
        state.leadFocused = true;
        const active = document.activeElement;
        const row = rowOf(state.page);
        if (!active || active === document.body || (row?.contains(active) && !state.primary.contains(active))) {
            lead.focus({ preventScroll: true });
        }
    }

    /**
     * The request slot of a page: in the row, or in the container on a page without one.
     * @param {Object} state Page state.
     * @returns {HTMLElement|null} Slot.
     */
    function requestSlot(state) {
        return state.primary?.querySelector('.je-native-absent-request')
            || state.container?.querySelector('.je-native-absent-request') || null;
    }

    /**
     * Spoiler Guard's per-title switch for a movie or series, as an icon button in the native action
     * row where the library's own Spoiler Guard button sits (before More…). The rule is kept by TMDB id
     * (pending until the title arrives), never by the page's id.
     * @param {Object} state Page state.
     * @param {Object} item Item DTO.
     * @returns {void}
     */
    function mountSpoiler(state, item) {
        const hide = ['movie', 'series', 'season', 'episode'].includes(state.parts.kind) && JE.hiddenContent?.buildTitleControl?.({ itemId: state.itemId || state.id, type: state.parts.kind === 'movie' ? 'Movie' : 'Series',
            tmdbId: state.parts.tmdbId, name: item?.Name || '' }, { detail: true });
        if (hide) {
            state.page.querySelectorAll('.je-detail-hide-btn').forEach(node => node.remove());
            state.hide = own(state, hide);
            const host = rowOf(state.page);
            if (host) JE.core.ui.placeDetailAction(host, hide);
            else state.container?.appendChild(hide);
        }
        const { parts, page } = state;
        if (parts.kind !== 'movie' && parts.kind !== 'series') return;
        const row = rowOf(page);
        const build = JE.internals?.spoilerGuard?.buildSeerrToggle;
        if (!row || typeof build !== 'function') return;
        let button = null;
        try {
            button = build({ id: parts.tmdbId, title: item?.Name || '', name: item?.Name || '', mediaInfo: null, jeSpoiler: { guarded: item?.ProviderIds?.JeSpoilerGuarded === 'true' } }, state.mediaType, { detail: true });
        } catch {
            button = null;
        }
        if (!button) return;
        // Where a library title has it: after Report issue, just before More….
        state.spoiler = own(state, button);
        JE.core.ui.placeDetailAction(row, button);
    }

    /**
     * The page's controls are the live state's own, once each: dead copies and leftovers go, and the
     * request controls and Spoiler Guard go back into the row if it was drawn anew (its contents or
     * the row itself) while the page stayed. They are the same controls, still live and still
     * observed, so nothing is mounted twice. The status container, ratings and extras live outside
     * the row; if the details section holding them is drawn anew, the page isn't the same any more
     * and a new state draws it.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function restore(state) {
        sweep(state);
        const row = state.primary ? rowOf(state.page) : null;
        if (!row) return;
        if (row.firstElementChild !== state.primary) row.insertBefore(state.primary, row.firstElementChild);
        if (state.hide && state.hide.parentNode !== row) JE.core.ui.placeDetailAction(row, state.hide);
        if (state.spoiler && state.spoiler.parentNode !== row) JE.core.ui.placeDetailAction(row, state.spoiler);
    }

    /**
     * restore, then smart actions shown outside the row move in. Runs on every look (and for a new
     * page state), on every status read, and (as restore) whenever smart actions are placed.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function reconcile(state) {
        restore(state);
        adoptActions(state);
    }

    /**
     * Stops what the previous synthetic page started and takes away every control this module drew,
     * copies included.
     * @returns {void}
     */
    function dispose() {
        const state = current;
        if (state) {
            state.aborted = true;
            try { state.controls?.destroy?.(); } catch { /* already gone */ }
            state.observer?.disconnect();
            state.rowObserver?.disconnect();
            if (state.onKey) document.removeEventListener('keydown', state.onKey, true);
            controlsOf(state).forEach(n => n.remove());
            current = null;
        }
        sweep(null);
    }

    /**
     * Neutral message in place of the page (no modal or external-link bypass): a refusal, or a
     * page that still can't be loaded after the one fallback.
     * @param {HTMLElement} page Details page.
     * @param {string} [messageKey] Translation key of the message.
     * @returns {void}
     */
    function refuse(page, messageKey = 'native_details_unavailable') {
        // A refusal on another page (where Back or Forward took the viewer) wins over the modal an
        // earlier outage still meant to open; the failed page's own second look keeps it.
        if (pendingModal && window.location.hash !== pendingModal.from) cancelPendingModal();
        window.Dashboard?.hideLoadingMsg?.();
        page.querySelector('.je-native-absent-refusal')?.remove();
        sweep(null);
        const box = el('div', 'je-native-absent-refusal');
        box.setAttribute('role', 'status');
        box.textContent = JE.t(messageKey);
        // Back within Jellyfin; a page opened from outside (a link, a bookmark) goes to Home instead.
        const inApp = cameFromApp();
        const back = el('button', 'raised button-submit emby-button', JE.t(inApp ? 'native_details_back' : 'native_details_home'));
        back.type = 'button';
        back.addEventListener('click', () => (inApp ? history.back() : goHome()));
        box.appendChild(document.createElement('br'));
        box.appendChild(back);
        // The page's own content (a restored view still holds the title, overview, cast and artwork) is
        // hidden while the refusal stands; a later check that passes shows it again.
        page.prepend(box);
        checking(page, false);
        page.classList.add(REFUSED_CLASS);
        document.documentElement.classList.add(REFUSED_VIEW_CLASS);
    }

    /**
     * Shows (or hides) a restored page's earlier content while its access is checked again.
     * @param {HTMLElement|null} page Page.
     * @param {boolean} on Hide it (true) or show it again.
     * @returns {void}
     */
    function checking(page, on) {
        const was = document.documentElement.classList.contains(CHECKING_CLASS);
        document.documentElement.classList.toggle(CHECKING_CLASS, on);
        page?.classList.toggle(CHECKING_CLASS, on);
        // Jellyfin's own loading indicator while the page is hidden.
        if (on && !was) window.Dashboard?.showLoadingMsg?.();
        else if (!on && was) window.Dashboard?.hideLoadingMsg?.();
    }

    /**
     * Ends a refusal shown on a page (its box and the hidden content), or only the page-wide part when
     * no page is given.
     * @param {HTMLElement|null} [page] Page.
     * @returns {void}
     */
    function unrefuse(page) {
        document.documentElement.classList.remove(REFUSED_VIEW_CLASS);
        if (!page) return;
        page.classList.remove(REFUSED_CLASS);
        page.querySelector('.je-native-absent-refusal')?.remove();
    }

    /**
     * Drops the modal an earlier outage still meant to open (a refusal, another user, or the viewer
     * moved on from where Back took them).
     * @returns {void}
     */
    function cancelPendingModal() {
        if (!pendingModal) return;
        clearTimeout(pendingModal.timer);
        pendingModal = null;
    }

    /**
     * After an outage: Back to where the viewer was, then the modal over that page, once, unless the
     * viewer has moved on (another page than the one Back landed on), was refused on another page
     * meanwhile or is someone else by then.
     * @param {number} tmdbId TMDB id.
     * @param {string} mediaType movie | tv.
     * @returns {void}
     */
    function backThenModal(tmdbId, mediaType) {
        cancelPendingModal();
        const user = window.ApiClient?.getCurrentUserId?.() || null;
        const pending = { timer: 0, user, from: window.location.hash, landing: null };
        pending.timer = setTimeout(() => {
            if (pendingModal !== pending) return;
            pendingModal = null;
            if (pending.landing !== null && window.location.hash !== pending.landing) return;
            if ((window.ApiClient?.getCurrentUserId?.() || null) !== user) return;
            openModal(tmdbId, mediaType, undefined, JE.NATIVE);
        }, 300);
        pendingModal = pending;
        history.back();
    }

    /**
     * Notes where Back landed for a pending modal (the first navigation after it).
     * @returns {void}
     */
    function notePendingMove() {
        if (pendingModal && pendingModal.landing === null) pendingModal.landing = window.location.hash;
    }

    /**
     * True when the page was reached from another page of this Jellyfin session (so Back stays in
     * Jellyfin); false for a page opened directly (a link, a bookmark, a reload of the first page).
     * jellyfin-web's router numbers its history entries (0: the first); an entry it didn't number
     * (a plain hash change) counts as in-app once Jellyfin has moved between pages since it loaded.
     * @returns {boolean} In-app.
     */
    function cameFromApp() {
        const idx = window.history.state?.idx;
        return typeof idx === 'number' ? idx > 0 : navigated;
    }

    /**
     * Jellyfin's Home, in place of a page that can't be shown (never leaving Jellyfin).
     * @returns {void}
     */
    function goHome() {
        try {
            if (typeof window.Emby?.Page?.goHome === 'function') {
                window.Emby.Page.goHome();
                return;
            }
        } catch { /* fall through */ }
        window.location.replace('#/home');
    }

    /**
     * True when the Requests & downloads request controls (the ledger, phase 3) run here.
     * @returns {boolean} On.
     */
    function requestsOn() {
        return JE.arrAsk?.enabled?.() === true;
    }

    /**
     * True when the details surface (status pill, Notify me, Manage, smart actions) runs here.
     * @returns {boolean} On.
     */
    function statusOn() {
        return JE.arrStatus?.enabled?.() === true;
    }

    /**
     * Request for the page's title. With the request feature on, a movie gets the shared mount
     * (Request / Ask {contact} / Search, the request sheet; its Notify me and its request state are left to
     * the details surface's button and status pill) and a series gets Get Season N and Request from the
     * smart actions. With it
     * off, Request opens the modal over the page, where Seerr's request choices live.
     * @param {Object} state Page state.
     * @param {Object} item Item DTO.
     * @returns {void}
     */
    function mountRequest(state, item) {
        const slot = requestSlot(state);
        if (!slot) return;
        const { parts } = state;
        if (requestsOn()) {
            if (parts.kind !== 'movie' || !JE.arrAskSheet?.mount) return;
            state.controls = JE.arrAskSheet.mount(slot, {
                key: state.key,
                kind: 'movie',
                name: item.Name,
                year: item.ProductionYear || undefined
            }, { notify: !statusOn(), state: !statusOn() });
            if (!statusOn()) {
                // Without the details surface nothing else reads the status: follow it here.
                JE.arrStatus?.fetchKey?.(state.key).then((data) => {
                    if (!state.aborted) state.controls?.update?.(data?.items?.[0] || null);
                }).catch(() => { /* the mount keeps Request */ });
            }
            return;
        }
        if (parts.kind !== 'movie' && parts.kind !== 'series') return;
        if (!JE.pluginConfig?.JellyseerrEnabled || typeof JE.jellyseerrMoreInfo?.open !== 'function') return;
        const b = pageButton('add', JE.t('jellyseerr_btn_request'), 'button-submit je-native-absent-legacy-request');
        b.addEventListener('click', (e) => {
            e.preventDefault();
            // The row's primary: a press a title action dispatched opens the window for its operation (D46S2-R6).
            openModal(parts.tmdbId, parts.kind === 'movie' ? 'movie' : 'tv', undefined, JE.ownerOf(e));
        });
        slot.appendChild(b);
    }

    /**
     * "Open": a copy the viewer can open has arrived while the page was shown. The page stays (with
     * whatever the request sheet holds); the button goes to the copy.
     * @param {Object} state Page state.
     * @param {string|null} itemId Library item id, or null to remove the button.
     * @returns {void}
     */
    function showOpen(state, itemId) {
        const slot = requestSlot(state);
        if (!slot) return;
        const existing = slot.querySelector('.je-native-absent-open');
        const valid = !!itemId && /^[0-9a-f-]{32,36}$/i.test(itemId) && !isSynthetic(itemId);
        if (!valid) {
            existing?.remove();
            return;
        }
        if (existing?.dataset.itemId === itemId) return;
        existing?.remove();
        const b = pageButton('play_arrow', JE.t('native_details_open'), 'button-submit je-native-absent-open');
        b.dataset.itemId = itemId;
        b.setAttribute('aria-label', JE.t('native_details_open_label', { name: state.item?.Name || '' }));
        b.addEventListener('click', (e) => {
            e.preventDefault();
            go(itemId);
        });
        slot.insertBefore(b, slot.firstChild);
    }

    /**
     * The details surface read this page's status (status-details calls this after each read):
     * a copy that arrived gets Open, and the movie's Request mount follows the status.
     * @param {HTMLElement} page Page.
     * @param {Object|null} status Status.
     * @returns {void}
     */
    function statusShown(page, status) {
        const state = current;
        if (!state || state.aborted || state.page !== page) return;
        // Kept for the Request mount, which may only be made after this read (the item is read first).
        state.status = status || null;
        // Keep the status block in this page's status slot (first: it may have gone into a dead copy's),
        // then the page's controls, and the smart actions in the row.
        const slot = state.container?.querySelector('.je-native-absent-status');
        if (slot) {
            page.querySelectorAll('.je-arr-status[data-je-arr-surface="details"]').forEach(n => {
                if (!slot.contains(n)) slot.appendChild(n);
            });
        }
        reconcile(state);
        showOpen(state, status?.openItemId || null);
        // The movie's Request mount follows the same status (asked, on its way, Search…).
        state.controls?.update?.(status || null);
    }

    /**
     * Smart actions a page shows outside the row (drawn before this page's controls existed) move
     * into the row's request controls (or, on a page without a row, into the status slot).
     * @param {Object} state Page state.
     * @returns {void}
     */
    function adoptActions(state) {
        const boxes = state.page.querySelectorAll('.je-ask-actions[data-je-ask-surface="details"]');
        boxes.forEach((n) => {
            if (state.primary) {
                // Drawn after the box the controls hold (while they were out of the row): it replaces it.
                if (!state.primary.contains(n) && state.page.contains(state.primary)) putActions(state, n, null);
            } else {
                const slot = state.container?.querySelector('.je-native-absent-status');
                if (slot && !slot.contains(n)) slot.appendChild(n);
            }
        });
    }

    /**
     * The modal's data for the title (Seerr through JE's proxy, the viewer's own rules), or null.
     * @param {Object} state Page state.
     * @returns {Promise<Object|null>} Details.
     */
    async function titleData(state) {
        const internal = JE.internals?.moreInfoModal;
        if (!JE.pluginConfig?.JellyseerrEnabled || typeof internal?.fetchMediaDetails !== 'function') return null;
        try {
            return await internal.fetchMediaDetails(state.parts.tmdbId, state.mediaType);
        } catch {
            return null;
        }
    }

    /**
     * The title's public details for the page's extras, from the server's native route (read with
     * Jellyfin Enhanced's own Seerr key under this page's rule, so viewers without a Seerr account get
     * them too; no per-account part), or null.
     * @param {Object} state Page state.
     * @param {string} [suffix] '' for the details, '/ratings' for the ratings.
     * @returns {Promise<Object|null>} Details or ratings.
     */
    async function nativeTitleData(state, suffix = '') {
        const path = `/native-details/title/${state.mediaType === 'movie' ? 'movie' : 'tv'}/${state.parts.tmdbId}${suffix}`;
        try {
            if (JE.core?.api?.plugin) return await JE.core.api.plugin(path, { skipCache: true });
            return await ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`JellyfinEnhanced${path}`), dataType: 'json' });
        } catch {
            return null;
        }
    }

    /**
     * Adds what the modal shows and the native layout has no place for: ratings (TMDB, IMDb, Rotten
     * Tomatoes, independent of MDBList), the information panel (production status, dates, revenue,
     * budget, original language, production countries, studios, streaming providers and the
     * external links), trailers and teasers, the movie's collection and Spoiler Guard's per-title
     * switch. Movie and series pages only. The modal's own builders render them, so both stay alike.
     * @param {Object} state Page state.
     * @returns {Promise<void>}
     */
    async function mountExtras(state) {
        const { parts, page } = state;
        if (parts.kind !== 'movie' && parts.kind !== 'series') return;
        const internal = JE.internals?.moreInfoModal;
        if (!internal?.buildRightPanel) return;
        const data = await nativeTitleData(state);
        if (!data || state.aborted || current !== state) return;
        const mediaType = state.mediaType;
        // A copy is offered by Open only (checked for this viewer by the server), never from Seerr's link.
        const shown = Object.assign({}, data, { mediaInfo: null });
        const releaseDate = mediaType === 'movie' ? data.releaseDate : data.firstAirDate;
        const extras = own(state, el('div', 'detailSection je-native-absent-extras'));
        extras.dataset.tmdbId = String(parts.tmdbId);
        let html = '';
        try {
            const trailers = internal.buildTrailersSection ? internal.buildTrailersSection(data) : '';
            if (trailers) html += `<div class="je-native-absent-trailers"><h2 class="sectionTitle sectionTitle-cards">${JE.escapeHtml(JE.t('jellyseerr_modal_trailers'))}</h2>${trailers}</div>`;
            html += `<div class="je-native-absent-info"><h2 class="sectionTitle sectionTitle-cards">${JE.escapeHtml(JE.t('native_details_information'))}</h2>`
                + internal.buildRightPanel(shown, mediaType, {
                    budget: data.budget ? internal.formatCurrency(data.budget) : null,
                    revenue: data.revenue ? internal.formatCurrency(data.revenue) : null,
                    releaseDate,
                    tmdbId: data.id
                }) + '</div>';
        } catch {
            return;
        }
        extras.innerHTML = html;
        // Spoiler Guard is in the action row (mountSpoiler); a page without a row keeps it here.
        if (!state.spoiler) {
            const spoiler = el('div', 'je-native-absent-spoiler');
            JE.internals?.spoilerGuard?.appendSeerrToggle?.(spoiler, data, mediaType);
            if (spoiler.childNodes.length) extras.prepend(spoiler);
        }
        extras.querySelector('.je-collection-card-button')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const btn = /** @type {HTMLElement} */ (e.currentTarget);
            const id = parseInt(btn.dataset.collectionId || '', 10);
            if (id && JE.jellyseerrUI?.showCollectionRequestModal) JE.jellyseerrUI.showCollectionRequestModal(id, btn.dataset.collectionName || '', null, { operation: e });
        });
        const host = page.querySelector('.detailPagePrimaryContent .detailSection') || page.querySelector('.detailPageContent');
        if (!host || state.aborted || current !== state) return;
        state.extras?.remove();
        state.extras = extras;
        host.appendChild(extras);
        // Ratings: the modal's endpoints and logos, under the controls.
        if (internal.buildRatingLogos) {
            // Series ratings are Rotten Tomatoes only, kept under `rt` as the modal does.
            const raw = await nativeTitleData(state, '/ratings');
            const ratings = raw && mediaType === 'tv' ? { rt: raw } : raw;
            if (state.aborted || current !== state) return;
            const mount = state.ratings;
            if (mount && ratings) {
                data.ratings = ratings;
                mount.innerHTML = internal.buildRatingLogos(ratings, data, mediaType, parts.tmdbId) || '';
                // Where JE's MDBList ratings sit on a library title: just above the external links.
                const links = page.querySelector('.detailPagePrimaryContent .itemExternalLinks');
                if (mount.innerHTML && links?.parentNode) links.insertAdjacentElement('beforebegin', mount);
            }
        }
    }

    /**
     * The page's Seerr status chips and download bars when the request feature is off (what the
     * modal shows above its Request button).
     * @param {Object} state Page state.
     * @param {Object|null} data Seerr details.
     * @returns {void}
     */
    function legacyStatus(state, data) {
        const internal = JE.internals?.moreInfoModal;
        const slot = state.container?.querySelector('.je-native-absent-status');
        const info = data?.mediaInfo;
        if (!slot || !info || !internal?.buildStatusChip || !JE.seerrStatus?.hasStatus) return;
        const status = info.status ?? 1;
        const status4k = info.status4k ?? 1;
        const downloads = info.downloadStatus || [];
        const downloads4k = info.downloadStatus4k || [];
        const row = el('div', 'je-native-absent-row je-native-absent-seerr');
        // Seerr's own library links are not used: Open (checked for this viewer) takes that place.
        if (JE.seerrStatus.hasStatus(status)) {
            const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, null, null, false);
            if (chip) row.appendChild(chip);
        }
        if (JE.seerrStatus.hasStatus(status4k) && JE.pluginConfig?.JellyseerrEnable4KRequests) {
            const chip = internal.buildStatusChip(status, status4k, true, downloads, downloads4k, null, null, true);
            if (chip) row.appendChild(chip);
        }
        if (row.childNodes.length) slot.appendChild(row);
        const bars = internal.buildDownloadBars?.(downloads, downloads4k);
        if (bars) slot.appendChild(bars);
    }

    /**
     * A person page: the department TMDB knows them for (the server gives it as the tagline), in
     * place of the native tagline.
     * @param {Object} state Page state.
     * @param {Object} item Item DTO.
     * @returns {void}
     */
    function showKnownFor(state, item) {
        const department = Array.isArray(item?.Taglines) ? String(item.Taglines[0] || '').trim() : '';
        if (state.parts.kind !== 'person' || !department || !state.container) return;
        state.container.querySelector('.je-native-absent-knownfor')?.remove();
        state.container.insertBefore(el('div', 'je-native-absent-knownfor', JE.t('native_details_known_for', { department })), state.container.firstChild);
    }

    /**
     * Loads the page's item (every view: a restored page is checked again) and adapts the page.
     * @returns {Promise<void>}
     */
    async function onView() {
        const id = idFromHash();
        const page = visiblePage();
        // Capability or admin switch off (or a 10.11 server): native pages stay exactly as they are.
        if (!available()) {
            // A page this module drew earlier, shown again (Back) after the setting was turned off.
            const restored = !!page?.classList.contains(PAGE_CLASS);
            page?.classList.remove(PAGE_CLASS, PERSON_CLASS);
            document.querySelectorAll(`.${LIST_CLASS}`).forEach(n => n.classList.remove(LIST_CLASS));
            unrefuse(null);
            checking(page, false);
            dispose();
            // A restored page of a title not in the library, after the setting was turned off: there is
            // no such page any more, so none of its earlier content stays on screen. (A fresh deep link is
            // Jellyfin's own: it answers that the item doesn't exist.)
            if (restored && id && parse(id)) {
                injectStyles();
                refuse(page);
            }
            return;
        }
        adaptListPage();
        const parts = id ? parse(id) : null;
        if (page) {
            page.classList.toggle(PAGE_CLASS, !!parts);
            page.classList.toggle(PERSON_CLASS, parts?.kind === 'person');
        }
        if (!parts || !page) {
            unrefuse(parts ? null : page);
            checking(page, false);
            dispose();
            return;
        }
        // A person page (or a genre/studio/network page opened as details) has no request key, status,
        // information panel or modal to fall back to.
        const isTitle = TITLE_KINDS.has(parts.kind);
        injectStyles();
        // The same page shown again (Back, restore): keep its controls, check it again.
        const same = current && current.id === id && current.page === page && document.contains(current.container || page);
        const state = same ? current : {
            id, parts, page, item: null, key: null, mediaType: parts.kind === 'movie' ? 'movie' : 'tv',
            controls: null, container: null, primary: null, spoiler: null, ratings: null, observer: null, rowObserver: null, extras: null,
            onKey: null, keyed: false, leadFocused: false, aborted: false, generation: 0, status: undefined, drawn: false,
            token: String(++tokens)
        };
        if (!same) {
            dispose();
            current = state;
            // Titles get their request controls in the native action row; a person page has none.
            state.primary = isTitle ? primaryOf(state) : null;
            state.container = actionsOf(state);
            if (state.primary && typeof MutationObserver === 'function') {
                // The controls redraw themselves (status changes, asks): each drawing gets the native look,
                // and smart actions taken away by any path take their cost lines with them.
                state.observer = new MutationObserver(() => syncRow(state));
                state.observer.observe(state.primary, { childList: true, subtree: true });
                // The action row itself can be replaced without a view event. Repair only disconnected
                // owned controls; our repair leaves them connected, so its own mutations are a no-op.
                state.rowObserver = new MutationObserver(() => {
                    if (state.aborted || current !== state) return;
                    if (!page.contains(state.primary) || state.hide && !page.contains(state.hide)
                        || state.spoiler && !page.contains(state.spoiler)) reconcile(state);
                });
                state.rowObserver.observe(page, { childList: true, subtree: true });
            }
            if (state.primary) {
                // A key pressed on the page (the remote moved the focus) keeps the focus where it went.
                state.onKey = () => { state.keyed = true; };
                document.addEventListener('keydown', state.onKey, true);
                markRow(state.primary);
            }
        }
        // Every look starts from the live controls only (copies and leftovers gone), and ends so too.
        reconcile(state);
        const generation = ++state.generation;
        let item = null;
        let status = 0;
        // A restored page still shows what it showed before (Back keeps the page's element, though
        // leaving it ended this module's state): hidden until the check below passes.
        if (same || page.dataset.jeNativeShown) checking(page, true);
        // Where this title opens for the viewer now: a copy that is already here wins, on a restored
        // page too (the title may have arrived since).
        const where = !isTitle ? Promise.resolve(null) : resolve({ id });
        try {
            item = await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
        } catch (err) {
            status = Number(err?.status || err?.response?.status || 0);
        }
        if (state.aborted || current !== state || generation !== state.generation) return;
        if (!item) {
            if (status === 404 || status === 403) {
                dispose();
                refuse(page, isTitle ? undefined : 'native_details_page_unavailable');
                return;
            }
            // Outage or an unusable page: back to where the user was, then the modal, once; a
            // second failure soon after says so on the page instead of leaving its spinner.
            checking(page, false);
            dispose();
            if (!isTitle) {
                // No modal shows a person: the page says it can't be loaded.
                refuse(page, 'native_details_page_failed');
                return;
            }
            if (fellBackFrom === id) {
                refuse(page, 'native_details_failed');
                return;
            }
            fellBackFrom = id;
            setTimeout(() => { if (fellBackFrom === id) fellBackFrom = null; }, FALLBACK_WINDOW_MS);
            if (cameFromApp()) {
                backThenModal(parts.tmdbId, state.mediaType);
            } else {
                // Opened from outside Jellyfin: Back would leave it (or do nothing). The page says it
                // couldn't load, and the modal opens over it once.
                refuse(page, 'native_details_failed');
                openModal(parts.tmdbId, state.mediaType, undefined, JE.NATIVE);
            }
            return;
        }
        unrefuse(page);
        state.item = item;
        const destination = await where;
        if (state.aborted || current !== state) return;
        if (destination?.itemId && !isSynthetic(destination.itemId) && /^[0-9a-f-]{32,36}$/i.test(destination.itemId)) {
            // A deep link to a title that is here now: its library page, in this page's place, by the one
            // arrival rule (status-arrival.js). While the viewer types, plays or has a dialog open it waits,
            // and this page is drawn meanwhile (with Open).
            const arrival = JE.internals?.arrStatusArrival;
            if (!arrival?.open || !arrival.busy()) {
                checking(page, false);
                dispose();
                if (!arrival?.open?.(page, id, destination.itemId)) go(destination.itemId, true);
                return;
            }
            arrival.open(page, id, destination.itemId);
        }
        checking(page, false);
        page.dataset.jeNativeShown = id;
        reconcile(state);
        // Drawn once per page state: a look that overlapped the first one (viewshow and the first look
        // on a fresh load, the first giving way to it) still draws the page.
        if (state.drawn) return;
        state.drawn = true;
        if (!isTitle) {
            showKnownFor(state, item);
            return;
        }
        state.key = keyOf(item, parts);
        mountRequest(state, item);
        mountSpoiler(state, item);
        // A status the details surface read before the mount existed: the mount starts from it.
        if (state.status !== undefined) state.controls?.update?.(state.status);
        if (!requestsOn() && (parts.kind === 'movie' || parts.kind === 'series')) {
            titleData(state).then((data) => { if (!state.aborted && current === state) legacyStatus(state, data); });
        }
        mountExtras(state).catch(() => { /* the native page stands on its own */ });
    }

    /**
     * Blocks native shortcuts that would act on a synthetic id: card context menus anywhere (a click
     * opens the card's page: a title, or a person's own page).
     * @param {Event} e Event.
     * @returns {void}
     */
    function guard(e) {
        if (!available() || e.type !== 'contextmenu') return;
        const target = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
        const card = target?.closest?.('[data-id]');
        if (!card || !parse(card.getAttribute('data-id'))) return;
        e.preventDefault();
        e.stopPropagation();
    }

    /**
     * Starts the page adapter (once).
     * @returns {void}
     */
    function start() {
        if (started) return;
        started = true;
        const run = () => { onView().catch(() => { /* the page keeps its native state */ }); };
        if (JE.core?.navigation?.onViewPage) {
            JE.core.navigation.onViewPage(run);
        } else {
            document.addEventListener('viewshow', run);
        }
        // A cold deep link or reload: the first look happens after load has settled.
        setTimeout(run, 350);
        const moved = () => { navigated = true; notePendingMove(); };
        if (JE.core?.navigation?.onNavigate) JE.core.navigation.onNavigate(moved);
        else window.addEventListener('hashchange', moved);
        JE.core?.navigation?.onNavigate?.(() => {
            if (parse(idFromHash())) return;
            unrefuse(null);
            dispose();
        });
        document.addEventListener('contextmenu', guard, true);
        window.addEventListener('je-spoiler-policy-changed', event => {
            const state = current;
            if (!state || event.detail?.type && (Number(event.detail?.tmdbId) !== state.parts.tmdbId || event.detail.type !== state.mediaType)) return;
            // Native fields are owned by jellyfin-web. Drop their old DOM before its fresh page read.
            state.page.replaceChildren();
            dispose();
            JE.internals.spoilerGuard?.scheduleFullReload?.();
        });
        JE.session?.onUserChange?.('native-details', () => { cancelPendingModal(); dispose(); });
    }

    JE.titleDetails = Object.freeze({ available, open, show, openKey, openModal, openItem: go, syntheticId, parse, isSynthetic });
    JE.internals = JE.internals || {};
    JE.internals.nativeDetails = { start, onView, dispose, guard, statusShown, placeActions, resolve, adaptListPage, current: () => current };
    start();
})(window.JellyfinEnhanced);
