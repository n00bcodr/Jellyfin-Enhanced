/** Existing bookmark.json records are patched, never reconstructed on ordinary saves. */
export interface Details {
 itemId: string; tmdbId?: string | null | undefined; tvdbId?: string | null | undefined;
 mediaType?: string | undefined; name?: string | undefined; type?: string | undefined;
 seasonNumber?: number | null | undefined; episodeNumber?: number | null | undefined;
}
export interface Bookmark extends Details {
 timestamp: number; label?: string | undefined; createdAt?: string | undefined; updatedAt?: string | undefined;
 syncedFrom?: string | undefined; progress?: number | undefined;
 [field: string]: unknown;
}
export interface IdentifiedBookmark extends Bookmark { id: string; exactMatch?: boolean }
export type BookmarkMap = Record<string, Bookmark>;
export interface BookmarkDocument { bookmarks: BookmarkMap; [field: string]: unknown }
export interface Owner { bookmark?: BookmarkDocument; bookmarkRevision?: string | null; bookmarkBinding?: { client: unknown; userId: string; token: string | undefined; baseUrl: string } }
export type MediaTab = 'movie' | 'tv' | 'other';
export interface Group { details: Details; bookmarks: IdentifiedBookmark[]; type?: MediaTab }
export interface Item {
 Id: string; Name?: string | undefined; Type?: string | undefined; SeriesId?: string | undefined; SeriesName?: string | undefined;
 ParentIndexNumber?: number | undefined; IndexNumber?: number | undefined; ProductionYear?: number | undefined;
 ProviderIds?: { Tmdb?: string | undefined; Tvdb?: string | undefined } | undefined;
 ImageTags?: { Primary?: string | undefined } | undefined; UserData?: { Key?: string | undefined } | undefined;
}
export interface BookmarkApi {
 add(timestamp: number, label?: string): Promise<IdentifiedBookmark | null>;
 update(id: string, updates: Partial<Bookmark>): Promise<boolean>;
 delete(id: string): Promise<boolean | null>; deleteAll(): Promise<boolean>;
 findForItem(itemId: string, tmdbId?: string | null, tvdbId?: string | null, seasonNumber?: number | null, episodeNumber?: number | null): { bookmarks: IdentifiedBookmark[]; exactMatches: IdentifiedBookmark[]; providerMatches: IdentifiedBookmark[]; hasIdMismatch: boolean };
 showModal(mode?: string, bookmark?: IdentifiedBookmark | null): Promise<void>;
 updateMarkers(): Promise<void>; formatTimestamp(seconds: number): string;
 syncBookmarks(old: IdentifiedBookmark[], details: Details, offset?: number, options?: { replaceOriginals?: boolean }): Promise<IdentifiedBookmark[]>;
 cleanupOrphaned(): Promise<{cleaned: number; errors: number}>; backfillEpisodeMetadata(): Promise<void>;
 adjustOffsets(bookmarks: IdentifiedBookmark[], offset: number): Promise<number>;
}
export interface Library {
 renderIfSectionExists(): void; hookViewEvents(): void; renderBookmarksLibrary(container: HTMLElement): Promise<void>;
 renderBookmarkItems(container: HTMLElement, groups: Record<string, Group>, tab: string): Promise<void>;
 formatTimestamp(seconds: number): string; parseTimestampInput(value: unknown): number | null;
 findAndOfferReplacement(group: Group, button: HTMLButtonElement): Promise<void>;
 showOffsetAdjustmentModal(group: Group): void; showDuplicatesSyncModal(bookmarks: BookmarkMap): void;
 isPluginPagesActive(): boolean; showPage(): void; injectNavigation(): void; setupNavigationWatcher(): void;
 handleNavigation(): void; interceptNavigation(event: Event): void; handleViewShow(event: Event): void; handleNavClick(event: Event): void;
}
