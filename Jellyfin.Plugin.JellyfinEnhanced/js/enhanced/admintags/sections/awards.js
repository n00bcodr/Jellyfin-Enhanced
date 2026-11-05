(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-awards',
        tab: 'groups',
        order: 65,
        title: 'awards_label', hint: 'admin_tags_awards_desc',
        group: {
            id: 'awards', summary: () => JE.t('admin_tags_awards_desc'), sample: () => [['status', 'Awards']] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'admin_tags_awardsTagsEnabled' },
            { id: 'awardsTagsImdb', key: 'AwardsTagsImdb', type: 'switch', label: 'awards_tags_imdbTop250' },
            { id: 'awardsTagsCertifiedFresh', key: 'AwardsTagsCertifiedFresh', type: 'switch', label: 'awards_tags_label_certifiedFresh' },
            { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', label: 'admin_tags_awardsTagsOscar' },
            { id: 'awardsTagsEmmy', key: 'AwardsTagsEmmy', type: 'switch', label: 'admin_tags_awardsTagsEmmy' },
            { id: 'awardsTagsLetterboxd', key: 'AwardsTagsLetterboxd', type: 'switch', label: 'awards_tags_letterboxdTop250' },
            { id: 'awardsTagsImdbList', key: 'AwardsTagsImdbList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'admin_tags_awardsTagsImdbList' },
            { id: 'awardsTagsLetterboxdList', key: 'AwardsTagsLetterboxdList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'admin_tags_awardsTagsLetterboxdList' },
            { id: 'awardsTagsRefreshHours', key: 'AwardsTagsRefreshHours', type: 'number', label: 'admin_tags_awardsTagsRefreshHours', min: 1, max: 168, fallback: 24 },
        ],
    });
})(window.JellyfinEnhanced);
