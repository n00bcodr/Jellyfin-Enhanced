/**
 * @file Requests & downloads, phase 3: the Discover tab of the Requests page (#/requests?tab=discover)
 * for the JE request backend, and the title card it shares with the search page's "Not in your
 * library" row (ask-search.js). Rows: Trending, Coming soon, Popular TV and "Because you watched …",
 * read from GET /JellyfinEnhanced/acquire/discover (TMDB through the server, already filtered for the
 * caller: Kids only get titles within their parental limits). Each card shows the poster, title, year,
 * a state chip (In your library / Asked / Waiting for OK / Someone asked) and Request ("Ask {contact}"
 * for people whose asks wait for an OK) for movies; series get the request sheet when one is loaded
 * (JE.arrAskSheet), otherwise Notify me only. A card opens the Jellyfin item when the caller has it,
 * else Seerr's more-info window when Seerr is set up; otherwise only its buttons act.
 * Every row read carries an intent token (tab, row, filter, page, user epoch, sequence) and publishes
 * only while it is still the row's current one. The tab is offered to people who may ask
 * (JE.arrAsk.me().canRequest) in JE mode only; it plugs into the Requests page through its tab
 * tab list (JE.internals.arrHub.extraTabs). Exposes JE.internals.arrDiscover.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const D = JE.internals.arrDiscover = JE.internals.arrDiscover || {};
    const TAB = 'discover';
    const ROWS = [
        { id: 'trending', list: 'trending', type: 'movie', title: 'arr_discover_row_trending' },
        { id: 'upcoming', list: 'upcoming', type: 'movie', title: 'arr_discover_row_upcoming' },
        { id: 'popular_tv', list: 'popular', type: 'tv', title: 'arr_discover_row_popular_tv' },
        { id: 'because', list: 'because', type: 'movie', title: null }
    ];
    const logPrefix = '🪼 Jellyfin Enhanced: Discover:';
    /** How long the caller's capabilities are trusted before they are read again (in the background). */
    const CAPS_TTL_MS = 60000;

    const CSS = `
.je-discover { display: flex; flex-direction: column; gap: 1.6em; }
.je-discover-row[hidden] { display: none; }
.je-discover-row-title { font-size: 1.15em; font-weight: 600; margin: 0 0 0.6em; }
.je-discover-group + .je-discover-group { margin-top: 1.2em; }
.je-discover-strip { display: flex; gap: 0.9em; overflow-x: auto; padding: 0.3em 0.3em 0.7em; scroll-snap-type: x proximity; align-items: flex-start; }
.je-discover-card { flex: 0 0 10.5em; width: 10.5em; display: flex; flex-direction: column; gap: 0.4em; scroll-snap-align: start; color: inherit; }
.je-discover-poster-box { position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden;
  background: rgba(127,127,127,0.18); }
.je-discover-poster-box img { width: 100%; height: 100%; object-fit: cover; display: block; }
.je-discover-poster-empty { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 2.6em; opacity: 0.5; }
button.je-discover-poster-box { border: 0; padding: 0; margin: 0; cursor: pointer; font: inherit; color: inherit; }
.je-discover-name { font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
.je-discover-year { font-weight: 400; opacity: 0.7; margin-left: 0.3em; }
.je-discover-chip { display: inline-flex; align-items: center; gap: 0.25em; width: fit-content; font-size: 0.8em; font-weight: 700; line-height: 1.3;
  padding: 0.1em 0.55em; border-radius: 999px; border: 1px solid; }
.je-discover-chip .material-icons { font-size: 1.15em; }
.je-discover-chip-library { color: #2e9e4f; border-color: #2e9e4f; }
.je-discover-chip-asked { color: #3b82f6; border-color: #3b82f6; }
.je-discover-chip-waiting { color: #c27c0e; border-color: #c27c0e; }
.je-discover-chip-household { color: inherit; border-color: rgba(127,127,127,0.6); }
.je-discover-btn.je-discover-paused { color: #c27c0e; border-color: #c27c0e; background: rgba(194,124,14,0.1); }
.je-discover-actions { display: flex; flex-direction: column; gap: 0.4em; }
.je-discover-card .je-hub-btn, .je-discover-btn { font: inherit; font-weight: 600; font-size: 0.9em; display: inline-flex; align-items: center; justify-content: center;
  gap: 0.3em; min-height: 2.5em; width: 100%; box-sizing: border-box; padding: 0.3em 0.7em; border-radius: 8px; cursor: pointer; color: inherit;
  border: 1px solid rgba(127,127,127,0.55); background: rgba(127,127,127,0.12); }
.je-discover-card .je-hub-btn:hover, .je-discover-btn:hover { background: rgba(127,127,127,0.24); }
.je-discover-btn-primary { background: #6d4aff; border-color: #7c5cff; color: #fff; }
.je-discover-btn-primary:hover { background: #7d5dff; }
.je-discover-btn[disabled], .je-discover-btn[aria-busy="true"] { opacity: 0.75; cursor: progress; }
.je-discover-btn .material-icons, .je-discover-card .je-hub-btn .material-icons { font-size: 1.2em; }
.je-discover-card button:focus-visible, .layout-tv .je-discover-card button:focus, .je-discover-more:focus-visible, .layout-tv .je-discover-more:focus,
.je-discover-retry:focus-visible, .layout-tv .je-discover-retry:focus { outline: 3px solid #a78bfa; outline-offset: 2px; }
.je-discover-more { align-self: center; flex: 0 0 auto; width: auto; }
.je-discover-note { padding: 0.7em 1em; border-radius: 8px; background: rgba(127,127,127,0.12); display: flex; align-items: center; gap: 0.8em; flex-wrap: wrap; }
.je-discover-note .je-discover-btn { width: auto; }
@media (max-width: 600px) {
  .je-discover-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: visible; scroll-snap-type: none; padding: 0.2em 0; }
  .je-discover-card { width: auto; }
  .je-discover-card .je-hub-btn, .je-discover-btn { min-height: 44px; min-width: 44px; }
  .je-discover-more { grid-column: 1 / -1; width: 100%; }
}
.layout-tv .je-discover-card { flex-basis: 12em; width: 12em; }
.layout-tv .je-discover-card .je-hub-btn, .layout-tv .je-discover-btn { min-height: 3em; font-size: 1em; }
`;

    const state = {
        active: false,
        panel: null,
        caps: undefined,
        capsEpoch: null,
        capsAt: 0,
        capsLoading: false,
        /** @type {Map<string, Object>} row id -> { page, totalPages, results, groups, loaded, loading, error, token, controller } */
        rows: new Map(),
        seq: 0,
        listening: false
    };
    /** @type {WeakMap<HTMLElement, {card: Object, ctx: Object}>} */
    const cards = new WeakMap();

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * A material icon (decorative).
     * @param {string} name Icon.
     * @returns {HTMLElement} Icon.
     */
    function icon(name) {
        const i = el('span', 'material-icons', name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * The two-letter language for TMDB texts.
     * @returns {string} Language.
     */
    function language() {
        return (navigator.language || 'en').split('-')[0].toLowerCase();
    }

    /**
     * Adds the card and Discover styles once.
     * @returns {void}
     */
    function injectStyles() {
        if (document.getElementById('je-arr-discover-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-discover-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * A TMDB poster URL for a path from the server (validated there; checked again here).
     * @param {string} path Poster path.
     * @returns {string|null} URL.
     */
    function posterUrl(path) {
        return typeof path === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(path) ? `https://image.tmdb.org/t/p/w342${path}` : null;
    }

    /**
     * True when cards can open Seerr's more-info window (Seerr set up and the window loaded).
     * @returns {boolean} Seerr window available.
     */
    function seerrWindow() {
        return JE.pluginConfig?.JellyseerrEnabled === true && typeof JE.jellyseerrMoreInfo?.open === 'function';
    }

    /**
     * True when the card body opens something (the caller's Jellyfin copy, the native details page,
     * or Seerr's window).
     * @param {Object} card Card data.
     * @returns {boolean} Openable.
     */
    function openable(card) {
        return !!(card.inLibrary && card.itemId) || ((seerrWindow() || JE.titleDetails?.available?.() === true) && card.tmdbId > 0);
    }

    /**
     * Opens a card: the Jellyfin item when the caller has it, else the title's native details page
     * (when offered) or Seerr's more-info window.
     * @param {Object} card Card data.
     * @param {Object} owner The press's owner (JE.ownerOf(event), D46S2-R10-5): a title action's operation that pressed
     *     the poster, else the viewer's own; every effect below is its own, checked as it happens.
     * @returns {void}
     */
    function open(card, owner) {
        if (!JE.effectOwner(owner, 'a Discover poster')) return;
        if (card.inLibrary && card.itemId) {
            if (window.Emby?.Page?.showItem) window.Emby.Page.showItem(card.itemId);
            else window.location.hash = `#/details?id=${encodeURIComponent(card.itemId)}`;
            return;
        }
        if (!(card.tmdbId > 0)) return;
        const mediaType = card.kind === 'tv' ? 'tv' : 'movie';
        // The title's native details page when offered, else Seerr's window.
        if (JE.titleDetails?.open?.(card.tmdbId, mediaType, undefined, owner)) return;
        if (seerrWindow()) JE.jellyseerrMoreInfo.open(card.tmdbId, mediaType, undefined, owner);
    }

    /**
     * The state chip of a card: in the library, the caller's own ask, or someone else's.
     * @param {Object} card Card data.
     * @returns {HTMLElement|null} Chip.
     */
    function chip(card) {
        let kind = null;
        let text = '';
        let glyph = '';
        if (card.inLibrary) { kind = 'library'; text = tr('arr_discover_chip_library'); glyph = 'check_circle'; }
        else if (card.mine === 'asked') { kind = 'asked'; text = tr('arr_ask_chip_asked'); glyph = 'send'; }
        else if (card.mine === 'waiting') { kind = 'waiting'; text = tr('arr_ask_chip_waiting'); glyph = 'hourglass_empty'; }
        else if (card.requested) { kind = 'household'; text = tr('arr_ask_chip_household'); glyph = 'group'; }
        if (!kind) return null;
        const node = el('span', `je-discover-chip je-discover-chip-${kind}`);
        node.appendChild(icon(glyph));
        node.appendChild(el('span', null, text));
        return node;
    }

    /**
     * What the caller may still ask for from a card after their own ask: nothing more ({more:
     * false}), or more of it, with the copy a movie's sheet starts on (4K when only the standard
     * copy is asked for). A series always has more (other seasons, episodes, new ones; the sheet
     * leaves out the seasons already asked for); a movie has more while a copy the caller may ask
     * for is not asked for yet.
     * @param {Object} card Card data ({mine, mineVariants}).
     * @param {Object} caps Capabilities.
     * @returns {{more: boolean, again: boolean, variant?: string}} Whether a Request button stays.
     */
    function moreToAsk(card, caps) {
        const asked = card.mine === 'asked' || card.mine === 'waiting';
        if (!asked) return { more: true, again: false };
        if (card.kind === 'tv') return { more: true, again: true };
        const covered = Array.isArray(card.mineVariants) && card.mineVariants.length ? card.mineVariants : ['standard'];
        if (!covered.includes('standard')) return { more: true, again: true, variant: 'standard' };
        if (caps?.can4kMovies === true && !covered.includes('4k')) return { more: true, again: true, variant: '4k' };
        return { more: false, again: true };
    }

    /**
     * The Request / "Ask {contact}" button of a card, or null: none for titles the caller has or
     * already asked for in full (a partial ask keeps "Request more"), for people who may not ask, and
     * for series while no request sheet is loaded (asking for every season of a series is never the
     * right default). Series open the request sheet (it reads their seasons); movies go through the
     * sheet's one-tap rules (the sheet when 4K can be chosen, the allowance is nearly used or asks
     * wait for an OK). When the server marks the card's title as paused (`blocked`: the drive its standard
     * edition would land on, its own folder when Sonarr/Radarr has it, else the default root, is nearly full)
     * the button says so instead ("Paused: storage full") and opens the sheet, which says why (where and how
     * much is free for administrators) after checking that title. A 4K "Request more" is another instance's
     * drive: left to the sheet's own check.
     * @param {Object} card Card data.
     * @param {Object} ctx Context ({caps, surface}).
     * @param {HTMLElement} node The card.
     * @returns {HTMLElement|null} Button.
     */
    function requestButton(card, ctx, node) {
        const caps = ctx.caps;
        if (!(JE.arrAsk?.canAsk ? JE.arrAsk.canAsk(caps, card.kind === 'tv' ? 'series' : 'movie') : caps?.canRequest) || card.inLibrary) return null;
        const left = moreToAsk(card, caps);
        if (!left.more) return null;
        const series = card.kind === 'tv';
        // The server's answer for this very title (standard edition: its own folder's drive when the arr has it,
        // else the default root's). The 4K copy goes to another instance: the sheet checks that one.
        const block = left.variant !== '4k' && typeof card.blocked?.reason === 'string' ? card.blocked : null;
        const words = block && JE.arrAsk?.blockWords ? JE.arrAsk.blockWords(block, caps) : null;
        const sheetReady = typeof JE.arrAskSheet?.open === 'function';
        if (series && !sheetReady && !words) return null;
        const who = JE.arrAsk?.contact ? JE.arrAsk.contact(caps) : tr('arr_contact_default');
        const label = words ? words.chip
            : caps.asksFirst ? tr('arr_discover_ask_contact', { contact: who }) : left.again ? tr('arr_discover_request_more') : tr('arr_discover_request');
        // Paused: still a button (touch, keyboard and D-pad reach it) that opens the sheet, which says why in full
        // (where and how much is free for administrators) and checks this very title.
        const button = el('button', words ? 'je-discover-btn je-discover-paused' : 'je-discover-btn je-discover-btn-primary je-discover-request');
        button.type = 'button';
        button.dataset.jeFocus = `${ctx.surface}:request:${card.key}`;
        if (words) {
            button.title = words.detail || words.text;
            button.setAttribute('aria-label', `${words.chip}. ${words.detail || words.text}`);
        } else {
            button.setAttribute('aria-label', caps.asksFirst ? tr('arr_discover_ask_label', { contact: who, title: card.title })
                : tr(left.again ? 'arr_discover_request_more_label' : 'arr_discover_request_label', { title: card.title }));
        }
        button.appendChild(icon(words ? 'storage' : caps.asksFirst ? 'chat' : 'add'));
        const text = el('span', null, label);
        button.appendChild(text);
        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Busy, not disabled: a disabled button would drop keyboard / D-pad focus.
            if (button.getAttribute('aria-busy') === 'true') return;
            if (words && !sheetReady) {
                JE.arrAsk.toast(words.detail || words.text);
                return;
            }
            const sheet = JE.arrAskSheet;
            const title = { key: card.key, kind: series ? 'series' : 'movie', name: card.title, year: card.year ?? null, poster: card.poster ?? null };
            if (series && Array.isArray(card.mineSeasons)) title.askedSeasons = card.mineSeasons.slice();
            const operation = JE.ownerOf(e);
            // A press with no owner (a script's click) asks for nothing (D46S2-R11-1).
            if (!operation) return;
            const submitted = JE.captureSubmitted(operation);
            // The ask belongs to this click's session, through the sheet, the ask and what its answer shows.
            const origin = JE.core.userWrite.origin();
            const current = () => JE.core.userWrite.isBound(origin);
            const options = left.variant ? { opener: button, variant: left.variant, operation, origin } : { opener: button, operation, origin };
            button.setAttribute('aria-busy', 'true');
            if (!series && !words) text.textContent = tr('arr_ask_asking');
            let result = null;
            try {
                if (series || words) result = await sheet.open(title, options);
                else if (typeof sheet?.openOrAsk === 'function') result = await sheet.openOrAsk(title, options);
                else {
                    result = await JE.arrAsk.ask(JE.arrAsk.movieInput(card.key), { session: origin, bound: submitted.bound() });
                    if (!result.stale && current()) {
                        const allowance = result.state === 'quota' ? await JE.arrAsk.quota('movie') : null;
                        // The answer is a page effect (D46S2-R11-8): said only while the press's owner is current.
                        if (current() && submitted.current()) JE.arrAsk.toast(JE.arrAsk.describe(result, caps, allowance).text);
                    }
                }
            } catch (err) {
                result = { ok: false, state: 'failed' };
                if (current() && submitted.current()) JE.arrAsk.toast(JE.arrAsk.describe(result, caps, null).text);
            }
            if (result?.stale || !current()) return;
            if (applyResult(card, result)) {
                refreshEverywhere(card.key);
                return;
            }
            button.removeAttribute('aria-busy');
            text.textContent = label;
        });
        return button;
    }

    /**
     * Records an ask's answer on a card's data. True when the title is now asked for (the card
     * shows its chip; its Request button stays as "Request more" only while more can be asked
     * for); false for a refusal or failure.
     * @param {Object} card Card data.
     * @param {Object} result Result of JE.arrAsk.ask.
     * @returns {boolean} Asked.
     */
    function applyResult(card, result) {
        if (!result || !(result.ok || result.state === 'unknown')) return false;
        card.requested = true;
        if (result.state === 'waiting') card.mine = 'waiting';
        else if (result.state !== 'nothing') card.mine = 'asked';
        // What the ask covered (the sheet says which input it sent; a one-tap ask is the standard copy).
        const input = result.input || null;
        const variant = input?.variant === '4k' ? '4k' : 'standard';
        card.mineVariants = [...new Set([...(Array.isArray(card.mineVariants) ? card.mineVariants : []), variant])];
        if (variant === 'standard' && Array.isArray(input?.seasons) && ['seasons', 'future', 'next_season'].includes(input.scope)) {
            card.mineSeasons = [...new Set([...(Array.isArray(card.mineSeasons) ? card.mineSeasons : []), ...input.seasons])].sort((a, b) => a - b);
        }
        return true;
    }

    /**
     * Fills a card's chip and buttons from its data (again after a change), keeping keyboard / D-pad
     * focus on the card when the focused button went away.
     * @param {HTMLElement} node Card.
     * @returns {void}
     */
    function fill(node) {
        const entry = cards.get(node);
        if (!entry) return;
        const { card, ctx } = entry;
        const hadFocus = node.contains(document.activeElement);
        const focusId = hadFocus ? document.activeElement.closest('[data-je-focus]')?.dataset.jeFocus : null;
        const chipBox = node.querySelector('.je-discover-chip-box');
        chipBox.textContent = '';
        const c = chip(card);
        if (c) chipBox.appendChild(c);
        const actions = node.querySelector('.je-discover-actions');
        actions.textContent = '';
        const request = requestButton(card, ctx, node);
        if (request) actions.appendChild(request);
        if (!card.inLibrary && JE.arrNotify?.enabled?.() && JE.internals?.arrNotify?.rowButton) {
            JE.internals.arrNotify.rowButton({ key: card.key }, actions);
            const follow = actions.querySelector('.je-notify-follow');
            if (follow) follow.dataset.jeFocus = `${ctx.surface}:follow:${card.key}`;
        }
        if (hadFocus && !node.contains(document.activeElement)) {
            const target = [...node.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focusId)
                || node.querySelector('button') || node;
            target.focus({ preventScroll: true });
        }
    }

    /**
     * Brings every card of a title on the page in line with its data (the same title can be on
     * several rows, and the search row too).
     * @param {string} key Title key.
     * @returns {void}
     */
    function refreshEverywhere(key) {
        document.querySelectorAll('.je-discover-card').forEach((node) => {
            if (node.dataset.key === key) fill(node);
        });
    }

    /**
     * One title card (shared with the search row).
     * @param {Object} card Card data from the server ({key, kind, tmdbId, title, year, poster, inLibrary, itemId, requested, mine}).
     * @param {{caps: Object|null, surface: string}} ctx The caller's capabilities and the surface (discover, search).
     * @returns {HTMLElement} Card.
     */
    function buildCard(card, ctx) {
        injectStyles();
        const node = el('div', 'je-discover-card');
        // Focus can rest on the card itself when the button that had it goes (after asking), and finds
        // the same card again when the row or the page is redrawn (its focus id).
        node.tabIndex = -1;
        node.dataset.jeFocus = `${ctx.surface}:card:${card.key}`;
        node.dataset.key = card.key;
        node.dataset.jeArrKey = card.key;
        const year = card.year ? String(card.year) : '';
        const src = posterUrl(card.poster);
        const posterBox = openable(card) ? el('button', 'je-discover-poster-box') : el('div', 'je-discover-poster-box');
        if (posterBox.tagName === 'BUTTON') {
            posterBox.type = 'button';
            posterBox.dataset.jeFocus = `${ctx.surface}:open:${card.key}`;
            posterBox.setAttribute('aria-label', tr('arr_discover_open_label', { title: year ? `${card.title} (${year})` : card.title }));
            posterBox.addEventListener('click', (e) => {
                e.preventDefault();
                open(card, JE.ownerOf(e));
            });
        }
        if (src) {
            const img = el('img');
            img.src = src;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            posterBox.appendChild(img);
        } else {
            const empty = el('span', 'je-discover-poster-empty');
            empty.appendChild(icon(card.kind === 'tv' ? 'tv' : 'movie'));
            posterBox.appendChild(empty);
        }
        node.appendChild(posterBox);
        const name = el('div', 'je-discover-name');
        const bdi = el('bdi', null, card.title || '');
        name.appendChild(bdi);
        if (year) name.appendChild(el('span', 'je-discover-year', year));
        node.appendChild(name);
        node.appendChild(el('div', 'je-discover-chip-box'));
        node.appendChild(el('div', 'je-discover-actions'));
        const hide = JE.hiddenContent?.buildTitleControl?.({ ...card, type: card.kind, tmdbId: card.tmdbId, name: card.title }, {
            surface: ctx.surface === 'search' ? 'search' : 'discovery'
        });
        if (hide) node.appendChild(hide);
        cards.set(node, { card, ctx });
        fill(node);
        listen();
        return node;
    }

    /**
     * Follows asks made anywhere on the page (season rows, the request sheet, another card) and
     * follow-state changes, once.
     * @returns {void}
     */
    function listen() {
        if (state.listening || !JE.arrAsk?.onChange) return;
        state.listening = true;
        JE.arrAsk.onChange((detail) => {
            if (detail?.type !== 'ask' || !detail.key) return;
            document.querySelectorAll('.je-discover-card').forEach((node) => {
                const entry = cards.get(node);
                if (!entry || node.dataset.key !== detail.key) return;
                if (applyResult(entry.card, detail.input && detail.result ? { ...detail.result, input: detail.input } : detail.result)) fill(node);
            });
        });
    }

    // ------------------------------------------------------------------ capabilities

    /**
     * The caller's request capabilities for this session: undefined while not known yet.
     * @returns {Object|null|undefined} Capabilities.
     */
    function currentCaps() {
        return state.capsEpoch === epoch() ? state.caps : undefined;
    }

    /**
     * Asks the server for the caller's capabilities (again after a minute: a role can change); when
     * they arrive changed, the Requests page redraws its tabs (and the Discover tab itself, when it is
     * the one asked for).
     * @returns {void}
     */
    function ensureCaps() {
        if (state.capsLoading || !JE.arrAsk?.me) return;
        state.capsLoading = true;
        const started = epoch();
        JE.arrAsk.me().then((caps) => {
            state.capsLoading = false;
            if (started !== epoch()) return;
            const changed = state.capsEpoch !== started || JSON.stringify(state.caps) !== JSON.stringify(caps || null);
            state.caps = caps || null;
            state.capsEpoch = started;
            state.capsAt = Date.now();
            if (!changed) return;
            H.renderTabs?.();
            if (H.state?.visible && H.state.tab === TAB) H.selectTab?.(TAB);
        }, () => {
            state.capsLoading = false;
        });
    }

    /**
     * True when the Discover tab is offered: JE mode, and the caller may ask for titles.
     * @returns {boolean} Available.
     */
    function available() {
        if (!JE.arrAsk?.enabled?.()) return false;
        const caps = currentCaps();
        if (caps === undefined) {
            ensureCaps();
            return false;
        }
        if (Date.now() - state.capsAt > CAPS_TTL_MS) ensureCaps();
        return !!(caps && caps.canRequest && caps.backend === 'je');
    }

    /**
     * True while it isn't known yet whether the tab is offered (the page keeps ?tab=discover).
     * @returns {boolean} Pending.
     */
    function pending() {
        return !!JE.arrAsk?.enabled?.() && currentCaps() === undefined;
    }

    // ------------------------------------------------------------------ rows

    /**
     * A new intent token for a row read: tab, row, filter, page, user epoch and a sequence number.
     * @param {Object} row Row definition.
     * @param {number} page Page.
     * @returns {Object} Token.
     */
    function intent(row, page) {
        state.seq += 1;
        return Object.freeze({ tab: TAB, row: row.id, query: '', filter: `${row.list}:${row.type}`, page, epoch: epoch(), seq: state.seq });
    }

    /**
     * True while a token is still the row's current read (same visit, same user, not replaced).
     * @param {string} rowId Row id.
     * @param {Object} token Token.
     * @returns {boolean} Current.
     */
    function current(rowId, token) {
        const entry = state.rows.get(rowId);
        return state.active && !!entry && entry.token === token && token.epoch === epoch();
    }

    /**
     * The state of a row (created on first use).
     * @param {string} rowId Row id.
     * @returns {Object} Row state.
     */
    function rowState(rowId) {
        let entry = state.rows.get(rowId);
        if (!entry) {
            entry = { page: 0, totalPages: 1, results: [], groups: null, loaded: false, loading: false, error: false, token: null, controller: null };
            state.rows.set(rowId, entry);
        }
        return entry;
    }

    /**
     * Reads one page of a row. Only the newest read of a row may publish (or fail) into it; an
     * older one still on its way is aborted and its answer dropped.
     * @param {Object} row Row definition.
     * @param {number} page Page.
     * @returns {Promise<void>}
     */
    async function load(row, page) {
        const entry = rowState(row.id);
        const token = intent(row, page);
        entry.controller?.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        entry.token = token;
        entry.controller = controller;
        entry.loading = true;
        entry.error = false;
        paint(row);
        let answer;
        try {
            answer = await JE.arrAsk.call(`/acquire/discover?list=${encodeURIComponent(row.list)}&type=${encodeURIComponent(row.type)}&page=${page}&language=${encodeURIComponent(language())}`,
                { signal: controller?.signal });
        } catch (err) {
            if (!current(row.id, token)) return;
            console.warn(`${logPrefix} could not load the ${row.id} row (${err?.message || err})`);
            answer = null;
        }
        if (!current(row.id, token)) return;
        entry.loading = false;
        entry.controller = null;
        const body = answer?.status === 200 ? answer.body?.answer : null;
        if (!body) {
            entry.error = true;
            paint(row);
            return;
        }
        if (row.list === 'because') {
            entry.groups = Array.isArray(body.groups) ? body.groups : [];
        } else {
            const results = Array.isArray(body.results) ? body.results : [];
            if (page === 1) entry.results = results;
            else {
                const known = new Set(entry.results.map(c => c.key));
                entry.results = entry.results.concat(results.filter(c => !known.has(c.key)));
            }
            entry.page = page;
            entry.totalPages = Number(body.totalPages) || 1;
        }
        entry.loaded = true;
        paint(row);
    }

    /**
     * A strip of cards.
     * @param {Object[]} list Cards.
     * @returns {HTMLElement} Strip.
     */
    function strip(list) {
        const box = el('div', 'je-discover-strip');
        const ctx = { caps: currentCaps() || null, surface: TAB };
        for (const card of list) box.appendChild(buildCard(card, ctx));
        return box;
    }

    /**
     * Redraws one row from its state (hidden while it has nothing to show), keeping focus inside it.
     * @param {Object} row Row definition.
     * @returns {void}
     */
    function paint(row) {
        const section = state.panel?.querySelector(`[data-je-discover-row="${row.id}"]`);
        if (!section) return;
        const entry = rowState(row.id);
        const focus = section.contains(document.activeElement) ? document.activeElement.closest('[data-je-focus]')?.dataset.jeFocus : null;
        section.textContent = '';
        if (row.list === 'because') {
            const groups = (entry.groups || []).filter(g => Array.isArray(g.results) && g.results.length);
            section.hidden = groups.length === 0;
            for (const group of groups) {
                const box = el('div', 'je-discover-group');
                box.appendChild(el('h2', 'je-discover-row-title', tr('arr_discover_row_because', { title: group.basedOn || '' })));
                box.appendChild(strip(group.results));
                section.appendChild(box);
            }
        } else {
            section.appendChild(el('h2', 'je-discover-row-title', tr(row.title)));
            if (entry.error && !entry.results.length) {
                section.hidden = false;
                section.appendChild(note(tr('arr_discover_error'), () => load(row, 1)));
            } else if (!entry.loaded) {
                section.hidden = false;
                section.appendChild(el('div', 'je-discover-note', tr('arr_discover_loading')));
            } else if (!entry.results.length) {
                section.hidden = true;
            } else {
                section.hidden = false;
                const box = strip(entry.results);
                if (entry.page < Math.min(entry.totalPages, 10)) {
                    const more = el('button', 'je-discover-btn je-discover-more');
                    more.type = 'button';
                    more.dataset.jeFocus = `${TAB}:more:${row.id}`;
                    more.textContent = tr(entry.loading ? 'arr_discover_loading' : entry.error ? 'arr_discover_retry' : 'arr_discover_more');
                    more.disabled = entry.loading;
                    more.addEventListener('click', () => load(row, entry.page + 1));
                    box.appendChild(more);
                }
                section.appendChild(box);
            }
        }
        if (focus != null && !section.contains(document.activeElement)) {
            const target = [...section.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === focus) || section.querySelector('button');
            target?.focus({ preventScroll: true });
        }
    }

    /**
     * A note with a Retry button.
     * @param {string} text Text.
     * @param {Function} retry Retry action.
     * @returns {HTMLElement} Note.
     */
    function note(text, retry) {
        const box = el('div', 'je-discover-note', text);
        const button = el('button', 'je-discover-btn je-discover-retry', tr('arr_discover_retry'));
        button.type = 'button';
        button.addEventListener('click', retry);
        box.appendChild(button);
        return box;
    }

    /**
     * Renders the Discover tab into the Requests page's panel; rows already read this visit are
     * drawn from memory, the others are read now.
     * @param {HTMLElement} panel Tab panel.
     * @returns {void}
     */
    function render(panel) {
        injectStyles();
        state.active = true;
        state.panel = panel;
        const root = el('div', 'je-discover');
        panel.appendChild(root);
        for (const row of ROWS) {
            const section = el('section', 'je-discover-row');
            section.dataset.jeDiscoverRow = row.id;
            root.appendChild(section);
            const entry = rowState(row.id);
            if (entry.loaded || entry.loading) paint(row);
            else load(row, 1);
        }
    }

    /**
     * Leaves the tab: reads still on their way are aborted and dropped; the rows are read again on
     * the next visit.
     * @returns {void}
     */
    function leave() {
        state.active = false;
        state.panel = null;
        for (const entry of state.rows.values()) entry.controller?.abort();
        state.rows.clear();
    }

    JE.session?.onUserChange?.('arr-discover', () => {
        state.caps = undefined;
        state.capsEpoch = null;
        state.capsAt = 0;
        state.capsLoading = false;
        leave();
    });

    H.extraTabs = H.extraTabs || [];
    H.extraTabs.push(Object.freeze({ id: TAB, label: 'arr_discover_tab', after: 'own', visible: () => (available() ? true : pending() ? 'pending' : false), render, leave }));

    D.buildCard = buildCard;
    D.injectStyles = injectStyles;
    D.applyResult = applyResult;
    D.posterUrl = posterUrl;
})(window.JellyfinEnhanced);
