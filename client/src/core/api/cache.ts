/** Bounded LRU and invalidation clocks, independent of transport or browser globals. */
export function createCache(config: { ttlMs: number; maxEntries: number }, now: () => number) {
    const entries = new Map<string, { data: unknown; timestamp: number }>();
    const clears = new Map<string, number>();
    let clock = 0, floor = 0;
    function get(key: string): unknown {
        const entry = entries.get(key);
        if (!entry) return null;
        entries.delete(key);
        if (now() - entry.timestamp >= config.ttlMs) return null;
        entries.set(key, entry);
        return entry.data;
    }
    function set(key: string, data: unknown, requestedAt?: number): void {
        if (requestedAt !== undefined) {
            if (requestedAt < floor) return;
            for (const [pattern, at] of clears) if (at > requestedAt && key.includes(pattern)) return;
        }
        entries.delete(key);
        while (entries.size >= Math.max(1, config.maxEntries)) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
        }
        if (config.maxEntries > 0) entries.set(key, { data, timestamp: now() });
    }
    function clear(): void { entries.clear(); floor = ++clock; clears.clear(); }
    function clearMatching(pattern: string): void {
        clears.delete(pattern); clears.set(pattern, ++clock);
        if (clears.size > 32) {
            const oldest = clears.entries().next();
            if (!oldest.done) { clears.delete(oldest.value[0]); floor = oldest.value[1]; }
        }
        for (const key of entries.keys()) if (key.includes(pattern)) entries.delete(key);
    }
    return { get, set, clear, clearMatching, stamp: () => clock };
}
