/**
 * Bookmarks Library View — mount detection + main library rendering,
 * plus the small shared time/type helpers.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  // Late-bound cross-module references (defined in bookmarks-library-items.js
  // and bookmarks-library-modals.js).
  const renderBookmarkItems = (...args) => internal.renderBookmarkItems(...args);
  const showDuplicatesSyncModal = (...args) => internal.showDuplicatesSyncModal(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';
  let isRendering = false;
  let lastRenderTs = 0;
  let lastMountedContainer = null;

  /**
   * Render when section exists or bookmarks updated
   */
  function renderIfSectionExists() {
    // Prevent re-entrant renders triggered by our own DOM mutations
    if (isRendering) return;
    const now = Date.now();
    if (now - lastRenderTs < 150) return;

    const container = findActiveBookmarksContainer();
    if (!container) {
      lastMountedContainer = null;
      return;
    }

    // Only render if container changed (new DOM node) or is empty
    const shouldRender = container !== lastMountedContainer
      || !container.hasChildNodes()
      || (lastMountedContainer && !document.contains(lastMountedContainer));

    if (shouldRender) {
      revealSection(container);
      isRendering = true;
      renderBookmarksLibrary(container).finally(() => {
        isRendering = false;
        lastRenderTs = Date.now();
      });
      lastMountedContainer = container;
    }
  }

  /**
   * Find the bookmarks container inside the active (non-hidden) home page.
   * Returns null if no visible container exists -- never falls back to a
   * stale DOM-cached copy.
   * @returns {HTMLElement|null}
   */
  function findActiveBookmarksContainer() {
    const all = document.querySelectorAll('.sections.bookmarks');
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      // 1. Standard Jellyfin page structure
      const page = el.closest('.page');
      if (page && !page.classList.contains('hide')) return el;
      // 2. Custom Tabs wraps content in .tabContent.is-active (no .page ancestor)
      const tabContent = el.closest('.tabContent');
      if (tabContent && tabContent.classList.contains('is-active')) return el;
      // 3. Last resort: element is simply visible in the document
      if (!page && !tabContent && el.offsetParent !== null) return el;
    }
    return null;
  }

  /**
   * Bind to viewshow so CustomTabs triggers render
   */
  function hookViewEvents() {
    JE.core.navigation.onViewPage((v, el, hash, itemPromise, rawEvent) => {
      // Only real viewshow events carry the shown view element on
      // e.detail.view; router-internal notifications (rawEvent == null) were
      // never seen by the old document-level listener either.
      const e = rawEvent;
      if (!e) return;
      if (isRendering) return;
      // CustomTabs provides a view element on e.detail.view
      const view = e.detail?.view || document;
      const container = view.querySelector?.('.sections.bookmarks') || findActiveBookmarksContainer();
      if (container) {
        revealSection(container);
        isRendering = true;
        renderBookmarksLibrary(container).finally(() => {
          isRendering = false;
          lastRenderTs = Date.now();
        });
        lastMountedContainer = container;
      }
    });
  }

  /**
   * Remove hidden styles often set by CustomTabs placeholders
   */
  function revealSection(container) {
    container.classList.remove('hide');
    container.style.removeProperty('display');
    container.style.removeProperty('visibility');
  }

  /**
   * Render bookmarks library content
   */
  async function renderBookmarksLibrary(container) {
    console.log(`${logPrefix} Rendering bookmarks library...`);

    const bookmarks = JE.userConfig.bookmark?.bookmarks || {};
    const bookmarkEntries = Object.entries(bookmarks);

    // Group by item
    const groupedByItem = {};
    const typeCounts = {
      tv: { items: 0, bookmarks: 0 },
      movie: { items: 0, bookmarks: 0 }
    };

    for (const [id, bm] of bookmarkEntries) {
      const key = bm.itemId || bm.tmdbId || bm.tvdbId || 'unknown';
      const normalizedType = normalizeMediaType(bm.mediaType);
      if (!groupedByItem[key]) {
        groupedByItem[key] = {
          details: bm,
          bookmarks: [],
          type: normalizedType
        };
        if (typeCounts[normalizedType]) {
          typeCounts[normalizedType].items += 1;
        }
      }
      groupedByItem[key].bookmarks.push({ id, ...bm });
      if (typeCounts[groupedByItem[key].type]) {
        typeCounts[groupedByItem[key].type].bookmarks += 1;
      }
    }

    // Sort bookmarks within each group by timestamp
    Object.values(groupedByItem).forEach(group => {
      group.bookmarks.sort((a, b) => a.timestamp - b.timestamp);
    });

    const totalBookmarks = bookmarkEntries.length;
    let currentTab = container.dataset.currentTab || 'movie';
    if (currentTab === 'tv' && typeCounts.tv.items === 0 && typeCounts.movie.items > 0) {
      currentTab = 'movie';
    } else if (currentTab === 'movie' && typeCounts.movie.items === 0 && typeCounts.tv.items > 0) {
      currentTab = 'tv';
    }
    container.dataset.currentTab = currentTab;

    // Create UI
    container.innerHTML = `
      <div class="je-bookmarks-wrapper">
        <div class="je-bookmark-tabs">
          <button class="je-tab ${currentTab === 'movie' ? 'active' : ''}" data-tab="movie">
            ${JE.t('bookmarks_library_tab_movies')}
          </button>
          <button class="je-tab ${currentTab === 'tv' ? 'active' : ''}" data-tab="tv">
            ${JE.t('bookmarks_library_tab_series')}
          </button>
        </div>

        <div class="bookmarks-container">
          ${totalBookmarks === 0 ? `
            <div class="je-bookmarks-empty">
              <div class="je-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
              <div class="je-bookmarks-empty-title">${JE.t('bookmarks_library_empty_title')}</div>
              <div class="je-bookmarks-empty-hint">${JE.t('bookmarks_library_empty_hint')}</div>
            </div>
          ` : `
            <div class="je-bookmarks-grid" id="bookmarks-items-container"></div>
            <div class="je-bookmark-actions-footer">
              <button class="btnFindDuplicates je-btn-footer">
                <span class="material-icons" aria-hidden="true">merge</span>
                <span>${JE.t('bookmarks_library_button_find_duplicates')}</span>
              </button>
              <button class="btnCleanupBookmarks je-btn-footer">
                <span class="material-icons" aria-hidden="true">cleaning_services</span>
                <span>${JE.t('bookmarks_library_button_cleanup')}</span>
              </button>
              <button class="btnDeleteAllBookmarks je-btn-footer je-btn-footer-delete">
                <span class="material-icons" aria-hidden="true">delete</span>
                <span>${JE.t('bookmarks_library_button_delete_all')}</span>
              </button>
            </div>
          `}
        </div>
      </div>
    `;

    // Attach button handlers
    const findDuplicatesBtn = container.querySelector('.btnFindDuplicates');
    const cleanupBtn = container.querySelector('.btnCleanupBookmarks');
    const deleteAllBtn = container.querySelector('.btnDeleteAllBookmarks');

    findDuplicatesBtn?.addEventListener('click', async () => {
      findDuplicatesBtn.disabled = true;
      const label = findDuplicatesBtn.querySelector('span:last-child');
      const origText = label.innerHTML;
      label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      // Surface duplicate bookmark groups and offer merging
      showDuplicatesSyncModal(bookmarks);

      findDuplicatesBtn.disabled = false;
      label.innerHTML = origText;
    });

    cleanupBtn?.addEventListener('click', async () => {
      cleanupBtn.disabled = true;
      const label = cleanupBtn.querySelector('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        const result = await JE.bookmarks.cleanupOrphaned();
        JE.toast(JE.t('bookmark_cleanup_complete').replace('{count}', result.cleaned), 4000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Cleanup failed:', error);
        JE.toast(JE.t('bookmark_cleanup_failed'), 3000);
      } finally {
        cleanupBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    deleteAllBtn?.addEventListener('click', async () => {
      if (!confirm(JE.t('bookmark_delete_all_confirm'))) return;

      deleteAllBtn.disabled = true;
      const label = deleteAllBtn.querySelector('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        JE.userConfig.bookmark.bookmarks = {};
        await JE.saveUserSettings('bookmark.json', JE.userConfig.bookmark);
        JE.toast(JE.t('bookmark_deleted_all'), 3000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Delete failed:', error);
        JE.toast(JE.t('bookmark_delete_failed'), 3000);
      } finally {
        deleteAllBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    // Render items with posters
    if (totalBookmarks > 0) {
      const itemsContainer = container.querySelector('#bookmarks-items-container');
      if (itemsContainer) {
        await renderBookmarkItems(itemsContainer, groupedByItem, currentTab);

        // Tab click handlers
        container.querySelectorAll('.je-tab').forEach(btn => {
          btn.addEventListener('click', async () => {
            const tab = btn.dataset.tab;
            container.dataset.currentTab = tab;
            container.querySelectorAll('.je-tab').forEach(b => {
              b.classList.toggle('active', b.dataset.tab === tab);
            });
            await renderBookmarkItems(itemsContainer, groupedByItem, tab);
          });
        });
      }
    }
  }

  /**
   * Format timestamp (seconds) to HH:MM:SS
   */
  function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function normalizeMediaType(mediaType) {
    const type = (mediaType || '').toLowerCase();
    if (type === 'series' || type === 'episode' || type === 'tvshow' || type === 'tv') return 'tv';
    if (type === 'movie' || type === 'film' || type === 'musicvideo') return 'movie';
    return 'other';
  }

  // Parse HH:MM:SS or MM:SS or seconds into numeric seconds
  function parseTimestampInput(value) {
    if (!value && value !== 0) return null;
    const str = String(value).trim();
    if (!str) return null;

    if (!str.includes(':')) {
      const num = parseFloat(str);
      return Number.isFinite(num) && num >= 0 ? num : null;
    }

    const parts = str.split(':').map(p => parseFloat(p));
    if (parts.some(p => Number.isNaN(p) || p < 0)) return null;

    let seconds = 0;
    for (const part of parts) {
      seconds = seconds * 60 + part;
    }
    return seconds;
  }

  Object.assign(internal, {
    renderIfSectionExists,
    hookViewEvents,
    renderBookmarksLibrary,
    formatTimestamp,
    parseTimestampInput,
  });

})(window.JellyfinEnhanced);
