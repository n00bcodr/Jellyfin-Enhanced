/**
 * Bookmarks Library View — offset-adjustment and duplicate-merge modals.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  const { formatTimestamp } = internal;
  const renderBookmarksLibrary = (...args) => internal.renderBookmarksLibrary(...args);

  const escapeHtml = JE.escapeHtml;

  /**
   * Show modal to adjust time offset for synced bookmarks
   */
  function showOffsetAdjustmentModal(group) {
    const syncedBookmarks = group.bookmarks.filter(bm => bm.syncedFrom);
    if (syncedBookmarks.length === 0) {
      JE.toast(JE.t('bookmark_no_synced'), 2000);
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 550px;">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #2196f3; flex-shrink: 0;">schedule</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">${JE.t('bookmark_adjust_offset')}</h2>
              <p class="je-modal-subtitle">${JE.t('bookmark_synced_count').replace('{count}', syncedBookmarks.length)} ${JE.t('bookmark_for_item').replace('{name}', escapeHtml(group.details.name))}</p>
            </div>
          </div>

          <div class="je-modal-info-box">
            <div class="je-modal-info-title"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">info</span> ${JE.t('bookmark_synced_info_title')}</div>
            <div class="je-modal-info-text">${JE.t('bookmark_synced_info_body')}</div>
          </div>

          <div style="margin-bottom: 24px;">
            <label for="offset-adjustment-input" class="je-modal-label"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">schedule</span> ${JE.t('bookmark_offset_label')}</label>
            <input type="number" id="offset-adjustment-input" value="0" step="0.1" placeholder="0" class="je-modal-input">
            <div class="je-modal-help-text">${JE.t('bookmark_offset_help')}</div>
          </div>

          <div class="je-modal-list-container">
            <div class="je-modal-list-title">${JE.t('bookmark_offset_affected')}</div>
            ${syncedBookmarks.map(bm => `
              <div class="je-modal-list-item">
                <div class="je-modal-list-item-title">${bm.label || JE.t('bookmark_unlabeled')}</div>
                <div class="je-modal-list-item-meta">${formatTimestamp(bm.timestamp)} • ${JE.t('bookmark_from').replace('{source}', bm.syncedFrom)}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="btnApplyOffset je-modal-btn-primary">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">check</span>
            <span>${JE.t('bookmark_apply_offset')}</span>
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

    // Apply offset button handler
    modal.querySelector('.btnApplyOffset').addEventListener('click', async () => {
      const offset = parseFloat(modal.querySelector('#offset-adjustment-input').value) || 0;

      const btn = modal.querySelector('.btnApplyOffset');
      btn.disabled = true;
      btn.querySelector('span:last-child').innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

      try {
        let updatedCount = 0;

        // Update each synced bookmark
        for (const bm of syncedBookmarks) {
          const newTimestamp = Math.max(0, bm.timestamp + offset);
          const ok = await JE.bookmarks.update(bm.id, {
            timestamp: newTimestamp,
            syncedFrom: '' // Clear syncedFrom to remove the icon
          });
          if (ok) updatedCount++;
        }

        if (updatedCount > 0) {
          const message = offset === 0
            ? JE.t('bookmark_offset_cleared').replace('{count}', updatedCount)
            : JE.t('bookmark_offset_applied').replace('{count}', updatedCount).replace('{offset}', `${offset > 0 ? '+' : ''}${offset}s`);
          JE.toast(message, 3000);
          closeDialog();

          // Refresh the library view
          const container = document.querySelector('.sections.bookmarks');
          if (container) {
            setTimeout(() => renderBookmarksLibrary(container), 300);
          }
        } else {
          JE.toast(JE.t('bookmark_update_failed'), 3000);
          btn.disabled = false;
          btn.querySelector('span:last-child').textContent = JE.t('bookmark_apply_offset');
        }
      } catch (e) {
        console.error('Failed to apply offset:', e);
        JE.toast(JE.t('bookmark_offset_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child').textContent = JE.t('bookmark_apply_offset');
      }
    });

    // Fade in
    setTimeout(() => modal.style.opacity = '1', 10);
  }

  /**
   * Find duplicate bookmarks (same TMDB/TVDB but different item IDs)
   */
  function findDuplicateBookmarks(bookmarks) {
    const byProvider = {}; // Group by TMDB/TVDB ID
    const duplicateGroups = [];

    for (const [id, bm] of Object.entries(bookmarks)) {
      const tmdbKey = bm.tmdbId ? `tmdb:${bm.tmdbId}` : null;
      const tvdbKey = bm.tvdbId ? `tvdb:${bm.tvdbId}` : null;

      for (const key of [tmdbKey, tvdbKey].filter(Boolean)) {
        if (!byProvider[key]) {
          byProvider[key] = {};
        }
        if (!byProvider[key][bm.itemId]) {
          byProvider[key][bm.itemId] = [];
        }
        byProvider[key][bm.itemId].push({ id, ...bm });
      }
    }

    // Find groups with multiple item IDs
    for (const [providerKey, itemGroups] of Object.entries(byProvider)) {
      const itemIds = Object.keys(itemGroups);
      if (itemIds.length > 1) {
        duplicateGroups.push({
          providerKey,
          itemGroups,
          totalBookmarks: Object.values(itemGroups).flat().length,
          name: Object.values(itemGroups)[0][0].name || 'Unknown'
        });
      }
    }

    return duplicateGroups;
  }

  /**
   * Show modal to sync duplicate bookmarks
   */
  function showDuplicatesSyncModal(bookmarks) {
    const duplicates = findDuplicateBookmarks(bookmarks);

    if (duplicates.length === 0) {
      JE.toast(JE.t('bookmark_no_duplicates'), 3000);
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8); max-height: 85vh; overflow-y: auto;">
        <button class="je-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header" style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px;">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #ff9800; flex-shrink: 0;">merge</span>
            <div style="flex: 1;">
              <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #fff;">${JE.t('bookmark_duplicate_title')}</h2>
              <p style="margin: 0; font-size: 13px; color: #aaa;">${JE.t('bookmark_duplicate_subtitle').replace('{count}', duplicates.length)}</p>
            </div>
          </div>
          <div style="margin-top: 20px;">
            ${duplicates.map((dup, idx) => {
              const itemIds = Object.keys(dup.itemGroups);
              return `
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                  <div style="font-weight: 600; margin-bottom: 12px; color: #ff9800;">${escapeHtml(dup.name)}</div>
                  <div style="font-size: 12px; color: #888; margin-bottom: 12px;">
                    ${JE.t('bookmark_split_versions')
                      .replace('{count}', dup.totalBookmarks)
                      .replace('{versions}', itemIds.length)}
                  </div>
                  ${itemIds.map((itemId, versionIdx) => {
                    const bms = dup.itemGroups[itemId];
                    return `
                      <div style="background: rgba(255,255,255,0.02); border-left: 3px solid ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px;">
                        <div style="font-size: 11px; color: ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; font-weight: 600; margin-bottom: 4px;">
                          ${versionIdx === 0 ? JE.t('bookmark_primary_version') : JE.t('bookmark_old_version')}
                        </div>
                        <div style="font-size: 12px; color: #ccc; margin-bottom: 6px;">
                          ${JE.t('bookmark_item_id')}: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-size: 11px;">${itemId.substring(0, 16)}...</code>
                        </div>
                        <div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">
                          ${JE.t('bookmark_bookmark_count').replace('{count}', bms.length)} ${bms.map(b => formatTimestamp(b.timestamp)).join(', ')}
                        </div>
                        <button class="je-btn" data-sync-from="${versionIdx}" data-dup-index="${idx}" style="background: rgba(33, 150, 243, 0.15); border-color: #2196f3; color: #2196f3; font-size: 11px;">
                          <span class="material-icons" aria-hidden="true" style="font-size: 14px;">schedule</span>
                          <span>${JE.t('bookmark_adjust_offset')}</span>
                        </button>
                      </div>
                    `;
                  }).join('')}
                  <button class="je-btn" data-dup-index="${idx}" style="margin-top: 8px; background: rgba(255, 152, 0, 0.15); border-color: #ff9800; color: #ff9800;">
                    <span class="material-icons" aria-hidden="true" style="font-size: 16px;">merge</span>
                    <span>${JE.t('bookmark_merge_primary')}</span>
                  </button>
                </div>
              `;
            }).join('')}
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

    // Adjust Offset button handlers
    modal.querySelectorAll('[data-sync-from]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const dupIndex = parseInt(btn.dataset.dupIndex);
        const versionIndex = parseInt(btn.dataset.syncFrom);
        const dup = duplicates[dupIndex];
        const itemIds = Object.keys(dup.itemGroups);
        const targetItemId = itemIds[versionIndex];
        const bookmarksForItem = dup.itemGroups[targetItemId];

        closeDialog();

        // Show offset adjustment modal for these bookmarks
        const groupObj = {
          bookmarks: bookmarksForItem,
          details: { name: dup.name }
        };
        showOffsetAdjustmentModal(groupObj);
      });
    });

    // Merge button handlers
    modal.querySelectorAll('button.je-btn:not([data-sync-from])').forEach(btn => {
      if (!btn.dataset.dupIndex) return;

      btn.addEventListener('click', async () => {
        const dupIndex = parseInt(btn.dataset.dupIndex);
        const dup = duplicates[dupIndex];
        const itemIds = Object.keys(dup.itemGroups);

        if (itemIds.length < 2) return;

        const primaryItemId = itemIds[0]; // First one is primary
        const oldItemIds = itemIds.slice(1);

        const primaryBookmarks = dup.itemGroups[primaryItemId];
        const oldBookmarks = oldItemIds.flatMap(id => dup.itemGroups[id]);

        if (!confirm(JE.t('bookmark_merge_confirm').replace('{count}', oldBookmarks.length))) {
          return;
        }

        btn.disabled = true;
        btn.querySelector('span:last-child').innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

        try {
          // Get primary item details from first primary bookmark
          const primaryDetails = {
            itemId: primaryItemId,
            tmdbId: primaryBookmarks[0].tmdbId,
            tvdbId: primaryBookmarks[0].tvdbId,
            mediaType: primaryBookmarks[0].mediaType,
            name: primaryBookmarks[0].name
          };

          // Sync old bookmarks to primary
          const synced = await JE.bookmarks.syncBookmarks(oldBookmarks, primaryDetails, 0);
          JE.toast(JE.t('bookmark_merge_success').replace('{count}', synced.length), 3000);

          closeDialog();

          // Refresh the library view
          const container = document.querySelector('.sections.bookmarks');
          if (container) {
            setTimeout(() => renderBookmarksLibrary(container), 500);
          }
        } catch (e) {
          console.error('Merge failed:', e);
          JE.toast(JE.t('bookmark_merge_failed'), 3000);
          btn.disabled = false;
          btn.querySelector('span:last-child').textContent = JE.t('bookmark_merge_primary');
        }
      });
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  Object.assign(internal, { showOffsetAdjustmentModal, showDuplicatesSyncModal });

})(window.JellyfinEnhanced);
