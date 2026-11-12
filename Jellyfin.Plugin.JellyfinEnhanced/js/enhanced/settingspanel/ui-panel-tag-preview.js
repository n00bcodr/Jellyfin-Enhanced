/**
 * @file Live preview of the poster tags in the settings panel's Media Tags
 * hub: four synthetic cards (movie and series posters, an episode still
 * and a list row) drawn through the real layout controller (core/tag-layout.js) and
 * the tag modules' chip classes. Each card's look is decided by the same
 * lock → first matching rule → shape override → default resolver as the real cards
 * (lookSource/resolveLayout): the series sample carries the id of the most
 * recently locked item, the episode sample the facts of the first enabled
 * rule, so the labels "Locked" and "Rule N" are what the resolver answered,
 * never what the preview assumed.
 *
 * The cards carry the card structure the layout controller needs
 * (.cardBox > .cardScalable + a title block for the caption outlet) but
 * neither .card nor .cardImageContainer, so the tag pipeline and other card
 * features never pick them up. Built lazily by the hub (ui-panel-media-tags.js)
 * when the Media Tags section first shows, disposed when the panel closes.
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /** The setting that turns each group's renderer on (same keys as the panel toggles). */
    const ENABLED = {
        status: 'statusTagsEnabled',
        awards: 'awardsTagsEnabled',
        quality: 'qualityTagsEnabled',
        rating: 'ratingTagsEnabled',
        ageRating: 'ageRatingTagsEnabled',
        language: 'languageTagsEnabled',
        genre: 'genreTagsEnabled',
        logos: 'logoTagsEnabled',
        custom: 'customTagsEnabled',
    };
    const GROUP_IDS = Object.keys(ENABLED);

    /** Each sample art's dominant colour (its CSS gradient's main band), for the Poster tag colours. */
    const ART_RGB = { movie: '181,86,47', series: '44,111,122', episode: '63,113,146', list: '63,113,146' };
    /**
     * The weekday "Airs {date}" names for the series sample, as a real badge writes it (tags/statustags.js
     * formatAirDay: the long weekday in the status date locale), for a fixed Friday.
     * @returns {string}
     */
    function sampleWeekday() {
        const friday = new Date(Date.UTC(2026, 0, 9));
        const locale = JE.getStatusDateContext?.()?.locale || JE.core?.mediaLanguage?.uiLocale?.() || undefined;
        try { return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(friday); } catch { return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(friday); }
    }

    /** Made-up logos (inline SVG), so the Logos samples never touch the network or a real brand. */
    const LOGOS = {
        provider: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#d81b60"/><path d="M13 11h14v5H18v3h8v5h-8v5h9v5H13z" fill="#fff"/></svg>',
        network: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 32"><circle cx="16" cy="16" r="12" fill="#1565c0"/><path d="M10 22V10l12 12V10" stroke="#fff" stroke-width="3" fill="none"/><text x="34" y="22" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#111">NWB</text></svg>',
    };

    /** Inline flags (data URIs), so the preview never touches the network. */
    const FLAGS = {
        fr: { lang: 'fr', name: 'French', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2"><rect width="1" height="2" fill="#002395"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ed2939"/></svg>' },
        jp: { lang: 'ja', name: 'Japanese', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#bc002d"/></svg>' },
        de: { lang: 'de', name: 'German', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 3"><rect width="5" height="1" fill="#000"/><rect y="1" width="5" height="1" fill="#d00"/><rect y="2" width="5" height="1" fill="#ffce00"/></svg>' },
        it: { lang: 'it', name: 'Italian', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2"><rect width="1" height="2" fill="#009246"/><rect x="1" width="1" height="2" fill="#fff"/><rect x="2" width="1" height="2" fill="#ce2b37"/></svg>' },
    };

    /**
     * The four samples. `quality` maps a quality category's setting key to
     * the chip it shows ([label, data-quality, kind class]); `status` lists
     * candidate badges in the status module's precedence (a card shows the
     * first whose family is on), each [family setting, kind, label key,
     * compact label key, label params].
     */
    const SAMPLES = [
        {
            key: 'movie', type: 'Movie', shape: 'poster', titleKey: 'panel_media_tags_preview_title_movie',
            id: 'a11ce0000000000000000000000000a1',
            facts: { Genres: ['Science Fiction', 'Thriller'], OfficialRating: 'PG-13', Scenes: { PostCredits: true, MidCredits: false } },
            quality: { showResolutionTag: ['4K', '4K', 'resolution'], showDynamicRangeTag: ['Dolby Vision', 'Dolby Vision', 'video-codec'], showSpecialFormatTag: ['IMAX', 'IMAX', 'video-codec'], showVideoCodecTag: ['HEVC', 'HEVC', 'video-format'], showAudioInfoTag: ['ATMOS 7.1', 'ATMOS', 'audio-codec'] },
            rating: { critic: '92%', community: '8.1' },
            age: 'PG-13', flags: ['fr', 'jp', 'de'], genres: [['Science Fiction', 'science'], ['Thriller', 'psychology']],
            logos: [{ kind: 'provider', name: 'Streamflix', svg: LOGOS.provider }],
            status: [['statusTagsLeaving', 'leaving', 'status_tag_leaving_days', 'status_tag_compact_leaving_days', { days: 5 }], ['statusTagsTrending', 'trending', 'status_tag_trending_today', null, { rank: 3 }], ['statusTagsNewRelease', 'new', 'status_tag_new_movie'], ['statusTagsJustAdded', 'added', 'status_tag_just_added', 'status_tag_compact_added'], ['statusTagsScenes', 'scenes', 'status_tag_post_credits']],
            custom: 2,
        },
        {
            key: 'series', type: 'Series', shape: 'poster', titleKey: 'panel_media_tags_preview_title_series',
            id: 'a11ce0000000000000000000000000b2',
            facts: { Genres: ['Drama', 'Mystery'], OfficialRating: 'TV-MA' },
            quality: { showResolutionTag: ['4K', '4K', 'resolution'], showDynamicRangeTag: ['HDR10', 'HDR10', 'video-codec'], showAudioInfoTag: ['Dolby Digital+ 5.1', 'Dolby Digital+', 'audio-codec'] },
            rating: { critic: '97%', community: '8.7' },
            age: 'TV-MA', flags: ['it'], genres: [['Drama', 'theater_comedy'], ['Mystery', 'psychology_alt']],
            logos: [{ kind: 'network', name: 'Northwind Broadcasting', svg: LOGOS.network }],
            status: [['statusTagsSchedule', 'schedule', 'status_tag_airs_date', null, { get date() { return sampleWeekday(); } }], ['statusTagsSeriesStatus', 'status', 'status_tag_returning']],
            custom: 1,
        },
        {
            key: 'episode', type: 'Episode', shape: 'thumb', titleKey: 'panel_media_tags_preview_title_episode',
            id: 'a11ce0000000000000000000000000c3',
            facts: { Genres: ['Animation', 'Family'], OfficialRating: 'TV-Y' },
            quality: { showResolutionTag: ['1080p', '1080p', 'resolution'], showAudioInfoTag: ['Dolby Digital+ 5.1', 'Dolby Digital+', 'audio-codec'] },
            rating: { community: '9.3' },
            age: 'TV-Y', flags: ['jp'], genres: [['Animation', 'animation'], ['Family', 'family_restroom']],
            logos: [{ kind: 'network', name: 'Harbor Kids Network' }],
            status: [['statusTagsMilestones', 'milestone', 'status_tag_season_finale', 'status_tag_compact_finale'], ['statusTagsNewRelease', 'new', 'status_tag_new_episode', 'status_tag_compact_new_episode']],
        },
    ];
    SAMPLES.push({ ...SAMPLES[2], key: 'list', shape: 'list', titleKey: 'tag_shapes_preview_list', id: 'a11ce0000000000000000000000000d4' });

    /** @returns {any} The layout controller, or null. */
    const layoutApi = () => JE.core?.tagLayout || null;

    /**
     * Resolve a boolean setting: user override, then admin default, then the built-in default.
     * @param {string} userKey
     * @param {string} pluginKey
     * @param {boolean} [fallback=true]
     * @returns {boolean}
     */
    function effectiveBool(userKey, pluginKey, fallback = true) {
        const u = JE.currentSettings?.[userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[pluginKey];
        return typeof a === 'boolean' ? a : fallback;
    }

    /** @param {string} key @returns {string} The setting's PascalCase plugin key. */
    const pluginKeyOf = (key) => key.charAt(0).toUpperCase() + key.slice(1);
    /** Status families whose built-in default is off. */
    const OFF_BY_DEFAULT = new Set(['statusTagsSeriesStatus', 'statusTagsScenes', 'statusTagsLeaving', 'statusTagsDirectPlay']);

    /**
     * The sample group wrapper for one card, with the renderers' real classes.
     * @param {Object} sample - One of SAMPLES.
     * @param {string} group
     * @returns {HTMLElement|null} Null when the group has nothing to show.
     */
    function sampleGroup(sample, group) {
        const L = layoutApi();
        const wrap = document.createElement('div');
        wrap.className = L.CONTAINER_CLASS[group];
        const add = (className, text) => {
            const el = document.createElement('div');
            el.className = className;
            if (text !== undefined) el.textContent = text;
            wrap.appendChild(el);
            return el;
        };
        switch (group) {
            case 'quality': {
                const cats = internal.tagGroupEditorData?.sortedQualityCats?.() || [];
                for (const cat of cats) {
                    const chip = sample.quality[cat.settingKey] || (cat.fallback === false ? cat.sample : null);
                    if (!chip || !effectiveBool(cat.settingKey, cat.pluginKey, cat.fallback ?? true)) continue;
                    const [label, key, kind] = chip;
                    const minimum = JE.currentSettings.qualityMinimumResolution ?? JE.pluginConfig?.QualityMinimumResolution;
                    if (cat.settingKey === 'showResolutionTag' && minimum === '4k' && !['4K', '8K'].includes(key)) continue;
                    const node = add(`quality-overlay-label ${kind}`, label);
                    node.dataset.quality = key;
                    if (cat.fallback === false) {
                        const category = cat.settingKey.slice(4, -3);
                        node.dataset.jeQualityCategory = category[0].toLowerCase() + category.slice(1);
                        node.dataset.jeCompact = label.replace(/(\d+)h (\d+)m/, '$1h$2').replace(/:1$/, '');
                    }
                    const modeKey = { showAudioInfoTag: 'qualityAudioDisplayMode', showVideoCodecTag: 'qualityVideoCodecDisplayMode', showDynamicRangeTag: 'qualityHdrDisplayMode' }[cat.settingKey];
                    const mode = modeKey && (JE.currentSettings[modeKey] ?? JE.pluginConfig?.[modeKey[0].toUpperCase() + modeKey.slice(1)]);
                    const hideSdr = JE.currentSettings.qualityHideSdr ?? JE.pluginConfig?.QualityHideSdr;
                    if (mode === 'all') {
                        const extra = cat.settingKey === 'showAudioInfoTag' ? ['DTS 5.1', 'DTS']
                            : cat.settingKey === 'showVideoCodecTag' ? ['H264', 'H264'] : !hideSdr ? ['SDR', 'SDR'] : null;
                        if (extra) add(`quality-overlay-label ${kind}`, extra[0]).dataset.quality = extra[1];
                    }
                }
                break;
            }
            case 'awards':
                if (sample.type === 'Movie' || sample.type === 'Series') {
                    for (const fact of JE.awardsTags?.resolve(sample.type === 'Movie'
                        ? { ImdbRank: 12, CertifiedFresh: true, OscarWinner: true, OscarYear: 2024, LetterboxdRank: 24 }
                        : { EmmyWinner: true, EmmyYear: 2023 }) || []) wrap.appendChild(JE.awardsTags.chip(fact));
                }
                break;
            case 'rating':
                for (const fact of JE.ratingSources.resolve(sample.rating.community, sample.rating.critic?.replace('%', ''),
                    { imdb: 8.1, tmdb: 81, rtCritic: 92, rtAudience: 88, metacritic: 74, letterboxd: 4.1, trakt: 85, myAnimeList: 8.4, aniList: 82, metacriticUser: 7.9, rogerEbert: 3.5, mdblist: 78 })) {
                    wrap.appendChild(JE.ratingSources.chip(fact));
                }
                break;
            case 'ageRating':
                add('age-rating-tag', sample.age).setAttribute('rating', sample.age);
                break;
            case 'language': {
                const codes = { fr: 'fr', jp: 'ja', de: 'de', it: 'it' };
                const data = { audio: sample.flags.map(flag => codes[flag]), subtitles: ['fr', 'de'] };
                const group = JE.core.languageTags?.buildGroup(data, 0, code => FLAGS[code]
                    ? `data:image/svg+xml,${encodeURIComponent(FLAGS[code].svg)}` : JE.core.mediaLanguage.flagSrc(code));
                if (group) return group.children.length ? group : null;
                // Standalone preview harnesses without the renderer still show the sample flags.
                for (const code of sample.flags) {
                    const img = document.createElement('img');
                    img.className = 'language-flag';
                    img.src = `data:image/svg+xml,${encodeURIComponent(FLAGS[code].svg)}`;
                    // The language's name in the user's language; the English one only where the browser has none.
                    img.alt = img.title = JE.core.mediaLanguage?.localName?.(FLAGS[code].lang) || FLAGS[code].name;
                    img.dataset.lang = code;
                    img.dataset.langName = FLAGS[code].name;
                    wrap.appendChild(img);
                }
                break;
            }
            case 'genre':
                for (const [name, icon] of sample.genres) {
                    const chip = add('genre-tag');
                    chip.title = name;
                    // The genre's Tag Styles label, as genretags.js marks its chips.
                    const label = JE.genreTags?.labelFor(name);
                    if (label) chip.dataset.jeGenre = label;
                    const glyph = document.createElement('span');
                    glyph.className = 'je-msym-outlined';
                    glyph.textContent = icon;
                    chip.appendChild(glyph);
                    {
                        const text = document.createElement('span');
                        text.className = 'genre-text';
                        text.textContent = name;
                        chip.appendChild(text);
                    }
                }
                break;
            case 'status': {
                // One badge per card, the first whose family is on (as statustags.js picks).
                const badge = sample.status.find(([key]) => effectiveBool(key, pluginKeyOf(key), !OFF_BY_DEFAULT.has(key)));
                if (!badge) break;
                const [, kind, labelKey, compactKey, params] = badge;
                const tag = add(`status-tag status-tag--${kind}`);
                if (compactKey) tag.dataset.jeCompact = JE.t(compactKey, params);
                if (kind === 'trending') {
                    // "#{rank} Today" with the rank in its own span, as the status module draws it.
                    const [before, after = ''] = JE.t(labelKey, { rank: '\u0001' }).split('\u0001');
                    const hash = before.endsWith('#') ? '#' : '';
                    const rank = document.createElement('span');
                    rank.className = 'status-tag-rank';
                    rank.textContent = `${hash}${params.rank}`;
                    tag.append(before.slice(0, before.length - hash.length), rank, after);
                } else {
                    tag.textContent = JE.t(labelKey, params);
                }
                break;
            }
            case 'logos':
                // A logo on its pill, or the name chip a logo without an image shows.
                for (const logo of sample.logos || []) {
                    const chip = JE.logoTags?.buildChip({ kind: logo.kind, name: logo.name, logo: null },
                        logo.svg ? `data:image/svg+xml,${encodeURIComponent(logo.svg)}` : undefined);
                    if (chip) wrap.appendChild(chip);
                }
                break;
            case 'custom': {
                // The administrator's first rules (as customtags.js draws them), or a
                // sample label while none is set up.
                const custom = JE.customTags;
                const rules = custom ? [...custom.currentRules().rules.values()] : [];
                const shown = rules.length ? rules.slice(0, sample.custom || 0)
                    : (sample.custom ? [{ id: 'collection:sample', match: 'collection', value: JE.t('custom_tags_sample'), label: JE.t('custom_tags_sample'), icon: null }] : []);
                for (const rule of shown) {
                    if (custom) wrap.appendChild(custom.buildChip(rule));
                    else add('custom-tag', rule.label).dataset.jeCustom = rule.label;
                }
                break;
            }
            default:
                return null;
        }
        return wrap.children.length ? wrap : null;
    }

    /**
     * The item data a sample hands the resolver (setCardContext): the
     * movie as it is; the series under the id of the most recently locked
     * item; the episode with the conditions of the first enabled rule (its
     * type included), so the resolver can find them.
     * @param {Object} sample
     * @returns {{id: string, type: string, entry: Object}}
     */
    function sampleFacts(sample) {
        const look = JE.core.tagLook;
        const { rules, locks } = look ? look.read() : { rules: [], locks: new Map() };
        let id = sample.id;
        let type = sample.type;
        const entry = { ...sample.facts, Genres: sample.facts.Genres.slice() };
        if (sample.key === 'series' && locks.size) {
            id = Array.from(locks.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt)[0][0];
        }
        if (sample.key === 'episode') {
            const rule = rules.find((r) => r.enabled && r.when.length);
            // Every genre the rule asks for (a rule needs all of its conditions to hold).
            const genres = [];
            for (const cond of rule?.when || []) {
                if (cond.field === 'library') entry.LibraryId = cond.value;
                else if (cond.field === 'type') type = cond.value;
                else if (cond.field === 'genre') genres.push(cond.value);
                else if (cond.field === 'ageRating') entry.OfficialRating = cond.value;
            }
            if (genres.length) entry.Genres = genres;
        }
        return { id, type, entry: { ...entry, Id: id, Type: type } };
    }

    /**
     * One sample card: the poster or still the layout controller draws on,
     * and the line under it naming the item, where its look comes from and
     * the look.
     * @param {Object} sample
     * @returns {HTMLElement}
     */
    function buildSample(sample) {
        const figure = document.createElement('figure');
        figure.className = 'je-mtp-sample';
        figure.dataset.sample = sample.key;
        const card = document.createElement('div');
        card.className = `je-mtp-card je-mtp-card--${sample.shape}`;
        card.dataset.jeShape = sample.shape === 'thumb' ? 'landscape' : sample.shape === 'list' ? 'list' : 'portrait';
        card.tabIndex = 0;
        card.setAttribute('aria-label', JE.t(sample.titleKey));
        const box = document.createElement('div');
        box.className = 'cardBox';
        const scalable = document.createElement('div');
        scalable.className = `${sample.shape === 'list' ? '' : 'cardScalable '}je-mtp-scalable`;
        const art = document.createElement('div');
        art.className = `je-mtp-art je-mtp-art--${sample.key}`;
        // The art's main colour, for the Poster tag colours (tags/tag-poster-colours.js).
        art.dataset.jePosterRgb = ART_RGB[sample.key] || ART_RGB.movie;
        const overlay = document.createElement('div');
        overlay.className = 'cardOverlayContainer';
        scalable.append(art, overlay);
        const title = document.createElement('div');
        title.className = 'cardText je-mtp-card-title';
        title.textContent = JE.t(sample.titleKey);
        box.append(scalable, title);
        card.appendChild(box);
        const meta = document.createElement('figcaption');
        meta.className = 'je-mtp-meta';
        figure.append(card, meta);
        return figure;
    }

    /**
     * The visible chips of a drawn card in the order they read: one short
     * text per chip, flags by language code, "+N" overflow chips as they are.
     * @param {HTMLElement} card
     * @param {string|null} first - A group whose chips go first (the one being edited).
     * @returns {string[]}
     */
    function chipTexts(card, first) {
        const L = layoutApi();
        const lead = [];
        const rest = [];
        const chips = card.querySelectorAll('.je-tag-slot:not([data-je-slot="hover"]) :is(.quality-overlay-label, .rating-tag, .age-rating-tag, .language-flag, .language-chip, .genre-tag, .status-tag, .awards-tag, .je-logo-chip, .custom-tag, .je-tag-pill-fact, .je-tag-more)');
        for (const chip of chips) {
            const el = /** @type {HTMLElement} */ (chip);
            if (el.parentElement?.classList.contains('language-subtitle')) continue;
            let text;
            if (el.classList.contains('language-flag')) text = String(el.dataset.lang || '').toUpperCase();
            else if (el.classList.contains('genre-tag')) text = el.title || el.textContent || '';
            else if (el.classList.contains('je-logo-chip')) text = el.title || el.textContent || '';
            // Rating chips: their score only (the star is an icon ligature).
            else if (el.classList.contains('rating-tag')) text = `${el.classList.contains('rating-tag-tmdb') ? '★' : ''}${el.querySelector('.rating-text')?.textContent || ''}`;
            // Custom chips: their label (an icon is a ligature too).
            else if (el.classList.contains('custom-tag')) text = el.dataset.jeCustom || '';
            else text = el.textContent || '';
            text = text.replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const inFirst = first && el.closest(`.${L.CONTAINER_CLASS[first]}`);
            (inFirst ? lead : rest).push(text);
        }
        return lead.concat(rest);
    }

    /**
     * The preview's stylesheet (panel-scoped). Its text colours read
     * --je-mtp-* custom properties, which the admin page sets per theme; the
     * hub defines none and keeps the fallbacks.
     */
    const PREVIEW_CSS = (JE.awardsTags?.CSS || '') + `
        #jellyfin-enhanced-panel .je-mtp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
        #jellyfin-enhanced-panel .je-mtp-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; margin: 0; }

        #jellyfin-enhanced-panel .je-mtp-view { display: inline-flex; border: 1px solid var(--je-mtp-line, rgba(255,255,255,0.22)); border-radius: 999px; overflow: hidden; }
        #jellyfin-enhanced-panel .je-mtp-view button { background: transparent; color: var(--je-mtp-text, rgba(255,255,255,0.85)); border: 0; padding: 5px 12px; min-height: 30px; font: inherit; font-size: 12px; cursor: pointer; }
        #jellyfin-enhanced-panel .je-mtp-view button[aria-pressed="true"] { background: var(--je-mtp-pressed-bg, rgba(255,255,255,0.16)); color: var(--je-mtp-pressed-text, #fff); font-weight: 600; }
        #jellyfin-enhanced-panel .je-mtp-view button:focus-visible { outline: 2px solid var(--je-mtp-strong, #fff); outline-offset: -3px; }
        #jellyfin-enhanced-panel .je-mtp-samples { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 10px; }
        #jellyfin-enhanced-panel .je-mtp-sample { margin: 0; min-width: 0; }
        #jellyfin-enhanced-panel .je-mtp-sample[data-sample="episode"] { grid-column: 1 / -1; display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 4px 10px; align-items: start; }
        #jellyfin-enhanced-panel .je-mtp-sample[data-sample="list"] { grid-column: 1 / -1; }
        #jellyfin-enhanced-panel .je-mtp-card--list .cardBox { display: flex; height: 92px; gap: 8px; align-items: center; background: var(--je-mtp-surface, rgba(255,255,255,0.05)); border-radius: 6px; }
        #jellyfin-enhanced-panel .je-mtp-card--list .je-mtp-scalable { width: 140px; height: 92px; flex: 0 0 140px; }
        #jellyfin-enhanced-panel .je-mtp-art--list { background: linear-gradient(180deg, #2f5f80 0%, #4f86a6 55%, #3f7d3a 56%, #234f27 100%); }
        #jellyfin-enhanced-panel .je-mtp-card:focus-visible { outline: 2px solid var(--je-mtp-strong, #fff); outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mtp-card .cardBox { margin: 0; }
        #jellyfin-enhanced-panel .je-mtp-card--poster .je-mtp-scalable { width: 100%; aspect-ratio: 2 / 3; }
        #jellyfin-enhanced-panel .je-mtp-card--thumb { width: 140px; }
        #jellyfin-enhanced-panel .je-mtp-card--thumb .je-mtp-scalable { width: 140px; aspect-ratio: 16 / 9; }
        #jellyfin-enhanced-panel .je-mtp-scalable { position: relative; border-radius: 6px; overflow: hidden; contain: paint; }
        #jellyfin-enhanced-panel .je-mtp-art { position: absolute; inset: 0; }
        #jellyfin-enhanced-panel .je-mtp-art--movie { background: linear-gradient(170deg, #e2a35d 0%, #b5562f 48%, #3a1d14 100%); }
        #jellyfin-enhanced-panel .je-mtp-art--movie::after { content: ''; position: absolute; left: 0; right: 0; bottom: 18%; height: 22%; background: linear-gradient(175deg, transparent 30%, rgba(60,25,12,0.85) 31%); }
        #jellyfin-enhanced-panel .je-mtp-art--series { background: radial-gradient(ellipse at 50% 58%, #f2f7f7 0%, #9ccfd2 22%, #2c6f7a 55%, #0d2a31 100%); }
        #jellyfin-enhanced-panel .je-mtp-art--series::after { content: ''; position: absolute; left: 46%; width: 8%; top: 52%; height: 14%; border-radius: 40% 40% 4px 4px; background: #111; }
        #jellyfin-enhanced-panel .je-mtp-art--episode { background: linear-gradient(180deg, #2f5f80 0%, #4f86a6 55%, #3f7d3a 56%, #234f27 100%); }
        #jellyfin-enhanced-panel .je-mtp-art--episode::after { content: ''; position: absolute; left: 18%; bottom: 14%; width: 22%; height: 16%; border-radius: 50%; background: #3f6fd8; box-shadow: 34px 4px 0 -4px #e8a04c; }
        #jellyfin-enhanced-panel .je-mtp-card .cardOverlayContainer { display: none; }
        #jellyfin-enhanced-panel .je-mtp-card .je-tag-host { position: absolute; inset: 0; pointer-events: none; container-type: inline-size; }
        #jellyfin-enhanced-panel .je-mtp-card-title { font-size: 12px; padding: 3px 2px 0; color: var(--je-mtp-text, rgba(255,255,255,0.9)); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #jellyfin-enhanced-panel .je-mtp-meta { font-size: 12px; line-height: 1.35; color: var(--je-mtp-muted, rgba(255,255,255,0.7)); padding: 2px 2px 0; overflow-wrap: anywhere; }
        #jellyfin-enhanced-panel .je-mtp-meta strong { color: var(--je-mtp-text, rgba(255,255,255,0.9)); font-weight: 400; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mtp-meta [data-source="lock"] { color: var(--je-mtp-lock, #ffd166); }
        #jellyfin-enhanced-panel .je-mtp-meta [data-source="shape"] { white-space: normal; }
        #jellyfin-enhanced-panel .je-mtp-meta [data-source="rule"] { color: var(--je-mtp-rule, #7fd3ff); }
        #jellyfin-enhanced-panel .je-mtp-meta .je-mtp-look { display: block; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-mtp-foot { margin: 12px 0 0; font-size: 12px; line-height: 1.45; color: var(--je-mtp-muted, rgba(255,255,255,0.7)); }
        #jellyfin-enhanced-panel .je-mtp-foot p { margin: 0; }
        #jellyfin-enhanced-panel .je-mtp-why { margin-top: 4px; }
        #jellyfin-enhanced-panel .je-mtp-why > summary { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 0 6px 0 2px; border-radius: 6px; cursor: pointer; list-style: none; color: var(--je-mtp-text, rgba(255,255,255,0.9)); font-weight: 600; }
        #jellyfin-enhanced-panel .je-mtp-why > summary::-webkit-details-marker { display: none; }
        #jellyfin-enhanced-panel .je-mtp-why > summary::before { content: 'expand_more'; font-family: 'Material Icons'; font-size: 18px; font-weight: normal; line-height: 1; font-feature-settings: 'liga'; transition: transform 0.2s ease; }
        #jellyfin-enhanced-panel .je-mtp-why[open] > summary::before { transform: rotate(180deg); }
        #jellyfin-enhanced-panel .je-mtp-why > summary:hover { background: var(--je-mtp-surface, rgba(255,255,255,0.05)); }
        #jellyfin-enhanced-panel .je-mtp-why > summary:focus-visible { outline: 2px solid var(--je-mtp-strong, #fff); outline-offset: 2px; }
        #jellyfin-enhanced-panel .je-mtp-foot strong { color: var(--je-mtp-strong, #fff); }
        #jellyfin-enhanced-panel .je-mtp-note { margin: 6px 0 0; font-size: 12px; color: var(--je-mtp-lock, #ffd166); }
        #jellyfin-enhanced-panel .je-mtp-note[hidden] { display: none; }
        /* Spotlight: the group being edited stays bright, the others step back. */
        #jellyfin-enhanced-panel .je-mtp[data-spot] .je-mtp-card :is(.quality-overlay-container, .genre-overlay-container, .language-overlay-container, .rating-overlay-container, .age-rating-overlay-container, .status-overlay-container, .awards-overlay-container, .logo-overlay-container, .custom-overlay-container, .je-tag-pill, .je-tag-dots) { opacity: 0.6; transition: opacity 0.15s; }
    `;

    /**
     * The spotlight rule for each group: its chips stay at full strength
     * with a quiet outline.
     * @param {Object<string, string>} containerClass - Group id → wrapper class.
     * @returns {string}
     */
    function spotlightCss(containerClass) {
        return GROUP_IDS.map((g) => `#jellyfin-enhanced-panel .je-mtp[data-spot="${g}"] .je-mtp-card .${containerClass[g]} { opacity: 1; outline: 1px solid rgba(255,255,255,0.8); outline-offset: 1px; border-radius: 4px; }`).join('\n');
    }

    /**
     * Share per-card pointer/focus reveal and the touch pin across all previews.
     * The returned disposer removes every listener owned by this interaction.
     * @param {HTMLElement[]} cards
     * @param {HTMLElement} view - Resting/Hover buttons, identified by data-view.
     * @param {{change?: (active: boolean) => void, touch?: () => void}} [options]
     * @returns {{sync: () => void, dispose: () => void}}
     */
    internal.bindTagPreviewInteraction = function(cards, view, options = {}) {
        let pinned = false;
        const pointed = new Set();
        const focused = new Set();
        const listeners = [];
        /** Apply the preview hook without changing any library card selectors. */
        const sync = () => {
            for (const card of cards) {
                const reveal = pinned || pointed.has(card) || focused.has(card);
                card.classList.toggle('je-tag-reveal', reveal);
                // The names a reveal floats out stay beside their icons, clear of other chips (core/tag-layout.js).
                if (reveal) JE.core?.tagLayout?.fitReveal?.(card.querySelector('.je-tag-host'));
            }
            options.change?.(pinned || pointed.size > 0 || focused.size > 0);
        };
        /** Register a listener with this preview's lifetime. */
        const listen = (el, type, fn) => {
            el.addEventListener(type, fn);
            listeners.push(() => el.removeEventListener(type, fn));
        };
        for (const card of cards) {
            listen(card, 'pointerenter', event => {
                if (event.pointerType === 'touch') return;
                pointed.add(card); sync();
            });
            listen(card, 'pointerleave', () => { pointed.delete(card); sync(); });
            listen(card, 'focusin', () => { focused.add(card); sync(); });
            listen(card, 'focusout', event => {
                if (card.contains(event.relatedTarget)) return;
                focused.delete(card); sync();
            });
        }
        listen(view, 'click', event => {
            const button = event.target.closest('[data-view]');
            if (!button) return;
            pinned = button.dataset.view === 'hover';
            view.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
            sync();
            options.touch?.();
        });
        return { sync, dispose() {
            for (const remove of listeners) remove();
            pointed.clear(); focused.clear(); pinned = false;
            sync();
        } };
    };

    /**
     * Build the preview into its mount and keep it in step. Returns the
     * handle the hub drives: refresh after a change, the Resting/Hover view,
     * the group spotlight, which sample the phone strip follows, and dispose.
     * @param {HTMLElement} mount - The preview column (#jeMthPreviewBody).
     * @param {{strip?: HTMLElement|null, touch?: () => void, source?: () => {settings: Object, plugin: Object}}} [options] - The
     *   phone strip's summary element, the panel's auto-close reset, and
     *   (the Media Tags admin tab) the settings and plugin configuration to
     *   draw instead of the signed-in user's.
     * @returns {{refresh: () => void, suspend: () => void, resume: () => void, setSpotlight: (group: string|null) => void, follow: (key: string) => void, dispose: () => void, root: HTMLElement}|null}
     */
    internal.createTagPreview = function(mount, options = {}) {
        const L = layoutApi();
        if (!L || !mount) return null;
        // The admin page (.je-tag-admin) shows the same preview outside the panel.
        JE.core.ui?.injectCss?.('je-tag-preview', (PREVIEW_CSS + spotlightCss(L.CONTAINER_CLASS)).replaceAll('#jellyfin-enhanced-panel ', ':is(#jellyfin-enhanced-panel, .je-tag-admin) '));
        const root = document.createElement('div');
        root.className = 'je-mtp';
        const head = document.createElement('div');
        head.className = 'je-mtp-head';
        const title = document.createElement('h4');
        title.className = 'je-mtp-title';
        title.id = 'jeMtpTitle';
        title.textContent = JE.t('panel_media_tags_preview');
        const view = document.createElement('div');
        view.className = 'je-mtp-view';
        view.setAttribute('role', 'group');
        view.setAttribute('aria-label', JE.t('panel_media_tags_preview_view'));
        for (const [mode, key] of [['rest', 'panel_settings_ui_tag_editor_preview_resting'], ['hover', 'panel_settings_ui_tag_editor_preview_hover']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.view = mode;
            b.setAttribute('aria-pressed', String(mode === 'rest'));
            b.textContent = JE.t(key);
            view.appendChild(b);
        }
        head.append(title, view);
        const grid = document.createElement('div');
        grid.className = 'je-mtp-samples';
        const figures = SAMPLES.map((sample) => buildSample(sample));
        grid.append(...figures);
        const foot = document.createElement('div');
        foot.className = 'je-mtp-foot';
        const note = document.createElement('p');
        note.className = 'je-mtp-note';
        note.hidden = true;
        note.textContent = JE.t('panel_media_tags_preview_hover_hidden');
        root.append(head, grid, foot, note);
        root.setAttribute('aria-labelledby', title.id);
        mount.replaceChildren(root);

        let disposed = false;
        let suspended = false;
        const styleOwner = {};
        let queued = false;
        let followKey = 'movie';
        const interaction = internal.bindTagPreviewInteraction(figures.map(figure => figure.querySelector('.je-mtp-card')), view, {
            change: active => withSource(() => { note.hidden = !(active && JE.currentSettings?.tagsHideOnHover); }),
            touch: options.touch,
        });
        /** @type {Map<string, {figure: HTMLElement, card: HTMLElement, target: HTMLElement, look: string, source: string}>} */
        const drawn = new Map();

        /**
         * Run with options.source's settings and configuration standing in for
         * the signed-in user's (synchronously, so nothing else sees them).
         * @param {() => void} fn
         */
        const withSource = (fn) => {
            if (!options.source) { fn(); return; }
            const saved = [JE.currentSettings, JE.pluginConfig];
            const { settings, plugin } = options.source();
            JE.currentSettings = settings;
            JE.pluginConfig = plugin;
            L.invalidateSettings();
            try { fn(); } finally {
                JE.currentSettings = saved[0];
                JE.pluginConfig = saved[1];
                L.invalidateSettings();
            }
        };

        /** Re-feed and re-present every sample, then rewrite the labels and the strip. */
        const draw = () => withSource(drawSamples);
        const drawSamples = () => {
            if (disposed || suspended || !root.isConnected) return;
            // This runs inside withSource: admin drafts and hub settings each
            // load their own enabled groups, without activating any renderer.
            JE.core.tagRenderer?.ensureStyles?.(JE.currentSettings, styleOwner);
            L.invalidateSettings();
            root.dataset.jeHideOnHover = String(!!JE.currentSettings?.tagsHideOnHover);
            SAMPLES.forEach((sample, i) => {
                const figure = figures[i];
                const card = /** @type {HTMLElement} */ (figure.querySelector('.je-mtp-card'));
                const target = /** @type {HTMLElement} */ (card.querySelector('.je-mtp-scalable'));
                const { id, type, entry } = sampleFacts(sample);
                card.dataset.id = id;
                card.dataset.type = type;
                const host = L.ensureHost(target);
                L.setCardContext(target, entry, id);
                for (const group of GROUP_IDS) {
                    // The sample's own type decides "Where to show", as it does on a real card.
                    const wrap = JE.currentSettings?.[ENABLED[group]] && !JE.core.tagScopes?.excludes(group, card) ? sampleGroup(sample, group) : null;
                    if (wrap) L.commitGroup(target, group, wrap);
                    else L.removeGroup(target, group);
                }
                L.refreshPresentation(target);
                const conf = L.resolveLayout(host);
                const source = L.lookSource(host);
                const look = JE.t('tag_looks_outcome', { layout: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[conf.layout]), density: JE.t(conf.density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full') });
                const sourceText = source.source === 'lock' ? JE.t('panel_media_tags_preview_source_lock')
                    : source.source === 'override' ? JE.t('panel_media_tags_preview_source_override')
                    : source.source === 'rule' ? JE.t('panel_media_tags_preview_source_rule', { n: source.index + 1 })
                    : source.source === 'shape' ? JE.t('tag_shapes_preview_source', { shape: JE.t(`tag_shapes_${source.shape}`) })
                    : JE.t('common_default');
                const meta = /** @type {HTMLElement} */ (figure.querySelector('.je-mtp-meta'));
                const typeLabel = JE.t(JE.core.tagLayout.VOCABULARY_KEYS.type[type.toLowerCase()]);
                const strong = document.createElement('strong');
                strong.dataset.source = source.source;
                strong.textContent = source.source === 'lock' ? `🔒 ${sourceText}` : sourceText;
                const lookLine = document.createElement('span');
                lookLine.className = 'je-mtp-look';
                lookLine.textContent = look;
                meta.replaceChildren(document.createTextNode(`${typeLabel} · `), strong, lookLine);
                drawn.set(sample.key, { figure, card, target, look, source: sourceText });
            });
            const base = L.normalizeSettings();
            const preset = JE.pluginConfig?.TagStylesAllowUserPreset && JE.currentSettings?.tagStylePreset
                ? JE.t(JE.core.tagLayout.VOCABULARY_KEYS.preset[JE.currentSettings.tagStylePreset]) : null;
            const defaultLook = JE.t('tag_looks_outcome', { layout: JE.t(JE.core.tagLayout.VOCABULARY_KEYS.layout[base.layout]), density: JE.t(base.density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full') });
            const strong = document.createElement('strong');
            strong.textContent = preset ? `${defaultLook} · ${preset}` : defaultLook;
            // The admin page's preview (drawn from a seeded new user) speaks of the new-user default, not the viewer's own.
            const forNewUsers = !!options.source;
            const line = document.createElement('p');
            line.append(document.createTextNode(`${JE.t(forNewUsers ? 'admin_tags_preview_default' : 'panel_media_tags_preview_default')} `), strong,
                document.createTextNode(forNewUsers ? `. ${JE.t('admin_tags_preview_existing')}.` : '.'));
            if (forNewUsers) foot.replaceChildren(line);
            else {
                // How a card's look is chosen: on request, so the preview stays short.
                const why = document.createElement('details');
                why.className = 'je-mtp-why';
                // Help text, not settings: an informational disclosure (the settings guards allow it).
                why.dataset.jeInfo = '';
                why.open = foot.querySelector('.je-mtp-why')?.hasAttribute('open') || false;
                const summary = document.createElement('summary');
                summary.textContent = JE.t('panel_media_tags_preview_why');
                const text = document.createElement('p');
                text.textContent = JE.t('panel_media_tags_preview_precedence');
                why.append(summary, text);
                foot.replaceChildren(line, why);
            }
            interaction.sync();
            drawStrip();
        };

        /**
         * The phone strip: a small copy of the followed sample and one line
         * naming it, its source and look, with its chips (the edited group's first).
         */
        const drawStrip = () => {
            const strip = options.strip;
            const item = drawn.get(followKey);
            if (!strip || !item) return;
            const thumb = /** @type {HTMLElement|null} */ (strip.querySelector('.je-mth-strip-thumb'));
            const text = /** @type {HTMLElement|null} */ (strip.querySelector('.je-mth-strip-text'));
            const chips = /** @type {HTMLElement|null} */ (strip.querySelector('.je-mth-strip-chips'));
            if (thumb) {
                // A small drawing of where each group sits, never a copy of the
                // card: a copied .je-tag-host would be picked up by the layout
                // controller on the next re-present.
                thumb.dataset.shape = item.card.dataset.jeShape === 'portrait' ? 'poster' : 'thumb';
                const marks = [];
                const perSlot = new Map();
                for (const placed of L.describe(item.target)) {
                    if (placed.slot === 'off' || placed.slot === 'hover') continue;
                    const n = perSlot.get(placed.slot) || 0;
                    perSlot.set(placed.slot, n + 1);
                    const mark = document.createElement('i');
                    mark.dataset.slot = placed.slot;
                    mark.dataset.group = placed.group;
                    mark.style.setProperty('--je-mtp-n', String(n));
                    marks.push(mark);
                }
                thumb.dataset.layout = item.card.querySelector('.je-tag-host')?.getAttribute('data-je-layout') || '';
                thumb.replaceChildren(...marks);
            }
            const sample = SAMPLES.find((s) => s.key === followKey);
            // First line: which sample and its look; second: where the look comes from, then its tags.
            // First line: the look itself. Second: the sample, then the tags of the group being edited
            // (spotlighted) or, with none, where the sample's look comes from.
            if (text && sample) text.textContent = JE.t('panel_media_tags_preview_summary', { title: JE.t(sample.titleKey), source: item.source, look: item.look });
            if (chips && sample) {
                const spot = root.dataset.spot || null;
                const all = spot ? chipTexts(item.card, spot) : [];
                const shown = all.slice(0, 4);
                const more = all.length - shown.length;
                chips.textContent = `${JE.t(sample.titleKey)} · ${shown.length ? shown.join(' · ') + (more > 0 ? ` +${more}` : '') : item.source}`;
            }
        };

        /** Redraw after the current event's handlers ran (a burst of changes draws once). */
        const refresh = () => {
            if (queued || disposed || suspended) return;
            queued = true;
            Promise.resolve().then(() => {
                queued = false;
                draw();
            });
        };

        // Cards re-present on every layout reinitialisation (a rule saved, a
        // lock removed, a reset): redraw the labels and the strip with them.
        document.addEventListener('je:tag-layout-changed', refresh);
        draw();

        /** Tear the preview down: drop the cards' controllers and ignore queued redraws. */
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            interaction.dispose();
            JE.core.tagRenderer?.releaseStyles?.(styleOwner);
            document.removeEventListener('je:tag-layout-changed', refresh);
            // Clear the cards while they are still in the document, then drop them.
            for (const figure of figures) {
                const target = figure.querySelector('.je-mtp-scalable');
                if (target) L.clearCard(target);
            }
            root.remove();
            options.strip?.querySelector('.je-mth-strip-thumb')?.replaceChildren();
            drawn.clear();
        };

        return {
            root,
            refresh,
            suspend() {
                suspended = true;
                JE.core.tagRenderer?.releaseStyles?.(styleOwner);
            },
            resume() {
                if (disposed) return;
                suspended = false;
                draw();
            },
            /** @param {string|null} group - Outline this group's chips (null: none). */
            setSpotlight(group) {
                if (group) root.dataset.spot = group;
                else delete root.dataset.spot;
                drawStrip();
            },
            /** @param {string} key - The sample the phone strip shows ('movie', 'series', 'episode', 'list'). */
            follow(key) {
                if (!SAMPLES.some((s) => s.key === key) || key === followKey) return;
                followKey = key;
                drawStrip();
            },
            dispose,
        };
    };

    // Exposed for tests.
    internal.tagPreviewData = { SAMPLES, sampleFacts, chipTexts };
})(window.JellyfinEnhanced);
