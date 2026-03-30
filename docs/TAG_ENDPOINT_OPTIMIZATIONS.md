# Tag Data Endpoint Optimization Analysis

**Date**: 2026-03-30
**Endpoint**: `GET /JellyfinEnhanced/tag-data/{userId}?ids=id1,id2,...`
**Current baseline**: TV Shows Library with 60 items = 134ms, 5 API calls

## Optimization Candidates

### OPT-1: Batch Item Lookup (Replace N GetItemById with 1 GetItemList)

**Current**: Sequential `_libraryManager.GetItemById<BaseItem>(itemId, user)` per item in a foreach loop.
Each call is a separate cache lookup + library access check.

**Proposed**: Single `_libraryManager.GetItemList(new InternalItemsQuery { ItemIds = ids, User = user })` call
to fetch all items at once. The library manager already supports this pattern (used at line 3969 in the
calendar endpoint).

**Expected impact**: Reduces N item lookups to 1 batch query. Biggest win for large batches (50+ items).

**Tradeoffs**:
- IMPORTANT: Known Jellyfin SDK quirk -- `GetItemList` with `User` + `ItemIds` does NOT filter by library
  access. Must validate access separately or use GetItemById per-item as fallback.
- Need to handle the access filtering differently.

**Verdict**: Risky due to the SDK quirk. Need per-item access check anyway.

---

### OPT-2: Parallel First-Episode Queries

**Current**: Sequential `GetItemList(episodeQuery)` per Series/Season, one at a time in the foreach loop.
For 30 Series items, this is 30 sequential database queries.

**Proposed**: Collect all Series/Season IDs, then run the first-episode queries in parallel using
`Task.WhenAll()` or `Parallel.ForEachAsync()`.

**Expected impact**: 30 sequential queries (each ~2-5ms) = 60-150ms. In parallel = ~5-10ms total.

**Tradeoffs**:
- Increases concurrent database load
- Need to limit parallelism to avoid connection pool exhaustion
- Database queries are CPU-bound in SQLite so parallelism may not help as much

**Verdict**: Good win. Use `Parallel.ForEachAsync` with `MaxDegreeOfParallelism = 4`.

---

### OPT-3: Skip GetMediaSources for Series/Season (Only Need First Episode's Streams)

**Current**: Calls `item.GetMediaSources(false)` for EVERY item including Series and Season, which
don't have playable media files. This returns empty results for containers but still does work.

**Proposed**: Only call `GetMediaSources` for Movies and Episodes (items with actual media files).
For Series/Season, skip it entirely since the tag renderers use FirstEpisode's streams instead.

**Expected impact**: Eliminates ~30 unnecessary GetMediaSources calls for Series items.

**Tradeoffs**: None -- Series/Season items never have media sources. This is pure waste removal.

**Verdict**: Easy win, zero risk.

---

### OPT-4: Server-Side Memory Cache for First Episodes

**Current**: Each request re-queries the first episode for every Series/Season. On page reload
or navigation back, the same first episodes are fetched again.

**Proposed**: Add a `ConcurrentDictionary<Guid, FirstEpisodeData>` static cache with a 5-minute TTL.
First-episode data rarely changes (only when new episodes are added).

**Expected impact**: Subsequent page loads hit cache instead of querying. First load unchanged.

**Tradeoffs**:
- Memory usage (~1KB per cached series, negligible for typical libraries)
- Stale data for up to 5 minutes if new episodes are added
- Need cache invalidation on library scan completion

**Verdict**: Good for repeat visits. Marginal for first load.

---

### OPT-5: Trim Response Payload (Remove Unused Fields)

**Current**: Returns full MediaSources objects which include file paths, container info, bitrate,
and many fields the tag renderers don't use. The response for 60 items can be several hundred KB.

**Proposed**: Return only the fields tag renderers actually need:
- Genre renderer: `Genres` only
- Language renderer: `MediaStreams[].Language` where `Type == Audio`
- Quality renderer: `MediaStreams[].{Height, Codec, VideoRangeType, Channels, ChannelLayout, DisplayTitle, Type}`
- Rating renderer: `CommunityRating`, `CriticRating`

Build a minimal DTO instead of returning full MediaSource/MediaStream objects.

**Expected impact**: Response size reduction of ~60-80%. Faster JSON serialization and network transfer.

**Tradeoffs**:
- More coupling between backend and frontend (backend needs to know what frontend needs)
- If a new tag renderer needs a different field, backend must be updated too

**Verdict**: Good win for response size. Moderate implementation effort.

---

### OPT-6: Parallel.ForEachAsync for the Entire Item Processing Loop (from Codex)

**Current**: The entire foreach loop processes items sequentially.

**Proposed**: Use `Parallel.ForEachAsync` for the entire item processing pipeline (lookup + media sources + first episode).

**Expected impact**: Significant for large batches. 60 items at ~3ms each = 180ms sequential, ~15ms parallel.

**Tradeoffs**:
- Thread-safety of `results` list (need ConcurrentBag or lock)
- SQLite may serialize concurrent queries anyway
- Risk of connection pool exhaustion

**Verdict**: Moderate risk, potentially high reward. Test with thread-safe collection.

---

### OPT-7: Direct EF Core Query for First Episodes (from Codex)

**Current**: Uses `_libraryManager.GetItemList()` which goes through the full Jellyfin query pipeline.

**Proposed**: Use `_dbContextFactory` to query the database directly with EF Core, fetching all first
episodes in a single SQL query with GROUP BY ParentId.

```sql
SELECT * FROM BaseItems
WHERE Type = 'Episode' AND ParentId IN (@ids)
GROUP BY ParentId
ORDER BY PremiereDate ASC
```

**Expected impact**: Replaces N queries with 1 SQL query. Could be the biggest win.

**Tradeoffs**:
- Bypasses Jellyfin's library access checks
- Need to handle the EF Core entity mapping manually
- MediaStreams are in a separate table (need JOIN)
- More complex implementation

**Verdict**: Highest potential but most complex. The access check bypass is concerning.

---

## Implementation Priority

| # | Optimization | Risk | Effort | Impact | Priority |
|---|-------------|------|--------|--------|----------|
| 3 | Skip MediaSources for Series/Season | None | 5 min | Medium | 1 |
| 2 | Parallel first-episode queries | Low | 15 min | High | 2 |
| 5 | Trim response payload | None | 30 min | Medium | 3 |
| 4 | Server-side first-episode cache | Low | 20 min | Medium (repeat visits) | 4 |
| 6 | Parallel entire loop | Medium | 15 min | High | 5 |
| 1 | Batch GetItemList | High (SDK quirk) | 20 min | Medium | 6 |
| 7 | Direct EF Core query | High | 1 hour | Highest | 7 |

## Testing Results

_(Will be filled in after implementing and benchmarking each)_
