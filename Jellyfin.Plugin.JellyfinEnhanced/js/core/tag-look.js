// @ts-check
// /js/core/tag-look.js
//
// Data side of the tag looks: per-user rules ("cards in library Kids use the
// caption layout, compact") and per-item locks (an item keeps the look it
// had when it was locked). A look is { layout, density, colourPreset, slots }.
//
// This module only reads, normalises, matches and saves rules and locks. The
// decision which look a card gets (lock → first matching enabled rule → shape
// override → the user's default layout) is made in one place, resolveLayout() in
// core/tag-layout.js, which calls the helpers below.
//
// Settings (camelCase on JE.currentSettings, PascalCase on the server):
//   tagLookRules    ordered array of { id, enabled, when: [{ field, value }],
//                   layout, density, colourPreset, slots }. null = inherit the
//                   administrator's default rules (normalized documents only).
//   tagLayoutLocks  object keyed by item id (32 lowercase hex) of
//                   { layout, density, colourPreset, slots, lockedAt }.
// slots travel as [{ group, slot }] (values, not keys, so the settings key
// conversion never touches them) and are held here as { group: slot }.
// A rule or lock may also carry shapes: { landscape, list } looks laid over
// its look on cards of that shape (core/tag-layout.js reads and writes them);
// the panel has no control for it, it is kept and honoured as stored.
//
// Public surface: JE.core.tagLook (see the object at the bottom).
(function (JE) {
    'use strict';

    JE.core = JE.core || {};

    const FIELDS = ['library', 'type', 'genre', 'ageRating'];
    const TYPES = ['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video'];
    const DENSITIES = ['full', 'compact'];
    const MAX_RULES = 50;
    const MAX_CONDITIONS = 5;
    const MAX_LOCKS = 500;
    const MAX_TEXT = 100;
    const RULE_ID = /^[A-Za-z0-9_-]{1,40}$/;
    const PRESET = /^[a-z0-9_-]{1,64}$/;

    /**
     * Read a key in either case (array items never pass through the
     * settings key converter, so they arrive in the server's PascalCase).
     * @param {*} obj
     * @param {string} key - camelCase key.
     * @returns {*}
     */
    function pick(obj, key) {
        if (!obj || typeof obj !== 'object') return undefined;
        if (Object.hasOwn(obj, key) && obj[key] !== undefined && obj[key] !== null) return obj[key];
        const pascal = key.charAt(0).toUpperCase() + key.slice(1);
        return Object.hasOwn(obj, pascal) && obj[pascal] !== undefined && obj[pascal] !== null ? obj[pascal] : undefined;
    }

    /** @returns {Object<string, string[]>} layout → valid slots (from core/tag-layout.js). */
    function layoutSlots() {
        return JE.core.tagLayout?.LAYOUT_SLOTS || {};
    }

    /**
     * An item or library id as 32 lowercase hex characters, or null.
     * @param {*} raw
     * @returns {string|null}
     */
    function normalizeId(raw) {
        if (typeof raw !== 'string') return null;
        const id = raw.trim().replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(id) ? id : null;
    }

    /**
     * A layout id, or null when unknown.
     * @param {*} raw
     * @returns {string|null}
     */
    function normalizeLayout(raw) {
        const layout = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        return Object.prototype.hasOwnProperty.call(layoutSlots(), layout) ? layout : null;
    }

    /**
     * A density ('full' when missing), or null when it names something unknown.
     * @param {*} raw
     * @returns {string|null}
     */
    function normalizeDensity(raw) {
        if (raw === undefined || raw === null || raw === '') return 'full';
        const density = String(raw).trim().toLowerCase();
        return DENSITIES.includes(density) ? density : null;
    }

    /**
     * Slot overrides for a layout as { group: slot }, from the stored
     * [{ group, slot }] list or an object map; invalid entries dropped, null
     * when none is left.
     * @param {*} raw
     * @param {string} layout
     * @returns {Object<string, string>|null}
     */
    function normalizeSlots(raw, layout) {
        if (!raw || typeof raw !== 'object') return null;
        const pairs = Array.isArray(raw)
            ? raw.map((entry) => [pick(entry, 'group'), pick(entry, 'slot')])
            : Object.entries(raw);
        const layouts = layoutSlots();
        const valid = Object.hasOwn(layouts, layout) ? layouts[layout] : [];
        /** @type {Object<string, string>} */
        const out = {};
        for (const [rawGroup, rawSlot] of pairs) {
            const group = JE.core.tagLayout?.normalizeGroup(rawGroup);
            const slot = typeof rawSlot === 'string' ? rawSlot.trim().toLowerCase() : '';
            if (!group || out[group] || !valid.includes(slot)) continue;
            if (slot === 'dots' && group !== 'quality') continue;
            out[group] = slot;
        }
        return Object.keys(out).length ? out : null;
    }

    /**
     * A rule's or lock's per-shape looks (core/tag-layout.js
     * readShapeOverrides), or null when no shape has one.
     * @param {*} raw
     * @returns {Object|null}
     */
    function normalizeShapes(raw) {
        const shapes = JE.core.tagLayout?.readShapeOverrides?.(raw);
        return shapes && (shapes.landscape || shapes.list) ? shapes : null;
    }

    /**
     * One condition normalised, or null when its field or value is invalid.
     * @param {*} raw
     * @returns {{field: string, value: string}|null}
     */
    function normalizeCondition(raw) {
        const rawField = pick(raw, 'field');
        const field = FIELDS.find((f) => typeof rawField === 'string' && f.toLowerCase() === rawField.trim().toLowerCase());
        const rawValue = pick(raw, 'value');
        const text = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (!field || !text) return null;
        let value = null;
        if (field === 'library') value = normalizeId(text);
        else if (field === 'type') value = TYPES.find((t) => t.toLowerCase() === text.toLowerCase()) || null;
        else value = text.length <= MAX_TEXT ? text : null;
        return value ? { field, value } : null;
    }

    /**
     * @typedef {Object} TagLookRule
     * @property {string} id
     * @property {boolean} enabled
     * @property {Array<{field: string, value: string}>} when - All must hold.
     * @property {string} layout
     * @property {string} density
     * @property {string|null} colourPreset - Reserved (a later phase).
     * @property {Object<string, string>|null} slots - Slot overrides for the layout.
     * @property {Object|null} shapes - Per-shape looks over the rule's look (landscape, list).
     */

    /**
     * Rules normalised the way the server stores them: rules with an unknown
     * layout or density or without a valid condition are dropped, invalid
     * conditions are dropped from their rule, missing/repeated ids replaced,
     * at most 50 rules of at most 5 conditions.
     * @param {*} raw
     * @returns {TagLookRule[]}
     */
    function normalizeRules(raw) {
        if (!Array.isArray(raw)) return [];
        /** @type {TagLookRule[]} */
        const out = [];
        const ids = new Set();
        for (const rule of raw) {
            if (out.length >= MAX_RULES) break;
            if (!rule || typeof rule !== 'object') continue;
            const layout = normalizeLayout(pick(rule, 'layout'));
            const density = normalizeDensity(pick(rule, 'density'));
            if (!layout || !density) continue;
            const whenRaw = pick(rule, 'when');
            const when = (Array.isArray(whenRaw) ? whenRaw : []).map(normalizeCondition).filter(Boolean).slice(0, MAX_CONDITIONS);
            if (when.length === 0) continue;
            let id = String(pick(rule, 'id') ?? '').trim();
            if (!RULE_ID.test(id) || ids.has(id)) id = newRuleId(ids);
            ids.add(id);
            const enabled = pick(rule, 'enabled');
            const preset = String(pick(rule, 'colourPreset') ?? '').trim().toLowerCase();
            out.push({
                id,
                enabled: enabled !== false,
                when: /** @type {Array<{field: string, value: string}>} */ (when),
                layout,
                density,
                colourPreset: PRESET.test(preset) ? preset : null,
                slots: normalizeSlots(pick(rule, 'slots'), layout),
                shapes: normalizeShapes(pick(rule, 'shapes')),
            });
        }
        return out;
    }

    /**
     * A rule id not in the given set.
     * @param {Set<string>} [taken]
     * @returns {string}
     */
    function newRuleId(taken) {
        let id;
        do {
            id = 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        } while (taken && taken.has(id));
        return id;
    }

    /**
     * @typedef {Object} TagLayoutLock
     * @property {string} layout
     * @property {string} density
     * @property {string|null} colourPreset - Reserved (a later phase).
     * @property {Object<string, string>|null} slots - Every group's slot at lock time.
     * @property {Object|null} shapes - Per-shape looks over the locked look (landscape, list).
     * @property {number} lockedAt - Unix milliseconds.
     */

    /**
     * Locks normalised: non-id keys and locks with an unknown layout or
     * density dropped, the newest 500 kept.
     * @param {*} raw
     * @returns {Map<string, TagLayoutLock>}
     */
    function normalizeLocks(raw) {
        /** @type {Map<string, TagLayoutLock>} */
        const byId = new Map();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return byId;
        for (const [key, value] of Object.entries(raw)) {
            const id = normalizeId(key);
            if (!id || !value || typeof value !== 'object') continue;
            const layout = normalizeLayout(pick(value, 'layout'));
            const density = normalizeDensity(pick(value, 'density'));
            if (!layout || !density) continue;
            const lockedAt = Math.max(0, Number(pick(value, 'lockedAt')) || 0);
            const previous = byId.get(id);
            if (previous && previous.lockedAt >= lockedAt) continue;
            const preset = String(pick(value, 'colourPreset') ?? '').trim().toLowerCase();
            byId.set(id, {
                layout,
                density,
                colourPreset: PRESET.test(preset) ? preset : null,
                slots: normalizeSlots(pick(value, 'slots'), layout),
                shapes: normalizeShapes(pick(value, 'shapes')),
                lockedAt,
            });
        }
        if (byId.size <= MAX_LOCKS) return byId;
        const newest = Array.from(byId.entries())
            .sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1))
            .slice(0, MAX_LOCKS);
        return new Map(newest);
    }

    /**
     * The rules and locks that apply for a user document: its own rules, or
     * (a normalized document that never set any) the administrator's default
     * rules; a document saved before layouts existed never inherits them.
     * @param {Object} [settings] - Defaults to JE.currentSettings.
     * @param {Object} [plugin] - Defaults to JE.pluginConfig.
     * @returns {{rules: TagLookRule[], locks: Map<string, TagLayoutLock>}}
     */
    function read(settings, plugin) {
        const s = settings || JE.currentSettings || {};
        const p = plugin || JE.pluginConfig || {};
        const legacy = !(Number(s.tagLayoutSettingsVersion) >= 1);
        const own = s.tagLookRules;
        const rules = Array.isArray(own) ? normalizeRules(own) : (legacy ? [] : normalizeRules(pick(p, 'tagLookRules')));
        return { rules, locks: normalizeLocks(s.tagLayoutLocks) };
    }

    /**
     * Normalise an official rating the way the age rating tags do, for
     * comparing a rule value with a card's rating.
     * @param {*} raw
     * @returns {string}
     */
    function normalizeRating(raw) {
        if (raw === null || raw === undefined) return '';
        const text = String(raw).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        const shared = JE.normalizeOfficialRating;
        return String((typeof shared === 'function' ? shared(text) : text) || text).toLowerCase();
    }

    /**
     * @typedef {Object} CardFacts
     * @property {string} itemId - Normalised id of the item the card shows.
     * @property {string|null} type - Card type (data-type), else the fetched item's.
     * @property {string[]} genres
     * @property {string|null} officialRating
     * @property {string|null} libraryId
     * @property {string|null} seriesId - For a Season/Episode, its series.
     * @property {string[]} lockIds - Ids whose lock applies, most specific first.
     */

    /**
     * Whether every condition of a rule holds for a card.
     * @param {TagLookRule} rule
     * @param {CardFacts} facts
     * @returns {boolean}
     */
    function matches(rule, facts) {
        if (!rule || !rule.enabled || !rule.when.length) return false;
        return rule.when.every((cond) => {
            switch (cond.field) {
                case 'library': return !!facts.libraryId && facts.libraryId === cond.value;
                case 'type': return !!facts.type && facts.type.toLowerCase() === cond.value.toLowerCase();
                case 'genre': {
                    const wanted = cond.value.toLowerCase();
                    return facts.genres.some((g) => String(g).trim().toLowerCase() === wanted);
                }
                case 'ageRating': {
                    const have = normalizeRating(facts.officialRating);
                    return !!have && have === normalizeRating(cond.value);
                }
                default: return false;
            }
        });
    }

    /**
     * The first enabled rule whose conditions all hold, or null.
     * @param {TagLookRule[]} rules
     * @param {CardFacts} facts
     * @returns {TagLookRule|null}
     */
    function firstMatch(rules, facts) {
        for (const rule of rules) {
            if (matches(rule, facts)) return rule;
        }
        return null;
    }

    /**
     * The lock that applies to a card: its own item's, else (a Season or
     * Episode) its series'.
     * @param {Map<string, TagLayoutLock>} locks
     * @param {CardFacts} facts
     * @returns {TagLayoutLock|null}
     */
    function findLock(locks, facts) {
        if (!locks.size) return null;
        for (const id of facts.lockIds) {
            const lock = locks.get(id);
            if (lock) return lock;
        }
        return null;
    }

    /**
     * Card facts from a tag-cache entry or a /tag-data (or /Items) item and
     * the card's own type, in the shape matches() reads.
     * @param {Object|null} entry
     * @param {{itemId?: string, cardId?: string, cardType?: string|null}} [card]
     * @returns {CardFacts}
     */
    function factsFrom(entry, card = {}) {
        const e = entry || {};
        const itemId = normalizeId(card.itemId || '') || normalizeId(String(e.Id ?? e.id ?? '')) || '';
        const cardId = normalizeId(card.cardId || '') || '';
        const type = card.cardType || e.Type || e.type || null;
        const genresRaw = e.Genres || e.genres;
        const seriesId = (type === 'Season' || type === 'Episode' || e.Type === 'Season' || e.Type === 'Episode')
            ? normalizeId(String(e.SeriesId ?? e.seriesId ?? '')) : null;
        const lockIds = [];
        for (const id of [cardId, itemId, seriesId]) {
            if (id && !lockIds.includes(id)) lockIds.push(id);
        }
        return {
            itemId: itemId || cardId,
            type,
            genres: Array.isArray(genresRaw) ? genresRaw : [],
            officialRating: e.OfficialRating || e.officialRating || null,
            libraryId: normalizeId(String(e.LibraryId ?? e.libraryId ?? '')),
            seriesId,
            lockIds,
        };
    }

    // ── Writing ────────────────────────────────────────────────────────

    /**
     * Wire form of a slot map: [{ group, slot }] (null stays null).
     * @param {Object<string, string>|null} slots
     * @returns {Array<{group: string, slot: string}>|null}
     */
    function slotsToWire(slots) {
        return slots ? Object.entries(slots).map(([group, slot]) => ({ group, slot })) : null;
    }

    /**
     * Wire form of per-shape looks (null stays null).
     * @param {Object|null} shapes
     * @returns {Object|null}
     */
    function shapesToWire(shapes) {
        return shapes ? JE.core.tagLayout?.shapesToWire?.(shapes) || null : null;
    }

    /** Re-present every card (no refetch) with the rules and locks as they now are. */
    function represent() {
        JE.core.tagLayout?.invalidateSettings?.();
        if (typeof JE.reinitializeTagLayout === 'function') JE.reinitializeTagLayout();
    }

    /**
     * Apply a change to the rules or locks, re-present the cards and save the
     * settings document. When the save fails the previous value is put back
     * (unless a later change replaced it meanwhile) and the cards re-presented
     * again.
     * @param {'tagLookRules'|'tagLayoutLocks'} key
     * @param {*} value - The new setting value.
     * @returns {Promise<boolean>} Whether the change was saved.
     */
    function persist(key, value) {
        const previous = JE.currentSettings[key];
        JE.currentSettings[key] = value;
        represent();
        if (typeof JE.saveUserSettings !== 'function') return Promise.resolve(true);
        return new Promise((resolve) => resolve(JE.saveUserSettings('settings.json', JE.currentSettings, { throwOnError: true })))
            .then(() => true, (err) => {
                console.warn('🪼 Jellyfin Enhanced [TagLook]: saving the tag looks failed:', err);
                if (JE.currentSettings[key] === value) {
                    JE.currentSettings[key] = previous;
                    represent();
                }
                return false;
            });
    }

    /**
     * Replace the user's rules (normalised) and save.
     * @param {Array<Object>} rules
     * @returns {Promise<boolean>} Whether the rules were saved (false: the previous rules are back).
     */
    function saveRules(rules) {
        return persist('tagLookRules', normalizeRules(rules).map((rule) => ({ ...rule, slots: slotsToWire(rule.slots), shapes: shapesToWire(rule.shapes) })));
    }

    /**
     * Wire form of a lock map (null when empty).
     * @param {Map<string, TagLayoutLock>} locks
     * @returns {Object<string, Object>|null}
     */
    function locksToWire(locks) {
        /** @type {Object<string, Object>} */
        const out = {};
        for (const [id, lock] of locks) out[id] = { ...lock, slots: slotsToWire(lock.slots), shapes: shapesToWire(lock.shapes) };
        return Object.keys(out).length ? out : null;
    }

    /**
     * Lock an item to a look (the effective look it has now: layout, density
     * and the complete slot profile, so later profile edits don't move it).
     * Past 500 locks the oldest is dropped.
     * @param {string} itemId
     * @param {{layout: string, density: string, slots?: Object<string, string>|null, colourPreset?: string|null}} look
     * @returns {Promise<boolean>} False when the id or look is invalid or the
     *   save failed (the previous locks are back).
     */
    function lockItem(itemId, look) {
        const id = normalizeId(itemId);
        const layout = normalizeLayout(look?.layout);
        const density = normalizeDensity(look?.density);
        if (!id || !layout || !density) return Promise.resolve(false);
        const locks = normalizeLocks(JE.currentSettings.tagLayoutLocks);
        locks.delete(id);
        locks.set(id, {
            layout,
            density,
            colourPreset: null,
            slots: normalizeSlots(look.slots || null, layout),
            shapes: null,
            lockedAt: Math.max(Date.now(), ...Array.from(locks.values(), (l) => l.lockedAt + 1)),
        });
        return persist('tagLayoutLocks', locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }

    /**
     * Unlock items (all of them when no ids are given).
     * @param {string[]} [ids]
     * @returns {Promise<boolean>} Whether the change was saved (false: the previous locks are back).
     */
    function unlockItems(ids) {
        const locks = normalizeLocks(JE.currentSettings.tagLayoutLocks);
        if (ids === undefined) locks.clear();
        else for (const raw of ids) { const id = normalizeId(raw); if (id) locks.delete(id); }
        return persist('tagLayoutLocks', locksToWire(locks));
    }

    JE.core.tagLook = {
        FIELDS: FIELDS.slice(),
        TYPES: TYPES.slice(),
        MAX_RULES,
        MAX_CONDITIONS,
        MAX_LOCKS,
        normalizeId,
        normalizeRules,
        normalizeLocks,
        normalizeSlots,
        normalizeRating,
        read,
        matches,
        firstMatch,
        findLock,
        factsFrom,
        newRuleId,
        saveRules,
        lockItem,
        unlockItems,
    };

})(window.JellyfinEnhanced);
