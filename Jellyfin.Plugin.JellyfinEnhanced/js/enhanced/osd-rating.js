// /js/enhanced/osd-rating.js
// Injects rating into the Jellyfin video OSD near the "Ends at" text
(function(JE) {
  'use strict';

  const logPrefix = '🪼 Jellyfin Enhanced: OSD Rating:';
  const CONTAINER_ID = 'je-osd-rating-container';
  // Hot cache (per session) so each item is fetched once
  const ratingCache = new Map();
  const pendingRatings = new Map();
  let scheduledUpdate = null;

  function isEnabled() {
    // Controlled by server config; default true unless explicitly disabled
    return JE.pluginConfig?.ShowRatingInPlayer !== false;
  }

  function normalizeCriticPercent(raw) {
    if (raw === null || raw === undefined) return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    const percent = num <= 10 ? Math.round(num * 10) : Math.round(num);
    return Math.max(0, Math.min(100, percent));
  }

  function createTomatoIcon(isRotten) {
    const span = document.createElement('span');
    span.className = `je-tomato ${isRotten ? 'rotten' : 'fresh'}`;
    return span;
  }

  function getCurrentItemId() {
    // Pull from the favorite button in the OSD
    const favBtn = document.querySelector('.videoOsdBottom .btnUserRating[data-id]');
    return favBtn?.dataset?.id || null;
  }

  async function fetchItemRatings(userId, itemId) {
    try {
      const result = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: itemId, Fields: 'CommunityRating,CriticRating,Type' }),
        dataType: 'json'
      });
      const item = result?.Items?.[0];
      if (!item) return { tmdb: null, critic: null };

      let sourceItem = item;
      if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId && !item.CommunityRating && !item.CriticRating) {
        try {
          const seriesResult = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: item.SeriesId, Fields: 'CommunityRating,CriticRating,Type' }),
            dataType: 'json'
          });
          sourceItem = seriesResult?.Items?.[0] || item;
        } catch (e) {
          console.warn(`${logPrefix} Failed to fetch series rating for ${item.Type}`, e);
        }
      }

      const tmdb = sourceItem.CommunityRating != null ? Number(sourceItem.CommunityRating).toFixed(1) : null;
      const critic = normalizeCriticPercent(sourceItem.CriticRating);

      return { tmdb, critic };
    } catch (e) {
      console.warn(`${logPrefix} Failed to fetch rating for ${itemId}`, e);
      return { tmdb: null, critic: null };
    }
  }

  function ensureStyles() {
    if (document.getElementById('je-osd-rating-style')) return;
    const style = document.createElement('style');
    style.id = 'je-osd-rating-style';
    style.textContent = `
      #${CONTAINER_ID} { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; vertical-align: middle; }
      #${CONTAINER_ID} .je-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font-weight: 600; line-height: 1; }
      #${CONTAINER_ID} .je-chip.tmdb { color: #ffc107; }
      #${CONTAINER_ID} .je-chip.critic { color: #ffffff; }
      #${CONTAINER_ID} .je-star { font-family: 'Material Icons'; font-size: 16px; color: #ffc107; line-height: 1; }
      #${CONTAINER_ID} .je-text { font-size: 14px; color: inherit; font-weight: 600; line-height: 1; }
      #${CONTAINER_ID} .je-tomato { width: 16px; height: 16px; flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
      #${CONTAINER_ID} .je-tomato.fresh { background-image: url(assets/img/fresh.svg); }
      #${CONTAINER_ID} .je-tomato.rotten { background-image: url(assets/img/rotten.svg); }
    `;
    document.head.appendChild(style);
  }

  function injectRating(osdRoot, rating) {
    if (!osdRoot || (!rating.tmdb && rating.critic === null)) return;
    ensureStyles();

    const osdTimeContainer = osdRoot.querySelector('.osdTimeText');
    if (!osdTimeContainer) return;

    osdRoot.querySelectorAll(`#${CONTAINER_ID}`).forEach(el => el.remove());

    const container = document.createElement('span');
    container.id = CONTAINER_ID;

    if (rating.critic !== null) {
      const criticChip = document.createElement('span');
      criticChip.className = 'je-chip critic';
      criticChip.appendChild(createTomatoIcon(rating.critic < 60));

      const criticText = document.createElement('span');
      criticText.className = 'je-text';
      criticText.textContent = `${rating.critic}%`;

      criticChip.appendChild(criticText);
      container.appendChild(criticChip);
    }

    if (rating.tmdb) {
      const tmdbChip = document.createElement('span');
      tmdbChip.className = 'je-chip tmdb';

      const star = document.createElement('span');
      star.className = 'je-star';
      star.textContent = 'star';

      const text = document.createElement('span');
      text.className = 'je-text';
      text.textContent = rating.tmdb;

      tmdbChip.appendChild(star);
      tmdbChip.appendChild(text);
      container.appendChild(tmdbChip);
    }

    if (container.children.length === 0) return;
    osdTimeContainer.insertAdjacentElement('beforebegin', container);
  }

  async function updateOsdRating() {
    if (!isEnabled()) {
      console.debug(`${logPrefix} Skipped - feature disabled`);
      return;
    }
    if (!JE.isVideoPage()) {
      return;
    }
    const osdRoot = document.querySelector('.videoOsdBottom');
    if (!osdRoot) return;

    if (osdRoot.querySelector(`#${CONTAINER_ID}`)) return;

    const userId = ApiClient.getCurrentUserId?.();
    const itemId = getCurrentItemId();
    if (!userId || !itemId) return;

    // Serve from cache if available (including null-rating to avoid refetch loops)
    if (ratingCache.has(itemId)) {
      const cached = ratingCache.get(itemId);
      if (cached && (cached.tmdb || cached.critic !== null)) injectRating(osdRoot, cached);
      return;
    }

    // Reuse in-flight fetch
    if (pendingRatings.has(itemId)) {
      const rating = await pendingRatings.get(itemId);
      if (rating && (rating.tmdb || rating.critic !== null)) injectRating(osdRoot, rating);
      return;
    }

    const promise = (async () => {
      const rating = await fetchItemRatings(userId, itemId);
      ratingCache.set(itemId, rating);
      return rating;
    })();

    pendingRatings.set(itemId, promise);

    try {
      const rating = await promise;
      if (rating && (rating.tmdb || rating.critic !== null)) injectRating(osdRoot, rating);
    } finally {
      pendingRatings.delete(itemId);
    }
  }

  function scheduleUpdate() {
    if (scheduledUpdate) return;
    scheduledUpdate = setTimeout(() => {
      scheduledUpdate = null;
      if (JE.isVideoPage()) updateOsdRating();
    }, 200);
  }

  function observeOsd() {
    const observer = new MutationObserver(() => {
      scheduleUpdate();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  JE.initializeOsdRating = function() {
    if (!isEnabled()) {
      console.log(`${logPrefix} Feature is disabled in settings.`);
      return;
    }
    try {
      observeOsd();
      console.log(`${logPrefix} Initialized successfully.`);
    } catch (e) { console.warn(`${logPrefix} Init failed`, e); }
  };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
