(() => {
"use strict";
(() => {
  // client/src/core/lifecycle.ts
  function createLifecycle(deps) {
    const registry = /* @__PURE__ */ new Map();
    function dispose(resource) {
      try {
        if (resource == null) return;
        if (typeof resource === "number") {
          deps.clearInterval(resource);
          return;
        }
        if (typeof resource === "function") {
          resource();
          return;
        }
        if ("el" in resource) {
          resource.el.removeEventListener(resource.type, resource.fn, resource.opts);
          return;
        }
        if ("intervalId" in resource) {
          deps.clearInterval(resource.intervalId);
          return;
        }
        if ("timeoutId" in resource) {
          deps.clearTimeout(resource.timeoutId);
          return;
        }
        if ("abort" in resource) {
          resource.abort();
          return;
        }
        if ("disconnect" in resource) {
          resource.disconnect();
          return;
        }
        if ("unsubscribe" in resource) {
          resource.unsubscribe();
          return;
        }
        deps.report("Don't know how to dispose resource", resource);
      } catch (error) {
        deps.report("Error disposing resource", error);
      }
    }
    function register(name) {
      const existing = registry.get(name);
      if (existing) return existing;
      let tracked = [];
      const hooks = [];
      let tearingDown = false;
      const handle = {
        name,
        track(resource) {
          tracked.push(resource);
          return resource;
        },
        untrack(resource) {
          tracked = tracked.filter((entry) => entry !== resource);
        },
        addListener(el, type, fn, opts) {
          el.addEventListener(type, fn, opts);
          tracked.push({ el, type, fn, opts });
        },
        onTeardown(callback) {
          hooks.push(callback);
          return handle;
        },
        teardown() {
          if (tearingDown) return;
          tearingDown = true;
          const resources = tracked;
          const currentHooks = [...hooks];
          tracked = [];
          try {
            for (const resource of resources) dispose(resource);
            for (const hook of currentHooks) {
              try {
                hook();
              } catch (error) {
                deps.report(`Error in teardown hook for "${name}"`, error);
              }
            }
          } finally {
            tearingDown = false;
          }
        },
        teardownOn(eventName) {
          if (eventName !== "navigate") {
            deps.report("teardownOn: unsupported event", eventName);
            return () => {
            };
          }
          return deps.onNavigate(() => handle.teardown());
        }
      };
      registry.set(name, handle);
      return handle;
    }
    let tearingDownAll = false;
    return {
      register,
      get: (name) => registry.get(name) || null,
      getFeatures: () => [...registry.keys()],
      teardownAll() {
        if (tearingDownAll) return;
        tearingDownAll = true;
        try {
          for (const handle of [...registry.values()]) handle.teardown();
        } finally {
          tearingDownAll = false;
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

  // client/src/core/lifecycle-entry.ts
  var je = coreHost().JellyfinEnhanced;
  var core = je.core ?? (je.core = {});
  core.lifecycle ?? (core.lifecycle = createLifecycle({
    clearInterval: (id) => window.clearInterval(id),
    clearTimeout: (id) => window.clearTimeout(id),
    onNavigate: (callback) => core.navigation?.onNavigate(callback) ?? (() => {
    }),
    report: (context, error) => {
      const log = context.startsWith("Error in teardown hook") ? console.error : console.warn;
      log(`🪼 Jellyfin Enhanced: Lifecycle: ${context}:`, error);
    }
  }));
})();
})();
//# sourceMappingURL=lifecycle.js.map
