/**
 * @file Requests & downloads, phase 3: the request sheet and the mountable request controls.
 *
 * The sheet is a bottom sheet on phones (≤ 600 px), a centred dialog on desktop and a full-screen,
 * focus-trapped panel on TV. Movies usually skip it: {@link openOrAsk} asks with one tap and a
 * toast, and opens the sheet only when the caller's quota is nearly used, their asks wait for an
 * OK, or they may choose 4K. For series it offers large toggle cards (Everything / Just the latest
 * season / Next season only / Pick seasons… / Pick episodes… / Just new episodes from now on), each
 * with its cost from the quota projection. Over quota in JE mode the primary button becomes "Send to
 * {contact} for an OK" (the server records it as waiting); in Seerr mode the honest quota words are
 * shown and nothing is sent. Every ask goes through JE.arrAsk.ask (retry-safe clientRequestId); a
 * double tap is one request. Family members never see servers, profiles, folders or tags.
 *
 * API (JE.arrAskSheet):
 *   open(title, options?) → Promise<result|null>
 *     title = { key, kind: 'movie'|'series', name, year?, poster? (TMDB path '/x.jpg' or a Jellyfin
 *       image URL), seasons?: [{season, episodes, have, status?}], latestSeason?, nextSeason?,
 *       askedSeasons?: number[] (seasons the caller already asked for in the standard copy) }
 *     options = { opener?: HTMLElement (focus returns there), variant?: 'standard'|'4k' }
 *     Resolves with the JE.arrAsk.ask result (plus the `input` asked for) once an ask is recorded (the
 *     sheet then closes and a toast says what happened), or null when the sheet is closed without
 *     one. A refused ask keeps the sheet open with the reason.
 *     `have` counts the copies in the library, whatever their quality: it marks seasons complete for
 *     the standard copy only (for 4K nothing is known to be here, so every season stays offered).
 *     options.fixed (phase 4c3a, list entries) = { scope: string (what is asked for, e.g. "Season 2"), input: Object
 *       (anything truthy: the scope is fixed), cost?: number (the preview's), note?: string (what the list's preview
 *       says), send: () =>
 *       Promise<JE.arrAsk result> } shows no scope cards and no Standard/4K toggle (the entry fixes both) and sends
 *       through `send` (the list's own request route) instead of JE.arrAsk.ask.
 *     options.listTicket binds a fixed sheet (including its loaders and later writes) to the originating list page.
 *   openOrAsk(title, options?) → Promise<result|null>   movies: one tap unless the sheet is needed.
 *   close() → void   closes the sheet (its promise resolves with null).
 *
 * Request controls mount API (for pages that show a title JE draws itself):
 *   const controls = JE.arrAskSheet.mount(container, { key, kind, name, year, poster, seasons }, { notify, state });
 *   controls.update(status);   // the title's status (JE.arrStatus item) or null when unknown
 *   controls.destroy();        // removes everything and stops listening
 *   Renders Request (or "Ask {contact}" when the caller's asks wait for an OK), Notify me (when
 *   JE.arrNotify offers following the key, unless options.notify is false because the page has its
 *   own Notify me button) and the current request state into the container (unless options.state is false
 *   because the page shows the title's status pill, which says the same: then the controls give way to it); a
 *   title missing for a long while (JE.arrStatus.searchable) gets Search instead (an administrator's
 *   runs the arr's search at once). The title is checked first (JE.arrAsk.check, once per title, the controls
 *   wait for it): when it can't be asked for now (e.g. "Paused: storage full", its drive is nearly full) the
 *   Request reads so and opens the sheet, which says why; a family Search gives way to the paused line, and an
 *   administrator's Search stays with that line next to it (where and how much is free). Nothing is rendered when the request feature is
 *   off; Watchers get Notify me only. The sheet itself says when a title can't be asked for now
 *   (JE.arrAsk.check) and then offers nothing to send.
 */
(function (JE) {
    'use strict';

    const TMDB_IMAGE = /^\/[A-Za-z0-9_.-]{1,80}$/;
    /** Episodes a season list offers at most (the server caps an ask at 1000). */
    const MAX_EPISODES = 200;
    const STAGES_REQUESTABLE = new Set(['notHere', 'none']);

    /** @type {Object|null} the open sheet's state */
    let current = null;
    /** Pending sheet loaders cancelled by close or by their originating page. */
    const pendingOpens = new Set();
    /** @type {Map<string, Promise<Object|null>>} one-tap movie asks in flight, by key */
    const inflight = new Map();

    /**
     * Translates (shared helper).
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
     * @param {string} name Icon name.
     * @param {string} [cls] Extra class.
     * @returns {HTMLElement} Icon.
     */
    function icon(name, cls) {
        const i = el('span', `material-icons${cls ? ' ' + cls : ''}`, name);
        i.setAttribute('aria-hidden', 'true');
        return i;
    }

    /**
     * A plain button.
     * @param {string} cls Classes.
     * @param {string} [text] Text.
     * @returns {HTMLButtonElement} Button.
     */
    function button(cls, text) {
        const b = el('button', cls, text);
        b.type = 'button';
        return b;
    }

    /**
     * True on the TV layout.
     * @returns {boolean} TV.
     */
    function isTv() {
        return document.documentElement.classList.contains('layout-tv') || !!document.body?.classList.contains('layout-tv');
    }

    /**
     * Injects the styles and says whether the page is light-themed.
     * @returns {boolean} Light theme.
     */
    function prepareStyles() {
        const styles = JE.internals?.arrAskSheetStyles;
        styles?.ensure?.();
        return !!styles?.isLight?.();
    }

    /**
     * A poster URL: a TMDB path becomes a TMDB image URL; anything else must be an http(s) URL
     * (a Jellyfin image URL). Null otherwise.
     * @param {string|undefined} poster Poster.
     * @returns {string|null} URL.
     */
    function posterUrl(poster) {
        if (typeof poster !== 'string' || !poster) return null;
        if (TMDB_IMAGE.test(poster)) return `https://image.tmdb.org/t/p/w154${poster}`;
        try {
            const url = new URL(poster, window.location.href);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------ costs

    /**
     * True when the quota projection is complete and limited (a cost line makes sense).
     * @param {Object|null} quota Quota ({limit, remaining, available}).
     * @returns {boolean} Limited.
     */
    function limited(quota) {
        return !!quota && quota.available !== false && typeof quota.limit === 'number' && typeof quota.remaining === 'number';
    }

    /**
     * What a number of single episodes costs: the first free ones nothing, then one per five.
     * @param {number} count Episodes.
     * @param {number} [free] Free episodes per window.
     * @returns {number} Requests used.
     */
    function episodeCost(count, free) {
        const f = Math.max(0, Number.isFinite(free) ? free : 5);
        return count <= f ? 0 : Math.ceil((count - f) / 5);
    }

    /**
     * What an ask costs (requests of the caller's allowance). Single episodes cost what they add to
     * the ones already charged in the window (the quota's `episodes`), as the server charges them.
     * @param {{scope: string, seasons?: number[], episodes?: Array}} input Mutation input.
     * @param {Object|null} caps Capabilities (free episodes).
     * @param {Object|null} [quota] Quota (episodes already charged in the window).
     * @returns {number} Cost.
     */
    function costOf(input, caps, quota) {
        switch (input?.scope) {
            case 'movie':
            case 'next_season':
            case 'future': return 1;
            case 'seasons': return (input.seasons || []).length;
            case 'episodes': {
                const before = Number.isInteger(quota?.episodes) && quota.episodes > 0 ? quota.episodes : 0;
                return episodeCost(before + (input.episodes || []).length, caps?.freeEpisodes) - episodeCost(before, caps?.freeEpisodes);
            }
            default: return 0;
        }
    }

    /**
     * The cost line of a choice ("Uses 2 of your 4 this week"), or '' when the allowance is unlimited
     * or unknown.
     * @param {Object} input Mutation input.
     * @param {Object|null} caps Capabilities.
     * @param {Object|null} quota Quota.
     * @returns {{text: string, over: boolean}} Line.
     */
    function costLine(input, caps, quota) {
        if (!limited(quota)) return { text: '', over: false };
        const cost = costOf(input, caps, quota);
        const left = quota.remaining;
        if (input.scope === 'episodes' && cost === 0) return { text: tr('arr_sheet_cost_free', { free: caps?.freeEpisodes ?? 5 }), over: false };
        if (cost > left) {
            if (caps?.backend === 'seerr') return { text: quotaText(quota), over: true };
            // "only 0 left" reads oddly: none left says it plainly.
            return { text: tr(left > 0 ? 'arr_sheet_cost_over' : 'arr_sheet_cost_over_none', { contact: JE.arrAsk.contact(caps), left }), over: true };
        }
        if (input.scope === 'future') return { text: tr('arr_sheet_cost_future', { left }), over: false };
        return { text: tr('arr_sheet_cost', { cost, left }), over: false };
    }

    /**
     * "You've used this week's requests · next one frees up Thu."
     * @param {Object|null} quota Quota.
     * @returns {string} Text.
     */
    function quotaText(quota) {
        const day = quota?.nextSlotAt ? JE.arrStatus.formatDate(quota.nextSlotAt) : '';
        return day ? tr('arr_ask_toast_quota_day', { day }) : tr('arr_ask_toast_quota');
    }

    /**
     * True when a movie needs the sheet rather than one tap: the quota is nearly used, the caller's
     * asks wait for an OK, or they may choose 4K.
     * @param {Object} caps Capabilities.
     * @param {Object|null} quota Quota.
     * @param {'movie'|'series'} kind Kind.
     * @returns {boolean} Sheet needed.
     */
    function needsSheet(caps, quota, kind) {
        if (caps?.asksFirst) return true;
        if (kind === 'movie' ? caps?.can4kMovies : caps?.can4kSeries) return true;
        return limited(quota) && quota.remaining <= 1;
    }

    // ------------------------------------------------------------------ series choices

    /**
     * The seasons a series sheet offers (specials left out), in order, for one copy: `have` (the
     * library's episodes, whatever their quality) and `asked` (the caller's own standard asks) speak
     * for the standard copy only; for 4K nothing is known to be here or asked for.
     * @param {Object} title Title.
     * @param {string} [variant] 'standard' (default) or '4k'.
     * @returns {Array<{season: number, episodes: number, have: number, asked: boolean, status?: string}>} Seasons.
     */
    function seasonsOf(title, variant) {
        const standard = variant !== '4k';
        const asked = new Set(standard && Array.isArray(title?.askedSeasons) ? title.askedSeasons : []);
        return (Array.isArray(title?.seasons) ? title.seasons : [])
            .filter(s => Number.isInteger(s?.season) && s.season > 0)
            .map(s => ({
                season: s.season,
                episodes: Math.max(0, Number(s.episodes) || 0),
                have: standard ? Math.max(0, Number(s.have) || 0) : 0,
                asked: asked.has(s.season),
                status: s.status
            }))
            .sort((a, b) => a.season - b.season);
    }

    /**
     * True when every episode of a season is here.
     * @param {{episodes: number, have: number}} s Season.
     * @returns {boolean} Complete.
     */
    function complete(s) {
        return s.episodes > 0 && s.have >= s.episodes;
    }

    /**
     * True when a season has nothing left to ask for (all here, or already asked for).
     * @param {{episodes: number, have: number, asked?: boolean}} s Season.
     * @returns {boolean} Nothing to ask for.
     */
    function settled(s) {
        return complete(s) || !!s.asked;
    }

    /**
     * The series cards: each with its id, icon, label and the mutation input it asks for (null for
     * the pickers until something is picked), for one copy. "Just new episodes from now on" in Seerr mode too:
     * Seerr doesn't follow new seasons itself, so Jellyfin Enhanced asks Seerr for each one as it starts.
     * Seerr mode: no "Pick episodes…" (Seerr takes whole seasons); with Seerr's partial requests off, one card for
     * the whole series (every season, whatever is here: Seerr leaves out what it already has). One season at a time
     * (the administrator's option): no "Everything" for more than one season, and "Pick seasons…" takes one.
     * @param {Object} title Title.
     * @param {string} [variant] 'standard' (default) or '4k'.
     * @param {Object|null} [caps] Capabilities (backend).
     * @returns {Array<{id: string, icon: string, label: string, input: Function}>} Cards.
     */
    function seriesCards(title, variant, caps) {
        const seasons = seasonsOf(title, variant);
        const wanted = seasons.filter(s => !settled(s)).map(s => s.season);
        const latest = Number.isInteger(title.latestSeason) ? title.latestSeason : (seasons.length ? seasons[seasons.length - 1].season : null);
        const latestEntry = seasons.find(s => s.season === latest);
        const cards = [];
        if (JE.arrAsk.wholeSeriesOnly?.(caps)) {
            const all = seasons.map(s => s.season);
            if (wanted.length) {
                cards.push({
                    id: 'everything', icon: 'library_add',
                    label: all.length === 1 ? tr('arr_sheet_card_series_one') : tr('arr_sheet_card_series', { n: all.length }),
                    input: (variant) => JE.arrAsk.seasonsInput(title.key, all, variant)
                });
            }
            return cards;
        }
        if (wanted.length && !(wanted.length > 1 && JE.arrAsk.singleSeasonOnly?.(caps))) {
            cards.push({
                id: 'everything', icon: 'library_add',
                label: wanted.length === 1 ? tr('arr_sheet_card_everything_one') : tr('arr_sheet_card_everything', { n: wanted.length }),
                input: (variant) => JE.arrAsk.seasonsInput(title.key, wanted, variant)
            });
        }
        if (latest != null && !(latestEntry && settled(latestEntry)) && wanted.length !== 1) {
            cards.push({ id: 'latest', icon: 'filter_1', label: tr('arr_sheet_card_latest'), input: (variant) => JE.arrAsk.seasonsInput(title.key, [latest], variant) });
        }
        const nextEntry = seasons.find(s => s.season === title.nextSeason);
        if (Number.isInteger(title.nextSeason) && title.nextSeason > 0 && !(nextEntry && settled(nextEntry))) {
            cards.push({ id: 'next', icon: 'skip_next', label: tr('arr_sheet_card_next'), input: (variant) => ({ ...JE.arrAsk.seasonsInput(title.key, [title.nextSeason], variant), scope: 'next_season' }) });
        }
        if (seasons.length > 1) cards.push({ id: 'pick', icon: 'checklist', label: tr('arr_sheet_card_pick'), input: null });
        if (seasons.some(s => s.episodes > 0) && !JE.arrAsk.seasonsOnly?.(caps)) cards.push({ id: 'episodes', icon: 'format_list_numbered', label: tr('arr_sheet_card_episodes'), input: null });
        if (latest != null) {
            cards.push({ id: 'future', icon: 'update', label: tr('arr_sheet_card_future'), input: (variant) => ({ ...JE.arrAsk.seasonsInput(title.key, [latest], variant), scope: 'future' }) });
        }
        return cards;
    }

    // ------------------------------------------------------------------ the sheet

    /**
     * The seasons of a series given without them (search and Discover cards name only the title):
     * read through JE's TMDB proxy for a TMDB key; null when they can't be had.
     * @param {Object} title Series title.
     * @returns {Promise<Object|null>} The title with seasons, or null.
     */
    async function withSeasons(title) {
        if (Array.isArray(title.seasons)) return title;
        const id = /^tv:tmdb:(\d{1,10})$/.exec(String(title.key))?.[1] ?? title.tmdbId;
        const tmdb = await JE.arrAsk.tmdbSeasons(id);
        if (!tmdb.seasons.length && tmdb.upcoming == null) return null;
        return {
            ...title,
            seasons: tmdb.seasons,
            latestSeason: Number.isInteger(title.latestSeason) ? title.latestSeason : tmdb.latest,
            nextSeason: Number.isInteger(title.nextSeason) ? title.nextSeason : tmdb.upcoming
        };
    }

    /**
     * Opens the request sheet for a title (closing any other). A series given without its seasons
     * has them read first.
     * @param {Object} title Title (see the file comment).
     * @param {{opener?: HTMLElement, variant?: string, caps?: Object, quota?: Object|null}} [options] Options.
     * @returns {Promise<Object|null>} The ask result, or null when closed without one.
     */
    async function open(title, options) {
        if (!JE.arrAsk?.enabled() || !title?.key) return null;
        const listTicket = options?.fixed ? options?.listTicket : null;
        const opener = options?.opener || document.activeElement;
        const kind = title.kind === 'movie' ? 'movie' : 'series';
        const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
        let cancelled = false;
        let state = null;
        let stop;
        const stopped = new Promise(resolve => { stop = resolve; });
        /** Cancels loaders promptly and removes an already displayed sheet. */
        const cancel = () => {
            cancelled = true;
            stop(null);
            if (state) finish(state, null);
        };
        const off = listTicket?.onRevoke(cancel);
        const live = () => !cancelled && (!listTicket || listTicket.current()) && (JE.session?.getEpoch ? JE.session.getEpoch() : 0) === epoch;
        pendingOpens.add(cancel);
        try {
            if (!live()) return null;
            const caps = await Promise.race([options?.caps || JE.arrAsk.me(), stopped]);
            if (!live()) return null;
            if (!JE.arrAsk.canAsk(caps, kind)) {
                sheetPaint(listTicket, () => JE.arrAsk.toast(JE.arrAsk.describe({ state: 'denied' }, caps).text));
                return null;
            }
            const can4k = kind === 'movie' ? caps.can4kMovies === true : caps.can4kSeries === true;
            const variant = can4k && options?.variant === '4k' ? '4k' : 'standard';
            const loaded = await Promise.race([Promise.all([
                options && 'quota' in options ? options.quota : JE.arrAsk.quota(kind === 'movie' ? 'movie' : 'tv'),
                kind === 'series' && !options?.fixed ? withSeasons(title) : title,
                JE.arrAsk.check ? JE.arrAsk.check(title.key, variant) : null
            ]), stopped]);
            if (!live() || !loaded) return null;
            const [quota, shown, check] = loaded;
            if (!shown) {
                sheetPaint(listTicket, () => JE.arrAsk.toast(tr('arr_sheet_seasons_unavailable')));
                return null;
            }
            pendingOpens.delete(cancel);
            return await new Promise(resolve => {
                const painted = sheetPaint(listTicket, () => {
                    close();
                    state = build(shown, kind, caps, quota, { ...options, listTicket, blocks: { [variant]: blockOf(check) } }, opener, resolve);
                    current = state;
                });
                if (!painted) resolve(null);
            });
        } finally {
            pendingOpens.delete(cancel);
            off?.();
        }
    }

    /** Runs a sheet write under its list ticket, or directly for ordinary request sheets. */
    function sheetPaint(ticket, fn) {
        if (ticket) return JE.internals.arrListPages.gate.paint(ticket, fn, 'sheet');
        fn();
        return true;
    }

    /**
     * The block a title check names (null: the title can be asked for, or the check says nothing).
     * @param {{canRequest: boolean, blocked: Object|null}|null} check Title check (JE.arrAsk.check).
     * @returns {Object|null} Block.
     */
    function blockOf(check) {
        return check && !check.canRequest && check.blocked ? check.blocked : null;
    }

    /**
     * Reads whether the sheet's title can be asked for in an edition the sheet hasn't checked yet (a switch
     * between Standard and 4K: another instance, another drive); the sheet is refreshed when it answers.
     * @param {Object} state Sheet state.
     * @param {string} variant standard or 4k.
     * @returns {void}
     */
    function checkVariant(state, variant) {
        if (!JE.arrAsk.check || variant in state.blocks) return;
        state.blocks[variant] = null;
        JE.arrAsk.check(state.key, variant).then((check) => {
            state.blocks[variant] = blockOf(check);
            if (!state.done && current === state) refresh(state);
        });
    }

    /**
     * Builds and shows the sheet.
     * @param {Object} title Title.
     * @param {'movie'|'series'} kind Kind.
     * @param {Object} caps Capabilities.
     * @param {Object|null} quota Quota.
     * @param {Object|undefined} options Options.
     * @param {Element|null} opener Element focus returns to.
     * @param {Function} resolve Resolves the open() promise.
     * @returns {Object} Sheet state.
     */
    function build(title, kind, caps, quota, options, opener, resolve) {
        const light = prepareStyles();
        const contact = JE.arrAsk.contact(caps);
        const can4k = kind === 'movie' ? caps.can4kMovies === true : caps.can4kSeries === true;
        const state = {
            listTicket: options?.listTicket || null,
            title, kind, caps, quota, opener, resolve, busy: false, done: false, ...returnPoints(opener),
            variant: can4k && options?.variant === '4k' ? '4k' : 'standard',
            choice: null, picked: new Set(), episodeSeason: null, episodes: new Set(), cards: [], key: title.key,
            blocks: { ...(options?.blocks || {}) },
            // A list entry (phase 4c3a): its scope and edition are the entry's, and it is asked for through the list.
            fixed: options?.fixed && typeof options.fixed.send === 'function' ? options.fixed : null
        };
        const backdrop = el('div', 'je-sheet-backdrop');
        if (isTv()) backdrop.classList.add('je-sheet-tv');
        if (light) backdrop.classList.add('je-sheet-light');
        // focuscontainer: jellyfin-web's D-pad navigation (TV layout) stays inside the sheet, as Tab does.
        const sheet = el('div', 'je-sheet focuscontainer');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        const titleId = `je-sheet-title-${Date.now().toString(36)}`;
        sheet.setAttribute('aria-labelledby', titleId);
        sheet.appendChild(el('div', 'je-sheet-handle'));

        const head = el('div', 'je-sheet-head');
        const src = posterUrl(title.poster);
        if (src) {
            const img = el('img', 'je-sheet-poster');
            img.alt = '';
            img.loading = 'lazy';
            img.src = src;
            head.appendChild(img);
        }
        const headText = el('div', 'je-sheet-head-text');
        const heading = el('h2', 'je-sheet-title', caps.asksFirst ? tr('arr_sheet_title_ask', { contact, name: title.name || '' }) : tr('arr_sheet_title', { name: title.name || '' }));
        heading.id = titleId;
        headText.appendChild(heading);
        const facts = state.fixed ? state.fixed.scope || '' : factsLine(title, kind);
        if (facts) headText.appendChild(el('div', 'je-sheet-facts', facts));
        head.appendChild(headText);
        sheet.appendChild(head);

        if (can4k && !state.fixed) sheet.appendChild(variantToggle(state));

        if (kind === 'series' && !state.fixed) {
            const group = el('div', 'je-sheet-cards');
            group.setAttribute('role', 'group');
            group.setAttribute('aria-label', tr('arr_sheet_choices'));
            state.group = group;
            fillCards(state);
            sheet.appendChild(group);
        }

        state.note = el('div', 'je-sheet-note');
        state.note.id = `${titleId}-note`;
        state.note.hidden = true;
        sheet.appendChild(state.note);
        state.message = el('div', 'je-sheet-message');
        state.message.setAttribute('role', 'status');
        state.message.setAttribute('aria-live', 'polite');
        sheet.appendChild(state.message);

        const actions = el('div', 'je-sheet-actions');
        state.primary = button('je-sheet-primary');
        state.primary.addEventListener('click', () => submit(state));
        actions.appendChild(state.primary);
        state.cancel = button('je-sheet-secondary', tr('arr_sheet_cancel'));
        state.cancel.addEventListener('click', () => finish(state, null));
        actions.appendChild(state.cancel);
        sheet.appendChild(actions);
        backdrop.appendChild(sheet);

        state.backdrop = backdrop;
        state.sheet = sheet;
        state.onKey = (e) => onKey(state, e);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finish(state, null); });
        document.addEventListener('keydown', state.onKey, true);
        refresh(state);
        document.body.appendChild(backdrop);
        const first = sheet.querySelector('.je-sheet-card[aria-pressed="true"]') || (state.primary.hidden ? state.cancel : state.primary);
        first.focus();
        return state;
    }

    /**
     * (Re)builds a series sheet's cards and pickers for the copy chosen (Standard / 4K): what is
     * complete or already asked for differs between them. The choice and picks are kept where
     * they still apply.
     * @param {Object} state Sheet state.
     * @returns {void}
     */
    function fillCards(state) {
        state.group.replaceChildren();
        state.cards = seriesCards(state.title, state.variant, state.caps).map(card => ({ ...card, el: null, cost: null, panel: null }));
        const open = new Set(seasonsOf(state.title, state.variant).filter(s => !settled(s)).map(s => s.season));
        for (const n of [...state.picked]) if (!open.has(n)) state.picked.delete(n);
        for (const card of state.cards) {
            state.group.appendChild(cardButton(state, card));
            if (card.id === 'pick') state.group.appendChild(card.panel = pickSeasonsPanel(state));
            if (card.id === 'episodes') state.group.appendChild(card.panel = pickEpisodesPanel(state));
        }
        if (!state.cards.some(c => c.id === state.choice)) state.choice = state.cards[0]?.id || null;
    }

    /**
     * "2 seasons · 24 episodes" for a series, the year for a movie.
     * @param {Object} title Title.
     * @param {'movie'|'series'} kind Kind.
     * @returns {string} Facts.
     */
    function factsLine(title, kind) {
        if (kind === 'movie') return Number.isInteger(title.year) ? String(title.year) : '';
        const seasons = seasonsOf(title);
        if (!seasons.length) return Number.isInteger(title.year) ? String(title.year) : '';
        const episodes = seasons.reduce((n, s) => n + s.episodes, 0);
        if (seasons.length === 1) return episodes === 1 ? tr('arr_sheet_series_facts_one_one') : tr('arr_sheet_series_facts_one', { episodes });
        return episodes === 1 ? tr('arr_sheet_series_facts_episode_one', { seasons: seasons.length }) : tr('arr_sheet_series_facts', { seasons: seasons.length, episodes });
    }

    /**
     * The Standard / 4K toggle (only for callers who may ask for 4K of this kind).
     * @param {Object} state Sheet state.
     * @returns {HTMLElement} Toggle.
     */
    function variantToggle(state) {
        const box = el('div', 'je-sheet-variant');
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', tr('arr_sheet_variant_label'));
        box.appendChild(el('span', 'je-sheet-variant-label', tr('arr_sheet_variant_label')));
        for (const [variant, key] of [['standard', 'arr_sheet_variant_standard'], ['4k', 'arr_sheet_variant_4k']]) {
            const b = button('je-sheet-toggle je-sheet-variant-option', tr(key));
            b.dataset.variant = variant;
            b.addEventListener('click', () => {
                if (state.variant === variant) return;
                state.variant = variant;
                checkVariant(state, variant);
                if (state.kind === 'series') fillCards(state);
                refresh(state);
            });
            box.appendChild(b);
        }
        state.variantBox = box;
        return box;
    }

    /**
     * One series card (a toggle button).
     * @param {Object} state Sheet state.
     * @param {Object} card Card.
     * @returns {HTMLButtonElement} Button.
     */
    function cardButton(state, card) {
        const b = button('je-sheet-card');
        b.dataset.choice = card.id;
        b.appendChild(icon(card.icon, 'je-sheet-card-icon'));
        const body = el('span', 'je-sheet-card-body');
        body.appendChild(el('span', 'je-sheet-card-label', card.label));
        card.cost = el('span', 'je-sheet-card-cost');
        body.appendChild(card.cost);
        b.appendChild(body);
        card.mark = icon('radio_button_unchecked', 'je-sheet-card-mark');
        b.appendChild(card.mark);
        b.addEventListener('click', () => {
            state.choice = card.id;
            refresh(state);
        });
        card.el = b;
        return b;
    }

    /**
     * The "Pick seasons…" checklist.
     * @param {Object} state Sheet state.
     * @returns {HTMLElement} Panel.
     */
    function pickSeasonsPanel(state) {
        const panel = el('div', 'je-sheet-panel je-sheet-pick');
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', tr('arr_sheet_pick_seasons_label'));
        // One season at a time: ticking a season unticks the others (as Seerr's own season picker does).
        const one = !!JE.arrAsk.singleSeasonOnly?.(state.caps);
        if (one) {
            panel.appendChild(el('div', 'je-sheet-check-facts je-sheet-one-season', tr('arr_ask_toast_single_season')));
            if (state.picked.size > 1) state.picked = new Set([[...state.picked].sort((a, b) => a - b)[0]]);
        }
        for (const s of seasonsOf(state.title, state.variant)) {
            const label = el('label', 'je-sheet-check');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = String(s.season);
            box.disabled = settled(s);
            box.checked = !box.disabled && state.picked.has(s.season);
            if (box.disabled) label.classList.add('je-sheet-check-disabled');
            box.addEventListener('change', () => {
                if (box.checked && one) {
                    state.picked.clear();
                    panel.querySelectorAll('input[type="checkbox"]:checked').forEach((other) => { if (other !== box) other.checked = false; });
                }
                if (box.checked) state.picked.add(s.season);
                else state.picked.delete(s.season);
                refresh(state);
            });
            label.appendChild(box);
            label.appendChild(el('span', 'je-sheet-check-label', tr('arr_sheet_season', { season: s.season })));
            const facts = complete(s) ? tr('arr_sheet_season_all_here') : s.asked ? tr('arr_sheet_season_asked') : s.have > 0 && s.episodes > 0 ? tr('arr_sheet_season_have', { have: s.have, episodes: s.episodes }) : s.episodes > 0 ? (s.episodes === 1 ? tr('arr_sheet_season_count_one') : tr('arr_sheet_season_count', { episodes: s.episodes })) : '';
            if (facts) label.appendChild(el('span', 'je-sheet-check-facts', facts));
            panel.appendChild(label);
        }
        return panel;
    }

    /**
     * The "Pick episodes…" panel: a season row, then that season's episodes as toggles.
     * @param {Object} state Sheet state.
     * @returns {HTMLElement} Panel.
     */
    function pickEpisodesPanel(state) {
        const panel = el('div', 'je-sheet-panel je-sheet-pick-episodes');
        const seasons = seasonsOf(state.title).filter(s => s.episodes > 0);
        const row = el('div', 'je-sheet-seasons');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', tr('arr_sheet_pick_seasons_label'));
        const grid = el('div', 'je-sheet-episodes');
        grid.setAttribute('role', 'group');
        /**
         * Fills the episode toggles of the chosen season.
         * @returns {void}
         */
        const fill = () => {
            grid.replaceChildren();
            const s = seasons.find(x => x.season === state.episodeSeason);
            if (!s) return;
            grid.setAttribute('aria-label', tr('arr_sheet_pick_episodes_label', { season: s.season }));
            for (let n = 1; n <= Math.min(s.episodes, MAX_EPISODES); n++) {
                const b = button('je-sheet-toggle je-sheet-episode', tr('arr_sheet_episode_short', { episode: n }));
                b.dataset.episode = String(n);
                b.setAttribute('aria-label', tr('arr_sheet_episode', { episode: n }));
                b.addEventListener('click', () => {
                    if (state.episodes.has(n)) state.episodes.delete(n);
                    else state.episodes.add(n);
                    refresh(state);
                });
                grid.appendChild(b);
            }
        };
        for (const s of seasons) {
            const b = button('je-sheet-toggle je-sheet-episode-season', tr('arr_sheet_season', { season: s.season }));
            b.dataset.season = String(s.season);
            b.addEventListener('click', () => {
                if (state.episodeSeason === s.season) return;
                state.episodeSeason = s.season;
                state.episodes.clear();
                fill();
                refresh(state);
            });
            row.appendChild(b);
        }
        if (!seasons.some(s => s.season === state.episodeSeason)) {
            state.episodeSeason = seasons[0]?.season ?? null;
            state.episodes.clear();
        }
        fill();
        panel.appendChild(row);
        panel.appendChild(grid);
        return panel;
    }

    /**
     * The mutation input of the current choice, or null when nothing is chosen yet.
     * @param {Object} state Sheet state.
     * @returns {Object|null} Input.
     */
    function currentInput(state) {
        if (state.fixed) return state.fixed.input || {};
        const variant = state.variant;
        if (state.kind === 'movie') return JE.arrAsk.movieInput(state.key, variant);
        const card = state.cards.find(c => c.id === state.choice);
        if (!card) return null;
        if (card.id === 'pick') return state.picked.size ? JE.arrAsk.seasonsInput(state.key, [...state.picked], variant) : null;
        if (card.id === 'episodes') {
            if (state.episodeSeason == null || !state.episodes.size) return null;
            return JE.arrAsk.episodesInput(state.key, [...state.episodes].sort((a, b) => a - b).map(episode => ({ season: state.episodeSeason, episode })), variant);
        }
        return card.input(variant);
    }

    /**
     * Brings the sheet in line with its state: selected card, costs, the quota note and the
     * primary button's words.
     * @param {Object} state Sheet state.
     * @returns {void}
     */
    function refresh(state) {
        sheetPaint(state.listTicket, () => refreshSheet(state));
    }

    /** Updates the sheet inside its write boundary. */
    function refreshSheet(state) {
        const { caps, quota } = state;
        const contact = JE.arrAsk.contact(caps);
        // This title can't be asked for now (e.g. the drive it would land on is nearly full): said first, nothing to send.
        const paused = state.blocks?.[state.variant] ? JE.arrAsk.blockWords?.(state.blocks[state.variant], caps) : null;
        state.variantBox?.querySelectorAll('.je-sheet-variant-option').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.variant === state.variant)));
        for (const card of state.cards) {
            const on = card.id === state.choice;
            card.el.setAttribute('aria-pressed', String(on));
            card.mark.textContent = on ? 'radio_button_checked' : 'radio_button_unchecked';
            if (card.panel) card.panel.hidden = !on;
            const input = card.input ? card.input(state.variant) : (on ? currentInput(state) : null);
            const line = input && !paused ? costLine(input, caps, quota) : { text: '', over: false };
            card.cost.textContent = line.text;
            card.cost.hidden = !line.text;
            card.cost.classList.toggle('je-sheet-over', line.over);
        }
        state.sheet?.querySelectorAll('.je-sheet-episode-season').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.season) === state.episodeSeason)));
        state.sheet?.querySelectorAll('.je-sheet-episode').forEach((b) => b.setAttribute('aria-pressed', String(state.episodes.has(Number(b.dataset.episode)))));

        const input = currentInput(state);
        // A list entry's cost is the one the list's preview gave (the server's own rounding).
        const cost = state.fixed ? (Number.isInteger(state.fixed.cost) ? state.fixed.cost : 0) : input ? costOf(input, caps, quota) : 0;
        const over = limited(quota) && input != null && cost > quota.remaining;
        const used = limited(quota) && quota.remaining <= 0;
        const seerrBlocked = (caps.backend === 'seerr' && over) || !!paused;

        // The note: paused (amber), over quota (amber), else "{contact} will take a look first" for asks that wait.
        state.note.replaceChildren();
        state.note.className = 'je-sheet-note';
        state.sheet?.removeAttribute('aria-describedby');
        if (paused) {
            state.note.classList.add('je-sheet-note-attention', 'je-sheet-note-paused');
            state.note.appendChild(icon('storage', 'je-sheet-note-icon'));
            const body = el('span', null);
            body.appendChild(el('strong', null, paused.chip));
            body.appendChild(document.createTextNode(` · ${paused.detail || paused.text}`));
            state.note.appendChild(body);
            state.note.hidden = false;
            // Read out with the dialog's name: focus lands on Close, and the reason is the point of the sheet now.
            state.sheet?.setAttribute('aria-describedby', state.note.id);
        } else if (used || seerrBlocked) {
            state.note.classList.add('je-sheet-note-attention');
            state.note.appendChild(icon('hourglass_empty', 'je-sheet-note-icon'));
            const day = quota?.nextSlotAt ? JE.arrStatus.formatDate(quota.nextSlotAt) : '';
            const text = caps.backend === 'seerr' ? quotaText(quota)
                : day ? tr(quota.limit === 1 ? 'arr_sheet_over_quota_one' : 'arr_sheet_over_quota', { limit: quota.limit, day })
                    : tr(quota.limit === 1 ? 'arr_sheet_over_quota_noday_one' : 'arr_sheet_over_quota_noday', { limit: quota.limit });
            state.note.appendChild(el('span', null, text));
            state.note.hidden = false;
        } else if (caps.asksFirst) {
            state.note.classList.add('je-sheet-note-info');
            state.note.appendChild(icon('front_hand', 'je-sheet-note-icon'));
            state.note.appendChild(el('span', null, tr('arr_sheet_asks_first', { contact })));
            state.note.hidden = false;
        } else {
            state.note.hidden = true;
        }
        if (state.fixed?.note && state.note.hidden && !used) {
            // A list entry: what the list's preview says it would do and cost.
            state.note.hidden = false;
            state.note.classList.add('je-sheet-note-info');
            state.note.appendChild(icon('confirmation_number', 'je-sheet-note-icon'));
            state.note.appendChild(el('span', null, state.fixed.note));
        } else if (state.kind === 'movie' && !state.fixed) {
            // A movie has no cards: its cost goes under the note.
            const line = costLine(JE.arrAsk.movieInput(state.key, state.variant), caps, quota);
            if (line.text && !used) {
                if (state.note.hidden) {
                    state.note.hidden = false;
                    state.note.classList.add('je-sheet-note-info');
                    state.note.appendChild(icon('confirmation_number', 'je-sheet-note-icon'));
                    state.note.appendChild(el('span', null, line.text));
                }
            }
        }
        // Phase 4b: the shared allowance (group pool) the caller's requests draw on, after what the note says.
        const pool = !paused && quota?.pool && typeof quota.pool.used === 'number' && typeof quota.pool.limit === 'number' ? quota.pool : null;
        if (pool) {
            if (state.note.hidden) {
                state.note.hidden = false;
                state.note.classList.add('je-sheet-note-info');
                state.note.appendChild(icon('groups', 'je-sheet-note-icon'));
            } else state.note.appendChild(document.createTextNode(' · '));
            state.note.appendChild(el('span', 'je-sheet-note-pool', tr('arr_rules_sheet_pool', { name: String(pool.name || ''), used: pool.used, limit: pool.limit })));
        }

        // The primary button: Request / Ask {contact} / Send to {contact} for an OK; none when Seerr would refuse.
        if (!state.busy) {
            state.primary.replaceChildren();
            if (over && caps.backend !== 'seerr') {
                state.primary.appendChild(icon('send'));
                state.primary.appendChild(el('span', null, tr('arr_sheet_send_ok', { contact })));
            } else if (caps.asksFirst) {
                state.primary.appendChild(icon('front_hand'));
                state.primary.appendChild(el('span', null, tr('arr_sheet_ask_contact', { contact })));
            } else {
                state.primary.appendChild(icon('add'));
                state.primary.appendChild(el('span', null, tr('arr_sheet_request')));
            }
        }
        state.primary.hidden = seerrBlocked;
        state.cancel.textContent = seerrBlocked ? tr('arr_ask_close') : tr('arr_sheet_cancel');
    }

    /**
     * Sends the ask of the current choice. A tap while one is in flight does nothing (one request);
     * a refusal keeps the sheet open and says why.
     * @param {Object} state Sheet state.
     * @returns {Promise<void>}
     */
    async function submit(state) {
        if (state.busy || state.done || (state.listTicket && !state.listTicket.current())) return;
        const input = currentInput(state);
        if (!input) {
            showMessage(state, tr('arr_sheet_pick_none'), true);
            return;
        }
        state.busy = true;
        sheetPaint(state.listTicket, () => {
            state.primary.disabled = true;
            state.primary.setAttribute('aria-busy', 'true');
            state.primary.replaceChildren(el('span', null, tr('arr_sheet_asking')));
            showMessage(state, '', false);
        });
        let result;
        try {
            result = state.fixed ? await state.fixed.send() : await JE.arrAsk.ask(input);
        } catch (err) {
            result = { ok: false, status: 0, state: 'failed', outcome: '', reason: err?.name === 'AbortError' ? 'aborted' : 'network', certainty: '', requestId: null };
        }
        if (state.listTicket && (state.done || !state.listTicket.current())) return;
        state.busy = false;
        sheetPaint(state.listTicket, () => {
            state.primary.disabled = false;
            state.primary.removeAttribute('aria-busy');
        });
        if (result.stale) {
            finish(state, null);
            return;
        }
        const allowance = result.state === 'quota' ? (await JE.arrAsk.quota(state.kind === 'movie' ? 'movie' : 'tv')) || state.quota : state.quota;
        if (state.listTicket && (state.done || !state.listTicket.current())) return;
        const words = JE.arrAsk.describe(result, state.caps, allowance);
        if (result.ok || result.state === 'unknown') {
            sheetPaint(state.listTicket, () => JE.arrAsk.toast(words.text));
            finish(state, { ...result, input });
            return;
        }
        if (state.done) {
            // Closed while the ask was out: the answer still reaches the person.
            JE.arrAsk.toast(words.text);
            return;
        }
        if (result.state === 'quota' && allowance) state.quota = allowance;
        refresh(state);
        showMessage(state, words.text, true);
    }

    /**
     * Shows a line in the sheet (a refusal or a hint).
     * @param {Object} state Sheet state.
     * @param {string} text Text.
     * @param {boolean} attention Attention tone.
     * @returns {void}
     */
    function showMessage(state, text, attention) {
        sheetPaint(state.listTicket, () => {
            state.message.textContent = text;
            state.message.classList.toggle('je-sheet-message-attention', !!text && attention);
        });
    }

    /**
     * Keyboard: Escape (and Back on TV) closes, Tab stays inside the sheet.
     * @param {Object} state Sheet state.
     * @param {KeyboardEvent} e Event.
     * @returns {void}
     */
    function onKey(state, e) {
        if (state.done) return;
        const typing = /input|textarea|select/i.test(e.target?.tagName || '') && e.target?.type !== 'checkbox';
        if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
            e.preventDefault();
            e.stopPropagation();
            finish(state, null);
            return;
        }
        if (e.key !== 'Tab') return;
        const focusables = [...state.sheet.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')]
            .filter(n => !n.disabled && !n.hidden && !n.closest('[hidden]'));
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const inside = state.sheet.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
            e.preventDefault();
            first.focus();
        }
    }

    /**
     * Where focus can return to when the sheet closes, noted when it opens: the opener's focus id
     * (data-je-focus) and its ancestors. An ask redraws the page's controls while the sheet is open
     * (Discover cards, actions), so the opener itself may be gone by then.
     * @param {Element|null} opener Opener.
     * @returns {{focusId: string|null, openerPath: Element[]}} Return points.
     */
    function returnPoints(opener) {
        const path = [];
        for (let n = opener?.parentElement; n && n !== document.body; n = n.parentElement) path.push(n);
        return { focusId: opener?.closest?.('[data-je-focus]')?.dataset?.jeFocus || null, openerPath: path };
    }

    /**
     * Returns focus after the sheet closes: to the opener, else (it was redrawn) the control with its
     * focus id, else the nearest focusable ancestor still on the page (a Discover card), else the
     * page's main region, so keyboard, remote and screen-reader users keep their place.
     * @param {Object} state Sheet state.
     * @returns {void}
     */
    function restoreFocus(state) {
        const opener = state.opener;
        if (opener && document.contains(opener) && typeof opener.focus === 'function') {
            opener.focus();
            return;
        }
        const same = state.focusId ? [...document.querySelectorAll('[data-je-focus]')].find(n => n.dataset.jeFocus === state.focusId) : null;
        const holder = (state.openerPath || []).find(n => document.contains(n) && (n.tabIndex >= 0 || n.hasAttribute('tabindex')));
        const main = document.querySelector('.mainAnimatedPage:not(.hide)') || document.querySelector('main, [role="main"]');
        const target = same || holder || main;
        if (!target) return;
        if (target === main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
    }

    /**
     * Closes a sheet, resolves its promise and returns focus to what opened it.
     * @param {Object} state Sheet state.
     * @param {Object|null} result Result.
     * @returns {void}
     */
    function finish(state, result) {
        if (state.done) return;
        state.done = true;
        document.removeEventListener('keydown', state.onKey, true);
        const remove = () => state.backdrop?.remove();
        if (state.listTicket) JE.internals.arrListPages.gate.erase(remove);
        else remove();
        if (current === state) current = null;
        sheetPaint(state.listTicket, () => restoreFocus(state));
        state.resolve(result);
    }

    /**
     * Closes the open sheet (if any); its promise resolves with null.
     * @returns {void}
     */
    function close() {
        for (const cancel of pendingOpens) cancel();
        if (current) finish(current, null);
    }

    /**
     * Movies: asks with one tap and a toast, or opens the sheet when it is needed (quota nearly
     * used, asks wait for an OK, 4K allowed). Series always open the sheet. A second tap while the
     * first is out joins it (one request).
     * @param {Object} title Title.
     * @param {{opener?: HTMLElement}} [options] Options.
     * @returns {Promise<Object|null>} Result, or null.
     */
    function openOrAsk(title, options) {
        if (!JE.arrAsk?.enabled() || !title?.key) return Promise.resolve(null);
        if (title.kind !== 'movie') return open(title, options);
        if (inflight.has(title.key)) return inflight.get(title.key);
        // Capabilities and allowance are read for this session: a sign-out (and someone else's
        // sign-in) before the ask goes out drops it instead of asking as the next person.
        const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
        const sameSession = () => (JE.session?.getEpoch ? JE.session.getEpoch() : 0) === epoch;
        const run = (async () => {
            const caps = await JE.arrAsk.me();
            if (!sameSession()) return null;
            if (!JE.arrAsk.canAsk(caps, 'movie')) {
                JE.arrAsk.toast(JE.arrAsk.describe({ state: 'denied' }, caps).text);
                return null;
            }
            const quota = await JE.arrAsk.quota('movie');
            if (!sameSession()) return null;
            if (needsSheet(caps, quota, 'movie')) return { sheet: true, caps, quota };
            const result = await JE.arrAsk.ask(JE.arrAsk.movieInput(title.key));
            if (result.stale) return null;
            const allowance = result.state === 'quota' ? (await JE.arrAsk.quota('movie')) || quota : quota;
            JE.arrAsk.toast(JE.arrAsk.describe(result, caps, allowance).text);
            return result;
        })();
        const tracked = run.then((outcome) => (outcome?.sheet ? (sameSession() ? open(title, { ...options, caps: outcome.caps, quota: outcome.quota }) : null) : outcome));
        const settled = run.finally(() => inflight.delete(title.key));
        settled.catch(() => {});
        inflight.set(title.key, tracked);
        return tracked;
    }

    // ------------------------------------------------------------------ mount API

    /**
     * Renders a title's request controls into a container (see the file comment).
     * @param {HTMLElement} container Where the controls go.
     * @param {{key: string, kind: string, name?: string, year?: number, poster?: string, seasons?: Array}} title Title.
     * @param {{notify?: boolean, state?: boolean}} [options] notify: false leaves Notify me out (the page has its own);
     *     state: false leaves the request state chip out once the status says it (the page's status pill does).
     * @returns {{update: (status: Object|null) => void, destroy: () => void}} Controls.
     */
    function mount(container, title, options) {
        const withNotify = options?.notify !== false;
        const withState = options?.state !== false;
        const host = el('div', 'je-ask-mount');
        host.dataset.jeAskKey = title?.key || '';
        container.appendChild(host);
        let status = null;
        let caps = null;
        let local = null; // words of this page's last ask, until the status catches up
        /** @type {Object|null|undefined} the title check (JE.arrAsk.check): undefined until it is in */
        let check;
        let checking = false;
        let destroyed = false;
        let busy = false;
        const kind = title?.kind === 'movie' ? 'movie' : 'series';
        /**
         * The series key of a title key.
         * @param {string} key Key.
         * @returns {string} Series key.
         */
        const series = (key) => JE.arrAsk.seriesKey(key || '');
        const unsubscribe = JE.arrAsk?.onChange ? JE.arrAsk.onChange((detail) => {
            if (detail?.key && series(detail.key) === series(title.key)) render();
        }) : () => {};

        /**
         * True when the title can be asked for (nothing is under way for it).
         * @returns {boolean} Requestable.
         */
        function requestable() {
            return !status || (STAGES_REQUESTABLE.has(status.stage) && !status.attention);
        }

        /**
         * Whether this title can be asked for now: the words saying why not ("Paused: storage full"; where and how
         * much is free for administrators), null when it can (or the server can't say), or undefined while the
         * check is out (it is started here, once; the controls are drawn again when it is in).
         * @returns {Object|null|undefined} Words ({@link JE.arrAsk.blockWords}).
         */
        function blocked() {
            if (!JE.arrAsk.check || !JE.arrAsk.blockWords) return null;
            if (check === undefined) {
                if (!checking) {
                    checking = true;
                    JE.arrAsk.check(title.key, 'standard').then((value) => {
                        check = value || null;
                        render();
                    });
                }
                return undefined;
            }
            return check && !check.canRequest && check.blocked ? JE.arrAsk.blockWords(check.blocked, caps) : null;
        }

        /**
         * The control of this mount that has the keyboard focus, as a selector for its stand-in after
         * a redraw; null when the focus is elsewhere.
         * @returns {string|null} Selector.
         */
        function focusedControl() {
            const active = document.activeElement;
            if (!active || active === document.body || !host.contains(active)) return null;
            const classes = [...active.classList].filter(c => /^[A-Za-z0-9_-]+$/.test(c));
            return active.tagName.toLowerCase() + classes.map(c => `.${c}`).join('');
        }

        /**
         * Draws the controls for the current status and capabilities. A control that had the keyboard
         * (or remote) focus hands it to its stand-in, or to the mount's first control when it is gone,
         * or (nothing to press left: a state chip took its place) to that chip, so the keyboard and the
         * TV remote go on from here instead of the top of the page.
         * @param {boolean} [pressed] The control just pressed had the focus (it lost it while disabled).
         * @returns {void}
         */
        function render(pressed) {
            if (destroyed) return;
            // The pressed control lost the focus to the page itself; focus moved elsewhere meanwhile stays there.
            const focused = focusedControl() || (pressed && (!document.activeElement || document.activeElement === document.body) ? 'button' : null);
            draw();
            if (!focused || destroyed) return;
            const target = host.querySelector(focused) || host.querySelector('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
                || host.querySelector('.je-arr-chip');
            if (!target) return;
            // A chip is not focusable by itself: it takes the focus only to hand it on.
            if (target.classList.contains('je-arr-chip')) target.tabIndex = -1;
            target.focus?.({ preventScroll: true });
        }

        /**
         * Draws the controls (see render).
         * @returns {void}
         */
        function draw() {
            host.replaceChildren();
            if (!JE.arrAsk?.enabled() || !title?.key) return;
            prepareStyles();
            const row = el('div', 'je-ask-mount-row');
            const search = !!status && !!JE.arrStatus?.searchable?.(status);
            // Asks and Searches wait for this title's check (nothing that can't work is offered meanwhile).
            const words = !local && JE.arrAsk.canAsk(caps, kind) && (search || requestable()) ? blocked() : null;
            if (local && (requestable() || search)) {
                row.appendChild(el('span', `je-arr-chip je-arr-tone-${local.tone}`, local.chip));
            } else if (words === undefined) {
                // The check is out: drawn when it is in.
            } else if (search && JE.arrAsk.canAsk(caps, kind)) {
                // Can't be asked for now: an administrator's own Search stays (told where and how much is free);
                // anyone else's would be an ask or a search whose download can't be imported, so the line says why.
                if (!words || JE.arrAsk.searchInstance(caps, status, status?.key || title.key)) row.appendChild(searchButton());
                if (words) row.appendChild(JE.arrAsk.pausedNote(words));
            } else if (!requestable()) {
                // Where it stands (the page's own status pill says so when it has one: no second chip).
                if (withState) row.appendChild(el('span', `je-arr-chip je-arr-tone-${status.attention ? 'attention' : status.stage}`, JE.arrStatus.familyText(status, { contact: caps?.contact || '' })));
            } else if (JE.arrAsk.canAsk(caps, kind)) {
                const contact = JE.arrAsk.contact(caps);
                // This title can't be asked for now: the button says so instead of Request, and opens the sheet, which
                // says why in full (where and how much is free for administrators) and offers the 4K copy where it can.
                const b = button(words ? 'je-ask-action je-ask-mount-request je-ask-mount-paused' : 'je-ask-action je-ask-mount-request');
                b.appendChild(icon(words ? 'storage' : caps.asksFirst ? 'front_hand' : 'add', 'je-ask-action-icon'));
                b.appendChild(el('span', null, words ? words.chip : caps.asksFirst ? tr('arr_actions_ask', { contact }) : tr('arr_actions_request')));
                if (words) {
                    b.title = words.detail || words.text;
                    b.setAttribute('aria-label', `${words.chip}. ${words.detail || words.text}`);
                }
                b.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (busy) return;
                    busy = true;
                    // Disabling the button drops its focus: noted here, so the redraw can hand it on.
                    const pressed = document.activeElement === b;
                    b.disabled = true;
                    let result = null;
                    try {
                        result = kind === 'movie' && !words ? await openOrAsk(title, { opener: b }) : await open(title, { opener: b });
                    } finally {
                        busy = false;
                        b.disabled = false;
                    }
                    if (result && (result.ok || result.state === 'unknown')) {
                        const words = JE.arrAsk.describe(result, caps, null);
                        local = words.chip ? { chip: words.chip, tone: words.tone } : null;
                        render(pressed);
                    }
                });
                row.appendChild(b);
            }
            if (withNotify) {
                const notify = el('div', 'je-ask-mount-notify');
                JE.internals?.arrNotify?.attachModal?.(notify, status, title.key, { contact: caps?.contact || '' });
                if (notify.childNodes.length) row.appendChild(notify);
            }
            if (row.childNodes.length) host.appendChild(row);
        }

        /**
         * Search for a title missing for a long while (monitored, nothing grabbed): an
         * administrator's runs the arr's search right away; so does anyone's for a movie, or a series'
         * episodes missing for a long while, that requests already sent; a movie is otherwise asked for
         * with one tap, a series opens the sheet (the request backend turns an ask for a monitored scope
         * into a search).
         * @returns {HTMLButtonElement} Button.
         */
        function searchButton() {
            const contact = JE.arrAsk.contact(caps);
            const b = button('je-ask-action je-ask-mount-request je-ask-mount-search');
            b.appendChild(icon('search', 'je-ask-action-icon'));
            // A Kid's Search of what requests already sent runs without a new OK: plain "Search" then.
            const searchLabel = () => (JE.arrAsk.searchAsksFirst(caps, status) ? tr('arr_actions_ask_search', { contact }) : tr('arr_ask_search'));
            const label = el('span', null, searchLabel());
            b.appendChild(label);
            b.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (busy) return;
                busy = true;
                const pressed = document.activeElement === b;
                b.disabled = true;
                const instanceId = JE.arrAsk.searchInstance(caps, status, status?.key || title.key);
                let words = null;
                let searched = null;
                try {
                    if (instanceId) {
                        label.textContent = tr('arr_ask_searching');
                        const result = await JE.arrAsk.adminSearch(status?.key || title.key, instanceId);
                        JE.arrAsk.toast(result.text);
                        words = result.chip ? { chip: result.chip, tone: result.tone } : null;
                    } else if ((searched = await JE.arrAsk.familySearch(status?.key || title.key))) {
                        // Requests already sent it: search for it again instead of asking.
                        JE.arrAsk.toast(searched.text);
                        words = searched.chip ? { chip: searched.chip, tone: searched.tone } : null;
                    } else {
                        const result = kind === 'movie' ? await JE.arrAsk.ask(JE.arrAsk.movieInput(title.key)) : await open(title, { opener: b });
                        if (result && (result.ok || result.state === 'unknown')) {
                            const said = JE.arrAsk.describe(result, caps, null);
                            if (kind === 'movie') JE.arrAsk.toast(said.text);
                            words = said.chip ? { chip: said.chip, tone: said.tone } : null;
                        } else if (result && kind === 'movie') {
                            JE.arrAsk.toast(JE.arrAsk.describe(result, caps, null).text);
                        }
                    }
                } finally {
                    busy = false;
                    b.disabled = false;
                }
                if (words) {
                    local = words;
                    render(pressed);
                } else if (!destroyed) {
                    label.textContent = searchLabel();
                }
            });
            return b;
        }

        if (JE.arrAsk?.enabled()) {
            JE.arrAsk.me().then((value) => {
                caps = value;
                render();
            });
        }
        render();
        return {
            update(next) {
                const before = status ? `${status.stage}|${status.reason?.code || ''}` : '';
                status = next || null;
                // A new status that moved on (or a first one) replaces this page's own words.
                if (status && !requestable() && `${status.stage}|${status.reason?.code || ''}` !== before) local = null;
                render();
            },
            destroy() {
                destroyed = true;
                unsubscribe();
                host.remove();
            }
        };
    }

    JE.session?.onUserChange?.('arr-ask-sheet', () => {
        close();
        inflight.clear();
    });

    JE.arrAskSheet = Object.freeze({ open, openOrAsk, close, mount });
    JE.internals = JE.internals || {};
    JE.internals.arrAskSheet = { costOf, costLine, episodeCost, needsSheet, seriesCards, limited, posterUrl, current: () => current };
})(window.JellyfinEnhanced);
