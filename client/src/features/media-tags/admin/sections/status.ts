/**
 * @file Media Tags admin tab, Groups › Status: on or off for new users,
 * with the way to the Status badges tab, where its families and windows are.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'groups',
    title: 'Status',
    group: { id: 'status' },
    writes: ['TagGroupScopes'],
        { id: 'statusTagsEnabled', key: 'StatusTagsEnabled', type: 'enable', label: 'Status tags for new users' },
*/
import { installSection, shown } from './install';

/** The badge family switches (Status badges tab). */
const FAMILIES = ['StatusTagsJustAdded', 'StatusTagsNewRelease', 'StatusTagsTrending', 'StatusTagsSchedule', 'StatusTagsMilestones', 'StatusTagsSeriesStatus', 'StatusTagsScenes', 'StatusTagsLeaving', 'StatusTagsDirectPlay'];

installSection((A) => {
    A.registerSection({
        id: 'group-status',
        tab: 'groups',
        order: 60,
        title: 'Status',
        hint: 'Badge posters with what is new, trending, airing next or a season milestone, without replacing the poster image. Native Poster Tags draw them too, except the direct-play warning.',
        group: {
            id: 'status',
            summary: (ctx) => {
                const days = ctx.config.StatusTagsJustAddedDays;
                return A.fmt('{n} of {total} badge families · just added {days} {days|day|days}', { n: FAMILIES.filter((k) => ctx.config[k] === true).length, total: FAMILIES.length, days: shown(days, 7) });
            },
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
});
