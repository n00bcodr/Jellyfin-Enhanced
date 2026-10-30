// @ts-check
// /js/core/tag-layout.js
//
// Shared placement layer for the poster tag groups (quality, genre, language,
// rating, age rating, status). Renderers keep building their group wrapper
// (.quality-overlay-container and friends, with the same chip classes) and
// hand it to commitGroup(); this module decides where, and in what form, it
// appears on the card for the user's layout:
//
//   corners  tl/tr/bl/br stacks (the original behaviour)
//   bands    a top band and a wrapping bottom band
//   caption  a strip below the image, plus a small poster stack
//   summary  one fact pill, full chips on hover/focus
//   minimal  status top, quality dots, rating corner, full chips on hover/focus
//
// The committed wrapper is kept as the group's master copy and never placed
// itself: each representation (slot chips, pill fact, dots, hover chips) is
// built from it, so a settings change re-presents every card from the facts
// already on the page, without refetching anything.
//
// DOM: one .je-tag-host per image (data-je-layout) with .je-tag-slot
// [data-je-slot] children for on-image slots. The caption slot is an owned
// outlet (.je-tag-caption) inserted between .cardScalable and the card's
// first .cardText, never inside .cardImageContainer. Cards without that
// topology (list rows, bare images) show caption groups in the poster slot.
//
// Public surface: JE.core.tagLayout (see the object at the bottom) and
// JE.reinitializeTagLayout().
(function (JE) {
    'use strict';

    JE.core = JE.core || {};

    /** Group ids in the default priority order. */
    const DEFAULT_ORDER = ['status', 'quality', 'rating', 'ageRating', 'language', 'genre'];
    const GROUPS = new Set(DEFAULT_ORDER);

    /** Valid slots per layout; "off" hides a group in any layout. */
    const LAYOUT_SLOTS = {
        corners: ['tl', 'tr', 'bl', 'br', 'off'],
        bands: ['top', 'bottom', 'off'],
        caption: ['poster', 'caption', 'off'],
        summary: ['pill', 'hover', 'off'],
        minimal: ['top', 'dots', 'corner', 'hover', 'off'],
    };
    const LAYOUTS = Object.keys(LAYOUT_SLOTS);

    /** Built-in profiles (corners comes from the position settings instead). */
    const DEFAULT_PROFILES = {
        bands: { quality: 'bottom', genre: 'off', language: 'bottom', rating: 'bottom', ageRating: 'top', status: 'top' },
        caption: { quality: 'caption', genre: 'off', language: 'caption', rating: 'caption', ageRating: 'caption', status: 'poster' },
        summary: { quality: 'pill', genre: 'hover', language: 'hover', rating: 'pill', ageRating: 'hover', status: 'pill' },
        minimal: { quality: 'dots', genre: 'hover', language: 'hover', rating: 'corner', ageRating: 'hover', status: 'top' },
    };

    /** Built-in chip limits (0 = unlimited): the limits each group had before caps existed. */
    const DEFAULT_CAPS = { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1 };
    const MAX_CAP = 10;

    /** The legacy per-group position settings the corners profile migrates from. */
    const POSITION_SETTINGS = {
        quality: { userKey: 'qualityTagsPosition', pluginKey: 'QualityTagsPosition', fallback: 'top-left' },
        genre: { userKey: 'genreTagsPosition', pluginKey: 'GenreTagsPosition', fallback: 'top-right' },
        language: { userKey: 'languageTagsPosition', pluginKey: 'LanguageTagsPosition', fallback: 'bottom-left' },
        rating: { userKey: 'ratingTagsPosition', pluginKey: 'RatingTagsPosition', fallback: 'bottom-right' },
        ageRating: { userKey: 'ageRatingTagsPosition', pluginKey: 'AgeRatingTagsPosition', fallback: 'bottom-right' },
        status: { userKey: 'statusTagsPosition', pluginKey: 'StatusTagsPosition', fallback: 'top-right' },
    };
    const POSITION_TO_SLOT = { 'top-left': 'tl', 'top-right': 'tr', 'bottom-left': 'bl', 'bottom-right': 'br' };
    const SLOT_TO_POSITION = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };

    /** Group wrapper class per group (frozen DOM: Tag Styles and custom CSS target these). */
    const CONTAINER_CLASS = {
        quality: 'quality-overlay-container',
        genre: 'genre-overlay-container',
        language: 'language-overlay-container',
        rating: 'rating-overlay-container',
        ageRating: 'age-rating-overlay-container',
        status: 'status-overlay-container',
    };

    /** Slots that summarise a group; its full chips are added to the hover scrim. */
    const SUMMARY_SLOTS = new Set(['pill', 'dots', 'corner']);
    const PILL_MAX_FACTS = 3;

    /**
     * Settings for the hover/focus reveal's chips: always compact labels, so
     * its two rows say as much as they can in the bottom of the card.
     * @param {TagLayoutSettings} conf
     * @returns {TagLayoutSettings}
     */
    function revealSettings(conf) {
        return conf.density === 'compact' ? conf : { ...conf, density: 'compact' };
    }

    /** Layouts whose representations are fitted to the card's measured size. */
    const FIT_LAYOUTS = new Set(['bands', 'caption', 'summary', 'minimal']);
    /** Rows a wrapping slot (caption strip, hover reveal) shows before its "+N" overflow chip. */
    const FIT_MAX_ROWS = 2;

    /** Compact quality labels; audio "<codec> <channels>" is handled in compactQualityLabel. */
    const COMPACT_QUALITY = { 'Dolby Vision': 'DV', 'HDR10+': 'HDR+', 'Dolby Digital+': 'DD+' };
    const DYNAMIC_RANGE = ['Dolby Vision', 'HDR10+', 'HDR10', 'HDR'];

    /** Dot kind per quality chip class (minimal layout). */
    const DOT_KIND = [
        ['resolution', 'resolution'],
        ['video-codec', 'range'],
        ['audio-codec', 'audio'],
        ['video-format', 'codec'],
        ['other-quality', 'codec'],
    ];

    // ── Settings ───────────────────────────────────────────────────────

    /**
     * Read a key from an object that may use the client's camelCase or the
     * server's PascalCase (plugin configuration, array items the key
     * converter never reaches).
     * @param {*} obj
     * @param {string} key - camelCase key.
     * @returns {*}
     */
    function pick(obj, key) {
        if (!obj || typeof obj !== 'object') return undefined;
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
        const pascal = key.charAt(0).toUpperCase() + key.slice(1);
        return obj[pascal] !== undefined && obj[pascal] !== null ? obj[pascal] : undefined;
    }

    /**
     * Canonical group id for a renderer or settings name, or null.
     * "agerating" (the age rating renderer's registration name) → "ageRating".
     * @param {*} name
     * @returns {string|null}
     */
    function normalizeGroup(name) {
        if (typeof name !== 'string') return null;
        const lowered = name.trim().toLowerCase();
        for (const group of DEFAULT_ORDER) {
            if (group.toLowerCase() === lowered) return group;
        }
        return null;
    }

    /**
     * Canonical layout id, or "corners".
     * @param {*} value
     * @returns {string}
     */
    function normalizeLayout(value) {
        const lowered = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return LAYOUTS.includes(lowered) ? lowered : 'corners';
    }

    /**
     * Read one layout profile ({ groups: [{group, slot}] }) into a group → slot
     * map, dropping unknown groups, invalid slots and repeats.
     * @param {*} profiles - tagLayouts object (either key case).
     * @param {string} layout
     * @returns {Object<string, string>}
     */
    function readProfile(profiles, layout) {
        const out = {};
        const groups = pick(pick(profiles, layout), 'groups');
        if (!Array.isArray(groups)) return out;
        for (const entry of groups) {
            const group = normalizeGroup(pick(entry, 'group'));
            const raw = pick(entry, 'slot');
            const slot = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
            if (!group || out[group] || !LAYOUT_SLOTS[layout].includes(slot)) continue;
            if (slot === 'dots' && group !== 'quality') continue;
            out[group] = slot;
        }
        return out;
    }

    /**
     * Known groups in the given order without repeats, or null when none.
     * @param {*} order
     * @returns {string[]|null}
     */
    function readOrder(order) {
        if (!Array.isArray(order)) return null;
        const out = [];
        for (const entry of order) {
            const group = normalizeGroup(entry);
            if (group && !out.includes(group)) out.push(group);
        }
        return out.length ? out : null;
    }

    /**
     * Clamp a cap value to 0..MAX_CAP, or undefined when not a number.
     * @param {*} value
     * @returns {number|undefined}
     */
    function readCap(value) {
        const n = Number(value);
        if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return undefined;
        return Math.max(0, Math.min(MAX_CAP, Math.round(n)));
    }

    /**
     * The corners slot a group's legacy position setting maps to, read exactly
     * like the old resolvePosition(): the first non-empty of user → admin →
     * built-in, "top" anywhere in it means a top corner and "left" a left one
     * (so a stray "top" is top-right and "middle" bottom-right, as before).
     * @param {Object} settings
     * @param {Object} plugin
     * @param {string} group
     * @returns {string}
     */
    function positionSlot(settings, plugin, group) {
        const p = POSITION_SETTINGS[group];
        const pos = String(settings?.[p.userKey] || plugin?.[p.pluginKey] || p.fallback);
        const isTop = pos.includes('top');
        const isLeft = pos.includes('left');
        return isTop ? (isLeft ? 'tl' : 'tr') : (isLeft ? 'bl' : 'br');
    }

    /**
     * @typedef {Object} TagLayoutSettings
     * @property {string} layout - Active layout id.
     * @property {boolean} legacy - True for a document saved before layouts existed.
     * @property {string} density - 'full' or 'compact'.
     * @property {string[]|null} order - Complete group priority order, or null for arrival order.
     * @property {Object<string, number>} caps - Chips per group, 0 = unlimited.
     * @property {Object<string, Object<string, string>>} profiles - layout → group → slot.
     * @property {Object<string, string>} slots - group → slot for the active layout.
     * @property {Set<string>} indicatorGap - Groups set to exactly top-right: a corners card
     *   holding one moves its top-right stack below Jellyfin's played/count indicator.
     */

    /**
     * Resolve the effective layout settings from a user document and the
     * administrator defaults. A legacy document (no tagLayoutSettingsVersion)
     * keeps corners with its position settings, arrival ordering, full labels
     * and the built-in limits — exactly what it showed before layouts existed —
     * whatever the administrator's new defaults are. A normalized document
     * inherits each value it does not set: user → administrator → built-in.
     * @param {Object} [settings] - Defaults to JE.currentSettings.
     * @param {Object} [plugin] - Defaults to JE.pluginConfig.
     * @returns {TagLayoutSettings}
     */
    function normalizeSettings(settings, plugin) {
        const s = settings || JE.currentSettings || {};
        const p = plugin || JE.pluginConfig || {};
        const legacy = !(Number(s.tagLayoutSettingsVersion) >= 1);
        const layout = legacy ? 'corners' : normalizeLayout(s.tagLayout);
        const densityRaw = legacy ? 'full' : String(s.tagLabelDensity || '').toLowerCase();
        const density = densityRaw === 'compact' ? 'compact' : 'full';

        const profiles = {};
        const indicatorGap = new Set();
        const ownCorners = readProfile(s.tagLayouts, 'corners');
        for (const group of DEFAULT_ORDER) {
            const pos = POSITION_SETTINGS[group];
            // The original rule (and Native Poster Tags): only a position of
            // exactly "top-right" earns the indicator offset.
            const raw = s[pos.userKey] || p[pos.pluginKey] || pos.fallback;
            if (ownCorners[group] ? ownCorners[group] === 'tr' : raw === 'top-right') indicatorGap.add(group);
        }
        for (const name of LAYOUTS) {
            const own = readProfile(s.tagLayouts, name);
            // The corners profile is the position settings (kept in step with
            // it by the panel), so an admin corners profile never overrides them.
            const admin = name === 'corners' ? {} : readProfile(pick(p, 'tagLayouts'), name);
            const profile = {};
            for (const group of DEFAULT_ORDER) {
                profile[group] = own[group] || admin[group]
                    || (name === 'corners' ? positionSlot(s, p, group) : DEFAULT_PROFILES[name][group]);
            }
            profiles[name] = profile;
        }

        let order = null;
        if (!legacy) {
            const chosen = readOrder(s.tagGroupOrder) || readOrder(pick(p, 'tagGroupOrder'))
                || (layout === 'corners' ? null : DEFAULT_ORDER);
            if (chosen) order = chosen.concat(DEFAULT_ORDER.filter((g) => !chosen.includes(g)));
        }

        const caps = {};
        for (const group of DEFAULT_ORDER) {
            const own = legacy ? undefined : readCap(pick(s.tagGroupCaps, group));
            const admin = legacy ? undefined : readCap(pick(pick(p, 'tagGroupCaps'), group));
            caps[group] = own ?? admin ?? DEFAULT_CAPS[group];
        }

        return { layout, legacy, density, order, caps, profiles, slots: profiles[layout], indicatorGap };
    }

    /** @type {TagLayoutSettings|null} memoised until the next invalidateSettings() */
    let cachedSettings = null;

    /** @returns {TagLayoutSettings} */
    function currentSettings() {
        if (!cachedSettings) cachedSettings = normalizeSettings();
        return cachedSettings;
    }

    /** Forget the memoised settings (they changed, or the user switched). */
    function invalidateSettings() {
        cachedSettings = null;
    }

    // ── Card context ───────────────────────────────────────────────────

    /**
     * @typedef {Object} CardController
     * @property {HTMLElement} host
     * @property {string} itemId - Normalised item id the groups belong to.
     * @property {Map<string, {master: HTMLElement, seq: number}>} groups
     * @property {Map<string, HTMLElement[]>} nodes - Representations placed per group.
     * @property {HTMLElement|null} outlet - Caption outlet owned by this card.
     * @property {HTMLElement|null} pill
     * @property {string|null} layout - Layout the card is currently presented in.
     * @property {number} seq - Arrival counter (legacy ordering).
     */

    /** @type {WeakMap<HTMLElement, CardController>} host → controller */
    const controllers = new WeakMap();
    let outletSeq = 0;
    let stylesInjected = false;

    /**
     * Inject the shared layout stylesheet once (tags/tag-layout-styles.js
     * provides it), and start re-fitting cards when the window resizes.
     */
    function injectStyles() {
        if (stylesInjected || typeof api.buildStyles !== 'function' || !JE.core.ui?.injectCss) return;
        stylesInjected = true;
        JE.core.ui.injectCss('je-tag-layout', api.buildStyles());
        window.addEventListener('resize', refitOnResize, { passive: true });
    }

    let resizeQueued = false;

    /** Card sizes follow the window: re-fit every fitted card once per frame of resizing. */
    function refitOnResize() {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            for (const host of document.querySelectorAll('.je-tag-host')) {
                const ctrl = controllers.get(/** @type {HTMLElement} */ (host));
                if (ctrl) scheduleFit(ctrl);
            }
        });
    }

    /**
     * Normalised id of the item a card shows, from its data-id/data-itemid
     * attribute (what a virtualised list rewrites when it reuses a card; the
     * lazily set artwork URL is deliberately not used, it can name the series).
     * @param {HTMLElement} el
     * @returns {string}
     */
    function identityOf(el) {
        const holder = el.closest('[data-id]') || el.closest('[data-itemid]');
        const raw = holder?.getAttribute('data-id') || holder?.getAttribute('data-itemid') || '';
        return raw.replace(/-/g, '').toLowerCase();
    }

    /**
     * The .je-tag-host a render target already has, without creating one.
     * @param {HTMLElement} target
     * @returns {HTMLElement|null}
     */
    function findHost(target) {
        if (!target) return null;
        if (target.classList?.contains('je-tag-host')) return target;
        for (const child of target.children || []) {
            if (child.classList.contains('je-tag-host')) return /** @type {HTMLElement} */ (child);
        }
        return null;
    }

    /**
     * The .je-tag-host for a render target: the target itself when the
     * pipeline already gave it one, else a host created inside the target —
     * in .cardScalable before Jellyfin's hover overlay, or appended to a bare
     * image target (a list row image) the way overlays were before.
     * @param {HTMLElement} target - Render target from the tag pipeline.
     * @returns {HTMLElement|null}
     */
    function ensureHost(target) {
        const existing = findHost(target);
        if (existing || !target) return existing;
        const host = document.createElement('div');
        host.className = 'je-tag-host';
        const overlay = target.classList.contains('cardScalable')
            ? Array.from(target.children).find((c) => c.classList.contains('cardOverlayContainer')) || null
            : null;
        target.insertBefore(host, overlay);
        return host;
    }

    /**
     * Where a caption outlet goes for a host: after .cardScalable, before the
     * first sibling that is (or holds) a .cardText — Modern and legacy cards
     * both put the title block there, directly or in a .cardFooter. Null for
     * topologies without one (list rows, bare images, cards without titles).
     * @param {HTMLElement} host
     * @returns {{parent: HTMLElement, before: HTMLElement}|null}
     */
    function captionAnchor(host) {
        const scalable = host.closest('.cardScalable');
        const box = scalable?.parentElement;
        if (!scalable || !box || !box.classList.contains('cardBox')) return null;
        for (let next = scalable.nextElementSibling; next; next = next.nextElementSibling) {
            if (next.classList.contains('je-tag-caption')) continue;
            if (next.classList.contains('cardText') || next.querySelector('.cardText')) {
                return { parent: box, before: /** @type {HTMLElement} */ (next) };
            }
        }
        return null;
    }

    /**
     * Whether the card sits in a context that never shows tags (detail-page
     * poster, cast, dialogs, admin pages): no caption space is reserved there.
     * @param {HTMLElement} host
     * @returns {boolean}
     */
    function isIgnoredContext(host) {
        const check = JE.core.tagRenderer?.isIgnoredContext;
        return typeof check === 'function' ? check(host) : false;
    }

    /**
     * The controller for a render target, created on demand. A controller
     * whose card now shows another item (a reused virtualised card) is
     * cleared first, so the previous item's groups never linger.
     * @param {HTMLElement} target
     * @param {boolean} create
     * @returns {CardController|null}
     */
    function controllerFor(target, create) {
        const host = create ? ensureHost(target) : findHost(target);
        if (!host) return null;
        let ctrl = controllers.get(host) || null;
        const itemId = identityOf(host);
        if (ctrl && ctrl.itemId !== itemId) {
            forget(ctrl);
            ctrl = null;
        }
        if (!ctrl && create) {
            injectStyles();
            ctrl = { host, itemId, groups: new Map(), nodes: new Map(), outlet: null, pill: null, layout: null, seq: 0 };
            controllers.set(host, ctrl);
        }
        return ctrl;
    }

    /**
     * The layout decision for one card. Today every card follows the user's
     * layout; this is the single boundary later per-card rules and locks
     * plug into.
     * @param {CardController|HTMLElement} cardContext
     * @returns {TagLayoutSettings}
     */
    // eslint-disable-next-line no-unused-vars
    function resolveLayout(cardContext) {
        return currentSettings();
    }

    // ── Representations ────────────────────────────────────────────────

    /**
     * Shorter quality label for compact density ("Dolby Vision" → "DV",
     * "ATMOS 7.1" → "ATMOS", "Dolby Digital+ 5.1" → "5.1").
     * @param {string} label
     * @returns {string}
     */
    function compactQualityLabel(label) {
        if (COMPACT_QUALITY[label]) return COMPACT_QUALITY[label];
        const audio = /^(ATMOS|DTS-X|TRUEHD|DTS|Dolby Digital\+) (\d+\.\d+)$/.exec(label);
        if (audio) return audio[1] === 'Dolby Digital+' ? audio[2] : audio[1];
        return label;
    }

    /**
     * Apply density and the cap to a group copy in place: compact shortens
     * quality labels and drops the critic chip next to a community score;
     * the cap then keeps the first N chips.
     * @param {string} group
     * @param {HTMLElement} node
     * @param {TagLayoutSettings} conf
     */
    function applyDensityAndCap(group, node, conf) {
        if (conf.density === 'compact') {
            if (group === 'quality') {
                for (const chip of node.querySelectorAll('.quality-overlay-label')) {
                    const text = chip.textContent || '';
                    const short = compactQualityLabel(text);
                    if (short !== text) chip.textContent = short;
                }
            } else if (group === 'rating' && node.querySelector('.rating-tag-tmdb')) {
                node.querySelector('.rating-tag-critic')?.remove();
            }
        }
        const cap = conf.caps[group];
        if (cap > 0) {
            while (node.children.length > cap) node.lastElementChild?.remove();
        }
    }

    /**
     * A display copy of a group's master wrapper (the master itself never
     * enters the DOM, so later re-presentations start from the full facts).
     * @param {string} group
     * @param {HTMLElement} master
     * @param {TagLayoutSettings} conf
     * @returns {HTMLElement}
     */
    function buildChips(group, master, conf) {
        const node = /** @type {HTMLElement} */ (master.cloneNode(true));
        node.dataset.jeGroup = group;
        // Event handler properties are not cloned: a flag whose country is
        // missing from the flag set still removes itself.
        for (const img of node.querySelectorAll('img')) img.onerror = () => img.remove();
        applyDensityAndCap(group, node, conf);
        return node;
    }

    /**
     * Quality dots for the minimal layout: one coloured dot per (capped)
     * quality chip, with one combined accessible label for the set.
     * @param {HTMLElement} master
     * @param {TagLayoutSettings} conf
     * @returns {HTMLElement|null}
     */
    function buildDots(master, conf) {
        const copy = buildChips('quality', master, { ...conf, density: 'full' });
        const labels = [];
        const dots = document.createElement('div');
        dots.className = 'je-tag-dots';
        dots.dataset.jeGroup = 'quality';
        for (const chip of Array.from(copy.children)) {
            const label = chip.textContent || '';
            const kind = DOT_KIND.find(([cls]) => chip.classList.contains(cls))?.[1] || 'codec';
            const dot = document.createElement('span');
            dot.className = 'je-tag-dot';
            dot.dataset.jeDot = kind;
            dot.title = label;
            dot.setAttribute('aria-hidden', 'true');
            dots.appendChild(dot);
            labels.push(label);
        }
        if (labels.length === 0) return null;
        dots.setAttribute('role', 'img');
        dots.setAttribute('aria-label', labels.join(', '));
        dots.title = labels.join(' · ');
        return dots;
    }

    /**
     * The one short fact a group contributes to the summary pill, or null.
     * @param {string} group
     * @param {HTMLElement} master - The group's capped display copy (buildChips).
     * @returns {{text: string, glyph?: string, flag?: HTMLElement}|null}
     */
    function pillFact(group, master) {
        switch (group) {
            case 'quality': {
                const labels = Array.from(master.querySelectorAll('.quality-overlay-label'));
                const resolution = labels.find((l) => l.classList.contains('resolution'))?.textContent || '';
                const range = labels.map((l) => /** @type {HTMLElement} */ (l).dataset.quality || '').find((q) => DYNAMIC_RANGE.includes(q)) || '';
                const text = [resolution, range ? compactQualityLabel(range) : ''].filter(Boolean).join(' ')
                    || labels[0]?.textContent || '';
                return text ? { text } : null;
            }
            case 'rating': {
                const community = master.querySelector('.rating-tag-tmdb .rating-text')?.textContent;
                if (community) return { text: community, glyph: '★' };
                const critic = master.querySelector('.rating-tag-critic .rating-text')?.textContent;
                if (critic) return { text: critic };
                const review = master.querySelector('.je-userreview-tag .rating-text')?.textContent;
                return review ? { text: review, glyph: '♥' } : null;
            }
            case 'status':
            case 'ageRating': {
                const text = (master.firstElementChild?.textContent || '').trim();
                return text ? { text } : null;
            }
            case 'language': {
                const img = master.querySelector('img');
                if (!img) return null;
                const flag = /** @type {HTMLElement} */ (img.cloneNode(true));
                flag.className = 'je-tag-pill-flag';
                /** @type {HTMLImageElement} */ (flag).onerror = () => flag.remove();
                return { text: img.getAttribute('alt') || '', flag };
            }
            case 'genre': {
                const text = master.querySelector('.genre-tag')?.getAttribute('title') || '';
                return text ? { text } : null;
            }
            default:
                return null;
        }
    }

    /**
     * Priority of a group on a card: its index in the configured order, or
     * its arrival on the card (legacy corners documents).
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     * @param {string} group
     * @returns {number}
     */
    function rankOf(ctrl, conf, group) {
        if (conf.order) return conf.order.indexOf(group);
        return ctrl.groups.get(group)?.seq ?? Number.MAX_SAFE_INTEGER;
    }

    /**
     * The element a slot's representations go into, created on demand.
     * @param {CardController} ctrl
     * @param {string} slot
     * @returns {HTMLElement}
     */
    function slotElement(ctrl, slot) {
        if (slot === 'caption') return /** @type {HTMLElement} */ (ensureOutlet(ctrl));
        for (const child of ctrl.host.children) {
            if (child.classList.contains('je-tag-slot') && /** @type {HTMLElement} */ (child).dataset.jeSlot === slot) {
                return /** @type {HTMLElement} */ (child);
            }
        }
        const el = document.createElement('div');
        el.className = 'je-tag-slot';
        el.dataset.jeSlot = slot;
        ctrl.host.appendChild(el);
        return el;
    }

    /**
     * Reserve (or return) the card's caption outlet. Null when the card has
     * no supported topology for one.
     * @param {CardController} ctrl
     * @returns {HTMLElement|null}
     */
    function ensureOutlet(ctrl) {
        if (ctrl.outlet && ctrl.outlet.isConnected) return ctrl.outlet;
        const anchor = captionAnchor(ctrl.host);
        if (!anchor) return null;
        // An outlet left by a previous host of the same card (Jellyfin rebuilt
        // the image block) is reused rather than stacked.
        let outlet = Array.from(anchor.parent.children).find((c) => c.classList.contains('je-tag-caption')) || null;
        if (!outlet) {
            outlet = document.createElement('div');
            outlet.className = 'je-tag-slot je-tag-caption';
            outlet.dataset.jeSlot = 'caption';
            anchor.parent.insertBefore(outlet, anchor.before);
        }
        outlet.dataset.jeOwner = String(++outletSeq);
        outlet.replaceChildren();
        ctrl.outlet = /** @type {HTMLElement} */ (outlet);
        return ctrl.outlet;
    }

    /**
     * Insert a representation into a slot at its priority position.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     * @param {HTMLElement} slotEl
     * @param {HTMLElement} node - Carries data-je-group.
     */
    function placeSorted(ctrl, conf, slotEl, node) {
        const rank = rankOf(ctrl, conf, node.dataset.jeGroup || '');
        let before = null;
        for (const sibling of slotEl.children) {
            const group = /** @type {HTMLElement} */ (sibling).dataset.jeGroup;
            if (group && rankOf(ctrl, conf, group) > rank) { before = sibling; break; }
        }
        // The "+N" overflow chip stays last.
        slotEl.insertBefore(node, before || moreChipOf(slotEl));
    }

    /**
     * Remove a group's representations, and any slot left empty (the
     * caption outlet stays: it is the card's reserved space).
     * @param {CardController} ctrl
     * @param {string} group
     */
    function removeNodes(ctrl, group) {
        const nodes = ctrl.nodes.get(group);
        if (!nodes) return;
        ctrl.nodes.delete(group);
        for (const node of nodes) {
            const slot = node.parentElement;
            node.remove();
            if (slot && slot !== ctrl.outlet && slot.classList.contains('je-tag-slot') && !holdsGroups(slot)) slot.remove();
        }
    }

    /**
     * The slot a group is actually shown in on this card: caption groups
     * fall back to the poster slot where no caption outlet fits.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     * @param {string} group
     * @returns {string}
     */
    function effectiveSlot(ctrl, conf, group) {
        const slot = conf.slots[group] || 'off';
        if (slot === 'caption' && !ensureOutlet(ctrl)) return 'poster';
        return slot;
    }

    /**
     * Rebuild the summary pill from the card's pill groups in priority order.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     */
    function refreshPill(ctrl, conf) {
        if (ctrl.pill) {
            const slot = ctrl.pill.parentElement;
            ctrl.pill.remove();
            if (slot && slot.children.length === 0) slot.remove();
            ctrl.pill = null;
        }
        if (conf.layout !== 'summary') return;
        const groups = Array.from(ctrl.groups.keys())
            .filter((g) => conf.slots[g] === 'pill')
            .sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
        const facts = [];
        for (const group of groups) {
            // From the same capped, density-adjusted copy the chips show, so
            // the pill never names a chip the caps or density left out.
            const shown = buildChips(group, /** @type {HTMLElement} */ (ctrl.groups.get(group)?.master), conf);
            const fact = pillFact(group, shown);
            if (fact) facts.push({ group, ...fact });
            if (facts.length >= PILL_MAX_FACTS) break;
        }
        if (facts.length === 0) return;
        const pill = document.createElement('div');
        pill.className = 'je-tag-pill';
        const spoken = [];
        facts.forEach((fact, i) => {
            if (i > 0) {
                const sep = document.createElement('span');
                sep.className = 'je-tag-pill-sep';
                sep.setAttribute('aria-hidden', 'true');
                sep.textContent = '·';
                pill.appendChild(sep);
            }
            const span = document.createElement('span');
            span.className = 'je-tag-pill-fact';
            span.dataset.jeGroup = fact.group;
            if (fact.flag) {
                span.appendChild(fact.flag);
            } else {
                if (fact.glyph) {
                    const glyph = document.createElement('span');
                    glyph.className = 'je-tag-pill-glyph';
                    glyph.setAttribute('aria-hidden', 'true');
                    glyph.textContent = fact.glyph;
                    span.append(glyph, ' ');
                }
                span.append(fact.text);
            }
            pill.appendChild(span);
            spoken.push(fact.text);
        });
        pill.title = spoken.join(' · ');
        pill.setAttribute('aria-label', spoken.join(', '));
        slotElement(ctrl, 'pill').appendChild(pill);
        ctrl.pill = pill;
    }

    /**
     * Place one group's representations for the card's layout.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     * @param {string} group
     */
    function presentGroup(ctrl, conf, group) {
        removeNodes(ctrl, group);
        const rec = ctrl.groups.get(group);
        if (!rec) return;
        const slot = effectiveSlot(ctrl, conf, group);
        if (slot === 'off') return;
        /** @type {HTMLElement[]} */
        const nodes = [];
        if (slot === 'dots') {
            const dots = buildDots(rec.master, conf);
            if (dots) { placeSorted(ctrl, conf, slotElement(ctrl, 'dots'), dots); nodes.push(dots); }
        } else if (slot !== 'pill') {
            const chips = buildChips(group, rec.master, slot === 'hover' ? revealSettings(conf) : conf);
            if (conf.layout === 'corners') chips.dataset.jeCorner = SLOT_TO_POSITION[slot];
            if (chips.children.length > 0) { placeSorted(ctrl, conf, slotElement(ctrl, slot), chips); nodes.push(chips); }
        }
        // Summaries (pill, dots, corner score) keep their full chips for the
        // hover/focus scrim of the summary and minimal layouts.
        if (SUMMARY_SLOTS.has(slot) && (conf.layout === 'summary' || conf.layout === 'minimal')) {
            const full = buildChips(group, rec.master, revealSettings(conf));
            if (full.children.length > 0) { placeSorted(ctrl, conf, slotElement(ctrl, 'hover'), full); nodes.push(full); }
        }
        ctrl.nodes.set(group, nodes);
    }

    /**
     * Mark a corners card whose shown groups include one set to exactly
     * top-right, so the layout stylesheet moves its top-right stack below
     * Jellyfin's played / unplayed-count indicator.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     */
    function syncIndicatorGap(ctrl, conf) {
        const on = conf.layout === 'corners'
            && Array.from(ctrl.groups.keys()).some((g) => conf.indicatorGap.has(g) && (ctrl.nodes.get(g)?.length || 0) > 0);
        if (on) ctrl.host.dataset.jeIndicatorGap = '1';
        else delete ctrl.host.dataset.jeIndicatorGap;
    }

    /**
     * Remove every representation, slot, pill and outlet a card owns.
     * @param {CardController} ctrl
     */
    function teardown(ctrl) {
        for (const group of Array.from(ctrl.nodes.keys())) removeNodes(ctrl, group);
        ctrl.pill?.remove();
        ctrl.pill = null;
        for (const child of Array.from(ctrl.host.children)) {
            if (child.classList.contains('je-tag-slot')) child.remove();
        }
        ctrl.outlet?.remove();
        ctrl.outlet = null;
        ctrl.layout = null;
        delete ctrl.host.dataset.jeLayout;
        delete ctrl.host.dataset.jeIndicatorGap;
    }

    /**
     * Re-present every group of a card for the current layout settings.
     * @param {CardController} ctrl
     */
    function presentAll(ctrl) {
        const conf = resolveLayout(ctrl);
        teardown(ctrl);
        ctrl.layout = conf.layout;
        ctrl.host.dataset.jeLayout = conf.layout;
        if (conf.layout === 'caption' && !isIgnoredContext(ctrl.host)) ensureOutlet(ctrl);
        const groups = Array.from(ctrl.groups.keys()).sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
        for (const group of groups) presentGroup(ctrl, conf, group);
        refreshPill(ctrl, conf);
        syncIndicatorGap(ctrl, conf);
        scheduleFit(ctrl);
    }

    // ── Fitting ────────────────────────────────────────────────────────
    // What fits on a card depends on its rendered size, which only the
    // browser knows. After cards are presented, one pass after the next
    // paint measures every card queued by then — reads and writes in
    // separate phases, so a page of cards costs two layouts, not one per
    // card — and hides what does not fit, never half a chip or fact:
    //   - the summary pill's lowest-priority facts;
    //   - in the caption strip and the hover reveal, chips past their two
    //     rows, lowest priority first, behind a "+N" chip whose title names
    //     them.

    /**
     * Whether a slot still holds any group representation.
     * @param {Element} slotEl
     * @returns {boolean}
     */
    function holdsGroups(slotEl) {
        return Array.from(slotEl.children).some((c) => !!(/** @type {HTMLElement} */ (c).dataset.jeGroup));
    }

    /**
     * A slot's "+N" overflow chip, or null.
     * @param {Element} slotEl
     * @returns {HTMLElement|null}
     */
    function moreChipOf(slotEl) {
        const last = slotEl.lastElementChild;
        return last && last.classList.contains('je-tag-more') ? /** @type {HTMLElement} */ (last) : null;
    }

    /**
     * The wrapping slots of a card that are limited to FIT_MAX_ROWS rows.
     * @param {CardController} ctrl
     * @returns {HTMLElement[]}
     */
    function rowSlots(ctrl) {
        const slots = [];
        if (ctrl.outlet && ctrl.outlet.isConnected) slots.push(ctrl.outlet);
        for (const child of ctrl.host.children) {
            if (child.classList.contains('je-tag-slot') && /** @type {HTMLElement} */ (child).dataset.jeSlot === 'hover') {
                slots.push(/** @type {HTMLElement} */ (child));
            }
        }
        return slots;
    }

    /**
     * The chips of a wrapping slot in display order (its groups flow as one
     * row of chips, in priority order).
     * @param {HTMLElement} slotEl
     * @returns {HTMLElement[]}
     */
    function slotChips(slotEl) {
        const chips = [];
        for (const child of slotEl.children) {
            if (/** @type {HTMLElement} */ (child).dataset.jeGroup) chips.push(.../** @type {HTMLElement[]} */ (Array.from(child.children)));
        }
        return chips;
    }

    /**
     * A chip's name for the "+N" chip's title: its title or alt text (genre
     * icons, flags), its rating number, or its text.
     * @param {HTMLElement} chip
     * @returns {string}
     */
    function chipLabel(chip) {
        return chip.getAttribute('title') || chip.getAttribute('alt')
            || chip.querySelector('.rating-text')?.textContent?.trim()
            || (chip.textContent || '').trim();
    }

    /**
     * How many chips, in order, a wrapping row shows within maxRows rows,
     * leaving room for a "+N" chip after them when some are left out. Mirrors
     * flex-wrap: a chip joins the current row if it fits after the gap, else
     * starts the next one.
     * @param {number[]} widths - Chip widths in display order.
     * @param {number} available - Content width of the row.
     * @param {number} gap - Gap between chips.
     * @param {number} maxRows
     * @param {number} moreWidth - Width of the "+N" chip.
     * @returns {number}
     */
    function chipsThatFit(widths, available, gap, maxRows, moreWidth) {
        const rowsFor = (list) => {
            let rows = 0;
            let x = 0;
            for (const w of list) {
                if (rows === 0 || x + gap + w > available + 0.5) { rows++; x = w; } else x += gap + w;
            }
            return rows;
        };
        if (rowsFor(widths) <= maxRows) return widths.length;
        for (let keep = widths.length - 1; keep > 0; keep--) {
            if (rowsFor(widths.slice(0, keep).concat(moreWidth)) <= maxRows) return keep;
        }
        return 0;
    }

    /** @type {Set<CardController>} cards waiting for the next fitting pass */
    const pendingFit = new Set();
    let fitScheduled = false;
    let fitting = false;

    /**
     * Queue a card for the next fitting pass (layouts that need one only).
     * @param {CardController} ctrl
     */
    function scheduleFit(ctrl) {
        if (fitting || !FIT_LAYOUTS.has(ctrl.layout || '')) return;
        pendingFit.add(ctrl);
        if (fitScheduled) return;
        fitScheduled = true;
        if (typeof JE.core.dom?.afterNextPaint === 'function') JE.core.dom.afterNextPaint(flushFit);
        else requestAnimationFrame(flushFit);
    }

    /** Run the fitting pass for every queued card that is still on the page. */
    function flushFit() {
        fitScheduled = false;
        const list = Array.from(pendingFit).filter((c) => c.host.isConnected && controllers.get(c.host) === c);
        pendingFit.clear();
        if (list.length === 0) return;
        fitting = true;
        try {
            // Reads: cards not laid out (hidden, detached tab) are left as they are.
            const shown = list.filter((ctrl) => ctrl.host.clientWidth > 0);
            // Writes: show what an earlier pass hid, and give every wrapping
            // slot its "+N" chip, so both are measured afresh.
            for (const ctrl of shown) prepareFit(ctrl);
            // Reads, then writes.
            const plans = shown.map(measureFit);
            shown.forEach((ctrl, i) => applyFit(ctrl, plans[i]));
        } finally {
            fitting = false;
        }
    }

    /**
     * Undo an earlier pass and put a "+N" chip (sized for the worst case)
     * last in every wrapping slot that has chips (writes only).
     * @param {CardController} ctrl
     */
    function prepareFit(ctrl) {
        for (const root of [ctrl.host, ctrl.outlet]) {
            root?.querySelectorAll('[data-je-overflow]').forEach((el) => el.removeAttribute('data-je-overflow'));
        }
        for (const slotEl of rowSlots(ctrl)) {
            const count = slotChips(slotEl).length;
            let more = moreChipOf(slotEl) || slotEl.querySelector(':scope > .je-tag-more');
            if (count === 0) { more?.remove(); continue; }
            if (!more) {
                more = document.createElement('span');
                more.className = 'je-tag-more';
            }
            if (more !== slotEl.lastElementChild) slotEl.appendChild(more);
            const text = `+${count}`;
            if (more.textContent !== text) more.textContent = text;
        }
    }

    /**
     * @typedef {Object} FitPlan
     * @property {number} pillFacts - Pill facts to keep (-1 = no pill).
     * @property {Array<{slot: HTMLElement, chips: HTMLElement[], keep: number}>} rows - Wrapping slots.
     */

    /**
     * Measure a card (reads only).
     * @param {CardController} ctrl
     * @returns {FitPlan}
     */
    function measureFit(ctrl) {
        const plan = { pillFacts: ctrl.pill ? pillFactsThatFit(ctrl.pill) : -1, rows: [] };
        for (const slotEl of rowSlots(ctrl)) {
            const chips = slotChips(slotEl);
            const more = moreChipOf(slotEl);
            if (chips.length === 0 || !more) continue;
            const style = getComputedStyle(slotEl);
            const available = slotEl.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
            const gap = parseFloat(style.columnGap) || 0;
            const widths = chips.map((chip) => chip.getBoundingClientRect().width);
            const keep = available > 0
                ? chipsThatFit(widths, available, gap, FIT_MAX_ROWS, more.getBoundingClientRect().width)
                : chips.length;
            plan.rows.push({ slot: slotEl, chips, keep });
        }
        return plan;
    }

    /**
     * How many of a pill's facts fit on one line: the lowest-priority facts
     * (with their separators) are dropped until the rest fits, so a fact is
     * either shown whole or not at all. The first fact always stays (an
     * ellipsis cuts it on a card too narrow for even that).
     * @param {HTMLElement} pill
     * @returns {number}
     */
    function pillFactsThatFit(pill) {
        const facts = Array.from(pill.querySelectorAll('.je-tag-pill-fact'));
        const excess = pill.scrollWidth - pill.clientWidth;
        let keep = facts.length;
        let freed = 0;
        while (keep > 1 && freed < excess - 0.5) {
            const fact = facts[keep - 1];
            const sep = fact.previousElementSibling;
            freed += fact.getBoundingClientRect().width + (sep ? sep.getBoundingClientRect().width : 0);
            keep--;
        }
        return keep;
    }

    /**
     * Apply a card's measurements (writes only).
     * @param {CardController} ctrl
     * @param {FitPlan} plan
     */
    function applyFit(ctrl, plan) {
        if (plan.pillFacts >= 0 && ctrl.pill) {
            Array.from(ctrl.pill.querySelectorAll('.je-tag-pill-fact')).slice(plan.pillFacts).forEach((fact) => {
                fact.setAttribute('data-je-overflow', '');
                fact.previousElementSibling?.setAttribute('data-je-overflow', '');
            });
        }
        for (const { slot, chips, keep } of plan.rows) {
            const more = moreChipOf(slot);
            if (!more) continue;
            const hidden = chips.slice(keep);
            for (const chip of hidden) chip.setAttribute('data-je-overflow', '');
            if (hidden.length === 0) {
                more.setAttribute('data-je-overflow', '');
                more.removeAttribute('title');
                continue;
            }
            more.textContent = `+${hidden.length}`;
            more.title = hidden.map(chipLabel).filter(Boolean).join(', ');
        }
    }

    // ── Public operations ──────────────────────────────────────────────

    /**
     * Commit a group's wrapper for a card and present it. The wrapper becomes
     * the group's master copy; the previous one (if any) is replaced.
     * @param {HTMLElement} target - Render target (or its .je-tag-host).
     * @param {string} groupId - Group id or renderer name.
     * @param {HTMLElement} overlay - Group wrapper with its chips.
     * @returns {boolean} True when the group has chips to show.
     */
    function commitGroup(target, groupId, overlay) {
        const group = normalizeGroup(groupId);
        if (!group || !target) return false;
        if (!overlay || overlay.children.length === 0) {
            removeGroup(target, group);
            return false;
        }
        const ctrl = controllerFor(target, true);
        if (!ctrl) return false;
        const conf = resolveLayout(ctrl);
        const previous = ctrl.groups.get(group);
        ctrl.groups.set(group, { master: overlay, seq: previous ? previous.seq : ++ctrl.seq });
        if (ctrl.layout !== conf.layout) {
            presentAll(ctrl);
        } else {
            presentGroup(ctrl, conf, group);
            if (conf.layout === 'summary') refreshPill(ctrl, conf);
            syncIndicatorGap(ctrl, conf);
            scheduleFit(ctrl);
        }
        return true;
    }

    /**
     * Remove one group from a card.
     * @param {HTMLElement} target
     * @param {string} groupId
     */
    function removeGroup(target, groupId) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? controllerFor(target, false) : null;
        if (!group || !ctrl || !ctrl.groups.has(group)) return;
        ctrl.groups.delete(group);
        removeNodes(ctrl, group);
        const conf = resolveLayout(ctrl);
        if (conf.layout === 'summary') refreshPill(ctrl, conf);
        syncIndicatorGap(ctrl, conf);
        scheduleFit(ctrl);
    }

    /**
     * Whether a card currently holds a group (the layout-aware "tagged" check).
     * @param {HTMLElement} target
     * @param {string} groupId
     * @returns {boolean}
     */
    function hasGroup(target, groupId) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? controllerFor(target, false) : null;
        return !!(group && ctrl && ctrl.groups.has(group));
    }

    /**
     * A card's master wrapper for a group (to extend it, e.g. the review
     * chip), or null. Recommit it with commitGroup() after changing it.
     * @param {HTMLElement} target
     * @param {string} groupId
     * @returns {HTMLElement|null}
     */
    function getGroup(target, groupId) {
        const group = normalizeGroup(groupId);
        const ctrl = target ? controllerFor(target, false) : null;
        return (group && ctrl?.groups.get(group)?.master) || null;
    }

    /**
     * Re-present cards from the facts they already hold: the given render
     * targets, or every card on the page.
     * @param {HTMLElement|HTMLElement[]} [targets]
     */
    function refreshPresentation(targets) {
        const list = targets === undefined
            ? Array.from(document.querySelectorAll('.je-tag-host'))
            : (Array.isArray(targets) ? targets : [targets]);
        for (const target of list) {
            const ctrl = controllerFor(/** @type {HTMLElement} */ (target), false);
            if (ctrl && ctrl.host.isConnected) presentAll(ctrl);
        }
    }

    /**
     * What a card holds, in arrival order: each group with the slot it is
     * shown in and its first placed representation (tests and the poster
     * parity harness read the layout through this).
     * @param {HTMLElement} target
     * @returns {Array<{group: string, slot: string, seq: number, element: HTMLElement|null}>}
     */
    function describe(target) {
        const ctrl = target ? controllerFor(target, false) : null;
        if (!ctrl) return [];
        const conf = resolveLayout(ctrl);
        return Array.from(ctrl.groups.entries())
            .sort((a, b) => a[1].seq - b[1].seq)
            .map(([group, rec]) => ({
                group,
                slot: conf.slots[group] === 'caption' && !ctrl.outlet ? 'poster' : (conf.slots[group] || 'off'),
                seq: rec.seq,
                element: ctrl.nodes.get(group)?.[0] || null,
            }));
    }

    /**
     * Drop everything a card shows and holds.
     * @param {HTMLElement} target
     */
    function clearCard(target) {
        // The user review key lives on the render target (the host, or the
        // image of a card without one): a lookup still out for the old item
        // checks it before adding its chip.
        if (target?.dataset) delete target.dataset.jeReviewKey;
        const host = findHost(target);
        if (host) delete host.dataset.jeReviewKey;
        const ctrl = host ? controllers.get(host) : null;
        if (!host || !ctrl) return;
        forget(ctrl);
    }

    /**
     * Tear a card's controller down and drop it.
     * @param {CardController} ctrl
     */
    function forget(ctrl) {
        teardown(ctrl);
        controllers.delete(ctrl.host);
    }

    /**
     * Remove one group from every card on the page (its tag type was turned
     * off or is about to be re-rendered).
     * @param {string} groupId
     */
    function removeGroupEverywhere(groupId) {
        for (const host of document.querySelectorAll('.je-tag-host')) removeGroup(/** @type {HTMLElement} */ (host), groupId);
    }

    /**
     * Drop every card's groups and representations, plus outlets no card
     * owns any more (the pipeline is about to re-render everything).
     */
    function clearAll() {
        for (const host of document.querySelectorAll('.je-tag-host')) clearCard(/** @type {HTMLElement} */ (host));
        document.querySelectorAll('.je-tag-caption').forEach((el) => el.remove());
        document.querySelectorAll('[data-je-review-key]').forEach((el) => { delete /** @type {HTMLElement} */ (el).dataset.jeReviewKey; });
    }

    /**
     * Reserve a card's caption space as soon as the pipeline discovers it,
     * before its tag data arrives, so the title block does not jump when the
     * chips land. No-op for other layouts and ignored contexts.
     * @param {HTMLElement} target - Render target.
     */
    function prepareCard(target) {
        if (currentSettings().layout !== 'caption' || !target) return;
        const host = ensureHost(target);
        if (!host || isIgnoredContext(host)) return;
        const ctrl = controllerFor(host, true);
        if (ctrl && ctrl.layout !== 'caption') presentAll(ctrl);
    }

    /** Toggle the body classes the layout CSS keys off (hide on hover). */
    function syncBodyClasses() {
        if (!document.body) return;
        document.body.classList.toggle('je-tags-hide-on-hover', !!JE.currentSettings?.tagsHideOnHover);
    }

    /** @type {Promise<void>|null} the pending coalesced re-present */
    let reinitPending = null;

    /**
     * Apply changed layout settings (or another user's) to every card on the
     * page, once per burst of calls: re-presents each card from the facts it
     * holds, clears cards whose item changed, removes orphaned outlets and
     * reserves caption space on cards that have none yet.
     * @returns {Promise<void>} Settles once the re-present ran.
     */
    function reinitialize() {
        invalidateSettings();
        syncBodyClasses();
        if (reinitPending) return reinitPending;
        reinitPending = Promise.resolve().then(() => {
            reinitPending = null;
            invalidateSettings();
            const owned = new Set();
            const caption = currentSettings().layout === 'caption';
            for (const host of document.querySelectorAll('.je-tag-host')) {
                const el = /** @type {HTMLElement} */ (host);
                const ctrl = controllerFor(el, caption && !isIgnoredContext(el));
                if (!ctrl) continue;
                presentAll(ctrl);
                if (ctrl.outlet) owned.add(ctrl.outlet);
            }
            document.querySelectorAll('.je-tag-caption').forEach((el) => { if (!owned.has(el)) el.remove(); });
        });
        return reinitPending;
    }

    // A user switch: forget the outgoing user's settings and every fact their
    // cards hold (they may be spoiler-stripped differently for the incoming
    // user); the pipeline re-renders the cards, and je:user-data-loaded
    // re-applies the incoming user's layout.
    JE.session?.onUserChange?.('tag-layout', () => {
        invalidateSettings();
        clearAll();
    });

    const api = {
        GROUPS: DEFAULT_ORDER.slice(),
        LAYOUT_SLOTS,
        DEFAULT_ORDER: DEFAULT_ORDER.slice(),
        DEFAULT_CAPS: { ...DEFAULT_CAPS },
        DEFAULT_PROFILES,
        CONTAINER_CLASS,
        SLOT_TO_POSITION,
        POSITION_TO_SLOT,
        POSITION_SETTINGS,
        /** @type {Function|null} set by tags/tag-layout-styles.js */
        buildStyles: null,
        normalizeGroup,
        normalizeSettings,
        invalidateSettings,
        resolveLayout,
        ensureHost,
        commitGroup,
        removeGroup,
        hasGroup,
        getGroup,
        refreshPresentation,
        describe,
        clearCard,
        clearAll,
        removeGroupEverywhere,
        prepareCard,
        compactQualityLabel,
        reinitialize,
        /** Run the pending fitting pass now (tests; the page runs it after the next paint). */
        flushFit,
        chipsThatFit,
        isGroup: (name) => GROUPS.has(/** @type {string} */ (normalizeGroup(name))),
    };
    JE.core.tagLayout = api;
    JE.reinitializeTagLayout = reinitialize;

})(window.JellyfinEnhanced);
