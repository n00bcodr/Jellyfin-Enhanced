/**
 * @file Requests & downloads, phase 3: missing episodes on season pages (one row per episode, like
 * the native list). On a missing episode's row the "Missing" chip gets a **Get it** button (one tap
 * asks for that episode; the chip then reads "Waiting for OK" or "Asked!" as the server answered);
 * a downloading episode gets the download ring on its thumbnail; a missing episode's thumbnail is
 * dimmed. Where Jellyfin made its own row for a missing episode (the library imports missing
 * episodes) that row is decorated and its own "Missing" label is replaced by the one chip; for every
 * other missing episode JE draws a row that looks like the native ones — when the viewer shows
 * missing episodes within seasons (Jellyfin's per-user display setting). With that setting off the
 * phase-1 "Missing: E4, E7" banner gets **Get them** instead (never both). Plugs into
 * status-episodes.js (JE.internals.arrStatusEpisodes.extend); one GET .../acquire/requests/season/{id}
 * per season page view (and again after an ask or a status change). An episode that is monitored
 * and missing for a long while (JE.arrStatus.searchable) gets **Search** instead of Get it: an
 * administrator's Search runs the arr's search for it at once (Searching…, then what it found), whatever
 * the request policy says; everyone else asks for it like Get it. When the viewer's role may ask but the
 * policy can't take an ask right now (the season read's `blocked`, e.g. the drive is nearly full) the
 * episode says so in place of Get it ("Paused: storage full"), with one line for the season (where and
 * how much is free, for administrators) — never a bare "Missing" with nothing to do. A monitored
 * episode the arr is looking for right now (not missing for long yet) offers nothing: its chip says
 * "Looking for it".
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Ask:';
    const STILL = /^\/[A-Za-z0-9_.-]{1,80}$/;
    /** Stages of an episode that is simply not there (nobody is downloading it). */
    const MISSING_STAGES = new Set(['looking', 'notHere']);

    let season = null; // { itemId, rows, caps, loading, statusRef, generation }
    /** @type {Map<number, {state: string, at: number}>} optimistic states after an ask, until the server agrees */
    const local = new Map();
    /** How long a Search outcome stays in the place of its button. */
    const SEARCHED_TTL_MS = 2 * 60 * 1000;
    /** At most this many episodes are searched one by one from the banner by someone who doesn't manage the arrs. */
    const BANNER_SEARCH_MAX = 10;
    /** @type {Map<number, {chip: string, tone: string, at: number}>} outcomes of an administrator's Search, by episode */
    const searched = new Map();
    /** @type {{chip: string, tone: string, at: number, itemId: string}|null} outcome of an administrator's Search from the banner */
    let bannerSearched = null;
    const busy = new Set();
    let started = false;
    let generation = 0;
    let unsubscribe = null;
    /** @type {{itemId: string|null, close: function(boolean=): void}|null} the episode dialog shown now */
    let shownDialog = null;

    /**
     * Translates (shared helper).
     * @param {string} key Key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * True when the episode is missing and nothing is under way for it (dimmed, listed by the banner).
     * Being missing is not enough to offer anything: see offerable.
     * @param {Object} ep Episode status.
     * @returns {boolean} Missing.
     */
    function isMissing(ep) {
        if (!ep || !MISSING_STAGES.has(ep.stage) || ep.attention) return false;
        const code = ep.reason?.code;
        return code !== 'service_down' && code !== 'failed';
    }

    /**
     * True when a missing episode can be asked for (Get it): nobody is fetching it (not monitored, or
     * not in the arr at all).
     * @param {Object} ep Episode status.
     * @returns {boolean} Askable.
     */
    function askable(ep) {
        return isMissing(ep) && ep.stage === 'notHere';
    }

    /**
     * True when a missing episode gets a button: it can be asked for (askable), or it is monitored and
     * missing for a long while (JE.arrStatus.searchable: Search). A monitored episode the arr is
     * looking for right now gets neither: its chip says "Looking for it".
     * @param {Object} ep Episode status.
     * @returns {boolean} Offerable.
     */
    function offerable(ep) {
        return askable(ep) || (isMissing(ep) && !!JE.arrStatus?.searchable?.(ep));
    }

    /**
     * The request state shown for an episode: an optimistic one right after an ask, else the server's
     * (the episode's own ask first, then an ask for the whole season), in the edition of the control's own binding
     * (D53, edition round 19: a 4K copy's control reads the 4K asks, never a standard ask, and the other way round).
     * @param {number} episode Episode number.
     * @param {string|null} [variant] The edition (default standard).
     * @returns {string|null} waiting, asked, declined, household or null.
     */
    function requestState(episode, variant) {
        const optimistic = local.get(episode);
        if (optimistic) return optimistic.state;
        const rows = season?.rows;
        if (!rows) return null;
        const entry = (rows.episodes || []).find(e => e.episode === episode);
        if (variant === '4k') return entry?.request4k || rows.seasonRequest4k || null;
        return entry?.request || rows.seasonRequest || null;
    }

    /**
     * The request state that takes the place of Get it / Search on an episode, or null when the
     * episode can be asked for (or searched). A request waiting for an OK, a decline and an ask made
     * from this page a moment ago always do. A request that was already sent (the viewer's or someone
     * else's) gives way to Search once the episode is monitored and missing for a long while: it
     * reads plainly Missing then, like any other episode nothing was found for. It gives way to Get it
     * too when nobody is fetching the episode any more (unmonitored in Sonarr since, or gone from it):
     * "Asked!" would promise something nothing is doing.
     * @param {Object} ep Episode status.
     * @returns {string|null} waiting, asked, declined, household or null.
     */
    function shownState(ep) {
        const state = requestState(ep.episode, bindingOf([ep])?.variant);
        if (state !== 'asked' && state !== 'household') return state;
        const mine = local.get(ep.episode);
        if (mine && !(mine.search && Date.now() - mine.at > SEARCHED_TTL_MS)) return state;
        return JE.arrStatus?.searchable?.(ep) || ep.stage === 'notHere' ? null : state;
    }

    /**
     * Chip words for a request state.
     * @param {string} stateName Request state.
     * @returns {{text: string, tone: string}|null} Chip.
     */
    function chipForState(stateName) {
        switch (stateName) {
            case 'waiting': return { text: tr('arr_ask_chip_waiting'), tone: 'asked' };
            case 'asked': return { text: tr('arr_ask_chip_asked'), tone: 'approved' };
            case 'household': return { text: tr('arr_ask_chip_household'), tone: 'approved' };
            case 'declined': return { text: tr('arr_ask_chip_declined'), tone: 'attention' };
            default: return null;
        }
    }

    /**
     * True when this page can offer Get it for an edition (feature on, rows loaded, the viewer may ask: the caller's
     * capabilities, once read, don't say otherwise, and that edition's own policy answer allows it). D53, edition round 20
     * (per-edition capabilities): a 4K control reads the 4K edition's answer (`canRequest4k`, the caller's 4K permission),
     * never the standard edition's, and the other way round: a full standard drive never hides a 4K ask.
     * @param {'standard'|'4k'} [variant] The edition (default standard).
     * @returns {boolean} Can ask.
     */
    function canAsk(variant) {
        const rows = season?.rows;
        if (!(JE.arrAsk?.enabled() && rows && season.caps?.canRequest !== false && season.caps?.canRequestSeries !== false)) return false;
        if (variant === '4k') return (rows.canRequest4k ?? rows.canRequest) === true && season.caps?.can4kSeries === true;
        return !!rows.canRequest;
    }

    /**
     * The edition the control for these episodes asks in: its copy binding's (a 4K copy's gap: 4K), else standard.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {'standard'|'4k'} Edition.
     */
    function editionOf(eps, status) {
        return bindingOf(eps, status)?.variant === '4k' ? '4k' : 'standard';
    }

    /**
     * True when an administrator's Search runs for this episode from this page whatever the request
     * policy says (monitored, missing for a long while, the Manage drawer on and an instance holding it):
     * the arr's own search needs no request.
     * @param {Object} ep Episode status.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {boolean} Search offered.
     */
    function adminSearchable(ep, status) {
        if (!JE.arrAsk?.enabled() || !season?.rows || !JE.arrStatus?.searchable?.(ep)) return false;
        return !!adminInstance([ep], status || null, ep.key);
    }

    /**
     * The one copy binding a control for these episodes acts on (D53, edition round 15: one binding decides wording and
     * action). Null when none of them is a gap of this page's copy only: the control is title-wide (plain words, a standard
     * ask). For a copy's gap, the season's `copy` from the server: the edition a request names and whether that request
     * reaches the copy's Sonarr, whether a household Search does, and (administrators) the copy's instance. A server that
     * names none for that copy: nothing reaches it.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {{role: string, variant: string|null, ask: boolean, search: boolean, instanceId?: string}|null} Binding.
     */
    function bindingOf(eps, status) {
        const gap = eps.find(ep => ep?.copyGap)?.copyGap;
        if (!gap) return null;
        const copy = (status || season?.statusRef)?.copy;
        return copy && copy.role === gap ? copy : { role: gap, variant: null, ask: false, search: false };
    }

    /**
     * The instance an administrator's Search for these episodes runs on: the copy's own Sonarr under a copy's binding, else
     * the title's (JE.arrAsk.searchInstance). Null when the caller can't run one.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} status Season status (null: the one shown).
     * @param {string} key Title key in scope.
     * @param {Object|null} [caps] Capabilities (default: the season's).
     * @returns {string|null} Instance id.
     */
    function adminInstance(eps, status, key, caps) {
        const who = caps || season?.caps;
        const binding = bindingOf(eps, status);
        if (!binding) return JE.arrAsk.searchInstance?.(who, status || season?.statusRef, key) || null;
        if (who?.role !== 'admin' || JE.pluginConfig?.ArrManageDrawerEnabled !== true) return null;
        return binding.instanceId || null;
    }

    /**
     * What a control under a copy's binding may do: 'search' when its Search reaches the copy (an administrator's on the
     * copy's own Sonarr, a household Search on its request target), else 'get' when an ask for the copy's edition reaches it
     * (and the viewer may ask for that edition), else null: nothing is offered under the copy's name. A title-wide control
     * keeps its mode.
     * @param {Object|null} binding Binding ({@link bindingOf}).
     * @param {'get'|'search'} mode The mode the episodes would have.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} [status] Season status.
     * @returns {'get'|'search'|null} Mode.
     */
    function reach(binding, mode, eps, status) {
        if (!binding) return mode;
        // Seerr mode is out of scope for edition awareness (D80): Seerr picks the server, so nothing acts under a copy's name.
        if (JE.arrAsk?.seasonsOnly?.(season?.caps)) return null;
        if (mode === 'search' && (adminInstance(eps, status || null, eps[0]?.key) || (binding.search && canAsk('standard')))) return 'search';
        // An ask in the copy's edition needs that edition's own permission and policy answer (its target and drive).
        if (binding.ask && canAsk(binding.variant === '4k' ? '4k' : 'standard')) return 'get';
        return null;
    }

    /**
     * True when the episode gets a button (Get it, or Search) that reaches what its chip names.
     * @param {Object} ep Episode status.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {boolean} Offered.
     */
    function offered(ep, status) {
        return (canAsk(editionOf([ep], status)) || adminSearchable(ep, status)) && modeOf(ep, status) !== null;
    }

    /**
     * What a control for these episodes does, exactly (D53, edition round 19: the server decides every press): the season page
     * it sits on, its mode, the episodes, the copy binding it acts for, the edition, where an ask lands (the server's opaque
     * token) or the instance an administrator's Search runs on, and, for an ask Seerr takes as whole seasons, the whole-series
     * policy it is drawn under and the seasons it names. The press sends it (`expect`) and the server works it out again and
     * refuses any difference; the page compares it too, at the press, as a courtesy. Null for no control.
     * @param {'get'|'search'|null} mode Mode.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} status Season status.
     * @param {string} key Title key in scope (the episode's, or the season's for several).
     * @returns {Object|null} The press intent.
     */
    function pressOf(mode, eps, status, key) {
        if (!mode || !eps.length) return null;
        const binding = bindingOf(eps, status);
        const instance = mode === 'search' ? adminInstance(eps, status, key) : null;
        if (!instance && !canAsk(binding?.variant === '4k' ? '4k' : 'standard')) return null;
        const round = mode === 'get' && rounded();
        const whole = round && !!JE.arrAsk.wholeSeriesOnly?.(season?.caps);
        return {
            item: normalize(status?.itemId || season?.itemId),
            mode,
            episodes: eps.map(ep => ep.episode).sort((a, b) => a - b),
            copy: binding ? binding.role : null,
            variant: binding?.variant || 'standard',
            dest: binding && mode === 'get' ? (binding.dest || null) : null,
            instance: instance || null,
            whole,
            // The seasons a rounded ask names: this season; the whole series' seasons are known only when it is sent.
            seasons: round && !whole && Number.isInteger(season?.rows?.season) ? [season.rows.season] : null
        };
    }

    /**
     * {@link pressOf} as one comparable string (empty for no control): a control's signature, and what the press compares.
     * @param {'get'|'search'|null} mode Mode.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} status Season status.
     * @param {string} key Title key in scope.
     * @returns {string} Intent.
     */
    function intentOf(mode, eps, status, key) {
        const press = pressOf(mode, eps, status, key);
        return press ? JSON.stringify(press) : '';
    }

    /** Presses being checked or sent, by season and episode: one press per episode at a time, whichever control it came from. */
    const pressing = new Map();

    /**
     * Reserves a press for these episodes of a season, synchronously, before anything is awaited (D53, edition round 19: one
     * press protocol): the episode dialog's button, its row's, the banner's, a keyboard or a remote all share it, so a second
     * press of the same episode while the first is out does nothing. Null when one is out already; else the release.
     * @param {string} itemId Season item id.
     * @param {number[]} numbers Episode numbers.
     * @returns {(function(): void)|null} Release.
     */
    function reserve(itemId, numbers) {
        const keys = [...new Set(numbers)].map(n => `${itemId}|${n}`);
        if (!keys.length || keys.some(k => pressing.has(k))) return null;
        const token = {};
        keys.forEach(k => pressing.set(k, token));
        return () => keys.forEach((k) => { if (pressing.get(k) === token) pressing.delete(k); });
    }

    /**
     * Remembers the focused press's semantic origin before any awaited preparation or redraw. The episode dialog belongs to
     * its opening row; it may close or lose that row while the request is pending. Replies never acquire focus ownership.
     * @param {HTMLElement|null} button The control pressed.
     * @returns {void}
     */
    function rememberFocus(button) {
        // A control inside the episode dialog acts for the row that opened it (D53, edition round 21): the dialog gives the
        // focus back to that row when it closes, so the row is where the person still is, and its place is what recovers.
        const origin = button ? origins.get(button) || null : null;
        const active = document.activeElement;
        const hadFocus = !!button && (active === button || (!!origin && (active === origin.el || origin.el.contains(active))));
        const from = origin && document.contains(origin.el) ? origin.el : button;
        const place = from?.closest?.('.listItem, .je-arr-banner') || null;
        const page = origin?.page || from?.closest?.('#itemDetailPage') || null;
        // The press owns a semantic place before its first await. Busy controls, optimistic outcomes and later server reads
        // may all replace it. One owner survives those redraws, until deliberate input or the page/session ends it.
        pendingFocus = hadFocus ? {
            focusKey: button.dataset?.jeFocus || null,
            originKey: origin?.focusKey || null,
            place,
            // The opener's row may already be gone (a live redraw while the dialog was open): its neighbours as they were then.
            neighbours: place ? neighboursOf(place) : origin?.neighbours || [],
            episode: button.dataset?.jeAskEpisode || origin?.episode || null,
            itemId: season?.itemId || null,
            page,
            href: location.href,
            epoch: JE.arrAsk.epoch(),
            dialog: button.closest?.('[role="dialog"]') || null,
            // Where the focus is now (the pressed control, or the row the dialog gave it back to); null: nowhere.
            placed: origin?.el?.isConnected ? origin.el : active && active !== document.body ? active : null,
            moved: false,
            input: false
        } : null;
    }

    /** Announces a refused press and refreshes its evidence; focus belongs to the original checked press, never its reply. */
    function refused(text, key) {
        const seasonKey = key || season?.statusRef?.key;
        if (seasonKey) JE.arrStatus.refresh([seasonKey]);
        JE.internals?.arrStatusEpisodes?.apply?.();
        announce(text);
        JE.arrAsk.toast(text);
        focusStable();
    }

    /** One checked press's semantic focus origin, shared by busy, success, uncertainty, refusal and later redraws. */
    let pendingFocus = null;

    /** What opened the episode dialog a control sits in (its row, that row's episode, focus key and neighbours): the control's origin. */
    const origins = new WeakMap();

    /**
     * The rows next to a row (after it, then before it), by what a redraw keeps: an episode number or Jellyfin's item id.
     * @param {Element|null} place Row.
     * @returns {Array<{episode?: string, id?: string}>} Neighbours.
     */
    function neighboursOf(place) {
        if (!place) return [];
        return [place.nextElementSibling, place.previousElementSibling]
            .map(n => n?.dataset?.jeAskEpisode ? { episode: n.dataset.jeAskEpisode } : n?.dataset?.id ? { id: n.dataset.id } : null).filter(Boolean);
    }

    /**
     * Moves the focus to the control that took the pressed one's place (the same focus key), else its
     * row's title or chip, else the row next to where it was, else the banner; only while nothing else has the focus or the
     * element it was put on went with a redraw, and until the person moves the focus themselves (or the season changes).
     * @returns {void}
     */
    function focusStable() {
        const want = pendingFocus;
        if (!want) return;
        // Another season is shown: the focus went with its page.
        if (!season || (want.itemId && season.itemId !== want.itemId) || want.epoch !== JE.arrAsk.epoch()
            || want.href !== location.href || !JE.arrAsk.enabled() || !JE.arrStatus.enabled()
            || !want.page?.isConnected || want.page.classList.contains('hide')) {
            pendingFocus = null;
            return;
        }
        // The person moved the focus themselves: it stays where they put it, and the recovery is over.
        if (want.moved) {
            pendingFocus = null;
            return;
        }
        // The focus is where the recovery (or the dialog closing) put it, on something still on the page: nothing to do. When that
        // element went with a redraw (the page's own list drawn again, the episode arrived), the focus fell to the page or the
        // host moved it on its own; that was no move of the person's, so it is placed again (D53, edition round 21: the recovery
        // lasts through the redraws, never a timer, and ends at the person's own move or with the season).
        const active = document.activeElement;
        const modal = active?.closest?.('[role="dialog"], dialog');
        if (modal) {
            if (modal !== want.dialog) pendingFocus = null;
            return;
        }
        const vanished = !!want.placed && !document.contains(want.placed);
        if (active && active !== document.body && active !== want.placed && document.contains(active) && !vanished) return;
        const page = want.page;
        const byKey = key => (key ? page.querySelector(`[data-je-focus="${key}"]:not([disabled])`) : null);
        const rowOf = n => page.querySelector(`.listItem[data-je-ask-episode="${n}"]`);
        const replacement = byKey(want.focusKey) || byKey(want.originKey);
        const row = want.place && document.contains(want.place) ? want.place : want.episode ? rowOf(want.episode) : null;
        // The row is gone (the episode arrived): the row next to where it was, as the redraw has it.
        const neighbour = row ? null : (want.neighbours || []).map(n => n.episode
            ? rowOf(n.episode)
            : [...page.querySelectorAll('[data-id]')].find(e => e.dataset.id === n.id)).find(Boolean) || null;
        const inRow = r => r && (r.querySelector('.je-ask-get:not([disabled])') || r.querySelector('.je-ask-searched, .je-arr-chip') || r.querySelector('.je-ask-row-title') || r);
        const stable = replacement
            || (row && !row.classList.contains('je-arr-banner') ? inRow(row) : null)
            || inRow(neighbour)
            || page.querySelector('.je-arr-banner .je-ask-get:not([disabled])')
            || page.querySelector('.je-ask-banner-action .je-ask-searched, .je-ask-banner-action .je-arr-chip')
            || page.querySelector('.je-arr-banner-title, .je-arr-banner');
        if (!stable) return;
        if (stable === active) return;
        if (stable.tagName !== 'BUTTON' && !stable.hasAttribute('tabindex')) stable.tabIndex = -1;
        want.placed = stable;
        want.input = false;
        stable.focus();
    }

    // The person's own move: a focus change that follows their own input (a TV remote's key, Tab, a click or a touch) while the
    // recovery's element is still on the page. The recovery ends there (see focusStable). A focus the host moves by itself (its
    // page refresh focusing its first button) follows no input of theirs and ends nothing.
    const input = () => { if (pendingFocus) pendingFocus.input = true; };
    document.addEventListener('keydown', input, true);
    document.addEventListener('pointerdown', input, true);
    document.addEventListener('mousedown', input, true);
    document.addEventListener('touchstart', input, { capture: true, passive: true });
    // Any activation is deliberate and ends the recovery at once (D53, edition round 22): a click with no key, pointer or mouse
    // event before it (a screen reader's, or a TV remote's Enter turned into a click) included, and one on the very control the
    // recovery placed the focus on (no focus change follows it). The recovery itself only focuses, it never clicks.
    document.addEventListener('click', () => { pendingFocus = null; }, true);
    document.addEventListener('focusin', (e) => {
        const want = pendingFocus;
        if (want && want.input && want.placed && e.target !== want.placed && document.contains(want.placed)) want.moved = true;
    }, true);

    /**
     * Check at the press (D53, edition rounds 16 and 19): reads the caller's capabilities and the season's status again and lets
     * the control act only while it would still be drawn to do exactly what it was drawn to do. The same season read again
     * meanwhile is the same season (compared by its key, never by the state object); a read that fails fails closed (nothing
     * sent, and the person is told it couldn't be checked); a difference sends nothing, draws the page again and says why.
     * The server works the press out again in any case.
     * @param {Object} target The season state the control was drawn for.
     * @param {string} drawn The control's intent ({@link intentOf}) when drawn.
     * @param {function(Object): string} now The control's intent from a season status read now.
     * @param {HTMLElement|null} button The control pressed.
     * @returns {Promise<Object|null>} The press intent to send, or null to send nothing.
     */
    async function checkAtClick(target, drawn, now, button) {
        if (!drawn) return null;
        const started = JE.arrAsk.epoch();
        let caps = null;
        let answer = null;
        try {
            [caps, answer] = await Promise.all([JE.arrAsk.me(true), JE.arrStatus.fetchItem(target.itemId)]);
        } catch (err) {
            if (err?.name === 'AbortError') return null;
        }
        // Another person signed in, or another season is shown now: the control is gone with its page.
        if (JE.arrAsk.epoch() !== started || !season || season.itemId !== target.itemId) return null;
        const fresh = (answer?.items || []).find(s => normalize(s?.itemId) === target.itemId) || null;
        if (!caps || !fresh) {
            refused(tr('arr_ask_check_failed'), target.statusRef?.key);
            return null;
        }
        season.caps = caps;
        const intent = now(fresh);
        if (intent && intent === drawn) return JSON.parse(intent);
        // No longer what it was drawn to do: drawn again for what is allowed now, and the person is told why nothing happened
        // (Seerr mode: that it takes whole seasons, when the control now asks for the season instead).
        const was = drawn ? JSON.parse(drawn) : null;
        const is = intent ? JSON.parse(intent) : null;
        const roundedNow = !!is && is.mode === 'get' && !was?.seasons && !was?.whole && (is.seasons || is.whole);
        refused(roundedNow ? JE.arrAsk.describe({ ok: false, state: 'blocked', reason: 'seerr_whole_season_only' }, caps, null).text : tr('arr_ask_changed'), fresh.key);
        return null;
    }

    /**
     * Runs a control's press: reserves its episodes before anything is awaited ({@link reserve}), checks it
     * ({@link checkAtClick}), and runs its action with the intent the server is sent.
     * @param {HTMLButtonElement} button The control.
     * @param {Array<number>} numbers The episodes it acts on (a rounded ask: every episode of the season).
     * @param {function(Object): string} now The control's intent from a season status read now.
     * @param {function(Object): Promise<void>} run Its action, given the press intent.
     * @returns {Promise<void>}
     */
    async function act(button, numbers, now, run) {
        // The press's origin (JE.core.userWrite), taken at the click before the check's reads: what it runs is that
        // session's, or nothing.
        const origin = JE.core.userWrite.origin();
        const target = season;
        if (!target) return;
        const release = reserve(target.itemId, numbers);
        if (!release) return;
        rememberFocus(button);
        try {
            const intent = await checkAtClick(target, button.dataset.intent || '', now, button);
            if (intent && JE.core.userWrite.isBound(origin)) await run(intent, origin);
        } finally {
            release();
        }
    }

    /**
     * True when an ask from this page goes for whole seasons (Seerr mode: Seerr takes whole seasons, so Get it asks
     * for the episode's season and says so on the button).
     * @returns {boolean} Rounded up.
     */
    function rounded() {
        return !!JE.arrAsk?.seasonsOnly?.(season?.caps);
    }

    /**
     * The words of a button that asks for this season in Seerr mode ("Get Season 2", or "Get the whole series"), and
     * why ("Seerr takes whole seasons, so this asks for all of Season 2.").
     * @returns {{label: string, note: string}} Words.
     */
    function roundedWords() {
        const seasons = [season?.rows?.season].filter(Number.isInteger);
        return { label: JE.arrAsk.roundedLabel(season?.caps, seasons), note: JE.arrAsk.roundedNote(season?.caps, seasons) };
    }

    /**
     * The words of an edition's request block (the viewer's role may ask, that edition's policy can't take an ask now:
     * "Paused: storage full"), or null. A 4K copy's gap says the 4K edition's block (`blocked4k`), never the standard one's.
     * @param {'standard'|'4k'} [variant] The edition (default standard).
     * @returns {{reason: string, chip: string, text: string, detail: string}|null} Words.
     */
    function blockedWords(variant) {
        const block = variant === '4k' ? season?.rows?.blocked4k : season?.rows?.blocked;
        if (!JE.arrAsk?.enabled() || canAsk(variant) || !block) return null;
        return JE.arrAsk.blockWords ? JE.arrAsk.blockWords(block, season.caps) : null;
    }

    /**
     * The block words of the first of these episodes whose edition can't take an ask now (see {@link blockedWords}), or null.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object|null} [status] Season status.
     * @returns {{reason: string, chip: string, text: string, detail: string}|null} Words.
     */
    function blockedWordsOf(eps, status) {
        for (const ep of eps) {
            const words = blockedWords(editionOf([ep], status));
            if (words) return words;
        }
        return null;
    }

    /**
     * Extension hook: the chip of a missing episode says its request state, or plainly "Missing"
     * (one label, whatever Sonarr's monitoring says) when it can be asked for, searched, or the page
     * says why it can't be asked for now. One the arr is looking for right now keeps "Looking for it".
     * @param {Object} ep Episode status.
     * @returns {{text: string, tone: string}|null} Chip override.
     */
    function chip(ep) {
        if (!JE.arrAsk?.enabled() || !isMissing(ep)) return null;
        const byState = chipForState(shownState(ep));
        if (byState) return byState;
        if (!offerable(ep)) return null;
        if (!offered(ep) && !blockedWords(editionOf([ep]))) return null;
        // Another copy the viewer can open plays it: this copy's gap (the chip names the copy).
        return { text: ep.copyGap ? tr('arr_chip_missing_in_copy', { copy: JE.arrStatus.copyName(ep.copyGap) }) : tr('arr_chip_missing'), tone: 'notOut' };
    }

    /**
     * The episodes of the season JE shows as rows (Jellyfin has none for them): with the viewer's
     * "display missing episodes" setting on, every episode the banner would list. With no episode
     * list on the page to put rows in (once jellyfin-web has rendered the season), none: the banner
     * says it instead.
     * @param {Object} status Season status.
     * @param {{page?: HTMLElement, list?: HTMLElement|null}} [parts] The season page and its episode list.
     * @returns {Set<number>} Episode numbers.
     */
    function drawn(status, parts) {
        const out = new Set();
        if (!JE.arrAsk?.enabled()) return out;
        ensureRows(status);
        // While the first read is out the banner waits (it may turn out to be rows); a failed read
        // brings it back.
        const loadingFirst = season?.loading && !season?.rows;
        if (!loadingFirst && (!season?.rows?.displayMissing || season.itemId !== normalize(status.itemId))) return out;
        if (parts && !parts.list && !parts.page?.querySelector('#listChildrenCollapsible.hide')) return out;
        let upcoming = false;
        for (const ep of status.episodes || []) {
            if (ep.row || ep.stage === 'ready' || ep.stage === 'none') continue;
            if (ep.stage === 'notOut') {
                if (upcoming) continue;
                upcoming = true;
            }
            out.add(ep.episode);
        }
        return out;
    }

    /**
     * An id without dashes, lower case.
     * @param {string} id Id.
     * @returns {string} Normalized id.
     */
    function normalize(id) {
        return String(id || '').replace(/-/g, '').toLowerCase();
    }

    /**
     * True in jellyfin-web's TV layout: rows are single focus targets there (no buttons inside a row).
     * @returns {boolean} TV layout.
     */
    function isTv() {
        return document.documentElement.classList.contains('layout-tv') || !!document.body?.classList.contains('layout-tv');
    }

    /**
     * Loads the season rows (once per season per status read).
     * @param {Object} status Season status.
     * @returns {void}
     */
    function ensureRows(status) {
        const itemId = normalize(status.itemId);
        if (!itemId) return;
        if (season && season.itemId === itemId && (season.loading || season.statusRef === status)) return;
        const fresh = !season || season.itemId !== itemId;
        if (fresh) {
            pendingFocus = null;
            local.clear();
            searched.clear();
            bannerSearched = null;
            closeDialog();
        }
        const mine = { itemId, rows: fresh ? null : season.rows, caps: fresh ? null : season.caps, loading: true, statusRef: status, generation: ++generation };
        season = mine;
        load(mine);
    }

    /**
     * Reads the season rows and re-applies the page when they arrive.
     * @param {Object} target The season state the read is for.
     * @returns {Promise<void>}
     */
    async function load(target) {
        const lang = (navigator.language || 'en').split('-')[0];
        // The caller's capabilities are read alongside (an administrator's Search doesn't depend on the rows'
        // canRequest); the rows don't wait for them, and the page is applied again when they arrive.
        let rows = null;
        try {
            const read = JE.arrAsk.call(`/acquire/requests/season/${encodeURIComponent(target.itemId)}?language=${encodeURIComponent(lang)}`);
            followCaps(target);
            const answer = await read;
            rows = answer.status === 200 && answer.body?.rows ? answer.body.rows : null;
        } catch (err) {
            if (err?.name !== 'AbortError') console.warn(`${logPrefix} season rows unavailable (${err?.message || err})`);
        }
        if (season !== target || target.generation !== generation) return;
        target.loading = false;
        if (rows) {
            target.rows = rows;
            // The server's answer replaces optimistic states it agrees with (or knows better).
            for (const [episode, entry] of [...local]) {
                const server = (rows.episodes || []).find(e => e.episode === episode)?.request || rows.seasonRequest;
                // A Search's ask stays shown for a while: the server's "asked" gives way to Search again.
                if (Date.now() - entry.at > (entry.search ? SEARCHED_TTL_MS : 60000) || (server && !entry.search)) local.delete(episode);
            }
        }
        JE.internals?.arrStatusEpisodes?.apply?.();
    }

    /**
     * Reads the caller's capabilities for a season state and applies the page again when they change what it
     * offers (cached by JE.arrAsk for a minute, so usually at once).
     * @param {Object} target The season state.
     * @returns {void}
     */
    function followCaps(target) {
        if (!JE.arrAsk.me) return;
        Promise.resolve(JE.arrAsk.me()).then((caps) => {
            if (season !== target || target.caps === (caps || null)) return;
            target.caps = caps || null;
            if (target.rows) JE.internals?.arrStatusEpisodes?.apply?.();
        }, () => {});
    }

    /**
     * Extension hook: decorates the season page after the phase-1 chips and banner are on.
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {Object} ctx Response context.
     * @param {{banner: HTMLElement|null, list: HTMLElement|null, drawn: Set<number>|null}} parts Parts.
     * @returns {void}
     */
    function decorate(page, status, ctx, parts) {
        if (!JE.arrAsk?.enabled()) { pendingFocus = null; return; }
        JE.internals?.arrAskStyles?.syncTheme?.();
        ensureRows(status);
        const byId = new Map();
        const byNumber = new Map();
        for (const ep of status.episodes || []) {
            byNumber.set(ep.episode, ep);
            if (ep.row && ep.itemId) byId.set(normalize(ep.itemId), ep);
        }
        let list = parts.list;
        page.querySelectorAll('.listItem[data-id]').forEach((row) => {
            const ep = byId.get(normalize(row.getAttribute('data-id')));
            decorateNative(row, ep);
            if (!list && row.getAttribute('data-type') === 'Episode') list = row.closest('.itemsContainer');
        });
        syncDrawnRows(page, status, ctx, list, season?.rows?.displayMissing ? (parts.drawn || new Set()) : new Set(), byNumber);
        decorateBanner(parts.banner, status);
        syncNote(page, parts.banner ? null : list, status);
        // Every checked press keeps its semantic origin through all of these renderers.
        focusStable();
    }

    /**
     * The season's one line saying why its missing episodes can't be asked for now ("Paused: storage
     * full" and the family sentence; for administrators where and how much is free), above the episode
     * list. With the banner shown it says it instead (see decorateBanner).
     * @param {HTMLElement} page Season page.
     * @param {HTMLElement|null} list The episode list (null: no line here).
     * @param {Object} status Season status.
     * @returns {void}
     */
    function syncNote(page, list, status) {
        const words = list ? blockedWordsOf((status.episodes || []).filter(ep => offerable(ep) && !shownState(ep)), status) : null;
        const existing = page.querySelector('.je-ask-season-note');
        const signature = words ? `${words.chip}|${words.detail || words.text}` : '';
        if (existing && (!words || existing.dataset.sig !== signature || existing.nextElementSibling !== list)) existing.remove();
        else if (existing) return;
        if (!words) return;
        const note = pausedNote(words, signature);
        note.classList.add('je-ask-season-note');
        list.insertAdjacentElement('beforebegin', note);
    }

    /**
     * A paused line: icon, "Paused: storage full", and the sentence (administrators: where and how much is free).
     * @param {{chip: string, text: string, detail: string}} words Words.
     * @param {string} signature Signature (the line is replaced when it changes).
     * @returns {HTMLElement} Line.
     */
    function pausedNote(words, signature) {
        const note = JE.arrAsk.pausedNote(words);
        note.dataset.sig = signature;
        return note;
    }

    /**
     * One native row: Get it next to its chip, dimmed thumbnail for a missing episode, download ring
     * for a downloading one, and Jellyfin's own missing label hidden when JE's chip says it.
     * @param {HTMLElement} row Native row.
     * @param {Object|undefined} ep Episode status.
     * @returns {void}
     */
    function decorateNative(row, ep) {
        const chipEl = row.querySelector('.je-arr-chip');
        const missing = !!ep && isMissing(ep);
        row.classList.toggle('je-ask-dim', missing);
        // Jellyfin's red "Missing" (or "Unaired") label on its own virtual rows: JE's chip says it now.
        const virtual = !!row.querySelector('.missingIndicator, .unairedIndicator');
        row.classList.toggle('je-ask-native-label-off', !!chipEl && virtual);
        if (virtual && ep) syncMeta(row, ep);
        syncRing(row.querySelector('.listItemImage'), ep);
        syncGetIt(chipEl, ep, row);
    }

    /**
     * Jellyfin's rows for missing episodes print no runtime or air date: add them (from the season
     * read) at the start of the row's info line, like the rows of episodes that are here.
     * @param {HTMLElement} row Native virtual row.
     * @param {Object} ep Episode status.
     * @returns {void}
     */
    function syncMeta(row, ep) {
        const line = row.querySelector('.listItemMediaInfo');
        if (!line || line.querySelector('.mediaInfoItem:not(.je-ask-meta)')) return;
        const meta = metaOf(ep.episode) || {};
        const parts = [meta.runtime ? `${meta.runtime}m` : '', longDate(meta.airDate || ep.airDate || '')].filter(Boolean);
        const signature = parts.join('|');
        const existing = [...line.querySelectorAll('.je-ask-meta')];
        if (existing.map(n => n.textContent).join('|') === signature) return;
        existing.forEach(n => n.remove());
        for (const text of parts.reverse()) line.insertBefore(JE.arrStatus.el('div', 'mediaInfoItem je-ask-meta', text), line.firstChild);
    }

    /**
     * Puts (or removes) the Get it button right after a chip.
     * @param {HTMLElement|null} chipEl The chip.
     * @param {Object|undefined} ep Episode status.
     * @param {HTMLElement} scope Row the button belongs to.
     * @returns {void}
     */
    function syncGetIt(chipEl, ep, scope) {
        // On TV a row is one focus target (Jellyfin's own rows are buttons there): Get it lives in the
        // episode's dialog (JE rows) or on the episode's page (Jellyfin's rows), never inside a row.
        const open = !!chipEl && !!ep && offerable(ep) && !shownState(ep) && !chipEl.classList.contains('je-arr-chip-overlay') && !isTv();
        const placeable = open && offered(ep);
        const outcome = placeable ? searchedOutcome(ep.episode) : null;
        const want = placeable && !outcome;
        const existing = scope.querySelector(`.je-ask-get[data-je-ask-episode="${ep?.episode}"]`) || scope.querySelector('.je-ask-get');
        syncSearched(chipEl, scope, outcome);
        syncPaused(chipEl, scope, open && !placeable ? blockedWords(editionOf([ep])) : null);
        if (!want) {
            if (existing && !busy.has(Number(existing.dataset.jeAskEpisode))) existing.remove();
            return;
        }
        if (existing && existing.previousElementSibling === chipEl && existing.dataset.mode === modeOf(ep) && existing.dataset.label === labelOf(modeOf(ep)) && existing.dataset.intent === rowIntent(ep)) {
            setBusyLook(existing, busy.has(ep.episode));
            return;
        }
        if (existing) existing.remove();
        chipEl.insertAdjacentElement('afterend', getItButton(ep));
    }

    /**
     * Whether an episode's button asks for it (Get it) or searches for it (Search: monitored and
     * missing for a long while, see JE.arrStatus.searchable); null for a copy's gap nothing reaches.
     * @param {Object} ep Episode status.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {'get'|'search'|null} Mode.
     */
    function modeOf(ep, status) {
        let mode = 'search';
        if (!JE.arrStatus?.searchable?.(ep)) mode = 'get';
        // Seerr mode: someone else's Search that would turn into an ask (nothing sent for the episode yet) asks for the
        // season instead, and its button says so.
        else if (rounded() && !adminSearchable(ep, status) && ep?.reason?.params?.sent !== '1') mode = 'get';
        // A copy's own gap: only what reaches that copy (null: no button).
        return reach(bindingOf([ep], status), mode, [ep], status);
    }

    /**
     * What an episode's own button does ({@link intentOf}); empty when it gets none.
     * @param {Object|undefined} ep Episode status.
     * @param {Object|null} [status] Season status (default: the one shown).
     * @returns {string} Intent.
     */
    function rowIntent(ep, status) {
        if (!ep || !offerable(ep) || !offered(ep, status)) return '';
        return intentOf(modeOf(ep, status), [ep], status || season?.statusRef || null, ep.key);
    }

    /**
     * The label of an episode's button: Search, Get it, or (Seerr mode) the season it asks for.
     * @param {'get'|'search'} mode Mode.
     * @returns {string} Label.
     */
    function labelOf(mode) {
        if (mode === 'search') return tr('arr_ask_search');
        return rounded() ? roundedWords().label : tr('arr_ask_get_it');
    }

    /**
     * The outcome of an administrator's recent Search for an episode, while it is fresh.
     * @param {number} episode Episode number.
     * @returns {{chip: string, tone: string, at: number}|null} Outcome.
     */
    function searchedOutcome(episode) {
        const entry = searched.get(episode);
        if (!entry) return null;
        if (Date.now() - entry.at > SEARCHED_TTL_MS) {
            searched.delete(episode);
            return null;
        }
        return entry;
    }

    /**
     * Shows (or removes) "Paused: storage full" right after a chip, where Get it would be.
     * @param {HTMLElement|null} chipEl The chip.
     * @param {HTMLElement} scope Row.
     * @param {{chip: string, text: string, detail: string}|null} words Block words, or null for none.
     * @returns {void}
     */
    function syncPaused(chipEl, scope, words) {
        const existing = scope.querySelector('.je-ask-paused');
        if (!words || !chipEl) {
            if (existing) existing.remove();
            return;
        }
        const sig = `${words.chip}|${words.detail || words.text}`;
        if (existing && existing.previousElementSibling === chipEl && existing.dataset.sig === sig) return;
        if (existing) existing.remove();
        const note = JE.arrStatus.el('span', 'je-arr-chip je-ask-paused je-arr-tone-attention', words.chip);
        note.dataset.sig = sig;
        note.title = words.detail || words.text;
        note.setAttribute('aria-label', `${words.chip}. ${words.detail || words.text}`);
        chipEl.insertAdjacentElement('afterend', note);
    }

    /**
     * Shows (or removes) a Search outcome right after a chip ("Nothing found yet · searched just now").
     * @param {HTMLElement|null} chipEl The chip.
     * @param {HTMLElement} scope Row.
     * @param {{chip: string, tone: string}|null} outcome Outcome, or null for none.
     * @returns {void}
     */
    function syncSearched(chipEl, scope, outcome) {
        const existing = scope.querySelector('.je-ask-searched');
        if (!outcome || !chipEl) {
            if (existing) existing.remove();
            return;
        }
        if (existing && existing.previousElementSibling === chipEl && existing.textContent === outcome.chip) return;
        if (existing) existing.remove();
        const note = JE.arrStatus.el('span', `je-arr-chip je-ask-searched je-arr-tone-${outcome.tone}`, outcome.chip);
        note.tabIndex = -1;
        chipEl.insertAdjacentElement('afterend', note);
    }

    /**
     * The episodes a press reserves: its own, or every episode of the season for an ask Seerr takes as the whole season.
     * @param {number[]} numbers The control's episodes.
     * @param {HTMLElement} button The control.
     * @returns {number[]} Episode numbers.
     */
    function pressScope(numbers, button) {
        if (button?.dataset.rounded !== '1') return numbers;
        return [...new Set([...numbers, ...(season?.rows?.episodes || []).map(e => e.episode)])];
    }

    /**
     * A Get it button for one episode.
     * @param {Object} ep Episode status.
     * @returns {HTMLButtonElement} Button.
     */
    function getItButton(ep) {
        const S = JE.arrStatus;
        const mode = modeOf(ep);
        const binding = bindingOf([ep]);
        const btn = S.el('button', `je-ask-get${mode === 'search' ? ' je-ask-search' : ''}`);
        btn.type = 'button';
        btn.dataset.jeAskEpisode = String(ep.episode);
        btn.dataset.jeFocus = `ask-get-${ep.episode}`;
        btn.dataset.mode = mode;
        btn.dataset.intent = rowIntent(ep);
        btn.dataset.label = labelOf(mode);
        if (mode === 'search') btn.dataset.busyLabel = tr('arr_ask_searching');
        btn.appendChild(S.icon(mode === 'search' ? 'search' : 'add', 'je-ask-get-icon'));
        btn.appendChild(S.el('span', 'je-ask-get-text', btn.dataset.label));
        const meta = metaOf(ep.episode);
        const title = meta?.title || tr('arr_ask_episode_title', { episode: ep.episode });
        if (mode === 'get' && rounded()) {
            // Seerr mode: the button says it asks for the whole season (never rounded up behind the person's back).
            const words = roundedWords();
            btn.dataset.rounded = '1';
            btn.title = words.note;
            btn.setAttribute('aria-label', `${words.label}. ${words.note}`);
        } else if (binding) {
            btn.setAttribute('aria-label', tr(mode === 'search' ? 'arr_ask_search_in_copy_label' : 'arr_ask_get_it_in_copy_label', { episode: ep.episode, title, copy: S.copyPhrase(binding.role) }));
        } else {
            btn.setAttribute('aria-label', tr(mode === 'search' ? 'arr_ask_search_label' : 'arr_ask_get_it_label', { episode: ep.episode, title }));
        }
        // The button asks for this season's episode only, even if another season is shown by the
        // time it is pressed (a dialog left open across a navigation); a copy's gap in that copy's edition.
        const scope = season?.itemId || null;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (scope && season?.itemId !== scope) return;
            // Checked at the press: the episode's button as the server and the caller's capabilities say now; the server is sent
            // what it was drawn to do and works it out again.
            const now = fresh => rowIntent((fresh.episodes || []).find(x => x.episode === ep.episode), fresh);
            act(btn, pressScope([ep.episode], btn), now, (intent, origin) => (mode === 'search' ? searchEpisode(ep, btn, scope, intent, origin) : getEpisodes([ep.episode], btn, false, scope, binding?.variant, intent, origin)));
        });
        setBusyLook(btn, busy.has(ep.episode));
        return btn;
    }

    /**
     * Shows a button as busy (Asking…) or ready.
     * @param {HTMLButtonElement} btn Button.
     * @param {boolean} on Busy.
     * @returns {void}
     */
    function setBusyLook(btn, on) {
        btn.disabled = on;
        btn.setAttribute('aria-busy', String(on));
        const text = btn.querySelector('.je-ask-get-text');
        const label = btn.dataset.label || tr('arr_ask_get_it');
        if (text) text.textContent = on ? (btn.dataset.busyLabel || tr('arr_ask_asking')) : label;
    }

    /**
     * Search for an episode missing for a long while. An administrator's Search runs the arr's own
     * search for that episode right away (Searching…, then what it found, in place of the button).
     * Everyone else's runs it too when requests already sent the episode (no new request); otherwise
     * they ask for the episode like Get it (the request backend turns that into a search).
     * @param {Object} ep Episode status.
     * @param {HTMLButtonElement} button The button pressed.
     * @param {string|null} [scope] The season the button was made for (nothing happens on another).
     * @param {Object|null} [intent] What the press was drawn to do ({@link pressOf}): sent for the server to work out again.
     * @returns {Promise<void>}
     */
    async function searchEpisode(ep, button, scope, intent, origin) {
        // The Search's origin (the click): the search, the ask it falls back to and what they show, in that session only.
        origin = JE.core.userWrite.originOf(origin);
        const current = () => JE.core.userWrite.isBound(origin);
        const target = season;
        if (!target?.rows || busy.has(ep.episode) || (scope && target.itemId !== scope)) return;
        // Capabilities are read for this session: a sign-out (and someone else's sign-in) before
        // they arrive drops the Search instead of running it with the next person's token (the click's origin is checked too).
        const started = JE.arrAsk.epoch();
        const caps = await JE.arrAsk.me();
        // The same season read again meanwhile is the same season (by its key); another one shown: the control is gone.
        if (!current() || JE.arrAsk.epoch() !== started || season?.itemId !== target.itemId) return;
        const binding = bindingOf([ep], target.statusRef);
        const instanceId = intent ? intent.instance : adminInstance([ep], target.statusRef, ep.key, caps);
        busy.add(ep.episode);
        JE.internals?.arrStatusEpisodes?.apply?.();
        let result;
        try {
            // A household Search runs on the standard request target: never for a copy it doesn't reach. Under a copy's
            // binding without its administrator's instance or a household Search that reaches it, nothing runs (no other
            // edition or instance in its place): the controls are drawn again.
            result = instanceId ? await JE.arrAsk.adminSearch(ep.key, instanceId, { expect: intent, session: origin }) : (!binding || binding.search) ? await JE.arrAsk.familySearch(ep.key, { expect: intent, session: origin }) : null;
        } finally {
            busy.delete(ep.episode);
        }
        if (!current() || JE.arrAsk.epoch() !== started || result?.stale) return;
        if (result && pressRefusal(result)) return;
        if (!result) {
            // Nothing sent for it yet (or not missing for long enough): a household Search asks for it like Get it, in the
            // edition of its binding, only while that ask reaches the copy (as this click's).
            if (season?.itemId !== target.itemId) return;
            if (!instanceId && (!binding || (binding.search && binding.ask))) await getEpisodes([ep.episode], button, true, target.itemId, binding?.variant, intent ? { ...intent, mode: 'get', dest: binding?.dest || null, instance: null } : null, origin);
            else JE.internals?.arrStatusEpisodes?.apply?.();
            return;
        }
        const stillHere = !!season && season.itemId === target.itemId;
        if (stillHere && result.chip) searched.set(ep.episode, { chip: result.chip, tone: result.tone, at: Date.now() });
        announce(result.text);
        JE.arrAsk.toast(result.text);
        if (!stillHere) return;
        JE.internals?.arrStatusEpisodes?.apply?.();
    }

    /**
     * Asks for episodes of this season (Get it / Get them, or Search for people who ask) and shows
     * the answer honestly.
     * @param {number[]} episodes Episode numbers.
     * @param {HTMLButtonElement} button The button pressed (focus goes to the new chip after).
     * @param {boolean} [search] The ask is a Search (its state then shows for a while only).
     * @param {string|null} [scope] The season the button was made for (nothing is asked on another).
     * @param {string|null} [variant] The edition asked for (a copy's binding; default standard).
     * @param {Object|null} [intent] What the press was drawn to do ({@link pressOf}): the ask is exactly that (a whole-series
     * ask only when it was drawn as one, never widened at the press), and the server is sent it to work out again.
     * @param {any} [origin] The click's origin (a Search falling back to this passes its own).
     * @returns {Promise<void>}
     */
    async function getEpisodes(episodes, button, search, scope, variant, intent, origin) {
        origin = JE.core.userWrite.originOf(origin);
        const current = () => JE.core.userWrite.isBound(origin);
        const target = season;
        const rows = target?.rows;
        if (!rows || !episodes.length || episodes.some(n => busy.has(n)) || (scope && target.itemId !== scope)) return;
        // Seerr mode: the button asks for the whole season, so every episode of it waits for the answer.
        const affected = rounded() ? [...new Set([...episodes, ...(rows.episodes || []).map(e => e.episode)])] : episodes;
        affected.forEach(n => busy.add(n));
        JE.internals?.arrStatusEpisodes?.apply?.();
        const started = JE.arrAsk.epoch();
        let result = null;
        try {
            const caps = await JE.arrAsk.me();
            let input = JE.arrAsk.episodesInput(rows.series, episodes.map(episode => ({ season: rows.season, episode })), variant || 'standard');
            if (JE.arrAsk.seasonsOnly?.(caps)) {
                if (season?.itemId === target.itemId && !season.caps) season.caps = caps;
                // Seerr takes whole seasons: only a button that said so asks for the season, and for exactly what it was drawn
                // to ask for (this season, or the whole series when it was drawn as that: never widened by what Seerr says at
                // the press, which the server checks); any other (a Search that would turn into an ask, a button drawn before the
                // caller's capabilities were known) asks for nothing and says why, and the buttons are drawn again.
                const rounded = button?.dataset.rounded === '1';
                const whole = intent ? !!intent.whole : JE.arrAsk.wholeSeriesOnly?.(caps);
                input = !rounded ? null : whole ? await JE.arrAsk.wholeSeriesInput(rows.series, variant || 'standard') : JE.arrAsk.seasonsInput(rows.series, [rows.season], variant || 'standard');
                if (!input) result = { ok: false, state: rounded ? 'failed' : 'blocked', reason: 'seerr_whole_season_only' };
            }
            const expect = intent ? { ...intent, mode: 'get', episodes: [...episodes].sort((a, b) => a - b), seasons: input?.scope === 'seasons' ? input.seasons : intent.seasons } : null;
            if (!result && JE.arrAsk.epoch() === started && current()) result = await JE.arrAsk.ask(input, expect ? { expect, session: origin } : { session: origin });
        } finally {
            affected.forEach(n => busy.delete(n));
        }
        // Answered after a sign-out: the next person is not told about it.
        if (!result || result.stale || JE.arrAsk.epoch() !== started || !current()) return;
        if (pressRefusal(result)) return;
        const caps = await JE.arrAsk.me();
        const allowance = result.state === 'quota' ? await JE.arrAsk.quota('tv') : null;
        // These reads waited too: shown in the ask's session only.
        if (!current()) return;
        const words = JE.arrAsk.describe(result, caps, allowance);
        // The same season page is still shown (the ask itself makes the page read the season again).
        const stillHere = !!season && season.itemId === target.itemId;
        if (result.ok || result.state === 'unknown') {
            const shown = result.state === 'waiting' ? 'waiting' : result.state === 'nothing' ? null : result.state === 'declined' ? 'declined' : 'asked';
            if (shown && stillHere) affected.forEach(n => local.set(n, { state: shown, at: Date.now(), search: !!search }));
        }
        announce(words.text);
        JE.arrAsk.toast(words.text);
        if (stillHere) {
            JE.internals?.arrStatusEpisodes?.apply?.();
            // The server's truth is read again through JE.arrAsk.onChange (see initialize).
        }
    }

    /**
     * The server refused a press (D53, edition round 19): it no longer does what it was drawn to do, or it couldn't be checked.
     * Nothing was sent: the page is drawn again and the person told. False for any other answer.
     * @param {Object} result The answer ({@link JE.arrAsk.ask}, adminSearch or familySearch).
     * @returns {boolean} It was a press refusal.
     */
    function pressRefusal(result) {
        if (result?.reason !== 'press_changed' && result?.reason !== 'press_unverified') return false;
        refused(tr(result.reason === 'press_unverified' ? 'arr_ask_check_failed' : 'arr_ask_changed'));
        return true;
    }

    /**
     * Announces a result to screen readers (polite live region).
     * @param {string} text Text.
     * @returns {void}
     */
    function announce(text) {
        let region = document.getElementById('je-ask-live');
        if (!region) {
            region = document.createElement('div');
            region.id = 'je-ask-live';
            region.className = 'je-ask-sr';
            region.setAttribute('role', 'status');
            region.setAttribute('aria-live', 'polite');
            document.body.appendChild(region);
        }
        region.textContent = '';
        setTimeout(() => { region.textContent = text || ''; }, 50);
    }

    /**
     * Server metadata of one episode (title, overview, runtime, air date, still), or null.
     * @param {number} episode Episode number.
     * @returns {Object|null} Metadata.
     */
    function metaOf(episode) {
        return (season?.rows?.episodes || []).find(e => e.episode === episode) || null;
    }

    /**
     * Puts the download ring on a thumbnail while the episode downloads (removes it otherwise).
     * @param {HTMLElement|null} image Thumbnail element.
     * @param {Object|undefined} ep Episode status.
     * @returns {void}
     */
    function syncRing(image, ep) {
        if (!image) return;
        const downloading = !!ep && ep.stage === 'downloading' && !ep.attention;
        const pct = typeof ep?.progress?.percent === 'number' ? Math.round(ep.progress.percent) : null;
        let holder = image.querySelector('.je-ask-ring');
        if (!downloading) {
            if (holder) holder.remove();
            return;
        }
        if (holder && holder.dataset.pct === String(pct)) return;
        if (holder) holder.remove();
        holder = document.createElement('div');
        holder.className = 'je-ask-ring';
        holder.dataset.pct = String(pct);
        holder.appendChild(JE.arrStatus.buildBadge({ stage: 'downloading', progress: pct == null ? undefined : { percent: pct } })?.querySelector('.je-arr-ring') || document.createElement('span'));
        holder.setAttribute('role', 'img');
        holder.setAttribute('aria-label', pct == null ? tr('arr_chip_downloading') : tr('arr_chip_downloading_pct', { pct }));
        image.appendChild(holder);
    }

    /**
     * Keeps JE's drawn rows in the list: one per drawn episode, in episode order among the native
     * rows; removes rows that are no longer needed (Jellyfin made its own, or the episode arrived).
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {Object} ctx Response context.
     * @param {HTMLElement|null} list The episode list.
     * @param {Set<number>} wanted Episodes to draw.
     * @param {Map<number, Object>} byNumber Episode statuses by number.
     * @returns {void}
     */
    function syncDrawnRows(page, status, ctx, list, wanted, byNumber) {
        page.querySelectorAll('.je-ask-row').forEach((row) => {
            const n = Number(row.dataset.jeAskEpisode);
            if (!list || !wanted.has(n) || row.parentNode !== list) row.remove();
        });
        if (!list || !wanted.size) return;
        // Episode numbers of the native rows, to place JE's rows between them.
        const natives = [];
        list.querySelectorAll(':scope > .listItem[data-id]').forEach((row) => {
            const id = normalize(row.getAttribute('data-id'));
            const ep = (status.episodes || []).find(e => e.itemId && normalize(e.itemId) === id);
            if (ep) natives.push({ n: ep.episode, row });
        });
        for (const n of [...wanted].sort((a, b) => a - b)) {
            const ep = byNumber.get(n);
            if (!ep) continue;
            let row = list.querySelector(`:scope > .je-ask-row[data-je-ask-episode="${n}"]`);
            const signature = rowSignature(ep);
            if (row && row.dataset.sig !== signature) {
                const hadFocus = row.contains(document.activeElement);
                const replacement = buildRow(ep, ctx);
                row.replaceWith(replacement);
                row = replacement;
                // Keyboard and TV users stay on the row they were on.
                if (hadFocus) (row.matches('button') ? row : row.querySelector('.je-ask-row-title'))?.focus();
            } else if (!row) {
                row = buildRow(ep, ctx);
            }
            const after = natives.filter(x => x.n < n).pop();
            const drawnBefore = [...list.querySelectorAll(':scope > .je-ask-row')].filter(r => Number(r.dataset.jeAskEpisode) < n && r !== row).pop();
            const anchor = [after?.row, drawnBefore].filter(Boolean).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).pop();
            if (anchor) {
                if (anchor.nextElementSibling !== row) anchor.insertAdjacentElement('afterend', row);
            } else if (list.firstElementChild !== row) {
                list.insertBefore(row, list.firstElementChild);
            }
            placeChip(row);
            syncRing(row.querySelector('.listItemImage'), ep);
            syncGetIt(row.querySelector('.je-arr-chip'), ep, row);
        }
    }

    /**
     * Phone layouts hide a row's info line (as Jellyfin does for its own rows): the chip then moves to
     * a line of its own above the overview, like the phase-1 chips on native rows.
     * @param {HTMLElement} row JE row.
     * @returns {void}
     */
    function placeChip(row) {
        const line = row.querySelector('.listItemMediaInfo');
        const chipEl = row.querySelector('.je-arr-chip');
        if (!line || !chipEl) return;
        const lineShown = getComputedStyle(line).display !== 'none';
        let holder = row.querySelector('.je-arr-chip-row');
        if (lineShown) {
            if (chipEl.parentNode !== line) line.appendChild(chipEl);
            if (holder) holder.remove();
            return;
        }
        if (!holder) {
            holder = document.createElement('div');
            holder.className = 'je-arr-chip-row';
            const below = row.querySelector('.listItem-bottomoverview');
            if (below) row.insertBefore(holder, below);
            else row.appendChild(holder);
        }
        if (chipEl.parentNode !== holder) holder.appendChild(chipEl);
    }

    /**
     * What a drawn row shows (it is rebuilt when this changes).
     * @param {Object} ep Episode status.
     * @returns {string} Signature.
     */
    function rowSignature(ep) {
        const meta = metaOf(ep.episode);
        const c = chip(ep);
        return [ep.stage, ep.reason?.code, ep.progress?.percent, c?.text || JE.arrStatus.chipText(ep), meta?.title, meta?.still, JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId) ? 's' : '', isTv() ? 'tv' : ''].join('|');
    }

    /**
     * Builds a JE row for an episode Jellyfin has no row for, with the native row's classes so it
     * looks the same (number and title, runtime, air date, chip, overview, thumbnail). The row is
     * not a Jellyfin item: clicks stay inside it; its title opens the episode's status details.
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @returns {HTMLElement} Row.
     */
    function buildRow(ep, ctx) {
        const S = JE.arrStatus;
        const meta = metaOf(ep.episode) || {};
        const spoiler = !!JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId);
        const title = meta.title || tr('arr_ask_episode_title', { episode: ep.episode });
        if (isTv()) return buildTvRow(ep, ctx, meta, title, spoiler);
        const row = S.el('div', 'listItem listItem-largeImage listItem-withContentWrapper je-ask-row');
        row.dataset.jeAskEpisode = String(ep.episode);
        row.dataset.sig = rowSignature(ep);
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', isMissing(ep) ? tr('arr_ask_row_missing_label', { episode: ep.episode }) : `${ep.episode}. ${title}`);
        if (isMissing(ep)) row.classList.add('je-ask-dim');
        // Jellyfin's list handles clicks, long presses and context menus of its items by delegation:
        // this row is not an item, so none of that may reach it.
        for (const type of ['click', 'contextmenu', 'mousedown', 'pointerdown', 'touchstart', 'keydown']) {
            row.addEventListener(type, (e) => e.stopPropagation());
        }
        const content = S.el('div', 'listItem-content');
        const image = S.el('div', 'listItemImage listItemImage-large je-ask-row-image');
        const still = typeof meta.still === 'string' && STILL.test(meta.still) ? meta.still : null;
        if (still) image.style.backgroundImage = `url("https://image.tmdb.org/t/p/w300${still}")`;
        else image.appendChild(S.icon('tv', 'je-ask-row-placeholder'));
        if (spoiler) image.classList.add('je-ask-row-spoiler');
        image.addEventListener('click', () => openDetails(ep, ctx));
        content.appendChild(image);

        const body = S.el('div', 'listItemBody je-ask-row-body');
        const heading = S.el('div', 'listItemBodyText');
        const open = S.el('button', 'je-ask-row-title');
        open.type = 'button';
        open.dataset.jeFocus = `ask-row-${ep.episode}`;
        const bdi = document.createElement('bdi');
        bdi.textContent = `${ep.episode}. ${title}`;
        open.appendChild(bdi);
        open.title = tr('arr_ask_row_open', { episode: ep.episode });
        open.addEventListener('click', () => openDetails(ep, ctx));
        heading.appendChild(open);
        body.appendChild(heading);

        const info = S.el('div', 'secondary listItemMediaInfo listItemBodyText');
        if (meta.runtime) info.appendChild(S.el('div', 'mediaInfoItem', `${meta.runtime}m`));
        const air = meta.airDate || ep.airDate;
        const airText = air ? longDate(air) : '';
        if (airText) info.appendChild(S.el('div', 'mediaInfoItem', airText));
        const c = chip(ep);
        const chipEl = S.el('span', `je-arr-chip je-arr-tone-${c?.tone || (ep.attention ? 'attention' : ep.stage)}`, c?.text || S.chipText(ep));
        chipEl.dataset.jeArrKey = ep.key || '';
        info.appendChild(chipEl);
        body.appendChild(info);

        if (meta.overview && !spoiler) {
            const overview = S.el('div', 'secondary listItem-overview listItemBodyText');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            overview.appendChild(text);
            body.appendChild(overview);
        }
        content.appendChild(body);

        const buttons = S.el('div', 'listViewUserDataButtons');
        const infoButton = S.el('button', 'listItemButton paper-icon-button-light je-ask-row-info');
        infoButton.type = 'button';
        infoButton.title = tr('arr_ask_row_open', { episode: ep.episode });
        infoButton.setAttribute('aria-label', tr('arr_ask_row_open', { episode: ep.episode }));
        infoButton.appendChild(S.icon('info_outline'));
        infoButton.addEventListener('click', () => openDetails(ep, ctx));
        buttons.appendChild(infoButton);
        content.appendChild(buttons);
        row.appendChild(content);

        if (meta.overview && !spoiler) {
            const bottom = S.el('div', 'listItem-bottomoverview secondary');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            bottom.appendChild(text);
            row.appendChild(bottom);
        }
        return row;
    }

    /**
     * The TV layout's row: one button like Jellyfin's own TV rows (thumbnail, number and title, info
     * line with the chip, overview); selecting it opens the episode's dialog, which holds Get it.
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @param {Object} meta Season-read metadata.
     * @param {string} title Title.
     * @param {boolean} spoiler Spoiler Guard protects the series.
     * @returns {HTMLButtonElement} Row.
     */
    function buildTvRow(ep, ctx, meta, title, spoiler) {
        const S = JE.arrStatus;
        const row = S.el('button', 'listItem listItem-button listItem-focusscale listItem-largeImage je-ask-row');
        row.type = 'button';
        row.dataset.jeAskEpisode = String(ep.episode);
        row.dataset.sig = rowSignature(ep);
        row.dataset.jeFocus = `ask-row-${ep.episode}`;
        if (isMissing(ep)) row.classList.add('je-ask-dim');
        for (const type of ['contextmenu', 'mousedown', 'pointerdown', 'touchstart']) row.addEventListener(type, (e) => e.stopPropagation());
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            openDetails(ep, ctx);
        });
        const image = S.el('div', 'listItemImage listItemImage-large listItemImage-large-tv je-ask-row-image');
        const still = typeof meta.still === 'string' && STILL.test(meta.still) ? meta.still : null;
        if (still) image.style.backgroundImage = `url("https://image.tmdb.org/t/p/w300${still}")`;
        else image.appendChild(S.icon('tv', 'je-ask-row-placeholder'));
        if (spoiler) image.classList.add('je-ask-row-spoiler');
        row.appendChild(image);
        const body = S.el('div', 'listItemBody');
        const heading = S.el('h2', 'listItemBodyText');
        const bdi = document.createElement('bdi');
        bdi.textContent = `${ep.episode}. ${title}`;
        heading.appendChild(bdi);
        body.appendChild(heading);
        const info = S.el('div', 'secondary listItemMediaInfo listItemBodyText');
        if (meta.runtime) info.appendChild(S.el('div', 'mediaInfoItem', `${meta.runtime}m`));
        const airText = longDate(meta.airDate || ep.airDate || '');
        if (airText) info.appendChild(S.el('div', 'mediaInfoItem', airText));
        const c = chip(ep);
        const chipEl = S.el('span', `je-arr-chip je-arr-tone-${c?.tone || (ep.attention ? 'attention' : ep.stage)}`, c?.text || S.chipText(ep));
        chipEl.dataset.jeArrKey = ep.key || '';
        info.appendChild(chipEl);
        body.appendChild(info);
        if (meta.overview && !spoiler) {
            const overview = S.el('div', 'secondary listItem-overview listItemBodyText');
            const text = document.createElement('bdi');
            text.textContent = meta.overview;
            overview.appendChild(text);
            body.appendChild(overview);
        }
        row.appendChild(body);
        row.appendChild(S.el('div', 'listViewUserDataButtons'));
        return row;
    }

    /**
     * A date as the native rows print it ("29 Jun 2014").
     * @param {string} iso ISO date or yyyy-MM-dd.
     * @returns {string} Text.
     */
    function longDate(iso) {
        const d = JE.arrStatus.parseDate(String(iso).slice(0, 10));
        return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    }

    /**
     * What the banner offers for a season status: its missing episodes, their shown states, the ones left open, and the
     * button's episodes, copy binding and mode (null: no button). The banner is drawn from it, and its button checked
     * against it again at click ({@link checkAtClick}).
     * @param {Object} status Season status.
     * @returns {{missingEps: Array<Object>, states: Map<number, string|null>, lookingEps: Array<Object>, openEps: Array<Object>, offerEps: Array<Object>, binding: Object|null, mode: 'get'|'search'|null, intent: string}} Plan.
     */
    function bannerPlan(status) {
        const missingEps = JE.internals.arrStatusEpisodes.bannerEntries(status).missing.filter(isMissing);
        const states = new Map(missingEps.map(ep => [ep.episode, shownState(ep)]));
        // Monitored episodes the arr is looking for right now: nothing to ask for, the banner says so.
        const lookingEps = missingEps.filter(ep => !states.get(ep.episode) && !offerable(ep));
        const openEps = missingEps.filter(ep => !states.get(ep.episode) && offerable(ep));
        // What the button is for: every episode left when the viewer may ask; otherwise an administrator's Search
        // for the ones missing for a long while (it runs whatever the request policy says).
        const candidates = openEps.filter(ep => canAsk(editionOf([ep], status)) || adminSearchable(ep, status));
        // Some of them another copy the viewer can open plays: the button acts for that copy, says which, and is offered under
        // its name only when its action reaches it (one binding decides wording and action); otherwise only the episodes no
        // copy has get the plain button.
        let offerEps = candidates;
        let binding = bindingOf(offerEps, status);
        const modes = eps => (eps.length > 0 && eps.every(ep => modeOf(ep, status) === 'search') ? 'search' : 'get');
        let mode = offerEps.length ? reach(binding, modes(offerEps), offerEps, status) : null;
        if (binding && !mode) {
            offerEps = candidates.filter(ep => !ep.copyGap);
            binding = null;
            mode = offerEps.length ? modes(offerEps) : null;
        }
        if (!mode) offerEps = [];
        const key = offerEps.length === 1 ? offerEps[0].key : status.key;
        return { missingEps, states, lookingEps, openEps, offerEps, binding, mode, intent: intentOf(mode, offerEps, status, key) };
    }

    /**
     * The banner (viewer doesn't show missing episodes as rows): the request state of each missing
     * episode already asked for ("E4 · Waiting for OK"), and Get them (or "Get E8" for one) for the rest.
     * @param {HTMLElement|null} banner Banner.
     * @param {Object} status Season status.
     * @returns {void}
     */
    function decorateBanner(banner, status) {
        if (!banner) return;
        const S = JE.arrStatus;
        const plan = bannerPlan(status);
        const { missingEps, states, lookingEps, openEps, offerEps, binding } = plan;
        const missing = missingEps.map(ep => ep.episode);
        const open = openEps.map(ep => ep.episode);
        const looking = lookingEps.map(ep => ep.episode);
        const asked = missing.filter(n => states.get(n));
        const offer = offerEps.map(ep => ep.episode);
        // Every episode offered is monitored and missing for a long while (and the Search reaches them): the button searches.
        const search = plan.mode === 'search';
        // Seerr mode: Get them asks for the whole season, and says so.
        const seasonWords = !search && rounded() ? roundedWords() : null;
        const gap = binding?.role || null;
        const copy = gap ? { name: S.copyName(gap), phrase: S.copyPhrase(gap) } : null;
        if (bannerSearched && (bannerSearched.itemId !== normalize(status.itemId) || Date.now() - bannerSearched.at > SEARCHED_TTL_MS)) bannerSearched = null;
        const outcome = search ? bannerSearched : null;
        // Asking can't be done now: the banner says why (administrators: where and how much is free).
        const words = open.length ? blockedWordsOf(openEps, status) : null;
        // A season of a title that isn't in the library (native details) with every aired episode
        // still open: its page's "Get Season N" asks for exactly that, so the banner doesn't repeat it.
        const wholeSeason = !search && !asked.length && open.length > 0 && open.length === (status.summary?.aired || -1)
            && !!JE.titleDetails?.isSynthetic?.(status.itemId);
        let action = banner.querySelector('.je-ask-banner-action');
        const signature = `${open.join(',')}|${looking.join(',')}|${offer.join(',')}|${asked.map(n => `${n}:${states.get(n)}`).join(',')}|${canAsk('standard')}:${canAsk('4k')}|${missing.some(n => busy.has(n))}|${search}|${outcome?.chip || ''}|${words ? words.chip + (words.detail || words.text) : ''}|${wholeSeason}|${seasonWords?.label || ''}|${gap || ''}:${binding?.variant || ''}:${binding?.ask ? 1 : 0}:${binding?.search ? 1 : 0}:${binding?.instanceId || ''}|${plan.intent}`;
        if (action && action.dataset.sig === signature) return;
        if (action) action.remove();
        if (!missing.length) return;
        action = S.el('div', 'je-ask-banner-action');
        action.dataset.sig = signature;
        for (const n of asked) {
            const shown = chipForState(states.get(n));
            if (shown) action.appendChild(S.el('span', `je-arr-chip je-arr-tone-${shown.tone}`, `E${n} · ${shown.text}`));
        }
        // Every episode listed is being looked for: one chip says so; otherwise each one that is says it.
        if (looking.length > 1 && looking.length === missing.length) action.appendChild(S.el('span', 'je-arr-chip je-arr-tone-looking', tr('arr_chip_looking')));
        else for (const n of looking) action.appendChild(S.el('span', 'je-arr-chip je-arr-tone-looking', `E${n} · ${tr('arr_chip_looking')}`));
        if (outcome) {
            const note = S.el('span', `je-arr-chip je-ask-searched je-arr-tone-${outcome.tone}`, outcome.chip);
            note.tabIndex = -1;
            action.appendChild(note);
        } else if (offer.length && !wholeSeason) {
            const btn = S.el('button', `je-ask-get je-ask-get-many${search ? ' je-ask-search' : ''}`);
            btn.type = 'button';
            btn.dataset.jeFocus = 'ask-get-them';
            if (search) {
                btn.dataset.label = copy
                    ? (offer.length === 1 ? tr('arr_ask_search_one_in_copy', { episode: offer[0], copy: copy.name }) : tr('arr_ask_search_in_copy', { copy: copy.name }))
                    : (offer.length === 1 ? tr('arr_ask_search_one', { episode: offer[0] }) : tr('arr_ask_search'));
                btn.dataset.busyLabel = tr('arr_ask_searching');
            } else if (seasonWords) {
                btn.dataset.label = seasonWords.label;
                btn.dataset.rounded = '1';
            } else {
                btn.dataset.label = copy
                    ? (offer.length === 1 ? tr('arr_ask_get_one_in_copy', { episode: offer[0], copy: copy.name }) : tr('arr_ask_get_them_in_copy', { copy: copy.name }))
                    : (offer.length === 1 ? tr('arr_ask_get_one', { episode: offer[0] }) : tr('arr_ask_get_them'));
            }
            btn.appendChild(S.icon(search ? 'search' : 'download', 'je-ask-get-icon'));
            btn.appendChild(S.el('span', 'je-ask-get-text', btn.dataset.label));
            const list = offer.map(n => `E${n}`).join(', ');
            if (seasonWords) {
                btn.title = seasonWords.note;
                btn.setAttribute('aria-label', `${seasonWords.label}. ${seasonWords.note}`);
            } else if (copy) {
                btn.setAttribute('aria-label', tr(search ? 'arr_ask_search_them_in_copy_label' : 'arr_ask_get_them_in_copy_label', { copy: copy.phrase, list }));
            } else {
                btn.setAttribute('aria-label', search ? tr('arr_ask_search_them_label', { list }) : tr('arr_ask_get_them_label', { list }));
            }
            const scope = normalize(status.itemId);
            btn.dataset.intent = plan.intent;
            // Checked at the press: the banner's button as the server and the caller's capabilities say now; the server is sent
            // what it was drawn to do and works it out again.
            btn.addEventListener('click', () => {
                if (season?.itemId !== scope) return;
                act(btn, pressScope(offer, btn), fresh => bannerPlan(fresh).intent, (intent, origin) => (search ? searchBanner(offerEps, status, btn, intent, origin) : getEpisodes(offer, btn, false, scope, binding?.variant, intent, origin)));
            });
            setBusyLook(btn, offer.some(n => busy.has(n)));
            action.appendChild(btn);
        }
        if (words) action.appendChild(pausedNote(words, ''));
        if (action.childNodes.length) banner.appendChild(action);
    }

    /**
     * Search from the banner for the season's episodes missing for a long while. An administrator's
     * Search runs the arr's search for that episode (one) or the season (several: the season search
     * looks for exactly its monitored missing episodes) and shows what it found in the banner.
     * Everyone else's searches again for the season's episodes missing for a long while when requests
     * already sent every one of them (one search, no new request); otherwise for the ones requests
     * already sent (one by one, at most ten), and asks for the rest like Get them.
     * @param {Array<Object>} eps Episode statuses.
     * @param {Object} status Season status.
     * @param {HTMLButtonElement} button The button pressed.
     * @param {Object|null} [intent] What the press was drawn to do ({@link pressOf}): sent for the server to work out again.
     * @returns {Promise<void>}
     */
    async function searchBanner(eps, status, button, intent, origin) {
        // The Search's origin (the click): every search of it, the ask it falls back to and what they show, in that
        // session only (a loop never goes on as the next person).
        origin = JE.core.userWrite.originOf(origin);
        const current = () => JE.core.userWrite.isBound(origin);
        const target = season;
        const numbers = eps.map(ep => ep.episode);
        if (!target?.rows || !numbers.length || numbers.some(n => busy.has(n)) || target.itemId !== normalize(status.itemId)) return;
        const key = eps.length === 1 ? eps[0].key : status.key;
        const started = JE.arrAsk.epoch();
        const caps = await JE.arrAsk.me();
        // The same season read again meanwhile is the same season (by its key); another one shown: the control is gone.
        if (!current() || JE.arrAsk.epoch() !== started || season?.itemId !== target.itemId) return;
        const binding = bindingOf(eps, status);
        const instanceId = intent ? intent.instance : key ? adminInstance(eps, status, key, caps) : null;
        numbers.forEach(n => busy.add(n));
        JE.internals?.arrStatusEpisodes?.apply?.();
        let result;
        let toAsk = [];
        try {
            if (instanceId) {
                // Exactly the episodes it names (one EpisodeSearch for several, never the whole season).
                result = await JE.arrAsk.adminSearch(key, instanceId, { episodes: eps.length > 1 ? numbers : undefined, expect: intent, session: origin });
            } else if (binding && !binding.search) {
                // Neither its administrator's instance nor a household Search reaches this copy: nothing runs (no ask in
                // another edition or on another instance in its place); the controls are drawn again below.
                result = null;
            } else {
                // The whole season first: one search for all of them when requests sent every one.
                const whole = eps.length > 1 && status.key ? await JE.arrAsk.familySearch(status.key, { expect: intent, session: origin }) : null;
                if (!current() || JE.arrAsk.epoch() !== started) return;
                const done = whole ? [whole] : [];
                for (const [i, ep] of (whole ? [] : eps).entries()) {
                    const one = i < BANNER_SEARCH_MAX ? await JE.arrAsk.familySearch(ep.key, { expect: intent ? { ...intent, episodes: [ep.episode] } : undefined, session: origin }) : null;
                    if (!current() || JE.arrAsk.epoch() !== started) return;
                    if (one) done.push(one);
                    else toAsk.push(ep.episode);
                    if (one && (one.reason === 'press_changed' || one.reason === 'press_unverified')) break;
                }
                result = done.find(r => r.state === 'found') || done.find(r => r.ok) || done[0] || null;
            }
        } finally {
            numbers.forEach(n => busy.delete(n));
        }
        if (!current() || JE.arrAsk.epoch() !== started) return;
        if (result && pressRefusal(result)) return;
        // A household Search asks for what no request sent yet (like Get them), in the edition of its binding, only while
        // that ask reaches the copy.
        const mayAsk = !instanceId && (!binding || (binding.search && binding.ask));
        const asks = intent ? { ...intent, mode: 'get', dest: binding?.dest || null, instance: null } : null;
        if (!result) {
            if (season?.itemId !== target.itemId) return;
            if (mayAsk) await getEpisodes(numbers, button, true, target.itemId, binding?.variant, asks, origin);
            else JE.internals?.arrStatusEpisodes?.apply?.();
            return;
        }
        // Episodes no request sent yet are asked for like Get them.
        if (mayAsk && toAsk.length && season?.itemId === target.itemId) await getEpisodes(toAsk, null, true, target.itemId, binding?.variant, asks, origin);
        if (!current()) return;
        const stillHere = !!season && season.itemId === target.itemId;
        if (stillHere && result.chip) bannerSearched = { chip: result.chip, tone: result.tone, at: Date.now(), itemId: target.itemId };
        announce(result.text);
        JE.arrAsk.toast(result.text);
        if (!stillHere) return;
        JE.internals?.arrStatusEpisodes?.apply?.();
    }

    /**
     * The episode's status details (from a JE row): title, air date, runtime, overview, the status
     * pill and journey, and Get it. A focus-trapped dialog; Escape or Close returns focus. It closes
     * by itself when the page changes (navigation, another season, a sign-out).
     * @param {Object} ep Episode status.
     * @param {Object} ctx Response context.
     * @returns {void}
     */
    function openDetails(ep, ctx) {
        const S = JE.arrStatus;
        closeDialog();
        const opener = document.activeElement;
        const meta = metaOf(ep.episode) || {};
        const spoiler = !!JE.spoilerBlur?.isEnabledFor?.(season?.rows?.seriesId);
        const backdrop = S.el('div', 'je-ask-dialog-backdrop');
        const dialog = S.el('div', 'je-ask-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const titleId = `je-ask-dialog-title-${ep.episode}`;
        dialog.setAttribute('aria-labelledby', titleId);
        const heading = S.el('h2', 'je-ask-dialog-title', `${ep.episode}. ${meta.title || tr('arr_ask_episode_title', { episode: ep.episode })}`);
        heading.id = titleId;
        dialog.appendChild(heading);
        const facts = [meta.runtime ? `${meta.runtime}m` : '', longDate(meta.airDate || ep.airDate || '')].filter(Boolean).join(' · ');
        if (facts) dialog.appendChild(S.el('div', 'je-ask-dialog-facts', facts));
        const c = chip(ep);
        const pillStatus = { ...ep, journey: null };
        const pill = S.buildPill(pillStatus, ctx);
        if (c && shownState(ep)) {
            const text = pill.querySelector('.je-arr-pill-text');
            if (text) text.textContent = c.text;
        }
        dialog.appendChild(pill);
        if (meta.overview && !spoiler) dialog.appendChild(S.el('p', 'je-ask-dialog-overview', meta.overview));
        const actions = S.el('div', 'je-ask-dialog-actions');
        // Why it can't be asked for now, above the buttons (an administrator's Search stays below it).
        if (offerable(ep) && !shownState(ep) && blockedWords(editionOf([ep]))) {
            const note = pausedNote(blockedWords(editionOf([ep])), '');
            note.id = `${titleId}-paused`;
            dialog.appendChild(note);
            // Read out with the dialog's name (focus lands on a button; the reason is plain text).
            dialog.setAttribute('aria-describedby', note.id);
        }
        if (offerable(ep) && offered(ep) && !shownState(ep) && !searchedOutcome(ep.episode)) {
            const get = getItButton(ep);
            // Seerr mode: why the button asks for the whole season, in words above it.
            if (get.dataset.rounded === '1') dialog.appendChild(S.el('p', 'je-ask-dialog-note', roundedWords().note));
            get.classList.add('je-ask-get-large');
            if (opener && opener !== document.body) {
                const row = opener.closest?.('.listItem, .je-arr-banner') || null;
                origins.set(get, { el: opener, page: opener.closest?.('#itemDetailPage') || null, episode: opener.dataset?.jeAskEpisode || row?.dataset?.jeAskEpisode || null, focusKey: opener.dataset?.jeFocus || null, neighbours: neighboursOf(row) });
            }
            get.addEventListener('click', () => close());
            actions.appendChild(get);
        }
        const closeBtn = S.el('button', 'je-ask-dialog-close', tr('arr_ask_close'));
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => close());
        actions.appendChild(closeBtn);
        dialog.appendChild(actions);
        backdrop.appendChild(dialog);
        const onKey = (e) => {
            if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'GoBack' || (e.key === 'Backspace' && !/input|textarea/i.test(e.target?.tagName || ''))) {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                // TV remotes: move between the dialog's buttons only (the page behind stays put).
                const focusables = [...dialog.querySelectorAll('button:not([disabled])')];
                if (!focusables.length) return;
                e.preventDefault();
                e.stopPropagation();
                const at = focusables.indexOf(document.activeElement);
                const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
                focusables[(at + step + focusables.length) % focusables.length].focus();
            } else if (e.key === 'Tab') {
                const focusables = [...dialog.querySelectorAll('button:not([disabled])')];
                if (!focusables.length) return;
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        const shownAt = location.href;
        const offNavigate = JE.core?.navigation?.onNavigate?.(() => { if (location.href !== shownAt) close(false); });
        /**
         * Closes the dialog and (unless the page changed under it) returns focus to what opened it.
         * @param {boolean} [restore] Return focus to the opener (default true).
         * @returns {void}
         */
        function close(restore) {
            if (shownDialog?.close === close) shownDialog = null;
            document.removeEventListener('keydown', onKey, true);
            if (typeof offNavigate === 'function') offNavigate();
            if (!backdrop.isConnected) return;
            backdrop.remove();
            if (restore !== false && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
        }
        shownDialog = { itemId: season?.itemId || null, close };
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        (actions.querySelector('button') || closeBtn).focus();
    }

    /**
     * Closes the episode dialog if one is shown, without moving focus to its opener (the page it
     * was opened from is gone or belongs to someone else).
     * @returns {void}
     */
    function closeDialog() {
        if (shownDialog) shownDialog.close(false);
    }

    /**
     * Extension hook: removes everything this module added to a page.
     * @param {HTMLElement} page Page.
     * @returns {void}
     */
    function clear(page) {
        pendingFocus = null;
        closeDialog();
        (page || document).querySelectorAll('.je-ask-row, .je-ask-get, .je-ask-searched, .je-ask-paused, .je-ask-paused-note, .je-ask-ring, .je-ask-banner-action, .je-ask-meta').forEach(n => n.remove());
        (page || document).querySelectorAll('.je-ask-dim, .je-ask-native-label-off').forEach(n => n.classList.remove('je-ask-dim', 'je-ask-native-label-off'));
    }

    /**
     * Starts the season-page request controls (behind the phase-3 flag).
     * @returns {void}
     */
    function initialize() {
        if (started || !JE.arrAsk?.enabled()) return;
        const episodes = JE.internals?.arrStatusEpisodes;
        if (!episodes?.extend) return;
        started = true;
        episodes.extend({ chip, drawn, decorate, clear });
        // An ask made elsewhere (the request sheet, the series page) changes this season's states.
        unsubscribe = JE.arrAsk.onChange(() => {
            if (!season) return;
            const again = { ...season, loading: true, generation: ++generation };
            season = again;
            load(again);
        });
        JE.core?.navigation?.onNavigate?.(() => { pendingFocus = null; });
    }

    JE.session?.onUserChange?.('arr-ask-episodes', () => {
        closeDialog();
        season = null;
        pendingFocus = null;
        pressing.clear();
        local.clear();
        searched.clear();
        bannerSearched = null;
        busy.clear();
        generation++;
    });

    JE.internals = JE.internals || {};
    JE.internals.arrAskEpisodes = { initialize, chip, drawn, decorate, clear, isMissing, askable, offerable, requestState, getEpisodes, searchEpisode, searchBanner, openDetails, closeDialog, adminSearchable, stop: () => { pendingFocus = null; if (unsubscribe) unsubscribe(); } };
    JE.initializeArrAskEpisodes = initialize;
})(window.JellyfinEnhanced);
