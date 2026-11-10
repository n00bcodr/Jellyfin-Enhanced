import type { RandomSettings } from './host';
import type { DetailsItem } from './wire';

// Lucide dice-1..dice-6 faces, 24px to match the header's other icons.
export const DICE_FACES: readonly string[] = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M12 12h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M15 9h.01"/><path d="M9 15h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M12 12h.01"/><path d="M8 16h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M16 12h.01"/><path d="M16 16h.01"/><path d="M8 8h.01"/><path d="M8 12h.01"/><path d="M8 16h.01"/></svg>'
];

/** A random dice face index, optionally excluding one (to avoid repeats). */
export function randomDiceFace(random: () => number, excludeIndex?: number): number {
    let face: number;
    do { face = Math.floor(random() * DICE_FACES.length); } while (face === excludeIndex);
    return face;
}

// Containers the button can be scoped to.
export const CONTAINER_TYPES: readonly string[] = ['Playlist', 'BoxSet'];
export function isContainer(item: DetailsItem | null): item is DetailsItem {
    return item !== null && item.Type !== undefined && CONTAINER_TYPES.includes(item.Type);
}

/**
 * Item types the user opted into, as an IncludeItemTypes value. Inside a
 * container, episodes count as "shows" so an episode playlist is not empty.
 */
export function includeItemTypes(settings: RandomSettings, inContainer: boolean): string {
    const types: string[] = [];
    if (settings.randomIncludeMovies) types.push('Movie');
    if (settings.randomIncludeShows) types.push('Series', ...(inContainer ? ['Episode'] : []));
    return types.join(',');
}

/** Candidate query path: a container's direct children, else the whole library. */
export function candidatesPath(userId: string, settings: RandomSettings, parentId: string | null): string {
    const scope = parentId ? `ParentId=${encodeURIComponent(parentId)}` : 'Recursive=true';
    return `/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes(settings, !!parentId)}&${scope}&SortBy=Random&Limit=100&Fields=ExternalUrls`;
}

/** Series need unplayed episodes; everything else must simply not be played. */
export function filterUnwatched(settings: RandomSettings, items: DetailsItem[]): DetailsItem[] {
    if (!settings.randomUnwatchedOnly) return items;
    return items.filter(item => item.Type === 'Series'
        ? (item.UnplayedItemCount ?? 0) > 0
        : !item.Played);
}

/** Details route for an item, with the server id when known. */
export function detailsRoute(itemId: string, serverId: string): string {
    return `/details?id=${itemId}${serverId ? `&serverId=${serverId}` : ''}`;
}
