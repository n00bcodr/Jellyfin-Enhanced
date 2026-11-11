import { bookmarksHost, type BookmarkHost } from './host';
import { displayBookmarks, formatTimestamp, parseTimestampInput } from './domain';
import { createLifetime } from './lifetime';
import type { Group, Library, MediaTab } from './types';
const { ctx, host, getApi } = bookmarksHost();
/**
 * Bookmarks Library View — mount detection + main library rendering,
 * plus the small shared time/type helpers.
 * Typed entry retaining the established library DOM and public bridge.
 */
function install(JE: BookmarkHost) {
  const lifetime = createLifetime(ctx, 'library-render');

  
  const internal = ctx.own.bookmarksLibrary = ctx.own.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  // Late-bound cross-module references (defined in bookmarks-library-items.js
  // and bookmarks-library-modals.js).
  const renderBookmarkItems = (...args: Parameters<Library["renderBookmarkItems"]>) => { const fn = internal.renderBookmarkItems; if (!fn) throw new Error("Missing bookmark module: renderBookmarkItems"); return fn(...args); };
  const showDuplicatesSyncModal = (...args: Parameters<Library["showDuplicatesSyncModal"]>) => { const fn = internal.showDuplicatesSyncModal; if (!fn) throw new Error("Missing bookmark module: showDuplicatesSyncModal"); return fn(...args); };

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';
  let isRendering = false;
  let lastMountedContainer: HTMLElement | null = null;

  // The mounted-container guard suppresses re-renders while the same DOM
  // node stays populated — which is exactly what happens across an SPA user
  // switch (the Custom Tabs panel survives logout/login), leaving user A's
  // rendered bookmarks visible to user B (upstream discussion about stale
  // bookmarks after switching accounts). Drop the guard on the transition,
  // then force a fresh render once the new user's bookmarks are loaded.
  lifetime.keep(JE.session?.onUserChange('bookmarks-library-render-state', () => {
    lastMountedContainer = null;
  }));
  function invalidateBookmarks() {
    lastMountedContainer = null;
    renderIfSectionExists();
  }
  lifetime.listen(document, 'je:user-data-loaded', invalidateBookmarks);
  lifetime.listen(document, 'je-bookmarks-updated', invalidateBookmarks);

  /**
   * Render when section exists or bookmarks updated
   */
  function renderIfSectionExists() {
    // Prevent re-entrant renders triggered by our own DOM mutations
    if (isRendering) return;

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
      lastMountedContainer = container;
      let completed = false;
      renderBookmarksLibrary(container).then(() => {
        completed = true;
      }).catch(error => {
        console.error(`${logPrefix} Failed to render bookmarks:`, error);
      }).finally(() => {
        isRendering = false;
        // A tab can be replaced or user data invalidated while poster requests
        // are pending. Reconcile once more; the populated-container guard
        // prevents our own DOM mutations from rendering it again.
        // Custom Tabs can also clear the same marker during a pending render.
        // Retry an emptied marker after success, but never spin on a failure.
        if (lastMountedContainer !== container || findActiveBookmarksContainer() !== container ||
            (completed && !container.hasChildNodes())) {
          renderIfSectionExists();
        }
      });
    }
  }

  /**
   * Find the bookmarks container inside the active (non-hidden) home page.
   * Returns null if no visible container exists -- never falls back to a
   * stale DOM-cached copy.
   * @returns {HTMLElement|null}
   */
  function findActiveBookmarksContainer() {
    const all = document.querySelectorAll<HTMLElement>('.sections.bookmarks');
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (el && JE.helpers.isActiveTabContainer(el)) return el;
    }
    return null;
  }

  /**
   * Bind to viewshow so CustomTabs triggers render
   */
  function hookViewEvents() {
    lifetime.keep(JE.core.navigation.onViewPage((v, el, hash, itemPromise, rawEvent) => {
      // Only real viewshow events carry the shown view element on
      // e.detail.view; router-internal notifications (rawEvent == null) were
      // never seen by the old document-level listener either.
      const e = rawEvent;
      if (!e) return;
      if (isRendering) return;
      // Use the same active-container search as the mount observer. A cached,
      // hidden page may be the first match in a document-level view event.
      renderIfSectionExists();
    }));
  }

  /**
   * Remove hidden styles often set by CustomTabs placeholders
   */
  function revealSection(container: HTMLElement) {
    container.classList.remove('hide');
    container.style.removeProperty('display');
    container.style.removeProperty('visibility');
  }

  /**
   * Render bookmarks library content
   */
  async function renderBookmarksLibrary(container: HTMLElement) {
    const isCurrent = lifetime.current();
    console.log(`${logPrefix} Rendering bookmarks library...`);
    if (JE.userConfig?.bookmarkRevision === null) {
      // The loader could not read the stored bookmarks: say so rather than showing an empty library.
      const failed = document.createElement('div'), icon = document.createElement('div'), title = document.createElement('div');
      failed.className = 'je-bookmarks-empty';
      icon.className = 'je-bookmarks-empty-icon material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'error_outline';
      title.className = 'je-bookmarks-empty-title'; title.textContent = JE.t('bookmarks_library_load_failed');
      failed.append(icon, title);
      container.replaceChildren(failed);
      return;
    }

    const bookmarks = displayBookmarks(JE.userConfig?.bookmark?.bookmarks);
    const bookmarkEntries = Object.entries(bookmarks);

    // Group by item
    const groupedByItem: Record<string, Group & {type: MediaTab}> = Object.create(null);
    const typeCounts = {
      tv: { items: 0, bookmarks: 0 },
      movie: { items: 0, bookmarks: 0 },
      other: { items: 0, bookmarks: 0 }
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
      groupedByItem[key]?.bookmarks.push({ ...bm, id });
      typeCounts[normalizedType].bookmarks += 1;
    }

    // Sort bookmarks within each group by timestamp
    Object.values(groupedByItem).forEach(group => {
      group.bookmarks.sort((a, b) => a.timestamp - b.timestamp);
    });

    const totalBookmarks = bookmarkEntries.length;
    const tabOrder: MediaTab[] = ['movie', 'tv', 'other'];
    let currentTab = normalizeMediaType(container.dataset.currentTab || 'movie');
    if (!typeCounts[currentTab] || typeCounts[currentTab].items === 0) {
      const fallback = tabOrder.find(t => typeCounts[t].items > 0);
      if (fallback) currentTab = fallback;
    }
    container.dataset.currentTab = currentTab;

    // Create UI
    container.innerHTML = `
      <div class="je-bookmarks-wrapper">
        <input type="search" class="je-bookmark-search je-input" aria-label="Search bookmarks" placeholder="Search bookmarks">
        <div class="je-bookmark-tabs">
          <button class="je-tab ${currentTab === 'movie' ? 'active' : ''}" data-tab="movie">
            ${JE.t('bookmarks_library_tab_movies')}
          </button>
          <button class="je-tab ${currentTab === 'tv' ? 'active' : ''}" data-tab="tv">
            ${JE.t('bookmarks_library_tab_series')}
          </button>
          <button class="je-tab ${currentTab === 'other' ? 'active' : ''}" data-tab="other">
            ${JE.t('bookmarks_library_tab_others')}
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

    const search = container.querySelector<HTMLInputElement>('.je-bookmark-search');
    const applySearch = () => {
      const text = search?.value.trim().toLocaleLowerCase() || '';
      container.querySelectorAll<HTMLElement>('.je-bookmark-item').forEach(card => {
        card.hidden = !((card.textContent || '').toLocaleLowerCase().includes(text));
      });
    };
    search?.addEventListener('input', applySearch);
    // Attach button handlers
    const findDuplicatesBtn = container.querySelector<HTMLButtonElement>('.btnFindDuplicates');
    const cleanupBtn = container.querySelector<HTMLButtonElement>('.btnCleanupBookmarks');
    const deleteAllBtn = container.querySelector<HTMLButtonElement>('.btnDeleteAllBookmarks');

    findDuplicatesBtn?.addEventListener('click', async () => {
      if (!isCurrent()) return;
      findDuplicatesBtn.disabled = true;
      const label = findDuplicatesBtn.querySelector<HTMLElement>('span:last-child');
      if (!label) return;
      const origText = label.innerHTML;
      label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      // Surface duplicate bookmark groups and offer merging
      showDuplicatesSyncModal(bookmarks);

      findDuplicatesBtn.disabled = false;
      label.innerHTML = origText;
    });

    cleanupBtn?.addEventListener('click', async () => {
      if (!isCurrent()) return;
      cleanupBtn.disabled = true;
      const label = cleanupBtn.querySelector<HTMLElement>('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        const result = await ctx.own.bookmarks.cleanupOrphaned();
        if (!isCurrent()) return;
        if (isCurrent()) JE.toast(JE.t('bookmark_cleanup_complete').replace('{count}', String(result.cleaned)), 4000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Cleanup failed:', error);
        if (isCurrent()) JE.toast(JE.t('bookmark_cleanup_failed'), 3000);
      } finally {
        cleanupBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    deleteAllBtn?.addEventListener('click', async () => {
      if (!isCurrent()) return;
      if (!confirm(JE.t('bookmark_delete_all_confirm'))) return;

      deleteAllBtn.disabled = true;
      const label = deleteAllBtn.querySelector<HTMLElement>('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        // Queued behind the user's other bookmark mutations; restores them if the save fails.
        if (!await ctx.own.bookmarks.deleteAll() || !isCurrent()) return;
        if (isCurrent()) JE.toast(JE.t('bookmark_deleted_all'), 3000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Delete failed:', error);
        if (isCurrent()) JE.toast(JE.t('bookmark_delete_failed'), 3000);
      } finally {
        deleteAllBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    // Render items with posters
    if (totalBookmarks > 0) {
      const itemsContainer = container.querySelector<HTMLElement>('#bookmarks-items-container');
      if (itemsContainer) {
        await renderBookmarkItems(itemsContainer, groupedByItem, currentTab);
        if (!isCurrent()) return;
        applySearch();

        // Tab click handlers
        container.querySelectorAll<HTMLButtonElement>('.je-tab').forEach(btn => {
          btn.addEventListener('click', async () => {
      if (!isCurrent()) return;
            const tab = normalizeMediaType(btn.dataset.tab);
            container.dataset.currentTab = tab;
            container.querySelectorAll<HTMLButtonElement>('.je-tab').forEach(b => {
              b.classList.toggle('active', b.dataset.tab === tab);
            });
            await renderBookmarkItems(itemsContainer, groupedByItem, tab);
            if (isCurrent()) applySearch();
          });
        });
      }
    }
  }

  /**
   * Format timestamp (seconds) to HH:MM:SS
   */


  function normalizeMediaType(mediaType: string | undefined): MediaTab {
    const type = (mediaType || '').toLowerCase();
    if (type === 'series' || type === 'episode' || type === 'tvshow' || type === 'tv') return 'tv';
    if (type === 'movie' || type === 'film') return 'movie';
    return 'other';
  }

  // Parse HH:MM:SS or MM:SS or seconds into numeric seconds
  Object.assign(internal, {
    renderIfSectionExists,
    hookViewEvents,
    renderBookmarksLibrary,
    formatTimestamp,
    parseTimestampInput,
  });

}
install(ctx.core);
