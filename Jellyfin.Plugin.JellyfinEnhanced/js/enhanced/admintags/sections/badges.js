/**
 * @file Media Tags admin page, Status badges tab: which badge families new
 * users start with (each with the chip it shows), the two time windows
 * (server-wide), and whether the TMDB key the schedule and trending badges
 * use is set.
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
        statusTagsScenes: ['scenes', 'post_credits', 'status_tag_post_credits'],
    };

    /**
     * A sample chip for a family (the page's own chip style: the status
     * module's stylesheet only reaches chips on cards).
     * @param {Object} ctx
     * @param {string[]} chip - [kind, data-je-status, label key].
     * @returns {string}
     */
    function chipHtml(ctx, [kind, status, labelKey]) {
        const text = kind === 'trending' ? JE.t(labelKey, { rank: 1 }) : JE.t(labelKey);
        return `<span class="je-ta-chip" data-kind="status" data-je-status="${status}">${ctx.esc(text)}</span>`;
    }

    const FAMILY_FIELDS = [
        { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', place: 'section', label: 'panel_media_tags_badge_just_added', desc: 'panel_media_tags_badge_just_added_desc' },
        { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', place: 'section', label: 'panel_media_tags_badge_new_release', desc: 'panel_settings_ui_status_tags_new_release' },
        { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', place: 'section', label: 'panel_media_tags_badge_trending', desc: 'admin_tags_badges_trending_desc' },
        { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', place: 'section', label: 'panel_media_tags_badge_schedule', desc: 'admin_status_tags_schedule_description' },
        { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', place: 'section', label: 'panel_media_tags_badge_milestones', desc: 'admin_status_tags_milestones_description' },
        { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', place: 'section', label: 'panel_media_tags_badge_series_status', desc: 'admin_status_tags_series_status_description' },
        { id: 'statusTagsScenes', key: 'StatusTagsScenes', type: 'switch', place: 'section', label: 'panel_media_tags_badge_scenes', desc: 'admin_status_tags_scenes_description' },
    ];

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
})(window.JellyfinEnhanced);
