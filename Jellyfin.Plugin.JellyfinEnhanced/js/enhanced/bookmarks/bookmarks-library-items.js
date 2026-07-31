/**
 * Bookmarks Library View — per-item card rendering + bookmark playback.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  // Direct references to earlier-loaded module exports…
  const { formatTimestamp, parseTimestampInput } = internal;
  // …and late-bound references to later-loaded modules.
  const renderBookmarksLibrary = (...args) => internal.renderBookmarksLibrary(...args);
  const findAndOfferReplacement = (...args) => internal.findAndOfferReplacement(...args);
  const showOffsetAdjustmentModal = (...args) => internal.showOffsetAdjustmentModal(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';

  const escapeHtml = JE.escapeHtml;

  /**
   * Render bookmark items with posters
   */
  async function renderBookmarkItems(container, groupedByItem, currentTab) {
    container.innerHTML = '';
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) {
      container.innerHTML = '<p>API client not available</p>';
      return;
    }

    const userId = apiClient.getCurrentUserId();
    const itemPromises = [];

    // Fetch all items
    for (const [key, group] of Object.entries(groupedByItem)) {
      const itemId = group.details.itemId;
      if (itemId) {
        itemPromises.push(
          (JE.helpers?.getItemCached
            ? JE.helpers.getItemCached(itemId, { userId })
            : apiClient.getItem(userId, itemId))
            .then(item => ({ key, group, item, orphaned: false }))
            .catch(err => {
              console.warn(`Failed to fetch item ${itemId}:`, err);
              return { key, group, item: null, orphaned: true };
            })
        );
      } else {
        itemPromises.push(Promise.resolve({ key, group, item: null, orphaned: true }));
      }
    }

    const results = await Promise.all(itemPromises);

    // Apply tab filter
    const filtered = results.filter(({ group }) => {
      if (currentTab === 'tv') return group.type === 'tv';
      if (currentTab === 'movie') return group.type === 'movie';
      return true;
    });

    if (filtered.length === 0) {
      const emptyTitle = currentTab === 'tv' ? JE.t('bookmark_empty_tv') : JE.t('bookmark_empty_movie');
      const emptyHint = JE.t('bookmark_empty_hint');
      container.innerHTML = `
        <div class="je-bookmarks-empty">
          <div class="je-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
          <div class="je-bookmarks-empty-title">${emptyTitle}</div>
          <div class="je-bookmarks-empty-hint">${emptyHint}</div>
        </div>`;
      return;
    }

    // Render each item
    for (const { key, group, item, orphaned } of filtered) {
      const itemCard = document.createElement('div');
      itemCard.className = 'je-bookmark-item';
      if (orphaned) {
        itemCard.classList.add('je-bookmark-item-orphaned');
      }

      const posterUrl = item ? apiClient.getImageUrl(item.Id, {
        type: 'Primary',
        maxWidth: 260,
        tag: item.ImageTags?.Primary
      }) : '';

      // Build header content
      let titleDisplay = escapeHtml(group.details.name || 'Unknown Item');
      // For TV episodes, show series name and episode number/name
      if (group.type === 'tv' && item && item.Type === 'Episode' && item.SeriesName) {
        titleDisplay = `${escapeHtml(item.SeriesName)}<br><small class="je-episode-title">S${item.ParentIndexNumber || '?'}:E${item.IndexNumber || '?'} ${item.Name ? escapeHtml(item.Name) : ''}</small>`;
      }

      // Create the card header HTML
      const headerHtml = `
        <div class="je-bookmark-item-header">
          ${posterUrl ? `
            <img src="${posterUrl}"
                 class="je-bookmark-item-poster"
                 data-item-id="${group.details.itemId}">
          ` : `
            <div class="je-bookmark-item-placeholder"><span class="material-icons" style="font-size: 48px; opacity: 0.3;">image_not_supported</span></div>
          `}
          <div class="je-bookmark-item-info">
            <a href="/web/#/details?id=${group.details.itemId || ''}" class="je-bookmark-item-title">${titleDisplay}</a>
            <div class="je-bookmark-item-meta">
              ${JE.t('bookmark_count').replace('{count}', group.bookmarks.length)}
              ${orphaned ? ` • <span style="color: #ff9800;">${JE.t('bookmark_orphaned')}</span>` : ''}
            </div>
          </div>
          ${orphaned && group.details.tmdbId ? `
            <button class="btnFindReplacement je-btn-find-replacement" data-group-key="${key}" title="${JE.t('bookmark_find_replacement')}">
              <span class="material-icons" aria-hidden="true">find_replace</span>
            </button>
          ` : ''}
          ${!orphaned && group.bookmarks.some(bm => bm.syncedFrom) ? `
            <button class="btnAdjustOffset je-offset-icon" data-group-key="${key}" title="${JE.t('bookmark_adjust_offset')}">
              <span class="material-icons" aria-hidden="true">schedule</span>
            </button>
          ` : ''}
        </div>
        <div class="je-bookmarks-list bookmarks-list-${key}"></div>
      `;

      itemCard.innerHTML = headerHtml;
      container.appendChild(itemCard);

      // Add Find Replacement handler
      const findBtn = itemCard.querySelector('.btnFindReplacement');
      if (findBtn) {
        findBtn.addEventListener('click', async () => {
          await findAndOfferReplacement(group, findBtn);
        });
      }

      // Add Offset Adjustment handler
      const offsetBtn = itemCard.querySelector('.btnAdjustOffset');
      if (offsetBtn) {
        offsetBtn.addEventListener('click', () => {
          showOffsetAdjustmentModal(group);
        });
      }

      // Add poster click handler
      const poster = itemCard.querySelector('.je-bookmark-item-poster');
      if (poster) {
        poster.addEventListener('click', () => {
          const itemId = poster.dataset.itemId;
          if (itemId) {
            window.Emby?.Page?.show(`/details?id=${itemId}`);
          }
        });
      }

      // Render bookmarks for this item
      const bookmarksList = itemCard.querySelector(`.bookmarks-list-${key}`);
      if (bookmarksList) {
        group.bookmarks.forEach(bm => {
          const bmEl = document.createElement('div');
          bmEl.className = 'je-bookmark-row';

          const row = document.createElement('div');
          row.className = 'je-bookmark-main';

          const bar = document.createElement('div');
          bar.className = 'je-bookmark-bar';

          const info = document.createElement('div');
          info.className = 'je-bookmark-info';
          info.innerHTML = `
            ${bm.label ? `<div class="je-bookmark-label">${escapeHtml(bm.label)}</div>` : ''}
            <div class="je-bm-time" data-item-id="${bm.itemId}" data-time="${bm.timestamp}">
              <span>${bm.progress ? `${bm.progress}% • ` : ''}${formatTimestamp(bm.timestamp)}</span>
            </div>
          `;

          const actions = document.createElement('div');
          actions.className = 'je-bookmark-actions';

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btnDeleteBookmark je-btn je-btn-delete';
          deleteBtn.innerHTML = '<span class="material-icons" aria-hidden="true">delete</span>';
          deleteBtn.dataset.bookmarkId = bm.id;

          // Only add play and edit buttons if not orphaned
          if (!orphaned) {
            const playBtn = document.createElement('button');
            playBtn.className = 'btnPlayBookmark je-btn';
            playBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
            playBtn.dataset.itemId = bm.itemId;
            playBtn.dataset.time = bm.timestamp;

            const editBtn = document.createElement('button');
            editBtn.className = 'btnEditBookmark je-btn';
            editBtn.innerHTML = '<span class="material-icons" aria-hidden="true">edit</span>';

            actions.appendChild(playBtn);
            actions.appendChild(editBtn);
          }

          actions.appendChild(deleteBtn);

          row.appendChild(bar);
          row.appendChild(info);
          row.appendChild(actions);

          const editRow = document.createElement('div');
          editRow.className = 'je-btn-edit-row';

          const timeInput = document.createElement('input');
          timeInput.type = 'text';
          timeInput.className = 'je-input';
          timeInput.value = formatTimestamp(bm.timestamp);
          timeInput.placeholder = JE.t('bookmark_time_placeholder');

          const labelInput = document.createElement('input');
          labelInput.type = 'text';
          labelInput.className = 'je-input je-input-label';
          labelInput.value = bm.label || '';
          labelInput.placeholder = JE.t('bookmark_label_placeholder');
          labelInput.maxLength = 100;

          const saveBtn = document.createElement('button');
          saveBtn.className = 'je-btn-action';
          saveBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'je-btn-action je-btn-cancel';
          cancelBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';

          editRow.appendChild(timeInput);
          editRow.appendChild(labelInput);
          editRow.appendChild(saveBtn);
          editRow.appendChild(cancelBtn);

          bmEl.appendChild(row);
          bmEl.appendChild(editRow);
          bookmarksList.appendChild(bmEl);

          // Play button handler (only if not orphaned)
          const playBtn = actions.querySelector('.btnPlayBookmark');
          if (playBtn) {
            playBtn.addEventListener('click', async () => {
              const itemId = playBtn.dataset.itemId;
              const time = parseFloat(playBtn.dataset.time);
              await playItemAtTime(itemId, time);
            });
          }

          // Edit button handler (only if not orphaned)
          const editBtn = actions.querySelector('.btnEditBookmark');
          if (editBtn) {
            editBtn.addEventListener('click', () => {
              editRow.classList.toggle('show');
              if (editRow.classList.contains('show')) {
                timeInput.focus();
              }
            });
          }

          cancelBtn.addEventListener('click', () => {
            editRow.classList.remove('show');
            timeInput.value = formatTimestamp(bm.timestamp);
            labelInput.value = bm.label || '';
          });

          saveBtn.addEventListener('click', async () => {
            const parsedTime = parseTimestampInput(timeInput.value);
            if (parsedTime === null) {
              JE.toast(JE.t('bookmark_time_format_hint'), 3000);
              return;
            }

            saveBtn.disabled = true;
            editBtn.disabled = true;
            try {
              const ok = await JE.bookmarks.update(bm.id, {
                timestamp: parsedTime,
                label: labelInput.value.trim()
              });
              if (ok) {
                JE.toast(JE.t('toast_bookmark_updated'), 2000);
                const bookmarksSection = document.querySelector('.sections.bookmarks');
                if (bookmarksSection) {
                  renderBookmarksLibrary(bookmarksSection);
                }
              } else {
                JE.toast(JE.t('toast_bookmark_save_failed'), 3000);
              }
            } catch (err) {
              console.error('Bookmark update failed', err);
              JE.toast(JE.t('toast_bookmark_save_failed'), 3000);
            } finally {
              saveBtn.disabled = false;
              editBtn.disabled = false;
            }
          });

          // Delete button handler
          deleteBtn.addEventListener('click', async () => {
            const bookmarkId = deleteBtn.dataset.bookmarkId;
            await JE.bookmarks.delete(bookmarkId);
            JE.toast(JE.t('toast_bookmark_deleted'), 2000);

            // Re-render
            const bookmarksSection = document.querySelector('.sections.bookmarks');
            if (bookmarksSection) {
              renderBookmarksLibrary(bookmarksSection);
            }
          });

          // Timestamp click-to-play
          const ts = info.querySelector('.je-bm-time');
          ts?.addEventListener('click', async () => {
            const t = parseFloat(ts.dataset.time);
            await playItemAtTime(ts.dataset.itemId, t);
          });
        });
      }
    }
  }

  /**
   * Play item at specific time
   */
  async function playItemAtTime(itemId, startTime) {
    try {
      console.log(`${logPrefix} Attempting playback: itemId=${itemId}, startTime=${startTime}`);

      // Get the API client
      const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
      if (!apiClient) {
        console.warn(`${logPrefix} API client not available`);
        JE.toast(JE.t('toast_api_client_unavailable'), 3000);
        return;
      }

      // Get device ID to find our session
      const deviceId = apiClient._deviceId || apiClient.deviceId();
      console.log(`${logPrefix} Device ID: ${deviceId}`);

      // Query sessions to find our current session
      const sessionsUrl = apiClient.getUrl('Sessions');
      const sessions = await apiClient.ajax({
        type: 'GET',
        url: sessionsUrl,
        dataType: 'json'
      });

      console.log(`${logPrefix} Available sessions:`, sessions);

      // Find our session by device ID
      const currentSession = sessions.find(s => s.DeviceId === deviceId);

      if (!currentSession) {
        console.warn(`${logPrefix} Could not find current session`);
        JE.toast(JE.t('toast_session_not_found'), 3000);
        return;
      }

      const sessionId = currentSession.Id;
      console.log(`${logPrefix} Found session ID: ${sessionId}`);

      // Use Jellyfin Sessions API to start playback with query parameters
      const startTicks = Math.floor(startTime * 10000000);
      const url = `Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}&startPositionTicks=${startTicks}`;

      console.log(`${logPrefix} Sending playback request:`, url);

      await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(url)
      });

      console.log(`${logPrefix} Playback started successfully`);
      JE.toast(JE.t('toast_playing'), 2000);

      // Wait for navigation to complete, then trigger bookmark marker update
      setTimeout(() => {
        if (window.JE?.isVideoPage?.() && typeof window.JE.bookmarks?.updateMarkers === 'function') {
          console.log(`${logPrefix} Triggering bookmark marker update after playback start`);
          window.JE.bookmarks.updateMarkers();
        }
      }, 1500);

    } catch (e) {
      console.error(`${logPrefix} Failed to play item:`, e);
      JE.toast(JE.t('toast_playback_failed').replace('{error}', e.message || 'Unknown error'), 3000);
    }
  }

  Object.assign(internal, { renderBookmarkItems });

})(window.JellyfinEnhanced);
