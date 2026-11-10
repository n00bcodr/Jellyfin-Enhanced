/**
 * @file Media Tags admin tab, Status badges tab: which badge families new
 * users start with (each with the chip it shows), the two time windows
 * (server-wide), whether the TMDB key the schedule and trending badges
 * use is set, and the Leaving soon source (Maintainerr or collection names).
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** Family switch id → the sample chip [kind, data-je-status, label key]. */
    const SAMPLES = {
        statusTagsJustAdded: ['added', 'added', 'Just Added'],
        statusTagsNewRelease: ['new', 'newMovie', 'New Movie'],
        statusTagsTrending: ['trending', 'trending', '#{rank} Today'],
        statusTagsSchedule: ['schedule', 'airing_today', 'Airing Today'],
        statusTagsMilestones: ['milestone', 'season_finale', 'Season Finale'],
        statusTagsSeriesStatus: ['status', 'returning', 'Returning'],
        statusTagsScenes: ['scenes', 'post_credits', 'Post-credits'],
        statusTagsLeaving: ['leaving', 'leaving', 'Leaving in {days}d', { days: 5 }],
        statusTagsDirectPlay: ['playback', 'direct_play', 'Transcode'],
    };

    /**
     * A sample chip for a family (the page's own chip style: the status
     * module's stylesheet only reaches chips on cards).
     * @param {Object} ctx
     * @param {Array} chip - [kind, data-je-status, label key, label params?].
     * @returns {string}
     */
    function chipHtml(ctx, [kind, status, labelKey, params]) {
        const text = kind === 'trending' ? A.fmt(labelKey, { rank: 1 }) : A.fmt(labelKey, params);
        return `<span class="je-ta-chip" data-kind="status" data-je-status="${status}">${ctx.esc(text)}</span>`;
    }

    const FAMILY_FIELDS = [
        { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', place: 'section', label: 'Just Added', desc: 'Recently added to a library' },
        { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', place: 'section', label: 'New releases', desc: 'New Movie / New Series / New Episode' },
        { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', place: 'section', label: 'Trending', desc: 'Rank in TMDB\'s daily trending list (needs the TMDB API key), or Seerr\'s weekly list without one. Off also stops the server fetching the list.' },
        { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', place: 'section', label: 'Schedule', desc: 'When a series’ next episode airs (needs the TMDB API key), and Coming Soon for movies and series that have not premiered yet.' },
        { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', place: 'section', label: 'Milestones', desc: 'Season milestones from the library’s episode dates; Season Finale and Series Finale need the TMDB API key.' },
        { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', place: 'section', label: 'Series status', desc: 'The series status, when no other badge applies. Jellyfin supplies Returning and Ended; TMDB can refine Ended to Cancelled. Off by default.' },
        { id: 'statusTagsScenes', key: 'StatusTagsScenes', type: 'switch', place: 'section', label: 'Scenes', desc: 'Show a movie’s post-credits or mid-credits marker from TMDB keywords. Requires a TMDB key; refreshed daily.' },
        { id: 'statusTagsLeaving', key: 'StatusTagsLeaving', type: 'switch', place: 'section', label: 'Leaving soon', desc: 'Items in Maintainerr\'s collections or the leaving collections (set the source under Leaving soon).' },
        { id: 'statusTagsDirectPlay', key: 'StatusTagsDirectPlay', type: 'switch', place: 'section', label: 'Direct-play warning', desc: 'Each browser checks the movies and episodes on screen against its own playback support (web only; native posters have no client profile). Items Jellyfin would probe to answer, .strm items and media never probed, are skipped.' },
    ];

    /**
     * Each view's Leaving soon state: its last status answer (GET
     * admin/leaving-soon) and whether its status request or refresh is
     * running. Per view, so a view Jellyfin builds while another one's
     * request is on its way asks for itself, and a disposed view's late
     * answer only ever reaches that view.
     * @type {WeakMap<Object, {status: Object|null, busy: boolean}>}
     */
    const leavingStates = new WeakMap();

    /**
     * @param {Object} ctx
     * @returns {{status: Object|null, busy: boolean}}
     */
    function leavingOf(ctx) {
        let state = leavingStates.get(ctx);
        if (!state) leavingStates.set(ctx, state = { status: null, busy: false });
        return state;
    }

    /**
     * A time as Jellyfin Enhanced's interface language writes it (core/media-language.js), or a dash.
     * @param {number|null|undefined} ms
     * @returns {string}
     */
    function when(ms) {
        if (!Number.isFinite(ms)) return '—';
        try { return new Date(/** @type {number} */ (ms)).toLocaleString(JE.core?.mediaLanguage?.uiLocale?.() || undefined); } catch { return new Date(/** @type {number} */ (ms)).toISOString(); }
    }

    /**
     * Ask the server for the Leaving soon state (or refresh it first), then redraw.
     * @param {Object} ctx
     * @param {boolean} refresh - POST admin/leaving-soon/refresh after saving pending edits.
     * @returns {Promise<void>}
     */
    async function loadLeavingStatus(ctx, refresh) {
        const leaving = leavingOf(ctx);
        if (leaving.busy || typeof ApiClient === 'undefined') return;
        leaving.busy = true;
        const button = /** @type {HTMLButtonElement|null} */ (ctx.root?.querySelector?.('#leavingSoonRefreshBtn'));
        if (button) button.disabled = true;
        try {
            // The refresh reads the stored source: refuse while this page's edits to it
            // are not saved (a failed save, or a conflict waiting for Keep mine / Take theirs).
            const saved = refresh ? await ctx.flush() : true;
            if (!ctx.isCurrent()) return;
            if (!saved) {
                ctx.snack(A.fmt('Not refreshed: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then refresh again.'));
                return;
            }
            const answer = await ApiClient.ajax({
                type: refresh ? 'POST' : 'GET',
                url: ApiClient.getUrl(refresh ? 'JellyfinEnhanced/admin/leaving-soon/refresh' : 'JellyfinEnhanced/admin/leaving-soon'),
                dataType: 'json',
            });
            if (!ctx.isCurrent()) return;
            leaving.status = answer && typeof answer === 'object' ? answer : null;
            if (refresh) ctx.snack(A.fmt(leaving.status?.LastError ? 'Leaving soon refresh failed' : 'Leaving soon refreshed'));
        } catch {
            if (!ctx.isCurrent()) return;
            leaving.status = null;
            if (refresh) ctx.snack(A.fmt('Leaving soon refresh failed'));
        } finally {
            leaving.busy = false;
            if (ctx.isCurrent()) ctx.refresh({ controls: false });
        }
    }

    A.registerSection({
        id: 'badges-families',
        tab: 'badges',
        order: 10,
        title: 'Badge families',
        hint: 'One badge per poster, first match wins (the order per card type is in the documentation). Users can override the family switches in their personal settings; the day windows apply to everyone.',
        fields: FAMILY_FIELDS,
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-off" data-badges-off>${ctx.tx('Status tags are off for new users, so none of these show.')} <a class="je-ta-link" href="#" data-je-goto="groups:status">${ctx.tx('Turn Status on')}</a></p>`
                + `<div class="je-ta-badges">${FAMILY_FIELDS.map((f) => `<div class="je-ta-badge">${A.fieldHtml(f, ctx.config)}<span class="je-ta-badge-sample" aria-hidden="true">${chipHtml(ctx, SAMPLES[f.id])}</span></div>`).join('')}</div>`;
        },
        refresh(ctx, body) {
            const off = /** @type {HTMLElement|null} */ (body?.querySelector('[data-badges-off]'));
            if (off) off.hidden = ctx.config.StatusTagsEnabled === true;
        },
    });

    A.registerSection({
        id: 'badges-collections',
        tab: 'badges',
        order: 15,
        title: 'Collections',
        hint: 'This applies to everyone.',
        fields: [
            { id: 'statusTagsOnCollections', key: 'StatusTagsOnCollections', type: 'switch', label: 'Show status badges on collections', desc: 'A collection\'s date is when a tool created it, and some tools recreate collections often, which makes them show Just Added again and again. Turn this off to keep status badges off collections.' },
        ],
    });

    A.registerSection({
        id: 'badges-windows',
        tab: 'badges',
        order: 20,
        title: 'Time windows',
        hint: 'These apply to everyone.',
        fields: [
            { id: 'statusTagsJustAddedDays', key: 'StatusTagsJustAddedDays', type: 'number', min: 1, max: 365, fallback: 7, unit: 'days', label: 'Just added', desc: 'An item counts as just added (and a series or season shows New Episode) for this many days after it reached the library.', read: (v) => Number(v) || 7 },
            { id: 'statusTagsNewReleaseDays', key: 'StatusTagsNewReleaseDays', type: 'number', min: 1, max: 365, fallback: 30, unit: 'days', label: 'New release', desc: 'A movie or series counts as new for this many days after its premiere.', read: (v) => Number(v) || 30 },
        ],
    });

    A.registerSection({
        id: 'badges-tmdb',
        tab: 'badges',
        order: 30,
        title: 'TMDB API key',
        render(ctx, body) {
            body.innerHTML = '<div class="je-ta-state-row"><span class="je-ta-state" data-tmdb-state></span></div>'
                + `<p class="je-ta-hint">${ctx.tx('Daily popular ranks, next air dates and season and series finales use the TMDB API key. Without it, trending can use Seerr\'s weekly list.')}</p>`
                + `<a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl(null, 'services'))}"><span class="je-ta-link-text">${ctx.tx('TMDB API key setting')}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
        },
        refresh(ctx, body) {
            // Updated in place: every refresh (a save, the library list) would otherwise replace a focused link.
            const state = /** @type {HTMLElement|null} */ (body?.querySelector('[data-tmdb-state]'));
            if (!state) return;
            const set = String(ctx.config.TMDB_API_KEY || '').trim() !== '';
            state.dataset.state = set ? 'on' : 'warn';
            state.textContent = A.fmt(set ? 'Set' : 'Not set');
        },
    });

    A.registerSection({
        id: 'badges-leaving',
        tab: 'badges',
        order: 40,
        title: 'Leaving soon',
        hint: 'Where the Leaving soon badge comes from: Maintainerr\'s collections (with the day each item goes), or existing Jellyfin collections by name (no date).',
        fields: [
            { id: 'leavingSoonMaintainerrUrl', key: 'LeavingSoonMaintainerrUrl', type: 'text', wide: true, placeholder: 'http://maintainerr:6246', pattern: 'https?://[^\\s?#]+', label: 'Maintainerr URL', desc: 'The address this server reaches Maintainerr at. Empty uses only the collection names.' },
            { id: 'leavingSoonMaintainerrApiKey', key: 'LeavingSoonMaintainerrApiKey', type: 'text', wide: true, mask: true, label: 'Maintainerr API key', desc: 'Optional. Only needed if Maintainerr has an API key set.' },
            { id: 'leavingSoonCollections', key: 'LeavingSoonCollections', type: 'textarea', rows: 3, placeholder: 'Leaving Soon', label: 'Leaving collections', desc: 'Existing collection names, one per line, whose items count as leaving soon (for setups without the API). Up to 20.' },
            { id: 'leavingSoonRefreshHours', key: 'LeavingSoonRefreshHours', type: 'number', min: 1, max: 168, fallback: 6, unit: 'hours', label: 'Refresh every', desc: 'How often the server reads the source again (1–168 hours). A failed request is retried sooner.', read: (v) => Number(v) || 6 },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-state-row"><span class="je-ta-state" data-leaving-state></span></div>`
                + `<p class="je-ta-hint" data-leaving-detail></p>`
                + `<div class="je-ta-actions"><button type="button" class="je-ta-button" id="leavingSoonRefreshBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('Refresh now')}</button></div>`
                + `<p class="je-ta-hint">${ctx.tx('Cards never ask Maintainerr: the server reads it on this schedule and keeps the answer in the tag cache.')}</p>`;
            body.querySelector('#leavingSoonRefreshBtn')?.addEventListener('click', () => loadLeavingStatus(ctx, true));
            loadLeavingStatus(ctx, false);
        },
        refresh(ctx, body) {
            if (!body) return;
            const state = /** @type {HTMLElement|null} */ (body.querySelector('[data-leaving-state]'));
            const detail = body.querySelector('[data-leaving-detail]');
            const button = /** @type {HTMLButtonElement|null} */ (body.querySelector('#leavingSoonRefreshBtn'));
            const { status: s, busy } = leavingOf(ctx);
            const configured = String(ctx.config.LeavingSoonMaintainerrUrl || '').trim() !== '' || String(ctx.config.LeavingSoonCollections || '').trim() !== '';
            if (button) button.disabled = busy || !configured;
            if (!state || !detail) return;
            const key = !configured ? 'No source set' : !s ? 'Status unavailable' : s.LastError ? 'Last refresh failed: {error}' : s.LastSuccess ? 'Up to date' : 'Not read yet';
            state.dataset.state = key.endsWith('_ok') ? 'on' : key.endsWith('_off') ? 'off' : 'warn';
            state.textContent = A.fmt(key, { error: s?.LastError || '' });
            const collections = s?.Collections ? ` · ${A.fmt('{found} of {names} collections found', { found: s.CollectionsFound ?? 0, names: s.Collections })}` : '';
            detail.textContent = configured && s ? A.fmt('{items} {items|item|items} leaving ({dated} with a date) · last read {last} · next {next}', {
                items: s.Items ?? 0, dated: s.Dated ?? 0, last: when(s.LastSuccess), next: when(s.NextRefresh),
            }) + collections : '';
        },
    });
})(window.JellyfinEnhanced);
