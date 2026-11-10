/**
 * @file The Tag Styles editor's data: the catalog the server sends (GET
 * tag-styles/catalog, untrusted, decoded here) and the stored document's
 * colour entries.
 */

/** The three colour properties a chip has. */
export type ColourField = 'background' | 'border' | 'text';
export type Colours = Partial<Record<ColourField, string>>;
export interface Label { key: string; name: string }
export interface AgeBoard { id: string; ratings: string[] }
/** A preset's colours for one label (the catalog names the text colour `color`). */
export interface PaletteEntry { background?: string; border?: string; color?: string }
export interface Catalog {
    presets: string[];
    groups: Record<string, Label[]>;
    palettes: Record<string, Record<string, PaletteEntry>>;
    age: AgeBoard[];
    genreIcons: Record<string, string>;
    poster: { worstContrast: number | null };
}

const member = (value: unknown, key: string): unknown => (value && typeof value === 'object' ? Reflect.get(value, key) : undefined);
const entriesOf = (value: unknown): Array<[string, unknown]> => (value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * The catalog, or null when the answer is not one. Malformed parts read as
 * empty (a label without a key, a palette colour that is not text).
 * @param value - GET tag-styles/catalog.
 * @returns {Catalog|null}
 */
export function decodeCatalog(value: unknown): Catalog | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const groups: Record<string, Label[]> = {};
    for (const [g, labels] of entriesOf(member(value, 'groups'))) {
        groups[g] = (Array.isArray(labels) ? labels : []).flatMap((l: unknown) => {
            const key = member(l, 'key');
            const name = member(l, 'name');
            return typeof key === 'string' ? [{ key, name: typeof name === 'string' ? name : key }] : [];
        });
    }
    const palettes: Record<string, Record<string, PaletteEntry>> = {};
    for (const [preset, labels] of entriesOf(member(value, 'palettes'))) {
        const out: Record<string, PaletteEntry> = {};
        for (const [key, entry] of entriesOf(labels)) {
            const p: PaletteEntry = {};
            for (const f of ['background', 'border', 'color'] as const) {
                const v = member(entry, f);
                if (typeof v === 'string') p[f] = v;
            }
            out[key] = p;
        }
        palettes[preset] = out;
    }
    const age = (Array.isArray(member(value, 'age')) ? strictArray(member(value, 'age')) : []).flatMap((a) => {
        const id = member(a, 'id');
        return typeof id === 'string' ? [{ id, ratings: strings(member(a, 'ratings')) }] : [];
    });
    const genreIcons: Record<string, string> = {};
    for (const [key, icon] of entriesOf(member(value, 'genreIcons'))) if (typeof icon === 'string') genreIcons[key] = icon;
    const worst = member(member(value, 'poster'), 'worstContrast');
    return { presets: strings(member(value, 'presets')), groups, palettes, age, genreIcons, poster: { worstContrast: typeof worst === 'number' && Number.isFinite(worst) ? worst : null } };
}
function strictArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** The stored document's state: preset, per-group presets, group and label overrides. */
export interface StyleState {
    preset: string;
    groupPresets: Record<string, string>;
    groups: Record<string, Colours>;
    labels: Record<string, Colours>;
}
export const emptyState = (preset = 'default'): StyleState => ({ preset, groupPresets: {}, groups: {}, labels: {} });

/**
 * An own member of a map (never an inherited one).
 * @param map
 * @param key
 * @returns {T|undefined}
 */
export function ownOf<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
