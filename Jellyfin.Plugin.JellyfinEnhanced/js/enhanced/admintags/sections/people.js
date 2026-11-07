/**
 * @file Media Tags admin tab, Groups › People: age and birthplace on cast
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
})(window.JellyfinEnhanced);
