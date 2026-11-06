(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-awards',
        tab: 'groups',
        order: 65,
        title: 'Awards', hint: 'Ribbons from ratings and award sources. MDBList credentials stay on the main settings page. Failed lookups retry after an hour.',
        group: {
            id: 'awards',
            // The current choice, short (the description stays inside the group).
            summary: (ctx) => A.fmt('{n} of {total} sources · refreshed every {hours} h', { n: ['AwardsTagsImdb', 'AwardsTagsCertifiedFresh', 'AwardsTagsOscar', 'AwardsTagsEmmy', 'AwardsTagsLetterboxd'].filter((k) => ctx.config[k] === true).length, total: 5, hours: Number(ctx.config.AwardsTagsRefreshHours) || 24 }), sample: () => [['status', A.fmt('Awards')]] },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'Awards ribbons for new users' },
            { id: 'awardsTagsImdb', key: 'AwardsTagsImdb', type: 'switch', label: 'IMDb Top 250' },
            { id: 'awardsTagsCertifiedFresh', key: 'AwardsTagsCertifiedFresh', type: 'switch', label: 'Certified Fresh' },
            { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', label: 'Oscar winners' },
            { id: 'awardsTagsEmmy', key: 'AwardsTagsEmmy', type: 'switch', label: 'Emmy winners' },
            { id: 'awardsTagsLetterboxd', key: 'AwardsTagsLetterboxd', type: 'switch', label: 'Letterboxd Top 250' },
            { id: 'awardsTagsImdbList', key: 'AwardsTagsImdbList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'IMDb list (numeric id or owner/slug)' },
            { id: 'awardsTagsLetterboxdList', key: 'AwardsTagsLetterboxdList', type: 'text', pattern: '(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})', label: 'Letterboxd list (numeric id or owner/slug)' },
            { id: 'awardsTagsRefreshHours', key: 'AwardsTagsRefreshHours', type: 'number', label: 'Refresh cadence (hours)', min: 1, max: 168, fallback: 24 },
        ],
    });
})(window.JellyfinEnhanced);
