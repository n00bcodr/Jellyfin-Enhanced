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
        title: 'common_genre',
        hint: 'admin_tags_genre_desc',
        group: {
            id: 'genre',
            summary: () => JE.t('admin_tags_genre_summary'),
            sample: () => [['genre', 'Drama']],
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'genreTagsEnabled', key: 'GenreTagsEnabled', type: 'enable', label: 'admin_tags_genre_enabled' },
        ],
    });
})(window.JellyfinEnhanced);
