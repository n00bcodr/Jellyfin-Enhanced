import * as layoutRules from './layout-rules';
import { pick, hasOwn } from './layout-rules';
import type { Layout, Slots, Caps, ShapeOverrides, LayoutDocument } from './layout-rules';
export interface Condition {
    field: string;
    value: string;
}
export interface LookRule {
    id: string;
    enabled: boolean;
    when: Condition[];
    layout: Layout;
    density: string;
    colourPreset: string | null;
    slots: Slots | null;
    shapes: ShapeOverrides | null;
}
export interface LayoutLock {
    layout: Layout;
    density: string;
    colourPreset: string | null;
    slots: Slots | null;
    shapes: ShapeOverrides | null;
    caps: Partial<Caps> | null;
    tagScale: string | null;
    tagGap: string | null;
    edge: string | null;
    scope: 'item' | null;
    lockedAt: number;
}
export interface CardIdentity {
    itemId?: string;
    cardId?: string;
    cardType?: string | null;
}
export interface CardFacts {
    itemId: string;
    type: string | null;
    genres: unknown[];
    officialRating: unknown;
    libraryId: string | null;
    seriesId: string | null;
    lockIds: string[];
}
export interface ItemLookApi {
    get(): Promise<{
        TagLookItemOverrides?: unknown;
    }>;
    patch(changes: {
        TagLookItemOverrides: ReturnType<TagLook['itemOverrideMutation']>;
    }, expected: object): Promise<{
        values?: {
            TagLookItemOverrides?: unknown;
        };
        Values?: {
            TagLookItemOverrides?: unknown;
        };
    } | null>;
}
export interface SaveOptions {
    remove?: string[];
    restoreOnly?: boolean;
    api?: ItemLookApi;
}
export interface LookHost {
    settings(): LayoutDocument;
    config(): LayoutDocument;
    normalizeOfficialRating?(text: string): unknown;
    represent(): void;
    captureSession(): () => boolean;
    saveUserSettings?: ((path: string, settings: LayoutDocument, options: {
        throwOnError: true;
        isCurrent(): boolean;
        onError(): void;
    }) => unknown) | undefined;
    api: ItemLookApi;
}
// Fetch Response.status lives on the prototype; document normalizers deliberately
// read only own data fields and must not be used for transport errors.
function transportStatus(error: unknown): number | undefined {
    try {
        if (typeof error === 'object' && error !== null && 'status' in error) {
            const status = error.status;
            if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
        }
    } catch { /* An unreadable error is not a retryable conflict. */ }
    return undefined;
}
function lockTimestamp(value: unknown): number {
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
    return Number.isFinite(number) ? Math.max(0, number) : 0;
}
export function createTagLook(host: LookHost) {
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
    function layoutSlots() {
        return layoutRules.LAYOUT_SLOTS || {};
    }
    function normalizeId(raw: unknown) {
        if (typeof raw !== 'string')
            return null;
        const id = raw.trim().replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(id) ? id : null;
    }
    function normalizeLayout(raw: unknown) {
        const layout = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        return layoutRules.isLayout(layout) ? layout : null;
    }
    function normalizeDensity(raw: unknown) {
        if (raw === undefined || raw === null || raw === '')
            return 'full';
        const density = String(raw).trim().toLowerCase();
        return DENSITIES.includes(density) ? density : null;
    }
    function normalizeSlots(raw: unknown, layout: Layout) {
        if (!raw || typeof raw !== 'object')
            return null;
        const pairs = Array.isArray(raw)
            ? raw.map((entry) => [pick(entry, 'group'), pick(entry, 'slot')])
            : Object.entries(raw);
        const layouts = layoutSlots();
        const valid = layoutRules.isLayout(layout) ? layouts[layout] : [];
        const out: Slots = {};
        for (const [rawGroup, rawSlot] of pairs) {
            const group = layoutRules.normalizeGroup(rawGroup);
            const slot = typeof rawSlot === 'string' ? rawSlot.trim().toLowerCase() : '';
            if (!group || out[group] || !valid.includes(slot))
                continue;
            if (slot === 'dots' && group !== 'quality')
                continue;
            out[group] = slot;
        }
        return Object.keys(out).length ? out : null;
    }
    function normalizeShapes(raw: unknown) {
        const shapes = layoutRules.readShapeOverrides(raw);
        return shapes && (shapes.landscape || shapes.list) ? shapes : null;
    }
    function normalizeCaps(raw: unknown) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        const layout = layoutRules;
        const max = layout?.MAX_CAP ?? 10;
        const out: Partial<Caps> = {};
        for (const group of layout?.GROUPS || []) {
            const value = pick(raw, group);
            const n = Number(value);
            if (value === undefined || value === null || value === '' || !Number.isFinite(n))
                continue;
            out[group] = Math.max(0, Math.min(max, Math.round(n)));
        }
        return Object.keys(out).length ? out : null;
    }
    function choice(raw: unknown, values: string[]) {
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        return values.includes(value) ? value : null;
    }
    function normalizeCondition(raw: unknown) {
        const rawField = pick(raw, 'field');
        const field = FIELDS.find((f) => typeof rawField === 'string' && f.toLowerCase() === rawField.trim().toLowerCase());
        const rawValue = pick(raw, 'value');
        const text = typeof rawValue === 'string' ? rawValue.trim() : '';
        if (!field || !text)
            return null;
        let value = null;
        if (field === 'library')
            value = normalizeId(text);
        else if (field === 'type')
            value = TYPES.find((t) => t.toLowerCase() === text.toLowerCase()) || null;
        else
            value = text.length <= MAX_TEXT ? text : null;
        return value ? { field, value } : null;
    }
    function normalizeRules(raw: unknown) {
        if (!Array.isArray(raw))
            return [];
        const out: LookRule[] = [];
        const ids = new Set<string>();
        for (const rule of raw) {
            if (out.length >= MAX_RULES)
                break;
            if (!rule || typeof rule !== 'object')
                continue;
            const layout = normalizeLayout(pick(rule, 'layout'));
            const density = normalizeDensity(pick(rule, 'density'));
            if (!layout || !density)
                continue;
            const whenRaw = pick(rule, 'when');
            const when = (Array.isArray(whenRaw) ? whenRaw : []).map(normalizeCondition);
            if (when.length === 0 || when.length > MAX_CONDITIONS || when.includes(null))
                continue;
            let id = String(pick(rule, 'id') ?? '').trim();
            if (!RULE_ID.test(id) || ids.has(id))
                id = newRuleId(ids);
            ids.add(id);
            const enabled = pick(rule, 'enabled');
            const preset = String(pick(rule, 'colourPreset') ?? '').trim().toLowerCase();
            out.push({
                id,
                enabled: enabled !== false,
                when: when.filter((condition): condition is Condition => condition !== null),
                layout,
                density,
                colourPreset: PRESET.test(preset) ? preset : null,
                slots: normalizeSlots(pick(rule, 'slots'), layout),
                shapes: normalizeShapes(pick(rule, 'shapes')),
            });
        }
        return out;
    }
    function newRuleId(taken?: Set<string>) {
        let id;
        do {
            id = 'r' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        } while (taken && taken.has(id));
        return id;
    }
    function normalizeLock(value: unknown): LayoutLock | null {
        if (!value || typeof value !== 'object')
            return null;
        const layout = normalizeLayout(pick(value, 'layout'));
        const density = normalizeDensity(pick(value, 'density'));
        if (!layout || !density)
            return null;
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
            lockedAt: lockTimestamp(pick(value, 'lockedAt')),
        };
    }
    function normalizeLocks(raw: unknown) {
        const byId = new Map<string, LayoutLock>();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return byId;
        for (const [key, value] of Object.entries(raw)) {
            const id = normalizeId(key);
            const lock = id ? normalizeLock(value) : null;
            if (!id || !lock)
                continue;
            const previous = byId.get(id);
            if (previous && previous.lockedAt >= lock.lockedAt)
                continue;
            byId.set(id, lock);
        }
        if (byId.size <= MAX_LOCKS)
            return byId;
        const newest = Array.from(byId.entries())
            .sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1))
            .slice(0, MAX_LOCKS);
        return new Map(newest);
    }
    function normalizeItemOverrides(raw: unknown) {
        if (!Array.isArray(raw))
            return new Map<string, LayoutLock>();
        const byKey: Record<string, unknown> = {};
        for (const entry of raw) {
            const id = normalizeId(String(pick(entry, 'itemId') ?? ''));
            if (!id)
                continue;
            const seen = byKey[id];
            if (seen && lockTimestamp(pick(seen, 'lockedAt')) >= lockTimestamp(pick(entry, 'lockedAt')))
                continue;
            byKey[id] = entry;
        }
        const looks = normalizeLocks(byKey);
        return looks.size <= MAX_ITEM_OVERRIDES ? looks : new Map(Array.from(looks).slice(0, MAX_ITEM_OVERRIDES));
    }
    function read(settings?: LayoutDocument, plugin?: LayoutDocument) {
        const s = settings || host.settings() || {};
        const p = plugin || host.config() || {};
        const legacy = layoutRules.isLegacySettings(s);
        const own = s.tagLookRules;
        const rules = Array.isArray(own) ? normalizeRules(own) : (legacy ? [] : normalizeRules(pick(p, 'tagLookRules')));
        return { rules, locks: normalizeLocks(s.tagLayoutLocks), overrides: normalizeItemOverrides(pick(p, 'tagLookItemOverrides')) };
    }
    function normalizeRating(raw: unknown) {
        if (raw === null || raw === undefined)
            return '';
        const text = String(raw).replace(/\s+/g, ' ').trim();
        if (!text)
            return '';
        const shared = host.normalizeOfficialRating;
        return String((typeof shared === 'function' ? shared(text) : text) || text).toLowerCase();
    }
    function matches(rule: LookRule, facts: CardFacts) {
        if (!rule || !rule.enabled || !rule.when.length)
            return false;
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
    function firstMatch(rules: LookRule[], facts: CardFacts) {
        for (const rule of rules) {
            if (matches(rule, facts))
                return rule;
        }
        return null;
    }
    function findLock(locks: Map<string, LayoutLock>, facts: CardFacts) {
        if (!locks || !locks.size)
            return null;
        for (const id of facts.lockIds) {
            const lock = locks.get(id);
            if (!lock)
                continue;
            if (lock.scope === 'item' && id === facts.seriesId && id !== facts.itemId)
                continue;
            return lock;
        }
        return null;
    }
    function factsFrom(entry: unknown, card: CardIdentity = {}) {
        const e = entry;
        const itemId = normalizeId(card.itemId || '') || normalizeId(String(pick(e, 'id') ?? '')) || '';
        const cardId = normalizeId(card.cardId || '') || '';
        const rawType = card.cardType || pick(e, 'type');
        const type = typeof rawType === 'string' ? rawType : null;
        const genresRaw = pick(e, 'genres');
        const seriesId = (type === 'Season' || type === 'Episode' || pick(e, 'type') === 'Season' || pick(e, 'type') === 'Episode')
            ? normalizeId(String(pick(e, 'seriesId') ?? '')) : null;
        const lockIds: string[] = [];
        for (const id of [cardId, itemId, seriesId]) {
            if (id && !lockIds.includes(id))
                lockIds.push(id);
        }
        return {
            itemId: itemId || cardId,
            type,
            genres: Array.isArray(genresRaw) ? genresRaw : [],
            officialRating: pick(e, 'officialRating') || null,
            libraryId: normalizeId(String(pick(e, 'libraryId') ?? '')),
            seriesId,
            lockIds,
        };
    }
    // ── Writing ────────────────────────────────────────────────────────
    function slotsToWire(slots: Slots | null) {
        return slots ? Object.entries(slots).map(([group, slot]) => ({ group, slot })) : null;
    }
    function shapesToWire(shapes: ShapeOverrides | null) {
        return shapes ? layoutRules.shapesToWire(shapes) || null : null;
    }
    const represent = host.represent;
    const captureSession = host.captureSession;
    function persist(key: 'tagLookRules' | 'tagLayoutLocks', value: unknown) {
        const isCurrent = captureSession();
        const settings = host.settings();
        const previous = settings[key];
        if (!isCurrent())
            return Promise.resolve(false);
        settings[key] = value;
        represent();
        if (!isCurrent())
            return Promise.resolve(false);
        const save = host.saveUserSettings;
        const rollback = () => {
            if (host.settings() === settings && settings[key] === value) {
                settings[key] = previous;
                represent();
            }
        };
        if (typeof save !== 'function') {
            rollback();
            return Promise.resolve(false);
        }
        return new Promise((resolve) => resolve(save('settings.json', settings, { throwOnError: true, isCurrent, onError: rollback })))
            .then(() => isCurrent(), (err) => {
            if (!isCurrent())
                return false;
            console.warn('🪼 Jellyfin Enhanced [TagLook]: saving the tag looks failed:', err);
            return false;
        });
    }
    function saveRules(rules: unknown) {
        return persist('tagLookRules', normalizeRules(rules).map((rule) => ({ ...rule, slots: slotsToWire(rule.slots), shapes: shapesToWire(rule.shapes) })));
    }
    function lockToWire(lock: LayoutLock) {
        const { edge, ...rest } = lock;
        return {
            ...rest,
            slots: slotsToWire(lock.slots),
            shapes: shapesToWire(lock.shapes),
            caps: lock.caps ? { ...lock.caps } : null,
            edgeSpacing: edge || null,
        };
    }
    function locksToWire(locks: Map<string, LayoutLock>) {
        const out: Record<string, unknown> = {};
        for (const [id, lock] of locks)
            out[id] = lockToWire(lock);
        return Object.keys(out).length ? out : null;
    }
    function lockFrom(look: unknown, others: Iterable<LayoutLock>) {
        const lock = normalizeLock({ ...(look && typeof look === 'object' ? look : {}), edgeSpacing: pick(look, 'edge') ?? null, lockedAt: 0, shapes: null, colourPreset: null });
        if (!lock)
            return null;
        lock.lockedAt = Math.max(Date.now(), ...Array.from(others, (l) => l.lockedAt + 1));
        return lock;
    }
    function lockItem(itemId: string, look: unknown) {
        const id = normalizeId(itemId);
        const locks = normalizeLocks(host.settings().tagLayoutLocks);
        const lock = id ? lockFrom(look, locks.values()) : null;
        if (!id || !lock)
            return Promise.resolve(false);
        locks.delete(id);
        locks.set(id, lock);
        return persist('tagLayoutLocks', locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }
    function unlockItems(ids?: string[]) {
        const locks = normalizeLocks(host.settings().tagLayoutLocks);
        if (ids === undefined)
            locks.clear();
        else
            for (const raw of ids) {
                const id = normalizeId(raw);
                if (id)
                    locks.delete(id);
            }
        return persist('tagLayoutLocks', locksToWire(locks));
    }
    function editLocks(set: Record<string, unknown>, remove: string[] = []) {
        const locks = normalizeLocks(host.settings().tagLayoutLocks);
        for (const raw of remove) {
            const id = normalizeId(raw);
            if (id)
                locks.delete(id);
        }
        for (const [raw, look] of Object.entries(set || {})) {
            const id = normalizeId(raw);
            const lock = id ? lockFrom(look, locks.values()) : null;
            if (!id || !lock)
                return Promise.resolve(false);
            locks.delete(id);
            locks.set(id, lock);
        }
        return persist('tagLayoutLocks', locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }
    function restoreLocks(wire: unknown) {
        const locks = normalizeLocks(host.settings().tagLayoutLocks);
        for (const [id, lock] of normalizeLocks(wire)) {
            if (!locks.has(id) && locks.size < MAX_LOCKS)
                locks.set(id, lock);
        }
        return persist('tagLayoutLocks', locksToWire(locks));
    }
    function itemOverridesToWire(looks: Map<string, LayoutLock>) {
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
    function capsToWire(caps: Partial<Caps> | null) {
        if (!caps)
            return null;
        const out: Record<string, number> = {};
        for (const [group, n] of Object.entries(caps))
            out[group.charAt(0).toUpperCase() + group.slice(1)] = n;
        return out;
    }
    function itemOverridesWith(raw: unknown, itemId: string, look: unknown) {
        const id = normalizeId(itemId);
        if (!id)
            return undefined;
        const looks = normalizeItemOverrides(raw);
        looks.delete(id);
        if (look) {
            const lock = lockFrom(look, looks.values());
            if (!lock)
                return undefined;
            looks.set(id, lock);
        }
        return itemOverridesToWire(looks);
    }
    function restoreItemOverrides(raw: unknown, removed: unknown) {
        const looks = normalizeItemOverrides(raw);
        for (const [id, entry] of normalizeItemOverrides(removed)) {
            if (!looks.has(id) && looks.size < MAX_ITEM_OVERRIDES)
                looks.set(id, entry);
        }
        return itemOverridesToWire(looks);
    }
    function itemOverrideMutation(before: unknown, after: unknown) {
        const previous = normalizeItemOverrides(before);
        const next = normalizeItemOverrides(after);
        const sets = new Map<string, LayoutLock>();
        const remove = [];
        const expected: Record<string, unknown> = {};
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
            if (JSON.stringify(previous.get(id)) === JSON.stringify(next.get(id)))
                continue;
            const value = next.get(id);
            if (value)
                sets.set(id, value);
            else
                remove.push(id);
            expected[id] = (Array.isArray(before) ? before.find((e) => normalizeId(pick(e, 'itemId')) === id) : null) || null;
        }
        return { Set: itemOverridesToWire(sets) || [], Remove: remove, Expected: expected };
    }
    async function saveItemOverride(itemId: string, look: unknown, options: SaveOptions = {}) {
        const isCurrent = captureSession();
        const id = normalizeId(itemId);
        if (!id)
            return false;
        const api = options.api || host.api;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (!isCurrent())
                    return false;
                const config = await api.get();
                if (!isCurrent())
                    return false;
                const before = config?.TagLookItemOverrides ?? null;
                // Undo never replaces a newer target or evicts an intervening
                // addition when the list has filled during its Undo interval.
                const current = normalizeItemOverrides(before);
                if (options.restoreOnly && (current.has(id) || current.size >= MAX_ITEM_OVERRIDES))
                    return true;
                let next: unknown = before;
                for (const child of options.remove || [])
                    next = itemOverridesWith(next, child, null);
                next = itemOverridesWith(next, id, look);
                if (next === undefined)
                    return false;
                if (!isCurrent())
                    return false;
                const mutation = itemOverrideMutation(before, next);
                const result = mutation.Set.length || mutation.Remove.length
                    ? await api.patch({ TagLookItemOverrides: mutation }, {}) : null;
                if (!isCurrent())
                    return false;
                const stored = result?.values?.TagLookItemOverrides ?? result?.Values?.TagLookItemOverrides ?? (result ? next : before);
                const configView = host.config();
                configView.TagLookItemOverrides = visibleItemLooks(stored, configView.TagLookItemOverrides, id);
                represent();
                return true;
            }
            catch (err) {
                if (!isCurrent())
                    return false;
                if (transportStatus(err) === 409 && attempt === 0)
                    continue;
                console.warn('🪼 Jellyfin Enhanced [TagLook]: saving the item look for everyone failed:', err);
                return false;
            }
        }
        return false;
    }
    function visibleItemLooks(stored: unknown, previous: unknown, id: string) {
        if (!Array.isArray(stored))
            return null;
        const visible = new Set(normalizeItemOverrides(previous).keys()).add(id);
        const kept = stored.filter((entry) => visible.has(normalizeId(String(pick(entry, 'itemId') ?? '')) || ''));
        return kept.length ? kept : null;
    }
    return {
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
}
export type TagLook = ReturnType<typeof createTagLook>;
