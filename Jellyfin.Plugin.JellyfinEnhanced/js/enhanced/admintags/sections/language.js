/**
 * @file Media Tags admin tab, Groups › Language: priority languages and
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
        title: 'Language',
        hint: 'Audio and subtitle languages as flags or codes, with an optional Dual/Multi badge. Users can override what to show.',
        group: {
            id: 'language',
            summary(ctx) {
                const c = ctx.config;
                const parts = [A.fmt(String(c.LanguageTagsStyle || '').toLowerCase() === 'codes' ? 'Codes (EN, JA)' : 'Flags')];
                const include = [c.LanguageTagsShowAudio !== false && A.fmt('audio'), c.LanguageTagsShowSubtitles === true && A.fmt('subtitles')].filter(Boolean);
                parts.push(include.length ? include.join(' + ') : A.fmt('None'));
                if (String(c.LanguageTagsPriority || '').trim()) parts.push(A.fmt('priority: {list}', { list: String(c.LanguageTagsPriority).trim() }));
                return parts.join(' · ');
            },
            sample: (ctx) => (String(ctx.config.LanguageTagsStyle || '').toLowerCase() === 'codes' ? [['lang', 'EN'], ['lang', 'JA']] : [['flag', 'gb'], ['flag', 'jp']]),
        },
        // "Where to show" (drawn for every group row by admin-tags.js).
        writes: ['TagGroupScopes'],
        fields: [
            { id: 'languageTagsEnabled', key: 'LanguageTagsEnabled', type: 'enable', label: 'Language tags for new users' },
            { id: 'languageTagsShowAudio', key: 'LanguageTagsShowAudio', type: 'switch', label: 'Include audio languages' },
            { id: 'languageTagsShowSubtitles', key: 'LanguageTagsShowSubtitles', type: 'switch', label: 'Include subtitle languages', desc: 'Subtitle languages follow the audio ones and carry a small CC mark. Both count towards the group\'s limit. Needs the server tag cache rebuilt once after updating.' },
            { id: 'languageTagsStyle', key: 'LanguageTagsStyle', type: 'pills', label: 'Style', desc: 'Both show the full language name on hover.', options: [['flags', 'Flags'], ['codes', 'Codes (EN, JA)']], read: (v) => (String(v || '').toLowerCase() === 'codes' ? 'codes' : 'flags') },
            { id: 'languageTagsCountBadge', key: 'LanguageTagsCountBadge', type: 'select', label: 'Dual / Multi audio badge', desc: 'Two audio languages show "Dual", three or more "Multi", instead of the audio flags or ahead of them.', options: [['off', 'Off'], ['only', 'Badge only'], ['both', 'Badge and flags']], read: (v) => (['only', 'both'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'off') },
            { id: 'languageTagsPriority', key: 'LanguageTagsPriority', type: 'text', wide: true, label: 'Priority languages', desc: 'Comma-separated names or codes. A title with audio in one of these always shows that flag among the ones shown. Leave blank to show the first languages found.', placeholder: 'e.g. English, Japanese, fr', break: true },
            { id: 'languageTagsPriorityStrict', key: 'LanguageTagsPriorityStrict', type: 'switch', label: 'Only show priority languages', desc: 'Hide flags for every language not listed. A title with none of them shows no flags.' },
            { id: 'languageTagsMergeRegions', key: 'LanguageTagsMergeRegions', type: 'switch', label: 'Merge regional variants', desc: 'One flag per language, as Jellyfin\'s own audio language filter does: English and English (United Kingdom) share a flag.' },
        ],
    });
})(window.JellyfinEnhanced);
