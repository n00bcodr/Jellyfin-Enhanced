// /js/enhanced/osd-rating.js
// Injects rating into the Jellyfin video OSD near the "Ends at" text
(function(JE) {
  'use strict';

  const logPrefix = '🪼 Jellyfin Enhanced: OSD Rating:';
  const CONTAINER_ID = 'je-osd-rating-container';

  function isEnabled() {
    // Controlled by server config; default true unless explicitly disabled
    return JE.pluginConfig?.ShowRatingInPlayer !== false;
  }

  function getCurrentItemId() {
    // Pull from the favorite button in the OSD
    const favBtn = document.querySelector('.videoOsdBottom .btnUserRating[data-id]');
    return favBtn?.dataset?.id || null;
  }

  async function fetchItemRating(userId, itemId) {
    try {
      const result = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: itemId, Fields: 'CommunityRating,CriticRating,Type' }),
        dataType: 'json'
      });
      const item = result?.Items?.[0];
      if (!item) return null;
      const rating = item.CommunityRating || item.CriticRating;
      return rating ? Number(rating).toFixed(1) : null;
    } catch (e) {
      console.warn(`${logPrefix} Failed to fetch rating for ${itemId}`, e);
      return null;
    }
  }

  function ensureStyles() {
    if (document.getElementById('je-osd-rating-style')) return;
    const style = document.createElement('style');
    style.id = 'je-osd-rating-style';
    style.textContent = `
      #${CONTAINER_ID} { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; vertical-align: middle; }
      #${CONTAINER_ID} .je-star { font-family: 'Material Icons'; font-size: 16px; color: #ffc107; line-height: 1; }
      #${CONTAINER_ID} .je-text { font-size: 14px; color: inherit; font-weight: 600; line-height: 1; }
    `;
    document.head.appendChild(style);
  }

  function injectRating(osdRoot, rating) {
    if (!osdRoot || !rating) return;
    ensureStyles();

    const osdTimeContainer = osdRoot.querySelector('.osdTimeText');
    if (!osdTimeContainer) return;

    // Remove any existing instances to prevent duplicates
    osdRoot.querySelectorAll(`#${CONTAINER_ID}`).forEach(el => el.remove());

    const container = document.createElement('span');
    container.id = CONTAINER_ID;

    const star = document.createElement('span');
    star.className = 'je-star';
    star.textContent = 'star';

    const text = document.createElement('span');
    text.className = 'je-text';
    text.textContent = rating;

    container.appendChild(star);
    container.appendChild(text);

    // Place before the time text
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

    const rating = await fetchItemRating(userId, itemId);
    if (rating) injectRating(osdRoot, rating);
  }

  function observeOsd() {
    const observer = new MutationObserver(() => {
      if (JE.isVideoPage()) updateOsdRating();
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
