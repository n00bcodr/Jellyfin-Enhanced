/**
 * @file Media Tags admin tab, Groups › Genre: on or off for new users.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    A.registerSection({
        id: 'group-genre',
        tab: 'groups',
        order: 20,
        title: 'Genre',
        hint: 'Themed icons for the genres of a title, with the names on hover.',
        group: {
            id: 'genre',
            summary: () => A.fmt('Themed icons, names on hover'),
            sample: () => [['icon', 'theater_comedy']],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'genreTagsEnabled', key: 'GenreTagsEnabled', type: 'enable', label: 'Genre tags for new users' },
        ],
    });
})(window.JellyfinEnhanced);
