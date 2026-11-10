import { isMissingItem, lease, readItems, persistBookmarks, bookmarkOperation, type BookmarkApiClient, type BookmarkHost } from './host';
import { formatTimestamp } from './domain';
import type { Bookmark, Details, IdentifiedBookmark, Owner } from './types';
export function createBookmarkState(JE: BookmarkHost, getApi: () => BookmarkApiClient, getCurrentItemData: () => {itemId: string} | null) {
 const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks:';
  // Notify other views (e.g., CustomTabs library) when bookmarks change
  function emitBookmarksUpdated(reason = 'updated') {
    try {
      document.dispatchEvent(new CustomEvent('je-bookmarks-updated', { detail: { reason } }));
    } catch (e) {
      console.warn(`${logPrefix} Failed to emit update event`, e);
    }
  }



  // Operations run behind earlier saves and use the owner's loaded revision.
  // The POST waits
  // behind earlier saves. If two mutations overlapped, the first one's rollback could
  // undo the second's saved change or bring back a record the server no longer has.
  // So each user's mutations run one at a time: mutate, save and, on failure, roll
  // back before the next one touches memory.
  const mutationQueues = new WeakMap<Owner, Promise<unknown>>();

  /**
   * Runs a bookmark mutation once every earlier mutation for the same owner has settled.
   * @template T
   * @param {object} owner - The `JE.userConfig` object the mutation writes to.
   * @param {() => Promise<T>} mutation - Mutates memory, saves and rolls back its own change on failure.
   * @returns {Promise<T>} The mutation's own result or rejection.
   */
  function queueBookmarkMutation<T>(owner: Owner, mutation: () => Promise<T>): Promise<T> {
    const run = (mutationQueues.get(owner) || Promise.resolve()).then(mutation);
    mutationQueues.set(owner, run.catch(() => {}));
    return run;
  }

  /**
   * New bookmark data structure:
   * {
   *   "unique-bookmark-id": {
   *     itemId: "jellyfin-item-id",
   *     tmdbId: "12345",
   *     tvdbId: "67890",
   *     mediaType: "movie" | "tv",
   *     name: "Item Name",
   *     timestamp: 123.45,
   *     label: "Epic scene" (optional),
   *     createdAt: ISO date string,
   *     updatedAt: ISO date string
   *   }
   * }
   */

  /**
   * Get current video item data (similar to osd-rating.js)
   */
  let itemDetailsCache: {owner: Owner; epoch: number; itemId: string; data: Details | null; pending: Promise<Details | null> | null} | null = null;

  /**
   * Fetch full item details including TMDB/TVDB IDs (cached per item for a few seconds)
   */
  async function fetchItemDetails(itemId: string): Promise<Details | null> {
    const owner = JE.userConfig;
    const epoch = JE.session ? JE.session.getEpoch() : 0;
    if (!itemDetailsCache || itemDetailsCache.owner !== owner
        || itemDetailsCache.epoch !== epoch || itemDetailsCache.itemId !== itemId) {
      itemDetailsCache = { owner, epoch, itemId, data: null, pending: null };
    }
    // Keep each in-flight lookup attached to its original owner and item.
    const cache = itemDetailsCache;
    if (cache.itemId === itemId && cache.data) {
      return cache.data;
    }

    if (cache.pending && cache.itemId === itemId) {
      return cache.pending;
    }

    const fetchPromise = (async () => {
      try {
        const userId = getApi().getCurrentUserId?.();
        if (!userId) return null;

        const result = readItems(await getApi().ajax({
          type: 'GET',
          url: getApi().getUrl(`/Users/${userId}/Items`, {
            Ids: itemId,
            Fields: 'ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber'
          }),
          dataType: 'json'
        }));

        if (JE.userConfig !== owner || (JE.session && !JE.session.isCurrent(epoch))) return null;
        const item = result[0];
        if (!item) return null;

        // For episodes/seasons, also get series TMDB/TVDB
        let sourceItem = item;
        if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId) {
          try {
            const seriesResult = readItems(await getApi().ajax({
              type: 'GET',
              url: getApi().getUrl(`/Users/${userId}/Items`, {
                Ids: item.SeriesId,
                Fields: 'ProviderIds,Type,Name'
              }),
              dataType: 'json'
            }));
            const seriesItem = seriesResult[0];
            if (seriesItem) {
              // TMDB has no per-episode ID, so fall back to the series' ID. TVDB does
              // have a unique per-episode ID, so prefer the episode's own.
              sourceItem = {
                ...item,
                ProviderIds: {
                  ...(item.ProviderIds || {}),
                  Tmdb: seriesItem.ProviderIds?.Tmdb || item.ProviderIds?.Tmdb,
                  Tvdb: item.ProviderIds?.Tvdb || seriesItem.ProviderIds?.Tvdb
                }
              };
            }
          } catch (e) {
            console.warn(`${logPrefix} Failed to fetch series info:`, e);
          }
        }

        const tmdbId = sourceItem.ProviderIds?.Tmdb || null;
        const tvdbId = sourceItem.ProviderIds?.Tvdb || null;
        const mediaType = item.Type === 'Movie' ? 'movie'
          : (item.Type === 'Series' || item.Type === 'Episode' || item.Type === 'Season') ? 'tv'
          : (item.Type || '').toString().toLowerCase();

        // tmdbId is series-level for episodes, so track season/episode too for fallback matching.
        const seasonNumber = item.Type === 'Episode' ? (item.ParentIndexNumber ?? null) : null;
        const episodeNumber = item.Type === 'Episode' ? (item.IndexNumber ?? null) : null;

        const details = {
          itemId: item.Id,
          tmdbId,
          tvdbId,
          mediaType,
          name: item.Name || 'Unknown',
          type: item.Type,
          seasonNumber,
          episodeNumber
        };

        if (JE.userConfig !== owner || (JE.session && !JE.session.isCurrent(epoch))) return null;
        cache.data = details;
        return details;
      } catch (e) {
        console.warn(`${logPrefix} Error fetching item details:`, e);
        return null;
      } finally {
        cache.pending = null;
      }
    })();

    cache.itemId = itemId;
    cache.pending = fetchPromise;
    return fetchPromise;
  }

  /**
   * Generate unique bookmark ID
   */
  function generateBookmarkId() {
    return `bm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Find bookmarks for current item (by itemId or TMDB/TVDB fallback)
   * Returns both exact matches and provider ID matches separately
   */
  function findBookmarksForItem(itemId: string, tmdbId?: string | null, tvdbId?: string | null, seasonNumber: number | null = null, episodeNumber: number | null = null) {
    const allBookmarks = JE.userConfig?.bookmark?.bookmarks || {};
    const exactMatches = [];
    const providerMatches = [];
    // tmdbId is series-level for episodes, so fallback matching must also require the
    // same episode number or it pulls in bookmarks from unrelated episodes.
    const isEpisode = episodeNumber !== null;

    for (const [bookmarkId, bookmark] of Object.entries(allBookmarks)) {
      // Skip invalid bookmarks
      if (typeof bookmark !== 'object' || bookmark === null) continue;

      // Direct itemId match (preferred)
      if (bookmark.itemId === itemId) {
        exactMatches.push({ ...bookmark, id: bookmarkId, exactMatch: true });
        continue;
      }

      // Only bookmarks with episode metadata get the stricter check; legacy bookmarks
      // (no episodeNumber) fall back to the old provider-only matching behavior.
      if (isEpisode && bookmark.episodeNumber != null) {
        const bookmarkIsSameEpisode = bookmark.episodeNumber === episodeNumber
          && (bookmark.seasonNumber ?? null) === (seasonNumber ?? null);
        if (!bookmarkIsSameEpisode) continue;
      }

      // Fallback: TMDB/TVDB match (different item ID)
      if (tmdbId && bookmark.tmdbId === tmdbId) {
        providerMatches.push({ ...bookmark, id: bookmarkId, exactMatch: false });
        continue;
      }

      if (tvdbId && bookmark.tvdbId === tvdbId) {
        providerMatches.push({ ...bookmark, id: bookmarkId, exactMatch: false });
      }
    }

    // Use exact matches if available, otherwise use provider matches
    const bookmarks = exactMatches.length > 0 ? exactMatches : providerMatches;
    const hasIdMismatch = exactMatches.length === 0 && providerMatches.length > 0;

    return { bookmarks, hasIdMismatch, exactMatches, providerMatches };
  }

  /**
   * Add a new bookmark
   */
  async function addBookmark(timestamp: number, label = '') {
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid bookmark timestamp');
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    const itemData = getCurrentItemData();
    if (!itemData) {
      JE.toast(JE.t('toast_bookmark_no_item'), 3000);
      return null;
    }

    // Fetch full details
    const details = await fetchItemDetails(itemData.itemId);
    if (!isCurrentOwner()) return null;
    if (!details) {
      JE.toast(JE.t('toast_bookmark_fetch_failed'), 3000);
      return null;
    }

    return queueBookmarkMutation(owner, async () => {
      // An earlier queued mutation may have outlived this user's session.
      if (!isCurrentOwner()) return null;
      const bookmarkId = generateBookmarkId();
      const now = new Date().toISOString();

      const bookmark = {
        itemId: details.itemId || '',
        tmdbId: details.tmdbId || '',
        tvdbId: details.tvdbId || '',
        mediaType: details.mediaType || '',
        name: details.name || '',
        timestamp: timestamp,
        label: label || '',
        createdAt: now,
        updatedAt: now,
        syncedFrom: '',
        seasonNumber: details.seasonNumber ?? null,
        episodeNumber: details.episodeNumber ?? null
      };

      // Initialize bookmark structure if needed
      if (!owner.bookmark) {
        owner.bookmark = { bookmarks: {} };
      }
      if (!owner.bookmark.bookmarks) {
        owner.bookmark.bookmarks = {};
      }

      const bookmarks = owner.bookmark.bookmarks;
      bookmarks[bookmarkId] = bookmark;

      try {
        await persistBookmarks(JE, getApi, owner, [bookmarkOperation('create', bookmarkId, bookmark)]);
        console.log(`${logPrefix} Bookmark added:`, bookmarkId, bookmark);
        if (isCurrentOwner()) emitBookmarksUpdated('add');
        return { ...bookmark, id: bookmarkId };
      } catch (e) {
        console.error(`${logPrefix} Failed to save bookmark:`, e);
        delete bookmarks[bookmarkId];
        throw e;
      }
    });
  }

  /**
   * Update an existing bookmark
   */
  async function updateBookmark(bookmarkId: string, updates: Partial<Bookmark>) {
    if (updates.timestamp !== undefined && (!Number.isFinite(updates.timestamp) || updates.timestamp < 0)) return false;
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    if (!JE.userConfig?.bookmark?.bookmarks?.[bookmarkId]) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return false;
    }

    return queueBookmarkMutation(owner, async () => {
      // Re-check after any earlier queued mutation: the user or the record may be gone.
      if (!isCurrentOwner() || !owner.bookmark?.bookmarks?.[bookmarkId]) {
        console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
        return false;
      }
      const bookmarks = owner.bookmark.bookmarks;
      const original = bookmarks[bookmarkId];
      if (!original) return false;
      const bookmark = { ...original, ...Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)), updatedAt: new Date().toISOString() };
      bookmarks[bookmarkId] = bookmark;

      try {
        await persistBookmarks(JE, getApi, owner, [bookmarkOperation('edit', bookmarkId, updates, original.itemId)]);
        console.log(`${logPrefix} Bookmark updated:`, bookmarkId);
        if (isCurrentOwner()) emitBookmarksUpdated('update');
        return true;
      } catch (e) {
        if (bookmarks[bookmarkId] === bookmark) {
          bookmarks[bookmarkId] = original;
        }
        console.error(`${logPrefix} Failed to update bookmark:`, e);
        return false;
      }
    });
  }

  /**
   * Delete a bookmark.
   * @param {string} bookmarkId - The bookmark record ID.
   * @returns {Promise<boolean|null>} true once the deletion is saved; false when the save
   *   failed and the record was restored; null when there was nothing to delete (already
   *   gone, e.g. a double-clicked delete, or the user changed).
   */
  function deleteBookmark(bookmarkId: string) {
    return deleteCheckedBookmark(bookmarkId);
  }

  async function deleteCheckedBookmark(bookmarkId: string, expectedItemId?: string) {
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    if (!JE.userConfig?.bookmark?.bookmarks?.[bookmarkId]) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return null;
    }

    return queueBookmarkMutation(owner, async () => {
      // Re-check after any earlier queued mutation: the user or the record may be gone.
      if (!isCurrentOwner() || !owner.bookmark?.bookmarks?.[bookmarkId]) {
        console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
        return null;
      }
      const bookmarks = owner.bookmark.bookmarks;
      const original = bookmarks[bookmarkId];
      if (!original) return false;
      if (expectedItemId !== undefined && original.itemId !== expectedItemId) return null;
      delete bookmarks[bookmarkId];

      try {
        await persistBookmarks(JE, getApi, owner, [bookmarkOperation('delete', bookmarkId, undefined, original.itemId)]);
        console.log(`${logPrefix} Bookmark deleted:`, bookmarkId);
        if (isCurrentOwner()) emitBookmarksUpdated('delete');
        return true;
      } catch (e) {
        if (!Object.prototype.hasOwnProperty.call(bookmarks, bookmarkId)) {
          bookmarks[bookmarkId] = original;
        }
        console.error(`${logPrefix} Failed to delete bookmark:`, e);
        return false;
      }
    });
  }

  /**
   * Delete every bookmark of the current user, queued behind the user's other mutations.
   * @returns {Promise<boolean>} true once saved; false if the user changed before it ran.
   *   Rejects after restoring the previous bookmarks when the save fails.
   */
  async function deleteAllBookmarks() {
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    return queueBookmarkMutation(owner, async () => {
      if (!isCurrentOwner()) return false;
      if (!owner.bookmark) owner.bookmark = { bookmarks: {} };
      const previous = owner.bookmark.bookmarks;
      const cleared = {};
      owner.bookmark.bookmarks = cleared;

      try {
        await persistBookmarks(JE, getApi, owner, [bookmarkOperation('delete-all')]);
        console.log(`${logPrefix} All bookmarks deleted`);
        return true;
      } catch (e) {
        if (owner.bookmark.bookmarks === cleared) owner.bookmark.bookmarks = previous;
        console.error(`${logPrefix} Failed to delete all bookmarks:`, e);
        throw e;
      }
    });
  }

  /**
   * Sync bookmarks from old item ID to new item ID.
   * Creates duplicates with the new item ID and keeps the old ones, unless
   * `replaceOriginals` is set: then the old records are removed in the same save,
   * and a failed save restores them along with removing the new copies.
   * @param {Array<{id?: string}>} oldBookmarks - Bookmarks to copy, with their record IDs.
   * @param {object} newItemDetails - Item fields for the copies.
   * @param {number} [timeOffset=0] - Seconds added to each copied timestamp.
   * @param {{replaceOriginals?: boolean}} [options]
   * @returns {Promise<Array<object>>} The new bookmarks; rejects if the save fails.
   */
  async function syncBookmarks(oldBookmarks: IdentifiedBookmark[], newItemDetails: Details, timeOffset = 0, { replaceOriginals = false }: {replaceOriginals?: boolean} = {}) {
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    if (!Number.isFinite(timeOffset)) throw new Error('Invalid bookmark offset');
    const selection = oldBookmarks.map(bookmark => ({...bookmark}));
    return queueBookmarkMutation(owner, async () => {
      if (!isCurrentOwner()) throw new Error('Bookmark owner changed before sync');
      if (!owner.bookmark) owner.bookmark = {bookmarks: {}};
      const bookmarks = owner.bookmark.bookmarks;
      // Resolve the selection only after earlier saves finish. UI snapshots can
      // predate successful edits; missing or retargeted records cannot be moved.
      const sources = selection.map(selected => {
        if (!selected.id) throw new Error('Stored bookmark identity required for copying');
        const current = selected.id ? bookmarks[selected.id] : undefined;
        if (!current || current.itemId !== selected.itemId) throw new Error('Bookmark selection changed before sync');
        return {...current, id: selected.id, exactMatch: selected.exactMatch};
      });
      if (sources.some(bookmark => !Number.isFinite(bookmark.timestamp) || !Number.isFinite(bookmark.timestamp + timeOffset))) throw new Error('Invalid bookmark offset');
      const synced = [];
      const removed: [string, Bookmark][] = [];
      const now = new Date().toISOString();

      if (replaceOriginals) {
        for (const { id } of sources) {
          if (id && Object.prototype.hasOwnProperty.call(bookmarks, id)) {
            const original = bookmarks[id];
            if (original) removed.push([id, original]);
            delete bookmarks[id];
          }
        }
      }

      for (const oldBookmark of sources) {
        const newBookmarkId = generateBookmarkId();
        const newTimestamp = Math.max(0, oldBookmark.timestamp + timeOffset);

        const { id: _oldId, exactMatch: _match, ...preserved } = oldBookmark;
        const newBookmark = {
          ...preserved,
          itemId: newItemDetails.itemId,
          tmdbId: newItemDetails.tmdbId ?? null,
          tvdbId: newItemDetails.tvdbId ?? null,
          mediaType: newItemDetails.mediaType ?? '',
          name: newItemDetails.name ?? '',
          timestamp: newTimestamp,
          label: oldBookmark.label || '',
          createdAt: oldBookmark.createdAt || now,
          updatedAt: now,
          syncedFrom: oldBookmark.itemId, // Track where it came from
          seasonNumber: newItemDetails.seasonNumber ?? null,
          episodeNumber: newItemDetails.episodeNumber ?? null
        };

        bookmarks[newBookmarkId] = newBookmark;
        synced.push({ ...newBookmark, id: newBookmarkId });
      }

      try {
        await persistBookmarks(JE, getApi, owner, synced.map((copy, index) => {
          const source = sources[index];
          if (!source?.id) throw new Error('Stored bookmark identity required for copying');
          return {...bookmarkOperation(replaceOriginals ? 'replace' : 'copy', copy.id, {
            itemId: copy.itemId, tmdbId: copy.tmdbId, tvdbId: copy.tvdbId, mediaType: copy.mediaType,
            name: copy.name, seasonNumber: copy.seasonNumber, episodeNumber: copy.episodeNumber
          }, source.itemId), SourceId: source.id, Offset: timeOffset};
        }));
        console.log(`${logPrefix} Synced ${synced.length} bookmarks to new item ID`);
        if (isCurrentOwner()) emitBookmarksUpdated('sync');
        return synced;
      } catch (e) {
        console.error(`${logPrefix} Failed to sync bookmarks:`, e);
        // Rollback
        synced.forEach(bm => delete bookmarks[bm.id]);
        removed.forEach(([id, original]) => { bookmarks[id] = original; });
        throw e;
      }
    });
  }

  async function adjustOffsets(selected: IdentifiedBookmark[], offset: number): Promise<number> {
    if (!Number.isFinite(offset)) throw new Error('Invalid offset');
    const owner = JE.userConfig, current = lease(JE);
    return queueBookmarkMutation(owner, async () => {
      if (!current()) throw new Error('Bookmark owner changed before offset adjustment');
      const records = owner.bookmark?.bookmarks;
      if (!records) return 0;
      if (selected.some(bookmark => {
        const original = records[bookmark.id];
        return original && Number.isFinite(original.timestamp) && !Number.isFinite(original.timestamp + offset);
      })) throw new Error('Invalid bookmark offset');
      const changes: [string, Bookmark, Bookmark][] = [];
      for (const selectedBookmark of selected) {
        const original = records[selectedBookmark.id];
        if (!original || original.itemId !== selectedBookmark.itemId || !Number.isFinite(original.timestamp)) continue;
        const changed = {...original, timestamp: Math.max(0, original.timestamp + offset), syncedFrom: '', updatedAt: new Date().toISOString()};
        records[selectedBookmark.id] = changed;
        changes.push([selectedBookmark.id, original, changed]);
      }
      if (!changes.length) return 0;
      try {
        await persistBookmarks(JE, getApi, owner, changes.map(([id, original]) => ({...bookmarkOperation('offset', id, undefined, original.itemId), Offset: offset})));
        if (current()) emitBookmarksUpdated('offset');
        return changes.length;
      } catch (error) {
        for (const [id, original, changed] of changes) if (records[id] === changed) records[id] = original;
        throw error;
      }
    });
  }

  /**
   * One-time backfill for TV bookmarks saved before per-episode tracking existed:
   * populates seasonNumber/episodeNumber and corrects tvdbId to the episode's own
   * per-episode ID (previously stored as the series-level value).
   */
  async function backfillEpisodeMetadata() {
    const owner = JE.userConfig;
    const isCurrentOwner = lease(JE);
    const allBookmarks = owner?.bookmark?.bookmarks || {};
    const candidates = Object.entries(allBookmarks).filter(
      ([, bm]) => bm?.mediaType === 'tv' && bm.itemId && bm.episodeNumber == null
    );
    if (candidates.length === 0) return;

    // Look the episodes up first; only the apply and save run in the mutation queue.
    const found: [string, string, Details][] = [];
    for (const [id, bm] of candidates) {
      if (!isCurrentOwner()) return;
      try {
        const details = await fetchItemDetails(bm.itemId);
        if (!isCurrentOwner()) return;
        if (details?.episodeNumber != null) found.push([id, bm.itemId, details]);
      } catch (e) {
        // Item may no longer exist; leave it for cleanupOrphanedBookmarks() to handle
      }
    }
    if (found.length === 0) return;

    await queueBookmarkMutation(owner, async () => {
      if (!isCurrentOwner()) return;
      const bookmarks = owner.bookmark?.bookmarks;
      if (!bookmarks) return;
      const applied: [string, Bookmark, Bookmark][] = [];
      for (const [id, itemId, details] of found) {
        // An earlier queued mutation may have deleted, replaced or already filled the record.
        const original = bookmarks[id];
        if (!original || original.itemId !== itemId || original.episodeNumber != null) continue;
        const filled = {
          ...original,
          seasonNumber: details.seasonNumber,
          episodeNumber: details.episodeNumber,
          ...(details.tvdbId ? { tvdbId: details.tvdbId } : {})
        };
        bookmarks[id] = filled;
        applied.push([id, original, filled]);
      }
      if (applied.length === 0) return;

      try {
        await persistBookmarks(JE, getApi, owner, applied.map(([id, original, filled]) => bookmarkOperation('backfill', id, {
          seasonNumber: filled.seasonNumber, episodeNumber: filled.episodeNumber,
          ...(filled.tvdbId ? {tvdbId: filled.tvdbId} : {})
        }, original.itemId)));
        console.log(`${logPrefix} Backfilled episode metadata for ${applied.length} bookmark(s)`);
      } catch (e) {
        applied.forEach(([id, original, filled]) => {
          if (bookmarks[id] === filled) bookmarks[id] = original;
        });
        console.warn(`${logPrefix} Failed to save backfilled episode metadata:`, e);
      }
    });
  }

  /**
   * Delete bookmarks for items that no longer exist in Jellyfin
   */
  async function cleanupOrphanedBookmarks() {
    const isCurrentOwner = lease(JE);
    const allBookmarks = JE.userConfig?.bookmark?.bookmarks || {};
    const itemIds = new Set<string>();
    const toDelete: {bookmarkId: string; itemId: string}[] = [];

    // Collect all unique item IDs
    for (const bookmark of Object.values(allBookmarks)) {
      if (bookmark?.itemId) itemIds.add(bookmark.itemId);
    }

    // Check which items still exist
    const userId = getApi().getCurrentUserId?.();
    if (!userId) return { cleaned: 0, errors: 0 };

    let cleaned = 0;
    let errors = 0;

    for (const itemId of itemIds) {
      try {
        await (JE.helpers?.getItemCached
          ? JE.helpers.getItemCached(itemId, { userId })
          : getApi().getItem(userId, itemId));
        if (!isCurrentOwner()) return {cleaned: 0, errors: 0};
        // Item exists, keep bookmarks
      } catch (e) {
        if (!isCurrentOwner()) return {cleaned: 0, errors: 0};
        if (!isMissingItem(e)) { errors++; continue; }
        // Item doesn't exist, mark bookmarks for deletion
        for (const [bookmarkId, bookmark] of Object.entries(allBookmarks)) {
          if (bookmark?.itemId === itemId) {
            toDelete.push({bookmarkId, itemId});
          }
        }
      }
    }

    // Delete orphaned bookmarks
    for (const {bookmarkId, itemId} of toDelete) {
      if (!isCurrentOwner()) return {cleaned, errors};
      try {
        // deleteBookmark reports a failed save (rolled back) as false and an
        // already-gone record as null, which is neither a removal nor an error.
        const deleted = await deleteCheckedBookmark(bookmarkId, itemId);
        if (deleted) cleaned++;
        else if (deleted === false) errors++;
      } catch (e) {
        errors++;
      }
    }

    console.log(`${logPrefix} Cleanup: ${cleaned} orphaned bookmarks removed, ${errors} errors`);
    return { cleaned, errors };
  }

  /**
   * Format timestamp as HH:MM:SS or MM:SS
   */



 return {addBookmark, updateBookmark, deleteBookmark, deleteAllBookmarks, syncBookmarks, backfillEpisodeMetadata, cleanupOrphanedBookmarks, findBookmarksForItem, fetchItemDetails, formatTimestamp, adjustOffsets};
}
