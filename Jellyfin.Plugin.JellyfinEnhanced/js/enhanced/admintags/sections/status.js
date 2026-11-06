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
        title: 'Status',
        hint: 'Badge posters with what is new, trending, airing next or a season milestone, without replacing the poster image. Native Poster Tags draw them too, except the direct-play warning.',
        group: {
            id: 'status',
            summary: (ctx) => A.fmt('{n} of {total} badge families · just added {days} {days|day|days}', { n: FAMILIES.filter((k) => ctx.config[k] === true).length, total: FAMILIES.length, days: ctx.config.StatusTagsJustAddedDays || 7 }),
            sample: () => [['status', A.fmt('Just Added')]],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'statusTagsEnabled', key: 'StatusTagsEnabled', type: 'enable', label: 'Status tags for new users' },
        ],
        render(ctx, body) {
            body.innerHTML = `<div class="je-ta-actions"><button type="button" class="je-ta-button" data-je-goto="badges">${ctx.tx('Badge families and time windows')}<span class="material-icons" aria-hidden="true">arrow_forward</span></button></div>`;
        },
    });
})(window.JellyfinEnhanced);
