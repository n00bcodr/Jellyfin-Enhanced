import { isRecord, type JsonRecord, normalizeItemId, record, records } from './dto';
import { logPrefix, type PipelineFns, type PipelineState } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

// ── Tag look facts ─────────────────────────────────────────────────
//
// What item data said about an item that tag look rules and locks match
// on (type, series, library, genres, official rating; see factsFrom in
// core/tag-look.js), remembered from every /tag-data answer. A card
// rendered later from the renderers' local caches alone (no fetch) is
// matched on these, so library/genre/age rules apply to it and a season
// or episode inherits its series' lock. Kept in memory, and in
// localStorage alongside the renderers' caches when those persist (same
// server:user owner rule and admin clear). A card with nothing
// remembered is fetched when a rule or lock needs its data.

const LOOK_FACTS_KEY = 'JE_tagLookFacts';
const LOOK_FACTS_MAX = 3000;
const LOOK_FACT_FIELDS = ['Type', 'SeriesId', 'LibraryId', 'Genres', 'OfficialRating'];

/**
 * The item facts tag look rules and locks match on, remembered from /tag-data answers.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createLookFacts(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    /** @returns The renderers' local caches persist, so the facts do too. */
    function lookFactsPersist(): boolean {
        return JE.pluginConfig?.TagCacheServerMode === false || JE.pluginConfig?.EnableTagsLocalStorageFallback === true;
    }


    /** @returns The remembered facts, loaded on first use. */
    function lookFactsMap(): Map<string, JsonRecord> {
        if (s.lookFacts) return s.lookFacts;
        s.lookFacts = new Map();
        if (!lookFactsPersist()) return s.lookFacts;
        try {
            const ownerKey = `${LOOK_FACTS_KEY}:identity-owner`;
            const userId = JE.session?.getUserId?.()
                || (deps.hasApiClient() ? deps.apiClient().getCurrentUserId?.() : null) || '';
            const owner = `${JE.session?.getServerId?.() || ''}:${userId}`;
            if (localStorage.getItem(ownerKey) !== owner) {
                localStorage.removeItem(LOOK_FACTS_KEY);
                localStorage.setItem(ownerKey, owner);
                return s.lookFacts;
            }
            const stored = JSON.parse(localStorage.getItem(LOOK_FACTS_KEY) || '{}');
            const clearedAt = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
            if (isRecord(stored)) {
                for (const [id, facts] of Object.entries(stored)) {
                    if (isRecord(facts) && Number(facts.at) > clearedAt) s.lookFacts.set(id, facts);
                }
                // Admin clears must erase the stored payload now, even when
                // every renderer hits its cache and no later save is scheduled.
                if (s.lookFacts.size !== Object.keys(stored).length) saveLookFacts();
            }
        } catch (err) {
            console.warn(`${logPrefix} Ignoring unreadable tag look facts`, err);
        }
        return s.lookFacts;
    }


    /** Write the remembered facts (registered with JE._cacheManager). */
    function saveLookFacts() {
        if (!s.lookFacts || !lookFactsPersist()) return;
        try {
            localStorage.setItem(LOOK_FACTS_KEY, JSON.stringify(Object.fromEntries(s.lookFacts)));
        } catch (err) {
            console.warn(`${logPrefix} Failed to save tag look facts`, err);
        }
    }


    /**
     * Remember what an item's data says for tag looks (newest last; past
     * LOOK_FACTS_MAX the oldest go).
     * @param itemId - Normalised item id.
     * @param item - /tag-data or /Items item.
     * @param [source] - Whether library membership was resolved.
     */
    function rememberLookFacts(itemId: string, item: JsonRecord, source: 'tag-data'|'item' = 'tag-data') {
        if (!itemId || !item) return;
        const facts: Record<string, unknown> = { at: Date.now(), source };
        for (const field of LOOK_FACT_FIELDS) {
            if (item[field] !== undefined && item[field] !== null) facts[field] = item[field];
        }
        const map = lookFactsMap();
        map.delete(itemId);
        map.set(itemId, facts);
        for (const oldest of map.keys()) {
            if (map.size <= LOOK_FACTS_MAX) break;
            map.delete(oldest);
        }
        if (!lookFactsPersist() || !JE._cacheManager) return;
        if (!s.lookFactsSaveRegistered) {
            JE._cacheManager.register(saveLookFacts);
            s.lookFactsSaveRegistered = true;
        }
        JE._cacheManager.markDirty();
    }


    /**
     * Whether remembered data came from the enriched endpoint. Older facts
     * without provenance are complete only when they include a library id.
     * */
    function enrichedLookFacts(facts: JsonRecord|undefined): boolean {
        return !!facts && (facts.source === 'tag-data' || (facts.source == null && /^[a-f0-9]{32}$/i.test(String(facts.LibraryId || ''))));
    }


    /** @returns An enabled rule needs enriched library membership. */
    function needsLibraryFacts(): boolean {
        return !!JE.core.tagLook?.read().rules.some((rule) => rule.enabled && rule.when.some((cond) => cond.field === 'library'));
    }


    /**
     * An item's data for tag look rules and locks, the way its cards are
     * matched: its server tag-cache entry, else the remembered facts, else
     * fetched from /tag-data (and remembered).
     * @param itemId - Normalised item id.
     * @returns Null when the server has no such item.
     */
    async function itemLookFacts(itemId: string): Promise<JsonRecord|null> {
        const serverEntry = s.serverCache?.get(itemId);
        if (serverEntry) return serverEntry;
        const known = lookFactsMap().get(itemId);
        if (known && enrichedLookFacts(known)) return known;
        const userId = deps.apiClient().getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const response = record(await deps.apiClient().ajax({
            type: 'POST',
            // With the episode and collection-member dates: the Status renderer draws (and keeps) this answer.
            url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, { latestEpisode: true }),
            data: JSON.stringify([itemId]),
            contentType: 'application/json',
            dataType: 'json'
        }));
        if (userId !== deps.apiClient().getCurrentUserId() || epoch !== JE.session?.getEpoch?.()) return null;
        const item = records(response.Items).find((i) => normalizeItemId(i.Id ?? '') === itemId) || null;
        if (item) rememberLookFacts(itemId, item);
        return item;
    }

    return { lookFactsMap, rememberLookFacts, enrichedLookFacts, needsLibraryFacts, itemLookFacts };
}
