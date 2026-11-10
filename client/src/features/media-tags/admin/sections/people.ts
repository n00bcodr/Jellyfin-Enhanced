/**
 * @file Media Tags admin tab, Groups › People: age and birthplace on cast
 * cards, on or off for new users.
 */
/*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
 *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
 *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
 *  to the sections this module registers and to what those readers found in the JavaScript module.
registerSection({
    tab: 'groups',
    title: 'People',
    group: { id: 'people' },
        { id: 'peopleTagsEnabled', key: 'PeopleTagsEnabled', type: 'enable', label: 'People tags for new users' },
*/
import { installSection } from './install';

installSection((A) => {
    A.registerSection({
        id: 'group-people',
        tab: 'groups',
        order: 70,
        title: 'People',
        hint: 'Age and birthplace on cast members\' cards on detail pages.',
        group: {
            id: 'people',
            summary: () => A.fmt('Age and birthplace on cast cards'),
        },
        fields: [
            { id: 'peopleTagsEnabled', key: 'PeopleTagsEnabled', type: 'enable', label: 'People tags for new users' },
        ],
    });
});
