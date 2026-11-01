(function(JE) {
    'use strict';
    const A = JE.adminTags;
    if (!A) return;
    A.registerSection({
        id: 'group-logos',
        tab: 'groups',
        order: 70,
        title: 'common_logos', hint: 'admin_tags_logos_desc',
        group: {
            id: 'logos', summary: () => JE.t('admin_tags_logos_desc'), sample: () => [['status', 'Logos']] },
        fields: [
            { id: 'logoTagsEnabled', key: 'LogoTagsEnabled', type: 'enable', label: 'admin_tags_logoTagsEnabled' },
            { id: 'logoTagsMovieMode', key: 'LogoTagsMovieMode', type: 'select', label: 'admin_tags_logoTagsMovieMode', options: [['provider', '=Provider'], ['studio', '=Studio'], ['off', '=Off']] },
            { id: 'logoTagsSeriesMode', key: 'LogoTagsSeriesMode', type: 'select', label: 'admin_tags_logoTagsSeriesMode', options: [['network', '=Network'], ['provider', '=Provider'], ['off', '=Off']] },
            { id: 'logoTagsRegion', key: 'LogoTagsRegion', type: 'text', label: 'admin_tags_logoTagsRegion' },
            { id: 'logoTagsMaxLogos', key: 'LogoTagsMaxLogos', type: 'number', label: 'admin_tags_logoTagsMaxLogos', min: 1, max: 2, fallback: 1 },
        ],
    });
})(window.JellyfinEnhanced);
