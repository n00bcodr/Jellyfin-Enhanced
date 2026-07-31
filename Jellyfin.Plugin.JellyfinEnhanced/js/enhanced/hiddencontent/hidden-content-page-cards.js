/**
 * @file Hidden Content Page — grouped show cards: posters, episode lists,
 * expand/collapse, per-item unhide, and section containers.
 * Split from hidden-content-page.js (code motion; bodies verbatim).
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const internal = JE.internals.hiddenContentPage = JE.internals.hiddenContentPage || {};

  const { scopeBadgeText, scopeUnhideText, showUnhideConfirmation,
    handleUnhide, handleUnhideMany, POSTER_MAX_WIDTH } = internal;

  /** Delay before removing a card after unhide animation. */
  const UNHIDE_FADE_DELAY_MS = 200;

  // ============================================================
  // Rendering Functions
  // ============================================================

  /**
   * Creates a formatted episode/season label.
   * @param {Object} item Hidden content item.
   * @returns {string} Formatted label like "S02E05 - Episode Title".
   */
  function formatEpisodeLabel(item) {
    const parts = [];
    if (item.seasonNumber != null && item.episodeNumber != null) {
      const s = String(item.seasonNumber).padStart(2, '0');
      const e = String(item.episodeNumber).padStart(2, '0');
      parts.push(`S${s}E${e}`);
    } else if (item.seasonNumber != null) {
      parts.push(JE.t('hidden_content_season_label', { number: item.seasonNumber }));
    }
    if (item.name) parts.push(item.name);
    return parts.join(' \u2013 ') || item.name || JE.t('hidden_content_unknown_show');
  }

  /**
   * Creates the poster element for a group card.
   * @param {Object} group The show group data.
   * @param {string} tmdbId The TMDB ID for fallback poster lookup.
   * @returns {HTMLElement} The poster link element.
   */
  function createGroupPoster(group, tmdbId) {
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    const posterLink = document.createElement('a');
    posterLink.className = 'je-hidden-group-poster-link';
    if (hasJellyfinId) {
      posterLink.href = `#/details?id=${group.seriesId}`;
    } else if (hasTmdbId) {
      posterLink.href = '#';
    }

    const img = document.createElement('img');
    img.className = 'je-hidden-group-poster';
    const fallbackPosterPath = group.items[0]?.posterPath;
    if (hasJellyfinId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.seriesId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
      img.onerror = function() {
        var self = this;
        // Signal the card that Jellyfin item is gone
        if (hasTmdbId && JE.jellyseerrMoreInfo) {
          posterLink.dataset.jellyfinRemoved = '1';
        }
        // Item removed from Jellyfin — fall back to TMDB poster
        if (hasTmdbId && fallbackPosterPath) {
          self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
          self.onerror = function() { this.style.display = 'none'; };
        } else if (hasTmdbId && JE.jellyseerrAPI) {
          // No posterPath stored — fetch it from Jellyseerr
          self.onerror = function() { this.style.display = 'none'; };
          var mainItem = group.items[0];
          var mediaType = (mainItem && mainItem.type === 'Series') ? 'tv' : 'movie';
          var fetchFn = mediaType === 'tv'
              ? JE.jellyseerrAPI.fetchTvShowDetails
              : JE.jellyseerrAPI.fetchMovieDetails;
          fetchFn(parseInt(tmdbId, 10)).then(function(details) {
            var path = details && (details.posterPath || details.poster_path);
            if (path) {
              self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
            } else {
              self.style.display = 'none';
            }
          }).catch(function() { self.style.display = 'none'; });
        } else if (group.seriesName && JE.jellyseerrAPI && JE.jellyseerrMoreInfo) {
          // No TMDB id stored (e.g. an episode hidden from Next Up) and the Jellyfin media is gone.
          // Resolve the show via a Seerr search by name so the card can still open the more-info
          // modal — instead of leaving a blank poster and a dead "#/details" link.
          self.style.display = 'none';
          JE.jellyseerrAPI.search(group.seriesName).then(function(res) {
            var results = (res && res.results) || [];
            var hit = results.find(function(r) { return r.mediaType === 'tv'; }) || results[0];
            if (hit && hit.id) {
              posterLink.dataset.jellyfinRemoved = '1';
              posterLink.dataset.resolvedTmdbId = String(hit.id);
              posterLink.dataset.resolvedMediaType = hit.mediaType || 'tv';
              posterLink.href = '#';
              var p = hit.posterPath || hit.poster_path;
              if (p) {
                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                self.style.display = '';
                self.onerror = function() { this.style.display = 'none'; };
              }
            }
          }).catch(function() {});
        } else {
          self.style.display = 'none';
        }
      };
    } else if (fallbackPosterPath) {
      img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
      img.onerror = function() { this.style.display = 'none'; };
    } else if (group.items[0]?.itemId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.items[0].itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
      img.onerror = function() { this.style.display = 'none'; };
    }
    img.alt = '';
    img.loading = 'lazy';
    posterLink.appendChild(img);
    return posterLink;
  }

  /**
   * Creates the info section (name + meta) for a group card.
   * @param {Object} group The show group data.
   * @param {Object} mainItem The primary item in the group.
   * @param {number} totalItems Total count of items in the group.
   * @param {boolean} hasEpisodes Whether the group contains episode items.
   * @param {string} tmdbId The TMDB ID for navigation.
   * @returns {HTMLElement} The info container element.
   */
  function createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId) {
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    const info = document.createElement('div');
    info.className = 'je-hidden-group-info';

    const nameEl = (hasJellyfinId || hasTmdbId)
      ? document.createElement('a')
      : document.createElement('div');
    nameEl.className = 'je-hidden-group-name';
    nameEl.textContent = group.seriesName || JE.t('hidden_content_unknown_show');
    nameEl.title = group.seriesName || '';
    if (hasJellyfinId) {
      nameEl.href = `#/details?id=${group.seriesId}`;
      nameEl.style.color = '#fff';
      nameEl.style.textDecoration = 'none';
    } else if (hasTmdbId) {
      nameEl.href = '#';
      nameEl.style.color = '#fff';
      nameEl.style.textDecoration = 'none';
    }
    info.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'je-hidden-group-meta';
    if (totalItems === 1 && !hasEpisodes) {
      const hiddenDate = mainItem.hiddenAt ? new Date(mainItem.hiddenAt).toLocaleDateString() : '';
      meta.textContent = ['Series', hiddenDate].filter(Boolean).join(' \u00B7 ');
    } else if (totalItems === 1) {
      meta.textContent = JE.t('hidden_content_1_hidden_item');
    } else {
      meta.textContent = JE.t('hidden_content_n_hidden_items', { count: totalItems });
    }
    info.appendChild(meta);

    return { info, nameEl };
  }

  /**
   * Creates a single-item display (inline detail + unhide button) for a group card
   * that contains only one item.
   * @param {Object} group The show group data.
   * @param {Object} mainItem The single item in the group.
   * @param {boolean} hasEpisodes Whether the item is an episode/season.
   * @returns {HTMLElement} A document fragment with the detail and unhide button.
   */
  function createSingleItemDisplay(group, mainItem, hasEpisodes) {
    const fragment = document.createDocumentFragment();

    if (hasEpisodes) {
      const detailDiv = document.createElement('div');
      detailDiv.style.cssText = 'padding: 0 10px; font-size: 12px; color: rgba(255,255,255,0.7);';

      const label = document.createElement('a');
      label.className = 'je-hidden-group-item-label';
      label.textContent = formatEpisodeLabel(mainItem);
      label.title = mainItem.name || '';
      if (mainItem.itemId) {
        label.href = `#/details?id=${mainItem.itemId}`;
        label.style.color = 'inherit';
        label.style.textDecoration = 'none';
      }
      detailDiv.appendChild(label);

      if (mainItem.hideScope && mainItem.hideScope !== 'global') {
        const badge = document.createElement('span');
        badge.className = 'je-hidden-scoped-badge';
        badge.style.marginTop = '2px';
        badge.style.display = 'inline-block';
        badge.textContent = scopeBadgeText(mainItem.hideScope);
        detailDiv.appendChild(badge);
      }
      fragment.appendChild(detailDiv);
    }

    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'je-hidden-group-unhide';
    unhideBtn.textContent = scopeUnhideText(mainItem.hideScope);
    unhideBtn.addEventListener('click', () => {
      const itemLabel = hasEpisodes
        ? (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(mainItem)
        : (group.seriesName || mainItem.name || 'this item');
      showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
        unhideBtn.closest('.je-hidden-group-card').style.opacity = '0.3';
        setTimeout(() => {
          handleUnhide(mainItem._key || mainItem.itemId);
        }, UNHIDE_FADE_DELAY_MS);
      }, itemLabel);
    });
    fragment.appendChild(unhideBtn);

    return fragment;
  }

  /**
   * Creates an expandable list of items with individual unhide buttons,
   * plus an "Unhide All" button for the entire group.
   * @param {Object} group The show group data.
   * @param {Array} displayItems Sorted array of items with `_label` attached.
   * @param {number} totalItems Total count for the expand button label.
   * @returns {HTMLElement} A document fragment containing expand button, items list, and unhide-all.
   */
  function createExpandableItemsList(group, displayItems, totalItems) {
    const fragment = document.createDocumentFragment();

    // Expand/collapse button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'je-hidden-group-expand';
    const expandLabel = document.createElement('span');
    expandLabel.textContent = totalItems === 1
      ? JE.t('hidden_content_1_hidden_item')
      : JE.t('hidden_content_n_hidden_items', { count: totalItems });
    const expandIcon = document.createElement('span');
    expandIcon.className = 'material-icons';
    expandIcon.setAttribute('aria-hidden', 'true');
    expandIcon.textContent = 'expand_more';
    expandBtn.appendChild(expandLabel);
    expandBtn.appendChild(expandIcon);
    fragment.appendChild(expandBtn);

    // Expandable items list (hidden by default)
    const itemsList = document.createElement('div');
    itemsList.className = 'je-hidden-group-items';

    for (const item of displayItems) {
      const row = document.createElement('div');
      row.className = 'je-hidden-group-item';

      const infoCol = document.createElement('div');
      infoCol.className = 'je-hidden-group-item-info';

      const label = document.createElement('a');
      label.className = 'je-hidden-group-item-label';
      label.textContent = item._label;
      label.title = item.name || '';
      if (item.itemId) {
        label.href = `#/details?id=${item.itemId}`;
        label.style.color = 'inherit';
        label.style.textDecoration = 'none';
      }
      infoCol.appendChild(label);

      if (item.hideScope && item.hideScope !== 'global') {
        const badge = document.createElement('span');
        badge.className = 'je-hidden-scoped-badge';
        badge.textContent = scopeBadgeText(item.hideScope);
        infoCol.appendChild(badge);
      }

      row.appendChild(infoCol);

      const unhideBtn = document.createElement('button');
      unhideBtn.className = 'je-hidden-group-item-unhide';
      unhideBtn.textContent = scopeUnhideText(item.hideScope);
      unhideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const rowLabel = (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(item);
        showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
          row.style.opacity = '0.3';
          setTimeout(() => {
            handleUnhide(item._key || item.itemId);
          }, UNHIDE_FADE_DELAY_MS);
        }, rowLabel);
      });
      row.appendChild(unhideBtn);
      itemsList.appendChild(row);
    }

    fragment.appendChild(itemsList);

    // "Unhide All" button (hidden until expanded)
    const unhideAllBtn = document.createElement('button');
    unhideAllBtn.className = 'je-hidden-group-unhide-all';
    unhideAllBtn.textContent = JE.t('hidden_content_unhide_all_show');
    unhideAllBtn.addEventListener('click', () => {
      showUnhideConfirmation(JE.t('hidden_content_unhide_all_confirm') || 'Unhide all items for this show?', () => {
        handleUnhideMany(group.items.map((item) => item._key || item.itemId));
      }, group.seriesName || 'this show');
    });
    fragment.appendChild(unhideAllBtn);

    // Toggle expand/collapse
    expandBtn.addEventListener('click', () => {
      const isExpanded = itemsList.classList.toggle('expanded');
      expandBtn.classList.toggle('expanded', isExpanded);
      unhideAllBtn.classList.toggle('expanded', isExpanded);
    });

    return fragment;
  }

  /**
   * Creates a grouped card for a show with hidden items (episodes, seasons, or the whole series).
   * @param {Object} group Object with `seriesName`, `seriesId`, and `items` array.
   * @returns {HTMLElement} The group card element.
   */
  function createGroupCard(group) {
    const card = document.createElement('div');
    card.className = 'je-hidden-group-card';

    const seriesItems = group.items.filter(i => i.type === 'Series');
    const episodeItems = group.items.filter(i => i.type !== 'Series');
    const hasEpisodes = episodeItems.length > 0;
    const mainItem = seriesItems[0] || group.items[0];
    const totalItems = group.items.length;
    const tmdbId = mainItem.tmdbId || '';
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    // Poster
    card.appendChild(createGroupPoster(group, tmdbId));

    // Info section
    const { info, nameEl } = createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId);
    card.appendChild(info);

    // Seerr navigation: open the more-info modal when the item has no Jellyfin page (no
    // Jellyfin id) or its Jellyfin media has been deleted. The TMDB id is either stored on the item,
    // or — for an orphan episode whose show is gone — resolved at render time by createGroupPoster
    // and stashed on the poster link's dataset.
    if (JE.jellyseerrMoreInfo) {
      const posterLink = card.querySelector('.je-hidden-group-poster-link');
      const baseMediaType = mainItem.type === 'Series' ? 'tv' : 'movie';
      const openJellyseerr = (e) => {
        const id = tmdbId || (posterLink && posterLink.dataset.resolvedTmdbId);
        if (!id) return;
        const mediaType = tmdbId ? baseMediaType : (posterLink.dataset.resolvedMediaType || 'tv');
        if (e) e.preventDefault();
        JE.jellyseerrMoreInfo.open(parseInt(id, 10), mediaType);
      };
      if (posterLink) {
        if (hasTmdbId && !hasJellyfinId) {
          // No Jellyfin page at all → always open Seerr.
          posterLink.addEventListener('click', openJellyseerr);
          if (nameEl) nameEl.addEventListener('click', openJellyseerr);
        } else {
          // Has a Jellyfin page (or an orphan episode) → divert to Seerr only once the Jellyfin
          // media is gone (createGroupPoster sets data-jellyfin-removed on image failure).
          const guarded = (e) => { if (posterLink.dataset.jellyfinRemoved === '1') openJellyseerr(e); };
          posterLink.addEventListener('click', guarded);
          if (nameEl) nameEl.addEventListener('click', guarded);
        }
      }
    }

    // Single item: inline detail + unhide
    if (totalItems === 1) {
      card.appendChild(createSingleItemDisplay(group, mainItem, hasEpisodes));
      return card;
    }

    // Multi-item: expandable list
    const displayItems = [];
    for (const item of seriesItems) {
      displayItems.push({ ...item, _label: JE.t('hidden_content_entire_show') });
    }
    const sortedEpisodes = [...episodeItems].sort((a, b) => {
      const sa = a.seasonNumber ?? 999;
      const sb = b.seasonNumber ?? 999;
      if (sa !== sb) return sa - sb;
      return (a.episodeNumber ?? 999) - (b.episodeNumber ?? 999);
    });
    for (const item of sortedEpisodes) {
      displayItems.push({ ...item, _label: formatEpisodeLabel(item) });
    }

    card.appendChild(createExpandableItemsList(group, displayItems, totalItems));

    return card;
  }

  /**
   * Creates a section container with a title and optional expand/collapse toggle.
   * @param {string} titleKey Translation key for the section title.
   * @param {HTMLElement} content Content element.
   * @param {Object} [options] Options.
   * @param {boolean} [options.expandable] If true, adds an expand/collapse all button.
   * @returns {HTMLElement} The section element.
   */
  function createSection(titleKey, content, options = {}) {
    const section = document.createElement('div');
    section.className = 'je-hidden-group-section';

    if (options.expandable) {
      const header = document.createElement('div');
      header.className = 'je-hidden-section-header';

      const titleEl = document.createElement('div');
      titleEl.className = 'je-hidden-section-header-title';
      titleEl.textContent = JE.t(titleKey);
      header.appendChild(titleEl);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'je-hidden-expand-all-btn';
      toggleBtn.textContent = JE.t('hidden_content_expand_all');
      let allExpanded = false;

      toggleBtn.addEventListener('click', () => {
        allExpanded = !allExpanded;
        toggleBtn.textContent = allExpanded
          ? JE.t('hidden_content_collapse_all')
          : JE.t('hidden_content_expand_all');
        const cards = content.querySelectorAll('.je-hidden-group-card');
        cards.forEach((card) => {
          const items = card.querySelector('.je-hidden-group-items');
          const btn = card.querySelector('.je-hidden-group-expand');
          const unhideAll = card.querySelector('.je-hidden-group-unhide-all');
          if (items) items.classList.toggle('expanded', allExpanded);
          if (btn) btn.classList.toggle('expanded', allExpanded);
          if (unhideAll) unhideAll.classList.toggle('expanded', allExpanded);
        });
      });
      header.appendChild(toggleBtn);
      section.appendChild(header);
    } else {
      const titleEl = document.createElement('div');
      titleEl.className = 'je-hidden-group-section-title';
      titleEl.textContent = JE.t(titleKey);
      section.appendChild(titleEl);
    }

    section.appendChild(content);
    return section;
  }

  Object.assign(internal, { createGroupCard, createSection });

})();
