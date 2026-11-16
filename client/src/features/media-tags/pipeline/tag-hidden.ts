import { either, type JsonRecord } from './dto';

// ── Hidden tags ─────────────────────────────────────────────────────
// Per group, the Tag Styles labels (tiles of the admin Colours tag list)
// whose chips never draw, from the public configuration's TagHiddenValues
// ({ Genre: ['drama'], ... }). A label hides exactly the chips it colours;
// age rating boards come expanded as the ratings on them
// (TagHiddenAgeRatings). The layout (layout/present.ts) drops hidden chips
// before each group's limit; languages and logos are dropped by their
// renderers, before their own grouping and limit. Mirrors TagHiddenRules /
// TagHiddenSet (server), which native posters use.
export const HIDDEN_GROUPS: readonly string[] = ['quality', 'ageRating', 'rating', 'genre', 'status', 'language', 'awards', 'logos', 'custom'];
// Renderer names that differ from their group id.
const GROUP_ALIASES: Readonly<Record<string, string>> = { agerating: 'ageRating' };
const groupId = (group: string): string => (Object.prototype.hasOwnProperty.call(GROUP_ALIASES, group) ? GROUP_ALIASES[group] : undefined) ?? group;

export interface TagHidden {
    readonly GROUPS: readonly string[];
    /** Whether chips of this Tag Styles label are hidden. */
    hides(group: string, label: unknown): boolean;
    /** Whether a group hides anything. */
    any(group: string): boolean;
    /** Whether an age rating badge (its normalized rating) is on a hidden board. */
    hidesAgeRating(rating: unknown): boolean;
}

/** @param plugin - The public configuration, read at call time (it is replaced when settings are saved). */
export function createTagHidden(plugin: () => JsonRecord | undefined): TagHidden {
    let memo: { doc: unknown; ages: unknown; sets: Map<string, Set<string>>; ratings: Set<string> } = { doc: undefined, ages: undefined, sets: new Map(), ratings: new Set() };
    /** The hidden labels of a group (read fresh when the configuration's lists are replaced). */
    function labels(group: string): Set<string> {
        const doc = plugin()?.TagHiddenValues;
        const ages = plugin()?.TagHiddenAgeRatings;
        if (memo.doc !== doc || memo.ages !== ages) memo = { doc, ages, sets: new Map(), ratings: new Set(Array.isArray(ages) ? ages.map(String) : []) };
        let set = memo.sets.get(group);
        if (!set) {
            const list = either(doc, group);
            set = new Set(Array.isArray(list) ? list.map(String) : []);
            memo.sets.set(group, set);
        }
        return set;
    }
    return {
        GROUPS: HIDDEN_GROUPS,
        hides: (group, label) => label !== null && label !== undefined && labels(groupId(group)).has(String(label)),
        any(group) {
            const id = groupId(group);
            return labels(id).size > 0 || (id === 'ageRating' && memo.ratings.size > 0);
        },
        hidesAgeRating(rating) {
            labels('ageRating');
            return rating !== null && rating !== undefined && memo.ratings.has(String(rating));
        },
    };
}
