/**
 * @file Media Tags admin page, Groups › Age rating: on or off for new users.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    A.registerSection({
        id: 'group-age-rating',
        tab: 'groups',
        order: 50,
        title: 'panel_settings_ui_tag_group_age_rating',
        hint: 'admin_tags_age_rating_desc',
        group: {
            id: 'ageRating',
            summary: () => JE.t('admin_tags_age_rating_summary'),
            sample: () => [['age', 'PG-13']],
        },
        fields: [
            { id: 'ageRatingTagsEnabled', key: 'AgeRatingTagsEnabled', type: 'enable', label: 'admin_tags_age_rating_enabled' },
        ],
    });
})(window.JellyfinEnhanced);
