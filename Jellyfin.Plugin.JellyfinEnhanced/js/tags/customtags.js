// /js/tags/customtags.js
// Custom Tags - poster chips from the administrator's rules (Configuration >
// Tags > Custom tags): a Jellyfin tag ("4K Remaster") or a collection
// ("Criterion") an item carries becomes a chip with the rule's label and
// optional icon. A spec over the core tag-renderer factory
// (js/core/tag-renderer-base.js); this module supplies only reading the
// matched rule ids, the chip markup and its stylesheet.
//
// The server decides which rules an item matches (TagCacheService
// CustomTags, the same ids on /tag-data): the tag cache matches tags and
// collections; with the tag cache off, /tag-data matches tags only.
// Collection matches only reach users who can access the collection. Each
// rule has an opaque id derived from its match type and value
// ("collection:3f9a…"), so a label, icon or colour edit applies at once;
// ids of rules that no longer exist are ignored. The public configuration
// carries ids, labels and icons only: what a rule matches (the tooltip's
// second line) is in the admin-only private configuration. Spoiler Guard's
// tag strip removes the matches server side, like genres; the batch
// fallback's copies are stamped with that strip's revision and drawn only
// while it is unchanged, and kept across page loads only while nothing is
// stripped (see getCachedEntry).
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Custom Tags:';
    const containerClass = 'custom-overlay-container';
    const tagClass = 'custom-tag';
    /** The tag strip revision of a user Spoiler Guard strips nothing for (SpoilerTagDataStripper.NoTagStrip). */


    /**
     * Icons a rule may show: the genre icons the bundled Material Symbols
     * Outlined subset carries (tags/genretags.js genreIconMap), so every one
     * renders as a glyph. The server accepts the same list
     * (CustomTagRuleSet.Icons).
     */
    const ICONS = ['theaters', 'sports_martial_arts', 'explore', 'animation', 'mood', 'local_police', 'article', 'theater_comedy',
        'family_restroom', 'auto_awesome', 'history_edu', 'skull', 'music_note', 'psychology_alt', 'favorite', 'science', 'tv',
        'psychology', 'military_tech', 'landscape', 'domino_mask', 'music_video', 'menu_book', 'sports_soccer', 'quiz', 'live_tv'];

    /**
     * Read a key in either the client's camelCase or the server's PascalCase.
     * @param {*} obj
     * @param {string} key - camelCase key.
     * @returns {*}
     */
    function pick(obj, key) {
        if (!obj || typeof obj !== 'object') return undefined;
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
        const pascal = key.charAt(0).toUpperCase() + key.slice(1);
        return obj[pascal] ?? undefined;
    }

    /**
     * @typedef {Object} CustomTagRule
     * @property {string} id - The server's opaque rule id ("tag:…" or "collection:…").
     * @property {string} label - The chip text (also its Tag Styles label).
     * @property {string|null} icon - A Material Symbols name from ICONS, or null.
     * @property {string|null} match - "tag" or "collection" (administrators only, else null).
     * @property {string|null} value - The tag or collection name (administrators only, else null).
     */

    /** @type {{source: *, sources: *, rules: Map<string, CustomTagRule>, key: string}|null} */
    let rulesMemo = null;

    /**
     * The administrator's rules (public configuration, already normalised by
     * the server) by id, in table order, memoised per configuration object.
     * What each rule matches comes from the private configuration, which only
     * administrators receive (CustomTagRuleSources).
     * @returns {{rules: Map<string, CustomTagRule>, key: string}}
     */
    function currentRules() {
        const source = JE.pluginConfig?.CustomTagRules;
        const sources = JE.pluginConfig?.CustomTagRuleSources;
        if (rulesMemo && rulesMemo.source === source && rulesMemo.sources === sources) return rulesMemo;
        /** @type {Map<string, {match: string, value: string}>} */
        const matches = new Map();
        for (const raw of Array.isArray(sources) ? sources : []) {
            const id = String(pick(raw, 'id') || '');
            const match = String(pick(raw, 'match') || '').toLowerCase();
            const value = String(pick(raw, 'value') || '').trim();
            if (id && (match === 'tag' || match === 'collection') && value) matches.set(id, { match, value });
        }
        /** @type {Map<string, CustomTagRule>} */
        const rules = new Map();
        for (const raw of Array.isArray(source) ? source : []) {
            const id = String(pick(raw, 'id') || '');
            const label = String(pick(raw, 'label') || '').trim();
            if (!id || !label || rules.has(id)) continue;
            const icon = String(pick(raw, 'icon') || '').toLowerCase();
            const from = matches.get(id);
            rules.set(id, { id, label, icon: ICONS.includes(icon) ? icon : null, match: from?.match ?? null, value: from?.value ?? null });
        }
        // What the persisted per-item matches were computed under (see setCachedEntry).
        const key = [...rules.keys()].sort().join('\n');
        rulesMemo = { source, sources, rules, key };
        return rulesMemo;
    }

    /**
     * The rules an item matched, in the current rule table order: the ids
     * are a set (stored entries keep the order of when they were matched,
     * so a reorder needs no re-match), and ids no rule has any more are
     * skipped. Native posters resolve the same way
     * (PosterTagResolver.ResolveCustom).
     * @param {*} ids - CustomTags from the tag cache entry or /tag-data.
     * @returns {CustomTagRule[]}
     */
    function rulesFor(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const matched = new Set(ids.map(String));
        const out = [];
        for (const [id, rule] of currentRules().rules) {
            if (matched.has(id)) out.push(rule);
        }
        return out;
    }

    /**
     * The tooltip of a chip: its label and, for administrators (who know
     * what the rule matches), a second line saying where it comes from.
     * @param {CustomTagRule} rule
     * @returns {string}
     */
    function titleOf(rule) {
        if (!rule.match || !rule.value) return rule.label;
        const source = JE.t(rule.match === 'collection' ? 'custom_tags_source_collection' : 'custom_tags_source_tag', { name: rule.value });
        return `${rule.label}\n${source}`;
    }

    /**
     * One chip, as every Custom chip is drawn (the settings panel's preview
     * builds its samples with it too).
     * @param {CustomTagRule} rule
     * @returns {HTMLElement}
     */
    function buildChip(rule) {
        const tag = document.createElement('div');
        tag.className = rule.icon ? `${tagClass} ${tagClass}--icon` : tagClass;
        // Tag Styles colours a label through this attribute.
        tag.dataset.jeCustom = rule.label;
        tag.dataset.jeCustomRule = rule.id;
        tag.title = titleOf(rule);
        if (rule.icon) {
            const icon = document.createElement('span');
            icon.className = `${tagClass}-icon`;
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = rule.icon;
            tag.appendChild(icon);
        }
        const text = document.createElement('span');
        text.className = `${tagClass}-text`;
        text.textContent = rule.label;
        tag.appendChild(text);
        return tag;
    }

    /**
     * Create and commit the Custom chips for a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the overlay.
     * @param {*} ids - The matched rule ids.
     * @returns {void}
     */
    function applyCustomTags(ctx, el, ids) {
        const rules = rulesFor(ids);
        if (rules.length === 0) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;
        for (const rule of rules) container.appendChild(buildChip(rule));

        ctx.commitOverlay(el, container);
    }

    /**
     * Retrieve a cached entry: the item's matched ids, when they were matched
     * under the current rules (a rule added since may match it too) and the
     * current Spoiler Guard tag strip. Matches kept from an earlier page load
     * count only while nothing is stripped for the user, then and now: the
     * strip also follows watched state and collection membership, which no
     * revision covers. A copy from under another strip (or other rules) is
     * discarded, so the item is fetched again before anything is drawn.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {string[]|null} The ids, or null when unknown.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.hot?.get(itemId) ?? ctx.getPersistent(itemId);
        if (entry && entry.r === currentRules().key && Array.isArray(entry.ids)) return entry.ids;
        if (entry !== undefined) ctx.deletePersistent(itemId);
        return null;
    }

    /** Keep the rule identity inside the factory's shared strip envelope. */
    function setCachedEntry(ctx, itemId, ids) {
        ctx.setPersistent(itemId, { ids: Array.isArray(ids) ? ids.map(String) : [],
            r: currentRules().key, timestamp: Date.now() });
    }

    /** @type {Object} Factory spec - everything Custom-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'customTagsEnabled',
        containerClass,
        taggedAttr: 'jeCustomTagged',
        styleId: 'jellyfin-enhanced-custom-tags-css',
        position: { userKey: 'customTagsPosition', pluginKey: 'CustomTagsPosition', fallback: 'top-left' },
        cache: {
            key: 'JellyfinEnhanced-customTagsCache',
            legacyPrefix: 'customTagsCache',
            hotBucket: 'custom',
            pruneOnSave: true,
            saveOnUnload: false,
        },
        buildCss() {
            // Placement comes from the layout stylesheet (tags/tag-layout-styles.js);
            // the rules after the chip's own only size it in the other layouts' slots.
            return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }
                .je-tag-slot > .${containerClass} { max-width: 100%; }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3em;
                    box-sizing: border-box;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    background-color: rgba(38, 50, 56, 0.88);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    border-radius: 4px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 600;
                    line-height: 1.15;
                    letter-spacing: 0.01em;
                    text-transform: none;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                    pointer-events: none;
                }
                .${tagClass}-text { overflow: hidden; text-overflow: ellipsis; }
                .${tagClass}-icon {
                    font-family: 'JE Material Symbols Outlined';
                    font-weight: normal;
                    font-style: normal;
                    font-size: 1.2em;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    flex-shrink: 0;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }

                /* Card-width sizing, matching the age rating and status chips. */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                    }
                }
                .layout-mobile .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(11px * var(--je-tag-scale, 1)); border-radius: 3px; }
                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }
                @media (max-width: 480px) {
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }

                /* Caption strip and the minimal corner: the other chips' smaller size. */
                .je-tag-caption .${tagClass} {
                    font-size: calc(clamp(9px, 6.4cqw, 11.5px) * var(--je-tag-scale, 1));
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                    box-shadow: none;
                }
                html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .${tagClass} { font-size: calc(11px * var(--je-tag-scale, 1)); padding: calc(2px * var(--je-tag-scale, 1)) calc(5px * var(--je-tag-scale, 1)); }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;
                setCachedEntry(ctx, item.Id, item.CustomTags);
                applyCustomTags(ctx, el, item.CustomTags);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const ids = getCachedEntry(ctx, itemId);
                if (!ids) return false;
                applyCustomTags(ctx, el, ids);
                // No match is still a cache hit: nothing to fetch.
                return true;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                applyCustomTags(ctx, el, entry.CustomTags);
            },
            // The fallback copies were filtered for this user like the server
            // cache: when that is replaced (access or Spoiler Guard changed, a
            // rebuild) they go too, and a delta drops the items it carries.
            // A tag strip changed elsewhere is caught by the stamp instead.
            onServerCacheRefresh(ctx, updatedIds) {
                if (!updatedIds) {
                    ctx.clearPersistent();
                    ctx.hot?.clear();
                    return;
                }
                for (const id of updatedIds) {
                    ctx.deletePersistent(String(id));
                    ctx.hot?.delete(String(id));
                }
            },
        },
    };

    JE.initializeCustomTags = function() {
        console.log(`${logPrefix} Starting...`);
        const ctx = JE.core.tagRenderer.register('custom', spec);
        ctx.injectCss();
        console.log(`${logPrefix} Initialized successfully.`);
    };

    JE.reinitializeCustomTags = function() {
        rulesMemo = null;
        JE.core.tagRenderer.reinitialize('custom', spec);
    };

    JE.customTags = { ICONS, rulesFor, currentRules, buildChip };

})(window.JellyfinEnhanced);
