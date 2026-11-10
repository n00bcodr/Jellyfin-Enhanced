import { isRecord } from './domain';
import type { SessionCache, SessionScope } from './types';

// Which genre, studio or person a Jellyfin page is, and which TMDB id that maps to, rarely
// changes, yet resolving it costs a round trip or two before a section can fetch its first
// page. Lookups therefore also live in sessionStorage so a reload in the tab resolves at once.
// They are kept per server AND per user: the lookups run as the signed-in user (library access,
// Seerr results filtered by the user's policy), so one user's resolution is never handed to the
// next user signing in in the same tab.
const STORAGE_PREFIX = 'je-discovery-resolution-v2:';
/** Entries written per server only (before they were scoped by user): removed on first use. */
const LEGACY_PREFIX = 'je-discovery-resolution:';
export const STORAGE_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;
/** Stands in for an unknown server id: those entries are never written to sessionStorage. */
const MEMORY_ONLY_SERVER = '';

export interface SessionCacheDependencies {
    storage(): Storage;
    userId(): string | null | undefined;
    serverId(): string | null | undefined;
    now(): number;
}
interface Entry<T> { value: T; storedAt: number }

/** Builds caches sharing one once-per-page-load purge of the server-only entries. */
export function createSessionCacheFactory(deps: SessionCacheDependencies) {
    let legacyPurged = false;
    function purgeLegacy(): void {
        if (legacyPurged) return;
        legacyPurged = true;
        try {
            const storage = deps.storage();
            for (let index = storage.length - 1; index >= 0; index--) {
                const key = storage.key(index);
                if (key?.startsWith(LEGACY_PREFIX)) storage.removeItem(key);
            }
        } catch { /* Storage unavailable: nothing to clean up. */ }
    }

    /**
     * A lookup cache whose entries are also kept in sessionStorage. `scope()` binds has/get/set
     * to the user signed in when it is called: a lookup takes its scope before it awaits, so a
     * result landing after a user switch is stored for the user it was fetched for. While no
     * user is known nothing is cached; while the server is unknown entries stay in memory.
     */
    return function createSessionCache<T>(name: string, isValid: (value: unknown) => value is T): SessionCache<T> {
        let memoryKey: string | null = null;
        let memoryEntries: Map<string, Entry<T>> | null = null;

        function storageKey(): string | null {
            const userId = deps.userId();
            if (!userId) return null;
            return `${STORAGE_PREFIX}${deps.serverId() || MEMORY_ONLY_SERVER}:${userId}:${name}`;
        }
        const persisted = (key: string) => !key.startsWith(`${STORAGE_PREFIX}${MEMORY_ONLY_SERVER}:`);

        function load(key: string): Map<string, Entry<T>> {
            const entries = new Map<string, Entry<T>>();
            if (!persisted(key)) return entries;
            purgeLegacy();
            try {
                const parsed: unknown = JSON.parse(deps.storage().getItem(key) || 'null');
                const stored = isRecord(parsed) ? parsed.entries : null;
                if (!isRecord(stored)) return entries;
                const now = deps.now();
                for (const [entryKey, entry] of Object.entries(stored)) {
                    if (!isRecord(entry)) continue;
                    const { storedAt, value } = entry;
                    if (typeof storedAt !== 'number') continue;
                    const age = now - storedAt;
                    if (!(age >= 0 && age < STORAGE_TTL_MS) || !isValid(value)) continue;
                    entries.set(entryKey, { value, storedAt });
                }
            } catch { /* Unreadable or not ours: start empty. */ }
            return entries;
        }
        /** The in-memory set for the signed-in user; straight from storage for a lookup that outlived them. */
        function entriesFor(key: string): Map<string, Entry<T>> {
            if (key === memoryKey && memoryEntries) return memoryEntries;
            const entries = load(key);
            if (key === storageKey()) {
                memoryKey = key;
                memoryEntries = entries;
            }
            return entries;
        }
        function fresh(entries: Map<string, Entry<T>>, entryKey: string): Entry<T> | undefined {
            const entry = entries.get(entryKey);
            if (!entry) return undefined;
            if (deps.now() - entry.storedAt < STORAGE_TTL_MS) return entry;
            entries.delete(entryKey);
            return undefined;
        }
        function scope(): SessionScope<T> {
            const key = storageKey();
            return {
                has: entryKey => !!key && !!fresh(entriesFor(key), String(entryKey)),
                get: entryKey => key ? fresh(entriesFor(key), String(entryKey))?.value : undefined,
                set(entryKey, value) {
                    if (!key) return;
                    const entries = entriesFor(key);
                    entries.delete(String(entryKey));
                    entries.set(String(entryKey), { value, storedAt: deps.now() });
                    // Oldest first (insertion order): drop the oldest over the cap.
                    for (const oldest of entries.keys()) {
                        if (entries.size <= MAX_ENTRIES) break;
                        entries.delete(oldest);
                    }
                    if (!persisted(key) || !isValid(value)) return;
                    try {
                        const stored = [...entries].filter(([, entry]) => isValid(entry.value));
                        deps.storage().setItem(key, JSON.stringify({ entries: Object.fromEntries(stored) }));
                    } catch { /* Storage full or unavailable: the cache keeps working from memory. */ }
                }
            };
        }
        return { scope };
    };
}
