// @ts-check
// /js/core/tag-look.js
//
// Data side of the tag looks: per-user rules ("cards in library Kids use the
// caption layout, compact"), per-item locks (an item keeps the look it was
// given in the item editor, tags/tag-item-editor.js) and the administrator's
// server-wide item looks. A look is { layout, density, colourPreset, slots },
// and a lock or item look may also carry caps, tagScale, tagGap and edge.
//
// This module only reads, normalises, matches and saves rules and locks. The
// decision which look a card gets (the user's lock → the administrator's item
// look → first matching enabled rule → shape override → the user's default
// layout) is made in one place, resolveLayout() in core/tag-layout.js, which
// calls the helpers below; the native poster resolver (PosterTagSettings.ForItem)
// follows the same lock → item look order.
//
// Settings (camelCase on JE.currentSettings, PascalCase on the server):
//   tagLookRules    ordered array of { id, enabled, when: [{ field, value }],
//                   layout, density, colourPreset, slots }. null = inherit the
//                   administrator's default rules (normalized documents only).
//   tagLayoutLocks  object keyed by item id (32 lowercase hex) of
//                   { layout, density, colourPreset, slots, caps, tagScale,
//                   tagGap, edgeSpacing, scope, lockedAt }. A Series lock
//                   applies to its seasons and episodes too unless its scope
//                   is "item"; a season's or episode's own lock wins.
// Plugin configuration (JE.pluginConfig, the administrator's):
//   TagLookItemOverrides  array of the same documents with an ItemId, for
//                   every user ("For everyone"); written only by
//                   administrators through POST admin/configuration.
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
    const MAX_ITEM_OVERRIDES = 500;
    const PLUGIN_ID = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
    const SCALES = ['smaller', 'default', 'larger', 'largest'];
    const GAPS = ['tight', 'default', 'roomy'];
    const EDGES = ['default', 'tight', 'flush'];
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
     * A lock's chip limits ("Show up to") as { group: n } clamped to
     * 0..MAX_CAP, from an object in either key case; null when none.
     * @param {*} raw
     * @returns {Object<string, number>|null}
     */
    function normalizeCaps(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const layout = JE.core.tagLayout;
        const max = layout?.MAX_CAP ?? 10;
        /** @type {Object<string, number>} */
        const out = {};
        for (const group of layout?.GROUPS || []) {
            const value = pick(raw, group);
            const n = Number(value);
            if (value === undefined || value === null || value === '' || !Number.isFinite(n)) continue;
            out[group] = Math.max(0, Math.min(max, Math.round(n)));
        }
        return Object.keys(out).length ? out : null;
    }

    /**
     * One of a set of canonical values, or null (inherit) when missing or unknown.
     * @param {*} raw
     * @param {string[]} values
     * @returns {string|null}
     */
    function choice(raw, values) {
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        return values.includes(value) ? value : null;
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
     * @property {Object<string, number>|null} caps - "Show up to" per group over the user's caps.
     * @property {string|null} tagScale - Tag size; null keeps the user's.
     * @property {string|null} tagGap - Tag spacing; null keeps the user's.
     * @property {string|null} edge - Corners edge spacing (stored edgeSpacing); null keeps the user's.
     * @property {'item'|null} scope - 'item': a Series lock stays on the series card.
     * @property {number} lockedAt - Unix milliseconds.
     */

    /**
     * One lock (or item look) document normalised, or null when its layout or
     * density is unknown.
     * @param {*} value
     * @returns {TagLayoutLock|null}
     */
    function normalizeLock(value) {
        if (!value || typeof value !== 'object') return null;
        const layout = normalizeLayout(pick(value, 'layout'));
        const density = normalizeDensity(pick(value, 'density'));
        if (!layout || !density) return null;
        const preset = String(pick(value, 'colourPreset') ?? '').trim().toLowerCase();
        return {
            layout,
            density,
            colourPreset: PRESET.test(preset) ? preset : null,
            slots: normalizeSlots(pick(value, 'slots'), layout),
            shapes: normalizeShapes(pick(value, 'shapes')),
            caps: normalizeCaps(pick(value, 'caps')),
            tagScale: choice(pick(value, 'tagScale'), SCALES),
            tagGap: choice(pick(value, 'tagGap'), GAPS),
            edge: choice(pick(value, 'edgeSpacing') ?? pick(value, 'edge'), EDGES),
            scope: String(pick(value, 'scope') ?? '').trim().toLowerCase() === 'item' ? 'item' : null,
            lockedAt: Math.max(0, Number(pick(value, 'lockedAt')) || 0),
        };
    }

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
            const lock = id ? normalizeLock(value) : null;
            if (!id || !lock) continue;
            const previous = byId.get(id);
            if (previous && previous.lockedAt >= lock.lockedAt) continue;
            byId.set(id, lock);
        }
        if (byId.size <= MAX_LOCKS) return byId;
        const newest = Array.from(byId.entries())
            .sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1))
            .slice(0, MAX_LOCKS);
        return new Map(newest);
    }

    /**
     * The administrator's server-wide item looks (TagLookItemOverrides, a list
     * of lock documents with an ItemId) normalised like locks, by item id.
     * @param {*} raw - The list (either key case).
     * @returns {Map<string, TagLayoutLock>}
     */
    function normalizeItemOverrides(raw) {
        if (!Array.isArray(raw)) return new Map();
        /** @type {Object<string, *>} */
        const byKey = {};
        for (const entry of raw) {
            const id = normalizeId(String(pick(entry, 'itemId') ?? ''));
            if (!id) continue;
            const seen = byKey[id];
            if (seen && Math.max(0, Number(pick(seen, 'lockedAt')) || 0) >= Math.max(0, Number(pick(entry, 'lockedAt')) || 0)) continue;
            byKey[id] = entry;
        }
        const looks = normalizeLocks(byKey);
        return looks.size <= MAX_ITEM_OVERRIDES ? looks : new Map(Array.from(looks).slice(0, MAX_ITEM_OVERRIDES));
    }

    /**
     * The rules and locks that apply for a user document: its own rules, or
     * (a normalized document that never set any) the administrator's default
     * rules; a document saved before layouts existed never inherits them.
     * @param {Object} [settings] - Defaults to JE.currentSettings.
     * The administrator's item looks apply to every document (they are the
     * administrator's choice for that one item, for everyone).
     * @param {Object} [plugin] - Defaults to JE.pluginConfig.
     * @returns {{rules: TagLookRule[], locks: Map<string, TagLayoutLock>, overrides: Map<string, TagLayoutLock>}}
     */
    function read(settings, plugin) {
        const s = settings || JE.currentSettings || {};
        const p = plugin || JE.pluginConfig || {};
        const legacy = !(Number(s.tagLayoutSettingsVersion) >= 1);
        const own = s.tagLookRules;
        const rules = Array.isArray(own) ? normalizeRules(own) : (legacy ? [] : normalizeRules(pick(p, 'tagLookRules')));
        return { rules, locks: normalizeLocks(s.tagLayoutLocks), overrides: normalizeItemOverrides(pick(p, 'tagLookItemOverrides')) };
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
     * The lock (or item look) that applies to a card: its own item's, else (a
     * Season or Episode) its series', unless that series lock's scope is
     * "item" (it stays on the series card).
     * @param {Map<string, TagLayoutLock>} locks
     * @param {CardFacts} facts
     * @returns {TagLayoutLock|null}
     */
    function findLock(locks, facts) {
        if (!locks || !locks.size) return null;
        for (const id of facts.lockIds) {
            const lock = locks.get(id);
            if (!lock) continue;
            if (lock.scope === 'item' && id === facts.seriesId && id !== facts.itemId) continue;
            return lock;
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
     * Capture the operation's user, server and epoch. Read the live client as
     * well as the epoch: server changes may precede the session reconcile.
     * Never reconcile in a reset hook, which runs before credentials change.
     * @returns {() => boolean} Whether this operation still owns the session.
     */
    function captureSession() {
        /** @returns {string} The live client's identity. */
        const identity = () => {
            try {
                if (typeof ApiClient === 'undefined' || !ApiClient) return '|';
                const server = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId) || ApiClient._serverInfo?.Id;
                return `${server || ''}|${ApiClient.getCurrentUserId?.() || ''}`;
            } catch { return '|'; }
        };
        const owner = identity();
        const epoch = JE.session?.getEpoch?.();
        return () => owner === identity() && epoch === JE.session?.getEpoch?.();
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
        const isCurrent = captureSession();
        const settings = JE.currentSettings;
        const previous = settings[key];
        if (!isCurrent()) return Promise.resolve(false);
        settings[key] = value;
        represent();
        if (!isCurrent()) return Promise.resolve(false);
        if (typeof JE.saveUserSettings !== 'function') return Promise.resolve(true);
        return new Promise((resolve) => resolve(JE.saveUserSettings('settings.json', settings, { throwOnError: true, isCurrent })))
            .then(() => isCurrent(), (err) => {
                if (!isCurrent()) return false;
                console.warn('🪼 Jellyfin Enhanced [TagLook]: saving the tag looks failed:', err);
                if (JE.currentSettings === settings && settings[key] === value) {
                    settings[key] = previous;
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
    /**
     * Wire form of one lock document (slots as [{ group, slot }], the edge
     * spacing as edgeSpacing, nulls kept out of the optional fields).
     * @param {TagLayoutLock} lock
     * @returns {Object}
     */
    function lockToWire(lock) {
        const { edge, ...rest } = lock;
        return {
            ...rest,
            slots: slotsToWire(lock.slots),
            shapes: shapesToWire(lock.shapes),
            caps: lock.caps ? { ...lock.caps } : null,
            edgeSpacing: edge || null,
        };
    }

    function locksToWire(locks) {
        /** @type {Object<string, Object>} */
        const out = {};
        for (const [id, lock] of locks) out[id] = lockToWire(lock);
        return Object.keys(out).length ? out : null;
    }

    /**
     * @typedef {Object} ItemLook - What the item editor saves.
     * @property {string} layout
     * @property {string} density
     * @property {Object<string, string>|null} [slots]
     * @property {Object<string, number>|null} [caps]
     * @property {string|null} [tagScale]
     * @property {string|null} [tagGap]
     * @property {string|null} [edge]
     * @property {'item'|null} [scope]
     */

    /**
     * One look as a normalised lock document stamped newer than every
     * document in `others`, or null when the look is invalid.
     * @param {ItemLook} look
     * @param {Iterable<TagLayoutLock>} others
     * @returns {TagLayoutLock|null}
     */
    function lockFrom(look, others) {
        const lock = normalizeLock({ ...look, edgeSpacing: look?.edge ?? null, lockedAt: 0, shapes: null, colourPreset: null });
        if (!lock) return null;
        lock.lockedAt = Math.max(Date.now(), ...Array.from(others, (l) => l.lockedAt + 1));
        return lock;
    }

    /**
     * Lock an item to a look (the look the item editor shows: layout, density,
     * the complete slot profile, so later profile edits don't move it, and any
     * caps, size, gap and edge spacing chosen for it). Past 500 locks the
     * oldest is dropped.
     * @param {string} itemId
     * @param {ItemLook} look
     * @returns {Promise<boolean>} False when the id or look is invalid or the
     *   save failed (the previous locks are back).
     */
    function lockItem(itemId, look) {
        const id = normalizeId(itemId);
        const locks = normalizeLocks(JE.currentSettings.tagLayoutLocks);
        const lock = id ? lockFrom(look, locks.values()) : null;
        if (!id || !lock) return Promise.resolve(false);
        locks.delete(id);
        locks.set(id, lock);
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

    /**
     * Change several locks in one save (the item editor: a series lock that
     * replaces a season's or episode's own lock, or an unlock of both).
     * @param {Object<string, ItemLook>} set - item id → look to lock it to.
     * @param {string[]} [remove] - Item ids to unlock.
     * @returns {Promise<boolean>} False when a look is invalid or the save
     *   failed (the previous locks are back).
     */
    function editLocks(set, remove = []) {
        const locks = normalizeLocks(JE.currentSettings.tagLayoutLocks);
        for (const raw of remove) { const id = normalizeId(raw); if (id) locks.delete(id); }
        for (const [raw, look] of Object.entries(set || {})) {
            const id = normalizeId(raw);
            const lock = id ? lockFrom(look, locks.values()) : null;
            if (!id || !lock) return Promise.resolve(false);
            locks.delete(id);
            locks.set(id, lock);
        }
        return persist('tagLayoutLocks', locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }

    /**
     * Restore only locks removed by this operation (the item editor's Undo).
     * Newer entries win: restore an absent id only, without replacing current
     * locks or evicting an intervening addition when the map is full.
     * @param {Object<string, Object>|null} wire - A tagLayoutLocks value.
     * @returns {Promise<boolean>}
     */
    function restoreLocks(wire) {
        const locks = normalizeLocks(JE.currentSettings.tagLayoutLocks);
        for (const [id, lock] of normalizeLocks(wire)) {
            if (!locks.has(id) && locks.size < MAX_LOCKS) locks.set(id, lock);
        }
        return persist('tagLayoutLocks', locksToWire(locks));
    }

    /**
     * Wire form of server-wide item looks: the configuration's list, newest first.
     * @param {Map<string, TagLayoutLock>} looks
     * @returns {Array<Object>|null}
     */
    function itemOverridesToWire(looks) {
        const out = Array.from(looks.entries())
            .sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1))
            .map(([id, look]) => {
                const wire = lockToWire(look);
                return {
                    ItemId: id, Layout: wire.layout, Density: wire.density, ColourPreset: wire.colourPreset,
                    Slots: wire.slots ? wire.slots.map((e) => ({ Group: e.group, Slot: e.slot })) : null,
                    Shapes: wire.shapes, Caps: capsToWire(wire.caps), TagScale: wire.tagScale, TagGap: wire.tagGap,
                    EdgeSpacing: wire.edgeSpacing, Scope: wire.scope, LockedAt: wire.lockedAt,
                };
            });
        return out.length ? out : null;
    }

    /**
     * Caps in the configuration's shape ({ Quality: n, AgeRating: n }).
     * @param {Object<string, number>|null} caps
     * @returns {Object<string, number>|null}
     */
    function capsToWire(caps) {
        if (!caps) return null;
        /** @type {Object<string, number>} */
        const out = {};
        for (const [group, n] of Object.entries(caps)) out[group.charAt(0).toUpperCase() + group.slice(1)] = n;
        return out;
    }

    /**
     * A server-wide item look list with one item's look set (stamped newest)
     * or removed (look null), in the configuration's shape.
     * @param {*} raw - The stored TagLookItemOverrides list.
     * @param {string} itemId
     * @param {ItemLook|null} look
     * @returns {Array<Object>|null|undefined} The new list (null: none left);
     *   undefined when the id or look is invalid.
     */
    function itemOverridesWith(raw, itemId, look) {
        const id = normalizeId(itemId);
        if (!id) return undefined;
        const looks = normalizeItemOverrides(raw);
        looks.delete(id);
        if (look) {
            const lock = lockFrom(look, looks.values());
            if (!lock) return undefined;
            looks.set(id, lock);
        }
        return itemOverridesToWire(looks);
    }

    /**
     * Merge removed item looks into the latest list for Undo. As for personal
     * locks, a newer entry wins and unrelated edits/removals stay as they are.
     * @param {*} raw - The latest list.
     * @param {*} removed - Only the removed entries.
     * @returns {Array<Object>|null}
     */
    function restoreItemOverrides(raw, removed) {
        const looks = normalizeItemOverrides(raw);
        for (const [id, entry] of normalizeItemOverrides(removed)) {
            if (!looks.has(id) && looks.size < MAX_ITEM_OVERRIDES) looks.set(id, entry);
        }
        return itemOverridesToWire(looks);
    }

    /**
     * A per-entry mutation with expectations only for the ids that changed.
     * Full-list replacement remains available for portable imports.
     * @param {*} before - The configuration list read before editing.
     * @param {*} after - The edited list.
     * @returns {{Set: Array<Object>, Remove: string[], Expected: Object}}
     */
    function itemOverrideMutation(before, after) {
        const previous = normalizeItemOverrides(before);
        const next = normalizeItemOverrides(after);
        const sets = new Map();
        const remove = [];
        const expected = {};
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
            if (JSON.stringify(previous.get(id)) === JSON.stringify(next.get(id))) continue;
            if (next.has(id)) sets.set(id, next.get(id));
            else remove.push(id);
            expected[id] = (Array.isArray(before) ? before.find((e) => normalizeId(pick(e, 'itemId')) === id) : null) || null;
        }
        return { Set: itemOverridesToWire(sets) || [], Remove: remove, Expected: expected };
    }

    /**
     * Change one server-wide item look (administrators only): set it to a
     * look, or remove it (look null). Reads the stored list fresh, writes it
     * through an atomic per-entry patch with the affected entries as Expected
     * (including removal of a child when its look moves to its series)
     * (once more on a conflict), then puts the stored list into
     * JE.pluginConfig and re-presents the cards.
     * @param {string} itemId
     * @param {ItemLook|null} look
     * @param {{remove?: string[], restoreOnly?: boolean, api?: {get: () => Promise<Object>, patch: (changes: Object, expected: Object) => Promise<Object>}}} [options] - Host hooks (tests).
     * @returns {Promise<boolean>} Whether it was saved.
     */
    async function saveItemOverride(itemId, look, options = {}) {
        const isCurrent = captureSession();
        const id = normalizeId(itemId);
        if (!id) return false;
        const api = options.api || {
            get: () => ApiClient.getPluginConfiguration(PLUGIN_ID),
            patch: (changes, expected) => ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('/JellyfinEnhanced/admin/configuration'),
                data: JSON.stringify({ Changes: changes, Expected: expected }),
                contentType: 'application/json',
                dataType: 'json',
            }),
        };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (!isCurrent()) return false;
                const config = await api.get();
                if (!isCurrent()) return false;
                const before = config?.TagLookItemOverrides ?? null;
                // Undo never replaces a newer entry on the same target.
                if (options.restoreOnly && normalizeItemOverrides(before).has(id)) return true;
                let next = before;
                for (const child of options.remove || []) next = itemOverridesWith(next, child, null);
                next = itemOverridesWith(next, id, look);
                if (next === undefined) return false;
                if (!isCurrent()) return false;
                const result = await api.patch({ TagLookItemOverrides: itemOverrideMutation(before, next) }, {});
                if (!isCurrent()) return false;
                const stored = result?.values?.TagLookItemOverrides ?? result?.Values?.TagLookItemOverrides ?? next;
                if (JE.pluginConfig) JE.pluginConfig.TagLookItemOverrides = stored;
                represent();
                return true;
            } catch (err) {
                if (!isCurrent()) return false;
                if (err?.status === 409 && attempt === 0) continue;
                console.warn('🪼 Jellyfin Enhanced [TagLook]: saving the item look for everyone failed:', err);
                return false;
            }
        }
        return false;
    }

    JE.core.tagLook = {
        captureSession,
        FIELDS: FIELDS.slice(),
        TYPES: TYPES.slice(),
        MAX_RULES,
        MAX_CONDITIONS,
        MAX_LOCKS,
        MAX_ITEM_OVERRIDES,
        normalizeId,
        normalizeRules,
        normalizeLocks,
        normalizeLock,
        normalizeItemOverrides,
        normalizeCaps,
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
        editLocks,
        restoreLocks,
        saveItemOverride,
        itemOverrideMutation,
        restoreItemOverrides,
        itemOverridesWith,
        itemOverridesToWire,
    };

})(window.JellyfinEnhanced);
