// /js/enhanced/bookmarks.js
// Enhanced bookmarks system with multi-bookmark support, TMDB/TVDB tracking, and visual markers
(function(JE) {
  'use strict';

  if (!JE.pluginConfig?.BookmarksEnabled) {
    console.log('🪼 Jellyfin Enhanced: Bookmarks feature is disabled');
    return;
  }

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks:';

  // Notify other views (e.g., CustomTabs library) when bookmarks change
  function emitBookmarksUpdated(reason = 'updated') {
    try {
      document.dispatchEvent(new CustomEvent('je-bookmarks-updated', { detail: { reason } }));
    } catch (e) {
      console.warn(`${logPrefix} Failed to emit update event`, e);
    }
  }

  const bookmarks = {
    markers: [] // Visual markers for current video
  };

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
  function getCurrentItemData() {
    try {
      // Get item ID from favorite/rating button
      const btnUserRating = document.querySelector('.videoOsdBottom .btnUserRating[data-id]');
      const itemId = btnUserRating?.dataset?.id || null;

      if (!itemId) {
        console.debug(`${logPrefix} No item ID found`);
        return null;
      }

      return { itemId };
    } catch (e) {
      console.warn(`${logPrefix} Error getting item data:`, e);
      return null;
    }
  }

  const itemDetailsCache = { itemId: null, data: null, pending: null };

  /**
   * Fetch full item details including TMDB/TVDB IDs (cached per item for a few seconds)
   */
  async function fetchItemDetails(itemId) {
    if (itemDetailsCache.itemId === itemId && itemDetailsCache.data) {
      return itemDetailsCache.data;
    }

    if (itemDetailsCache.pending && itemDetailsCache.itemId === itemId) {
      return itemDetailsCache.pending;
    }

    const fetchPromise = (async () => {
      try {
        const userId = ApiClient.getCurrentUserId?.();
        if (!userId) return null;

        const result = await ApiClient.ajax({
          type: 'GET',
          url: ApiClient.getUrl(`/Users/${userId}/Items`, {
            Ids: itemId,
            Fields: 'ProviderIds,Type,Name,SeriesId,ParentIndexNumber,IndexNumber'
          }),
          dataType: 'json'
        });

        const item = result?.Items?.[0];
        if (!item) return null;

        // For episodes/seasons, also get series TMDB/TVDB
        let sourceItem = item;
        if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId) {
          try {
            const seriesResult = await ApiClient.ajax({
              type: 'GET',
              url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                Ids: item.SeriesId,
                Fields: 'ProviderIds,Type,Name'
              }),
              dataType: 'json'
            });
            const seriesItem = seriesResult?.Items?.[0];
            if (seriesItem) {
              // Merge: use series TMDB/TVDB but keep episode info
              sourceItem = {
                ...item,
                ProviderIds: {
                  ...(item.ProviderIds || {}),
                  Tmdb: seriesItem.ProviderIds?.Tmdb || item.ProviderIds?.Tmdb,
                  Tvdb: seriesItem.ProviderIds?.Tvdb || item.ProviderIds?.Tvdb
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

        const details = {
          itemId: item.Id,
          tmdbId,
          tvdbId,
          mediaType,
          name: item.Name || 'Unknown',
          type: item.Type
        };

        itemDetailsCache.data = details;
        return details;
      } catch (e) {
        console.warn(`${logPrefix} Error fetching item details:`, e);
        return null;
      } finally {
        itemDetailsCache.pending = null;
      }
    })();

    itemDetailsCache.itemId = itemId;
    itemDetailsCache.pending = fetchPromise;
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
  function findBookmarksForItem(itemId, tmdbId, tvdbId) {
    const allBookmarks = JE.userConfig?.bookmark?.bookmarks || {};
    const exactMatches = [];
    const providerMatches = [];

    for (const [bookmarkId, bookmark] of Object.entries(allBookmarks)) {
      // Skip invalid bookmarks
      if (typeof bookmark !== 'object' || bookmark === null) continue;

      // Direct itemId match (preferred)
      if (bookmark.itemId === itemId) {
        exactMatches.push({ id: bookmarkId, ...bookmark, exactMatch: true });
        continue;
      }

      // Fallback: TMDB/TVDB match (different item ID)
      if (tmdbId && bookmark.tmdbId === tmdbId) {
        providerMatches.push({ id: bookmarkId, ...bookmark, exactMatch: false });
        continue;
      }

      if (tvdbId && bookmark.tvdbId === tvdbId) {
        providerMatches.push({ id: bookmarkId, ...bookmark, exactMatch: false });
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
  async function addBookmark(timestamp, label = '') {
    const itemData = getCurrentItemData();
    if (!itemData) {
      JE.toast(JE.t('toast_bookmark_no_item'), 3000);
      return null;
    }

    // Fetch full details
    const details = await fetchItemDetails(itemData.itemId);
    if (!details) {
      JE.toast(JE.t('toast_bookmark_fetch_failed'), 3000);
      return null;
    }

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
      syncedFrom: ''
    };

    // Initialize bookmark structure if needed
    if (!JE.userConfig.bookmark) {
      JE.userConfig.bookmark = { bookmarks: {} };
    }
    if (!JE.userConfig.bookmark.bookmarks) {
      JE.userConfig.bookmark.bookmarks = {};
    }

    JE.userConfig.bookmark.bookmarks[bookmarkId] = bookmark;

    try {
      await JE.saveUserSettings('bookmark.json', JE.userConfig.bookmark);
      console.log(`${logPrefix} Bookmark added:`, bookmarkId, bookmark);
      emitBookmarksUpdated('add');
      return { id: bookmarkId, ...bookmark };
    } catch (e) {
      console.error(`${logPrefix} Failed to save bookmark:`, e);
      delete JE.userConfig.bookmark.bookmarks[bookmarkId];
      throw e;
    }
  }

  /**
   * Update an existing bookmark
   */
  async function updateBookmark(bookmarkId, updates) {
    if (!JE.userConfig?.bookmark?.bookmarks?.[bookmarkId]) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return false;
    }

    const bookmark = JE.userConfig.bookmark.bookmarks[bookmarkId];
    Object.assign(bookmark, updates, { updatedAt: new Date().toISOString() });

    try {
      await JE.saveUserSettings('bookmark.json', JE.userConfig.bookmark);
      console.log(`${logPrefix} Bookmark updated:`, bookmarkId);
      emitBookmarksUpdated('update');
      return true;
    } catch (e) {
      console.error(`${logPrefix} Failed to update bookmark:`, e);
      return false;
    }
  }

  /**
   * Delete a bookmark
   */
  async function deleteBookmark(bookmarkId) {
    if (!JE.userConfig?.bookmark?.bookmarks?.[bookmarkId]) {
      console.warn(`${logPrefix} Bookmark not found:`, bookmarkId);
      return false;
    }

    delete JE.userConfig.bookmark.bookmarks[bookmarkId];

    try {
      await JE.saveUserSettings('bookmark.json', JE.userConfig.bookmark);
      console.log(`${logPrefix} Bookmark deleted:`, bookmarkId);
      emitBookmarksUpdated('delete');
      return true;
    } catch (e) {
      console.error(`${logPrefix} Failed to delete bookmark:`, e);
      return false;
    }
  }

  /**
   * Sync bookmarks from old item ID to new item ID
   * Creates duplicates with new item ID, keeps old ones
   */
  async function syncBookmarks(oldBookmarks, newItemDetails, timeOffset = 0) {
    const synced = [];
    const now = new Date().toISOString();

    for (const oldBookmark of oldBookmarks) {
      const newBookmarkId = generateBookmarkId();
      const newTimestamp = Math.max(0, oldBookmark.timestamp + timeOffset);

      const newBookmark = {
        itemId: newItemDetails.itemId,
        tmdbId: newItemDetails.tmdbId,
        tvdbId: newItemDetails.tvdbId,
        mediaType: newItemDetails.mediaType,
        name: newItemDetails.name,
        timestamp: newTimestamp,
        label: oldBookmark.label || '',
        createdAt: oldBookmark.createdAt || now,
        updatedAt: now,
        syncedFrom: oldBookmark.itemId // Track where it came from
      };

      JE.userConfig.bookmark.bookmarks[newBookmarkId] = newBookmark;
      synced.push({ id: newBookmarkId, ...newBookmark });
    }

    try {
      await JE.saveUserSettings('bookmark.json', JE.userConfig.bookmark);
      console.log(`${logPrefix} Synced ${synced.length} bookmarks to new item ID`);
      emitBookmarksUpdated('sync');
      return synced;
    } catch (e) {
      console.error(`${logPrefix} Failed to sync bookmarks:`, e);
      // Rollback
      synced.forEach(bm => delete JE.userConfig.bookmark.bookmarks[bm.id]);
      throw e;
    }
  }

  /**
   * Delete bookmarks for items that no longer exist in Jellyfin
   */
  async function cleanupOrphanedBookmarks() {
    const allBookmarks = JE.userConfig?.bookmark?.bookmarks || {};
    const itemIds = new Set();
    const toDelete = [];

    // Collect all unique item IDs
    for (const bookmark of Object.values(allBookmarks)) {
      if (bookmark?.itemId) itemIds.add(bookmark.itemId);
    }

    // Check which items still exist
    const userId = ApiClient.getCurrentUserId?.();
    if (!userId) return { cleaned: 0, errors: 0 };

    let cleaned = 0;
    let errors = 0;

    for (const itemId of itemIds) {
      try {
        await ApiClient.getItem(userId, itemId);
        // Item exists, keep bookmarks
      } catch (e) {
        // Item doesn't exist, mark bookmarks for deletion
        for (const [bookmarkId, bookmark] of Object.entries(allBookmarks)) {
          if (bookmark?.itemId === itemId) {
            toDelete.push(bookmarkId);
          }
        }
      }
    }

    // Delete orphaned bookmarks
    for (const bookmarkId of toDelete) {
      try {
        await deleteBookmark(bookmarkId);
        cleaned++;
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
  function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Create visual bookmark markers in video OSD
   */
  function createBookmarkMarkers(video, bookmarksList) {
    console.log(`${logPrefix} createBookmarkMarkers called - video:`, !!video, 'bookmarks:', bookmarksList.length);

    if (!video || !bookmarksList.length) {
      console.log(`${logPrefix} Early return - no video or no bookmarks`);
      return;
    }

    // Find or create marker container
    const osdBottom = document.querySelector('.videoOsdBottom');
    if (!osdBottom) {
      console.log(`${logPrefix} No .videoOsdBottom found`);
      return;
    }

    // Find the position slider with expanded selectors
    const positionSlider = osdBottom.querySelector('.osdPositionSlider, .sliderBubble, .mdl-slider, input[type="range"]');
    if (!positionSlider) {
      console.log(`${logPrefix} No position slider found`);
      return;
    }

    const sliderContainer = positionSlider.closest('.osdPositionSliderContainer, .sliderContainer') || positionSlider.parentElement;
    if (!sliderContainer) {
      console.log(`${logPrefix} No slider container found`);
      return;
    }

    // Ensure markers position relative to the slider container
    const sliderPos = window.getComputedStyle(sliderContainer).position;
    if (sliderPos === 'static') {
      sliderContainer.style.position = 'relative';
    }

    // Remove existing markers
    const existingMarkers = sliderContainer.querySelectorAll('.je-bookmark-marker');
    console.log(`${logPrefix} Removing ${existingMarkers.length} existing markers`);
    existingMarkers.forEach(el => el.remove());

    const duration = video.duration;
    if (!duration || !isFinite(duration)) {
      console.log(`${logPrefix} Invalid duration:`, duration);
      return;
    }

    // Create markers for each bookmark
    bookmarksList.forEach(bookmark => {
      const percent = (bookmark.timestamp / duration) * 100;
      const markerColor = bookmark.exactMatch ? '#00d4ff' : '#ffa500';

      const marker = document.createElement('div');
      marker.className = 'je-bookmark-marker';
      marker.style.cssText = `
        position: absolute;
        left: ${percent}%;
        bottom: 0%;
        transform: translate(-50%, -50%);
        z-index: 1000;
        pointer-events: all;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      const icon = document.createElement('span');
      icon.className = 'material-icons';
      icon.textContent = 'location_pin';
      icon.style.cssText = `
        font-size: 24px;
        color: ${markerColor};
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
        pointer-events: none;
      `;

      marker.appendChild(icon);

      const labelText = bookmark.label || JE.t('bookmark_no_label');
      const versionNote = !bookmark.exactMatch ? ` ${JE.t('bookmark_file_changed')}` : '';
      marker.title = `${labelText} - ${formatTimestamp(bookmark.timestamp)}${versionNote}`;

      // Click to jump to bookmark
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        video.currentTime = bookmark.timestamp;
        JE.toast(`${JE.t('toast_jumped_to_bookmark')}: ${formatTimestamp(bookmark.timestamp)}`, 2000);
      });

      sliderContainer.appendChild(marker);
    });

    console.log(`${logPrefix} ✓ Created ${bookmarksList.length} bookmark markers`);
  }


  /**
   * Update bookmark markers for current video
   */
  async function updateBookmarkMarkersForCurrentVideo() {
    console.log(`${logPrefix} updateBookmarkMarkersForCurrentVideo called`);

    const video = document.querySelector('.videoPlayerContainer video');
    if (!video) {
      console.log(`${logPrefix} No video element found`);
      return;
    }

    const itemData = getCurrentItemData();
    if (!itemData) {
      console.log(`${logPrefix} No item data (no btnUserRating?)`);
      return;
    }

    console.log(`${logPrefix} Fetching details for item:`, itemData.itemId);
    const details = await fetchItemDetails(itemData.itemId);
    if (!details) {
      console.log(`${logPrefix} Failed to fetch item details`);
      return;
    }

    console.log(`${logPrefix} Item details:`, details);
    const { bookmarks: bookmarksList } = findBookmarksForItem(
      details.itemId,
      details.tmdbId,
      details.tvdbId
    );

    console.log(`${logPrefix} Found ${bookmarksList.length} bookmarks for this item`);
    createBookmarkMarkers(video, bookmarksList);
  }

  /**
   * Show bookmark management modal
   */
  async function showBookmarkModal(mode = 'add', existingBookmark = null) {
    const video = document.querySelector('.videoPlayerContainer video');
    const currentTime = video?.currentTime || 0;

    const itemData = getCurrentItemData();
    if (!itemData) {
      JE.toast(JE.t('toast_bookmark_no_item'), 3000);
      return;
    }

    const details = await fetchItemDetails(itemData.itemId);
    if (!details) {
      JE.toast(JE.t('toast_bookmark_fetch_failed'), 3000);
      return;
    }

    const { bookmarks: existingBookmarks } = findBookmarksForItem(
      details.itemId,
      details.tmdbId,
      details.tvdbId
    );

    console.log('🪼 Bookmarks modal: Found', existingBookmarks.length, 'existing bookmarks for item', details.itemId);
    console.log('🪼 Bookmarks modal: Mode =', mode, 'Existing bookmarks:', existingBookmarks);

    const isEdit = mode === 'edit' && existingBookmark;
    const title = isEdit ? 'Edit Bookmark' : (mode === 'view' ? 'Your Bookmarks' : 'Add Bookmark');
    const timestamp = isEdit ? existingBookmark.timestamp : currentTime;
    const label = isEdit ? existingBookmark.label : '';

    const formHtml = `
      <style>
        .je-bm-player-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.85);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        }
        .je-bm-player-modal-container {
          background: #181818;
          border-radius: 12px;
          max-width: 700px;
          width: 90%;
          max-height: 85vh;
          padding: 24px;
          position: relative;
          box-shadow: 0 8px 32px rgba(0,0,0,0.8);
          display: flex;
          flex-direction: column;
        }
        .je-bookmark-modal-close {
          position: absolute;
          top: 16px;
          right: 16px;
          background: transparent;
          border: none;
          color: #fff;
          font-size: 32px;
          cursor: pointer;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background 0.2s;
        }
        .je-bookmark-modal-close:hover {
          background: rgba(255,255,255,0.1);
        }
        .je-bookmark-modal-actions {
          display: flex;
          gap: 12px;
          margin-top: 24px;
          justify-content: flex-end;
        }
        .je-bookmark-btn-submit,
        .je-bookmark-btn-cancel {
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .je-bookmark-btn-submit {
          background: #00a86b;
          color: #fff;
        }
        .je-bookmark-btn-submit:hover {
          background: #00c47a;
        }
        .je-bookmark-btn-cancel {
          background: rgba(255,255,255,0.1);
          color: #fff;
        }
        .je-bookmark-btn-cancel:hover {
          background: rgba(255,255,255,0.15);
        }
        .je-bookmark-modal { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; }
        .je-bookmark-hero { padding: 0 0 20px 0; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 20px; }
        .je-bookmark-hero-title { font-size: 20px; font-weight: 600; color: #fff; margin: 0 0 6px 0; }
        .je-bookmark-hero-icon { display: none; }
        .je-bookmark-hero-subtitle { font-size: 14px; color: #888; margin: 0; }

        .je-bookmark-form-grid { display: grid; gap: 20px; }
        .je-bookmark-input-group { position: relative; }
        .je-bookmark-input-group label {
          display: block;
          margin-bottom: 8px;
          font-weight: 600;
          color: #e0e0e0;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .je-bookmark-input, .je-bookmark-textarea {
          width: 100%;
          padding: 12px 16px;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          color: #fff;
          font-family: inherit;
          font-size: 15px;
          transition: all 0.2s;
          box-sizing: border-box;
        }
        .je-bookmark-input:focus, .je-bookmark-textarea:focus {
          outline: none;
          border-color: rgba(255,255,255,0.3);
          background: rgba(255,255,255,0.08);
        }
        .je-bookmark-input[readonly] {
          background: rgba(0,0,0,0.2);
          cursor: not-allowed;
          border-color: rgba(255,255,255,0.1);
        }
        .je-bookmark-textarea {
          resize: vertical;
          min-height: 80px;
          font-family: inherit;
        }

        .je-bookmark-list {
          margin-top: 28px;
          max-height: 300px;
          overflow-y: auto;
          padding-right: 8px;
        }
        .je-bookmark-list::-webkit-scrollbar {
          width: 8px;
        }
        .je-bookmark-list::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.05);
          border-radius: 4px;
        }
        .je-bookmark-list::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.2);
          border-radius: 4px;
        }
        .je-bookmark-list::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.3);
        }
        .je-bookmark-list-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .je-bookmark-list-title {
          font-size: 13px;
          font-weight: 600;
          color: #aaa;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .je-bookmark-list-count {
          background: rgba(255,255,255,0.1);
          color: #fff;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }

        .je-bookmark-item {
            display: flex;
            gap: 12px;
            padding: 14px 16px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            margin-bottom: 10px;
            transition: all 0.2s;
            flex-wrap: wrap;
            flex-direction: row;
            align-items: center;
        }

        .je-bookmark-item:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(255,255,255,0.2);
        }
        .je-bookmark-item-marker {
          width: 3px;
          background: rgba(255,255,255,0.3);
          border-radius: 2px;
          flex-shrink: 0;
        }
        .je-bookmark-item-content { flex: 1; min-width: 0; }
        .je-bookmark-item-time {
          font-weight: 600;
          color: #fff;
          font-size: 15px;
          margin-bottom: 4px;
        }
        .je-bookmark-item-label {
          font-size: 14px;
          color: #ccc;
          margin-top: 4px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .je-bookmark-item-warning {
          color: #ffa500;
          font-size: 12px;
          margin-top: 6px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .je-bookmark-item-actions {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }
        .je-bookmark-btn {
          padding: 8px;
          font-size: 20px;
          border-radius: 50%;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .je-bookmark-btn:hover {
          opacity: 0.9;
          color: #fff;
        }
        .je-bookmark-btn-jump:hover {
          background: #00a86b;
        }
        .je-bookmark-btn-delete:hover {
          background: #b60505;
        }

        .je-bookmark-empty {
          text-align: center;
          padding: 40px 20px;
          color: #888;
          font-size: 14px;
        }
        .je-bookmark-empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
          opacity: 0.5;
        }
      </style>
      <div class="je-bookmark-modal">
        <div class="je-bookmark-hero">
          <div class="je-bookmark-hero-title">
            <span>${title}</span>
          </div>
          <div class="je-bookmark-hero-subtitle">${details.name}</div>
        </div>
        <div class="je-bookmark-form-grid">
          <div class="je-bookmark-input-group">
            <label for="bookmark-time">${JE.t('bookmark_time_label')}</label>
            <input
              type="text"
              id="bookmark-time"
              class="je-bookmark-input"
              value="${formatTimestamp(timestamp)}"
              readonly>
          </div>
          <div class="je-bookmark-input-group">
            <label for="bookmark-label">${JE.t('bookmark_label_label')}</label>
            <input
              type="text"
              id="bookmark-label"
              class="je-bookmark-input"
              placeholder="${JE.t('bookmark_label_placeholder')}"
              value="${label}"
              maxlength="100">
          </div>
        </div>
        ${existingBookmarks.length > 0 ? `
          <div class="je-bookmark-list">
            <div class="je-bookmark-list-header">
              <div class="je-bookmark-list-title">${JE.t('bookmark_existing_title')}</div>
              <div class="je-bookmark-list-count">${existingBookmarks.length}</div>
            </div>
            ${existingBookmarks.map(bm => `
              <div class="je-bookmark-item">
                <div class="je-bookmark-item-marker"></div>
                <div class="je-bookmark-item-content">
                  <div class="je-bookmark-item-time">${formatTimestamp(bm.timestamp)}</div>
                  ${bm.label ? `<div class="je-bookmark-item-label">${escapeHtml(bm.label)}</div>` : ''}
                  ${!bm.exactMatch ? `<div class="je-bookmark-item-warning">${JE.t('bookmark_file_changed')}</div>` : ''}
                </div>
                <div class="je-bookmark-item-actions">
                  <button class="je-bookmark-btn je-bookmark-btn-jump" data-bookmark-id="${bm.id}" title="${JE.t('bookmark_jump')}">
                    <span class="material-icons">forward</span>
                  </button>
                  <button class="je-bookmark-btn je-bookmark-btn-delete" data-bookmark-id="${bm.id}" title="${JE.t('bookmark_delete_confirm')}">
                    <span class="material-icons">delete</span>
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="je-bookmark-empty">
            <div>${JE.t('bookmark_none')}</div>
          </div>
        `}
      </div>
    `;

    // Create custom modal (not using Jellyfin's dialog classes to avoid style conflicts)
    const modal = document.createElement('div');
    modal.className = 'je-bm-player-modal-overlay';
    modal.innerHTML = `
      <div class="je-bm-player-modal-container">
        <button class="je-bookmark-modal-close">×</button>
        ${formHtml}
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-submit">${isEdit ? JE.t('bookmark_save') : JE.t('bookmark_add')}</button>
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Prevent keyboard shortcuts and wheel events from affecting video player
    modal.addEventListener('keydown', (e) => e.stopPropagation());
    modal.addEventListener('keyup', (e) => e.stopPropagation());
    modal.addEventListener('keypress', (e) => e.stopPropagation());
    modal.addEventListener('wheel', (e) => e.stopPropagation());

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => {
        modal.remove();
        // Remove navigation listener
        document.removeEventListener('viewshow', closeDialog);
      }, 200);
    };

    // Close modal when navigating away
    document.addEventListener('viewshow', closeDialog);

    // Close button
    modal.querySelector('.je-bookmark-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Focus label input after modal opens
    setTimeout(() => {
      const labelInput = modal.querySelector('#bookmark-label');
      if (labelInput) labelInput.focus();
      modal.style.opacity = '1';
    }, 10);

    // Submit
    modal.querySelector('.je-bookmark-btn-submit').addEventListener('click', async () => {
      const labelInput = modal.querySelector('#bookmark-label').value.trim();

      try {
        if (isEdit) {
          await updateBookmark(existingBookmark.id, { label: labelInput });
           JE.toast(JE.t('toast_bookmark_updated'), 2000);
        } else {
          await addBookmark(timestamp, labelInput);
           JE.toast(JE.t('toast_bookmark_updated'), 2000);
        }

        // Refresh markers
        updateBookmarkMarkersForCurrentVideo();
        closeDialog();
      } catch (e) {
        JE.toast(JE.t('toast_bookmark_save_failed'), 3000);
      }
    });

    // Jump to bookmark buttons
    modal.querySelectorAll('.je-bookmark-btn-jump').forEach(btn => {
      btn.addEventListener('click', () => {
        const bookmarkId = btn.dataset.bookmarkId;
        const bookmark = existingBookmarks.find(bm => bm.id === bookmarkId);
        if (bookmark && video) {
          video.currentTime = bookmark.timestamp;
          JE.toast(`${JE.t('toast_jumped_to_bookmark')}: ${formatTimestamp(bookmark.timestamp)}`, 2000);
          closeDialog();
        }
      });
    });

    // Delete bookmark buttons
    modal.querySelectorAll('.je-bookmark-btn-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const bookmarkId = btn.dataset.bookmarkId;
        await deleteBookmark(bookmarkId);
        JE.toast(JE.t('toast_bookmark_deleted'), 2000);
        updateBookmarkMarkersForCurrentVideo();
        closeDialog();
        // Reopen modal to show updated list
        setTimeout(() => showBookmarkModal(mode, existingBookmark), 300);
      });
    });
  }

  // Public API
  JE.bookmarks = {
    add: addBookmark,
    update: updateBookmark,
    delete: deleteBookmark,
    findForItem: findBookmarksForItem,
    showModal: showBookmarkModal,
    updateMarkers: updateBookmarkMarkersForCurrentVideo,
    formatTimestamp,
    syncBookmarks,
    cleanupOrphaned: cleanupOrphanedBookmarks
  };

  /**
   * Add bookmark button to the video player OSD
   */
  function addOsdBookmarkButton() {
    // Don't add if already exists
    if (document.getElementById('jeBookmarkBtn')) return;

    const controlsContainer = document.querySelector('.videoOsdBottom .buttons.focuscontainer-x');
    if (!controlsContainer) return;

    // Find the native settings button to insert before
    const nativeSettingsButton = controlsContainer.querySelector('.btnVideoOsdSettings');
    if (!nativeSettingsButton) return;

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.id = 'jeBookmarkBtn';
    bookmarkBtn.setAttribute('is', 'paper-icon-button-light');
    bookmarkBtn.className = 'autoSize paper-icon-button-light';
    bookmarkBtn.title = JE.t('shortcut_BookmarkCurrentTime');
    bookmarkBtn.innerHTML = '<span class="largePaperIconButton material-icons" aria-hidden="true">bookmark_add</span>';

    bookmarkBtn.onclick = (e) => {
      e.stopPropagation();
      showBookmarkModal('add');
    };

    // Insert before the settings button
    nativeSettingsButton.parentElement.insertBefore(bookmarkBtn, nativeSettingsButton);
    console.log(`${logPrefix} ✓ Added OSD bookmark button`);
  }

  /**
   * Initialize bookmarks system
   */
  JE.initializeBookmarks = (function() {
    let initialized = false;
    let cleanupFunctions = [];

    return function() {
      // Prevent multiple initializations
      if (initialized) {
        console.log(`${logPrefix} Already initialized, skipping...`);
        return;
      }
      initialized = true;

      console.log(`${logPrefix} Initializing enhanced bookmarks...`);

      let updateTimeout = null;
      let osdInjectionTimeout = null;
      let lastVideoUrl = null;
      let lastInjectedOsdKey = null;
      const osdObserverId = 'je-bookmarks-osd';
      const videoObserverId = 'je-bookmarks-video-changes';

      function getOsdKey() {
        const video = document.querySelector('.videoPlayerContainer video');
        return video?.currentSrc || video?.src || window.location.href;
      }

      function debouncedUpdate() {
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
          const currentUrl = window.location.href;
          if (JE.isVideoPage() && currentUrl !== lastVideoUrl) {
            lastVideoUrl = currentUrl;
            updateBookmarkMarkersForCurrentVideo();
          }
        }, 500);
      }

      // Debounced OSD injection - prevents rapid re-injection
      const debouncedOsdInjection = JE.helpers.debounce(() => {
        if (!JE.isVideoPage()) return;

        const osdBottom = document.querySelector('.videoOsdBottom');
        const video = document.querySelector('.videoPlayerContainer video');
        const currentOsdKey = getOsdKey();

        // Only inject if OSD exists and we haven't already injected for this video
        if (osdBottom && video && currentOsdKey !== lastInjectedOsdKey) {
          updateBookmarkMarkersForCurrentVideo();
          addOsdBookmarkButton();
          lastInjectedOsdKey = currentOsdKey;
          console.log(`${logPrefix} Injected markers/button for ${currentOsdKey}`);
        }
      }, 200);

      // Managed observer: only watches when on video page
      function ensureOsdObserver() {
        if (!JE.isVideoPage()) {
          JE.helpers.disconnectObserver(osdObserverId);
          return;
        }

        // Create observer that watches for OSD appearance
        JE.helpers.createObserver(
          osdObserverId,
          debouncedOsdInjection,
          document.body,
          { childList: true, subtree: true }
        );
      }

      // Debounced handlers for video events
      const handlePlayingEvent = JE.helpers.debounce((e) => {
        if (e.target.tagName === 'VIDEO' && JE.isVideoPage()) {
          debouncedOsdInjection();
        }
      }, 300);

      const handleMetadataEvent = JE.helpers.debounce((e) => {
        if (e.target.tagName === 'VIDEO' && JE.isVideoPage()) {
          debouncedOsdInjection();
        }
      }, 300);

      const handleViewShow = () => {
        if (JE.isVideoPage()) {
          lastInjectedOsdKey = null; // Reset for new page
          ensureOsdObserver();
          debouncedOsdInjection();
        } else {
          // Clean up when leaving video page
          lastVideoUrl = null;
          lastInjectedOsdKey = null;
          JE.helpers.disconnectObserver(osdObserverId);
          JE.helpers.disconnectObserver(videoObserverId);
        }
      };

      // Register event listeners with cleanup tracking
      document.addEventListener('playing', handlePlayingEvent, true);
      cleanupFunctions.push(() => document.removeEventListener('playing', handlePlayingEvent, true));

      document.addEventListener('loadedmetadata', handleMetadataEvent, true);
      cleanupFunctions.push(() => document.removeEventListener('loadedmetadata', handleMetadataEvent, true));

      document.addEventListener('viewshow', handleViewShow);
      cleanupFunctions.push(() => document.removeEventListener('viewshow', handleViewShow));

      // Initial setup if already on video page
      if (JE.isVideoPage()) {
        ensureOsdObserver();
        debouncedOsdInjection();
      }

      // Store cleanup function globally
      JE.cleanupBookmarks = function() {
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];
        JE.helpers.disconnectObserver(osdObserverId);
        JE.helpers.disconnectObserver(videoObserverId);
        initialized = false;
        console.log(`${logPrefix} Cleaned up`);
      };

      console.log(`${logPrefix} ✓ Initialized`);
    };
  })();

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
