/**
 * @file Media Tags admin page, Groups › Language: priority languages and
 * what the language tags include and look like for new users.
 */
(function(JE) {
    'use strict';

    const A = JE.adminTags;
    if (!A) return;

    A.registerSection({
        id: 'group-language',
        tab: 'groups',
        order: 30,
        title: 'panel_settings_ui_tag_group_language',
        hint: 'admin_tags_language_desc',
        group: {
            id: 'language',
            summary(ctx) {
                const c = ctx.config;
                const parts = [JE.t(String(c.LanguageTagsStyle || '').toLowerCase() === 'codes' ? 'admin_tags_language_style_codes' : 'admin_tags_language_style_flags')];
                const include = [c.LanguageTagsShowAudio !== false && JE.t('admin_tags_language_audio'), c.LanguageTagsShowSubtitles === true && JE.t('admin_tags_language_subtitles')].filter(Boolean);
                parts.push(include.length ? include.join(' + ') : JE.t('admin_tags_none'));
                if (String(c.LanguageTagsPriority || '').trim()) parts.push(JE.t('admin_tags_language_priority_summary', { list: String(c.LanguageTagsPriority).trim() }));
                return parts.join(' · ');
            },
            sample: () => [['lang', 'EN'], ['lang', 'JA']],
        },
        fields: [
            { id: 'languageTagsEnabled', key: 'LanguageTagsEnabled', type: 'enable', label: 'admin_tags_language_enabled' },
            { id: 'languageTagsShowAudio', key: 'LanguageTagsShowAudio', type: 'switch', label: 'admin_tags_language_show_audio' },
            { id: 'languageTagsShowSubtitles', key: 'LanguageTagsShowSubtitles', type: 'switch', label: 'admin_tags_language_show_subtitles', desc: 'admin_tags_language_show_subtitles_desc' },
            { id: 'languageTagsStyle', key: 'LanguageTagsStyle', type: 'pills', label: 'admin_tags_language_style', desc: 'admin_tags_language_style_desc', options: [['flags', 'admin_tags_language_style_flags'], ['codes', 'admin_tags_language_style_codes']], read: (v) => (String(v || '').toLowerCase() === 'codes' ? 'codes' : 'flags') },
            { id: 'languageTagsCountBadge', key: 'LanguageTagsCountBadge', type: 'select', label: 'admin_tags_language_count_badge', desc: 'admin_tags_language_count_badge_desc', options: [['off', 'admin_tags_language_count_off'], ['only', 'admin_tags_language_count_only'], ['both', 'admin_tags_language_count_both']], read: (v) => (['only', 'both'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'off') },
            { id: 'languageTagsPriority', key: 'LanguageTagsPriority', type: 'text', label: 'admin_tags_language_priority', desc: 'admin_tags_language_priority_desc', placeholder: 'admin_tags_language_priority_placeholder', break: true },
            { id: 'languageTagsPriorityStrict', key: 'LanguageTagsPriorityStrict', type: 'switch', label: 'admin_tags_language_priority_strict', desc: 'admin_tags_language_priority_strict_desc' },
            { id: 'languageTagsMergeRegions', key: 'LanguageTagsMergeRegions', type: 'switch', label: 'admin_tags_language_merge_regions', desc: 'admin_tags_language_merge_regions_desc' },
        ],
    });
})(window.JellyfinEnhanced);
