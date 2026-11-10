/**
 * @file Media Tags admin tab, Groups › Age rating: on or off for new users.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'groups',
    title: 'Age Rating',
    group: { id: 'ageRating' },
    writes: ['TagGroupScopes'],
        { id: 'ageRatingTagsEnabled', key: 'AgeRatingTagsEnabled', type: 'enable', label: 'Age rating tags for new users' },
*/
import { installSection } from './install';

installSection((A) => {
    A.registerSection({
        id: 'group-age-rating',
        tab: 'groups',
        order: 50,
        title: 'Age Rating',
        hint: 'The age rating (PG-13, TV-MA, FSK 12…) as a badge coloured by its board. Episodes and seasons use their series\' rating.',
        group: {
            id: 'ageRating',
            summary: () => A.fmt('Colour-coded by board'),
            sample: () => [['age', 'PG-13']],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'ageRatingTagsEnabled', key: 'AgeRatingTagsEnabled', type: 'enable', label: 'Age rating tags for new users' },
        ],
    });
});
