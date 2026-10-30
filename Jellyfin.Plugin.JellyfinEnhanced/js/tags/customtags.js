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
// collections; with the tag cache off, /tag-data matches tags only. Each
// rule is identified by its match type and value ("tag:4k remaster"), so a
// label, icon or colour edit applies at once; ids of rules that no longer
// exist are ignored. Spoiler Guard does not apply: the labels are the
// administrator's, not facts about the plot.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Custom Tags:';
    const containerClass = 'custom-overlay-container';
    const tagClass = 'custom-tag';

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
     * @property {string} id - "tag:<value>" or "collection:<value>", the value lower-cased.
     * @property {string} match - "tag" or "collection".
     * @property {string} value - The tag or collection name.
     * @property {string} label - The chip text (also its Tag Styles label).
     * @property {string|null} icon - A Material Symbols name from ICONS, or null.
     */

    /** @type {{source: *, rules: Map<string, CustomTagRule>, key: string}|null} */
    let rulesMemo = null;

    /**
     * The administrator's rules (public configuration, already normalised by
     * the server) by id, memoised per configuration object.
     * @returns {{rules: Map<string, CustomTagRule>, key: string}}
     */
    function currentRules() {
        const source = JE.pluginConfig?.CustomTagRules;
        if (rulesMemo && rulesMemo.source === source) return rulesMemo;
        /** @type {Map<string, CustomTagRule>} */
        const rules = new Map();
        for (const raw of Array.isArray(source) ? source : []) {
            const match = String(pick(raw, 'match') || '').toLowerCase();
            const value = String(pick(raw, 'value') || '').trim();
            const label = String(pick(raw, 'label') || '').trim();
            if ((match !== 'tag' && match !== 'collection') || !value || !label) continue;
            const id = `${match}:${value.toLowerCase()}`;
            if (rules.has(id)) continue;
            const icon = String(pick(raw, 'icon') || '').toLowerCase();
            rules.set(id, { id, match, value, label, icon: ICONS.includes(icon) ? icon : null });
        }
        // What the persisted per-item matches were computed under (see setCachedEntry).
        const key = [...rules.keys()].sort().join('\n');
        rulesMemo = { source, rules, key };
        return rulesMemo;
    }

    /**
     * The rules an item matched, in the order the server listed them (the
     * rule table's), skipping ids no rule has any more.
     * @param {*} ids - CustomTags from the tag cache entry or /tag-data.
     * @returns {CustomTagRule[]}
     */
    function rulesFor(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const { rules } = currentRules();
        const out = [];
        for (const id of ids) {
            const rule = rules.get(String(id));
            if (rule && !out.includes(rule)) out.push(rule);
        }
        return out;
    }

    /**
     * The tooltip of a chip: its label, and on a second line where it comes from.
     * @param {CustomTagRule} rule
     * @returns {string}
     */
    function titleOf(rule) {
        const source = JE.t(rule.match === 'collection' ? 'custom_tags_source_collection' : 'custom_tags_source_tag', { name: rule.value });
        return `${rule.label}\n${source}`;
    }

    /**
     * One chip, as every Custom chip is drawn (the settings panel's preview
     * builds its samples with it too).
     * @param {{id: string, match: string, value: string, label: string, icon: string|null}} rule
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
     * under the current rules (a rule added since may match it too).
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {string[]|null} The ids, or null when unknown.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!entry || typeof entry !== 'object' || entry.r !== currentRules().key) return null;
        return Array.isArray(entry.ids) ? entry.ids : [];
    }

    /**
     * Store an item's matched ids (an empty list too, so items without a
     * match are not fetched again) with the rules they were matched under.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @param {*} ids - CustomTags from /tag-data.
     * @returns {void}
     */
    function setCachedEntry(ctx, itemId, ids) {
        const entry = { ids: Array.isArray(ids) ? ids.map(String) : [], r: currentRules().key, timestamp: Date.now() };
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
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
                    gap: 3px;
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
                    padding: 4px 8px;
                    background-color: rgba(38, 50, 56, 0.88);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.22);
                    border-radius: 4px;
                    font-size: 13px;
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
                        font-size: clamp(9px, 6.8cqw, 13px);
                        padding: clamp(2px, 2cqw, 4px) clamp(4px, 4.5cqw, 8px);
                    }
                }
                .layout-mobile .${tagClass} { padding: 2px 6px; font-size: 11px; border-radius: 3px; }
                @media (max-width: 768px) {
                    .${tagClass} { padding: 3px 6px; font-size: 12px; }
                }
                @media (max-width: 480px) {
                    .${tagClass} { padding: 2px 4px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }

                /* Caption strip and the minimal corner: the other chips' smaller size. */
                .je-tag-caption .${tagClass} {
                    font-size: clamp(9px, 6.4cqw, 11.5px);
                    padding: 2px 5px;
                    border-radius: 3px;
                    box-shadow: none;
                }
                html .je-tag-host > .je-tag-slot[data-je-slot="corner"] .${tagClass} { font-size: 11px; padding: 2px 5px; }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            render(ctx, el, item) {
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
