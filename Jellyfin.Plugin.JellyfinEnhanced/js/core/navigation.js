(() => {
"use strict";
(() => {
  // client/src/core/navigation.ts
  function routerPart(href) {
    const text = String(href);
    const at = text.indexOf("#");
    const mark = at < 0 ? -1 : text.indexOf("#", at + 1);
    return mark < 0 ? text : text.slice(0, mark);
  }
  function routeOf(href) {
    const text = String(href);
    const at = text.indexOf("#");
    return at < 0 ? text : text.slice(0, at + 1) + (text.slice(at + 1).split(/[?#]/)[0] ?? "");
  }
  function pageOf(href) {
    const head = routerPart(href);
    const category = /(?:^|[#&])jeCategory=([^&]*)/.exec(String(href).slice(head.length));
    return `${head}#${category ? category[1] : ""}`;
  }
  function createNavigation(deps) {
    const callbacks = /* @__PURE__ */ new Map();
    const views = /* @__PURE__ */ new Set();
    let lastHref = null;
    let navGeneration = 0;
    let viewGeneration = 0;
    function invoke(entry, view, element, hash, event) {
      if (entry.options.pages && (!view || !entry.options.pages.includes(view))) return;
      try {
        entry.callback(view, element, hash, entry.options.fetchItem ? deps.fetchItem(hash) : null, event);
      } catch (error) {
        deps.report("Error in view handler", error);
      }
    }
    const navigation = {
      onNavigate(callback) {
        const entry = {};
        callbacks.set(callback, entry);
        return () => {
          if (callbacks.get(callback) === entry) callbacks.delete(callback);
        };
      },
      offNavigate: (callback) => callbacks.delete(callback),
      onViewPage(callback, options = {}) {
        const entry = { callback, options: { ...options, pages: options.pages ? [...options.pages] : null } };
        views.add(entry);
        if (options.immediate) invoke(entry, deps.currentView(), deps.currentElement(), deps.hash(), null);
        return () => {
          views.delete(entry);
        };
      },
      getCurrentView: () => deps.currentView(),
      /**
       * Changes the address without it being a navigation for the plugin: no 'je:navigate', and the address counts
       * as already seen, so its features keep what they show. For what a page keeps in its own address (a Seerr
       * section's filters, the Recommendations category page), which must not tear that page's features down. The
       * browser's Back and Forward to and from it still navigate. `state`: the entry's (keep `history.state` when
       * replacing: the router's own is in it); `push`: add a history entry (else the current one is replaced).
       */
      setAddressQuietly(state, url, push = false) {
        deps.writeAddress(state, url, push);
        lastHref = deps.href();
      },
      getViewHandlerCount: () => views.size,
      getNavCallbackCount: () => callbacks.size
    };
    return {
      navigation,
      /**
       * The address the page opened at is already where it is: a popstate or hashchange that lands on it again (a
       * dialog's own history entry popped by Back, such as the Seerr More Info modal's) is not a navigation.
       * Unseeded, the first one after a reload or an opened link would tear every page feature down.
       */
      seed() {
        lastHref = deps.href();
      },
      dispatchNavigate(event) {
        if (deps.href() === lastHref) return;
        if (lastHref !== null && deps.isDialogEntry()) {
          const href = deps.href();
          const pushed = event?.type === "je:navigate";
          if (pushed ? routeOf(href) === routeOf(lastHref) : pageOf(href) === pageOf(lastHref)) {
            deps.writeAddress(deps.state(), lastHref, false);
            return;
          }
        }
        lastHref = deps.href();
        const generation = ++navGeneration;
        for (const [callback, entry] of [...callbacks]) {
          if (generation !== navGeneration) break;
          if (callbacks.get(callback) !== entry) continue;
          try {
            callback(event);
          } catch (error) {
            deps.report("Error in onNavigate callback", error);
          }
        }
      },
      notifyViewHandlers(view, element, hash, event) {
        const generation = ++viewGeneration;
        for (const entry of [...views]) {
          if (generation !== viewGeneration) break;
          if (views.has(entry)) invoke(entry, view, element, hash, event);
        }
      }
    };
  }

  // client/src/host/core-host.ts
  function coreHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must be initialized before core modules");
    return host;
  }
  function identityId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function readIdentity(client) {
    try {
      const userId = identityId(client?.getCurrentUserId?.());
      let serverId = null;
      try {
        serverId = identityId(typeof client?.serverId === "function" ? client.serverId() : client?.serverId) || identityId(client?._serverInfo?.Id);
      } catch {
      }
      return { userId, serverId };
    } catch {
      return { userId: null, serverId: null };
    }
  }

  // client/src/host/navigation-host.ts
  function installNavigation() {
    const host = coreHost();
    const je = host.JellyfinEnhanced;
    const core = je.core ?? (je.core = {});
    if (core.navigation) return;
    let unpatchedPush = null;
    let unpatchedReplace = null;
    const currentElement = () => document.querySelector(".libraryPage:not(.hide)");
    const currentView = () => {
      const element = currentElement();
      return element?.getAttribute("data-type") || element?.id || element?.getAttribute("data-role") || null;
    };
    const runtime = createNavigation({
      href: () => window.location.href,
      hash: () => window.location.hash,
      currentView,
      currentElement,
      async fetchItem(hash) {
        const client = host.ApiClient;
        const identity = readIdentity(client);
        const lease = je.session?.createLease();
        const href = window.location.href;
        try {
          const id = new URLSearchParams((hash || "").split("?")[1]).get("id");
          if (!id || lease && !lease.isCurrent()) return null;
          const item = je.helpers?.getItemCached ? await je.helpers.getItemCached(id) : await client?.getItem?.(identity.userId, id);
          const current = readIdentity(host.ApiClient);
          if (href !== window.location.href || host.ApiClient !== client || current.userId !== identity.userId || current.serverId !== identity.serverId || lease && !lease.isCurrent()) return null;
          return item ?? null;
        } catch (error) {
          if (!lease?.signal.aborted) console.error("🪼 Jellyfin Enhanced: Navigation: Error fetching item:", error);
          return null;
        }
      },
      report: (context, error) => console.error(`🪼 Jellyfin Enhanced: Navigation: ${context}:`, error),
      isDialogEntry() {
        const state = window.history.state;
        if (!state || typeof state !== "object" || !("usr" in state)) return false;
        const usr = state.usr;
        return !!usr && typeof usr === "object" && "dialogs" in usr && Array.isArray(usr.dialogs);
      },
      state: () => window.history.state,
      writeAddress(state, url, push) {
        const write = push ? unpatchedPush ?? window.history.pushState.bind(window.history) : unpatchedReplace ?? window.history.replaceState.bind(window.history);
        write(state, "", url);
      }
    });
    core.navigation = runtime.navigation;
    let hooked = false;
    let lastEvent = null;
    let hookGeneration = 0;
    function installEmbyHook() {
      const page = host.Emby?.Page;
      if (!page) {
        window.setTimeout(installEmbyHook, 100);
        return;
      }
      const original = page.onViewShow;
      page.onViewShow = function(view, element, hash) {
        const generation = ++hookGeneration;
        const event = lastEvent;
        lastEvent = null;
        try {
          original?.call(this, view, element, hash);
        } catch (error) {
          console.warn("🪼 Jellyfin Enhanced: Navigation: Error in original onViewShow:", error);
        }
        if (generation === hookGeneration) runtime.notifyViewHandlers(view, element, hash, event);
      };
      hooked = true;
    }
    function initialize() {
      document.addEventListener("viewshow", (event) => {
        lastEvent = event;
        queueMicrotask(() => {
          if (lastEvent === event) lastEvent = null;
        });
      }, true);
      document.addEventListener("viewshow", (event) => {
        if (hooked) return;
        lastEvent = null;
        runtime.notifyViewHandlers(
          currentView() || void 0,
          event.target instanceof Element ? event.target : null,
          window.location.hash,
          event
        );
      });
      runtime.seed();
      for (const event of ["je:navigate", "hashchange", "popstate"]) {
        window.addEventListener(event, runtime.dispatchNavigate);
      }
      const history = window.history;
      if (!history.__jePushed) {
        history.__jePushed = true;
        unpatchedPush = history.pushState.bind(history);
        unpatchedReplace = history.replaceState.bind(history);
        for (const method of ["pushState", "replaceState"]) {
          const original = history[method].bind(history);
          history[method] = (data, unused, url) => {
            const before = window.location.href;
            original(data, unused, url);
            if (window.location.href !== before) window.dispatchEvent(new Event("je:navigate"));
          };
        }
      }
      installEmbyHook();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
  }

  // client/src/core/navigation-entry.ts
  installNavigation();
})();
})();
//# sourceMappingURL=navigation.js.map
