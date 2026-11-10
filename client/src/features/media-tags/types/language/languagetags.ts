import type { TagRuntimeBridge } from '../../host';
import { isRecord, type JsonRecord, memberRecord, members, memberText, record } from '../../pipeline/dto';
import type { TagCtx, TagSpec } from '../../pipeline/contract';

interface LanguageFact { name?: string | null; code: string; partial?: boolean; sdh?: boolean }
interface NormalLanguage { name: string; code: string; partial?: boolean; sdh?: boolean }
/** What a language named after an Object.prototype member resolves to: no flag, one token per name. */
interface UnrenderableFlag { unrenderable: string }
interface LanguageChip {
    countryCode: string | null | undefined | UnrenderableFlag;
    asCode: boolean;
    code: string;
    text: string;
    partial: boolean;
    sdh: boolean;
    allCodes: string[];
    allLanguages: string[];
    labels: string[];
    subtitle?: boolean;
    badge?: undefined;
}
interface BadgeChip { badge: 'dual' | 'multi'; subtitle?: undefined; partial?: undefined; asCode?: undefined }
function isImage(element: HTMLElement): element is HTMLImageElement { return element.tagName === 'IMG'; }
export interface LanguageData { audio?: unknown; subtitles?: unknown }
export interface LanguageDisplay { audio: boolean; subtitles: boolean; style: 'codes' | 'flags'; badge: string }
export interface LanguageTagsApi {
    readSettings(): LanguageDisplay;
    buildGroup(languages: unknown, cap?: number, flagSource?: (code: string) => string): HTMLElement;
}
// /js/tags/languagetags.js
// Jellyfin Language Flags Overlay — a spec over the core tag-renderer factory
// (js/core/tag-renderer-base.js), which owns the cache/ignore/tagged/CSS/
// reinitialize plumbing. This module supplies only the language-specific
// parts: the language→country map, audio-stream extraction and flag markup.
export function createLanguageTags(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Language Tags:';
    const containerClass = 'language-overlay-container';
    const flagClass = 'language-flag';
    // Series/Season flag for a language that only some episodes carry (#557).
    const partialFlagClass = 'language-flag-partial';
    const langDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    /** language code → display name; an Intl lookup per flag per card adds up */
    const displayNameByCode: Map<string, string> = new Map();

    /**
     * English display name of a language code (the code upper-cased when Intl
     * has no name for it), memoised per code.
     * */
    function displayName(code: string): string {
        let name = displayNameByCode.get(code);
        if (name === undefined) {
            try {
                name = langDisplayNames.of(code) || code.toUpperCase();
            } catch (e) {
                name = code.toUpperCase();
            }
            displayNameByCode.set(code, name);
        }
        return name;
    }
    // Flag resolution lives in the shared core module (js/core/media-language.js)
    // so this overlay and the details-page audio-language row can never disagree.
    // It understands region subtags: pt-BR → Brazilian flag, es-419 → Mexican,
    // zh-Hant → Taiwanese — while a bare pt/es/zh keeps its default flag.

    /**
     * Extracts languages of one track type from a Jellyfin item's media sources.
     * @param sourceItem - The item (or first episode) to extract languages from.
     * @param [type='Audio'] - Audio or Subtitle.
     * @returns Normalized array of language objects.
     */
    function extractLanguagesFromItem(sourceItem: JsonRecord | null | undefined, type: string = 'Audio'): NormalLanguage[] {
        if (!sourceItem) return [];
        const languages = new Set<string>();

        // Process audio streams from a flat list
        const processStreams = function(streams: unknown) {
            // Commentary/description audio and forced subtitles are not language options.
            members(streams).map(memberRecord).filter(function(s) { return s.Type === type && !(type === 'Audio' ? JE.core.mediaLanguage.isSecondaryAudio(s) : s.IsForced === true); }).forEach(function(stream) {
                const langCode = stream.Language;
                if (typeof langCode === 'string' && langCode && !JE.core.mediaLanguage.isLanguageless(langCode)) {
                    languages.add(JSON.stringify({ name: displayName(langCode), code: langCode, sdh: type === 'Subtitle' && (stream.IsHearingImpaired === true || /\b(SDH|CC)\b/i.test(`${String(stream.Title || '')} ${String(stream.DisplayTitle || '')}`)) }));
                }
            });
        };

        // Handle both formats: nested MediaSources[].MediaStreams[] and flat MediaStreams[]
        members(sourceItem.MediaSources).forEach(function(source) {
            processStreams(memberRecord(source).MediaStreams);
        });
        processStreams(sourceItem.MediaStreams);

        return normalizeLanguages(Array.from(languages, (fact): unknown => JSON.parse(fact)));
    }

    /** Merge batch language arrays with accessibility on the already-projected streams. */
    function subtitleFacts(sourceItem: JsonRecord, item: JsonRecord): readonly unknown[] {
        const tracks = extractLanguagesFromItem(sourceItem, 'Subtitle');
        const codes = sourceItem.SubtitleLanguages || item.SubtitleLanguages;
        if (!codes) return tracks;
        const sdh = members(sourceItem.SdhSubtitleLanguages || item.SdhSubtitleLanguages || tracks.filter(track => track.sdh).map(track => track.code));
        return members(codes).map(code => ({ code, sdh: sdh.some(track => JE.core.mediaLanguage.matchesLanguage(code, track, { requireRegion: true })) }));
    }

    // Normalize different shapes of language arrays into [{ name, code, partial }]
    // and de-duplicate. `partial` marks a language a Series/Season only carries
    // on some episodes; it is only ever set by the server cache path.
    function normalizeLanguages(languages: unknown): NormalLanguage[] {
        if (!Array.isArray(languages)) return [];
        const norm: NormalLanguage[] = [];
        const seen = new Set<string>();
        for (const entry of languages) {
            let obj: NormalLanguage | null = null;
            if (!entry) continue;
            if (typeof entry === 'string') {
                // Handle legacy cache that stored ["en", "fr", ...]. Keep the
                // full tag — a region subtag (pt-BR) is meaningful and must
                // survive normalization so the region flag can render.
                const code = entry.toLowerCase();
                obj = { name: displayName(code), code };
            } else if (isRecord(entry)) {
                // Same here: never strip the region from the code.
                const code = String(entry.code || entry.Code || '');
                const name = String(entry.name || entry.Name || '') || null;
                if (code) {
                    obj = { name: name || displayName(code), code };
                    // Only the server cache path sets it, so the localStorage
                    // cache (legacy per-page mode) never carries the field.
                    if (entry.partial) obj.partial = true;
                    if (entry.sdh) obj.sdh = true;
                }
            }
            if (!obj) continue;
            const key = `${obj.code.toLowerCase()}|${(obj.name || '').toLowerCase()}`;
            if (!seen.has(key)) { seen.add(key); norm.push(obj); }
            else if (obj.sdh) {
                const same = norm.find(lang => `${lang.code.toLowerCase()}|${(lang.name || '').toLowerCase()}` === key);
                if (same) same.sdh = true;
            }
        }
        return norm;
    }

    /**
     * Tooltip line for one language: the display name, suffixed for a language
     * that is only on some of a Series/Season's episodes.
     * */
    function languageLabel(lang: { name: string; code?: string; partial?: boolean | undefined }): string {
        // Shown in the user's language; matching keeps the English name.
        const name = (lang.code && JE.core.mediaLanguage?.localName?.(lang.code)) || lang.name;
        return lang.partial ? `${name} (${JE.t('language_tags_partial_tooltip')})` : name;
    }

    /**
     * Apply the effective priority list to grouped language chips. Personal ISO
     * codes match every represented language through the shared equivalences.
     * Server policy matches a chip by language code (en, pt-BR), its base code
     * (pt), or its display name (English, Portuguese), whichever the admin
     * typed. Codes also compare the way the audio-language filter does
     * (`matchesLanguage`): `en` matches a track tagged `eng`, `en-US` or
     * `en-GB`, and `pt-BR` still matches a bare `pt`, so a library that
     * mixes two- and three-letter tags (Jellyfin's own probe writes `eng`,
     * a Matroska IETF tag writes `en`) ranks every English track the same (#993).
     * Every code behind a chip counts, not just the first one: Hindi and
     * Telugu share India's flag, and `te` in the list must still find it.
     * Order among matched and unmatched chips stays stable.
     * */
    function orderByPriority(flags: LanguageChip[]): LanguageChip[] {
        const policy = JE.core.mediaLanguage.priorityPolicy();
        const priority = policy.terms;
        if (!priority.length) return flags;
        const matchesLanguage = JE.core.mediaLanguage.matchesLanguage;
        const rank = (flag: LanguageChip) => {
            const code = (flag.code || '').toLowerCase();
            const candidates = policy.personal
                ? flag.allCodes.map(c => baseOf(c))
                : [code, code.split('-')[0], ...flag.allLanguages.map(n => n.toLowerCase())];
            // Server terms also compare like the audio-language filter, over every code behind the chip.
            const codes = policy.personal ? [] : flag.allCodes;
            let best = -1;
            for (let idx = 0; idx < priority.length; idx++) {
                if (best !== -1 && idx >= best) break;
                const term = priority[idx];
                if (candidates.includes(term) || codes.some(c => matchesLanguage(c, term))) best = idx;
            }
            return best;
        };
        return flags
            .map((flag, i) => ({ flag, i, rank: rank(flag) }))
            .filter(entry => !policy.strict || entry.rank !== -1)
            .sort((a, b) => {
                const ra = a.rank === -1 ? priority.length : a.rank;
                const rb = b.rank === -1 ? priority.length : b.rank;
                return ra - rb || a.i - b.i;
            })
            .map(entry => entry.flag);
    }

    /** Effective display settings: user override, admin default, built-in default. */
    function readSettings(): LanguageDisplay {
        const value = (key: string, fallback: unknown): unknown => JE.currentSettings?.[key] ?? JE.pluginConfig?.[key.charAt(0).toUpperCase() + key.slice(1)] ?? fallback;
        const style = String(value('languageTagsStyle', 'flags')).trim().toLowerCase();
        const badge = String(value('languageTagsCountBadge', 'off')).trim().toLowerCase();
        return {
            audio: value('languageTagsShowAudio', true) !== false,
            subtitles: value('languageTagsShowSubtitles', false) === true,
            style: style === 'codes' ? 'codes' : 'flags',
            badge: ['only', 'both'].includes(badge) ? badge : 'off',
        };
    }

    /**
     * Deduplicated chips for one track type, full coverage first, then personal/server priority.
     * Flags preserve country grouping; codes group canonical languages, retaining
     * explicit regions unless the administrator merges regional variants. A
     * language without a flag keeps a code chip in Flags style rather than vanishing.
     * */
    /** The canonical language behind one code. */
    function baseOf(code: string): string {
        return JE.core.mediaLanguage.canonicalBase(JE.core.mediaLanguage.parseLanguageTag(code)?.base ?? '');
    }

    /**
     * A language's flag. resolveFlag refuses a name or code that is an Object.prototype member, but a group showing one
     * still draws nothing: buildGroup's invalid-flag guard answers to this token, and native posters follow the same
     * rule, name before code (LanguageFlagRules.LookupName).
     */
    function flagOf(lang: NormalLanguage): LanguageChip['countryCode'] {
        const flag = JE.core.mediaLanguage.resolveFlag(lang);
        if (flag != null) return flag;
        const inherited = [lang.name, lang.code].find(key => key in Object.prototype);
        return inherited === undefined ? flag : { unrenderable: inherited };
    }

    function resolveChips(languages: unknown, style: string): LanguageChip[] {
        const unique = new Map<string, LanguageChip>();
        for (const lang of normalizeLanguages(languages)) {
            const countryCode = flagOf(lang);
            const code = JE.core.mediaLanguage.displayCode(lang.code);
            const parsed = JE.core.mediaLanguage.parseLanguageTag(lang.code);
            const asCode = style === 'codes' || countryCode == null;
            const key = asCode ? 'code:' + JE.core.mediaLanguage.canonicalBase(parsed?.base ?? '') + (JE.pluginConfig?.LanguageTagsMergeRegions ? '' : ':' + (parsed?.region || parsed?.script || '')) : typeof countryCode === 'object' && countryCode ? `unrenderable:${countryCode.unrenderable}` : countryCode;
            if (!key || (asCode && !code)) continue;
            const name = lang.name || lang.code.toUpperCase();
            const existing = unique.get(key);
            if (!existing) unique.set(key, { countryCode, asCode, code: lang.code, text: code, partial: !!lang.partial, sdh: !!lang.sdh, allCodes: [lang.code], allLanguages: [name], labels: [languageLabel({ name, code: lang.code, partial: lang.partial })] });
            else {
                existing.partial = existing.partial && !!lang.partial;
                existing.sdh ||= !!lang.sdh;
                if (!existing.allCodes.includes(lang.code)) existing.allCodes.push(lang.code);
                if (!existing.allLanguages.includes(name)) existing.allLanguages.push(name);
                const label = languageLabel({ name, code: lang.code, partial: lang.partial });
                if (!existing.labels.includes(label)) existing.labels.push(label);
            }
        }
        return orderByPriority(Array.from(unique.values()).sort((a, b) => Number(a.partial) - Number(b.partial)));
    }

    /**
     * Build the real language group, also used by the hub preview. The layout
     * applies the combined cap to its children: badge, audio, then subtitles.
     * @param languages - Legacy audio array or {audio, subtitles}.
     * @param [cap] - Used only to preserve the invalid-flag guard.
     * @param [flagSource] - Preview's inline flag source.
     * */
    function buildGroup(languages: unknown, cap: number = 3, flagSource: (code: string) => string = JE.core.mediaLanguage.flagSrc): HTMLElement {
        const data: LanguageData = Array.isArray(languages) ? { audio: languages } : record(languages);
        const conf = readSettings();
        const audio = conf.audio ? resolveChips(data.audio, conf.style) : [];
        const subtitles = conf.subtitles ? resolveChips(data.subtitles, conf.style) : [];
        // Count languages rather than countries: Hindi and Tamil share a flag.
        const counted = conf.audio && conf.badge !== 'off' ? resolveChips(data.audio, 'codes')
            .filter(chip => baseOf(chip.code) !== 'zxx') : [];
        const count = new Set(counted.map(chip => baseOf(chip.code))).size;
        const badge = conf.badge !== 'off' && count >= 2;
        const chips: Array<LanguageChip | BadgeChip> = [];
        if (badge) chips.push({ badge: count === 2 ? 'dual' : 'multi' });
        if (!badge || conf.badge !== 'only') chips.push(...audio);
        chips.push(...subtitles.map(chip => ({ ...chip, subtitle: true })));
        const wrap = document.createElement('div');
        wrap.className = containerClass;
        const visible = cap > 0 ? chips.slice(0, cap) : chips;
        if (visible.some(chip => !chip.badge && !chip.asCode && typeof chip.countryCode !== 'string')) return wrap;
        for (const info of chips) {
            if (!info.badge && !info.asCode && typeof info.countryCode !== 'string') continue;
            const asCode = !info.badge && info.asCode;
            const chip: HTMLElement = document.createElement(info.badge || info.subtitle || asCode ? 'span' : 'img');
            chip.className = info.badge ? 'language-count-badge language-chip' : asCode ? 'language-code language-chip' : info.subtitle ? 'language-subtitle language-chip' : flagClass;
            if (info.partial) { chip.classList.add(partialFlagClass); chip.dataset.partial = 'true'; }
            chip.dataset.jeLanguage = info.badge ? 'countBadge' : info.subtitle ? 'subtitles' : 'flag';
            if (chip.tagName !== 'IMG') chip.dataset.jeLanguageLabel = info.badge || info.text.toLowerCase();
            if (info.badge) {
                chip.textContent = JE.t(JE.core.tagLayout?.VOCABULARY_KEYS.language[`${info.badge}`] ?? '');
                chip.title = `${JE.t('language_tags_count_tooltip', { count })}: ${counted.flatMap(chip => chip.labels).join(', ')}`;
            } else {
                const label = info.labels.join(', ');
                chip.title = `${JE.t(info.subtitle ? info.sdh ? 'language_tags_subtitles_sdh' : 'jellyseerr_report_issue_type_subtitles' : 'jellyseerr_report_issue_type_audio')}: ${label}`;
                chip.dataset.langName = info.allLanguages.join(', ');
                const flag = typeof info.countryCode === 'string' ? info.countryCode : '';
                chip.dataset.lang = asCode ? info.text.toLowerCase() : flag.toLowerCase();
                if (info.subtitle) {
                    const cc = document.createElement('span');
                    cc.className = 'language-cc';
                    cc.textContent = info.sdh ? 'SDH' : 'CC';
                    if (info.sdh) chip.dataset.jeSdh = 'true';
                    cc.setAttribute('aria-hidden', 'true');
                    chip.appendChild(cc);
                }
                if (asCode) chip.appendChild(document.createTextNode(info.text));
                else {
                    const img = isImage(chip) ? chip : document.createElement('img');
                    img.src = flagSource(flag);
                    img.className = info.subtitle ? flagClass : chip.className;
                    img.alt = chip.title;
                    img.loading = 'lazy';
                    img.onerror = () => chip.remove();
                    if (info.subtitle) chip.appendChild(img);
                }
            }
            if (chip.tagName !== 'IMG') chip.setAttribute('role', 'img');
            chip.setAttribute('aria-label', chip.title);
            wrap.appendChild(chip);
        }
        return wrap;
    }

    /** Attach the language group through the shared renderer/layout controller. */
    function insertLanguageTags(ctx: TagCtx, container: HTMLElement | null | undefined, languages: unknown): void {
        if (!container || ctx.isTagged(container)) return;
        ctx.removeExistingOverlay(container);
        if (container.style.position !== 'relative') container.style.position = 'relative';
        const cap = JE.core.tagLayout ? JE.core.tagLayout.resolveLayout(container).caps.language : 3;
        ctx.commitOverlay(container, buildGroup(languages, cap));
    }

    JE.core.languageTags = { readSettings, buildGroup };

    /** Factory spec — everything language-specific lives here. */
    const spec: TagSpec = {
        logPrefix,
        settingKey: 'languageTagsEnabled',
        containerClass,
        taggedAttr: 'jeLanguageTagged',
        styleId: 'language-tags-styles',
        position: { userKey: 'languageTagsPosition', pluginKey: 'LanguageTagsPosition', fallback: 'bottom-left' },
        cache: {
            // v3: entries keep both audio and subtitle facts. v2 kept region subtags instead of stripped
            // base codes; the old key is cleaned up via legacyPrefix so stale
            // stripped entries can't pin the wrong flag for the 30-day TTL.
            // Both prior generations are listed — dropping the ancient
            // un-namespaced stem would leave its keys orphaned forever.
            key: 'JellyfinEnhanced-languageTagsCache-v4',
            legacyPrefix: ['JellyfinEnhanced-languageTagsCache-v3', 'JellyfinEnhanced-languageTagsCache-v2', 'JellyfinEnhanced-languageTagsCache', 'languageTagsCache'],
            hotBucket: 'language',
        },
        buildCss() {
            return JE.core.tagRenderer.chipBaseCss('.language-chip') + JE.core.tagRenderer.chipBaseCss('.language-code:not([data-je-language="subtitles"])', true) + `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: hidden;
                }
                .${flagClass} {
                    width: calc(clamp(24px, 6vw, 32px) * var(--je-tag-scale, 1));
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    flex-shrink: 0;
                    object-fit: cover;
                }
                /* The host is otherwise below Jellyfin's full-card image link.
                   Its empty space remains pointer-transparent; only language
                   chips receive hover through native anchors supplied by the layout. */
                .je-tag-host:has(.${containerClass}) { z-index: 2; }
                .${containerClass} > * { pointer-events: auto; }
                .language-link { display: inline-flex; color: inherit; text-decoration: none; }
                .je-tag-pill[href] { pointer-events: auto; text-decoration: none; }
                .language-chip {
                    display: inline-flex; align-items: center; gap: calc(3px * var(--je-tag-scale, 1));
                    align-self: flex-start; flex-shrink: 0; width: max-content;
                    background: rgba(15,15,15,0.72); color: #fff;
                    font-family: inherit;
                }
                .language-cc { font-size: inherit; }
                .language-subtitle .language-flag { box-shadow: none; }
                /* Dub that doesn't cover every episode: dimmed, washed out and
                   dash-outlined so it reads as "incomplete" next to a full flag.
                   The dark ring keeps the white dashes (and a white flag's edge)
                   visible on light posters. */
                .${partialFlagClass} { opacity: 0.55; }
                img.${partialFlagClass} {
                    opacity: 0.55;
                    filter: saturate(0.5);
                    outline: 1px dashed rgba(255, 255, 255, 0.95);
                    outline-offset: -1px;
                    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
                }
                .layout-mobile .${flagClass} {
                    width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                @media (max-width: 768px) {
                    .${flagClass} {
                        width: calc(clamp(20px, 5vw, 26px) * var(--je-tag-scale, 1));
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${flagClass} {
                        width: calc(clamp(16px, 4vw, 20px) * var(--je-tag-scale, 1));
                    }
                    .${containerClass} {
                        gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: false,
            render(ctx: TagCtx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                // Skip cards hidden by hidden-content module
                if (el.closest('.je-hidden')) return;

                const itemId = String(item.Id);
                // Check hot cache first
                const hot = record(ctx.hot?.get(itemId));
                if (typeof hot.timestamp === 'number' && (Date.now() - hot.timestamp) < ctx.cacheTtl) {
                    if (hot.value) insertLanguageTags(ctx, el, hot.value);
                    return;
                }

                let sourceItem = item;
                if (item.Type === 'Series' || item.Type === 'Season') {
                    if (extras.firstEpisode) {
                        sourceItem = extras.firstEpisode;
                    } else {
                        return; // No first episode available, skip
                    }
                }

                const languages = { audio: extractLanguagesFromItem(sourceItem), subtitles: subtitleFacts(sourceItem, item) };

                {
                    ctx.setPersistent(itemId, languages);
                    ctx.hot?.set(itemId, { value: languages, timestamp: Date.now() });
                    insertLanguageTags(ctx, el, languages);
                }
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const hot = ctx.hot?.get(itemId);
                const cached = hot || ctx.getPersistent(itemId);
                if (cached) {
                    const entry = record(cached);
                    const languages = Array.isArray(cached) ? cached : (entry.value || entry.languages || cached);
                    if (languages && !Array.isArray(languages)) {
                        insertLanguageTags(ctx, el, languages);
                        return true;
                    }
                }
                return false;
            },
            renderFromServerCache(ctx: TagCtx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                const codes = members(entry.AudioLanguages);
                // Series/Season: AudioLanguages is the union over all episodes and
                // PartialAudioLanguages the ones missing from some of them.
                const partial = new Set(members(entry.PartialAudioLanguages));
                const languages = codes.map(function(member) {
                    const code = memberText(member);
                    return { name: displayName(code), code: code, partial: partial.has(code) };
                });
                const sdhCodes = members(entry.SdhSubtitleLanguages);
                insertLanguageTags(ctx, el, { audio: languages, subtitles: members(entry.SubtitleLanguages).map(code => ({ code, sdh: sdhCodes.some(sdh => JE.core.mediaLanguage.matchesLanguage(code, sdh, { requireRegion: true })) })) });
            },
        },
    };

    JE.initializeLanguageTags = function() {
        JE.core.tagRenderer.register('language', spec);
    };

    /**
     * Re-initializes the Language Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeLanguageTags = function() {
        JE.core.tagRenderer.reinitialize('language', spec);
    };

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);
}
