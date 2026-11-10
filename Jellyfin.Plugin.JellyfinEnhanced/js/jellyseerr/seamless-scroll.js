(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-details.ts
  function bridgeOrNew() {
    const host = window;
    return host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }

  // client/src/features/seerr/details/scroll/seamless-scroll.ts
  var logPrefix = `${SEERR_LOG} Seamless Scroll:`;
  var CONFIG = {
    // Vertical grids: keep at least this much rendered content below the viewport.
    bufferViewports: 3,
    minBufferPx: 2400,
    // Horizontal rows: keep this many visible-row-widths of cards to the right once the
    // viewer has interacted with the row (scrolled, wheeled, touched, focused it)...
    bufferRowWidths: 4,
    // ...and only this many before that, so a row that is merely displayed costs one page.
    idleRowWidths: 1.5,
    // Rows scrolled by transforms emit no scroll events, so poll the geometry while set up...
    horizontalPollMs: 400,
    // ...until this many polls in a row found nothing to load. Any scroll, wheel, swipe, key,
    // focus, press or resize, a card hidden or added, and any fill request starts it again.
    horizontalPollIdleLimit: 3,
    // After this many consecutive pages that rendered no cards the loop pauses and shows a
    // "Keep looking" button. Pages are never skipped: pressing it resumes the feed.
    maxConsecutiveEmptyPages: 40,
    // Pause after this many consecutive fills whose measured buffer did not grow, even
    // though pages kept returning results (e.g. mostly duplicates).
    maxStuckFills: 15,
    retry: { maxAttempts: 3, baseDelayMs: 1e3, maxDelayMs: 8e3, jitterFactor: 0.25 }
  };
  function calculateBackoff(attempt) {
    const { baseDelayMs, maxDelayMs, jitterFactor } = CONFIG.retry;
    const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
  }
  function verticalBufferPx() {
    return Math.max(window.innerHeight * CONFIG.bufferViewports, CONFIG.minBufferPx);
  }
  function errorName(error) {
    return typeof error === "object" && error !== null && "name" in error ? error.name : void 0;
  }
  function errorText(error) {
    return typeof error === "object" && error !== null && "message" in error ? error.message : error;
  }
  function cardsNeeded(container, hint, fallback = 40) {
    if (!container || !hint || !(hint.deficitPx > 0)) return fallback;
    const targetPx = Math.max(hint.deficitPx, (hint.spanPx || 0) * 0.75);
    const cards = container.querySelectorAll(".card");
    let first = null;
    for (let index = 0; index < cards.length && index < 60; index++) {
      const card = cards[index];
      if (card && card.offsetParent !== null) {
        first = card;
        break;
      }
    }
    if (!first) return fallback;
    const rect = first.getBoundingClientRect();
    if (hint.horizontal) return Math.ceil(targetPx / (rect.width || 150)) + 2;
    const rowHeight = rect.height || 250;
    let perRow = 1;
    for (let index = 1; index < cards.length && index < 80 && perRow < 40; index++) {
      const card = cards[index];
      if (!card || card.offsetParent === null) continue;
      if (Math.abs(card.getBoundingClientRect().top - rect.top) < 2) perRow++;
      else break;
    }
    return Math.ceil(targetPx / rowHeight) * perRow + perRow;
  }
  function defaultKey(item) {
    const value = record(item);
    return `${value?.mediaType}-${value?.id}`;
  }
  function createDeduplicator() {
    const seen = /* @__PURE__ */ new Set();
    return {
      /** Marks an item as seen; true when it was new. */
      add(item, getKey = defaultKey) {
        const key = getKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
      /** The new items of a list, all marked as seen. */
      filter(items, getKey = defaultKey) {
        const filtered = items.filter((item) => this.add(item, getKey));
        const duplicates = items.length - filtered.length;
        if (duplicates > 0) console.debug(`${logPrefix} Filtered out ${duplicates} duplicate(s) from ${items.length} items`);
        return filtered;
      },
      clear() {
        seen.clear();
      },
      get size() {
        return seen.size;
      }
    };
  }
  function trailingThrottle(callback, wait) {
    let lastCall = Number.NEGATIVE_INFINITY;
    let timer = null;
    const run = () => {
      timer = null;
      lastCall = Date.now();
      callback();
    };
    const throttled = () => {
      const elapsed = Date.now() - lastCall;
      if (elapsed >= wait) {
        if (timer !== null) clearTimeout(timer);
        run();
      } else if (timer === null) {
        timer = setTimeout(run, wait - elapsed);
      }
    };
    throttled.cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    return throttled;
  }
  var ACTION_ROW_CSS = {
    horizontal: "display: inline-flex; justify-content: center; align-items: center; vertical-align: middle; padding: 1em 1.5em; box-sizing: border-box;",
    vertical: "display: flex; justify-content: center; align-items: center; padding: 1.5em; width: 100%; box-sizing: border-box;",
    button: "padding: 0.8em 1.5em; border-radius: 4px; background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); border: 1px solid rgba(255,255,255,0.2); cursor: pointer; font-size: 1em; display: inline-flex; align-items: center; justify-content: center;"
  };
  function createScrollEngine(JE2) {
    function cleanupInfiniteScroll2(state) {
      if (state._teardown) {
        state._teardown();
        state._teardown = null;
      }
      if (state.activeScrollObserver) {
        state.activeScrollObserver.disconnect();
        state.activeScrollObserver = null;
      }
      if (state._sentinel) {
        state._sentinel.remove();
        state._sentinel = null;
      }
      if (state._removeRetryRow) {
        state._removeRetryRow();
        state._removeRetryRow = null;
      }
      state.fill = null;
    }
    function setupInfiniteScroll2(state, sectionSelector, loadMore, hasMore, isLoading, options = {}) {
      console.debug(`${logPrefix} Setting up infinite scroll for ${sectionSelector}`);
      cleanupInfiniteScroll2(state);
      const section = document.querySelector(sectionSelector);
      if (!section) return;
      const horizontal = options.horizontal === true;
      const trackSelector = options.trackSelector || ".itemsContainer";
      const scrollerSelector = options.scrollerSelector || ".emby-scroller";
      section.querySelectorAll(".jellyseerr-scroll-sentinel, .je-scroll-sentinel").forEach((old) => old.remove());
      const sentinel = document.createElement("div");
      sentinel.className = "je-scroll-sentinel";
      sentinel.style.cssText = "height:1px;width:100%;pointer-events:none;";
      section.appendChild(sentinel);
      let retryCount = 0;
      let retryRow = null;
      let destroyed = false;
      let filling = false;
      let emptyPages = 0;
      let paused = false;
      let engaged = !horizontal;
      let lastMeasuredAhead = null;
      let stuckFills = 0;
      let cancelBackoff = null;
      let suspendedByModal = false;
      let loadsStarted = 0;
      let pollTimer = null;
      let idlePolls = 0;
      const removeRetryRow = () => {
        if (retryRow) {
          retryRow.remove();
          retryRow = null;
        }
      };
      const showRetryRow = (label = "Tap to retry", icon = null) => {
        if (retryRow || destroyed) return;
        const row = document.createElement("div");
        row.className = "je-retry-row";
        row.style.cssText = horizontal ? ACTION_ROW_CSS.horizontal : ACTION_ROW_CSS.vertical;
        const button = document.createElement("button");
        button.type = "button";
        if (label) {
          button.title = label;
          button.setAttribute("aria-label", label);
        }
        if (icon) {
          const iconEl = document.createElement("span");
          iconEl.className = "material-icons";
          iconEl.textContent = icon;
          iconEl.setAttribute("aria-hidden", "true");
          button.appendChild(iconEl);
        } else {
          button.textContent = label;
        }
        button.style.cssText = ACTION_ROW_CSS.button;
        button.addEventListener("click", () => {
          retryCount = 0;
          emptyPages = 0;
          stuckFills = 0;
          lastMeasuredAhead = null;
          paused = false;
          engaged = true;
          removeRetryRow();
          void fill();
        });
        row.appendChild(button);
        retryRow = row;
        const track = horizontal ? section.querySelector(trackSelector) : null;
        if (track) track.appendChild(row);
        else sentinel.parentNode?.insertBefore(row, sentinel);
      };
      const isDisplayed = () => section.isConnected && section.getClientRects().length > 0;
      const measure = () => {
        if (!isDisplayed()) return { ahead: 0, target: 0, span: 0, inRange: false };
        if (horizontal) {
          const track = section.querySelector(trackSelector);
          const scroller = section.querySelector(scrollerSelector) ?? section;
          const sectionRect = section.getBoundingClientRect();
          const vBuffer = verticalBufferPx();
          const inRange = sectionRect.bottom > -vBuffer && sectionRect.top < window.innerHeight + vBuffer;
          if (!track) return { ahead: 0, target: 0, span: 0, inRange };
          const cards = track.querySelectorAll(".card");
          const last = cards[cards.length - 1] ?? track;
          const endRight = last.getBoundingClientRect().right;
          const scrollerRect = scroller.getBoundingClientRect();
          const visibleRight = Math.min(scrollerRect.right, window.innerWidth);
          const span = Math.max(scrollerRect.width || window.innerWidth, 400);
          const widths = engaged ? CONFIG.bufferRowWidths : CONFIG.idleRowWidths;
          return { ahead: endRight - visibleRight, target: span * widths, span, inRange };
        }
        const top = sentinel.getBoundingClientRect().top;
        const target = verticalBufferPx();
        return { ahead: top - window.innerHeight, target, span: window.innerHeight, inRange: top - window.innerHeight < target };
      };
      const contentEnd = () => {
        if (horizontal) {
          const track = section.querySelector(trackSelector);
          const last = track ? track.querySelectorAll(".card") : null;
          const card = last?.[last.length - 1];
          if (!track || !card) return 0;
          return card.getBoundingClientRect().right - track.getBoundingClientRect().left;
        }
        return sentinel.getBoundingClientRect().top + window.scrollY;
      };
      const backoff = (ms) => new Promise((resolve) => {
        const timer = setTimeout(() => {
          cancelBackoff = null;
          resolve();
        }, ms);
        cancelBackoff = () => {
          clearTimeout(timer);
          cancelBackoff = null;
          resolve();
        };
      });
      const wrappedLoad = async (hint) => {
        if (!hasMore() || isLoading()) return false;
        removeRetryRow();
        console.debug(`${logPrefix} Loading more items (attempt ${retryCount + 1}, deficit ${Math.round(hint.deficitPx)}px)`);
        try {
          const result = await loadMore(hint);
          retryCount = 0;
          return result && typeof result === "object" ? result : true;
        } catch (error) {
          if (errorName(error) === "AbortError" || destroyed) return false;
          retryCount++;
          console.warn(`${logPrefix} Load failed (attempt ${retryCount}/${CONFIG.retry.maxAttempts}):`, errorText(error));
          if (retryCount >= CONFIG.retry.maxAttempts) {
            console.warn(`${logPrefix} Max retry attempts reached, showing retry UI`);
            paused = true;
            showRetryRow();
            return false;
          }
          const delay = calculateBackoff(retryCount);
          console.debug(`${logPrefix} Retrying in ${delay}ms...`);
          await backoff(delay);
          if (destroyed || !sentinel.isConnected) return false;
          return wrappedLoad(hint);
        }
      };
      const modalOpen = () => !!document.querySelector(".je-more-info-modal");
      const runFill = async () => {
        if (filling || destroyed || paused) return;
        filling = true;
        try {
          while (!destroyed && !paused && sentinel.isConnected && hasMore() && !isLoading()) {
            if (modalOpen()) {
              suspendedByModal = true;
              break;
            }
            const geometry = measure();
            if (!geometry.inRange) break;
            const deficit = geometry.target - geometry.ahead;
            if (deficit <= 0) break;
            if (emptyPages >= CONFIG.maxConsecutiveEmptyPages) {
              console.debug(`${logPrefix} ${emptyPages} consecutive pages rendered nothing; pausing until "Keep looking" is pressed`);
              paused = true;
              showRetryRow(null, "refresh");
              break;
            }
            if (lastMeasuredAhead !== null && geometry.ahead <= lastMeasuredAhead + 1) {
              stuckFills++;
              if (stuckFills >= CONFIG.maxStuckFills) {
                console.warn(`${logPrefix} Buffer measurement hasn't grown after ${stuckFills} loads despite non-empty pages; pausing to avoid a runaway fetch loop`);
                paused = true;
                showRetryRow(null, "refresh");
                break;
              }
            } else {
              stuckFills = 0;
            }
            lastMeasuredAhead = geometry.ahead;
            const before = contentEnd();
            const pageBudget = CONFIG.maxConsecutiveEmptyPages - emptyPages;
            loadsStarted++;
            const result = await wrappedLoad({ deficitPx: deficit, aheadPx: geometry.ahead, spanPx: geometry.span, horizontal, engaged, pageBudget });
            if (!result) break;
            if (typeof result === "object" && typeof result.pages === "number") {
              const rendered = result.rendered ?? 0;
              if (result.pages === 0 && !(rendered > 0)) break;
              emptyPages = rendered > 0 ? 0 : emptyPages + result.pages;
            } else {
              emptyPages = contentEnd() > before + 1 ? 0 : emptyPages + 1;
            }
          }
        } finally {
          filling = false;
        }
      };
      const pollTick = async () => {
        if (!sentinel.isConnected) {
          teardown();
          return;
        }
        if (filling) {
          idlePolls = 0;
          return;
        }
        const before = loadsStarted;
        await runFill();
        if (loadsStarted !== before) {
          idlePolls = 0;
        } else if (++idlePolls >= CONFIG.horizontalPollIdleLimit && pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
      const armPoll = () => {
        if (!horizontal || destroyed) return;
        idlePolls = 0;
        if (pollTimer === null) pollTimer = window.setInterval(() => {
          void pollTick();
        }, CONFIG.horizontalPollMs);
      };
      const fill = () => {
        armPoll();
        return runFill();
      };
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fill();
      }, { rootMargin: `${Math.round(verticalBufferPx())}px` });
      state.activeScrollObserver = observer;
      observer.observe(horizontal ? section : sentinel);
      const onUserScroll = trailingThrottle(() => {
        if (!sentinel.isConnected) {
          teardown();
          return;
        }
        void fill();
      }, 100);
      const CARD_EVENT_TYPES = /* @__PURE__ */ new Set(["pointerdown", "touchstart", "focusin"]);
      const onEngage = (event) => {
        if (CARD_EVENT_TYPES.has(event.type) && event.target instanceof Element && event.target.closest(".card")) return;
        if (!engaged) {
          engaged = true;
          void fill();
        }
      };
      const listeners = [];
      const listen = (target, type, handler, opts) => {
        target.addEventListener(type, handler, opts);
        listeners.push(() => target.removeEventListener(type, handler, opts));
      };
      listen(window, "scroll", onUserScroll, { passive: true });
      listen(window, "resize", onUserScroll, { passive: true });
      listen(document, "jellyseerr-more-info-closed", () => {
        if (!suspendedByModal) return;
        suspendedByModal = false;
        void fill();
      });
      if (horizontal) {
        listen(section, "scroll", onUserScroll, { passive: true, capture: true });
        listen(section, "wheel", onUserScroll, { passive: true });
        listen(section, "touchmove", onUserScroll, { passive: true });
        listen(section, "keydown", onUserScroll, { passive: true });
        listen(section, "focusin", onUserScroll, { passive: true });
        listen(section, "pointerdown", armPoll, { passive: true, capture: true });
        listen(window, "je-hidden-content-changed", armPoll);
        const track = section.querySelector(trackSelector);
        if (track && typeof MutationObserver !== "undefined") {
          const trackObserver = new MutationObserver(() => armPoll());
          trackObserver.observe(track, { childList: true });
          listeners.push(() => trackObserver.disconnect());
        }
        for (const type of ["scroll", "wheel", "touchstart", "touchmove", "keydown", "focusin", "pointerdown"]) {
          listen(section, type, onEngage, { passive: true, capture: true });
        }
        armPoll();
      }
      const teardown = () => {
        if (destroyed) return;
        destroyed = true;
        listeners.splice(0).forEach((off) => off());
        onUserScroll.cancel();
        cancelBackoff?.();
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        observer.disconnect();
        if (state.activeScrollObserver === observer) state.activeScrollObserver = null;
        if (state.fill === fill) state.fill = null;
      };
      state._teardown = teardown;
      state._sentinel = sentinel;
      state._removeRetryRow = removeRetryRow;
      state.fill = fill;
      void fill();
    }
    return { setupInfiniteScroll: setupInfiniteScroll2, cleanupInfiniteScroll: cleanupInfiniteScroll2 };
  }

  // client/src/features/seerr/details/scroll/seamless-scroll-entry.ts
  var JE = bridgeOrNew();
  var { setupInfiniteScroll, cleanupInfiniteScroll } = createScrollEngine(JE);
  JE.seamlessScroll = { createDeduplicator, cardsNeeded, setupInfiniteScroll, cleanupInfiniteScroll, CONFIG };
})();
})();
//# sourceMappingURL=seamless-scroll.js.map
