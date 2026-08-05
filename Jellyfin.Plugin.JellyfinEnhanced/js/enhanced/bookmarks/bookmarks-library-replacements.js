/**
 * Bookmarks Library View — orphaned-bookmark replacement search + migration modals.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  const renderBookmarksLibrary = (...args) => internal.renderBookmarksLibrary(...args);

  const escapeHtml = JE.escapeHtml;

  /**
   * Search Jellyfin for items matching a TMDB/TVDB ID
   */
  async function searchForReplacementItem(tmdbId, tvdbId, mediaType) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) return null;

    const userId = apiClient.getCurrentUserId();

    try {
      // Search using Jellyfin's provider ID filtering. Movies/TV can be scoped
      // to their known item types; other media (music videos, etc.) search
      // across all types since the original Jellyfin type isn't preserved.
      const itemTypes = mediaType === 'tv' ? 'Series,Episode' : mediaType === 'movie' ? 'Movie' : null;

      // Fetch all items of this type and filter by provider ID client-side
      // This is more reliable than relying on AnyProviderIdEquals
      const url = `Users/${userId}/Items?Recursive=true${itemTypes ? `&IncludeItemTypes=${itemTypes}` : ''}&SortBy=DateCreated&SortOrder=Descending&Limit=500`;

      // Routed through the core fetch layer (auth + JSON parse identical to the
      // former ApiClient.ajax call; failures still land in the catch below).
      let response = await JE.core.api.fetch(apiClient.getUrl(url));

      // Handle if response is a string (shouldn't happen but be safe)
      if (typeof response === 'string') {
        response = JSON.parse(response);
      }

      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: API Response:`, response);

      const items = response?.Items || [];
      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Fetched ${items.length} total items of type ${itemTypes || 'any'}`);

      if (!Array.isArray(items) || items.length === 0) {
        console.warn(`🪼 Jellyfin Enhanced: Bookmarks Library: No items found or items is not an array`);
        return null;
      }

      // Filter items by matching provider IDs
      // Check both ProviderIds and UserData.Key (TMDB ID is often stored there)
      const matches = items.filter(item => {
        const providerIds = item.ProviderIds || {};
        const userData = item.UserData || {};

        if (tmdbId) {
          // Check ProviderIds.Tmdb
          if (providerIds.Tmdb === String(tmdbId)) return true;
          // Check UserData.Key for TMDB ID
          if (userData.Key === String(tmdbId)) return true;
        }

        if (tvdbId) {
          // Check ProviderIds.Tvdb
          if (providerIds.Tvdb === String(tvdbId)) return true;
        }

        return false;
      });

      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Found ${matches.length} matches for ${tmdbId ? 'TMDB:'+tmdbId : 'TVDB:'+tvdbId}`, matches);
      return matches.length > 0 ? matches : null;
    } catch (e) {
      console.error('Failed to search for replacement:', e);
      return null;
    }
  }

  /**
   * Find replacement for orphaned item and offer migration
   */
  async function findAndOfferReplacement(group, triggerBtn) {
    triggerBtn.disabled = true;

    const matches = await searchForReplacementItem(
      group.details.tmdbId,
      group.details.tvdbId,
      group.details.mediaType
    );

    if (!matches || matches.length === 0) {
      JE.toast(JE.t('bookmark_no_replacement'), 3000);
      triggerBtn.disabled = false;
      return;
    }

    showReplacementSelectionModal(group, matches);
    triggerBtn.disabled = false;
  }

  /**
   * Show modal to select replacement item and migrate bookmarks
   */
  function showReplacementSelectionModal(oldGroup, replacementItems) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) return;

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container je-replacement-modal-container">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content" style="padding: 28px;">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #4caf50; flex-shrink: 0;">find_replace</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">Replacement Found</h2>
              <p class="je-modal-subtitle">Migrate ${oldGroup.bookmarks.length} bookmark(s) from the old item to a new version</p>
            </div>
          </div>

          <div class="je-modal-warning-box">
            <div class="je-modal-warning-label">Old Item (Missing)</div>
            <div class="je-modal-item-name">${escapeHtml(oldGroup.details.name)}</div>
            <div class="je-modal-item-meta">TMDB: ${oldGroup.details.tmdbId || 'N/A'} • Item ID: ${oldGroup.details.itemId.substring(0,16)}...</div>
          </div>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options">
            ${replacementItems.map((item, idx) => {
              const posterUrl = apiClient.getImageUrl(item.Id, {
                type: 'Primary',
                maxWidth: 120,
                tag: item.ImageTags?.Primary
              });
              return `
                <div class="replacement-option" data-item-index="${idx}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                  ${posterUrl ? `<img src="${posterUrl}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">` : '<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                  <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${escapeHtml(item.Name)}</div>
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${item.ProductionYear || ''}</div>
                    <div style="font-size: 11px; color: #888;">Item ID: ${item.Id.substring(0,16)}...</div>
                  </div>
                  <span class="material-icons" aria-hidden="true" style="color: #4caf50; font-size: 28px; display: none; flex-shrink: 0;">check_circle</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="je-modal-actions-padded">
          <button class="je-modal-btn-cancel-alt je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="je-modal-btn-submit je-bookmark-btn-submit" disabled>
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">swap_horiz</span>
            <span>Migrate Bookmarks</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let selectedItem = null;

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Selection handlers
    modal.querySelectorAll('.replacement-option').forEach(option => {
      option.addEventListener('click', () => {
        const idx = parseInt(option.dataset.itemIndex);
        selectedItem = replacementItems[idx];

        modal.querySelectorAll('.replacement-option').forEach(opt => {
          opt.style.borderColor = 'rgba(76,175,80,0.2)';
          opt.style.background = 'rgba(76,175,80,0.05)';
          opt.querySelector('.material-icons').style.display = 'none';
        });

        option.style.borderColor = '#4caf50';
        option.style.background = 'rgba(76,175,80,0.15)';
        option.querySelector('.material-icons').style.display = 'block';

        const submitBtn = modal.querySelector('.je-bookmark-btn-submit');
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
      });
    });

    // Migrate handler
    modal.querySelector('.je-bookmark-btn-submit').addEventListener('click', async () => {
      if (!selectedItem) return;

      const btn = modal.querySelector('.je-bookmark-btn-submit');
      btn.disabled = true;
      btn.querySelector('span:last-child').textContent = 'Migrating...';

      try {
        // Fetch full details for new item
        const userId = apiClient.getCurrentUserId();
        const fullItem = JE.helpers?.getItemCached
          ? await JE.helpers.getItemCached(selectedItem.Id, { userId })
          : await apiClient.getItem(userId, selectedItem.Id);

        const newDetails = {
          itemId: fullItem.Id,
          tmdbId: fullItem.ProviderIds?.Tmdb || oldGroup.details.tmdbId,
          tvdbId: fullItem.ProviderIds?.Tvdb || oldGroup.details.tvdbId,
          mediaType: oldGroup.details.mediaType,
          name: fullItem.Name
        };

        // Delete old bookmarks BEFORE syncing to prevent race condition with re-render
        for (const bm of oldGroup.bookmarks) {
          delete JE.userConfig.bookmark.bookmarks[bm.id];
        }

        // Sync bookmarks to new item (no offset)
        const synced = await JE.bookmarks.syncBookmarks(oldGroup.bookmarks, newDetails, 0);

        JE.toast(JE.t('bookmark_migrated').replace('{count}', synced.length).replace('{name}', fullItem.Name), 4000);

        closeDialog();

        // Refresh the library view
        const container = document.querySelector('.sections.bookmarks');
        if (container) {
          setTimeout(() => renderBookmarksLibrary(container), 500);
        }
      } catch (e) {
        console.error('Migration failed:', e);
        JE.toast(JE.t('bookmark_migration_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child').textContent = JE.t('bookmark_migrate');
      }
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  /**
   * Show summary of all orphaned items with replacements
   */
  function showOrphanedSummaryModal(replacementResults) {
    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8);">
        <button class="je-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 32px; color: #4caf50;">search</span>
            <div>
              <h2 style="margin: 0 0 4px 0; font-size: 20px;">Orphaned Bookmarks</h2>
              <p style="margin: 0; font-size: 13px; color: #999;">Found ${replacementResults.length} item(s) with replacements available</p>
            </div>
          </div>
          <div style="margin-top: 20px; max-height: 400px; overflow-y: auto;">
            ${replacementResults.map((result, idx) => `
              <div class="je-orphaned-result-item">
                <div class="je-orphaned-result-header">
                  <div>
                    <div class="je-orphaned-result-name">${escapeHtml(result.group.details.name)}</div>
                    <div class="je-orphaned-result-count">${result.group.bookmarks.length} bookmark(s) • ${result.matches.length} replacement(s) found</div>
                  </div>
                  <button class="btnMigrateOrphaned je-btn" data-result-index="${idx}">
                    <span class="material-icons" aria-hidden="true" style="font-size: 16px;">find_replace</span>
                    <span>Migrate</span>
                  </button>
                </div>
                <div class="je-orphaned-result-meta">
                  TMDB: ${result.group.details.tmdbId || 'N/A'} • Item ID: ${result.group.details.itemId.substring(0,12)}...
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Migrate button handlers
    modal.querySelectorAll('.btnMigrateOrphaned').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.resultIndex);
        const result = replacementResults[idx];
        closeDialog();
        setTimeout(() => showReplacementSelectionModal(result.group, result.matches), 300);
      });
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  Object.assign(internal, { findAndOfferReplacement });

})(window.JellyfinEnhanced);
