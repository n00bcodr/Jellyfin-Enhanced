(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
  function getApi() {
    const api = browser.ApiClient;
    if (!api) throw new Error("Hidden Content API unavailable");
    return api;
  }
  function registry(JE, name) {
    const internals = JE.internals ?? (JE.internals = {});
    if (name === "features") return internals.features ?? (internals.features = {});
    if (name === "hiddenContentPage") return internals.hiddenContentPage ?? (internals.hiddenContentPage = {});
    const surface = internals.hiddenContent ?? (internals.hiddenContent = {});
    return new Proxy(surface, { get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const value = Reflect.get(target, key);
      if (value === void 0) throw new Error(`Missing hidden-content loader dependency: ${key}`);
      return value;
    } });
  }
  function hiddenContentContext(JE) {
    return featureContext("hidden-content", JE, {
      internalSlots: ["hiddenContent", "hiddenContentPage", "hiddenContentRuntime", "features"],
      // Same expression as registry() and runtime() below.
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
  }
  function runtime(JE) {
    const internals = JE.internals ?? (JE.internals = {});
    if (internals.hiddenContentRuntime) return internals.hiddenContentRuntime;
    const state = { modules: /* @__PURE__ */ new Set(), view: 0, policy: 0, queues: /* @__PURE__ */ new Map(), cleanups: /* @__PURE__ */ new Set(), identityCleanups: /* @__PURE__ */ new Set() };
    internals.hiddenContentRuntime = state;
    const invalidate = () => {
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    window.addEventListener("hashchange", invalidate);
    window.addEventListener("popstate", invalidate);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", invalidateIdentity);
    JE.session?.onUserChange("hidden-content-runtime", invalidateIdentity);
    return state;
  }
  function installOnce(JE, name) {
    const modules = runtime(JE).modules;
    if (modules.has(name)) return false;
    modules.add(name);
    return true;
  }
  function lease(JE, view = false) {
    JE.session?.checkNow?.("hidden-content-operation");
    const state = runtime(JE), version = state.view, api = getApi();
    const epoch = JE.session?.getEpoch(), userId = api.getCurrentUserId(), root = api.getUrl("/"), token = api.accessToken?.(), route = location.hash;
    return { api, destination: JSON.stringify([root, userId]), current: () => {
      try {
        return browser.ApiClient === api && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && api.getCurrentUserId() === userId && api.getUrl("/") === root && api.accessToken?.() === token && (!view || location.hash === route && state.view === version);
      } catch {
        return false;
      }
    } };
  }
  function selectionLease(JE, checkEditing = true) {
    const token = lease(JE, true), state = registry(JE, "hiddenContentPage").state;
    const version = state.adminLoadToken, uid = state.selectedAdminUserId, editing = state.adminEditMode;
    return { current: () => token.current() && state.adminLoadToken === version && state.selectedAdminUserId === uid && (!checkEditing || state.adminEditMode === editing) };
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export4 = /* @__PURE__ */ sharedExport(shared, "decodeSeerrItem");
  var export5 = /* @__PURE__ */ sharedExport(shared, "decodeSeerrSearch");

  // client/src/features/hidden-content/hidden-content-page-cards.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-cards")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const featureCtx = hiddenContentContext(JE);
    const {
      scopeBadgeText,
      scopeUnhideText,
      showUnhideConfirmation,
      handleUnhide,
      handleUnhideMany,
      POSTER_MAX_WIDTH
    } = internal;
    const UNHIDE_FADE_DELAY_MS = 200;
    function formatEpisodeLabel(item) {
      const parts = [];
      if (item.seasonNumber != null && item.episodeNumber != null) {
        const s = String(item.seasonNumber).padStart(2, "0");
        const e = String(item.episodeNumber).padStart(2, "0");
        parts.push(`S${s}E${e}`);
      } else if (item.seasonNumber != null) {
        parts.push(JE.t("hidden_content_season_label", { number: item.seasonNumber }));
      }
      if (item.name) parts.push(item.name);
      return parts.join(" – ") || item.name || JE.t("hidden_content_unknown_show");
    }
    function createGroupPoster(group, tmdbId) {
      const imageToken = lease(JE, true);
      const hasJellyfinId = !!group.seriesId;
      const hasTmdbId = !!tmdbId;
      const posterLink = document.createElement("a");
      posterLink.className = "je-hidden-group-poster-link";
      if (hasJellyfinId) {
        posterLink.href = `#/details?id=${group.seriesId}`;
      } else if (hasTmdbId) {
        posterLink.href = "#";
      }
      const img = document.createElement("img");
      img.className = "je-hidden-group-poster";
      const fallbackPosterPath = group.items[0]?.posterPath;
      if (hasJellyfinId) {
        img.src = `${getApi().getUrl("/Items/" + group.seriesId + "/Images/Primary", { maxWidth: POSTER_MAX_WIDTH })}`;
        img.onerror = function() {
          var self = img;
          if (hasTmdbId && featureCtx.peer("jellyseerrMoreInfo")) {
            posterLink.dataset.jellyfinRemoved = "1";
          }
          if (hasTmdbId && fallbackPosterPath) {
            self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
            self.onerror = function() {
              img.style.display = "none";
            };
          } else if (hasTmdbId && featureCtx.peer("jellyseerrAPI")) {
            self.onerror = function() {
              img.style.display = "none";
            };
            var mainItem = group.items[0];
            var mediaType = mainItem && mainItem.type === "Series" ? "tv" : "movie";
            var fetchFn = mediaType === "tv" ? featureCtx.peer("jellyseerrAPI").fetchTvShowDetails : featureCtx.peer("jellyseerrAPI").fetchMovieDetails;
            fetchFn(parseInt(tmdbId, 10)).then(export4).then(function(details) {
              if (!imageToken.current() || !img.isConnected) return;
              var path = details && (details.posterPath || details.poster_path);
              if (path) {
                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
              } else {
                self.style.display = "none";
              }
            }).catch(function() {
              self.style.display = "none";
            });
          } else if (group.seriesName && featureCtx.peer("jellyseerrAPI") && featureCtx.peer("jellyseerrMoreInfo")) {
            self.style.display = "none";
            featureCtx.peer("jellyseerrAPI").search(group.seriesName).then(export5).then(function(res) {
              if (!imageToken.current() || !img.isConnected) return;
              var results = res && res.results || [];
              var hit = results.find(function(r) {
                return r.mediaType === "tv";
              }) || results[0];
              if (hit && hit.id) {
                posterLink.dataset.jellyfinRemoved = "1";
                posterLink.dataset.resolvedTmdbId = String(hit.id);
                posterLink.dataset.resolvedMediaType = hit.mediaType || "tv";
                posterLink.href = "#";
                var p = hit.posterPath || hit.poster_path;
                if (p) {
                  self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                  self.style.display = "";
                  self.onerror = function() {
                    img.style.display = "none";
                  };
                }
              }
            }).catch(function() {
            });
          } else {
            self.style.display = "none";
          }
        };
      } else if (fallbackPosterPath) {
        img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
        img.onerror = function() {
          img.style.display = "none";
        };
      } else if (group.items[0]?.itemId) {
        img.src = `${getApi().getUrl("/Items/" + group.items[0].itemId + "/Images/Primary", { maxWidth: POSTER_MAX_WIDTH })}`;
        img.onerror = function() {
          img.style.display = "none";
        };
      }
      img.alt = "";
      img.loading = "lazy";
      posterLink.appendChild(img);
      return posterLink;
    }
    function createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId) {
      const hasJellyfinId = !!group.seriesId;
      const hasTmdbId = !!tmdbId;
      const info = document.createElement("div");
      info.className = "je-hidden-group-info";
      const nameEl = hasJellyfinId || hasTmdbId ? document.createElement("a") : document.createElement("div");
      nameEl.className = "je-hidden-group-name";
      nameEl.textContent = group.seriesName || JE.t("hidden_content_unknown_show");
      nameEl.title = group.seriesName || "";
      if (hasJellyfinId) {
        nameEl.href = `#/details?id=${group.seriesId}`;
        nameEl.style.color = "#fff";
        nameEl.style.textDecoration = "none";
      } else if (hasTmdbId) {
        nameEl.href = "#";
        nameEl.style.color = "#fff";
        nameEl.style.textDecoration = "none";
      }
      info.appendChild(nameEl);
      const meta = document.createElement("div");
      meta.className = "je-hidden-group-meta";
      if (totalItems === 1 && !hasEpisodes) {
        const hiddenDate = mainItem.hiddenAt ? new Date(mainItem.hiddenAt).toLocaleDateString() : "";
        meta.textContent = ["Series", hiddenDate].filter(Boolean).join(" · ");
      } else if (totalItems === 1) {
        meta.textContent = JE.t("hidden_content_1_hidden_item");
      } else {
        meta.textContent = JE.t("hidden_content_n_hidden_items", { count: totalItems });
      }
      info.appendChild(meta);
      return { info, nameEl };
    }
    function createSingleItemDisplay(group, mainItem, hasEpisodes) {
      const selection = selectionLease(JE);
      const fragment = document.createDocumentFragment();
      if (hasEpisodes) {
        const detailDiv = document.createElement("div");
        detailDiv.style.cssText = "padding: 0 10px; font-size: 12px; color: rgba(255,255,255,0.7);";
        const label = document.createElement("a");
        label.className = "je-hidden-group-item-label";
        label.textContent = formatEpisodeLabel(mainItem);
        label.title = mainItem.name || "";
        if (mainItem.itemId) {
          label.href = `#/details?id=${mainItem.itemId}`;
          label.style.color = "inherit";
          label.style.textDecoration = "none";
        }
        detailDiv.appendChild(label);
        if (mainItem.hideScope && mainItem.hideScope !== "global") {
          const badge = document.createElement("span");
          badge.className = "je-hidden-scoped-badge";
          badge.style.marginTop = "2px";
          badge.style.display = "inline-block";
          badge.textContent = scopeBadgeText(mainItem.hideScope);
          detailDiv.appendChild(badge);
        }
        fragment.appendChild(detailDiv);
      }
      const unhideBtn = document.createElement("button");
      unhideBtn.className = "je-hidden-group-unhide";
      unhideBtn.textContent = scopeUnhideText(mainItem.hideScope);
      unhideBtn.addEventListener("click", () => {
        const itemLabel = hasEpisodes ? (group.seriesName || "") + " – " + formatEpisodeLabel(mainItem) : group.seriesName || mainItem.name || "this item";
        showUnhideConfirmation(JE.t("hidden_content_unhide_confirm") || "Unhide this item?", () => {
          unhideBtn.closest(".je-hidden-group-card").style.opacity = "0.3";
          setTimeout(() => {
            if (!selection.current()) return;
            handleUnhide(mainItem._key || mainItem.itemId || "");
          }, UNHIDE_FADE_DELAY_MS);
        }, itemLabel);
      });
      fragment.appendChild(unhideBtn);
      return fragment;
    }
    function createExpandableItemsList(group, displayItems, totalItems) {
      const selection = selectionLease(JE);
      const fragment = document.createDocumentFragment();
      const expandBtn = document.createElement("button");
      expandBtn.className = "je-hidden-group-expand";
      const expandLabel = document.createElement("span");
      expandLabel.textContent = totalItems === 1 ? JE.t("hidden_content_1_hidden_item") : JE.t("hidden_content_n_hidden_items", { count: totalItems });
      const expandIcon = document.createElement("span");
      expandIcon.className = "material-icons";
      expandIcon.setAttribute("aria-hidden", "true");
      expandIcon.textContent = "expand_more";
      expandBtn.appendChild(expandLabel);
      expandBtn.appendChild(expandIcon);
      fragment.appendChild(expandBtn);
      const itemsList = document.createElement("div");
      itemsList.className = "je-hidden-group-items";
      for (const item of displayItems) {
        const row = document.createElement("div");
        row.className = "je-hidden-group-item";
        const infoCol = document.createElement("div");
        infoCol.className = "je-hidden-group-item-info";
        const label = document.createElement("a");
        label.className = "je-hidden-group-item-label";
        label.textContent = item._label;
        label.title = item.name || "";
        if (item.itemId) {
          label.href = `#/details?id=${item.itemId}`;
          label.style.color = "inherit";
          label.style.textDecoration = "none";
        }
        infoCol.appendChild(label);
        if (item.hideScope && item.hideScope !== "global") {
          const badge = document.createElement("span");
          badge.className = "je-hidden-scoped-badge";
          badge.textContent = scopeBadgeText(item.hideScope);
          infoCol.appendChild(badge);
        }
        row.appendChild(infoCol);
        const unhideBtn = document.createElement("button");
        unhideBtn.className = "je-hidden-group-item-unhide";
        unhideBtn.textContent = scopeUnhideText(item.hideScope);
        unhideBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const rowLabel = (group.seriesName || "") + " – " + formatEpisodeLabel(item);
          showUnhideConfirmation(JE.t("hidden_content_unhide_confirm") || "Unhide this item?", () => {
            row.style.opacity = "0.3";
            setTimeout(() => {
              if (!selection.current()) return;
              handleUnhide(item._key || item.itemId || "");
            }, UNHIDE_FADE_DELAY_MS);
          }, rowLabel);
        });
        row.appendChild(unhideBtn);
        itemsList.appendChild(row);
      }
      fragment.appendChild(itemsList);
      const unhideAllBtn = document.createElement("button");
      unhideAllBtn.className = "je-hidden-group-unhide-all";
      unhideAllBtn.textContent = JE.t("hidden_content_unhide_all_show");
      unhideAllBtn.addEventListener("click", () => {
        showUnhideConfirmation(JE.t("hidden_content_unhide_all_confirm") || "Unhide all items for this show?", () => {
          handleUnhideMany(group.items.map((item) => item._key || item.itemId || ""));
        }, group.seriesName || "this show");
      });
      fragment.appendChild(unhideAllBtn);
      expandBtn.addEventListener("click", () => {
        const isExpanded = itemsList.classList.toggle("expanded");
        expandBtn.classList.toggle("expanded", isExpanded);
        unhideAllBtn.classList.toggle("expanded", isExpanded);
      });
      return fragment;
    }
    function createGroupCard(group) {
      const card = document.createElement("div");
      card.className = "je-hidden-group-card";
      const seriesItems = group.items.filter((i) => i.type === "Series");
      const episodeItems = group.items.filter((i) => i.type !== "Series");
      const hasEpisodes = episodeItems.length > 0;
      const mainItem = seriesItems[0] || group.items[0];
      const totalItems = group.items.length;
      if (!mainItem) return card;
      const tmdbId = String(mainItem.tmdbId || "");
      const hasJellyfinId = !!group.seriesId;
      const hasTmdbId = !!tmdbId;
      card.appendChild(createGroupPoster(group, tmdbId));
      const { info, nameEl } = createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId);
      card.appendChild(info);
      if (featureCtx.peer("jellyseerrMoreInfo")) {
        const posterLink = card.querySelector(".je-hidden-group-poster-link");
        const baseMediaType = mainItem.type === "Series" ? "tv" : "movie";
        const openJellyseerr = (e) => {
          const id = tmdbId || posterLink && posterLink.dataset.resolvedTmdbId;
          if (!id) return;
          const mediaType = tmdbId ? baseMediaType : posterLink?.dataset.resolvedMediaType || "tv";
          if (e) e.preventDefault();
          featureCtx.peer("jellyseerrMoreInfo")?.open(parseInt(id, 10), mediaType);
        };
        if (posterLink) {
          if (hasTmdbId && !hasJellyfinId) {
            posterLink.addEventListener("click", openJellyseerr);
            if (nameEl) nameEl.addEventListener("click", openJellyseerr);
          } else {
            const guarded = (e) => {
              if (posterLink.dataset.jellyfinRemoved === "1") openJellyseerr(e);
            };
            posterLink.addEventListener("click", guarded);
            if (nameEl) nameEl.addEventListener("click", guarded);
          }
        }
      }
      if (totalItems === 1) {
        card.appendChild(createSingleItemDisplay(group, mainItem, hasEpisodes));
        return card;
      }
      const displayItems = [];
      for (const item of seriesItems) {
        displayItems.push({ ...item, _label: JE.t("hidden_content_entire_show") });
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
    function createSection(titleKey, content, options = {}) {
      const section = document.createElement("div");
      section.className = "je-hidden-group-section";
      if (options.expandable) {
        const header = document.createElement("div");
        header.className = "je-hidden-section-header";
        const titleEl = document.createElement("div");
        titleEl.className = "je-hidden-section-header-title";
        titleEl.textContent = JE.t(titleKey);
        header.appendChild(titleEl);
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "je-hidden-expand-all-btn";
        toggleBtn.textContent = JE.t("hidden_content_expand_all");
        let allExpanded = false;
        toggleBtn.addEventListener("click", () => {
          allExpanded = !allExpanded;
          toggleBtn.textContent = allExpanded ? JE.t("hidden_content_collapse_all") : JE.t("hidden_content_expand_all");
          const cards = content.querySelectorAll(".je-hidden-group-card");
          cards.forEach((card) => {
            const items = card.querySelector(".je-hidden-group-items");
            const btn = card.querySelector(".je-hidden-group-expand");
            const unhideAll = card.querySelector(".je-hidden-group-unhide-all");
            if (items) items.classList.toggle("expanded", allExpanded);
            if (btn) btn.classList.toggle("expanded", allExpanded);
            if (unhideAll) unhideAll.classList.toggle("expanded", allExpanded);
          });
        });
        header.appendChild(toggleBtn);
        section.appendChild(header);
      } else {
        const titleEl = document.createElement("div");
        titleEl.className = "je-hidden-group-section-title";
        titleEl.textContent = JE.t(titleKey);
        section.appendChild(titleEl);
      }
      section.appendChild(content);
      return section;
    }
    Object.assign(internal, { createGroupCard, createSection });
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-cards.js.map
