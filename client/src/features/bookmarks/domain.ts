import type { Bookmark, BookmarkMap } from './types';
/** Ignore malformed records for presentation; retain their bytes in the saved document. */
export function displayBookmarks(input: BookmarkMap | undefined): BookmarkMap {
 return Object.fromEntries(Object.entries(input ?? {}).filter((entry): entry is [string, Bookmark] => {
  const value: unknown = entry[1];
  return typeof value === 'object' && value !== null && 'itemId' in value && typeof value.itemId === 'string'
   && ['name', 'mediaType', 'label', 'tmdbId', 'tvdbId', 'syncedFrom'].every(key => !Object.prototype.hasOwnProperty.call(value, key) || Reflect.get(value, key) == null || typeof Reflect.get(value, key) === 'string')
   && 'timestamp' in value && typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) && value.timestamp >= 0;
 }));
}
export function formatTimestamp(seconds: number): string {
 const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
 const h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = Math.floor(value % 60);
 return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function parseTimestampInput(value: unknown): number | null {
 if (typeof value !== 'string' && typeof value !== 'number') return null;
 const text = String(value).trim();
 if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(text)) return null;
 const parts = text.split(':').map(Number);
 const result = parts.reduce((sum, part) => sum * 60 + part, 0);
 return Number.isFinite(result) ? result : null;
}
