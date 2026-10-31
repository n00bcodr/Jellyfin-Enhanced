/**
 * @file Media Tags admin page, Groups › People: age and birthplace on cast
 * cards, on or off for new users.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    A.registerSection({
        id: 'group-people',
        tab: 'groups',
        order: 70,
        title: 'admin_tags_group_people',
        hint: 'admin_tags_people_desc',
        group: {
            id: 'people',
            summary: () => JE.t('admin_tags_people_summary'),
        },
        fields: [
            { id: 'peopleTagsEnabled', key: 'PeopleTagsEnabled', type: 'enable', label: 'admin_tags_people_enabled' },
        ],
    });
})(window.JellyfinEnhanced);
