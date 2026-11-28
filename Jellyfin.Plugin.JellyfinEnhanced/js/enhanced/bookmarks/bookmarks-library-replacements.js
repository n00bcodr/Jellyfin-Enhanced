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

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';

  /** Item types a user can pick by hand. A Series only opens its episode list. */
  const PICKABLE_TYPES = 'Movie,Series,Episode,Video,MusicVideo';

  /**
   * Items from a Jellyfin list endpoint, without the placeholders for missing episodes.
   */
  async function getItems(path, params) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    const query = new URLSearchParams(params).toString();
    const response = await JE.core.api.fetch(apiClient.getUrl(`${path}?${query}`));
    return (response?.Items || []).filter(item => item.LocationType !== 'Virtual');
  }

  const queryLibrary = (params) => getItems(
    `Users/${(window.ApiClient || window.ConnectionManager?.currentApiClient()).getCurrentUserId()}/Items`,
    { Recursive: 'true', ...params }
  );

  const getEpisodes = (seriesId) => getItems(`Shows/${seriesId}/Episodes`, {
    userId: (window.ApiClient || window.ConnectionManager?.currentApiClient()).getCurrentUserId(),
    Fields: 'ProviderIds'
  });

  /**
   * Search Jellyfin for items matching a bookmark's TMDB/TVDB ID. The whole library
   * is checked, and Jellyfin only returns provider IDs when asked for them.
   */
  async function searchForReplacementItem({ tmdbId, tvdbId, mediaType, seasonNumber = null, episodeNumber = null }) {
    if (!tmdbId && !tvdbId) return [];

    const matchesIds = ({ ProviderIds: ids = {} }) =>
      (!!tmdbId && ids.Tmdb === String(tmdbId)) || (!!tvdbId && ids.Tvdb === String(tvdbId));
    const search = async (types) => (await queryLibrary({ IncludeItemTypes: types, Fields: 'ProviderIds' })).filter(matchesIds);

    if (mediaType === 'movie') return search('Movie');
    // Other media (music videos, etc.) doesn't preserve the original Jellyfin type.
    if (mediaType !== 'tv') return search(PICKABLE_TYPES);

    // An episode bookmark stores the series' TMDB ID, so find the show first.
    const shows = await search('Series');
    if (episodeNumber == null) return shows;

    const isSameEpisode = (item) => item.ParentIndexNumber === seasonNumber && item.IndexNumber === episodeNumber;
    const matches = [];
    for (const show of shows) {
      matches.push(...(await getEpisodes(show.Id)).filter(isSameEpisode));
    }
    if (matches.length > 0 || !tvdbId) return matches;

    // The episode's own TVDB ID still finds it when the show's IDs have changed.
    return (await search('Episode')).filter(isSameEpisode);
  }

  /**
   * Find replacements for an orphaned item and offer migration. The modal opens even
   * without a match, so the user can pick the item by hand.
   */
  async function findAndOfferReplacement(group, triggerBtn) {
    triggerBtn.disabled = true;

    let matches = [];
    try {
      matches = await searchForReplacementItem(group.details);
    } catch (e) {
      console.error(`${logPrefix} Failed to search for replacement:`, e);
    }

    showReplacementSelectionModal(group, matches);
    triggerBtn.disabled = false;
  }

  /**
   * Show modal to select replacement item and migrate bookmarks
   */
  function showReplacementSelectionModal(oldGroup, matches) {
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
              <h2 class="je-modal-title">${JE.t('bookmark_find_replacement')}</h2>
              <p class="je-modal-subtitle">Migrate ${oldGroup.bookmarks.length} bookmark(s) from the old item to a new version</p>
            </div>
          </div>

          <div class="je-modal-warning-box">
            <div class="je-modal-warning-label">Old Item (Missing)</div>
            <div class="je-modal-item-name">${escapeHtml(oldGroup.details.name)}</div>
            <div class="je-modal-item-meta">TMDB: ${escapeHtml(oldGroup.details.tmdbId || 'N/A')} • Item ID: ${escapeHtml((oldGroup.details.itemId || '').substring(0, 16))}...</div>
          </div>

          <form class="je-replacement-search">
            <input type="search" class="je-input" placeholder="${JE.t('bookmark_search_library')}" aria-label="${JE.t('bookmark_search_library')}">
            <button type="submit" class="je-btn-action" title="${JE.t('bookmark_search_library')}">
              <span class="material-icons" aria-hidden="true" style="font-size: 18px;">search</span>
            </button>
          </form>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options"></div>
        </div>
        <div class="je-modal-actions-padded">
          <button class="je-modal-btn-cancel-alt je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="je-modal-btn-submit je-bookmark-btn-submit" disabled>
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">swap_horiz</span>
            <span>${JE.t('bookmark_migrate')}</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const options = modal.querySelector('.je-replacement-options');
    const submitBtn = modal.querySelector('.je-bookmark-btn-submit');
    const searchInput = modal.querySelector('.je-replacement-search input');
    searchInput.value = oldGroup.details.name || '';

    let shownItems = [];
    let selectedItem = null;
    // Only the newest search or episode list may fill the results.
    let latestRequest = 0;

    function renderOptions(items) {
      shownItems = items;
      selectedItem = null;
      submitBtn.disabled = true;

      if (items.length === 0) {
        options.innerHTML = `<div class="replacement-option-meta">${JE.t('bookmark_no_replacement')}</div>`;
        return;
      }

      options.innerHTML = items.map((item, idx) => {
        const posterUrl = apiClient.getImageUrl(item.Id, {
          type: 'Primary',
          maxWidth: 120,
          tag: item.ImageTags?.Primary
        });
        const episode = item.Type === 'Episode'
          ? `${item.SeriesName || ''} S${item.ParentIndexNumber ?? '?'}:E${item.IndexNumber ?? '?'}`
          : '';
        const meta = [episode, item.ProductionYear].filter(Boolean).join(' • ');
        return `
          <button type="button" class="replacement-option" data-item-index="${idx}">
            ${posterUrl ? `<img src="${posterUrl}" alt="">` : '<div class="replacement-option-placeholder"></div>'}
            <div class="replacement-option-info">
              <div class="replacement-option-name">${escapeHtml(item.Name)}</div>
              <div class="replacement-option-meta">${escapeHtml(meta)}</div>
              <div class="replacement-option-meta">Item ID: ${escapeHtml(item.Id.substring(0, 16))}...</div>
            </div>
            <span class="material-icons replacement-option-check" aria-hidden="true">${item.Type === 'Series' ? 'chevron_right' : 'check_circle'}</span>
          </button>
        `;
      }).join('');
    }

    async function showResults(load) {
      const request = ++latestRequest;
      renderOptions([]);
      options.textContent = '…';
      let items = [];
      try {
        items = await load();
      } catch (e) {
        console.error(`${logPrefix} Failed to search the library:`, e);
      }
      if (request === latestRequest) renderOptions(items);
    }

    renderOptions(matches);

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    modal.querySelector('.je-replacement-search').addEventListener('submit', (e) => {
      e.preventDefault();
      const term = searchInput.value.trim();
      if (!term) return;
      showResults(() => queryLibrary({ SearchTerm: term, IncludeItemTypes: PICKABLE_TYPES, Limit: '50' }));
    });

    // Selection handler
    options.addEventListener('click', (e) => {
      const option = e.target.closest('.replacement-option');
      if (!option) return;
      const item = shownItems[Number(option.dataset.itemIndex)];

      if (item.Type === 'Series') {
        // Bookmarks belong to a playable file: list the episodes, the bookmarked one first.
        const { seasonNumber, episodeNumber } = oldGroup.details;
        const isSameEpisode = (ep) => ep.ParentIndexNumber === seasonNumber && ep.IndexNumber === episodeNumber;
        showResults(async () => (await getEpisodes(item.Id)).sort((a, b) => isSameEpisode(b) - isSameEpisode(a)));
        return;
      }

      selectedItem = item;
      options.querySelectorAll('.replacement-option').forEach(opt => {
        opt.classList.toggle('selected', opt === option);
        opt.setAttribute('aria-pressed', String(opt === option));
      });
      submitBtn.disabled = false;
    });

    // Migrate handler
    submitBtn.addEventListener('click', async () => {
      if (!selectedItem) return;

      submitBtn.disabled = true;
      submitBtn.querySelector('span:last-child').textContent = 'Migrating...';

      try {
        // The same item fields a new bookmark on that file would get.
        const details = await JE.bookmarks.itemDetails(selectedItem.Id);
        if (!details) throw new Error('Could not load the selected item');

        const newDetails = {
          ...details,
          tmdbId: details.tmdbId || oldGroup.details.tmdbId || '',
          tvdbId: details.tvdbId || oldGroup.details.tvdbId || ''
        };

        // Move the bookmarks to the new item (no offset). The old records are removed
        // in the same save, before the re-render it triggers, and come back if it fails.
        const synced = await JE.bookmarks.syncBookmarks(oldGroup.bookmarks, newDetails, 0, { replaceOriginals: true });

        JE.toast(JE.t('bookmark_migrated').replace('{count}', synced.length).replace('{name}', details.name), 4000);

        closeDialog();

        // Refresh the library view
        const container = document.querySelector('.sections.bookmarks');
        if (container) {
          setTimeout(() => renderBookmarksLibrary(container), 500);
        }
      } catch (e) {
        console.error('Migration failed:', e);
        JE.toast(JE.t('bookmark_migration_failed'), 3000);
        submitBtn.disabled = false;
        submitBtn.querySelector('span:last-child').textContent = JE.t('bookmark_migrate');
      }
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  Object.assign(internal, { findAndOfferReplacement });

})(window.JellyfinEnhanced);
