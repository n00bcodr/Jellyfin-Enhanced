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
// Card shapes: portrait posters (and square cards), landscape cards (episode
// thumbnails, backdrop cards) and large list rows can each have their own
// look (tagShapeOverrides). A card's shape comes from Jellyfin's card classes
// or the list row selector, else from the image's rendered aspect ratio,
// measured in the fitting pass's batched reads.
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

    /** Card shapes with a look of their own; every other card is a portrait (the default look). */
    const SHAPES = ['landscape', 'list'];
    /** A card is landscape when its image is this much wider than tall (portrait the other way; squares count as portrait). */
    const SHAPE_RATIO = 1.2;
    /** Jellyfin card classes (overflowPortraitCard, backdropCard, …) per shape. */
    const PORTRAIT_CARD = /^(?:overflow)?(?:portrait|square)card$/i;
    const LANDSCAPE_CARD = /^(?:overflow)?(?:backdrop|smallbackdrop|banner|thumb)card$/i;

    /**
     * The looks "Use recommended" gives each shape (the settings panel writes
     * them; configPage.html carries the same looks for the admin defaults).
     * Episode thumbnails: bands, compact, status and age on top, quality and
     * rating below. List rows: corners, compact, quality top left, status top
     * right, rating bottom right, up to 2 chips each.
     */
    const RECOMMENDED_SHAPES = {
        landscape: {
            layout: 'bands', density: 'compact', caps: null,
            slots: { status: 'top', ageRating: 'top', quality: 'bottom', rating: 'bottom', language: 'off', genre: 'off' },
        },
        list: {
            layout: 'corners', density: 'compact', caps: { quality: 2, status: 2, rating: 2 },
            slots: { quality: 'tl', status: 'tr', rating: 'br', ageRating: 'off', language: 'off', genre: 'off' },
        },
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

    /** The setting that turns each group's renderer on. */
    const ENABLED_SETTING = {
        quality: 'qualityTagsEnabled',
        genre: 'genreTagsEnabled',
        language: 'languageTagsEnabled',
        rating: 'ratingTagsEnabled',
        ageRating: 'ageRatingTagsEnabled',
        status: 'statusTagsEnabled',
    };
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
    /** Rows a wrapping slot (caption strip, bottom band, hover reveal) shows before its "+N" overflow chip. */
    const FIT_MAX_ROWS = 2;
    /** Cards narrower than this show bands with compact labels. */
    const NARROW_CARD_PX = 160;

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
     * @typedef {Object} TagShapeLook
     * @property {string|null} layout - null keeps the default layout.
     * @property {string|null} density - null keeps the default density.
     * @property {Object<string, string>|null} slots - group → slot over the profile of the
     *   layout the card resolves to (checked against it there).
     * @property {Object<string, number>|null} caps - group → cap over the default caps.
     */

    /**
     * One shape's look ({ layout, density, slots: [{group, slot}] or
     * { group: slot }, caps: { group: n } }, either key case), or null.
     * Unknown layouts and densities inherit (null), unknown groups and
     * slots no layout has are dropped, caps are clamped.
     * @param {*} raw
     * @returns {TagShapeLook|null}
     */
    function readShapeLook(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const layoutRaw = pick(raw, 'layout');
        const layout = typeof layoutRaw === 'string' && LAYOUTS.includes(layoutRaw.trim().toLowerCase()) ? layoutRaw.trim().toLowerCase() : null;
        const densityRaw = String(pick(raw, 'density') ?? '').trim().toLowerCase();
        const slotsRaw = pick(raw, 'slots');
        /** @type {Object<string, string>} */
        const slots = {};
        const pairs = Array.isArray(slotsRaw)
            ? slotsRaw.map((entry) => [pick(entry, 'group'), pick(entry, 'slot')])
            : (slotsRaw && typeof slotsRaw === 'object' ? Object.entries(slotsRaw) : []);
        const valid = layout ? LAYOUT_SLOTS[layout] : LAYOUTS.flatMap((name) => LAYOUT_SLOTS[name]);
        for (const [rawGroup, rawSlot] of pairs) {
            const group = normalizeGroup(rawGroup);
            const slot = typeof rawSlot === 'string' ? rawSlot.trim().toLowerCase() : '';
            if (!group || slots[group] || !valid.includes(slot) || (slot === 'dots' && group !== 'quality')) continue;
            slots[group] = slot;
        }
        /** @type {Object<string, number>} */
        const caps = {};
        const capsRaw = pick(raw, 'caps');
        for (const group of DEFAULT_ORDER) {
            const cap = readCap(pick(capsRaw, group));
            if (cap !== undefined) caps[group] = cap;
        }
        return {
            layout,
            density: densityRaw === 'compact' || densityRaw === 'full' ? densityRaw : null,
            slots: Object.keys(slots).length ? slots : null,
            caps: Object.keys(caps).length ? caps : null,
        };
    }

    /**
     * Per-shape looks ({ landscape, list }, either key case) normalised:
     * unknown shapes dropped, a missing or null shape inherits the default look.
     * @param {*} raw
     * @returns {{landscape: TagShapeLook|null, list: TagShapeLook|null}}
     */
    function readShapeOverrides(raw) {
        const out = { landscape: null, list: null };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        for (const shape of SHAPES) out[shape] = readShapeLook(pick(raw, shape));
        return out;
    }

    /**
     * Wire form of per-shape looks (slots as [{group, slot}], the form the
     * server stores); null when no shape has a look.
     * @param {{landscape?: TagShapeLook|null, list?: TagShapeLook|null}|null} shapes
     * @returns {Object|null}
     */
    function shapesToWire(shapes) {
        if (!shapes || !SHAPES.some((shape) => shapes[shape])) return null;
        /** @type {Object<string, Object|null>} */
        const out = {};
        for (const shape of SHAPES) {
            const look = shapes[shape];
            out[shape] = look ? {
                layout: look.layout || null,
                density: look.density || null,
                slots: look.slots ? Object.entries(look.slots).map(([group, slot]) => ({ group, slot })) : null,
                caps: look.caps ? { ...look.caps } : null,
            } : null;
        }
        return out;
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
     * @property {boolean} reserveCaption - Caption layout with at least one enabled group in
     *   the caption slot: cards reserve the strip before their data arrives.
     * @property {boolean} orderChosen - The order was set by the user or administrator.
     * @property {boolean} locked - The look comes from a per-item lock.
     * @property {{landscape: TagShapeLook|null, list: TagShapeLook|null}} shapes - The
     *   per-shape looks in effect (the user's own, else the administrator's on a
     *   normalized document; none on a legacy one unless the user set them).
     * @property {string} lookKey - Identifies the presentation (see lookKeyOf).
     */

    /**
     * Resolve the effective layout settings from a user document and the
     * administrator defaults. A legacy document (no tagLayoutSettingsVersion)
     * keeps corners with its position settings, arrival ordering, full labels
     * and the built-in limits — exactly what it showed before layouts existed —
     * whatever the administrator's new defaults are. A normalized document
     * inherits each slot and cap it does not set: user → administrator →
     * built-in. Its priority order is its own: without one, corners keeps
     * arrival order and the other layouts use the default order (the
     * administrator's order reaches users only through new-user seeding,
     * "apply defaults to all users" and Reset, which copy it).
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
        let orderChosen = false;
        if (!legacy) {
            const own = readOrder(s.tagGroupOrder);
            orderChosen = !!own;
            const chosen = own || (layout === 'corners' ? null : DEFAULT_ORDER);
            if (chosen) order = chosen.concat(DEFAULT_ORDER.filter((g) => !chosen.includes(g)));
        }

        const caps = {};
        for (const group of DEFAULT_ORDER) {
            const own = legacy ? undefined : readCap(pick(s.tagGroupCaps, group));
            const admin = legacy ? undefined : readCap(pick(pick(p, 'tagGroupCaps'), group));
            caps[group] = own ?? admin ?? DEFAULT_CAPS[group];
        }

        // Only a group that is switched on can still fill the caption strip.
        const reserveCaption = layout === 'caption'
            && DEFAULT_ORDER.some((g) => profiles.caption[g] === 'caption' && !!s[ENABLED_SETTING[g]]);

        // Per-shape looks: the document's own; without one, a normalized
        // document inherits the administrator's and a legacy one has none.
        const ownShapes = s.tagShapeOverrides;
        const shapes = readShapeOverrides(ownShapes && typeof ownShapes === 'object' ? ownShapes : (legacy ? null : pick(p, 'tagShapeOverrides')));

        const conf = { layout, legacy, density, order, orderChosen, caps, profiles, slots: profiles[layout], indicatorGap, reserveCaption, locked: false, shapes, lookKey: '' };
        conf.lookKey = lookKeyOf(conf);
        return conf;
    }

    /**
     * Make a legacy document (no tagLayoutSettingsVersion) a normalized one
     * without changing what it shows, before the first layout write: corners,
     * full labels, the built-in limits as explicit caps (so the administrator's
     * caps do not take over), no order (arrival order), and explicit personal
     * rules (so the administrator's rules do not take over). The position
     * settings and any corners profile already read the same either way.
     * Every caller that writes version 1 must call this first.
     * @param {Object} [settings] - Defaults to JE.currentSettings; changed in place.
     * @returns {boolean} True when the document was promoted.
     */
    function promoteLegacySettings(settings) {
        const s = settings || JE.currentSettings;
        if (!s || Number(s.tagLayoutSettingsVersion) >= 1) return false;
        s.tagLayout = 'corners';
        s.tagLabelDensity = 'full';
        s.tagGroupCaps = { ...DEFAULT_CAPS };
        s.tagGroupOrder = null;
        if (!Array.isArray(s.tagLookRules)) s.tagLookRules = [];
        // Promotion by any layout control must not opt a legacy user into
        // the administrator's shape looks. Only an explicit shape edit does.
        if (!s.tagShapeOverrides || typeof s.tagShapeOverrides !== 'object' || Array.isArray(s.tagShapeOverrides)) {
            s.tagShapeOverrides = { landscape: null, list: null };
        }
        s.tagLayoutSettingsVersion = 1;
        if (s === JE.currentSettings) invalidateSettings();
        return true;
    }

    /**
     * A string that differs whenever two settings would present a card
     * differently (layout, density, slots, caps — a shape look can change
     * them —, lock marker).
     * @param {TagLayoutSettings} conf
     * @returns {string}
     */
    function lookKeyOf(conf) {
        return [conf.layout, conf.density, conf.locked ? 'L' : '', DEFAULT_ORDER.map((g) => conf.slots[g] || '').join(','),
            DEFAULT_ORDER.map((g) => conf.caps[g]).join(',')].join('|');
    }

    /** @type {TagLayoutSettings|null} memoised until the next invalidateSettings() */
    let cachedSettings = null;
    /** What the memo was computed from (see settingsSource). */
    let cachedSource = null;

    /**
     * The inputs the memoised settings must still match: the settings and
     * plugin objects (the panel reloads replace them) and the tag toggles
     * (reserveCaption depends on them, and they change without a layout edit).
     * @returns {{settings: *, plugin: *, enabled: string}}
     */
    function settingsSource() {
        const s = JE.currentSettings;
        return { settings: s, plugin: JE.pluginConfig, enabled: DEFAULT_ORDER.map((g) => (s?.[ENABLED_SETTING[g]] ? '1' : '0')).join('') };
    }

    /** @returns {TagLayoutSettings} */
    function currentSettings() {
        const source = settingsSource();
        if (!cachedSettings || !cachedSource || cachedSource.settings !== source.settings
            || cachedSource.plugin !== source.plugin || cachedSource.enabled !== source.enabled) {
            cachedSettings = normalizeSettings();
            cachedSource = source;
        }
        return cachedSettings;
    }

    /** Forget the memoised settings (they changed, or the user switched). */
    function invalidateSettings() {
        cachedSettings = null;
        cachedLooks = null;
        lookSettingsCache.clear();
    }

    /** @type {{rules: Array<Object>, locks: Map<string, Object>}|null} memoised rules and locks */
    let cachedLooks = null;
    /** @type {Map<string, TagLayoutSettings>} derived settings per rule/lock look */
    const lookSettingsCache = new Map();

    /** @returns {{rules: Array<Object>, locks: Map<string, Object>}} The user's rules and locks (core/tag-look.js). */
    function currentLooks() {
        if (!cachedLooks) cachedLooks = JE.core.tagLook?.read() || { rules: [], locks: new Map() };
        return cachedLooks;
    }

    /**
     * The slots of a look that are valid in a layout (a shape look that keeps
     * the default layout may name another layout's slots).
     * @param {string} layout
     * @param {Object<string, string>|null|undefined} slots
     * @returns {Object<string, string>}
     */
    function validSlots(layout, slots) {
        /** @type {Object<string, string>} */
        const out = {};
        for (const [group, slot] of Object.entries(slots || {})) {
            if (GROUPS.has(group) && LAYOUT_SLOTS[layout].includes(slot) && (slot !== 'dots' || group === 'quality')) out[group] = slot;
        }
        return out;
    }

    /**
     * A look with a card shape's look laid over it: the shape's layout and
     * density where it sets them, its slots over the look's (only the
     * shape's own when it switches to another layout, whose profile fills
     * the rest) and its caps over the look's.
     * @param {{layout: string|null, density: string|null, slots: Object<string, string>|null, caps?: Object<string, number>|null}} look
     * @param {TagShapeLook|null|undefined} shapeLook
     * @returns {{layout: string|null, density: string|null, slots: Object<string, string>|null, caps: Object<string, number>|null}}
     */
    function withShape(look, shapeLook) {
        if (!shapeLook) return { ...look, caps: look.caps || null };
        const switches = !!shapeLook.layout && shapeLook.layout !== look.layout;
        const slots = switches ? shapeLook.slots : (look.slots || shapeLook.slots ? { ...(look.slots || {}), ...(shapeLook.slots || {}) } : null);
        const caps = look.caps || shapeLook.caps ? { ...(look.caps || {}), ...(shapeLook.caps || {}) } : null;
        return { layout: shapeLook.layout || look.layout, density: shapeLook.density || look.density, slots, caps };
    }

    /**
     * The settings a look (a rule's, a lock's or a card shape's) gives a
     * card: the user's settings with the look's layout and density (the
     * user's where it sets none), its slot overrides (a lock carries the
     * whole profile it was locked with) over the user's profile for that
     * layout, and its caps over the user's. Order stays the user's.
     * Memoised per look.
     * @param {TagLayoutSettings} base
     * @param {{layout: string|null, density: string|null, slots: Object<string, string>|null, caps?: Object<string, number>|null}} look
     * @param {boolean} locked
     * @returns {TagLayoutSettings}
     */
    function lookSettings(base, look, locked) {
        const layout = look.layout ? normalizeLayout(look.layout) : base.layout;
        const own = validSlots(layout, look.slots);
        const slots = { ...base.profiles[layout], ...own };
        const conf = {
            ...base,
            layout,
            density: look.density ? (look.density === 'compact' ? 'compact' : 'full') : base.density,
            caps: look.caps ? { ...base.caps, ...look.caps } : base.caps,
            // A chosen order applies everywhere; otherwise corners keeps
            // arrival order and the other layouts the built-in order.
            order: base.orderChosen ? base.order : (layout === 'corners' ? null : DEFAULT_ORDER),
            profiles: { ...base.profiles, [layout]: slots },
            slots,
            indicatorGap: Object.keys(own).length && layout === 'corners'
                ? new Set(DEFAULT_ORDER.filter((g) => slots[g] === 'tr')) : base.indicatorGap,
            reserveCaption: layout === 'caption'
                && DEFAULT_ORDER.some((g) => slots[g] === 'caption' && !!JE.currentSettings?.[ENABLED_SETTING[g]]),
            locked,
            lookKey: '',
        };
        conf.lookKey = lookKeyOf(conf);
        const memo = lookSettingsCache.get(conf.lookKey + '|' + (conf.order ? 'o' : ''));
        if (memo) return memo;
        lookSettingsCache.set(conf.lookKey + '|' + (conf.order ? 'o' : ''), conf);
        return conf;
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
     * @property {boolean} [narrow] - Last measured narrower than NARROW_CARD_PX (bands go compact).
     * @property {HTMLElement|null} [moreTip] - Names of the chips behind "+N" chips (moreTipOf).
     * @property {HTMLElement|null} [described] - The card link whose aria-describedby names moreTip.
     * @property {string} lookKey - lookKey of the settings the card is presented with.
     * @property {boolean} [pendingPresentation] - A detached card needs presentation on reconnection.
     * @property {string|null} shape - 'portrait', 'landscape' or 'list'; null until the
     *   fitting pass measured a card its classes don't classify (see shapeOfCard).
     */

    /** @type {WeakMap<HTMLElement, CardController>} host → controller */
    const controllers = new WeakMap();
    /** @type {WeakMap<HTMLElement, Object>} render target / host → what the card's item data says (setCardContext) */
    let cardData = new WeakMap();
    /** @type {WeakMap<HTMLElement, {cardId: string, timer: *, token: {cardId: string, generation: number}}>} render target / host → item data the card waits for (awaitCardContext) */
    let awaitingData = new WeakMap();
    let waitGeneration = 0;
    // A card waiting for its item data shows its tags after this long even
    // when the data never comes (a failed fetch the pipeline didn't report).
    const AWAIT_CONTEXT_MS = 8000;
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
     * A card's shape from its markup alone: a large list row by its image
     * selector, an explicit data-je-shape (the settings panel's samples),
     * else Jellyfin's card shape class (overflowPortraitCard, backdropCard,
     * squareCard, …; square cards count as portrait). Null when the markup
     * doesn't say (the fitting pass then measures the image).
     * @param {Element|null} el - The host, render target or any element of the card.
     * @returns {string|null}
     */
    function shapeOfCard(el) {
        if (!el || typeof el.closest !== 'function') return null;
        if (el.closest('.listItemImage-large')) return 'list';
        // The host's marker describes output; only an ancestor may declare
        // an input shape (the preview samples). Never classify from stale output.
        const origin = el.classList.contains('je-tag-host') ? el.parentElement : el;
        const explicit = origin?.closest('[data-je-shape]:not(.je-tag-host)')?.getAttribute('data-je-shape');
        if (explicit === 'portrait' || SHAPES.includes(explicit || '')) return explicit;
        const card = el.closest('.card');
        if (!card) return null;
        for (const cls of card.classList) {
            if (PORTRAIT_CARD.test(cls)) return 'portrait';
            if (LANDSCAPE_CARD.test(cls)) return 'landscape';
        }
        return null;
    }

    /**
     * A card's shape from its image's rendered size: landscape when it is
     * clearly wider than tall, else portrait (squares included).
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    function shapeOfSize(width, height) {
        return width > 0 && height > 0 && width / height > SHAPE_RATIO ? 'landscape' : 'portrait';
    }

    /**
     * The shape a card context resolves with: a controller's (portrait while
     * still unmeasured), an element's controller's or markup's, or a plain
     * item description's `shape`; portrait otherwise.
     * @param {CardController|HTMLElement|Object} cardContext
     * @returns {string}
     */
    function shapeOf(cardContext) {
        if (cardContext?.host && cardContext.groups) return cardContext.shape || 'portrait';
        if (cardContext?.nodeType === 1) {
            const el = /** @type {HTMLElement} */ (cardContext);
            const ctrl = controllers.get(findHost(el) || el);
            return ctrl?.shape || shapeOfCard(el) || 'portrait';
        }
        return SHAPES.includes(cardContext?.shape) ? cardContext.shape : 'portrait';
    }

    /**
     * Whether any look depends on the card shape: a shape look in the
     * settings, or a rule or lock that carries one. Without, every card
     * resolves as before shapes existed and nothing is measured.
     * @returns {boolean}
     */
    function shapesInUse() {
        const base = currentSettings();
        if (SHAPES.some((shape) => base.shapes[shape])) return true;
        const looks = currentLooks();
        return looks.rules.some((rule) => !!rule.shapes) || Array.from(looks.locks.values()).some((lock) => !!lock.shapes);
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
            ctrl = { host, itemId, groups: new Map(), nodes: new Map(), outlet: null, pill: null, layout: null, seq: 0, moreTip: null, described: null, lookKey: '', shape: shapeOfCard(host) };
            controllers.set(host, ctrl);
        }
        return ctrl;
    }

    /**
     * What is known about the item a card (or a plain description of an
     * item) shows, for matching rules and locks: the card's type
     * (data-type, which can differ from the fetched item's when an episode
     * card shows series artwork) and the item data the pipeline passed to
     * setCardContext() — ignored once the card shows another item.
     * @param {CardController|HTMLElement|Object} cardContext
     * @returns {Object} CardFacts (core/tag-look.js)
     */
    function cardFacts(cardContext) {
        const look = JE.core.tagLook;
        const el = cardContext?.host || (cardContext?.nodeType === 1 ? cardContext : null);
        if (!el) return look.factsFrom(cardContext, { itemId: cardContext?.itemId, cardType: cardContext?.cardType || null });
        const cardId = cardContext.host ? cardContext.itemId : identityOf(el);
        const data = contextOf(cardData, el);
        const usable = data && (!data.cardId || data.cardId === cardId);
        const cardType = el.closest('[data-type]')?.getAttribute('data-type') || null;
        return look.factsFrom(usable ? data.entry : null, { itemId: usable ? data.itemId : '', cardId, cardType });
    }

    /**
     * A per-card record kept for a render target or its host: the pipeline
     * may hand over the target before the host inside it exists.
     * @template T
     * @param {WeakMap<HTMLElement, T>} map
     * @param {HTMLElement} el - Host or render target.
     * @returns {T|undefined}
     */
    function contextOf(map, el) {
        return map.get(el) || (el.parentElement ? map.get(el.parentElement) : undefined);
    }

    /**
     * Whether some rule or lock could give this card another look once its
     * item data (library, genres, rating, series) is known. Without rules
     * and locks, or with type-only rules on a typed card, it cannot.
     * @param {string|null} cardType - The card's data-type.
     * @returns {boolean}
     */
    function needsCardData(cardType) {
        const looks = currentLooks();
        if (!looks.rules.length && !looks.locks.size) return false;
        if (!cardType) return true;
        if (looks.rules.some((rule) => rule.enabled && rule.when.some((cond) => cond.field !== 'type'))) return true;
        // A season or episode inherits its series' lock: the series id comes with the data.
        return looks.locks.size > 0 && (cardType === 'Season' || cardType === 'Episode');
    }

    /**
     * Whether a card's tags wait for its item data (see awaitCardContext).
     * @param {HTMLElement} host
     * @returns {boolean}
     */
    function isAwaiting(host) {
        const rec = contextOf(awaitingData, host);
        return !!rec && rec.cardId === identityOf(host);
    }

    /**
     * The look decision for one card, and the only place it is made:
     * a lock on the item (or, for a season or episode, on its series) →
     * the first enabled rule whose conditions all hold → the look of the
     * card's shape (landscape cards, list rows) → the user's default layout
     * and density. A lock or rule may carry its own per-shape looks, laid
     * over its look on cards of that shape. With no rules, no locks and no
     * shape looks every card follows the user's settings, exactly as before.
     * @param {CardController|HTMLElement|Object} cardContext - A card
     *   controller, a card element, or a plain item description
     *   ({ itemId, cardType, Type, Genres, OfficialRating, LibraryId, SeriesId, shape }).
     * @returns {TagLayoutSettings}
     */
    function resolveLayout(cardContext) {
        const base = currentSettings();
        const source = lookSource(cardContext);
        const shape = source.shape;
        if (source.lock) return lookSettings(base, withShape(source.lock, source.lock.shapes?.[shape]), true);
        if (source.rule) return lookSettings(base, withShape(source.rule, source.rule.shapes?.[shape]), false);
        if (source.source === 'shape') {
            return lookSettings(base, withShape({ layout: base.layout, density: base.density, slots: null, caps: null }, base.shapes[shape]), false);
        }
        return base;
    }

    /**
     * Where a card's look comes from: its lock, the first enabled rule that
     * matches (with its position in the user's rule list), its shape's look,
     * or the default. resolveLayout() decides through this, so a caller that
     * names the source (the settings panel's preview) always agrees with the
     * cards.
     * @param {CardController|HTMLElement|Object} cardContext - As for resolveLayout.
     * @returns {{source: 'lock'|'rule'|'shape'|'default', lock: Object|null, rule: Object|null, index: number, shape: string}}
     *   index is the rule's position in the list (-1 otherwise); shape is the card's shape.
     */
    function lookSource(cardContext) {
        const looks = currentLooks();
        const shape = shapeOf(cardContext);
        const shaped = SHAPES.includes(shape) && !!currentSettings().shapes[shape];
        const none = { source: /** @type {'shape'|'default'} */ (shaped ? 'shape' : 'default'), lock: null, rule: null, index: -1, shape };
        if (!looks.rules.length && !looks.locks.size) return none;
        const facts = cardFacts(cardContext);
        const lock = JE.core.tagLook.findLock(looks.locks, facts);
        if (lock) return { source: 'lock', lock, rule: null, index: -1, shape };
        const rule = JE.core.tagLook.firstMatch(looks.rules, facts);
        return rule ? { source: 'rule', lock: null, rule, index: looks.rules.indexOf(rule), shape } : none;
    }

    /**
     * The identity of the item a card shows (its data-id), to capture when
     * the card's item data is requested and hand back with setCardContext.
     * Distinct from the artwork id the pipeline resolves, which can name the
     * series an episode card borrows its image from.
     * @param {HTMLElement} target - Render target.
     * @returns {string}
     */
    function cardIdentity(target) {
        return target ? identityOf(findHost(target) || target) : '';
    }

    /**
     * Record what the item data says about a card (type, genres, rating,
     * library, series) so rules can match it, and re-present the card if its
     * look changes. The pipeline calls this before rendering a card from a
     * server-cache entry, remembered item data or a fetched item. Data for a
     * card that shows another item by now (a reused virtualised card) is
     * dropped.
     * @param {HTMLElement} target - Render target.
     * @param {Object} entry - Tag-cache entry or /tag-data item.
     * @param {string} itemId - The id the pipeline resolved for the card.
     * @param {string} [cardId] - cardIdentity() when the data was requested;
     *   omitted, the card's identity now.
     * @returns {boolean} False when the data was dropped.
     */
    function setCardContext(target, entry, itemId, cardId) {
        if (!target || !entry) return false;
        const host = findHost(target) || target;
        const current = identityOf(host);
        if (cardId !== undefined && cardId !== null && cardId !== current) return false;
        cardData.set(host, { entry, itemId, cardId: current });
        const waited = endAwait(host);
        const ctrl = controllers.get(host);
        if (!ctrl || !ctrl.host.isConnected || !ctrl.groups.size) return true;
        const looks = currentLooks();
        if (waited || ((looks.rules.length || looks.locks.size) && resolveLayout(ctrl).lookKey !== ctrl.lookKey)) presentAll(ctrl);
        return true;
    }

    /**
     * Hold a card's tags back until its item data arrives (setCardContext)
     * when a rule or lock could change its look, so its chips don't land in
     * the default look first and then move. Caption space follows the
     * default meanwhile. The pipeline calls this for a card it has no item
     * data for yet and then fetches the data.
     * @param {HTMLElement} target - Render target.
     * @param {string} cardId - cardIdentity() of the card.
     * @param {string|null} cardType - The card's data-type.
     * @returns {{cardId: string, generation: number}|false} Token for this hold, or false when no data is needed.
     */
    function awaitCardContext(target, cardId, cardType) {
        if (!target || !needsCardData(cardType)) return false;
        const host = findHost(target) || target;
        endAwait(host);
        const token = { cardId, generation: ++waitGeneration };
        const timer = setTimeout(() => releaseCardContext(target, token), AWAIT_CONTEXT_MS);
        awaitingData.set(host, { cardId, timer, token });
        return token;
    }

    /**
     * Stop a card waiting.
     * @param {HTMLElement} el - Host or render target the wait was recorded on.
     * @returns {boolean} Whether it was waiting.
     */
    function endAwait(el) {
        let waited = false;
        for (const key of [el, el.parentElement]) {
            const rec = key ? awaitingData.get(key) : undefined;
            if (!rec) continue;
            clearTimeout(rec.timer);
            awaitingData.delete(key);
            waited = true;
        }
        return waited;
    }

    /**
     * Show a waiting card's tags in the look known without its item data
     * (the fetch failed or returned nothing for it). No-op for other cards.
     * @param {HTMLElement} target - Render target.
     * @param {{cardId: string, generation: number}} token - The hold being released.
     */
    function releaseCardContext(target, token) {
        if (!target) return;
        const host = findHost(target) || target;
        const rec = contextOf(awaitingData, host);
        if (!rec || rec.token !== token || token.cardId !== identityOf(host)) return;
        if (!endAwait(host)) return;
        const ctrl = controllers.get(host);
        if (!ctrl || !ctrl.groups.size) return;
        if (ctrl.host.isConnected) presentAll(ctrl);
        else ctrl.pendingPresentation = true;
    }

    /**
     * Finish a detached card's safety release when a scan sees it reattached.
     * @param {HTMLElement} target - Existing render target; never creates a host.
     */
    function resumePresentation(target) {
        const ctrl = target ? controllerFor(target, false) : null;
        if (ctrl?.pendingPresentation && ctrl.host.isConnected) presentAll(ctrl);
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
     * quality and status labels and drops the critic chip next to a community score;
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
            } else if (group === 'status') {
                // Status badges carry their own short label ("Season Premiere" → "Premiere").
                for (const chip of node.querySelectorAll('[data-je-compact]')) {
                    chip.textContent = /** @type {HTMLElement} */ (chip).dataset.jeCompact || chip.textContent;
                }
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
            const chips = buildChips(group, rec.master, slot === 'hover' || (conf.layout === 'bands' && ctrl.narrow) ? revealSettings(conf) : conf);
            if (conf.layout === 'corners') chips.dataset.jeCorner = SLOT_TO_POSITION[slot];
            // The original web rule for settings saved before layouts: only a
            // container set to exactly top-right clears the played indicator.
            if (conf.layout === 'corners' && conf.legacy && conf.indicatorGap.has(group)) chips.dataset.jeIndicatorGap = '1';
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
     * Jellyfin's played / unplayed-count indicator (the Native Poster Tags
     * rule). Settings saved before layouts mark that group's container
     * instead (presentGroup), as the web always did.
     * @param {CardController} ctrl
     * @param {TagLayoutSettings} conf
     */
    function syncIndicatorGap(ctrl, conf) {
        const on = conf.layout === 'corners' && !conf.legacy
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
        describeHidden(ctrl, []);
        ctrl.layout = null;
        ctrl.lookKey = '';
        delete ctrl.host.dataset.jeLayout;
        delete ctrl.host.dataset.jeLegacy;
        delete ctrl.host.dataset.jeLocked;
        delete ctrl.host.dataset.jeIndicatorGap;
        delete ctrl.host.dataset.jeShape;
    }

    /**
     * Re-present every group of a card for the current layout settings.
     * @param {CardController} ctrl
     */
    function presentAll(ctrl) {
        ctrl.pendingPresentation = false;
        const declaredShape = shapeOfCard(ctrl.host);
        if (declaredShape) ctrl.shape = declaredShape;
        const conf = resolveLayout(ctrl);
        const shaped = shapesInUse();
        teardown(ctrl);
        ctrl.layout = conf.layout;
        ctrl.lookKey = conf.lookKey;
        ctrl.host.dataset.jeLayout = conf.layout;
        if (shaped) {
            // A card its markup doesn't classify waits for the fitting pass
            // to measure its image, so its chips don't land in the portrait
            // look first and then move.
            if (ctrl.shape === null) {
                ctrl.lookKey = '';
                scheduleFit(ctrl);
                return;
            }
            ctrl.host.dataset.jeShape = ctrl.shape;
        }
        // Settings saved before layouts keep the original web geometry
        // (tags/tag-layout-styles.js keys its legacy rules off this).
        if (conf.legacy) ctrl.host.dataset.jeLegacy = '1';
        if (conf.reserveCaption && !isIgnoredContext(ctrl.host)) ensureOutlet(ctrl);
        if (conf.locked) ctrl.host.dataset.jeLocked = '1';
        // Waiting for item data: keep the groups, show none yet.
        if (isAwaiting(ctrl.host)) return;
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
    //   - in the caption strip, the bottom band and the hover reveal, chips
    //     past their two rows (fewer when the reveal's share of the card
    //     height has room for less), lowest priority first, behind a "+N"
    //     chip whose title names them;
    // and it switches bands on cards narrower than NARROW_CARD_PX to compact
    // labels. Corners cards are left alone, except one saved before layouts
    // with a container set to exactly top-right below another container: how
    // far that one moves to clear Jellyfin's indicator depends on the height
    // of the containers above it (indicatorGapsToMeasure).

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
        const wrapping = ctrl.layout === 'bands' ? 'bottom' : 'hover';
        for (const child of ctrl.host.children) {
            if (child.classList.contains('je-tag-slot') && /** @type {HTMLElement} */ (child).dataset.jeSlot === wrapping) {
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
     * Which chips a wrapping row shows within maxRows rows. When they do not
     * all fit, chips are placed in priority order the way flex-wrap lays
     * them out (a chip joins the current row if it fits after the gap, else
     * starts the next row), keeping room for the "+N" chip at the end of the
     * last row; a chip with no room left is hidden and the chips after it
     * still fill the space, so a wide label never leaves a row empty.
     * @param {number[]} widths - Chip widths in display order.
     * @param {number} available - Content width of the row.
     * @param {number} gap - Gap between chips.
     * @param {number} maxRows
     * @param {number} moreWidth - Width of the "+N" chip.
     * @param {number[]} [rowsOut] - Filled with each chip's row (1-based; 0 when hidden).
     * @param {{row: number}} [moreOut] - Receives the row the "+N" chip lands on
     *   (0 when every chip is shown): the last row with chips when it has room
     *   after them, else the row below, which flex wraps it onto.
     * @returns {boolean[]} Per chip, whether it is shown.
     */
    function chipsThatFit(widths, available, gap, maxRows, moreWidth, rowsOut, moreOut) {
        // Flex wraps a chip that overflows by any fraction of a pixel.
        const fits = (need, room) => need <= room + 0.01;
        /** @type {number[]} */
        const rowOf = [];
        let rows = 0;
        let x = 0;
        for (const w of widths) {
            if (rows === 0 || !fits(x + gap + w, available)) { rows++; x = w; } else x += gap + w;
            rowOf.push(rows);
        }
        if (rows <= maxRows && widths.every((w) => fits(w, available))) {
            rowsOut?.push(...rowOf);
            if (moreOut) moreOut.row = 0;
            return widths.map(() => true);
        }
        const roomOn = (row) => (row === maxRows ? available - gap - moreWidth : available);
        let row = 1;
        x = 0;
        const shown = widths.map((w) => {
            if (fits(x === 0 ? w : x + gap + w, roomOn(row))) {
                x = x === 0 ? w : x + gap + w;
                rowsOut?.push(row);
                return true;
            }
            if (row < maxRows && x > 0 && fits(w, roomOn(row + 1))) {
                row++;
                x = w;
                rowsOut?.push(row);
                return true;
            }
            rowsOut?.push(0);
            return false;
        });
        // Room for "+N" is only reserved on the last allowed row; when the shown
        // chips stop on an earlier row it wraps below them unless it fits after them.
        if (moreOut) moreOut.row = x === 0 || fits(x + gap + moreWidth, available) ? Math.max(1, row) : row + 1;
        return shown;
    }

    /** @type {Set<CardController>} cards waiting for the next fitting pass */
    const pendingFit = new Set();
    let fitScheduled = false;
    let fitting = false;

    /** Inline custom property: how far down its slot an exact top-right container sits without its margin. */
    const INDICATOR_BEFORE = '--je-indicator-before';

    /**
     * The top-right slot of a corners card saved before layouts, when it has
     * a container set to exactly top-right whose indicator margin needs a
     * measurement: one right below a container that is not (one below an
     * exact container already clears the indicator: the stylesheet default
     * gives it no margin), or one that kept an earlier measurement (it may
     * have moved since). Null otherwise.
     * @param {CardController} ctrl
     * @returns {HTMLElement|null}
     */
    function indicatorGapsToMeasure(ctrl) {
        if (ctrl.layout !== 'corners' || ctrl.host.dataset.jeLegacy !== '1') return null;
        for (const child of ctrl.host.children) {
            const slot = /** @type {HTMLElement} */ (child);
            if (!slot.classList.contains('je-tag-slot') || slot.dataset.jeSlot !== 'tr') continue;
            const items = /** @type {HTMLElement[]} */ (Array.from(slot.children));
            const needs = items.some((el, i) => !!el.dataset.jeIndicatorGap
                && ((i > 0 && !items[i - 1].dataset.jeIndicatorGap) || !!el.style.getPropertyValue(INDICATOR_BEFORE)));
            return needs ? slot : null;
        }
        return null;
    }

    /**
     * Whether the fitting pass must measure a card's shape: its markup
     * doesn't classify it and some look depends on the shape. Measured
     * shapes are read again on the next fit, since responsive images can
     * change aspect ratio without changing their item identity.
     * @param {CardController} ctrl
     * @returns {boolean}
     */
    function needsShape(ctrl) {
        return shapeOfCard(ctrl.host) === null && shapesInUse();
    }

    /**
     * Queue a card for the next fitting pass (cards that need one only).
     * @param {CardController} ctrl
     */
    function scheduleFit(ctrl) {
        if (fitting || !(FIT_LAYOUTS.has(ctrl.layout || '') || indicatorGapsToMeasure(ctrl) || needsShape(ctrl))) return;
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
            // Reads: cards not laid out (hidden, detached tab) are left as they
            // are. The image's height only for cards whose shape is measured.
            const widths = list.map((ctrl) => ctrl.host.clientWidth);
            const heights = list.map((ctrl, i) => (widths[i] > 0 && needsShape(ctrl) ? ctrl.host.clientHeight : 0));
            const shown = list.filter((ctrl, i) => widths[i] > 0);
            // Writes: a card whose shape was measured is presented in its
            // shape's look (one not laid out as a portrait, measured again
            // next time); bands that crossed the narrow-card width re-present
            // with the other labels; then show what an earlier pass hid, and
            // give every wrapping slot its "+N" chip, so both are measured afresh.
            const presented = new Set();
            const narrowed = new Set();
            list.forEach((ctrl, i) => {
                const narrow = widths[i] > 0 && widths[i] < NARROW_CARD_PX;
                if (widths[i] === 0 || narrow === !!ctrl.narrow) return;
                ctrl.narrow = narrow;
                narrowed.add(ctrl);
            });
            list.forEach((ctrl, i) => {
                if (!needsShape(ctrl)) return;
                const shape = widths[i] > 0 ? shapeOfSize(widths[i], heights[i]) : 'portrait';
                const changed = shape !== ctrl.shape;
                ctrl.shape = shape;
                if (changed) { presentAll(ctrl); presented.add(ctrl); }
            });
            for (const ctrl of narrowed) {
                if (ctrl.layout === 'bands' && !presented.has(ctrl)) presentAll(ctrl);
            }
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
     * @property {Array<{slot: HTMLElement, chips: HTMLElement[], shown: boolean[], more: boolean}>} rows -
     *   Wrapping slots; `more` is false when not even the "+N" chip has room.
     * @property {Array<{el: HTMLElement, before: number|null}>} indicator - Exact top-right containers
     *   of a corners card saved before layouts, with how far down their slot they sit unmoved
     *   (null: the stylesheet default).
     */

    /**
     * The height a wrapping slot has for its chip rows, or null when it is not
     * limited (reads only). Only a slot with a max-height is: the hover reveal,
     * held to the bottom 40% of the card. Its rows must fit inside that height
     * less its padding; on a card too short for even one row that way (a small
     * landscape thumbnail), one row may sit in the top padding, which is only
     * the scrim's fade-in, while it still fits above the bottom padding.
     * @param {CardController} ctrl
     * @param {CSSStyleDeclaration} style - The slot's computed style.
     * @returns {{inside: number, oneRow: number, gap: number}|null}
     */
    function rowRoom(ctrl, style) {
        const raw = style.maxHeight;
        if (!raw || raw === 'none') return null;
        let limit = parseFloat(raw);
        if (raw.endsWith('%')) {
            // The slot is positioned in the host, which covers the image.
            const height = ctrl.host.clientHeight;
            if (!(height > 0)) return null;
            limit = (limit / 100) * height;
        }
        if (!Number.isFinite(limit)) return null;
        const padTop = parseFloat(style.paddingTop) || 0;
        const padBottom = parseFloat(style.paddingBottom) || 0;
        return { inside: limit - padTop - padBottom, oneRow: limit - padBottom, gap: parseFloat(style.rowGap) || 0 };
    }

    /**
     * Height of the rows a fit lays out: each row as tall as its tallest
     * shown chip, the "+N" chip (when chips are hidden) on the last row.
     * @param {boolean[]} shown
     * @param {number[]} rows - Row per chip (chipsThatFit's rowsOut).
     * @param {number[]} heights - Chip heights.
     * @param {number} moreHeight
     * @param {number} gap - Gap between rows.
     * @param {number} moreRow - Row the "+N" chip lands on (chipsThatFit's moreOut), 0 when none.
     * @returns {number}
     */
    function rowsHeight(shown, rows, heights, moreHeight, gap, moreRow) {
        /** @type {number[]} */
        const tallest = [];
        shown.forEach((on, i) => { if (on) tallest[rows[i] - 1] = Math.max(tallest[rows[i] - 1] || 0, heights[i]); });
        if (shown.includes(false) && moreRow > 0) tallest[moreRow - 1] = Math.max(tallest[moreRow - 1] || 0, moreHeight);
        const used = tallest.filter((h) => h !== undefined);
        return used.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, used.length - 1);
    }

    /**
     * Measure a card (reads only).
     * @param {CardController} ctrl
     * @returns {FitPlan}
     */
    function measureFit(ctrl) {
        const plan = { pillFacts: ctrl.pill ? pillFactsThatFit(ctrl.pill) : -1, rows: [], indicator: measureIndicatorGaps(ctrl) };
        for (const slotEl of rowSlots(ctrl)) {
            const chips = slotChips(slotEl);
            const more = moreChipOf(slotEl);
            if (chips.length === 0 || !more) continue;
            const style = getComputedStyle(slotEl);
            const available = slotEl.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
            const gap = parseFloat(style.columnGap) || 0;
            const rects = chips.map((chip) => chip.getBoundingClientRect());
            const widths = rects.map((r) => r.width);
            const moreRect = more.getBoundingClientRect();
            if (!(available > 0)) {
                plan.rows.push({ slot: slotEl, chips, shown: chips.map(() => true), more: true });
                continue;
            }
            const room = rowRoom(ctrl, style);
            if (!room) {
                plan.rows.push({ slot: slotEl, chips, shown: chipsThatFit(widths, available, gap, FIT_MAX_ROWS, moreRect.width), more: true });
                continue;
            }
            // As many whole rows as the height has room for, "+N" included.
            let shown = null;
            for (let n = FIT_MAX_ROWS; n >= 1 && !shown; n--) {
                const rows = [];
                const more = { row: 0 };
                const fit = chipsThatFit(widths, available, gap, n, moreRect.width, rows, more);
                const height = rowsHeight(fit, rows, rects.map((r) => r.height), moreRect.height, room.gap, more.row);
                if (height <= room.inside + 0.01 || (n === 1 && height <= room.oneRow + 0.01)) shown = fit;
            }
            plan.rows.push(shown
                ? { slot: slotEl, chips, shown, more: true }
                : { slot: slotEl, chips, shown: chips.map(() => false), more: false });
        }
        return plan;
    }

    /**
     * Where each exact top-right container of a legacy corners card right
     * below one that is not would sit without its indicator margin: right
     * below that container (the margin never moves the containers above it).
     * The first container and those below an exact one keep the stylesheet
     * default (reads only).
     * @param {CardController} ctrl
     * @returns {Array<{el: HTMLElement, before: number|null}>}
     */
    function measureIndicatorGaps(ctrl) {
        const slot = indicatorGapsToMeasure(ctrl);
        if (!slot) return [];
        const items = /** @type {HTMLElement[]} */ (Array.from(slot.children));
        const top = slot.getBoundingClientRect().top;
        const gap = parseFloat(getComputedStyle(slot).rowGap) || 0;
        const out = [];
        items.forEach((el, i) => {
            if (!el.dataset.jeIndicatorGap) return;
            const prev = items[i - 1];
            out.push({ el, before: !prev || prev.dataset.jeIndicatorGap ? null : Math.max(0, prev.getBoundingClientRect().bottom + gap - top) });
        });
        return out;
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
        /** @type {string[]} */
        const names = [];
        for (const { slot, chips, shown, more: room } of plan.rows) {
            const more = moreChipOf(slot);
            if (!more) continue;
            const hidden = chips.filter((chip, i) => !shown[i]);
            for (const chip of hidden) chip.setAttribute('data-je-overflow', '');
            names.push(...hidden.map(chipLabel).filter(Boolean));
            // Not a single row fits: no empty scrim either.
            if (!room) slot.setAttribute('data-je-overflow', '');
            if (hidden.length === 0 || !room) {
                more.setAttribute('data-je-overflow', '');
                more.removeAttribute('title');
                continue;
            }
            more.textContent = `+${hidden.length}`;
            more.title = hidden.map(chipLabel).filter(Boolean).join(', ');
        }
        describeHidden(ctrl, names);
        for (const { el, before } of plan.indicator) {
            const value = before === null ? '' : `${Math.round(before * 100) / 100}px`;
            if (el.style.getPropertyValue(INDICATOR_BEFORE) === value) continue;
            if (value) el.style.setProperty(INDICATOR_BEFORE, value);
            else el.style.removeProperty(INDICATOR_BEFORE);
        }
    }

    // ── Hidden chip names ──────────────────────────────────────────────
    // A "+N" chip takes no pointer events and no focus (on the poster it
    // would take clicks from the card and Jellyfin's buttons). The names it
    // stands for are given to the card's own link instead: an accessible
    // description, and a small tooltip while the card is hovered or focused.

    const FOCUSABLE = 'a[href], button, [tabindex]:not([tabindex="-1"])';
    let moreTipSeq = 0;

    /**
     * The focusable element that stands for a card: its image link, else the
     * focusable row or card around the host (list rows), else its first
     * focusable element.
     * @param {HTMLElement} host
     * @returns {HTMLElement|null}
     */
    function cardLinkOf(host) {
        const card = host.closest('.card, .listItem');
        const image = card?.querySelector(`.cardImageContainer:is(${FOCUSABLE})`);
        if (image) return /** @type {HTMLElement} */ (image);
        const around = host.parentElement?.closest(FOCUSABLE);
        if (around) return /** @type {HTMLElement} */ (around);
        return /** @type {HTMLElement|null} */ (card?.querySelector(FOCUSABLE) || null);
    }

    /**
     * Add or remove one id in an element's aria-describedby list.
     * @param {HTMLElement} el
     * @param {string} id
     * @param {boolean} on
     */
    function toggleDescribedBy(el, id, on) {
        const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter((t) => t && t !== id);
        if (on) ids.push(id);
        if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
        else el.removeAttribute('aria-describedby');
    }

    /**
     * Name the chips a card's "+N" chips stand for (none: remove the names).
     * One element in the host holds them: the card link's aria-describedby
     * points at it, and the layout stylesheet shows it as a tooltip while the
     * card is hovered or focused. It is aria-hidden so it is not read a
     * second time as page content.
     * @param {CardController} ctrl
     * @param {string[]} names
     */
    function describeHidden(ctrl, names) {
        const link = names.length ? cardLinkOf(ctrl.host) : null;
        if (ctrl.described && (ctrl.described !== link || !names.length) && ctrl.moreTip) {
            toggleDescribedBy(ctrl.described, ctrl.moreTip.id, false);
            ctrl.described = null;
        }
        if (!names.length) {
            ctrl.moreTip?.remove();
            ctrl.moreTip = null;
            return;
        }
        let tip = ctrl.moreTip;
        if (!tip || tip.parentElement !== ctrl.host) {
            tip?.remove();
            tip = document.createElement('span');
            tip.className = 'je-tag-more-tip';
            tip.id = `je-tag-more-${++moreTipSeq}`;
            tip.setAttribute('aria-hidden', 'true');
            ctrl.host.appendChild(tip);
            ctrl.moreTip = tip;
        }
        const list = names.join(', ');
        const label = typeof JE.t === 'function' ? JE.t('tag_layout_more_tags', { tags: list }) : '';
        const text = label && label !== 'tag_layout_more_tags' ? label : list;
        if (tip.textContent !== text) tip.textContent = text;
        if (link && link !== ctrl.described) {
            toggleDescribedBy(link, tip.id, true);
            ctrl.described = link;
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
        if (ctrl.layout !== conf.layout || ctrl.lookKey !== conf.lookKey) {
            presentAll(ctrl);
        } else if (!isAwaiting(ctrl.host)) {
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
        if (isAwaiting(ctrl.host)) return;
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
     * Drop everything a card shows, knows and holds. Explicit cleanup also
     * clears facts recorded before its host existed; automatic controller
     * retirement in forget() must leave replacement context intact.
     * @param {HTMLElement} target
     */
    function clearCard(target) {
        // The user review key lives on the render target (the host, or the
        // image of a card without one): a lookup still out for the old item
        // checks it before adding its chip.
        if (target?.dataset) delete target.dataset.jeReviewKey;
        if (target) cardData.delete(target);
        const host = findHost(target);
        if (!host) return;
        cardData.delete(host);
        if (host.parentElement) cardData.delete(host.parentElement);
        delete host.dataset.jeReviewKey;
        endAwait(host);
        const ctrl = host ? controllers.get(host) : null;
        if (!ctrl) return;
        forget(ctrl);
    }

    /**
     * Tear a card's controller down and drop it.
     * @param {CardController} ctrl
     */
    function forget(ctrl) {
        // A reused host may already be waiting for the replacement item.
        // Retiring its old controller must cancel only the old item's hold.
        if (contextOf(awaitingData, ctrl.host)?.cardId === ctrl.itemId) endAwait(ctrl.host);
        teardown(ctrl);
        controllers.delete(ctrl.host);
    }

    /**
     * Remove one group from every card on the page (its tag type was turned
     * off or is about to be re-rendered).
     * @param {string} groupId
     */
    function removeGroupEverywhere(groupId) {
        for (const host of document.querySelectorAll('.je-tag-host')) {
            const reserve = resolveLayout(controllers.get(host) || host).reserveCaption;
            removeGroup(/** @type {HTMLElement} */ (host), groupId);
            // The group was the last one switched on that could fill the
            // caption strip: give the reserved space back.
            const ctrl = reserve ? null : controllers.get(/** @type {HTMLElement} */ (host));
            if (ctrl?.outlet && !holdsGroups(ctrl.outlet)) {
                ctrl.outlet.remove();
                ctrl.outlet = null;
            }
        }
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
        if (!target || !resolveLayout(findHost(target) || target).reserveCaption) return;
        const host = ensureHost(target);
        if (!host || isIgnoredContext(host)) return;
        const ctrl = controllerFor(host, true);
        // A card presented while nothing could fill the strip has no outlet yet.
        if (ctrl && (ctrl.layout !== 'caption' || (!ctrl.outlet?.isConnected && captionAnchor(ctrl.host)))) presentAll(ctrl);
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
     * reserves caption space on cards that have none yet. Emits
     * je:tag-layout-changed once per burst so settings summaries can refresh.
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
            for (const host of document.querySelectorAll('.je-tag-host')) {
                const el = /** @type {HTMLElement} */ (host);
                const reserve = resolveLayout(controllers.get(el) || el).reserveCaption;
                const ctrl = controllerFor(el, reserve && !isIgnoredContext(el));
                if (!ctrl) continue;
                presentAll(ctrl);
                if (ctrl.outlet) owned.add(ctrl.outlet);
            }
            document.querySelectorAll('.je-tag-caption').forEach((el) => { if (!owned.has(el)) el.remove(); });
            document.dispatchEvent(new CustomEvent('je:tag-layout-changed'));
        });
        return reinitPending;
    }

    // A user switch: forget the outgoing user's settings and every fact their
    // cards hold (they may be spoiler-stripped differently for the incoming
    // user), including the item data kept for hosts without a controller and
    // the waits for it; the pipeline re-renders the cards, and
    // je:user-data-loaded re-applies the incoming user's layout.
    JE.session?.onUserChange?.('tag-layout', () => {
        invalidateSettings();
        // Clear first so every hold's timer is cancelled through clearCard,
        // then forget whatever a host without a controller still kept.
        clearAll();
        cardData = new WeakMap();
        awaitingData = new WeakMap();
    });

    const api = {
        GROUPS: DEFAULT_ORDER.slice(),
        LAYOUT_SLOTS,
        DEFAULT_ORDER: DEFAULT_ORDER.slice(),
        DEFAULT_CAPS: { ...DEFAULT_CAPS },
        MAX_CAP,
        DEFAULT_PROFILES,
        SHAPES: SHAPES.slice(),
        RECOMMENDED_SHAPES,
        CONTAINER_CLASS,
        SLOT_TO_POSITION,
        POSITION_TO_SLOT,
        POSITION_SETTINGS,
        /** @type {Function|null} set by tags/tag-layout-styles.js */
        buildStyles: null,
        normalizeGroup,
        normalizeSettings,
        promoteLegacySettings,
        invalidateSettings,
        resolveLayout,
        lookSource,
        shapeOf,
        shapeOfCard,
        readShapeOverrides,
        shapesToWire,
        setCardContext,
        cardIdentity,
        awaitCardContext,
        releaseCardContext,
        resumePresentation,
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
        rowsHeight,
        isGroup: (name) => GROUPS.has(/** @type {string} */ (normalizeGroup(name))),
    };
    JE.core.tagLayout = api;
    JE.reinitializeTagLayout = reinitialize;

})(window.JellyfinEnhanced);
