/**
 * @file Media Tags admin page, Status badges tab: which badge families new
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
        statusTagsJustAdded: ['added', 'added', 'status_tag_just_added'],
        statusTagsNewRelease: ['new', 'newMovie', 'status_tag_new_movie'],
        statusTagsTrending: ['trending', 'trending', 'status_tag_trending_today'],
        statusTagsSchedule: ['schedule', 'airing_today', 'status_tag_airing_today'],
        statusTagsMilestones: ['milestone', 'season_finale', 'status_tag_season_finale'],
        statusTagsSeriesStatus: ['status', 'returning', 'status_tag_returning'],
        statusTagsLeaving: ['leaving', 'leaving', 'status_tag_leaving_days', { days: 5 }],
        statusTagsDirectPlay: ['playback', 'direct_play', 'status_tag_transcode'],
    };

    /**
     * A sample chip for a family (the page's own chip style: the status
     * module's stylesheet only reaches chips on cards).
     * @param {Object} ctx
     * @param {Array} chip - [kind, data-je-status, label key, label params?].
     * @returns {string}
     */
    function chipHtml(ctx, [kind, status, labelKey, params]) {
        const text = kind === 'trending' ? JE.t(labelKey, { rank: 1 }) : JE.t(labelKey, params);
        return `<span class="je-ta-chip" data-kind="status" data-je-status="${status}">${ctx.esc(text)}</span>`;
    }

    const FAMILY_FIELDS = [
        { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', place: 'section', label: 'panel_media_tags_badge_just_added', desc: 'panel_media_tags_badge_just_added_desc' },
        { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', place: 'section', label: 'panel_media_tags_badge_new_release', desc: 'panel_settings_ui_status_tags_new_release' },
        { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', place: 'section', label: 'panel_media_tags_badge_trending', desc: 'admin_tags_badges_trending_desc' },
        { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', place: 'section', label: 'panel_media_tags_badge_schedule', desc: 'admin_status_tags_schedule_description' },
        { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', place: 'section', label: 'panel_media_tags_badge_milestones', desc: 'admin_status_tags_milestones_description' },
        { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', place: 'section', label: 'panel_media_tags_badge_series_status', desc: 'admin_status_tags_series_status_description' },
        { id: 'statusTagsLeaving', key: 'StatusTagsLeaving', type: 'switch', place: 'section', label: 'panel_media_tags_badge_leaving', desc: 'admin_tags_badges_leaving_desc' },
        { id: 'statusTagsDirectPlay', key: 'StatusTagsDirectPlay', type: 'switch', place: 'section', label: 'panel_media_tags_badge_direct_play', desc: 'admin_tags_badges_direct_play_desc' },
    ];

    /** @type {Object|null} The last Leaving soon status answer (GET admin/leaving-soon). */
    let leavingStatus = null;
    /** @type {boolean} A status request or refresh is running. */
    let leavingBusy = false;

    /**
     * A time as the admin's locale writes it, or a dash.
     * @param {number|null|undefined} ms
     * @returns {string}
     */
    function when(ms) {
        if (!Number.isFinite(ms)) return '—';
        try { return new Date(/** @type {number} */ (ms)).toLocaleString(); } catch { return new Date(/** @type {number} */ (ms)).toISOString(); }
    }

    /**
     * Ask the server for the Leaving soon state (or refresh it first), then redraw.
     * @param {Object} ctx
     * @param {boolean} refresh - POST admin/leaving-soon/refresh after saving pending edits.
     * @returns {Promise<void>}
     */
    async function loadLeavingStatus(ctx, refresh) {
        if (leavingBusy || typeof ApiClient === 'undefined') return;
        leavingBusy = true;
        const button = /** @type {HTMLButtonElement|null} */ (ctx.root?.querySelector?.('#leavingSoonRefreshBtn'));
        if (button) button.disabled = true;
        try {
            if (refresh) await ctx.flush();
            if (!ctx.isCurrent()) return;
            const answer = await ApiClient.ajax({
                type: refresh ? 'POST' : 'GET',
                url: ApiClient.getUrl(refresh ? 'JellyfinEnhanced/admin/leaving-soon/refresh' : 'JellyfinEnhanced/admin/leaving-soon'),
                dataType: 'json',
            });
            if (!ctx.isCurrent()) return;
            leavingStatus = answer && typeof answer === 'object' ? answer : null;
            if (refresh) ctx.snack(JE.t(leavingStatus?.LastError ? 'admin_tags_leaving_refresh_failed' : 'admin_tags_leaving_refresh_done'));
        } catch {
            if (!ctx.isCurrent()) return;
            leavingStatus = null;
            if (refresh) ctx.snack(JE.t('admin_tags_leaving_refresh_failed'));
        } finally {
            leavingBusy = false;
            if (ctx.isCurrent()) ctx.refresh({ controls: false });
        }
    }

    A.registerSection({
        id: 'badges-families',
        tab: 'badges',
        order: 10,
        title: 'admin_tags_badges_families',
        hint: 'admin_status_tags_priority',
        fields: FAMILY_FIELDS,
        render(ctx, body) {
            body.innerHTML = `<p class="je-ta-off" data-badges-off>${ctx.tx('admin_tags_badges_off')} <a class="je-ta-link" href="#" data-je-goto="groups:status">${ctx.tx('admin_tags_badges_turn_on')}</a></p>`
                + `<div class="je-ta-badges">${FAMILY_FIELDS.map((f) => `<div class="je-ta-badge">${A.fieldHtml(f, ctx.config)}<span class="je-ta-badge-sample" aria-hidden="true">${chipHtml(ctx, SAMPLES[f.id])}</span></div>`).join('')}</div>`;
        },
        refresh(ctx, body) {
            const off = /** @type {HTMLElement|null} */ (body?.querySelector('[data-badges-off]'));
            if (off) off.hidden = ctx.config.StatusTagsEnabled === true;
        },
    });

    A.registerSection({
        id: 'badges-windows',
        tab: 'badges',
        order: 20,
        title: 'admin_tags_badges_windows',
        hint: 'admin_tags_badges_windows_desc',
        fields: [
            { id: 'statusTagsJustAddedDays', key: 'StatusTagsJustAddedDays', type: 'number', min: 1, max: 365, fallback: 7, unit: 'admin_tags_days', label: 'admin_tags_badges_just_added_days', desc: 'admin_tags_badges_just_added_days_desc', read: (v) => Number(v) || 7 },
            { id: 'statusTagsNewReleaseDays', key: 'StatusTagsNewReleaseDays', type: 'number', min: 1, max: 365, fallback: 30, unit: 'admin_tags_days', label: 'admin_tags_badges_new_release_days', desc: 'admin_tags_badges_new_release_days_desc', read: (v) => Number(v) || 30 },
        ],
    });

    A.registerSection({
        id: 'badges-tmdb',
        tab: 'badges',
        order: 30,
        title: 'admin_tags_badges_tmdb',
        refresh(ctx, body) {
            if (!body) return;
            const set = String(ctx.config.TMDB_API_KEY || '').trim() !== '';
            body.innerHTML = `<div class="je-ta-card-head"><span class="je-ta-state" data-state="${set ? 'on' : 'warn'}">${ctx.tx(set ? 'admin_tags_badges_tmdb_set' : 'admin_tags_badges_tmdb_missing')}</span></div>`
                + `<p class="je-ta-hint">${ctx.tx('admin_tags_badges_tmdb_desc')}</p>`
                + `<a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl('TMDB_API_KEY'))}">${ctx.tx('admin_tags_badges_tmdb_open')}<span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
        },
    });

    A.registerSection({
        id: 'badges-leaving',
        tab: 'badges',
        order: 40,
        title: 'admin_tags_leaving_title',
        hint: 'admin_tags_leaving_desc',
        fields: [
            { id: 'leavingSoonMaintainerrUrl', key: 'LeavingSoonMaintainerrUrl', type: 'text', placeholder: 'admin_tags_leaving_url_placeholder', pattern: 'https?://[^\\s?#]+', label: 'admin_tags_leaving_url', desc: 'admin_tags_leaving_url_desc' },
            { id: 'leavingSoonMaintainerrApiKey', key: 'LeavingSoonMaintainerrApiKey', type: 'text', secret: true, label: 'admin_tags_leaving_key', desc: 'admin_tags_leaving_key_desc' },
            { id: 'leavingSoonCollections', key: 'LeavingSoonCollections', type: 'textarea', rows: 3, placeholder: 'admin_tags_leaving_collections_placeholder', label: 'admin_tags_leaving_collections', desc: 'admin_tags_leaving_collections_desc' },
            { id: 'leavingSoonRefreshHours', key: 'LeavingSoonRefreshHours', type: 'number', min: 1, max: 168, fallback: 6, unit: 'admin_tags_hours', label: 'admin_tags_leaving_refresh', desc: 'admin_tags_leaving_refresh_desc', read: (v) => Number(v) || 6 },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-card-head"><span class="je-ta-state" data-leaving-state></span></div>`
                + `<p class="je-ta-hint" data-leaving-detail></p>`
                + `<div class="je-ta-actions"><button type="button" class="je-ta-button" id="leavingSoonRefreshBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx('admin_tags_leaving_refresh_now')}</button></div>`
                + `<p class="je-ta-hint">${ctx.tx('admin_tags_leaving_note')}</p>`;
            body.querySelector('#leavingSoonRefreshBtn')?.addEventListener('click', () => loadLeavingStatus(ctx, true));
            loadLeavingStatus(ctx, false);
        },
        refresh(ctx, body) {
            if (!body) return;
            const state = /** @type {HTMLElement|null} */ (body.querySelector('[data-leaving-state]'));
            const detail = body.querySelector('[data-leaving-detail]');
            const button = /** @type {HTMLButtonElement|null} */ (body.querySelector('#leavingSoonRefreshBtn'));
            const s = leavingStatus;
            const configured = String(ctx.config.LeavingSoonMaintainerrUrl || '').trim() !== '' || String(ctx.config.LeavingSoonCollections || '').trim() !== '';
            if (button) button.disabled = leavingBusy || !configured;
            if (!state || !detail) return;
            const key = !configured ? 'admin_tags_leaving_state_off' : !s ? 'admin_tags_leaving_state_unknown' : s.LastError ? 'admin_tags_leaving_state_error' : s.LastSuccess ? 'admin_tags_leaving_state_ok' : 'admin_tags_leaving_state_pending';
            state.dataset.state = key.endsWith('_ok') ? 'on' : key.endsWith('_off') ? 'off' : 'warn';
            state.textContent = JE.t(key, { error: s?.LastError || '' });
            const collections = s?.Collections ? ` · ${JE.t('admin_tags_leaving_detail_collections', { found: s.CollectionsFound ?? 0, names: s.Collections })}` : '';
            detail.textContent = configured && s ? JE.t('admin_tags_leaving_detail', {
                items: s.Items ?? 0, dated: s.Dated ?? 0, last: when(s.LastSuccess), next: when(s.NextRefresh),
            }) + collections : '';
        },
    });
})(window.JellyfinEnhanced);
