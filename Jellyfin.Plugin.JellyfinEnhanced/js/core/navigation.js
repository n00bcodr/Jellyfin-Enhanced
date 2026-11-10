(() => {
"use strict";
(() => {
  // client/src/core/navigation.ts
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
      getViewHandlerCount: () => views.size,
      getNavCallbackCount: () => callbacks.size
    };
    return {
      navigation,
      dispatchNavigate(event) {
        if (deps.href() === lastHref) return;
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
      report: (context, error) => console.error(`🪼 Jellyfin Enhanced: Navigation: ${context}:`, error)
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
      for (const event of ["je:navigate", "hashchange", "popstate"]) {
        window.addEventListener(event, runtime.dispatchNavigate);
      }
      const history = window.history;
      if (!history.__jePushed) {
        history.__jePushed = true;
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
