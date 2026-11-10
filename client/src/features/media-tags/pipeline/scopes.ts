import { either, isRecord, type JsonRecord } from './dto';

// ── Where to show ───────────────────────────────────────────────────
// Every card tag group can be limited to item types (movies, series,
// seasons, episodes) and to the Continue Watching and Next Up home rows.
// A user's switches are in tagGroupScopes ({ group: { scope: bool } }); a
// missing one follows the administrator (TagGroupScopes, and RatingTagsOn…
// for Rating), else "on". An older document's ratingTagsOn… turned off is
// kept as the user's choice; its "on", the default everyone had, follows
// the administrator (TagLayoutRules.RatingScope). People Tags are on cast
// cards, not media cards: no switch applies to them.
// Mirrors TagLayoutRules.ScopeAllows (server) for the item types.
export const SCOPE_IDS = ['movies', 'series', 'seasons', 'episodes', 'continueWatching', 'nextUp'] as const;
export type ScopeId = typeof SCOPE_IDS[number];
export const SCOPED_GROUPS = ['quality', 'genre', 'language', 'ageRating', 'status', 'awards', 'logos', 'custom'];
export const TYPE_SCOPES: Readonly<Record<string, ScopeId>> = { Movie: 'movies', Series: 'series', Season: 'seasons', Episode: 'episodes' };
const ROW_SCOPES: Readonly<Record<string, ScopeId>> = { continuewatching: 'continueWatching', nextup: 'nextUp' };
// Renderer names that differ from their group id.
const SCOPE_GROUP_ALIASES: Readonly<Record<string, string>> = { agerating: 'ageRating' };
const RATING_SCOPE_KEYS: Readonly<Record<ScopeId, string>> = { movies: 'Movies', series: 'Series', seasons: 'Seasons', episodes: 'Episodes', continueWatching: 'ContinueWatching', nextUp: 'NextUp' };
const groupId = (group: string): string => (Object.prototype.hasOwnProperty.call(SCOPE_GROUP_ALIASES, group) ? SCOPE_GROUP_ALIASES[group] : undefined) ?? group;
const scopedType = (type: string | null): ScopeId | null => (type && Object.prototype.hasOwnProperty.call(TYPE_SCOPES, type) ? TYPE_SCOPES[type] ?? null : null);

export interface ScopeHost {
    settings(): Record<string, unknown> | undefined;
    plugin(): JsonRecord | undefined;
    detectRow: (() => ((el: Element) => string) | null);
}
/** The administrator's switch for a group's scope (true when unset). */
export function scopeDefaultOf(group: string, scope: ScopeId, plugin: JsonRecord | undefined): boolean {
    if (group === 'rating') return plugin?.[`RatingTagsOn${RATING_SCOPE_KEYS[scope]}`] !== false;
    return either(either(plugin?.TagGroupScopes, group), scope) !== false;
}
/** The personal switch for a group's scope, or null when it follows the administrator. */
export function scopeOwnOf(group: string, scope: ScopeId, settings: JsonRecord | undefined): boolean | null {
    const value = either(either(settings?.tagGroupScopes ?? settings?.TagGroupScopes, group), scope);
    if (typeof value === 'boolean') return value;
    if (group === 'rating' && settings?.[`ratingTagsOn${RATING_SCOPE_KEYS[scope]}`] === false) return false;
    return null;
}
export function createTagScopes(host: ScopeHost) {
    const scopeDefault = (group: string, scope: ScopeId, plugin = host.plugin()) => scopeDefaultOf(group, scope, plugin);
    const scopeOwn = (group: string, scope: ScopeId, settings = host.settings()) => scopeOwnOf(group, scope, settings);
    /** Whether the group shows in that scope (personal, else administrator, else on). */
    function allows(groupName: string, scope: ScopeId, settings = host.settings(), plugin = host.plugin()): boolean {
        const group = groupId(groupName);
        if (group !== 'rating' && !SCOPED_GROUPS.includes(group)) return true;
        return scopeOwn(group, scope, settings) ?? scopeDefault(group, scope, plugin);
    }
    /**
     * True when a group is switched off for this card: by its item type (the card's own
     * data-type wins over the fetched item's, as for rating) or by the home row it sits in.
     * @param groupName
     * @param el - The card or anything inside it.
     * @param type - Fetched item type, used when the card carries none.
     */
    function excludes(groupName: string, el: Element | null | undefined, type?: string | null): boolean {
        const group = groupId(groupName);
        if (group !== 'rating' && !SCOPED_GROUPS.includes(group)) return false;
        const itemType = el?.closest?.('[data-type]')?.getAttribute('data-type') || type || null;
        const typeScope = scopedType(itemType);
        if (typeScope && !allows(group, typeScope)) return true;
        // Row detection reads the home section, so it only runs when a row switch is off.
        const detect = host.detectRow();
        if (el && detect && (['continueWatching', 'nextUp'] as const).some(scope => !allows(group, scope))) {
            const row = detect(el);
            const rowScope = Object.prototype.hasOwnProperty.call(ROW_SCOPES, row) ? ROW_SCOPES[row] : undefined;
            if (rowScope && !allows(group, rowScope)) return true;
        }
        return false;
    }
    /**
     * Set (or, with null, clear) a personal switch on a settings document.
     * Rating's switches are plain booleans: clearing one takes the administrator's value.
     */
    function setOwn(groupName: string, scope: ScopeId, value: boolean | null, settings = host.settings()): void {
        if (!settings) throw new TypeError('A settings document is required');
        const group = groupId(groupName);
        // An older document's Rating "off" would still count as the user's: the switch now lives in tagGroupScopes.
        if (group === 'rating') settings[`ratingTagsOn${RATING_SCOPE_KEYS[scope]}`] = value !== false;
        // One shape on write: camelCase groups and switches, whatever casing the stored document used.
        const camel = (key: string) => key.charAt(0).toLowerCase() + key.slice(1);
        const source = isRecord(settings.tagGroupScopes) ? settings.tagGroupScopes : {};
        const scopes = new Map<string, Record<string, boolean>>();
        for (const [g, values] of Object.entries(source)) {
            if (!isRecord(values)) continue;
            const set: Record<string, boolean> = Object.create(null);
            for (const [s, v] of Object.entries(values)) if (typeof v === 'boolean') set[camel(s)] = v;
            if (Object.keys(set).length) scopes.set(camel(g), set);
        }
        const set: Record<string, boolean> = Object.assign(Object.create(null), scopes.get(group));
        if (value === null) delete set[scope]; else set[scope] = value;
        if (Object.keys(set).length) scopes.set(group, set); else scopes.delete(group);
        settings.tagGroupScopes = scopes.size ? Object.fromEntries([...scopes].map(([key, values]) => [key, { ...values }])) : null;
    }
    /** Make a group follow the administrator's "Where to show" again. */
    function follow(group: string, settings = host.settings()): void {
        for (const scope of SCOPE_IDS) setOwn(group, scope, null, settings);
    }
    return { SCOPE_IDS, SCOPED_GROUPS, TYPE_SCOPES, scopeDefault, scopeOwn, allows, excludes, setOwn, follow };
}
export type TagScopes = ReturnType<typeof createTagScopes>;

// ── Settings matrix ─────────────────────────────────────────────────
// The common controls every tag group offers, per settings surface: the
// admin Media Tags page, the personal Media Tags hub and the item editor.
// The surfaces render from it, and tests/browser/settings-matrix.spec.cjs
// checks each surface against it. A control a group or surface does not
// have names the reason it shows instead (an i18n key).
const MATRIX_GROUPS = ['quality', 'genre', 'language', 'rating', 'ageRating', 'status', 'awards', 'people', 'logos', 'custom'];
const reasons: { readonly people: Readonly<Record<string, string>> } = { people: { position: 'tag_scope_people_na', limit: 'tag_scope_people_na', scopes: 'tag_scope_people_na' } };
const surfaces: Readonly<Record<string, Readonly<Record<string, string>>>> = { admin: {}, hub: {}, itemEditor: { scopes: 'tag_item_editor_scope_note' } };
export const SETTINGS_MATRIX = {
    groups: MATRIX_GROUPS,
    controls: ['enable', 'position', 'limit', 'scopes'],
    // Groups without a control, everywhere, and why.
    except: reasons,
    // Controls a whole surface does not have, and why.
    surfaces,
};
export function createSettingsMatrix(singleChipGroup: (group: string) => boolean) {
    /** Whether a group offers a common control on a surface: true, or the i18n key of the reason it does not. */
    function offers(surface: string, group: string, control: string): true | string {
        const groupReasons = group === 'people' ? reasons.people : undefined;
        const reason = groupReasons?.[control] || surfaces[surface]?.[control];
        if (reason) return reason;
        // A group that always shows one tag (Status, Age rating; Logos limited to one) has no limit to choose.
        if (control === 'limit' && singleChipGroup(group)) return 'tag_limit_single';
        return true;
    }
    return { ...SETTINGS_MATRIX, offers };
}
export type TagSettingsMatrix = ReturnType<typeof createSettingsMatrix>;
