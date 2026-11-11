(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/bookmarks/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/bookmarks/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bookmarksHost");
  var export6 = /* @__PURE__ */ sharedExport(shared, "readItem");
  var export7 = /* @__PURE__ */ sharedExport(shared, "readItems");

  // client/src/features/bookmarks/dom.ts
  function required(root, selector) {
    const element = root.querySelector(selector);
    if (!element) throw new Error("Missing bookmark control: " + selector);
    return element;
  }

  // client/generated-shared/stub/client/src/features/bookmarks/lifetime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/bookmarks/lifetime");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "createLifetime");

  // client/src/features/bookmarks/library-replacements.ts
  var { ctx, host, getApi } = export1();
  function install(JE) {
    const lifetime = export0(ctx, "library-replacements");
    lifetime.listen(document, "viewshow", lifetime.cancelPending, true);
    const setTimeout = lifetime.timeout;
    const internal = ctx.own.bookmarksLibrary = ctx.own.bookmarksLibrary || {};
    if (!JE?.pluginConfig?.BookmarksEnabled) return;
    const renderBookmarksLibrary = (...args) => {
      const fn = internal.renderBookmarksLibrary;
      if (!fn) throw new Error("Missing bookmark module: renderBookmarksLibrary");
      return fn(...args);
    };
    const escapeHtml = JE.escapeHtml;
    async function searchForReplacementItem(tmdbId, tvdbId, mediaType, seasonNumber = null, episodeNumber = null) {
      const isCurrent = lifetime.current();
      const apiClient = getApi();
      if (!apiClient) return null;
      const userId = apiClient.getCurrentUserId();
      try {
        const episode = mediaType === "tv" && seasonNumber != null && episodeNumber != null;
        const itemTypes = episode ? "Episode" : mediaType === "tv" ? "Series,Episode" : mediaType === "movie" ? "Movie" : null;
        const position = episode ? `&ParentIndexNumber=${seasonNumber}&IndexNumber=${episodeNumber}` : "";
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        for (let start = 0; ; start += 500) {
          const url = `Items?userId=${encodeURIComponent(userId || "")}&Recursive=true${itemTypes ? `&IncludeItemTypes=${itemTypes}` : ""}${position}&Fields=ProviderIds&SortBy=DateCreated&SortOrder=Descending&Limit=500&StartIndex=${start}`;
          const response = await JE.core.api.fetch(apiClient.getUrl(url));
          if (!isCurrent()) return null;
          const batch = export7(response);
          const unseen = batch.filter((item) => !seen.has(item.Id));
          for (const item of unseen) {
            seen.add(item.Id);
            items.push(item);
          }
          if (batch.length < 500 || unseen.length === 0) break;
        }
        const matches = items.filter((item) => {
          const providerIds = item.ProviderIds || {};
          const userData = item.UserData || {};
          let providerMatch = false;
          if (tmdbId) {
            if (providerIds.Tmdb === String(tmdbId)) providerMatch = true;
            if (userData.Key === String(tmdbId)) providerMatch = true;
          }
          if (!providerMatch && tvdbId) {
            if (providerIds.Tvdb === String(tvdbId)) providerMatch = true;
          }
          if (!providerMatch) return false;
          if (episodeNumber != null) {
            return item.Type === "Episode" && item.ParentIndexNumber === seasonNumber && item.IndexNumber === episodeNumber;
          }
          return true;
        });
        console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Found ${matches.length} matches for ${tmdbId ? "TMDB:" + tmdbId : "TVDB:" + tvdbId}`, matches);
        return matches.length > 0 ? matches : null;
      } catch (e) {
        console.error("Failed to search for replacement:", e);
        return null;
      }
    }
    async function findAndOfferReplacement(group, triggerBtn) {
      const isCurrent = lifetime.current();
      triggerBtn.disabled = true;
      const matches = await searchForReplacementItem(
        group.details.tmdbId,
        group.details.tvdbId,
        group.details.mediaType,
        group.details.seasonNumber ?? null,
        group.details.episodeNumber ?? null
      );
      if (!isCurrent()) return;
      if (!matches || matches.length === 0) {
        if (isCurrent()) JE.toast(JE.t("bookmark_no_replacement"), 3e3);
        triggerBtn.disabled = false;
        return;
      }
      showReplacementSelectionModal(group, matches);
      triggerBtn.disabled = false;
    }
    function showReplacementSelectionModal(oldGroup, replacementItems) {
      const currentView = lifetime.current();
      const apiClient = getApi();
      if (!apiClient) return;
      const modal = document.createElement("div");
      const isCurrent = () => currentView() && modal.isConnected;
      modal.className = "je-bm-library-modal-overlay";
      modal.style.cssText = "position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;";
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
            <div class="je-modal-item-meta">TMDB: ${escapeHtml(oldGroup.details.tmdbId || "N/A")} • Item ID: ${escapeHtml(oldGroup.details.itemId.substring(0, 16))}...</div>
          </div>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options">
            ${replacementItems.map((item, idx) => {
        const posterUrl = apiClient.getImageUrl(item.Id, {
          type: "Primary",
          maxWidth: 120,
          tag: item.ImageTags?.Primary
        });
        return `
                <div class="replacement-option" data-item-index="${idx}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                  ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">` : '<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                  <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${escapeHtml(item.Name)}</div>
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${item.ProductionYear || ""}</div>
                    <div style="font-size: 11px; color: #888;">Item ID: ${escapeHtml(item.Id.substring(0, 16))}...</div>
                  </div>
                  <span class="material-icons" aria-hidden="true" style="color: #4caf50; font-size: 28px; display: none; flex-shrink: 0;">check_circle</span>
                </div>
              `;
      }).join("")}
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
      const closeDialog = lifetime.modal(modal);
      required(modal, ".je-bm-library-modal-close").addEventListener("click", closeDialog);
      required(modal, ".je-bookmark-btn-cancel").addEventListener("click", closeDialog);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeDialog();
      });
      modal.querySelectorAll(".replacement-option").forEach((option) => {
        option.addEventListener("click", () => {
          if (!isCurrent()) return;
          const idx = Number(option.dataset.itemIndex);
          selectedItem = replacementItems[idx] ?? null;
          modal.querySelectorAll(".replacement-option").forEach((opt) => {
            opt.style.borderColor = "rgba(76,175,80,0.2)";
            opt.style.background = "rgba(76,175,80,0.05)";
            required(opt, ".material-icons").style.display = "none";
          });
          option.style.borderColor = "#4caf50";
          option.style.background = "rgba(76,175,80,0.15)";
          required(option, ".material-icons").style.display = "block";
          const submitBtn = required(modal, ".je-bookmark-btn-submit");
          submitBtn.disabled = false;
          submitBtn.style.opacity = "1";
        });
      });
      required(modal, ".je-bookmark-btn-submit").addEventListener("click", async () => {
        if (!isCurrent()) return;
        if (!selectedItem) return;
        const btn = required(modal, ".je-bookmark-btn-submit");
        btn.disabled = true;
        required(btn, "span:last-child").textContent = "Migrating...";
        try {
          const userId = apiClient.getCurrentUserId();
          const fullItem = export6(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(selectedItem.Id, { userId }) : await apiClient.getItem(userId, selectedItem.Id));
          if (!isCurrent()) return;
          const newDetails = {
            itemId: fullItem.Id,
            tmdbId: fullItem.ProviderIds?.Tmdb || oldGroup.details.tmdbId,
            tvdbId: fullItem.ProviderIds?.Tvdb || oldGroup.details.tvdbId,
            mediaType: oldGroup.details.mediaType,
            name: fullItem.Name,
            seasonNumber: fullItem.Type === "Episode" ? fullItem.ParentIndexNumber ?? null : null,
            episodeNumber: fullItem.Type === "Episode" ? fullItem.IndexNumber ?? null : null
          };
          const synced = await ctx.own.bookmarks.syncBookmarks(oldGroup.bookmarks, newDetails, 0, { replaceOriginals: true });
          if (!isCurrent()) return;
          if (isCurrent()) JE.toast(JE.t("bookmark_migrated").replace("{count}", String(synced.length)).replace("{name}", () => escapeHtml(fullItem.Name || "")), 4e3);
          closeDialog();
          const container = document.querySelector(".sections.bookmarks");
          if (container) {
            setTimeout(() => renderBookmarksLibrary(container), 500);
          }
        } catch (e) {
          console.error("Migration failed:", e);
          if (isCurrent()) JE.toast(JE.t("bookmark_migration_failed"), 3e3);
          btn.disabled = false;
          required(btn, "span:last-child").textContent = JE.t("bookmark_migrate");
        }
      });
      setTimeout(() => modal.style.opacity = "1", 10);
    }
    Object.assign(internal, { findAndOfferReplacement });
  }
  install(ctx.core);
})();
})();
//# sourceMappingURL=bookmarks-library-replacements.js.map
