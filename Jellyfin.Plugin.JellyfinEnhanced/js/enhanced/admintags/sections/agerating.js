/**
 * @file Media Tags admin tab, Groups › Age rating: on or off for new users.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

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
})(window.JellyfinEnhanced);
