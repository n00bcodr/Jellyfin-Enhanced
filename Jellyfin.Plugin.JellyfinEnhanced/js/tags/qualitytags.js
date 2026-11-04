// /js/tags/qualitytags.js
// Jellyfin Quality Tags
// This is a modified version of the Jellyfin Quality Tags script by by BobHasNoSoul. - https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/
//
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. The quality
// resolution engine (stream analysis, category bucketing/ordering, colors)
// is quality-specific and intentionally stays in this module.
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Quality Tags:';
    const overlayClass = 'quality-overlay-label';
    const containerClass = 'quality-overlay-container';

    // Within-category sort orders (more important = lower index inside each category).
    const resolutionOrder = ['8K', '4K', '1440p', '1080p', '720p', '576p', '480p', 'LOW-RES', 'SD'];
    const sourceOrder = ['REMUX', 'BluRay', 'WEB', 'HD DVD', 'DVD', 'VHS', 'HDTV', 'Physical', 'CAM', 'TS', 'TC', 'SCR'];
    const EDITION_PREFIX = 'edition:';
    const editionOrder = [];
    const dynamicRangeOrder = ['Dolby Vision', 'HDR10+', 'HDR10', 'HLG', 'HDR', 'SDR'];
    const specialFormatOrder = ['IMAX', '3D'];
    const codecOrder = ['VVC', 'AV1', 'HEVC', 'H265', 'VP9', 'H264', 'VP8', 'XVID', 'DIVX', 'VC-1', 'WMV', 'MPEG2', 'MPEG4', 'MJPEG', 'THEORA', 'ProRes'];
    // TRaSH-Guides audio scores, highest first; from Dolby Digital+ on, lossy tracks rank by channels first.
    const audioOrder = ['TRUEHD ATMOS', 'DTS-X', 'ATMOS', 'DD+ ATMOS', 'TRUEHD', 'DTS-HD MA', 'PCM', 'FLAC', 'DTS-HD HRA', 'DTS-HD', 'Dolby Digital+', 'DTS', 'Dolby Digital', '7.1', '6.1', '5.1'];

    // showXxxTag = enable, xxxTagOrder = 1..N stack position.
    const CATEGORIES = [
        { key: 'resolution',    items: resolutionOrder,    settingKey: 'showResolutionTag',    pluginKey: 'ShowResolutionTag',    orderUserKey: 'resolutionTagOrder',    orderPluginKey: 'ResolutionTagOrder',    defaultOrder: 1 },
        { key: 'source',        items: sourceOrder,        settingKey: 'showSourceTag',        pluginKey: 'ShowSourceTag',        orderUserKey: 'sourceTagOrder',        orderPluginKey: 'SourceTagOrder',        defaultOrder: 2 },
        { key: 'dynamicRange',  items: dynamicRangeOrder,  settingKey: 'showDynamicRangeTag',  pluginKey: 'ShowDynamicRangeTag',  orderUserKey: 'dynamicRangeTagOrder',  orderPluginKey: 'DynamicRangeTagOrder',  defaultOrder: 3 },
        { key: 'specialFormat', items: specialFormatOrder, settingKey: 'showSpecialFormatTag', pluginKey: 'ShowSpecialFormatTag', orderUserKey: 'specialFormatTagOrder', orderPluginKey: 'SpecialFormatTagOrder', defaultOrder: 4 },
        { key: 'videoCodec',    items: codecOrder,         settingKey: 'showVideoCodecTag',    pluginKey: 'ShowVideoCodecTag',    orderUserKey: 'videoCodecTagOrder',    orderPluginKey: 'VideoCodecTagOrder',    defaultOrder: 5 },
        { key: 'audio',         items: audioOrder,         settingKey: 'showAudioInfoTag',     pluginKey: 'ShowAudioInfoTag',     orderUserKey: 'audioInfoTagOrder',     orderPluginKey: 'AudioInfoTagOrder',     defaultOrder: 6 },
        { key: 'edition', items: editionOrder, settingKey: 'showEditionTag', pluginKey: 'ShowEditionTag', orderUserKey: 'editionTagOrder', orderPluginKey: 'EditionTagOrder', defaultOrder: 7 },
        { key: 'runtime', items: [], settingKey: 'showRuntimeTag', pluginKey: 'ShowRuntimeTag', orderUserKey: 'runtimeTagOrder', orderPluginKey: 'RuntimeTagOrder', defaultOrder: 8, fallback: false },
        { key: 'aspectRatio', items: [], settingKey: 'showAspectRatioTag', pluginKey: 'ShowAspectRatioTag', orderUserKey: 'aspectRatioTagOrder', orderPluginKey: 'AspectRatioTagOrder', defaultOrder: 9, fallback: false },
        { key: 'frameRate', items: [], settingKey: 'showFrameRateTag', pluginKey: 'ShowFrameRateTag', orderUserKey: 'frameRateTagOrder', orderPluginKey: 'FrameRateTagOrder', defaultOrder: 10, fallback: false },
        { key: 'versions', items: [], settingKey: 'showVersionsTag', pluginKey: 'ShowVersionsTag', orderUserKey: 'versionsTagOrder', orderPluginKey: 'VersionsTagOrder', defaultOrder: 11, fallback: false },
    ];

    const TAG_TO_CATEGORY = new Map();
    for (const cat of CATEGORIES) {
        for (const item of cat.items) TAG_TO_CATEGORY.set(item, cat.key);
    }
    const CATEGORY_BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));

    // Color definitions for each quality tag.
    const qualityColors = {
        '8K': { bg: 'rgba(220, 20, 60, 0.95)', text: '#ffffff' },
        '4K': { bg: 'rgba(189, 5, 232, 0.95)', text: '#ffffff' },
        '1440p': { bg: 'rgba(255, 20, 147, 0.9)', text: '#ffffff' },
        '1080p': { bg: 'rgba(0, 191, 255, 0.9)', text: '#ffffff' },
        '720p': { bg: 'rgba(255, 165, 0, 0.9)', text: '#000000' },
        '576p': { bg: 'rgba(255, 179, 0, 0.85)', text: '#000000' },
        '480p': { bg: 'rgba(255, 193, 7, 0.85)', text: '#000000' },
        'SD': { bg: 'rgba(108, 117, 125, 0.85)', text: '#ffffff' },
        'SDR': { bg: 'rgba(84, 110, 122, 0.9)', text: '#ffffff' },
        'HDR': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'HDR10': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'HDR10+': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'HLG': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'Dolby Vision': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
        'IMAX': { bg: 'rgba(0, 114, 206, 0.9)', text: '#ffffff' },
        'ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
        'TRUEHD ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
        'DD+ ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
        'DTS-X': { bg: 'rgba(255, 100, 0, 0.9)', text: '#ffffff' },
        'DTS-HD MA': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
        'DTS-HD HRA': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
        'DTS-HD': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
        'Dolby Digital': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
        'DTS': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
        'Dolby Digital+': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
        'TRUEHD': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
        'PCM': { bg: 'rgba(46, 125, 50, 0.9)', text: '#ffffff' },
        'FLAC': { bg: 'rgba(46, 125, 50, 0.9)', text: '#ffffff' },
        '7.1': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
        '6.1': { bg: 'rgba(126, 87, 194, 0.9)', text: '#ffffff' },
        '5.1': { bg: 'rgba(103, 58, 183, 0.9)', text: '#ffffff' },
        '3D': { bg: 'rgba(0, 150, 255, 0.9)', text: '#ffffff' },
        'VVC': { bg: 'rgba(230, 74, 25, 0.95)', text: '#ffffff' },
        'AV1': { bg: 'rgba(255, 87, 34, 0.95)', text: '#ffffff' },
        'HEVC': { bg: 'rgba(33, 150, 243, 0.9)', text: '#ffffff' },
        'H265': { bg: 'rgba(63, 81, 181, 0.9)', text: '#ffffff' },
        'VP9': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
        'H264': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
        'VP8': { bg: 'rgba(121, 85, 72, 0.9)', text: '#ffffff' },
        'XVID': { bg: 'rgba(255, 152, 0, 0.9)', text: '#ffffff' },
        'DIVX': { bg: 'rgba(255, 193, 7, 0.9)', text: '#000000' },
        'VC-1': { bg: 'rgba(0, 188, 212, 0.9)', text: '#ffffff' },
        'WMV': { bg: 'rgba(0, 188, 212, 0.9)', text: '#ffffff' },
        'MPEG2': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
        'MPEG4': { bg: 'rgba(158, 158, 158, 0.9)', text: '#ffffff' },
        'MJPEG': { bg: 'rgba(233, 30, 99, 0.9)', text: '#ffffff' },
        'THEORA': { bg: 'rgba(139, 195, 74, 0.9)', text: '#ffffff' },
        'ProRes': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
        'REMUX': { bg: 'rgba(13, 71, 161, 0.95)', text: '#ffffff' },
        'WEB': { bg: 'rgba(0, 121, 107, 0.95)', text: '#ffffff' },
        'CAM': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
        'TS': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
        'TC': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
        'SCR': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
        'Director\'s Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Extended': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Unrated': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Theatrical': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Remastered': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Criterion': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Uncut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Final Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Special Edition': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Redux': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Ultimate': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Collector\'s Edition': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Anniversary': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Uncensored': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'Open Matte': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
        'BluRay': { bg: 'rgba(0, 102, 204, 0.95)', text: '#ffffff' },
        'HD DVD': { bg: 'rgba(128, 0, 32, 0.95)', text: '#ffffff' },
        'DVD': { bg: 'rgba(102, 102, 102, 0.95)', text: '#ffffff' },
        'VHS': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
        'HDTV': { bg: 'rgba(69, 90, 100, 0.95)', text: '#ffffff' },
        'Physical': { bg: 'rgba(102, 102, 102, 0.9)', text: '#ffffff' },
        'Mixed': { bg: '#546e7a', text: '#ffffff' }
    };

    // Computed quality labels derived from server cache entries
    const serverQualityCache = new Map();

    // Jellyfin audio-language preference (user.Configuration.AudioLanguagePreference)
    // of the signed-in user, loaded by primeJellyfinAudioPreference(). Only
    // trusted while jellyfinAudioPreferenceUserId is still the current user.
    let jellyfinAudioPreference = null;
    let jellyfinAudioPreferenceUserId = null;
    let jellyfinAudioPreferencePromise = null;
    let jellyfinAudioPreferencePromiseUserId = null;

    /**
     * Effective preferred audio language for the sound tag, or null for
     * "best track overall" (the pre-existing behaviour). Resolution order:
     * the user's own choice (a language code, "auto" = their Jellyfin audio
     * language, "none" = no preference), then the server default — each
     * user's Jellyfin audio language when the admin enabled that and the
     * user has one, else the admin's fixed language.
     * @returns {string|null}
     */
    function resolvePreferredAudioLanguage() {
        const choice = (JE.currentSettings?.qualityTagsPreferredAudioLanguage || '').trim();
        const lowered = choice.toLowerCase();
        if (lowered === 'none') return null;
        const currentUserId = window.ApiClient?.getCurrentUserId?.() || null;
        const jellyfinPref = (currentUserId && currentUserId === jellyfinAudioPreferenceUserId)
            ? jellyfinAudioPreference
            : null;
        if (lowered === 'auto') return jellyfinPref;
        if (choice) return choice;
        if (JE.pluginConfig?.QualityTagsAudioLanguageFromUser && jellyfinPref) return jellyfinPref;
        return (JE.pluginConfig?.QualityTagsPreferredAudioLanguage || '').trim() || null;
    }

    /**
     * Whether the effective preference depends on the user's Jellyfin audio
     * language: they picked "auto", or they inherit the server default and
     * the admin turned on "use each user's Jellyfin audio language".
     * @returns {boolean}
     */
    function usesJellyfinAudioPreference() {
        const choice = (JE.currentSettings?.qualityTagsPreferredAudioLanguage || '').trim().toLowerCase();
        if (choice === 'auto') return true;
        return !choice && !!JE.pluginConfig?.QualityTagsAudioLanguageFromUser;
    }

    /**
     * Loads the signed-in user's Jellyfin audio language preference when the
     * effective setting needs it (no request otherwise). One request per
     * user at a time; a failure is logged and keeps whatever was loaded
     * (no preference for a user with nothing loaded yet).
     * @returns {Promise<void>}
     */
    function primeJellyfinAudioPreference() {
        const userId = window.ApiClient?.getCurrentUserId?.() || null;
        if (!userId || !usesJellyfinAudioPreference()) return Promise.resolve();
        // Reuse a request already in flight for this user; one started for a
        // previous user (switch mid-flight) resolves as a no-op below.
        if (jellyfinAudioPreferencePromise && jellyfinAudioPreferencePromiseUserId === userId) {
            return jellyfinAudioPreferencePromise;
        }
        // ApiClient.getCurrentUser() hands back a memoised copy that Jellyfin's
        // playback-settings page never refreshes, so a preference changed in
        // this session would stay stale until reload; getUser() always fetches.
        const request = Promise.resolve()
            .then(() => ApiClient.getUser(userId))
            .then((user) => {
                // A user switch while the request was in flight: the incoming
                // user's own initialization loads its value.
                if (window.ApiClient?.getCurrentUserId?.() !== userId) return;
                jellyfinAudioPreference = (user?.Configuration?.AudioLanguagePreference || '').trim() || null;
                jellyfinAudioPreferenceUserId = userId;
            })
            .catch((err) => {
                console.warn(`${logPrefix} Could not read the Jellyfin audio language preference`, err);
                // A user with nothing loaded yet counts as having no preference,
                // so the tags render (and a later refresh is not held up).
                if (window.ApiClient?.getCurrentUserId?.() === userId && jellyfinAudioPreferenceUserId !== userId) {
                    jellyfinAudioPreference = null;
                    jellyfinAudioPreferenceUserId = userId;
                }
            })
            .finally(() => {
                if (jellyfinAudioPreferencePromise === request) {
                    jellyfinAudioPreferencePromise = null;
                    jellyfinAudioPreferencePromiseUserId = null;
                }
            });
        jellyfinAudioPreferencePromise = request;
        jellyfinAudioPreferencePromiseUserId = userId;
        return request;
    }

    /**
     * Whether the sound tag depends on the signed-in user's Jellyfin audio
     * language and that value is still being fetched for them (right after a
     * user switch). Cards stay untagged meanwhile instead of being judged by
     * no preference: tagged cards are skipped on rescan, so a wrong tag would
     * otherwise stick. The registration that follows the request rescans them.
     * @returns {boolean}
     */
    function isAudioPreferencePending() {
        const userId = window.ApiClient?.getCurrentUserId?.() || null;
        return !!userId
            && jellyfinAudioPreferencePromiseUserId === userId
            && jellyfinAudioPreferenceUserId !== userId
            && usesJellyfinAudioPreference();
    }

    let playbackPreferencesWatched = false;

    /**
     * Re-reads the Jellyfin audio language when the user leaves Jellyfin's
     * playback settings page (where it is changed) and re-renders the tags if
     * it changed, so a new preference applies without a page reload. Costs one
     * request per visit, and only when the effective setting follows it.
     */
    function watchPlaybackPreferencesPage() {
        if (playbackPreferencesWatched || typeof JE.core?.navigation?.onNavigate !== 'function') return;
        playbackPreferencesWatched = true;
        const isPlaybackPreferences = () => /mypreferencesplayback/i.test(window.location.href);
        let onPage = isPlaybackPreferences();
        JE.core.navigation.onNavigate(() => {
            const wasOnPage = onPage;
            onPage = isPlaybackPreferences();
            if (!wasOnPage || onPage) return;
            if (!JE.currentSettings?.qualityTagsEnabled || !usesJellyfinAudioPreference()) return;
            const before = resolvePreferredAudioLanguage();
            primeJellyfinAudioPreference().then(() => {
                if (resolvePreferredAudioLanguage() !== before) JE.core.tagRenderer.reinitialize('quality', spec);
            });
        });
    }

    /**
     * Cache stamp for the preference a set of qualities was computed under.
     * Old entries carry none, which equals "no preference".
     * @returns {string}
     */
    function audioPreferenceKey() {
        return resolvePreferredAudioLanguage() || '';
    }

    /**
     * Whether a cached entry was computed under the current preference; one
     * computed under another is a miss and gets recomputed.
     * @param {{audioLang?: string}} entry
     * @returns {boolean}
     */
    function matchesAudioPreference(entry) {
        return entry.namingVersion === 16 && entry.legacyAudio === legacyFullAudio() && entry.displayModeKey === displayModeKey() && (entry.audioLang || '') === audioPreferenceKey();
    }

    // The version (media source) the user last picked for an item, remembered
    // per browser. Library posters and the details poster show that version's
    // badges; an item with no pick keeps showing its first version.
    const SOURCE_PREF_KEY = 'je-quality-source';
    const SOURCE_PREF_MAX = 500;

    /** @returns {string} Lowercase hexadecimal item id, or '' when unusable. */
    function normItemId(id) {
        return String(id || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    }

    let sourcePrefs = new Map();
    let sourcePrefsMemoryOnly = false;
    /** @returns {Map<string, string>} Valid picks from the existing JSON object format. */
    function readSourcePrefs() {
        if (sourcePrefsMemoryOnly) return sourcePrefs;
        try {
            const parsed = JSON.parse(localStorage.getItem(SOURCE_PREF_KEY) || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                sourcePrefs = new Map();
                for (const [key, value] of Object.entries(parsed)) {
                    if (typeof value !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase())) continue;
                    const id = normItemId(key);
                    if (id) sourcePrefs.set(id, value);
                }
            }
            return sourcePrefs;
        } catch {
            return sourcePrefs;
        }
    }

    /** @returns {string} The remembered media source id, or '' for the default. */
    function selectedSourceFor(itemId) {
        const id = normItemId(itemId);
        return id ? readSourcePrefs().get(id) || '' : '';
    }

    /** Remember a pick as the newest entry, keeping the stored JSON object format. */
    function rememberSource(itemId, sourceId) {
        const id = normItemId(itemId);
        if (!id) return;
        const prefs = readSourcePrefs();
        prefs.delete(id); // re-insert so the newest pick sits last
        prefs.set(id, sourceId);
        while (prefs.size > SOURCE_PREF_MAX) prefs.delete(prefs.keys().next().value);
        try {
            localStorage.setItem(SOURCE_PREF_KEY, JSON.stringify(Object.fromEntries(prefs)));
        } catch { sourcePrefsMemoryOnly = true; /* the pick lasts until reload */ }
    }

    /**
     * Whether a cached entry matches both the audio preference and the item's
     * remembered version.
     * @param {{audioLang?: string, srcId?: string}} entry
     * @param {string} itemId
     * @returns {boolean}
     */
    function matchesCache(entry, itemId) {
        return matchesAudioPreference(entry) && (entry.srcId || '') === selectedSourceFor(itemId);
    }

    /**
     * Narrows the audio streams to the preferred language when one is set.
     * Tiers: streams matching language and region (when the preference has
     * one), then streams matching the language, then — when the title has
     * no audio in that language at all — every stream, exactly as before.
     * @param {Array} audioStreams - Audio streams in file order.
     * @param {string|null} preferred - From resolvePreferredAudioLanguage().
     * @returns {Array}
     */
    function selectAudioStreamsForLanguage(audioStreams, preferred) {
        // Commentary and audio description never stand for the soundtrack while an ordinary track exists.
        const secondary = JE.core.mediaLanguage?.isSecondaryAudio;
        if (typeof secondary === 'function' && audioStreams.some((s) => !secondary(s))) audioStreams = audioStreams.filter((s) => !secondary(s));
        const match = JE.core.mediaLanguage?.matchesLanguage;
        if (!preferred || !audioStreams.length || typeof match !== 'function') return audioStreams;
        const exact = audioStreams.filter((s) => match(s.Language, preferred, { requireRegion: true }));
        if (exact.length) return exact;
        const loose = audioStreams.filter((s) => match(s.Language, preferred));
        return loose.length ? loose : audioStreams;
    }

    /**
     * Creates a single quality tag element.
     * @param {string} label The text for the tag (e.g., "4K", "HDR").
     * @returns {HTMLElement} The created div element for the tag.
     */
    function createResponsiveLabel(label) {
        const normalizedLabel = normalizeQualityLabel(label);
        const badge = document.createElement('div');
        const category = categorize(label);
        const technical = ['runtime', 'aspectRatio', 'frameRate', 'versions'].includes(category);
        const edition = label.startsWith(EDITION_PREFIX);
        const displayLabel = edition || technical ? label.slice(label.indexOf(':') + 1) : label;
        badge.textContent = edition ? editionLabel(displayLabel) : category === 'versions' ? versionsText(displayLabel) : displayLabel;
        if (technical) {
            badge.dataset.jeQualityCategory = category;
            badge.dataset.jeCompact = category === 'versions' ? `×${displayLabel}` : compactTechnical(displayLabel, category);
            badge.title = badge.textContent;
        }
        badge.className = overlayClass;
        if (label === 'Mixed') badge.textContent = JE.t('series_quality_mixed');
        if (label === 'Mixed') {
            badge.classList.add('mixed');
            badge.dataset.jeCompact = JE.t('series_quality_mixed_compact');
            badge.title = JE.t('series_quality_mixed');
        }

        // Existing class names preserved for backward-compat with user CSS.
        // Source tags (BluRay/DVD/etc.) keep `.other-quality` from the
        // pre-PR behavior so user CSS targeting that class still matches.
        if (resolutionOrder.includes(normalizedLabel)) {
            badge.classList.add('resolution');
        } else if (codecOrder.includes(normalizedLabel)) {
            badge.classList.add('video-format');
        } else if (dynamicRangeOrder.includes(normalizedLabel) || specialFormatOrder.includes(normalizedLabel)) {
            badge.classList.add('video-codec');
        } else if (audioOrder.includes(normalizedLabel)) {
            badge.classList.add('audio-codec');
        } else {
            badge.classList.add('other-quality');
        }
        badge.dataset.quality = technical ? category : edition ? displayLabel : normalizedLabel;
        if (edition) {
            badge.dataset.jeEdition = 'true';
            badge.dataset.jeCompact = compactEditionLabel(displayLabel);
        }
        return badge;
    }

    // Full words are translatable; compact edition codes and proper nouns are literals.
    const EDITIONS = {"Director's Cut": ["quality_edition_directors_cut", "DC"], "Extended": ["quality_edition_extended", "Ext"], "Unrated": ["quality_edition_unrated", "Unr"], "Theatrical": ["quality_edition_theatrical", null], "IMAX": [null, "IMAX"], "Remastered": ["quality_edition_remastered", "Rem"], "Criterion": [null, "CC"], "Uncut": ["quality_edition_uncut", null], "Final Cut": ["quality_edition_final_cut", null], "Special Edition": ["quality_edition_special", "quality_edition_special_compact"], "Redux": [null, "Redux"], "Ultimate": ["quality_edition_ultimate", "Ult"], "Collector's Edition": ["quality_edition_collectors", "CE"], "Anniversary": ["quality_edition_anniversary", "Anniv"], "Uncensored": ["quality_edition_uncensored", "Unc"], "Open Matte": [null, "OM"]};
    /** @param {string} label Canonical edition. @returns {string} Its full display name. */
    function editionLabel(label) {
        const row = Object.hasOwn(EDITIONS, label) && EDITIONS[label];
        return row && row[0] ? JE.t(row[0]) : label;
    }
    /** @param {string} label Canonical edition. @returns {string} A compact code or translated word. */
    function compactEditionLabel(label) {
        const row = Object.hasOwn(EDITIONS, label) && EDITIONS[label];
        return row?.[1] ? row[1].startsWith('quality_') ? JE.t(row[1]) : row[1] : editionLabel(label);
    }

    /**
     * Normalizes dynamic quality labels to their base key for sorting and CSS color matching.
     * @param {string} label - The quality label to normalize.
     * @returns {string} The normalized base label.
     */
    function normalizeQualityLabel(label) {
        if (!label || typeof label !== 'string') return label;

        const audioBases = ['TRUEHD ATMOS', 'DD+ ATMOS', 'Dolby Digital+', 'Dolby Digital', 'ATMOS', 'DTS-X', 'TRUEHD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-HD', 'DTS', 'PCM', 'FLAC'];
        for (const base of audioBases) {
            if (label === base || label.startsWith(`${base} `)) {
                return base;
            }
        }

        return label;
    }

    // Which current per-track labels each earlier-vocabulary codec may stand for (it may name less, never more).
    const LEGACY_STANDS_FOR = {
        'ATMOS': ['TRUEHD ATMOS', 'DD+ ATMOS', 'ATMOS'],
        'TRUEHD': ['TRUEHD', 'TRUEHD ATMOS'],
        'DTS-X': ['DTS-X'],
        'DTS': ['DTS', 'DTS-HD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-X'],
        'Dolby Digital+': ['Dolby Digital+', 'DD+ ATMOS'],
    };
    const LEGACY_BUCKETS = ['2.0', '5.1', '7.1'];
    // The earlier-vocabulary name of a current per-track codec; Dolby Digital, PCM and FLAC had none.
    const LEGACY_NAME = { 'TRUEHD ATMOS': 'ATMOS', 'DD+ ATMOS': 'ATMOS', 'ATMOS': 'ATMOS', 'DTS-X': 'DTS-X', 'TRUEHD': 'TRUEHD',
        'DTS-HD MA': 'DTS', 'DTS-HD HRA': 'DTS', 'DTS-HD': 'DTS', 'DTS': 'DTS', 'Dolby Digital+': 'Dolby Digital+' };

    /** @param {string|null} layout A track layout such as "5.1.2". @returns {string|null} Its earlier channel bucket. */
    function legacyBucket(layout) {
        const total = String(layout || '').split('.').reduce((sum, part) => sum + (Number(part) || 0), 0);
        return total >= 8 ? '7.1' : total >= 6 ? '5.1' : total >= 2 ? '2.0' : null;
    }

    /**
     * Version-0 sound (QualityTagRules.TruthfulLegacyAudio): keep its codec and channel bucket when one eligible track
     * holds both (the codec naming that track's carrier or less, the track having at least those channels); otherwise
     * describe the best single track in the same vocabulary, so a TrueHD 2.0 track beside an AAC 7.1 never reads TRUEHD 7.1.
     * @param {string|null} codec Earlier-vocabulary codec.
     * @param {string|null} channels Earlier channel bucket.
     * @param {Object[]} streams Eligible audio tracks.
     * @returns {{codec: string|null, channels: string|null}}
     */
    function truthfulLegacyAudio(codec, channels, streams) {
        const tracks = streams.map(stream => ({ label: detectCurrentAudioCodec([stream]), bucket: legacyBucket(trackChannels(stream)), stream }));
        const holds = track => (codec === null || (LEGACY_STANDS_FOR[codec] || []).includes(track.label))
            && (channels === null || LEGACY_BUCKETS.indexOf(track.bucket) >= LEGACY_BUCKETS.indexOf(channels));
        if (tracks.some(holds)) return { codec, channels };
        let best = null;
        for (const track of tracks) {
            const label = trackAudioLabel(track.stream);
            if (label && (best === null || distinctRank(label, 'audio') < distinctRank(best.text, 'audio'))) best = { text: label, track };
        }
        if (!best) return { codec: null, channels: null };
        return { codec: LEGACY_NAME[best.track.label] ?? null, channels: best.track.bucket };
    }

    /**
     * Finds the richest channel layout available across audio streams.
     * @param {Array} audioStreams - Audio streams from item metadata.
     * @returns {string|null} A channel tag such as "7.1", "5.1", or "2.0".
     */
    function getChannelTag(audioStreams) {
        if (!Array.isArray(audioStreams) || audioStreams.length === 0) return null;

        const rank = { '7.1': 3, '5.1': 2, '2.0': 1 };
        let maxChannels = 0;
        let detectedLayoutTag = null;

        for (const stream of audioStreams) {
            const channels = stream.Channels || 0;
            if (channels > maxChannels) {
                maxChannels = channels;
            }

            const layoutSignals = `${stream.ChannelLayout || ''} ${stream.DisplayTitle || ''}`.toLowerCase();
            let tag = null;
            if (/\b7[. ]?1\b/.test(layoutSignals)) {
                tag = '7.1';
            } else if (/\b5[. ]?1\b/.test(layoutSignals)) {
                tag = '5.1';
            } else if (/\bstereo\b|\b2[. ]?0\b/.test(layoutSignals)) {
                tag = '2.0';
            }

            // A layout the track's reported channel count cannot hold is ignored (a stereo track titled 7.1).
            const needs = { '7.1': 8, '5.1': 6, '2.0': 2 };
            if (tag && channels > 0 && channels < needs[tag]) tag = null;

            if (tag && (!detectedLayoutTag || rank[tag] > rank[detectedLayoutTag])) {
                detectedLayoutTag = tag;
            }
        }

        if (detectedLayoutTag) {
            return detectedLayoutTag;
        }

        if (maxChannels >= 8) return '7.1';
        if (maxChannels >= 6) return '5.1';
        if (maxChannels >= 2) return '2.0';

        return null;
    }

    /**
     * "2 versions" in the user's language (native posters: PosterTagResolver, quality_versions_count).
     * @param {string} count Number of versions.
     * @returns {string}
     */
    function versionsText(count) {
        const text = JE.t('quality_versions_count', { count });
        return (text === 'quality_versions_count' ? '{count} versions' : text).replace('{count}', count);
    }

    /**
     * How many versions an item has: its listed sources with an id, else the distinct source ids of
     * its streams (QualityTagRules.VersionCount).
     * @param {Object[]} [streams]
     * @param {Object[]} [sources]
     * @returns {number}
     */
    function versionCount(streams, sources) {
        const listed = new Set((sources || []).map(s => s?.Id).filter(Boolean));
        return listed.size || new Set((streams || []).map(s => s?.SourceId).filter(Boolean)).size;
    }

    /** Compact technical text; values stay identical across densities. */
    function compactTechnical(label, category) {
        if (category === 'runtime') return label.replace(/(\d+)h (\d+)m/, '$1h$2');
        if (category === 'aspectRatio') return label.replace(/^IMAX /, '').replace(/:1$/, '');
        return label;
    }

    /** Technical labels from the representative item's runtime and first video stream. */
    function technicalLabels(ticks, video) {
        const labels = [];
        const minutes = Math.floor(Number(ticks) / 600000000);
        if (Number.isFinite(minutes) && minutes > 0) labels.push('runtime:' + (minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`));
        if (!video) return labels;
        const parts = String(video.AspectRatio || '').trim().split(/[:/]/).map(Number);
        let ratio = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[0] / parts[1] : 0;
        if (!Number.isFinite(ratio) || ratio <= 0) ratio = video.Width > 0 && video.Height > 0 ? video.Width / video.Height : 0;
        if (ratio >= .5 && ratio <= 4) {
            // Generated by scripts/generate_technical_ratios.py; edit TechnicalQualityRules.cs.
            const ratios = [[1.3333333333333333,0.025,"4:3"],[1.43,0.015,"IMAX 1.43"],[1.66,0.02,"1.66:1"],[1.7777777777777777,0.025,"16:9"],[1.85,0.025,"1.85:1"],[1.9,0.02,"1.90:1"],[2.0,0.025,"2:1"],[2.2,0.025,"2.20:1"],[2.35,0.019,"2.35:1"],[2.39,0.025,"2.39:1"],[2.76,0.025,"2.76:1"]];
            // End generated aspect ratios.
            const snap = ratios.filter(([value, tolerance]) => Math.abs(value - ratio) <= tolerance).sort((a, b) => Math.abs(a[0] - ratio) - Math.abs(b[0] - ratio))[0];
            labels.push('aspectRatio:' + (snap?.[2] || ratio.toFixed(2) + ':1'));
        }
        const real = Number(video.RealFrameRate);
        const rate = Number.isFinite(real) && real > 0 ? real : Number(video.AverageFrameRate);
        if (Number.isFinite(rate) && rate > 0 && rate <= 240) {
            const value = rate * (video.IsInterlaced === true ? 2 : 1);
            const snap = [24, 25, 30, 48, 50, 60, 100, 120, 144, 240].find(common => Math.abs(value - common) <= .15);
            labels.push('frameRate:' + (snap || Number(value.toFixed(2))) + (video.IsInterlaced === true ? 'i' : 'p'));
        }
        return labels;
    }

    // --- CORE LOGIC ---
    // Reference: Radarr/Sonarr audio custom formats, TRaSH-Guides Audio Formats:
    // https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/#audio-formats
    // Stream aliases use the established chip vocabulary: both Atmos families (and E-AC-3 JOC) →
    // ATMOS, DTS-ES → DTS; lossless FLAC and (L)PCM have their own chips; AAC/Opus/MP3 keep the
    // channel-only fallback. HRA and MA precede a bare DTS-HD, which claims neither (only an MA,
    // XLL or Master Audio word, in the title or the profile, says lossless); Plus/Atmos precede
    // plain DD. Boundaries reject suffixes.
    const AUDIO_ALIASES = [
        [/(?:^|[^a-z0-9_])(?:atmos|ddpa|joc)(?![a-z_])/, 'ATMOS'],
        [/(?:^|[^a-z0-9_])true[ .-]?hd(?![a-z_])/, 'TRUEHD'],
        [/(?:^|[^a-z0-9_])dts[-_.: ]?x7?(?![a-z_])(?![-_. ]?26[456])/, 'DTS-X'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:hra?|hi|high[ -]?resolution)(?![a-z_])/, 'DTS-HD HRA'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?(?:hd[-_. ]?)?(?:ma|xll|master[ -]?audio)(?![a-z_])/, 'DTS-HD MA'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?hd(?![a-z_])/, 'DTS-HD'],
        [/(?:^|[^a-z0-9_])dts[-_. ]?es(?![a-z_])/, 'DTS'],
        [/(?:^|[^a-z0-9_])dts(?![a-z_])/, 'DTS'],
        [/(?:^|[^a-z0-9_])(?:ddp(?:lus)?|dd\+|e[-_. ]?ac-?3|dolby\s*digital(?:\s*plus|\s*\+))(?![a-z_])/, 'Dolby Digital+'],
        [/(?:^|[^a-z0-9_])(?:dd(?!\s*\+)|dolby\s*digital(?!\s*(?:plus|\+)))(?![a-z_])|(?:^|[^a-z0-9_-])ac-?3(?![a-z_])/, 'Dolby Digital'],
        [/(?:^|[^a-z0-9_])flac(?![a-z_])/, 'FLAC'],
        [/(?:^|[^a-z0-9_])l?pcm(?![a-z])/, 'PCM'],
    ];

    /**
     * Match the most specific stream alias before its carrier codec.
     * @param {string} text Display title or technical metadata.
     * @returns {string|null} Canonical sound chip identity, before channels.
     */
    function audioCodecFromText(text) {
        const value = String(text || '').toLowerCase();
        return AUDIO_ALIASES.find(([pattern]) => pattern.test(value))?.[1] || null;
    }

    /**
     * Keep first-recognized-title priority, enriching its carrier from the same track's
     * profile; only use metadata-only tracks when no display title identifies a codec.
     * @param {Object[]} streams Eligible audio tracks.
     * @returns {string|null} Current codec label; legacy detection remains independent.
     */
    function detectCurrentAudioCodec(streams) {
        for (const stream of streams) {
            const title = audioCodecFromText(stream.DisplayTitle);
            if (!title) continue;
            // The title refined by the same track's codec and profile, else the title alone, if the codec can carry it.
            const label = [audioCodecFromText([stream.DisplayTitle, stream.Codec, stream.Profile].filter(Boolean).join(' ')) || title, title]
                .map(candidate => atmosCarrier(candidate, stream)).find(candidate => carrierAllows(candidate, stream.Codec));
            if (label) return label;
        }
        for (const stream of streams) {
            const label = [audioCodecFromText([stream.Codec, stream.Profile].filter(Boolean).join(' ')), audioCodecFromText(stream.Codec)]
                .filter(Boolean).map(candidate => atmosCarrier(candidate, stream)).find(candidate => carrierAllows(candidate, stream.Codec));
            if (label) return label;
        }
        return null;
    }

    // What each known stream codec can be (QualityTagRules.CarrierAllows): a title may refine its carrier
    // (DTS → DTS-HD MA, E-AC-3 → DD+ ATMOS) but never contradict it, so an AC-3 track titled "Atmos" stays
    // Dolby Digital and an AAC track titled "TrueHD" has no codec chip. An unknown codec lets the title decide.
    const CARRIERS = [
        [/^(?:e-?ac-?3|ddp)/, ['Dolby Digital+', 'DD+ ATMOS']],
        [/^ac-?3$/, ['Dolby Digital']],
        [/^(?:truehd|mlp)/, ['TRUEHD', 'TRUEHD ATMOS']],
        [/^(?:dts|dca)/, ['DTS', 'DTS-HD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-X']],
        [/^flac/, ['FLAC']],
        [/^pcm/, ['PCM']],
        [/^(?:aac|opus|mp[23]|vorbis|alac|wmav)/, []],
    ];

    /**
     * @param {string} label Detected sound label.
     * @param {string} [codec] The track's stream codec.
     * @returns {boolean} Whether the codec can carry that label.
     */
    function carrierAllows(label, codec) {
        const known = CARRIERS.find(([pattern]) => pattern.test(String(codec || '').toLowerCase()));
        return !known || known[1].includes(label);
    }

    /**
     * Atmos with the carrier that holds it (TRaSH's TrueHD Atmos and DD+ Atmos): lossless TrueHD,
     * lossy E-AC-3, or plain ATMOS when the track does not say (QualityTagRules.AtmosCarrier).
     * @param {string} label Detected codec label.
     * @param {Object} stream The same track.
     * @returns {string} The label, with its carrier when it is ATMOS.
     */
    function atmosCarrier(label, stream) {
        if (label !== 'ATMOS') return label;
        // The stream codec names the carrier first: a TrueHD title cannot hide an E-AC-3 JOC track's Atmos.
        const codec = String(stream.Codec || '').toLowerCase();
        if (/^(?:truehd|mlp)/.test(codec)) return 'TRUEHD ATMOS';
        if (/^(?:e-?ac-?3|ddp)/.test(codec)) return 'DD+ ATMOS';
        const text = [stream.Codec, stream.Profile, stream.DisplayTitle].filter(Boolean).join(' ').toLowerCase();
        if (/(?:^|[^a-z0-9_])(?:true[ .-]?hd|mlp)(?![a-z_])/.test(text)) return 'TRUEHD ATMOS';
        if (/(?:^|[^a-z0-9_])(?:e[-_. ]?ac-?3|ddp(?:a|lus)?|dd\+|dolby\s*digital\s*(?:plus|\+))(?![a-z_])/.test(text)) return 'DD+ ATMOS';
        return label;
    }

    // ffmpeg channel layout names → the layout they are (the "(side)"/"(back)"/"(wide)" variants share it).
    const NAMED_LAYOUTS = { mono: '1.0', stereo: '2.0', quad: '4.0', hexagonal: '6.0', octagonal: '8.0' };
    // A bare count only says the usual layout for counts with one (Jellyfin's own convention).
    const COUNT_LAYOUTS = { 1: '1.0', 2: '2.0', 6: '5.1', 7: '6.1', 8: '7.1' };

    /**
     * One track's actual channel layout: its ChannelLayout, then a layout named in its title, then
     * the usual layout for its channel count. Height channels stay ("5.1.2", "7.1.4"). Unknown
     * stays unknown (QualityTagRules.TrackChannels).
     * @param {Object} stream Audio track.
     * @returns {string|null} Layout such as "6.1", "4.0", "1.0" or "7.1.4".
     */
    function trackChannels(stream) {
        const layout = String(stream.ChannelLayout || '').toLowerCase().replace(/\(.*\)$/, '').trim();
        if (Object.hasOwn(NAMED_LAYOUTS, layout)) return NAMED_LAYOUTS[layout];
        const numeric = /^(\d)\.(\d)(?:\.(\d))?$/.exec(layout);
        if (numeric) return numeric.slice(1).filter(Boolean).join('.');
        // A title layout only counts when the track's own channel count is unknown or agrees with it (its bed,
        // or bed plus heights: TrueHD Atmos 7.1.4 over 8 channels), so a stereo encode titled "5.1" stays 2.0.
        const count = Number(stream.Channels) > 0 ? Number(stream.Channels) : 0;
        const agrees = found => {
            const [bed, lfe, height = 0] = found.split('.').map(Number);
            return !count || bed + lfe === count || bed + lfe + height === count;
        };
        const title = String(stream.DisplayTitle || '').toLowerCase();
        const named = /(?:^|[^a-z0-9_])([1-7])[. ]([01])(?:\.([246]))?(?![a-z0-9_])/.exec(title);
        const fromTitle = named ? named.slice(1).filter(Boolean).join('.')
            : /(?:^|[^a-z0-9_])stereo(?![a-z0-9_])/.test(title) ? '2.0'
            : /(?:^|[^a-z0-9_])mono(?![a-z0-9_])/.test(title) ? '1.0' : null;
        if (fromTitle && agrees(fromTitle)) return fromTitle;
        return COUNT_LAYOUTS[stream.Channels] || null;
    }

    /**
     * One track's own sound label: its codec with its own channels, or a bare surround layout
     * (its bed only: "5.1.2" without a codec is 5.1).
     * @param {Object} stream Audio track.
     * @returns {string|null} Label such as "ATMOS 7.1", or null.
     */
    function trackAudioLabel(stream) {
        const codec = detectCurrentAudioCodec([stream]);
        const channels = trackChannels(stream);
        if (!codec) {
            const bed = channels?.slice(0, 3);
            return ['7.1', '6.1', '5.1'].includes(bed) ? bed : null;
        }
        return channels && !codec.includes(channels) ? `${codec} ${channels}` : codec;
    }

    /**
     * Highest sound for current vocabularies: rank every eligible track by codec tier, then
     * channels, and keep the winning track's own label (first track wins a tie).
     * @param {Object[]} streams Audio tracks after the language tiers.
     * @returns {string|null} The best single track's label.
     */
    function bestAudioLabel(streams) {
        let best = null;
        for (const stream of streams) {
            const label = trackAudioLabel(stream);
            if (label && (best === null || distinctRank(label, 'audio') < distinctRank(best, 'audio'))) best = label;
        }
        return best;
    }

    // Jellyfin's VideoRangeType values (both supported targets), lowercased. A Dolby Vision
    // stream keeps its base layer so All mode can show the fallback a non-DV display gets.
    const RANGE_TYPES = {
        sdr: { range: null, base: null, sdr: true },
        hdr10: { range: 'HDR10', base: null, sdr: false },
        hdr10plus: { range: 'HDR10+', base: null, sdr: false },
        hlg: { range: 'HLG', base: null, sdr: false },
        dovi: { range: 'Dolby Vision', base: null, sdr: false },
        doviwithhdr10: { range: 'Dolby Vision', base: 'HDR10', sdr: false },
        doviwithhdr10plus: { range: 'Dolby Vision', base: 'HDR10+', sdr: false },
        doviwithhlg: { range: 'Dolby Vision', base: 'HLG', sdr: false },
        doviwithsdr: { range: 'Dolby Vision', base: 'SDR', sdr: false },
        doviwithel: { range: 'Dolby Vision', base: 'HDR10', sdr: false },
        doviwithelhdr10plus: { range: 'Dolby Vision', base: 'HDR10+', sdr: false },
    };

    /**
     * Dynamic range of one video stream: Jellyfin's VideoRangeType first; only a missing or
     * unknown type falls back to word-bounded hints in the display title and the type text
     * ("DVD" is not Dolby Vision).
     * @param {Object} video Video stream.
     * @returns {{range: string|null, base: string|null, sdr: boolean}} Range, DV base layer, known SDR.
     */
    function videoRangeFacts(video) {
        const type = String(video?.VideoRangeType || '').toLowerCase();
        if (Object.hasOwn(RANGE_TYPES, type)) return RANGE_TYPES[type];
        // An unrecognised type string still counts as a hint, after the title.
        const title = `${video?.DisplayTitle || ''} ${type}`.toLowerCase();
        const word = (pattern) => new RegExp(`(?:^|[^a-z0-9_])(?:${pattern})(?![a-z0-9_])`).test(title);
        if (word('dolby\\s*vision|dovi|dv')) return { range: 'Dolby Vision', base: null, sdr: false };
        if (/(?:^|[^a-z0-9_])hdr10(?:\+|plus(?![a-z0-9_]))/.test(title)) return { range: 'HDR10+', base: null, sdr: false };
        if (word('hdr10')) return { range: 'HDR10', base: null, sdr: false };
        if (word('hlg')) return { range: 'HLG', base: null, sdr: false };
        if (word('hdr')) return { range: 'HDR', base: null, sdr: false };
        // Jellyfin's coarse VideoRange still says HDR or SDR when the type is unknown.
        const coarse = String(video?.VideoRange || '').toLowerCase();
        if (coarse === 'hdr') return { range: 'HDR', base: null, sdr: false };
        return { range: null, base: null, sdr: word('sdr') || coarse === 'sdr' };
    }

    /**
     * Video codec label (first match on the codec, then on the display title).
     * @param {Object} video Video stream.
     * @returns {string|null} Codec label.
     */
    function detectVideoCodec(video) {
        const current = [['vvc', 'VVC'], ['h266', 'VVC'], ['hevc', 'HEVC'], ['h265', 'H265'], ['h264', 'H264'], ['avc', 'H264'], ['av1', 'AV1'], ['vp9', 'VP9'],
            ['vp8', 'VP8'], ['xvid', 'XVID'], ['divx', 'DIVX'], ['wmv', 'WMV'], ['vc1', 'VC-1'], ['mpeg2', 'MPEG2'],
            ['mpeg4', 'MPEG4'], ['mjpeg', 'MJPEG'], ['theora', 'THEORA'], ['prores', 'ProRes']];
        const codec = String(video.Codec || '').toLowerCase();
        const codecTag = String(video.CodecTag || '').toLowerCase();
        for (const [needle, label] of current) {
            if (codec.includes(needle)) return label;
            // CodecTag is consulted for AVC, and for the MPEG-4 Part 2 encoders Jellyfin reports as
            // "mpeg4" (XviD; DivX as DIVX/DX50/DIV3-6), right after the codec's own check.
            if (needle === 'avc' && codecTag.includes('avc')) return label;
            if (needle === 'xvid' && codecTag.includes('xvid')) return label;
            if (needle === 'divx' && /divx|dx50|div[3-6]/.test(codecTag)) return label;
        }
        const displayTitle = String(video.DisplayTitle || '').toLowerCase();
        return current.find(([needle]) => displayTitle.includes(needle))?.[1] || null;
    }

    /**
     * Analyzes media stream and source information to determine quality tags.
     * @param {Array} mediaStreams - The MediaStreams array from the Jellyfin item.
     * @param {Array} mediaSources - The MediaSources array from the Jellyfin item.
     * @param {Object} [itemData] - Optional item metadata for filename/title signals.
     * @param {boolean} [singleTrack=false] Internal per-track detection without display-mode expansion.
     * @param {string} [sourceId] Remembered merged version, or the first version.
     * @returns {Array<string>} A list of detected quality tags.
     */
    function getEnhancedQuality(mediaStreams, mediaSources, itemData = null, singleTrack = false, sourceId = '') {
        if (!mediaStreams && !mediaSources && !itemData?.Source && !itemData?.Edition) return [];

        const versions = versionCount(mediaStreams, mediaSources);
        // Narrow raw streams, cached per-track sets and filename/technical facts together.
        // The browser's pick, else the first version Jellyfin lists (an unprobed first version
        // then has no stream facts: it never borrows another version's).
        const versionId = sourceId && (mediaStreams?.some(s => s?.SourceId === sourceId) || mediaSources?.some(s => s?.Id === sourceId))
            ? sourceId : mediaSources?.find(s => s?.Id)?.Id || mediaStreams?.find(s => s?.SourceId)?.SourceId;
        if (versionId) {
            const version = mediaSources?.find(s => s?.Id === versionId);
            const tagged = mediaStreams?.some(s => s?.SourceId);
            if (tagged) mediaStreams = mediaStreams.filter(s => s?.SourceId === versionId);
            else if (version?.MediaStreams) mediaStreams = version.MediaStreams;
            if (version) mediaSources = [version];
            itemData = { ...itemData,
                ...(version ? { Path: version.Path, RunTimeTicks: version.RunTimeTicks ?? itemData?.RunTimeTicks,
                    Source: version.Source, Edition: version.Edition } : {}),
                DistinctQualities: itemData?.DistinctQualities?.filter(q => q.SourceId === versionId) };
        }

        const qualities = new Set();
        let videoStreams = [];
        let audioStreams = [];

        if (mediaStreams) {
            videoStreams = mediaStreams.filter(s => s.Type === 'Video');
            audioStreams = mediaStreams.filter(s => s.Type === 'Audio');
        }

        // Also check within MediaSources, as this can sometimes contain more accurate stream info
        if (mediaSources?.[0]?.MediaStreams) {
            const sourceStreams = mediaSources[0].MediaStreams;
            videoStreams = videoStreams.concat(sourceStreams.filter(s => s.Type === 'Video'));
            audioStreams = audioStreams.concat(sourceStreams.filter(s => s.Type === 'Audio'));
        }

        // Sound tag: judge only the preferred language's tracks when the user
        // or admin set one (#433) — a film whose English track is Atmos but
        // whose German dub is plain AC3 reads AC3 for a German-preferring
        // user. Falls back to every track when the title has no audio in it.
        audioStreams = selectAudioStreamsForLanguage(audioStreams, resolvePreferredAudioLanguage());

        // Get primary video stream for analysis
        const primaryVideoStream = videoStreams[0];
        // Version-0 documents keep their audio vocabulary; every account gets the current video
        // detection (range type, codec, dimensions), as the server does.
        const legacyAudio = legacyFullAudio();
        for (const label of technicalLabels(itemData?.RunTimeTicks, primaryVideoStream)) qualities.add(label);

        // --- IMAX TAG LOGIC ---
        // Pattern sources:
        // - TRaSH Guides IMAX CF regex (NON-IMAX exclusion + IMAX token)
        // - Dictionarry-Hub IMAX / IMAX Enhanced patterns
        // We gather multiple title/name/path signals since IMAX often appears in file names.
        const imaxSignals = [];
        if (itemData) {
            imaxSignals.push(
                itemData.Name || '',
                itemData.OriginalTitle || '',
                itemData.SortName || '',
                itemData.EditionTitle || '',
                itemData.ForcedSortName || ''
            );
        }
        if (Array.isArray(mediaSources)) {
            mediaSources.forEach((source) => {
                imaxSignals.push(source?.Path || '', source?.Name || '');
            });
        }
        if (Array.isArray(mediaStreams)) {
            mediaStreams.filter(stream => stream?.Type !== 'Subtitle').forEach((stream) => {
                imaxSignals.push(stream?.DisplayTitle || '', stream?.Title || '');
            });
        }

        const imaxContext = imaxSignals.filter(Boolean).join(' | ');
        const nonImaxRegex = /\bNON[ ._-]?IMAX\b/i;
        const imaxRegex = /\bIMAX(?:[ ._-]?ENHANCED)?\b/i;
        if (imaxContext && imaxRegex.test(imaxContext) && !nonImaxRegex.test(imaxContext)) {
            qualities.add('IMAX');
        }

        // --- VIDEO RESOLUTION LOGIC ---
        let resolutionTag = null;

        if (primaryVideoStream) {
            // Priority 1: DisplayTitle Scan for resolution keywords
            const displayTitle = primaryVideoStream.DisplayTitle || '';
            const resolutionRegex = /\b(8k|4320p|4k|2160p|1440p|1080p|720p|576p|480p|360p|404p|384p|520p)\b/i;
            const resolutionMatch = displayTitle.match(resolutionRegex);

            const displayTitleHeight = primaryVideoStream.Height || 0;
            // Known dimensions decide; a title hint only names an unknown size.
            const knownSize = displayTitleHeight > 0 || (primaryVideoStream.Width || 0) > 0;
            if (resolutionMatch && !knownSize) {
                const found = resolutionMatch[1].toLowerCase();
                if (found === '8k' || found === '4320p') {
                    resolutionTag = '8K';
                } else if (found === '4k' || found === '2160p') {
                    resolutionTag = '4K';
                } else if (found === '1440p') {
                    resolutionTag = '1440p';
                } else if (found === '1080p') {
                    resolutionTag = '1080p';
                } else if (found === '720p') {
                    resolutionTag = '720p';
                } else if (found === '576p') {
                    resolutionTag = '576p';
                } else if (found === '480p') {
                    resolutionTag = '480p';
                } else if (['360p', '404p', '384p', '520p'].includes(found)) {
                    // Generic low-res tag for anything below 480p
                    resolutionTag = 'LOW-RES';
                }
                qualities.add(resolutionTag);
            } else {
                // Priority 2: Dimension Fallback
                const height = primaryVideoStream.Height || 0;
                const width = primaryVideoStream.Width || 0;
                if (height >= 3000 || width >= 7000) {
                    resolutionTag = '8K';
                } else if (height >= 1550 || width >= 3500) {
                    resolutionTag = '4K';
                } else if (height >= 1250) {
                    // Only a 1440-class height: a 2560-wide frame is usually ultrawide 1080p (2560x1080).
                    resolutionTag = '1440p';
                } else if (height >= 1000 || width >= 1800) {
                    resolutionTag = '1080p';
                } else if (height >= 700 || width >= 1200) {
                    resolutionTag = '720p';
                } else if (height >= 528) {
                    // PAL DVD is 720x576; NTSC DVD is 720x480. 528 splits the two evenly.
                    resolutionTag = '576p';
                } else if (height >= 400 || width >= 640) {
                    // A cropped DVD (720x304) or SD scope encode (854x356) is still SD by its width.
                    resolutionTag = '480p';
                } else if (height > 0) {
                    // Any smaller frame gets the generic low-res tag
                    resolutionTag = 'LOW-RES';
                }

                if (resolutionTag) {
                    qualities.add(resolutionTag);
                }
            }
        }

        // --- VIDEO CODEC LOGIC ---
        if (primaryVideoStream) {
            const detectedCodec = detectVideoCodec(primaryVideoStream);
            if (detectedCodec) qualities.add(detectedCodec);
        }

        // --- VIDEO DYNAMIC RANGE LOGIC ---
        if (primaryVideoStream) {
            const range = videoRangeFacts(primaryVideoStream).range;
            if (range) qualities.add(range);
        }

        // --- AUDIO LOGIC ---
        let audioTag = null;
        if (!legacyAudio) {
            // One track supplies codec and channels together.
            audioTag = bestAudioLabel(audioStreams);
            if (audioTag) qualities.add(audioTag);
        } else {
            for (let i = 0; i < audioStreams.length; i++) {
                const stream = audioStreams[i];

                // Priority 1: DisplayTitle Scan
                const displayTitle = stream.DisplayTitle || '';

                const atmosRegex = /atmos/i;
                const truehd = /truehd/i;
                const dtsxRegex = /dts-x/i;
                const dtsRegex = /\bdts\b/i;
                const ddpRegex = /dolby\s*digital\+/i;

                // The earlier vocabulary keeps its labels but never a carrier the stream codec cannot be.
                const legacyAllows = tag => carrierAllows(tag === 'ATMOS' ? 'DD+ ATMOS' : tag, stream.Codec) || (tag === 'ATMOS' && carrierAllows('TRUEHD ATMOS', stream.Codec));
                const atmosMatch = displayTitle.match(atmosRegex);
                const truehdMatch = displayTitle.match(truehd);
                const dtsxMatch = displayTitle.match(dtsxRegex);
                const dtsMatch = displayTitle.match(dtsRegex);
                const ddpMatch = displayTitle.match(ddpRegex);

                const titled = atmosMatch ? 'ATMOS' : truehdMatch ? 'TRUEHD' : dtsxMatch ? 'DTS-X' : dtsMatch ? 'DTS' : ddpMatch ? 'Dolby Digital+' : null;
                if (titled && legacyAllows(titled)) {
                    audioTag = titled;
                    break; // Stop all further audio checks
                }
            }

            if (!audioTag) {

                // Priority 2: Technical Metadata Fallback
                for (let i = 0; i < audioStreams.length; i++) {
                    const stream = audioStreams[i];
                    const codec = (stream.Codec || '').toLowerCase();
                    const profile = (stream.Profile || '').toLowerCase();

                    if (codec.includes('truehd') || profile.includes('truehd')) {
                        if (codec.includes('atmos') || profile.includes('atmos')) {
                            audioTag = 'ATMOS';
                        } else {
                            audioTag = 'TRUEHD';
                        }
                        break;
                    } else if (codec.includes('dts')) {
                        // DTS:X by name only: XLL (the DTS-HD MA lossless extension) is not object audio.
                        if (/(?:^|[^a-z0-9_])dts[-_.: ]?x(?![a-z0-9_])/.test(`${codec} ${profile}`)) {
                            audioTag = 'DTS-X';
                        } else {
                            audioTag = 'DTS';
                        }
                        break;
                    } else if (codec.includes('eac3') || codec.includes('ddp')) {
                        audioTag = 'Dolby Digital+';
                        break;
                    }
                }
            }

            let channelTag = getChannelTag(audioStreams);
            // The earlier vocabulary keeps its words, but its codec and channels must come from one real track.
            ({ codec: audioTag, channels: channelTag } = truthfulLegacyAudio(audioTag, channelTag, audioStreams));

            // Append channel layout to codec tag instead of creating a separate channel tag.
            if (audioTag) {
                if (channelTag && !audioTag.includes(channelTag)) {
                    audioTag = `${audioTag} ${channelTag}`;
                }
                qualities.add(audioTag);
            } else if (channelTag === '7.1' || channelTag === '5.1') {
                // Preserve previous fallback behavior when no codec tag is detected.
                qualities.add(channelTag);
            }
        }

        // --- 3D VIDEO LOGIC ---
        if (mediaSources) {
            for (const source of mediaSources) {
                // Jellyfin's own 3D format first (Is3D in cached facts, Video3DFormat on items), else 3D release words.
                const path = String(source.Path || '').toLowerCase();
                const has3D = path.includes('3d');
                const has3DFormat = /hsbs|fsbs|htab|ftab|mvc/.test(path);
                if (source.Is3D === true || source.Video3DFormat || (has3D && has3DFormat)) {
                    qualities.add('3D');
                    break; // Found 3D, no need to check other sources
                }
            }
        }

        // --- MEDIA STUB TAG LOGIC ---
        // Detect media stubs (.disc files) for BluRay, DVD, or generic Physical media
        const stubSignals = [];
        if (itemData) {
            stubSignals.push(
                itemData.Name || '',
                itemData.Path || ''
            );
        }
        if (Array.isArray(mediaSources)) {
            mediaSources.forEach((source) => {
                stubSignals.push(source?.Path || '', source?.Name || '');
            });
        }

        const stubContext = stubSignals.filter(Boolean).join(' | ').toLowerCase();

        // Check for .disc extension (media stub indicator)
        if (/\.disc(?:$|\s*\|)/.test(stubContext)) {
            // Parse filename/path for specific media type patterns
            const blurayRegex = /bluray|blu-ray|bdrip|bd-rip|bdremux/;
            const hddvdRegex = /hddvd|hd-dvd|hd dvd/;
            const dvdRegex = /dvd|dvdrip|dvd-rip|dvdremux/;
            const vhsRegex = /vhs/;
            const hdtvRegex = /hdtv/;

            if (blurayRegex.test(stubContext)) {
                qualities.add('BluRay');
            } else if (hddvdRegex.test(stubContext)) {
                qualities.add('HD DVD');
            } else if (dvdRegex.test(stubContext)) {
                qualities.add('DVD');
            } else if (vhsRegex.test(stubContext)) {
                qualities.add('VHS');
            } else if (hdtvRegex.test(stubContext)) {
                qualities.add('HDTV');
            } else {
                qualities.add('Physical');
            }
        }

        // Naming facts are computed before server paths are trimmed. Legacy stubs remain a fallback.
        if (itemData?.Source && sourceOrder.includes(itemData.Source)) {
            for (const source of sourceOrder) qualities.delete(source);
            qualities.add(itemData.Source);
        }
        if (itemData?.Edition) qualities.add(EDITION_PREFIX + itemData.Edition);
        if (!singleTrack && versions > 1) qualities.add(`versions:${versions}`);
        if (!singleTrack && displayModeKey() !== '000') {
            const distinct = itemData?.DistinctQualities || distinctQualities(videoStreams, audioStreams);
            for (const category of ['audio', 'videoCodec', 'dynamicRange']) {
                if (!allValues(category)) continue;
                for (const label of qualities) if (categorize(label) === category) qualities.delete(label);
                const facts = category === 'audio' && legacyAudio ? distinctQualities([], audioStreams) : distinct;
                let values = facts.filter(value => value.Category === (category === 'audio' ? 'audioInfo' : category));
                if (category === 'audio' && resolvePreferredAudioLanguage()) {
                    // The raw tracks already chose the language tier above, including
                    // unlabelled tracks. No labels in that tier means no sound chip.
                    const languages = new Set(audioStreams.map(stream => stream.Language || null));
                    values = values.filter(value => languages.has(value.Language || null));
                }
                for (const value of values) qualities.add(value.Label);
            }
        }
        return Array.from(qualities);
    }

    /** @param {string} category Web category id. @returns {boolean} Whether distinct sets are enabled. */
    function allValues(category) {
        const key = { audio: 'qualityAudioDisplayMode', videoCodec: 'qualityVideoCodecDisplayMode', dynamicRange: 'qualityHdrDisplayMode' }[category];
        return !!key && (JE.currentSettings?.[key] ?? JE.pluginConfig?.[key[0].toUpperCase() + key.slice(1)]) === 'all';
    }

    /** @returns {string} Cache fingerprint for detection-affecting category modes. */
    function displayModeKey() {
        return ['audio', 'videoCodec', 'dynamicRange'].map(category => allValues(category) ? '1' : '0').join('');
    }

    /** Detect independently per track; cached and batch fallback paths use the same labels and language tiers.
     * @param {Object[]} videos Video streams. @param {Object[]} audio Audio streams. @returns {Object[]} Distinct facts.
     */
    function distinctQualities(videos, audio) {
        const values = [];
        for (const stream of [...videos, ...audio]) {
            const labels = getEnhancedQuality([stream], null, null, true);
            const categories = stream.Type === 'Video' ? ['videoCodec', 'dynamicRange'] : ['audio'];
            for (const label of labels) {
                const category = categorize(label);
                if (categories.includes(category)) values.push({ Category: category === 'audio' ? 'audioInfo' : category, Label: label, Language: stream.Language });
            }
            if (stream.Type === 'Video') {
                // Unknown stays unknown: only a known SDR stream is SDR; a Dolby Vision
                // stream also lists the base layer other displays fall back to.
                const facts = videoRangeFacts(stream);
                if (facts.base) values.push({ Category: 'dynamicRange', Label: facts.base });
                else if (!facts.range && facts.sdr) values.push({ Category: 'dynamicRange', Label: 'SDR' });
            }
        }
        return values;
    }

    /** @param {string} label Quality label. @param {string} category Web category. @returns {number} Rank; more channels win audio ties. */
    function distinctRank(label, category) {
        const index = CATEGORY_BY_KEY.get(category)?.items.indexOf(normalizeQualityLabel(label)) ?? -1;
        // Every channel counts, heights too ("7.1.4" beats "7.1"; QualityTagRules.AggregationRank).
        const layout = /(\d)\.(\d)(?:\.(\d))?$/.exec(label);
        const channels = layout ? layout.slice(1).reduce((sum, part) => sum + Number(part || 0), 0) : 0;
        if (category !== 'audio') return (index < 0 ? 999 : index) * 100;
        // Lossy tracks (Dolby Digital+ onwards) rank by channels before codec, so an AAC 5.1 soundtrack
        // beats an AC-3 2.0 dub; lossless and object tiers always rank by codec first.
        const lossy = audioOrder.indexOf('Dolby Digital+');
        if (index >= lossy) return lossy * 100 + (99 - Math.min(channels, 99)) * 10 + (index - lossy);
        return (index < 0 ? 99900 : index * 100) + 99 - Math.min(channels, 99);
    }

    /** @param {string} label Detected resolution. @returns {boolean} Inclusive threshold, unknown settings mean Off. */
    function meetsMinimum(label) {
        const threshold = JE.currentSettings?.qualityMinimumResolution ?? JE.pluginConfig?.QualityMinimumResolution;
        const last = { '4k': 1, '1080p': 3, '720p': 4 }[threshold];
        const index = resolutionOrder.indexOf(label);
        return last === undefined || (index >= 0 && index <= last);
    }

    /**
     * Effective series/season policy, independently of layout and label density.
     * @returns {string} A known policy; legacy and invalid settings remain representative.
     */
    function aggregationPolicy() {
        const policy = JE.currentSettings?.seriesQualityAggregation ?? JE.pluginConfig?.SeriesQualityAggregation;
        return ['latest', 'best', 'shared', 'mixed'].includes(policy) ? policy : 'representative';
    }

    /**
     * Resolve compact server facts without fetching episodes. Source and special-format
     * labels keep their representative semantics, except latest uses its own labels.
     * @param {Object} entry - A server-cache entry, or batch item carrying QualitySummary.
     * @param {string[]} representative - Legacy stream-derived labels.
     * @returns {string[]} Labels before category toggles, ordering, density and caps.
     */
    function aggregateQualities(entry, representative) {
        const policy = aggregationPolicy();
        const summary = entry.QualitySummary;
        if (!['Series', 'Season'].includes(entry.Type) || !summary || policy === 'representative') return representative;
        const categoryKeys = { resolution: 'resolution', dynamicRange: 'dynamicRange', videoCodec: 'videoCodec', audioInfo: 'audio' };
        // A version count describes one episode, never the series or season (QualitySummary.LatestExtras
        // stored before schema 31 may still carry one).
        const qualities = (policy === 'latest' ? [...(summary.LatestExtras || [])]
            : representative.filter(label => !['resolution', 'dynamicRange', 'videoCodec', 'audio'].includes(categorize(label))))
            .filter(label => !label.startsWith('versions:'));
        const preferred = resolvePreferredAudioLanguage();
        const match = JE.core.mediaLanguage?.matchesLanguage;
        const audioVariants = Object.entries((legacyFullAudio() ? summary.LegacyAudioByLanguage : summary.AudioByLanguage) || {});
        const regionalFallbacks = Object.entries((legacyFullAudio() ? summary.LegacyAudioRegionFallback : summary.AudioRegionFallback) || {});
        const audio = preferred && typeof match === 'function'
            ? (audioVariants.find(([language]) => match(language, preferred, { requireRegion: true }))
                || regionalFallbacks.find(([language]) => match(language, preferred))
                || audioVariants.find(([language]) => !language.includes('-') && match(language, preferred)))?.[1] : null;
        let mixed = false;
        for (const [key, category] of Object.entries(summary.Categories || {})) {
            const facts = key === 'audioInfo' ? audio || (legacyFullAudio() ? summary.LegacyAudio : category) || {} : category;
            const cat = CATEGORY_BY_KEY.get(categoryKeys[key]);
            if (allValues(categoryKeys[key])) {
                qualities.push(...((policy === 'latest' ? facts.LatestAll : policy === 'shared' ? facts.Shared : facts.All) || []));
                mixed ||= !facts.AllSetsAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true);
                continue;
            }
            const value = policy === 'latest' ? facts.Latest : policy === 'shared' && !facts.AllAgree ? null : facts.Best;
            if (value) qualities.push(value);
            mixed ||= !facts.AllAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true);
        }
        if (policy === 'mixed' && summary.EpisodeCount > 1 && mixed) qualities.push('Mixed');
        return qualities;
    }

    /** @returns {boolean} Whether audio must retain version-0 presentation. */
    function legacyFullAudio() {
        return JE.core.tagLayout?.isLegacySettings() ?? true;
    }

    /**
     * Fingerprint the effective category switches used to decide whether Mixed is present.
     * @returns {string} Stable key for computed labels retained across reinitialization.
     */
    function aggregationCategoriesKey() {
        return CATEGORIES.map(cat => readBool(cat.settingKey, cat.fallback ?? true) ? '1' : '0').join('');
    }

    /**
     * Reapply a policy to retained batch facts. A policy change must not fetch
     * episodes again while the language preference and cache lifetime still match.
     * @param {Object|null} cached - A computed local/hot cache record.
     * @returns {string[]|null} Resolved labels, including a known empty result, or a cache miss.
     */
    function qualitiesFromCache(cached, itemId) {
        if (!cached || !matchesCache(cached, itemId)) return null;
        if ((cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) || (cached.type && !['Series', 'Season'].includes(cached.type))) return cached.qualities;
        if (!cached.qualitySummary) return null;
        return aggregateQualities({ Type: cached.type, QualitySummary: cached.qualitySummary }, cached.representativeQualities || []);
    }

    // --- DOM MANIPULATION ---
    /**
     * Reads a boolean category toggle from per-user settings.
     * @param {string} userKey - Key on JE.currentSettings
     * @param {boolean} fallback - Returned when the user setting is not a boolean
     * @returns {boolean} The resolved boolean
     */
    function readBool(userKey, fallback) {
        const userVal = JE.currentSettings?.[userKey] ?? JE.pluginConfig?.[userKey[0].toUpperCase() + userKey.slice(1)];
        if (typeof userVal === 'boolean') return userVal;
        return fallback;
    }

    /**
     * Reads a numeric category order from per-user settings.
     * @param {string} userKey - Key on JE.currentSettings
     * @param {number} fallback - Returned when the user setting is not a finite number
     * @returns {number} The resolved number
     */
    function readInt(userKey, fallback) {
        const userVal = JE.currentSettings?.[userKey] ?? JE.pluginConfig?.[userKey[0].toUpperCase() + userKey.slice(1)];
        if (Number.isFinite(userVal)) return userVal;
        return fallback;
    }

    /**
     * Determines which category a quality tag belongs to
     * @param {string} tag - A quality tag, possibly composite (e.g. "ATMOS 7.1")
     * @returns {string|null} The category key, or null if uncategorized
     */
    function categorize(tag) {
        for (const cat of CATEGORIES) if (!cat.items.length && tag.startsWith(cat.key + ':')) return cat.key;
        const norm = normalizeQualityLabel(tag);
        const direct = TAG_TO_CATEGORY.get(norm);
        if (direct) return direct;
        // Bare channel layouts (e.g. "2.0") fall into audio.
        if (/^\d+\.\d+$/.test(tag)) return 'audio';
        return null;
    }

    /**
     * Renders the quality tag overlay onto a poster card
     * @param {Object} ctx - Factory context (tagged/overlay helpers).
     * @param {HTMLElement} container - The card element to receive the overlay
     * @param {Array<string>} qualities - Detected quality tags, unfiltered
     */
    function insertOverlay(ctx, container, qualities) {
        if (!container) return;

        // Remove any old tags before adding new ones
        ctx.removeExistingOverlay(container);

        // Bucket each tag by category. Disabled categories drop their tags.
        // Uncategorized labels (e.g. stale cache entries from a prior plugin
        // version) collect in `otherBucket` so they still render — preserves
        // the pre-PR `.other-quality` rendering behavior.
        const buckets = new Map();
        const otherBucket = [];
        for (const q of new Set(qualities)) {
            if (q === 'SDR' && readBool('qualityHideSdr', false)) continue;
            if (categorize(q) === 'resolution' && !meetsMinimum(q)) continue;
            if (['CAM', 'TS', 'TC', 'SCR'].includes(q) && !readBool('showLowQualitySourceTag', false)) continue;
            if (q === EDITION_PREFIX + 'IMAX' && qualities.includes('IMAX') && readBool('showSpecialFormatTag', true)) continue;
            const catKey = categorize(q);
            if (catKey) {
                const cat = CATEGORY_BY_KEY.get(catKey);
                if (!readBool(cat.settingKey, cat.fallback ?? true)) continue;
                if (!buckets.has(catKey)) buckets.set(catKey, []);
                buckets.get(catKey).push(q);
            } else {
                otherBucket.push(q);
            }
        }
        if (buckets.size === 0 && otherBucket.length === 0) {
            // Clear stale dataset attribute so a future re-init / re-render
            // can rebuild the overlay rather than treating the card as tagged.
            const card = container.closest('.card');
            if (card?.dataset) delete card.dataset[ctx.taggedAttr];
            return;
        }

        // Sort each bucket by within-category priority and keep only the best resolution
        for (const [catKey, tags] of buckets) {
            const cat = CATEGORY_BY_KEY.get(catKey);
            tags.sort((a, b) => {
                if (allValues(catKey)) return distinctRank(a, catKey) - distinctRank(b, catKey) || (a < b ? -1 : a > b ? 1 : 0);
                const aKey = normalizeQualityLabel(a);
                const bKey = normalizeQualityLabel(b);
                const aIdx = cat.items.indexOf(aKey);
                const bIdx = cat.items.indexOf(bKey);
                return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });
            if (catKey === 'resolution' && tags.length > 1) tags.length = 1;
        }

        // Sort categories by user stack order, tie-broken by defaultOrder for determinism
        const categoriesSorted = [...buckets.keys()].map((key) => {
            const cat = CATEGORY_BY_KEY.get(key);
            return {
                key,
                cat,
                order: readInt(cat.orderUserKey, cat.defaultOrder),
            };
        }).sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return a.cat.defaultOrder - b.cat.defaultOrder;
        });

        // Ensure container is positioned (avoids forced reflow from getComputedStyle,
        // and a style write per card when it already is)
        if (container.style.position !== 'relative') container.style.position = 'relative';

        const qualityContainer = document.createElement('div');
        qualityContainer.className = containerClass;

        for (const { key } of categoriesSorted) {
            for (const q of buckets.get(key)) {
                qualityContainer.appendChild(createResponsiveLabel(q));
            }
        }
        // Render any uncategorized tags last, in original input order.
        for (const q of otherBucket) {
            qualityContainer.appendChild(createResponsiveLabel(q));
        }

        ctx.commitOverlay(container, qualityContainer);
    }

    /** @type {Object} Factory spec — quality-specific config and renderers. */
    const spec = {
        logPrefix,
        settingKey: 'qualityTagsEnabled',
        containerClass,
        taggedAttr: 'jeQualityTagged',
        styleId: 'quality-tag-enhanced-style',
        position: { userKey: 'qualityTagsPosition', pluginKey: 'QualityTagsPosition', fallback: 'top-left' },
        cache: {
            // Static cache key (not version-based) to persist across plugin updates
            key: 'JellyfinEnhanced-qualityTagsCache',
            legacyPrefix: 'qualityOverlayCache',
            hotBucket: 'quality',
            pruneOnSave: true,
        },
        buildCss() {
            // Generate CSS rules from the color configuration
            const rules = Object.entries(qualityColors).map(([k, v]) => {
                return JE.core.tagRenderer.chipBaseCss(`.${overlayClass}`) + `.${containerClass} .${overlayClass}[data-quality="${k}"] {
                    background: ${v.bg} !important;
                    color: ${v.text} !important;
                }`;
            }).join("\n");

            // Placement (corner, band, caption...) comes from the layout
            // stylesheet (tags/tag-layout-styles.js); this only styles the group.
            return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-start;
                    z-index: 100;
                    max-width: calc(100% - 12px);
                    max-height: 90%;
                    overflow: hidden;
                    pointer-events: none;
                }


                .layout-mobile .${containerClass} {
                    gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                }
                @media (min-width: 1440px) {

                    .${containerClass} {
                        gap: calc(6px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 768px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                        max-height: 85%;
                    }
                }
                /* Generic style for low resolution content */
                .${containerClass} .${overlayClass}[data-quality="LOW-RES"] {
                    background: rgba(128, 128, 128, 0.8) !important;
                    color: #ffffff !important;
                }
                .${overlayClass}[data-je-quality-category] {
                    background: rgba(55, 71, 79, 0.95) !important;
                    color: #ffffff !important;
                }
                ${rules}
                .${containerClass} .${overlayClass}[data-je-edition] {
                    background: rgba(106, 27, 154, 0.95) !important;
                    color: #ffffff !important;
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: false,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                // Skip cards hidden by hidden-content module
                if (el.closest('.je-hidden')) return;
                if (isAudioPreferencePending()) return;

                const itemId = item.Id;
                // Check hot cache first
                const hot = ctx.hot?.get(itemId);
                const hotQualities = hot && (Date.now() - hot.timestamp) < ctx.cacheTtl ? qualitiesFromCache(hot, itemId) : null;
                if (hotQualities) {
                    if (hotQualities.length) insertOverlay(ctx, el, hotQualities);
                    return;
                }

                let qualities = [];
                const srcId = selectedSourceFor(itemId);
                if (item.Type === 'Series' || item.Type === 'Season') {
                    if (extras.firstEpisode) {
                        // A version count would describe the first episode, not the series or season.
                        qualities = getEnhancedQuality(extras.firstEpisode.MediaStreams, extras.firstEpisode.MediaSources, extras.firstEpisode)
                            .filter(label => !label.startsWith('versions:'));
                    }
                } else {
                    qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources, item, false, srcId);
                }

                const representativeQualities = qualities;
                qualities = aggregateQualities(item, qualities);
                {
                    const audioLang = audioPreferenceKey();
                    const record = { qualities, representativeQualities, type: item.Type, qualitySummary: item.QualitySummary,
                        namingVersion: 16, legacyAudio: legacyFullAudio(), displayModeKey: displayModeKey(), timestamp: Date.now(), audioLang, srcId, aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() };
                    ctx.setPersistent(itemId, record);
                    ctx.hot?.set(itemId, record);
                    if (qualities.length) insertOverlay(ctx, el, qualities);
                }
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                // No fetch while the preference loads; the rescan after it renders the card.
                if (isAudioPreferencePending()) return true;
                const hot = ctx.hot?.get(itemId);
                const cached = hot || ctx.getPersistent(itemId);
                const qualities = qualitiesFromCache(cached, itemId);
                if (qualities) {
                    if (qualities.length) insertOverlay(ctx, el, qualities);
                    return true;
                }
                return false;
            },
            renderFromServerCache(ctx, el, entry, itemId) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (isAudioPreferencePending()) return;
                // Check local computed cache first (avoids re-running quality detection)
                const cached = serverQualityCache.get(itemId);
                if (cached && cached.entry === entry && matchesCache(cached, itemId) && cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) {
                    if (cached.qualities.length > 0) insertOverlay(ctx, el, cached.qualities);
                    return;
                }
                const audioLang = audioPreferenceKey();
                const srcId = selectedSourceFor(itemId);
                const sd = entry.StreamData;
                const representative = getEnhancedQuality(sd?.Streams, sd?.Sources, { Name: sd?.ItemName, Path: sd?.ItemPath, RunTimeTicks: sd?.RunTimeTicks, Source: entry.Source, Edition: entry.Edition, DistinctQualities: sd?.DistinctQualities }, false, srcId)
                    // A version count would describe the representative episode, not the series or season.
                    .filter(label => !(entry.Type === 'Series' || entry.Type === 'Season') || !label.startsWith('versions:'));
                const qualities = aggregateQualities(entry, representative);
                serverQualityCache.set(itemId, { audioLang, srcId, qualities, entry, namingVersion: 16, legacyAudio: legacyFullAudio(), displayModeKey: displayModeKey(), aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() });
                if (qualities.length > 0) insertOverlay(ctx, el, qualities);
            },
            onServerCacheRefresh(ctx, updatedIds) {
                if (!updatedIds) { serverQualityCache.clear(); return; }
                updatedIds.forEach(function(id) { serverQualityCache.delete(id); });
            },
        },
    };

    /**
     * Runs `render` once the Jellyfin audio preference is known when the
     * effective setting depends on it (one request; none otherwise), so the
     * first pass is not judged under "no preference" and redone when the
     * value arrives. The request never rejects, so a failure still renders.
     * @param {Function} render
     */
    function withJellyfinAudioPreference(render) {
        if (!usesJellyfinAudioPreference()) { render(); return; }
        primeJellyfinAudioPreference().then(render);
    }

    let versionPickerWatched = false;
    let versionPickerTimer;

    /**
     * Makes the details page's version picker drive the badges: a pick is
     * remembered (so library posters follow it) and re-renders the poster, and
     * on opening the page the remembered version is selected again.
     */
    function watchVersionPicker() {
        if (versionPickerWatched) return;
        versionPickerWatched = true;
        const detailId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id');

        document.addEventListener('change', (e) => {
            const select = e.target;
            if (!select?.classList?.contains('selectSource') || !select.value) return;
            const id = detailId();
            if (!id || selectedSourceFor(id) === select.value) return;
            rememberSource(id, select.value);
            JE.core.tagRenderer.reinitialize('quality', spec);
        });

        document.addEventListener('viewshow', () => {
            clearInterval(versionPickerTimer);
            const id = detailId();
            const want = id && selectedSourceFor(id);
            if (!want) return;
            // Jellyfin fills the picker after the page shows.
            let tries = 0;
            const timer = versionPickerTimer = setInterval(() => {
                if (detailId() !== id) { clearInterval(timer); return; }
                const select = document.querySelector('#itemDetailPage:not(.hide) .selectSource');
                if (select && select.options.length > 1) {
                    clearInterval(timer);
                    if (select.value !== want && [...select.options].some((o) => o.value === want)) {
                        select.value = want;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } else if (++tries > 20) {
                    clearInterval(timer);
                }
            }, 300);
        });
    }

    /**
     * Initializes the Quality Tags feature.
     */
    JE.initializeQualityTags = function() {
        watchPlaybackPreferencesPage();
        watchVersionPicker();
        withJellyfinAudioPreference(() => JE.core.tagRenderer.register('quality', spec));
    };

    /**
     * Re-initializes the Quality Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeQualityTags = function() {
        watchPlaybackPreferencesPage();
        withJellyfinAudioPreference(() => JE.core.tagRenderer.reinitialize('quality', spec));
    };

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);

})(window.JellyfinEnhanced);
