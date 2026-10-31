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
    const dynamicRangeOrder = ['Dolby Vision', 'HDR10+', 'HDR10', 'HDR'];
    const specialFormatOrder = ['IMAX', '3D'];
    const codecOrder = ['AV1', 'HEVC', 'H265', 'VP9', 'H264', 'VP8', 'XVID', 'DIVX', 'WMV', 'MPEG2', 'MPEG4', 'MJPEG', 'THEORA'];
    const audioOrder = ['ATMOS', 'DTS-X', 'TRUEHD', 'DTS', 'Dolby Digital+', '7.1', '5.1'];

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
        'HDR': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'HDR10': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'HDR10+': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
        'Dolby Vision': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
        'IMAX': { bg: 'rgba(0, 114, 206, 0.9)', text: '#ffffff' },
        'ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
        'DTS-X': { bg: 'rgba(255, 100, 0, 0.9)', text: '#ffffff' },
        'DTS': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
        'Dolby Digital+': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
        'TRUEHD': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
        '7.1': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
        '5.1': { bg: 'rgba(103, 58, 183, 0.9)', text: '#ffffff' },
        '3D': { bg: 'rgba(0, 150, 255, 0.9)', text: '#ffffff' },
        'AV1': { bg: 'rgba(255, 87, 34, 0.95)', text: '#ffffff' },
        'HEVC': { bg: 'rgba(33, 150, 243, 0.9)', text: '#ffffff' },
        'H265': { bg: 'rgba(63, 81, 181, 0.9)', text: '#ffffff' },
        'VP9': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
        'H264': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
        'VP8': { bg: 'rgba(121, 85, 72, 0.9)', text: '#ffffff' },
        'XVID': { bg: 'rgba(255, 152, 0, 0.9)', text: '#ffffff' },
        'DIVX': { bg: 'rgba(255, 193, 7, 0.9)', text: '#000000' },
        'WMV': { bg: 'rgba(0, 188, 212, 0.9)', text: '#ffffff' },
        'MPEG2': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
        'MPEG4': { bg: 'rgba(158, 158, 158, 0.9)', text: '#ffffff' },
        'MJPEG': { bg: 'rgba(233, 30, 99, 0.9)', text: '#ffffff' },
        'THEORA': { bg: 'rgba(139, 195, 74, 0.9)', text: '#ffffff' },
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
        return entry.namingVersion === 2 && (entry.audioLang || '') === audioPreferenceKey();
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
        const technical = ['runtime', 'aspectRatio', 'frameRate'].includes(category);
        const edition = label.startsWith(EDITION_PREFIX);
        const displayLabel = edition || technical ? label.slice(label.indexOf(':') + 1) : label;
        badge.textContent = edition ? editionLabel(displayLabel) : displayLabel;
        if (technical) {
            badge.dataset.jeQualityCategory = category;
            badge.dataset.jeCompact = compactTechnical(displayLabel, category);
            badge.title = displayLabel;
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

    /** @param {string} label Canonical server edition. @returns {string} Localized full label. */
    function editionLabel(label) {
        const keys = {"Director's Cut": 'directors_cut', 'Extended': 'extended', 'Unrated': 'unrated', 'Theatrical': 'theatrical', 'IMAX': 'imax', 'Remastered': 'remastered', 'Criterion': 'criterion', 'Uncut': 'uncut', 'Final Cut': 'final_cut', 'Special Edition': 'special'};
        return Object.hasOwn(keys, label) ? JE.t('quality_edition_' + keys[label]) : label;
    }

    /** @param {string} label Canonical server edition. @returns {string} Localized compact label. */
    function compactEditionLabel(label) {
        const keys = {"Director's Cut": 'directors_cut', 'Extended': 'extended', 'Unrated': 'unrated', 'Theatrical': 'theatrical', 'IMAX': 'imax', 'Remastered': 'remastered', 'Criterion': 'criterion', 'Uncut': 'uncut', 'Final Cut': 'final_cut', 'Special Edition': 'special'};
        return Object.hasOwn(keys, label) ? JE.t('quality_edition_' + keys[label] + '_compact') : label;
    }

    /**
     * Normalizes dynamic quality labels to their base key for sorting and CSS color matching.
     * @param {string} label - The quality label to normalize.
     * @returns {string} The normalized base label.
     */
    function normalizeQualityLabel(label) {
        if (!label || typeof label !== 'string') return label;

        const audioBases = ['Dolby Digital+', 'ATMOS', 'DTS-X', 'TRUEHD', 'DTS'];
        for (const base of audioBases) {
            if (label === base || label.startsWith(`${base} `)) {
                return base;
            }
        }

        return label;
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
            const ratios = [[4 / 3, .025, '4:3'], [1.43, .015, 'IMAX 1.43'], [1.66, .02, '1.66:1'], [16 / 9, .025, '16:9'], [1.85, .025, '1.85:1'], [1.90, .02, 'IMAX 1.90'], [2, .025, '2:1'], [2.20, .025, '2.20:1'], [2.35, .019, '2.35:1'], [2.39, .025, '2.39:1'], [2.76, .025, '2.76:1']];
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
    /**
     * Analyzes media stream and source information to determine quality tags.
     * @param {Array} mediaStreams - The MediaStreams array from the Jellyfin item.
     * @param {Array} mediaSources - The MediaSources array from the Jellyfin item.
     * @param {Object} [itemData] - Optional item metadata for filename/title signals.
     * @param {boolean} [useWidthForResolution=true] Preserve legacy cache/batch resolution while using new width facts for aspect.
     * @returns {Array<string>} A list of detected quality tags.
     */
    function getEnhancedQuality(mediaStreams, mediaSources, itemData = null, useWidthForResolution = true) {
        if (!mediaStreams && !mediaSources && !itemData?.Source && !itemData?.Edition) return [];

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
            const isFalsely4k = resolutionMatch &&
                ['4k', '2160p'].includes(resolutionMatch[1].toLowerCase()) &&
                displayTitleHeight > 0 && displayTitleHeight < 1250;

            if (resolutionMatch && !isFalsely4k) {
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
                // Cache/batch widths are new aspect facts; keep their legacy resolution result.
                const width = useWidthForResolution ? primaryVideoStream.Width || 0 : 0;
                if (height >= 3000 || width >= 7000) {
                    resolutionTag = '8K';
                } else if (height >= 1550 || width >= 3500) {
                    resolutionTag = '4K';
                } else if (height >= 1250) {
                    resolutionTag = '1440p';
                } else if (height >= 1000) {
                    resolutionTag = '1080p';
                } else if (height >= 700) {
                    resolutionTag = '720p';
                } else if (height >= 528) {
                    // PAL DVD is 720x576; NTSC DVD is 720x480. 528 splits the two evenly.
                    resolutionTag = '576p';
                } else if (height >= 400) {
                    resolutionTag = '480p';
                } else if (height > 0) {
                    // Any height below 400px gets the generic low-res tag
                    resolutionTag = 'LOW-RES';
                }

                if (resolutionTag) {
                    qualities.add(resolutionTag);
                }
            }
        }

        // --- VIDEO CODEC LOGIC ---
        // Map codec to standard names and add to qualities
        if (primaryVideoStream) {
            const codec = (primaryVideoStream.Codec || '').toLowerCase();
            const codecTag = (primaryVideoStream.CodecTag || '').toLowerCase();
            let detectedCodec = null;

            // Priority 1: Check actual codec field
            if (codec.includes('hevc')) {
                detectedCodec = 'HEVC';
            } else if (codec.includes('h265')) {
                detectedCodec = 'H265';
            } else if (codec.includes('h264') || codec.includes('avc') || codecTag.includes('avc')) {
                detectedCodec = 'H264';
            } else if (codec.includes('av1')) {
                detectedCodec = 'AV1';
            } else if (codec.includes('vp9')) {
                detectedCodec = 'VP9';
            } else if (codec.includes('vp8')) {
                detectedCodec = 'VP8';
            } else if (codec.includes('xvid')) {
                detectedCodec = 'XVID';
            } else if (codec.includes('divx')) {
                detectedCodec = 'DIVX';
            } else if (codec.includes('wmv') || codec.includes('vc1')) {
                detectedCodec = 'WMV';
            } else if (codec.includes('mpeg2')) {
                detectedCodec = 'MPEG2';
            } else if (codec.includes('mpeg4')) {
                detectedCodec = 'MPEG4';
            } else if (codec.includes('mjpeg')) {
                detectedCodec = 'MJPEG';
            } else if (codec.includes('theora')) {
                detectedCodec = 'THEORA';
            }

            // Priority 2: Fallback to display title if codec field didn't match
            if (!detectedCodec) {
                const displayTitle = (primaryVideoStream.DisplayTitle || '').toLowerCase();
                if (displayTitle.includes('hevc')) {
                    detectedCodec = 'HEVC';
                } else if (displayTitle.includes('h265')) {
                    detectedCodec = 'H265';
                } else if (displayTitle.includes('h264') || displayTitle.includes('avc')) {
                    detectedCodec = 'H264';
                } else if (displayTitle.includes('av1')) {
                    detectedCodec = 'AV1';
                } else if (displayTitle.includes('vp9')) {
                    detectedCodec = 'VP9';
                } else if (displayTitle.includes('vp8')) {
                    detectedCodec = 'VP8';
                } else if (displayTitle.includes('xvid')) {
                    detectedCodec = 'XVID';
                } else if (displayTitle.includes('divx')) {
                    detectedCodec = 'DIVX';
                } else if (displayTitle.includes('wmv') || displayTitle.includes('vc1')) {
                    detectedCodec = 'WMV';
                } else if (displayTitle.includes('mpeg2')) {
                    detectedCodec = 'MPEG2';
                } else if (displayTitle.includes('mpeg4')) {
                    detectedCodec = 'MPEG4';
                } else if (displayTitle.includes('mjpeg')) {
                    detectedCodec = 'MJPEG';
                } else if (displayTitle.includes('theora')) {
                    detectedCodec = 'THEORA';
                }
            }

            if (detectedCodec) {
                qualities.add(detectedCodec);
            }
        }

        // --- VIDEO DYNAMIC RANGE LOGIC ---
        let hdrTag = null;

        if (primaryVideoStream) {
            // Priority 1: Dolby Vision Scan
            const displayTitle = primaryVideoStream.DisplayTitle || '';
            const videoRangeType = primaryVideoStream.VideoRangeType || '';
            const dolbyVisionRegex = /dolby\s*vision|dv/i;
            const dolbyVisionMatchTitle = displayTitle.match(dolbyVisionRegex);
            const dolbyVisionMatchRange = videoRangeType.match(dolbyVisionRegex);
            if (dolbyVisionMatchTitle || dolbyVisionMatchRange) {
                hdrTag = 'Dolby Vision';
                qualities.add(hdrTag);
            } else {
                // Priority 2: HDR Fallback
                const hdr10PlusRegex = /hdr10plus/i;
                const hdr10Regex = /hdr10/i;
                const hdrRegex = /\bhdr\b/i;

                const hdr10PlusMatchTitle = displayTitle.match(hdr10PlusRegex);
                const hdr10PlusMatchRange = videoRangeType.match(hdr10PlusRegex);


                if (hdr10PlusMatchTitle || hdr10PlusMatchRange) {
                    hdrTag = 'HDR10+';
                    qualities.add(hdrTag);
                } else {
                    const hdr10MatchTitle = displayTitle.match(hdr10Regex);
                    const hdr10MatchRange = videoRangeType.match(hdr10Regex);

                    if (hdr10MatchTitle || hdr10MatchRange) {
                        hdrTag = 'HDR10';
                        qualities.add(hdrTag);
                    } else {
                        const hdrMatchTitle = displayTitle.match(hdrRegex);
                        const hdrMatchRange = videoRangeType.match(hdrRegex);

                        if (hdrMatchTitle || hdrMatchRange) {
                            hdrTag = 'HDR';
                            qualities.add(hdrTag);
                        }
                    }
                }
            }
        }

        // --- AUDIO LOGIC ---
        let audioTag = null;

        for (let i = 0; i < audioStreams.length; i++) {
            const stream = audioStreams[i];

            // Priority 1: DisplayTitle Scan
            const displayTitle = stream.DisplayTitle || '';

            const atmosRegex = /atmos/i;
            const truehd = /truehd/i;
            const dtsxRegex = /dts-x/i;
            const dtsRegex = /\bdts\b/i;
            const ddpRegex = /dolby\s*digital\+/i;

            const atmosMatch = displayTitle.match(atmosRegex);
            const truehdMatch = displayTitle.match(truehd);
            const dtsxMatch = displayTitle.match(dtsxRegex);
            const dtsMatch = displayTitle.match(dtsRegex);
            const ddpMatch = displayTitle.match(ddpRegex);

            if (atmosMatch) {
                audioTag = 'ATMOS';
                break; // Stop all further audio checks
            } else if (truehdMatch) {
                audioTag = 'TRUEHD';
                break;
            } else if (dtsxMatch) {
                audioTag = 'DTS-X';
                break;
            } else if (dtsMatch) {
                audioTag = 'DTS';
                break;
            } else if (ddpMatch) {
                audioTag = 'Dolby Digital+';
                break;
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
                    if (codec.includes('x') || profile.includes('x')) {
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

        const channelTag = getChannelTag(audioStreams);

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

        // --- 3D VIDEO LOGIC ---
        if (mediaSources) {
            for (const source of mediaSources) {
                if (source.Path) {
                    const path = source.Path.toLowerCase();
                    const has3D = path.includes('3d');
                    const has3DFormat = /hsbs|fsbs|htab|ftab|mvc/.test(path);

                    if (has3D && has3DFormat) {
                        qualities.add('3D');
                        break; // Found 3D, no need to check other sources
                    }
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
        return Array.from(qualities);
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
        const qualities = policy === 'latest' ? [...(summary.LatestExtras || [])]
            : representative.filter(label => !['resolution', 'dynamicRange', 'videoCodec', 'audio'].includes(categorize(label)));
        const preferred = resolvePreferredAudioLanguage();
        const match = JE.core.mediaLanguage?.matchesLanguage;
        const audioVariants = Object.entries(summary.AudioByLanguage || {});
        const regionalFallbacks = Object.entries(summary.AudioRegionFallback || {});
        const audio = preferred && typeof match === 'function'
            ? (audioVariants.find(([language]) => match(language, preferred, { requireRegion: true }))
                || regionalFallbacks.find(([language]) => match(language, preferred))
                || audioVariants.find(([language]) => !language.includes('-') && match(language, preferred)))?.[1] : null;
        let mixed = false;
        for (const [key, category] of Object.entries(summary.Categories || {})) {
            const facts = key === 'audioInfo' && audio ? audio : category;
            const value = policy === 'latest' ? facts.Latest : policy === 'shared' && !facts.AllAgree ? null : facts.Best;
            if (value) qualities.push(value);
            const cat = CATEGORY_BY_KEY.get(categoryKeys[key]);
            mixed ||= !facts.AllAgree && !!cat && readBool(cat.settingKey, cat.fallback ?? true);
        }
        if (policy === 'mixed' && summary.EpisodeCount > 1 && mixed) qualities.push('Mixed');
        return qualities;
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
    function qualitiesFromCache(cached) {
        if (!cached || !matchesAudioPreference(cached)) return null;
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
        for (const q of qualities) {
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
                return `.${containerClass} .${overlayClass}[data-quality="${k}"] {
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
                .${overlayClass} {
                    font-weight: bold;
                    border-radius: 5px;
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(10px * var(--je-tag-scale, 1));
                    font-size: calc(clamp(0.65rem, 2vw, 0.85rem) * var(--je-tag-scale, 1));
                    user-select: none;
                    pointer-events: none;
                    font-variant-caps: small-caps;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    border: 1px solid rgba(255,255,255,0.15);
                    /* backdrop-filter removed — blur causes jank during hover animations */
                    opacity: 1;
                    transform: translateY(0);
                    white-space: nowrap;
                    flex-shrink: 0;
                    line-height: 1.2;
                }
                .layout-mobile .${overlayClass} {
                    padding: calc(0px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    font-size: calc(0.65rem * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }
                .layout-mobile .${containerClass} {
                    gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                }
                @media (min-width: 1440px) {
                    .${overlayClass} {
                        padding: calc(3px * var(--je-tag-scale, 1)) calc(12px * var(--je-tag-scale, 1));
                        font-size: calc(0.9rem * var(--je-tag-scale, 1));
                        border-radius: 6px;
                    }
                    .${containerClass} {
                        gap: calc(6px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 768px) {
                    .${overlayClass} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                        font-size: calc(0.65rem * var(--je-tag-scale, 1));
                        border-radius: 3px;
                    }
                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${overlayClass} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                        font-size: calc(0.6rem * var(--je-tag-scale, 1));
                        border-radius: 2px;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
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
                const hotQualities = hot && (Date.now() - hot.timestamp) < ctx.cacheTtl ? qualitiesFromCache(hot) : null;
                if (hotQualities) {
                    if (hotQualities.length) insertOverlay(ctx, el, hotQualities);
                    return;
                }

                let qualities = [];
                if (item.Type === 'Series' || item.Type === 'Season') {
                    if (extras.firstEpisode) {
                        qualities = getEnhancedQuality(extras.firstEpisode.MediaStreams, extras.firstEpisode.MediaSources, extras.firstEpisode, false);
                    }
                } else {
                    qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources, item, false);
                }

                const representativeQualities = qualities;
                qualities = aggregateQualities(item, qualities);
                {
                    const audioLang = audioPreferenceKey();
                    const record = { qualities, representativeQualities, type: item.Type, qualitySummary: item.QualitySummary,
                        namingVersion: 2, timestamp: Date.now(), audioLang, aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() };
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
                const qualities = qualitiesFromCache(cached);
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
                if (cached && cached.entry === entry && matchesAudioPreference(cached) && cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) {
                    if (cached.qualities.length > 0) insertOverlay(ctx, el, cached.qualities);
                    return;
                }
                const audioLang = audioPreferenceKey();
                const sd = entry.StreamData;
                const representative = getEnhancedQuality(sd?.Streams, sd?.Sources, { Name: sd?.ItemName, Path: sd?.ItemPath, RunTimeTicks: sd?.RunTimeTicks, Source: entry.Source, Edition: entry.Edition }, false);
                const qualities = aggregateQualities(entry, representative);
                serverQualityCache.set(itemId, { audioLang, qualities, entry, namingVersion: 2, aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() });
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

    /**
     * Initializes the Quality Tags feature.
     */
    JE.initializeQualityTags = function() {
        watchPlaybackPreferencesPage();
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

})(window.JellyfinEnhanced);
