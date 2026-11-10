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

  // client/generated-shared/stub/client/src/features/calendar/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/calendar/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "calendarHost");

  // client/src/features/calendar/lifetime.ts
  function lifetime(ctx) {
    var _a;
    return (_a = ctx.own).calendarLifetime || (_a.calendarLifetime = { view: 0, navigation: 0, refresh: 0, events: 0, userData: 0, requests: 0, initialized: false, disposers: /* @__PURE__ */ new Map() });
  }
  function invalidate(ctx) {
    const owner = lifetime(ctx);
    owner.view++;
    const state = ctx.own.calendarPage?.state;
    if (state) {
      state.isLoading = false;
      state.requestedLoading = false;
    }
  }
  function own(ctx, key, dispose) {
    const owner = lifetime(ctx);
    owner.disposers.get(key)?.();
    owner.disposers.set(key, dispose);
  }

  // client/src/features/calendar/calendar-custom-tab.ts
  (function() {
    const { JE, ctx } = export0();
    const config = JE.pluginConfig;
    if (!config?.CalendarPageEnabled || !config.CalendarUseCustomTabs && !config.CalendarUseNativeTab) return;
    const lifecycle = JE.core.lifecycle.register("arr-calendar-custom-owner");
    lifecycle.teardown();
    let disposed = false;
    let lastMountedContainer = null;
    let clicks = null;
    let watcher = null;
    const style = document.createElement("style");
    style.textContent = `.jellyfinenhanced.calendar {padding: 12px 3vw;}
 .backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.calendar) {background: rgba(0,0,0,.7) !important; opacity: 1 !important;}`;
    document.head.appendChild(style);
    let timer;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (timer !== void 0) clearInterval(timer);
      watcher?.teardown();
      style.remove();
      if (clicks) document.removeEventListener("click", clicks);
      if (lastMountedContainer) invalidate(ctx);
      lastMountedContainer = null;
    };
    own(ctx, "custom-tab", dispose);
    lifecycle.track(dispose);
    function isHome() {
      return /^(?:#\/home(?:\.html)?(?:\?.*)?)?$/.test(window.location.hash);
    }
    function reconcile() {
      if (disposed) return;
      const candidates = isHome() ? [...document.querySelectorAll(".jellyfinenhanced.calendar")] : [];
      const container = candidates.reverse().find((el) => JE.helpers.isActiveTabContainer(el)) ?? null;
      if (!container) {
        if (lastMountedContainer) {
          invalidate(ctx);
          const state = ctx.own.calendarPage?.state;
          if (state) state._customTabContainer = null;
        }
        lastMountedContainer = null;
        return;
      }
      if (container === lastMountedContainer && container.hasChildNodes()) return;
      const page = JE.calendarPage;
      if (!page) return;
      invalidate(ctx);
      container.classList.remove("hide");
      container.style.display = "";
      const child = document.createElement("div");
      child.id = "je-calendar-container-tab";
      container.replaceChildren(child);
      lastMountedContainer = container;
      page.renderForCustomTab(child);
      if (!clicks) {
        clicks = page.handleEventClick;
        document.addEventListener("click", clicks);
      }
    }
    let attempts = 0;
    function ready() {
      if (disposed) return;
      if (!JE.calendarPage || !JE.helpers?.observeTabContainers || config?.CalendarUseNativeTab && !JE.nativeTabs?.register) {
        if (++attempts >= 300) dispose();
        return;
      }
      if (timer !== void 0) clearInterval(timer);
      if (config?.CalendarUseNativeTab) JE.nativeTabs.register("calendar", JE.t("calendar_title") || "Calendar", (panel) => {
        if (disposed) return;
        const marker = document.createElement("div");
        marker.className = "jellyfinenhanced calendar";
        panel.appendChild(marker);
      }, "calendar_month");
      watcher = JE.helpers.observeTabContainers("arr-calendar-custom-tab", ".jellyfinenhanced.calendar", reconcile);
      reconcile();
    }
    timer = setInterval(ready, 100);
    ready();
  })();
})();
})();
//# sourceMappingURL=calendar-custom-tab.js.map
