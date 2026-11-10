import type { KindLooks } from './kind-looks';
export type Group = 'status' | 'quality' | 'rating' | 'ageRating' | 'language' | 'genre' | 'awards' | 'logos' | 'custom';
export type Layout = 'corners' | 'bands' | 'caption' | 'summary' | 'minimal';
export type Shape = 'landscape' | 'list';
export type Slots = Partial<Record<Group, string>>;
export type Caps = Record<Group, number>;
export interface ShapeLook {
    layout: Layout | null;
    density: string | null;
    tagScale?: string | null | undefined;
    tagGap?: string | null | undefined;
    edge?: string | null;
    slots: Slots | null;
    caps?: Partial<Caps> | null;
}
export type ShapeOverrides = Record<Shape, ShapeLook | null>;
export interface LayoutSettings {
    layout: Layout;
    legacy: boolean;
    density: string;
    tagScale: string;
    tagGap: string;
    order: Group[] | null;
    orderChosen: boolean;
    caps: Caps;
    profiles: Record<Layout, Slots>;
    slots: Slots;
    indicatorGap: Set<Group>;
    reserveCaption: boolean;
    locked: boolean;
    shapes: ShapeOverrides;
    edge: string;
    /** Per-kind opacity and size that differ from today's look (kind-looks.ts); {} draws as before. */
    kindLooks: KindLooks;
    lookKey: string;
}
export interface LayoutDocument {
    AgeRatingTagsPosition?: unknown;
    AwardsTagsEnabled?: unknown;
    AwardsTagsPosition?: unknown;
    CustomTagsPosition?: unknown;
    GenreTagsPosition?: unknown;
    LanguageTagsPosition?: unknown;
    LogoTagsMaxLogos?: unknown;
    LogoTagsPosition?: unknown;
    QualityTagsPosition?: unknown;
    RatingTagsPosition?: unknown;
    StatusTagsPosition?: unknown;
    TagEdgeSpacing?: unknown;
    TagGap?: unknown;
    TagGroupCaps?: unknown;
    TagKindLooks?: unknown;
    TagLayouts?: unknown;
    TagLookItemOverrides?: unknown;
    TagLookRules?: unknown;
    TagScale?: unknown;
    TagShapeOverrides?: unknown;
    ageRatingTagsEnabled?: unknown;
    ageRatingTagsPosition?: unknown;
    awardsTagsEnabled?: unknown;
    awardsTagsPosition?: unknown;
    customTagsEnabled?: unknown;
    customTagsPosition?: unknown;
    genreTagsEnabled?: unknown;
    genreTagsPosition?: unknown;
    languageTagsEnabled?: unknown;
    languageTagsPosition?: unknown;
    logoTagsEnabled?: unknown;
    logoTagsPosition?: unknown;
    qualityTagsEnabled?: unknown;
    qualityTagsPosition?: unknown;
    ratingTagsEnabled?: unknown;
    ratingTagsPosition?: unknown;
    statusTagsEnabled?: unknown;
    statusTagsPosition?: unknown;
    tagEdgeSpacing?: unknown;
    tagGap?: unknown;
    tagGroupCaps?: unknown;
    tagGroupOrder?: unknown;
    tagKindLooks?: unknown;
    tagLabelDensity?: unknown;
    tagLayout?: unknown;
    tagLayoutLocks?: unknown;
    tagLayoutSettingsVersion?: unknown;
    tagLayouts?: unknown;
    tagLookRules?: unknown;
    tagScale?: unknown;
    tagShapeOverrides?: unknown;
}
export const hasOwn = (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key);
export function isLayout(value: string): value is Layout { return LAYOUTS.some(layout => layout === value); }
export const DEFAULT_ORDER: Group[] = ['status', 'quality', 'rating', 'ageRating', 'language', 'genre', 'awards', 'logos', 'custom'];
export const GROUPS = new Set(DEFAULT_ORDER);
export const LAYOUT_SLOTS: Record<Layout, string[]> = withoutPrototype({
    corners: ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br', 'off'],
    bands: ['top', 'bottom', 'off'],
    caption: ['poster', 'caption', 'off'],
    summary: ['pill', 'hover', 'off'],
    minimal: ['top', 'dots', 'corner', 'hover', 'off'],
});
export const LAYOUTS: Layout[] = ['corners', 'bands', 'caption', 'summary', 'minimal'];
export const DEFAULT_PROFILES: Record<Exclude<Layout, 'corners'>, Slots> = {
    bands: { quality: 'bottom', genre: 'off', language: 'bottom', rating: 'bottom', ageRating: 'top', status: 'top', awards: 'bottom', logos: 'top', custom: 'bottom' },
    caption: { quality: 'caption', genre: 'off', language: 'caption', rating: 'caption', ageRating: 'caption', status: 'poster', awards: 'caption', logos: 'caption', custom: 'caption' },
    summary: { quality: 'pill', genre: 'hover', language: 'hover', rating: 'pill', ageRating: 'hover', status: 'pill', awards: 'hover', logos: 'hover', custom: 'hover' },
    minimal: { quality: 'dots', genre: 'hover', language: 'hover', rating: 'corner', ageRating: 'hover', status: 'top', awards: 'hover', logos: 'hover', custom: 'hover' },
};
export const SHAPES: Shape[] = ['landscape', 'list'];
export const RECOMMENDED_SHAPES = {
    landscape: {
        layout: 'bands', density: 'compact', caps: null,
        slots: { status: 'top', ageRating: 'top', quality: 'bottom', rating: 'bottom', language: 'off', genre: 'off', custom: 'off' },
    },
    list: {
        layout: 'corners', density: 'compact', caps: { quality: 2, status: 2, rating: 2 },
        slots: { quality: 'tl', status: 'tr', rating: 'br', ageRating: 'off', language: 'off', genre: 'off', custom: 'off' },
    },
};
export const EDGE_SPACINGS: Record<string, number> = withoutPrototype({ default: 6, tight: 3, flush: 0 });
export const DEFAULT_CAPS: Caps = { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 };
export const MAX_CAP = 10;
export const TAG_SCALES: Record<string, number> = { smaller: 0.85, default: 1, larger: 1.15, largest: 1.3 };
export const TAG_GAPS: Record<string, number> = { tight: 0.75, default: 1, roomy: 1.5 };
export function readScale(value: unknown) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return hasOwn(TAG_SCALES, key) ? key : null;
}
export function readGap(value: unknown) {
    const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return hasOwn(TAG_GAPS, key) ? key : null;
}
export const POSITION_SETTINGS: Record<Group, {
    userKey: keyof LayoutDocument;
    pluginKey: keyof LayoutDocument;
    fallback: string;
}> = {
    quality: { userKey: 'qualityTagsPosition', pluginKey: 'QualityTagsPosition', fallback: 'top-left' },
    genre: { userKey: 'genreTagsPosition', pluginKey: 'GenreTagsPosition', fallback: 'top-right' },
    language: { userKey: 'languageTagsPosition', pluginKey: 'LanguageTagsPosition', fallback: 'bottom-left' },
    rating: { userKey: 'ratingTagsPosition', pluginKey: 'RatingTagsPosition', fallback: 'bottom-right' },
    ageRating: { userKey: 'ageRatingTagsPosition', pluginKey: 'AgeRatingTagsPosition', fallback: 'bottom-right' },
    awards: { userKey: 'awardsTagsPosition', pluginKey: 'AwardsTagsPosition', fallback: 'top-left' },
    status: { userKey: 'statusTagsPosition', pluginKey: 'StatusTagsPosition', fallback: 'top-right' },
    logos: { userKey: 'logoTagsPosition', pluginKey: 'LogoTagsPosition', fallback: 'bottom-left' },
    custom: { userKey: 'customTagsPosition', pluginKey: 'CustomTagsPosition', fallback: 'top-left' },
};
export const POSITION_TO_SLOT: Record<string, string> = withoutPrototype({ 'top-left': 'tl', 'top-right': 'tr', 'bottom-left': 'bl', 'bottom-right': 'br', 'top-center': 'tc', 'bottom-center': 'bc', 'center-left': 'ml', 'center-right': 'mr', 'center': 'c' });
export const ENABLED_SETTING: Record<Group, keyof LayoutDocument> = {
    quality: 'qualityTagsEnabled',
    genre: 'genreTagsEnabled',
    language: 'languageTagsEnabled',
    rating: 'ratingTagsEnabled',
    ageRating: 'ageRatingTagsEnabled',
    status: 'statusTagsEnabled',
    awards: 'awardsTagsEnabled',
    logos: 'logoTagsEnabled',
    custom: 'customTagsEnabled',
};
export const SLOT_TO_POSITION: Record<string, string> = withoutPrototype({ tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right', tc: 'top-center', bc: 'bottom-center', ml: 'center-left', mr: 'center-right', c: 'center' });
export function pick(obj: unknown, key: string): unknown {
    if (!obj || typeof obj !== 'object')
        return undefined;
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(obj));
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    return (hasOwn(record, key) ? record[key] : undefined) ?? (hasOwn(record, pascal) ? record[pascal] : undefined) ?? undefined;
}
export function normalizeGroup(name: unknown): Group | null {
    if (typeof name !== 'string')
        return null;
    const lowered = name.trim().toLowerCase();
    for (const group of DEFAULT_ORDER) {
        if (group.toLowerCase() === lowered)
            return group;
    }
    return null;
}
export function normalizeLayout(value: unknown): Layout {
    const lowered = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return isLayout(lowered) ? lowered : 'corners';
}
export function readProfile(profiles: unknown, layout: Layout) {
    const out: Slots = {};
    const groups = pick(pick(profiles, layout), 'groups');
    if (!Array.isArray(groups))
        return out;
    for (const entry of groups) {
        const group = normalizeGroup(pick(entry, 'group'));
        const raw = pick(entry, 'slot');
        const slot = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (!group || out[group] || !LAYOUT_SLOTS[layout].includes(slot))
            continue;
        if (slot === 'dots' && group !== 'quality')
            continue;
        out[normalizeGroup(group) || 'quality'] = slot;
    }
    return out;
}
export function readOrder(order: unknown) {
    if (!Array.isArray(order))
        return null;
    const out: Group[] = [];
    for (const entry of order) {
        const group = normalizeGroup(entry);
        if (group && !out.includes(group))
            out.push(group);
    }
    return out.length ? out : null;
}
export function readEdge(value: unknown) {
    if (value === null || value === undefined || value === '')
        return null;
    const lowered = String(value).trim().toLowerCase();
    return hasOwn(EDGE_SPACINGS, lowered) ? lowered : 'default';
}
export function readCap(value: unknown) {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n))
        return undefined;
    return Math.max(0, Math.min(MAX_CAP, Math.round(n)));
}
export function singleChipGroup(group: string, config: LayoutDocument = {}) {
    return group === 'status' || group === 'ageRating'
        || (group === 'logos' && Number(pick(config, 'logoTagsMaxLogos') ?? 1) < 2);
}
export function normalizeGroupCaps(caps: Caps, config: LayoutDocument = {}) {
    return { ...caps, ...Object.fromEntries(DEFAULT_ORDER.map(group => [group, singleChipGroup(group, config) ? 1 : caps[group]])) };
}
export function readShapeLook(raw: unknown): ShapeLook | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const layoutRaw = pick(raw, 'layout');
    const candidate = typeof layoutRaw === 'string' ? layoutRaw.trim().toLowerCase() : '';
    const layout = isLayout(candidate) ? candidate : null;
    const densityRaw = String(pick(raw, 'density') ?? '').trim().toLowerCase();
    const slotsRaw = pick(raw, 'slots');
    const slots: Slots = {};
    const pairs = Array.isArray(slotsRaw)
        ? slotsRaw.map((entry) => [pick(entry, 'group'), pick(entry, 'slot')])
        : (slotsRaw && typeof slotsRaw === 'object' ? Object.entries(slotsRaw) : []);
    const valid = layout ? LAYOUT_SLOTS[layout] : LAYOUTS.flatMap((name) => LAYOUT_SLOTS[name]);
    for (const [rawGroup, rawSlot] of pairs) {
        const group = normalizeGroup(rawGroup);
        const slot = typeof rawSlot === 'string' ? rawSlot.trim().toLowerCase() : '';
        if (!group || slots[group] || !valid.includes(slot) || (slot === 'dots' && group !== 'quality'))
            continue;
        slots[group] = slot;
    }
    const caps: Partial<Caps> = {};
    const capsRaw = pick(raw, 'caps');
    for (const group of DEFAULT_ORDER) {
        const cap = readCap(pick(capsRaw, group));
        if (cap !== undefined)
            caps[group] = cap;
    }
    return {
        layout,
        density: densityRaw === 'compact' || densityRaw === 'full' ? densityRaw : null,
        ...(readScale(pick(raw, 'tagScale')) ? { tagScale: readScale(pick(raw, 'tagScale')) } : {}),
        ...(readGap(pick(raw, 'tagGap')) ? { tagGap: readGap(pick(raw, 'tagGap')) } : {}),
        slots: Object.keys(slots).length ? slots : null,
        caps: Object.keys(caps).length ? caps : null,
    };
}
export function readShapeOverrides(raw: unknown) {
    const out: ShapeOverrides = { landscape: null, list: null };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const shape of SHAPES)
        out[shape] = readShapeLook(pick(raw, shape));
    return out;
}
export function shapesToWire(shapes: ShapeOverrides | null) {
    if (!shapes || !SHAPES.some((shape) => shapes[shape]))
        return null;
    const out: Record<string, unknown> = {};
    for (const shape of SHAPES) {
        const look = shapes[shape];
        out[shape] = look ? {
            layout: look.layout || null,
            density: look.density || null,
            ...(look.tagScale ? { tagScale: look.tagScale } : {}),
            ...(look.tagGap ? { tagGap: look.tagGap } : {}),
            slots: look.slots ? Object.entries(look.slots).map(([group, slot]) => ({ group, slot })) : null,
            caps: look.caps ? { ...look.caps } : null,
        } : null;
    }
    return out;
}
export function positionSlot(settings: LayoutDocument, plugin: LayoutDocument, group: Group) {
    const p = POSITION_SETTINGS[group];
    const pos = String(settings?.[p.userKey] || plugin?.[p.pluginKey] || p.fallback);
    if (hasOwn(POSITION_TO_SLOT, pos))
        return POSITION_TO_SLOT[pos] || 'br';
    const isTop = pos.includes('top');
    const isLeft = pos.includes('left');
    return isTop ? (isLeft ? 'tl' : 'tr') : (isLeft ? 'bl' : 'br');
}
export function isLegacySettings(settings: LayoutDocument = {}) {
    return !(Number(settings.tagLayoutSettingsVersion) >= 1);
}
export function normalizeSettings(s: LayoutDocument = {}, p: LayoutDocument = {}, kindLooksOf: (s: LayoutDocument, p: LayoutDocument, legacy: boolean) => KindLooks = () => ({})) {
    const legacy = isLegacySettings(s);
    const layout = legacy ? 'corners' : normalizeLayout(s.tagLayout);
    const densityRaw = legacy ? 'full' : String(s.tagLabelDensity || '').toLowerCase();
    const density = densityRaw === 'compact' ? 'compact' : 'full';
    const profiles: Record<Layout, Slots> = { corners: {}, bands: {}, caption: {}, summary: {}, minimal: {} };
    const indicatorGap = new Set<Group>();
    const ownCorners = readProfile(s.tagLayouts, 'corners');
    for (const group of DEFAULT_ORDER) {
        const pos = POSITION_SETTINGS[group];
        // The original rule (and Native Poster Tags): only a position of
        // exactly "top-right" earns the indicator offset.
        const raw = s[pos.userKey] || p[pos.pluginKey] || pos.fallback;
        if (ownCorners[group] ? ownCorners[group] === 'tr' : raw === 'top-right')
            indicatorGap.add(group);
    }
    for (const name of LAYOUTS) {
        const own = readProfile(s.tagLayouts, name);
        // The corners profile is the position settings (kept in step with
        // it by the panel), so an admin corners profile never overrides them.
        const admin: Slots = name === 'corners' ? {} : readProfile(pick(p, 'tagLayouts'), name);
        const profile: Slots = {};
        for (const group of DEFAULT_ORDER) {
            profile[group] = own[group] || admin[group]
                || (name === 'corners' ? positionSlot(s, p, group) : DEFAULT_PROFILES[name][group] || 'off');
        }
        profiles[name] = profile;
    }
    let order: Group[] | null = null;
    let orderChosen = false;
    if (!legacy) {
        const own = readOrder(s.tagGroupOrder);
        orderChosen = !!own;
        const chosen = own || (layout === 'corners' ? null : DEFAULT_ORDER);
        if (chosen)
            order = chosen.concat(DEFAULT_ORDER.filter((g) => !chosen.includes(g)));
    }
    const caps: Partial<Caps> = {};
    for (const group of DEFAULT_ORDER) {
        const own = legacy ? undefined : readCap(pick(s.tagGroupCaps, group));
        const admin = legacy ? undefined : readCap(pick(pick(p, 'tagGroupCaps'), group));
        caps[group] = singleChipGroup(group, p) ? 1 : own ?? admin ?? DEFAULT_CAPS[group];
    }
    // Only a group that is switched on can still fill the caption strip.
    const reserveCaption = layout === 'caption'
        && DEFAULT_ORDER.some((g) => profiles.caption[g] === 'caption' && !!s[ENABLED_SETTING[g]] && (g !== 'awards' || p.AwardsTagsEnabled !== false));
    // Per-shape looks: the document's own; without one, a normalized
    // document inherits the administrator's and a legacy one has none.
    const ownShapes = s.tagShapeOverrides;
    const shapes = readShapeOverrides(ownShapes && typeof ownShapes === 'object' ? ownShapes : (legacy ? null : pick(p, 'tagShapeOverrides')));
    const tagScale = legacy ? 'default' : readScale(s.tagScale) || (s.tagScale != null ? 'default' : readScale(pick(p, 'tagScale'))) || 'default';
    const tagGap = legacy ? 'default' : readGap(s.tagGap) || (s.tagGap != null ? 'default' : readGap(pick(p, 'tagGap'))) || 'default';
    // Edge spacing: the document's own, else the administrator's; a
    // legacy document keeps the inset it always had.
    const edge = legacy ? 'default' : (readEdge(s.tagEdgeSpacing) || readEdge(pick(p, 'tagEdgeSpacing')) || 'default');
    const conf: LayoutSettings = { layout, legacy, density, tagScale, tagGap, order, orderChosen, caps: { ...DEFAULT_CAPS, ...caps }, profiles, slots: profiles[layout], indicatorGap, reserveCaption, locked: false, shapes, edge, kindLooks: kindLooksOf(s, p, legacy), lookKey: '' };
    conf.lookKey = lookKeyOf(conf);
    return conf;
}
export function promoteLegacySettings(s: LayoutDocument | undefined) {
    if (!s || !isLegacySettings(s))
        return false;
    s.tagLayout = 'corners';
    s.tagLabelDensity = 'full';
    s.tagScale = 'default';
    s.tagGap = 'default';
    s.tagGroupCaps = { ...DEFAULT_CAPS };
    s.tagGroupOrder = null;
    if (!Array.isArray(s.tagLookRules))
        s.tagLookRules = [];
    // Promotion by any layout control must not opt a legacy user into
    // the administrator's shape looks. Only an explicit shape edit does.
    if (!s.tagShapeOverrides || typeof s.tagShapeOverrides !== 'object' || Array.isArray(s.tagShapeOverrides)) {
        s.tagShapeOverrides = { landscape: null, list: null };
    }
    // Nor into the administrator's edge spacing.
    if (!readEdge(s.tagEdgeSpacing))
        s.tagEdgeSpacing = 'default';
    s.tagLayoutSettingsVersion = 1;
    return true;
}
export function lookKeyOf(conf: LayoutSettings) {
    // Kind looks join the key only when some kind differs, so every other key stays as it was.
    const kinds = Object.entries(conf.kindLooks || {}).map(([kind, look]) => `${kind}:${look.opacity}:${look.scale}`).join(',');
    return [conf.layout, conf.density, conf.tagScale, conf.tagGap, conf.locked ? 'L' : '', DEFAULT_ORDER.map((g) => conf.slots[g] || '').join(','),
        DEFAULT_ORDER.map((g) => conf.caps[g]).join(','), conf.edge === 'default' ? '' : conf.edge, ...(kinds ? [kinds] : [])].join('|');
}
export function validSlots(layout: Layout, slots: Slots | null | undefined) {
    const out: Slots = {};
    for (const [group, slot] of Object.entries(slots || {})) {
        if (normalizeGroup(group) !== null && LAYOUT_SLOTS[layout].includes(slot) && (slot !== 'dots' || group === 'quality'))
            out[normalizeGroup(group) || 'quality'] = slot;
    }
    return out;
}
export function withShape(look: ShapeLook, shapeLook: ShapeLook | null | undefined) {
    if (!shapeLook)
        return { ...look, caps: look.caps || null };
    const switches = !!shapeLook.layout && shapeLook.layout !== look.layout;
    const slots = switches ? shapeLook.slots : (look.slots || shapeLook.slots ? { ...(look.slots || {}), ...(shapeLook.slots || {}) } : null);
    const caps = look.caps || shapeLook.caps ? { ...(look.caps || {}), ...(shapeLook.caps || {}) } : null;
    return { layout: shapeLook.layout || look.layout, density: shapeLook.density || look.density,
        tagScale: shapeLook.tagScale || look.tagScale, tagGap: shapeLook.tagGap || look.tagGap, edge: look.edge || null, slots, caps };
}
export function lookSettings(base: LayoutSettings, look: ShapeLook, locked: boolean, settings: LayoutDocument = {}, plugin: LayoutDocument = {}) {
    const layout = look.layout ? normalizeLayout(look.layout) : base.layout;
    const own = validSlots(layout, look.slots);
    const slots = { ...base.profiles[layout], ...own };
    const conf: LayoutSettings = {
        ...base,
        layout,
        density: look.density ? (look.density === 'compact' ? 'compact' : 'full') : base.density,
        tagScale: readScale(look.tagScale) || base.tagScale,
        tagGap: readGap(look.tagGap) || base.tagGap,
        // A lock or item look may set its own edge spacing (an unknown one inherits).
        edge: (look.edge && hasOwn(EDGE_SPACINGS, look.edge) ? look.edge : null) || base.edge,
        caps: look.caps ? normalizeGroupCaps({ ...base.caps, ...look.caps }, plugin) : base.caps,
        // A chosen order applies everywhere; otherwise corners keeps
        // arrival order and the other layouts the built-in order.
        order: base.orderChosen ? base.order : (layout === 'corners' ? null : DEFAULT_ORDER),
        profiles: { ...base.profiles, [layout]: slots },
        slots,
        indicatorGap: Object.keys(own).length && layout === 'corners'
            ? new Set(DEFAULT_ORDER.filter((g) => slots[g] === 'tr')) : base.indicatorGap,
        reserveCaption: layout === 'caption'
            && DEFAULT_ORDER.some((g) => slots[g] === 'caption' && !!settings[ENABLED_SETTING[g]] && (g !== 'awards' || plugin.AwardsTagsEnabled !== false)),
        locked,
        lookKey: '',
    };
    conf.lookKey = lookKeyOf(conf);
    return conf;
}
function withoutPrototype<T extends object>(value: T): T { Object.setPrototypeOf(value, null); return value; }
