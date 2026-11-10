(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  function apiClient() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }
  function taskScheduler() {
    const host = window;
    return typeof host.scheduler?.postTask === "function" ? host.scheduler : null;
  }
  var detailsContexts = /* @__PURE__ */ new WeakMap();
  function seerrDetailsContext(JE2) {
    let ctx = detailsContexts.get(JE2);
    if (!ctx) {
      ctx = featureContext("seerr", JE2, {
        internalSlots: ["moreInfoModal"],
        internalsObject: () => JE2.internals ?? (JE2.internals = {})
      });
      detailsContexts.set(JE2, ctx);
    }
    return ctx;
  }
  function translator(JE2) {
    return (key, fallback = "", params) => {
      const text = params ? JE2.t?.(key, params) : JE2.t?.(key);
      return text || fallback;
    };
  }
  function identityLease(JE2) {
    const epoch = JE2.session?.getEpoch?.();
    return () => epoch === void 0 || typeof JE2.session?.isCurrent !== "function" || JE2.session.isCurrent(epoch);
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }
  function str(value) {
    return typeof value === "string" ? value : void 0;
  }
  function filled(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function records(value) {
    return list(value).filter(isRecord);
  }
  function idText(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return filled(value);
  }

  // client/src/features/seerr/details/domain/media.ts
  function tmdbIdOf(details) {
    return num(details.id) ?? idText(details.id) ?? "";
  }
  function anyTitle(details) {
    return filled(details.title) ?? filled(details.name) ?? "";
  }

  // client/src/features/seerr/details/domain/links.ts
  function detailsHref(itemId) {
    return `#!/details?id=${encodeURIComponent(itemId)}`;
  }

  // client/src/features/seerr/details/details-page/rows.ts
  var logPrefix = `${SEERR_LOG} Seerr Item Details:`;
  var PENDING_ROWS_CLASS = "je-seerr-rows-pending";
  var NAME_WAIT_MS = 5e3;
  var PREBUILD_SLICE_MS = 8;
  var NON_RENDERED_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META"]);
  function findDetailPage() {
    const activePage = document.querySelector(".libraryPage:not(.hide)");
    if (!activePage) return null;
    const detailPageContent = activePage.querySelector(".detailPageContent") ?? activePage.querySelector(".detailPageSecondaryContainer") ?? activePage;
    const moreLikeThisSection = detailPageContent.querySelector("#similarCollapsible");
    return moreLikeThisSection ? { detailPageContent, moreLikeThisSection } : null;
  }
  function detailsItemIdFromHash() {
    const hash = window.location.hash;
    if (!hash.includes("/details?id=")) return null;
    return new URLSearchParams(hash.split("?")[1]).get("id");
  }
  var jellyfinMediaIdOf = (item) => filled(record(record(item)?.mediaInfo)?.jellyfinMediaId);
  function sameItems(first, second) {
    return first.length === second.length && first.every((item, index) => item === second[index]);
  }
  function afterPaint(fn) {
    let waiting = true;
    let frame = null;
    let timer;
    const stop = () => {
      waiting = false;
      document.removeEventListener("visibilitychange", onHidden);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const queue = () => {
      if (!waiting) return;
      stop();
      timer = window.setTimeout(fn, 0);
    };
    const onHidden = () => {
      if (document.hidden) queue();
    };
    if (document.hidden) {
      queue();
    } else {
      document.addEventListener("visibilitychange", onHidden);
      frame = requestAnimationFrame(() => {
        frame = null;
        queue();
      });
    }
    return () => {
      stop();
      clearTimeout(timer);
    };
  }
  function whenIdle(fn) {
    const sliced = () => {
      const end = performance.now() + PREBUILD_SLICE_MS;
      fn({ timeRemaining: () => Math.max(0, end - performance.now()) });
    };
    const scheduler = taskScheduler();
    if (scheduler) {
      const controller = new AbortController();
      scheduler.postTask(sliced, { priority: "background", signal: controller.signal }).catch(() => {
      });
      return () => controller.abort();
    }
    if (typeof requestIdleCallback === "function") {
      const id2 = requestIdleCallback(fn);
      return () => cancelIdleCallback(id2);
    }
    const id = window.setTimeout(sliced, 0);
    return () => clearTimeout(id);
  }
  function createDetailRows(JE2, processedItems2, schedule) {
    const t2 = translator(JE2);
    let waitingRows = null;
    const viewItems = /* @__PURE__ */ new WeakMap();
    const leftMarkers = /* @__PURE__ */ new WeakSet();
    function sectionResults(results) {
      if (results.length === 0) return [];
      let filtered = results;
      if (JE2.pluginConfig?.JellyseerrExcludeLibraryItems === true) filtered = results.filter((item) => !jellyfinMediaIdOf(item));
      const hiddenContent = seerrDetailsContext(JE2).peer("hiddenContent");
      if (hiddenContent) filtered = hiddenContent.filterJellyseerrResults(filtered, "recommendations");
      return filtered;
    }
    function createSectionShell(title) {
      const section = document.createElement("div");
      section.className = "verticalSection emby-scroller-container jellyseerr-details-section";
      section.setAttribute("data-jellyseerr-section", "true");
      const titleElement = document.createElement("h2");
      titleElement.className = "sectionTitle sectionTitle-cards focuscontainer-x padded-right";
      titleElement.textContent = title || "Recommended";
      section.appendChild(titleElement);
      const scroller = document.createElement("div");
      scroller.setAttribute("is", "emby-scroller");
      scroller.className = "padded-top-focusscale padded-bottom-focusscale no-padding emby-scroller";
      scroller.dataset.horizontal = "true";
      scroller.dataset.centerfocus = "card";
      scroller.dataset.scrollModeX = "custom";
      scroller.style.scrollSnapType = "none";
      scroller.style.touchAction = "auto";
      scroller.style.overscrollBehaviorX = "contain";
      scroller.style.overscrollBehaviorY = "auto";
      scroller.style.setProperty("-webkit-overflow-scrolling", "touch");
      const itemsContainer = document.createElement("div");
      itemsContainer.setAttribute("is", "emby-itemscontainer");
      itemsContainer.className = "focuscontainer-x itemsContainer scrollSlider animatedScrollX";
      itemsContainer.style.whiteSpace = "nowrap";
      scroller.appendChild(itemsContainer);
      section.appendChild(scroller);
      return { section, itemsContainer };
    }
    function createSectionCard(item) {
      const card = JE2.jellyseerrUI?.createJellyseerrCard ? JE2.jellyseerrUI.createJellyseerrCard(item, true, true) : null;
      if (!card) return card;
      const titleLink = card.querySelector(".cardText-first a");
      const jellyfinMediaId = jellyfinMediaIdOf(item);
      if (jellyfinMediaId) {
        card.setAttribute("data-library-item", "true");
        card.setAttribute("data-jellyfin-media-id", jellyfinMediaId);
        card.classList.add("jellyseerr-card-in-library");
        if (titleLink) {
          const media = record(item);
          const name = str(media?.title) || str(media?.name) || "";
          titleLink.textContent = name;
          titleLink.title = name;
          titleLink.href = detailsHref(jellyfinMediaId);
          titleLink.removeAttribute("target");
          titleLink.removeAttribute("rel");
        }
      }
      return card;
    }
    function createJellyseerrSection(results, title) {
      const filtered = sectionResults(results);
      if (filtered.length === 0) return null;
      const { section, itemsContainer } = createSectionShell(title);
      const fragment = document.createDocumentFragment();
      for (const item of filtered) {
        const card = createSectionCard(item);
        if (card) fragment.appendChild(card);
      }
      itemsContainer.appendChild(fragment);
      return section;
    }
    const jellyfinRendered = (page) => !!page.querySelector(".nameContainer .itemName");
    function nothingFollows(anchor, page) {
      for (let node = anchor; node !== page; node = node.parentElement) {
        if (!node) return false;
        for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
          if (next.classList.contains(PENDING_ROWS_CLASS)) continue;
          if (node === anchor && next.tagName === "DIV") return false;
          if (NON_RENDERED_TAGS.has(next.tagName) || next instanceof HTMLElement && next.hidden || next.classList.contains("hide")) continue;
          return false;
        }
      }
      return true;
    }
    function releaseClaim({ itemId, signal }) {
      if (!signal.aborted) processedItems2.delete(itemId);
    }
    function noteViewItem(rawEvent) {
      if (!(rawEvent instanceof CustomEvent)) return;
      const view = rawEvent.target;
      const itemId = filled(record(record(rawEvent.detail)?.params)?.id);
      if (itemId && view instanceof Element) viewItems.set(view, itemId);
    }
    function shownForOther(page, itemId) {
      const shownFor = page ? viewItems.get(page) : void 0;
      return shownFor !== void 0 && shownFor !== itemId;
    }
    function canDeferRows(run) {
      const { page, detailPageContent, anchor } = run;
      if (!page || !page.isConnected || page.classList.contains("hide") || !page.querySelector(".nameContainer")) return false;
      if (detailPageContent.querySelector(".jellyseerr-details-section")) return false;
      if (jellyfinRendered(page)) return false;
      return nothingFollows(anchor, page);
    }
    function commitRows(run, marker) {
      const { itemId, signal, sameAccount, page, anchor } = run;
      if (signal.aborted) return false;
      if (detailsItemIdFromHash() !== itemId) return false;
      if (!sameAccount()) {
        releaseClaim(run);
        return false;
      }
      if (page ? !page.isConnected || page.classList.contains("hide") : !anchor.isConnected) {
        const shown = findDetailPage();
        const shownPage = shown ? shown.moreLikeThisSection.closest(".libraryPage") : null;
        if (shown && shownPage && shownPage !== page) {
          if (placeRows({ ...run, page: shownPage, detailPageContent: shown.detailPageContent, anchor: shown.moreLikeThisSection })) return true;
          releaseClaim(run);
          return false;
        }
        releaseClaim(run);
        const visible = document.querySelector(".libraryPage:not(.hide)");
        if (visible && visible !== page) schedule(itemId);
        return false;
      }
      insertRows(run, marker);
      return true;
    }
    function removeMarkers(page, root, itemId, keep = null) {
      const own = !!page && viewItems.get(page) === itemId;
      root.querySelectorAll(`.${PENDING_ROWS_CLASS}`).forEach((element) => {
        if (element === keep) return;
        if (element.dataset.itemId === itemId || own && leftMarkers.has(element)) element.remove();
      });
    }
    function commitLeftRows(run, marker) {
      if (!run.page.isConnected || !marker.isConnected || !run.sameAccount()) return;
      if (shownForOther(run.page, run.itemId)) return;
      insertRows(run, marker);
    }
    function rowSpecs({ recommended, similar }) {
      const rows2 = [];
      if (recommended.length > 0) rows2.push({ name: "Recommended", results: recommended.slice(0, 20), title: t2("jellyseerr_recommended_title", "Recommended"), total: recommended.length });
      if (similar.length > 0) rows2.push({ name: "Similar", results: similar.slice(0, 20), title: t2("jellyseerr_similar_title", "Similar"), total: similar.length });
      return rows2;
    }
    function rowSection(run, row) {
      const prebuilt = run.prebuilt?.take(row);
      return prebuilt ? prebuilt.section : createJellyseerrSection(row.results, row.title);
    }
    function insertRows(run, marker) {
      const { itemId, page, detailPageContent, anchor } = run;
      removeMarkers(page, detailPageContent, itemId, marker);
      JE2.jellyseerrUI?.releasePosters?.(detailPageContent);
      detailPageContent.querySelectorAll(".jellyseerr-details-section").forEach((element) => element.remove());
      const before = marker?.isConnected ? marker : null;
      for (const row of rowSpecs(run)) {
        const section = rowSection(run, row);
        if (!section) continue;
        if (before) {
          before.before(section);
        } else if (row.name === "Similar") {
          const last = detailPageContent.querySelector(".jellyseerr-details-section:last-of-type");
          if (last) last.after(section);
          else anchor.after(section);
        } else {
          anchor.after(section);
        }
        console.debug(`${logPrefix} Added ${row.name} section with ${row.total} items`);
      }
    }
    function prebuildRows(run) {
      if (typeof IntersectionObserver !== "function") return null;
      const holder = document.createDocumentFragment();
      const rows2 = rowSpecs(run).map((row) => ({ ...row, filtered: null, key: void 0, section: null, itemsContainer: null, built: 0, taken: false }));
      const inputsKey = (items) => JE2.jellyseerrUI?.cardInputsKey?.(items);
      let usable = true;
      let next = 0;
      let cancelStep = null;
      const release = () => {
        usable = false;
        cancelStep?.();
        cancelStep = null;
        if (!holder.firstChild) return;
        JE2.jellyseerrUI?.releasePosters?.(holder);
        holder.replaceChildren();
      };
      const buildCard = (row) => {
        const item = row.filtered?.[row.built++];
        const card = createSectionCard(item);
        if (card) row.itemsContainer?.appendChild(card);
      };
      const buildNext = () => {
        const row = rows2[next];
        if (!row) return false;
        if (!row.filtered) {
          row.filtered = sectionResults(row.results);
          row.key = inputsKey(row.filtered);
          if (row.filtered.length > 0) {
            const shell = createSectionShell(row.title);
            row.section = shell.section;
            row.itemsContainer = shell.itemsContainer;
            holder.appendChild(shell.section);
          }
        } else {
          buildCard(row);
        }
        if (row.built === row.filtered.length) next++;
        return true;
      };
      const step = (deadline) => {
        cancelStep = null;
        if (!usable) return;
        try {
          if (!run.sameAccount() || rows2.some((row) => row.filtered && inputsKey(row.filtered) !== row.key)) {
            release();
            return;
          }
          do {
            if (!buildNext()) return;
          } while (deadline.timeRemaining() > 0);
        } catch {
          release();
          return;
        }
        cancelStep = whenIdle(step);
      };
      const take = (spec) => {
        const row = usable ? rows2.find((entry) => entry.name === spec.name) : void 0;
        if (!row || row.taken || !row.filtered || row.title !== spec.title || !sameItems(row.results, spec.results)) return null;
        const filtered = sectionResults(spec.results);
        if (!sameItems(row.filtered, filtered) || inputsKey(filtered) !== row.key) return null;
        while (row.built < row.filtered.length) buildCard(row);
        row.taken = true;
        const { section } = row;
        section?.remove();
        return { section };
      };
      cancelStep = whenIdle(step);
      return { take, release };
    }
    function deferRows(run) {
      const { itemId, signal, page, anchor } = run;
      const marker = document.createElement("div");
      marker.className = PENDING_ROWS_CLASS;
      marker.dataset.itemId = itemId;
      marker.setAttribute("aria-hidden", "true");
      let done = false;
      let left = false;
      let nameObserver = null;
      let nameTimer;
      let cancelPaint = null;
      let prebuilt = null;
      const movedOn = () => !left && (!page.isConnected || page.classList.contains("hide")) && detailsItemIdFromHash() === itemId && !!findDetailPage();
      const waiting = { itemId, retarget: () => {
        if (movedOn()) buildNow();
      } };
      const detach = () => {
        signal.removeEventListener("abort", onAbort);
        if (waitingRows === waiting) waitingRows = null;
      };
      const dispose = () => {
        done = true;
        nameObserver?.disconnect();
        clearTimeout(nameTimer);
        cancelPaint?.();
        window.removeEventListener("beforeprint", buildNow);
        detach();
      };
      const drop = () => {
        dispose();
        marker.remove();
        prebuilt?.release();
      };
      function onAbort() {
        if (page.isConnected && run.sameAccount() && !shownForOther(page, itemId)) {
          left = true;
          leftMarkers.add(marker);
          detach();
          return;
        }
        drop();
      }
      function buildNow() {
        if (done) return;
        dispose();
        try {
          if (left) commitLeftRows(run, marker);
          else commitRows(run, marker);
        } catch (error) {
          releaseClaim(run);
          console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
        } finally {
          marker.remove();
          prebuilt?.release();
        }
      }
      try {
        removeMarkers(page, page, itemId);
        anchor.after(marker);
        signal.addEventListener("abort", onAbort, { once: true });
        window.addEventListener("beforeprint", buildNow);
        const observer = new MutationObserver(() => {
          if (!jellyfinRendered(page) && !movedOn()) return;
          observer.disconnect();
          cancelPaint = afterPaint(buildNow);
        });
        nameObserver = observer;
        const nameContainer = page.querySelector(".nameContainer");
        if (!nameContainer) throw new Error("Name container gone");
        observer.observe(nameContainer, { childList: true, subtree: true });
        observer.observe(page, { attributes: true, attributeFilter: ["class"] });
        nameTimer = window.setTimeout(buildNow, NAME_WAIT_MS);
        waitingRows = waiting;
      } catch {
        drop();
        let placed = false;
        try {
          placed = commitRows(run, null);
        } finally {
          if (!placed) releaseClaim(run);
        }
        return placed;
      }
      try {
        prebuilt = prebuildRows(run);
      } catch {
      }
      run.prebuilt = prebuilt;
      return true;
    }
    function placeRows(run) {
      if (canDeferRows(run)) {
        processedItems2.add(run.itemId);
        return deferRows(run);
      }
      const placed = commitRows(run, null);
      if (placed) processedItems2.add(run.itemId);
      return placed;
    }
    return {
      placeRows,
      noteViewItem,
      shownForOther,
      /** Rows still waiting on a view Jellyfin has left go to the shown one now. */
      retargetWaiting(itemId) {
        if (waitingRows?.itemId === itemId) waitingRows.retarget();
      },
      newRun(itemId, signal, found) {
        const { detailPageContent, moreLikeThisSection } = found.page;
        return {
          itemId,
          signal,
          sameAccount: found.sameAccount,
          page: moreLikeThisSection.closest(".libraryPage"),
          detailPageContent,
          anchor: moreLikeThisSection,
          recommended: found.recommended,
          similar: found.similar
        };
      }
    };
  }

  // client/src/features/seerr/details/details-page/item-details-entry.ts
  var JE = bridge();
  var t = translator(JE);
  var logPrefix2 = `${SEERR_LOG} Seerr Item Details:`;
  var requestMoreLogPrefix = `${SEERR_LOG} Series Request More:`;
  var REQUEST_MORE_BTN_CLASS = "je-series-request-more-btn";
  var processedItems = /* @__PURE__ */ new Set();
  var processedRequestMoreItems = /* @__PURE__ */ new Set();
  var requestMoreInFlight = /* @__PURE__ */ new Map();
  var currentAbortController = null;
  var requestMoreAbortController = null;
  var rows = createDetailRows(JE, processedItems, scheduleSimilarAndRecommended);
  function abortError() {
    return new DOMException("Aborted", "AbortError");
  }
  function isAbort(error) {
    return record(error)?.name === "AbortError" || error instanceof DOMException && error.name === "AbortError";
  }
  async function getTmdbIdFromItem(itemId, signal) {
    const none = { tmdbId: null, type: null };
    try {
      if (signal.aborted) throw abortError();
      const client = apiClient();
      const userId = client.getCurrentUserId() ?? "";
      const item = record(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId, { userId }) : await client.getItem(userId, itemId));
      if (signal.aborted) throw abortError();
      if (!item) {
        console.warn(`${logPrefix2} Item not found:`, itemId);
        return none;
      }
      if (item.Type !== "Movie" && item.Type !== "Series") return none;
      const tmdbId = idText(record(item.ProviderIds)?.Tmdb);
      if (!tmdbId) {
        console.warn(`${logPrefix2} No TMDB ID found for item:`, str(item.Name));
        return none;
      }
      return { tmdbId: parseInt(tmdbId, 10), type: item.Type === "Movie" ? "movie" : "tv" };
    } catch (error) {
      if (isAbort(error)) throw error;
      console.error(`${logPrefix2} Error getting TMDB ID:`, error);
      return none;
    }
  }
  function waitForDetailPageReady(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const immediate = findDetailPage();
      if (immediate) {
        resolve(immediate);
        return;
      }
      let subscription = null;
      let timer;
      const cleanup2 = () => {
        subscription?.unsubscribe();
        subscription = null;
        clearTimeout(timer);
      };
      signal.addEventListener("abort", () => {
        cleanup2();
        resolve(null);
      }, { once: true });
      subscription = JE.helpers?.onBodyMutation?.("jellyseerr-item-details-page-detect", () => {
        const found = findDetailPage();
        if (found) {
          cleanup2();
          resolve(found);
        }
      });
      timer = window.setTimeout(() => {
        cleanup2();
        resolve(findDetailPage());
      }, 3e3);
    });
  }
  function scheduleSimilarAndRecommended(itemId) {
    requestAnimationFrame(() => {
      if (detailsItemIdFromHash() === itemId) void renderSimilarAndRecommended(itemId);
    });
  }
  async function renderSimilarAndRecommended(itemId) {
    if (processedItems.has(itemId)) {
      rows.retargetWaiting(itemId);
      return;
    }
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    const { signal } = controller;
    const sameAccount = identityLease(JE);
    const metrics = JE.requestManager;
    if (metrics?.metrics?.enabled) metrics.startMeasurement?.("similar-recommended");
    try {
      const showSimilar = JE.pluginConfig?.JellyseerrShowSimilar === true;
      const showRecommended = JE.pluginConfig?.JellyseerrShowRecommended === true;
      if (!showSimilar && !showRecommended) {
        console.debug(`${logPrefix2} Both similar and recommended sections are disabled in settings`);
        return;
      }
      const api = JE.jellyseerrAPI;
      if (!api) return;
      const status = record(await api.checkUserStatus());
      if (signal.aborted) return;
      if (!status?.active) {
        console.debug(`${logPrefix2} Jellyseerr is not active, skipping`);
        return;
      }
      const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
      if (signal.aborted) return;
      if (!tmdbId || !type) {
        console.debug(`${logPrefix2} No valid TMDB ID found for item, skipping`);
        return;
      }
      console.debug(`${logPrefix2} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);
      const options = { signal };
      const empty = Promise.resolve({ results: [] });
      const [similarData, recommendedData, pageReady] = await Promise.all([
        showSimilar ? type === "movie" ? api.fetchSimilarMovies(tmdbId, options) : api.fetchSimilarTvShows(tmdbId, options) : empty,
        showRecommended ? type === "movie" ? api.fetchRecommendedMovies(tmdbId, options) : api.fetchRecommendedTvShows(tmdbId, options) : empty,
        waitForDetailPageReady(signal)
      ]);
      if (signal.aborted) return;
      const similarResults = records(record(similarData)?.results);
      const recommendedResults = records(record(recommendedData)?.results);
      if (similarResults.length === 0 && recommendedResults.length === 0) {
        console.debug(`${logPrefix2} No similar or recommended content to display`);
        return;
      }
      if (!pageReady) {
        console.warn(`${logPrefix2} Page not ready for insertion`);
        return;
      }
      const excludeLibrary = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
      const excludeBlocklisted = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;
      const blocked = JE.seerrStatus?.MEDIA.BLOCKED;
      const keep = (item) => {
        const info = record(record(item)?.mediaInfo);
        if (excludeLibrary && filled(info?.jellyfinMediaId)) return false;
        return !(excludeBlocklisted && blocked !== void 0 && info?.status === blocked);
      };
      const similar = similarResults.filter(keep);
      const recommended = recommendedResults.filter(keep);
      if (similar.length === 0 && recommended.length === 0) {
        console.debug(`${logPrefix2} No content to display after filtering library items`);
        return;
      }
      if (signal.aborted) return;
      const placed = rows.placeRows(rows.newRun(itemId, signal, { page: pageReady, recommended, similar, sameAccount }));
      if (placed && metrics?.metrics?.enabled) metrics.endMeasurement?.("similar-recommended");
    } catch (error) {
      if (isAbort(error)) {
        console.debug(`${logPrefix2} Request aborted for item ${itemId}`);
        return;
      }
      console.error(`${logPrefix2} Error rendering similar and recommended sections:`, error);
    }
  }
  function pollUntil(predicate, signal, intervalMs, timeoutMs) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const immediate = predicate();
      if (immediate) {
        resolve(immediate);
        return;
      }
      const deadline = Date.now() + timeoutMs;
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      signal.addEventListener("abort", onAbort, { once: true });
      const tick = () => {
        if (signal.aborted) {
          finish(null);
          return;
        }
        const result = predicate();
        if (result) {
          finish(result);
          return;
        }
        if (Date.now() >= deadline) {
          finish(null);
          return;
        }
        timer = window.setTimeout(tick, intervalMs);
      };
      timer = window.setTimeout(tick, intervalMs);
    });
  }
  function waitForSeasonsHeading(itemId, signal) {
    return pollUntil(() => {
      const activePage = document.querySelector(".libraryPage:not(.hide)");
      if (!activePage || rows.shownForOther(activePage, itemId)) return null;
      const collapsible = activePage.querySelector("#listChildrenCollapsible");
      if (!collapsible || collapsible.classList.contains("hide")) return null;
      const heading = collapsible.querySelector("h2.sectionTitle.sectionTitle-cards");
      if (!heading || heading.classList.contains("hide")) return null;
      return heading.querySelector("span")?.textContent?.trim() ? heading : null;
    }, signal, 100, 5e3);
  }
  function waitForChecker(signal) {
    return pollUntil(() => {
      const check = JE.jellyseerrMoreInfo?.checkForUnrequestedSeasons;
      return typeof check === "function" ? check : null;
    }, signal, 50, 3e3);
  }
  function buildSeriesRequestMoreButton(tvDetails, stale) {
    const label = t("jellyseerr_btn_request_more", "Request More");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `jellyseerr-request-button jellyseerr-button-request ${REQUEST_MORE_BTN_CLASS}`;
    button.title = label;
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.verticalAlign = "middle";
    button.style.fontSize = "0.85rem";
    button.style.padding = "0.4em 0.9em";
    button.style.marginLeft = "1em";
    const icon = document.createElement("span");
    icon.className = "material-icons";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "download";
    icon.style.marginRight = "0.4em";
    icon.style.fontSize = "1.1em";
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (stale()) return;
      JE.jellyseerrUI?.showSeasonSelectionModal?.(tmdbIdOf(tvDetails), "tv", filled(tvDetails.name) ?? anyTitle(tvDetails), tvDetails);
    });
    return button;
  }
  async function runSeriesRequestMoreCheck(itemId) {
    requestMoreAbortController?.abort();
    const controller = new AbortController();
    requestMoreAbortController = controller;
    const { signal } = controller;
    const sameAccount = identityLease(JE);
    const stale = () => signal.aborted || !sameAccount();
    try {
      if (!JE.pluginConfig?.JellyseerrEnabled || JE.pluginConfig.JellyseerrShowRequestMoreOnSeries === false) return;
      const api = JE.jellyseerrAPI;
      if (!api) return;
      const status = record(await api.checkUserStatus());
      if (stale() || !status?.active) return;
      const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
      if (stale() || !tmdbId || type !== "tv") return;
      const tvDetails = await api.fetchTvShowDetails(tmdbId);
      if (stale() || !isRecord(tvDetails)) return;
      const checker = await waitForChecker(signal);
      if (stale()) return;
      if (!checker) {
        console.warn(`${requestMoreLogPrefix} checkForUnrequestedSeasons unavailable after 3s, skipping`);
        return;
      }
      const hasUnrequested = await checker(tvDetails, signal);
      if (stale()) return;
      const name = filled(tvDetails.name) ?? anyTitle(tvDetails);
      if (!hasUnrequested) {
        processedRequestMoreItems.add(itemId);
        console.debug(`${requestMoreLogPrefix} No unrequested seasons for "${name}"`);
        return;
      }
      const heading = await waitForSeasonsHeading(itemId, signal);
      if (stale()) return;
      if (!heading) {
        console.debug(`${requestMoreLogPrefix} Seasons heading not found, skipping`);
        return;
      }
      if (heading.querySelector(`.${REQUEST_MORE_BTN_CLASS}`)) {
        processedRequestMoreItems.add(itemId);
        return;
      }
      heading.classList.add("je-series-request-more-heading");
      heading.appendChild(buildSeriesRequestMoreButton(tvDetails, () => !sameAccount()));
      processedRequestMoreItems.add(itemId);
      console.debug(`${requestMoreLogPrefix} Added Request More button for "${name}"`);
    } catch (error) {
      if (isAbort(error)) {
        console.debug(`${requestMoreLogPrefix} Aborted for item ${itemId}`);
        return;
      }
      console.error(`${requestMoreLogPrefix} Error rendering button:`, error);
    }
  }
  function renderSeriesRequestMoreButton(itemId) {
    if (processedRequestMoreItems.has(itemId)) return Promise.resolve();
    const inFlight = requestMoreInFlight.get(itemId);
    if (inFlight) return inFlight;
    const run = runSeriesRequestMoreCheck(itemId).finally(() => {
      if (requestMoreInFlight.get(itemId) === run) requestMoreInFlight.delete(itemId);
    });
    requestMoreInFlight.set(itemId, run);
    return run;
  }
  function handleItemDetailsPage() {
    const itemId = detailsItemIdFromHash();
    if (!itemId) return;
    requestAnimationFrame(() => {
      if (detailsItemIdFromHash() !== itemId) return;
      void renderSimilarAndRecommended(itemId);
      void renderSeriesRequestMoreButton(itemId);
    });
  }
  function cleanup() {
    currentAbortController?.abort();
    currentAbortController = null;
    requestMoreAbortController?.abort();
    requestMoreAbortController = null;
    processedItems.clear();
    processedRequestMoreItems.clear();
    requestMoreInFlight.clear();
  }
  function injectRequestMoreStyles() {
    if (document.getElementById("je-series-request-more-styles")) return;
    const style = document.createElement("style");
    style.id = "je-series-request-more-styles";
    style.textContent = `
            h2.sectionTitle.sectionTitle-cards.je-series-request-more-heading {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
            }
        `;
    document.head.appendChild(style);
  }
  function initialize() {
    console.debug(`${logPrefix2} Initializing Recommendations and Similar sections`);
    injectRequestMoreStyles();
    const core = JE.core;
    if (!core?.lifecycle || !core.navigation) return;
    const lifecycle = core.lifecycle.register("jellyseerr-item-details");
    lifecycle.onTeardown(cleanup);
    lifecycle.teardownOn("navigate");
    JE.session?.onUserChange?.("jellyseerr-item-details", cleanup);
    core.navigation.onNavigate(() => handleItemDetailsPage());
    handleItemDetailsPage();
    core.navigation.onViewPage((_view, _element, _hash, _item, rawEvent) => {
      rows.noteViewItem(rawEvent);
      handleItemDetailsPage();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
})();
})();
//# sourceMappingURL=item-details.js.map
