/**
 * @file Media Tags admin tab, Groups › Status: on or off for new users,
 * with the way to the Status badges tab, where its families and windows are.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    /** The badge family switches (Status badges tab). */
    const FAMILIES = ['StatusTagsJustAdded', 'StatusTagsNewRelease', 'StatusTagsTrending', 'StatusTagsSchedule', 'StatusTagsMilestones', 'StatusTagsSeriesStatus', 'StatusTagsScenes', 'StatusTagsLeaving', 'StatusTagsDirectPlay'];

    A.registerSection({
        id: 'group-status',
        tab: 'groups',
        order: 60,
        title: 'panel_settings_ui_tag_group_status',
        hint: 'admin_status_tags_description',
        group: {
            id: 'status',
            summary: (ctx) => JE.t('admin_tags_status_summary', { n: FAMILIES.filter((k) => ctx.config[k] === true).length, total: FAMILIES.length, days: ctx.config.StatusTagsJustAddedDays || 7 }),
            sample: () => [['status', JE.t('status_tag_just_added')]],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'statusTagsEnabled', key: 'StatusTagsEnabled', type: 'enable', label: 'admin_tags_status_enabled' },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-actions"><button type="button" class="je-ta-button" data-je-goto="badges">${ctx.tx('admin_tags_status_to_badges')}<span class="material-icons" aria-hidden="true">arrow_forward</span></button></div>`;
        },
    });
})(window.JellyfinEnhanced);
