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

  // client/src/features/chrome/host.ts
  function chromeContext(JE2, facades) {
    return featureContext("chrome", JE2, { facades });
  }
  function idString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function readClientIdentity(client) {
    let userId = null;
    let serverId = null;
    try {
      userId = idString(client?.getCurrentUserId?.());
    } catch {
    }
    try {
      const raw = client?.serverId;
      serverId = idString(typeof raw === "function" ? raw.call(client) : raw) || idString(client?._serverInfo?.Id);
    } catch {
    }
    return { userId, serverId };
  }
  function captureIdentity(session, client) {
    const live = readClientIdentity(client);
    let epoch = null;
    try {
      epoch = typeof session?.getEpoch === "function" ? session.getEpoch() : null;
    } catch {
      epoch = null;
    }
    const read = (get) => {
      try {
        return idString(get());
      } catch {
        return null;
      }
    };
    const token = read(() => client?.accessToken?.());
    const root = read(() => client?.getUrl?.("/"));
    return {
      userId: live.userId,
      serverId: live.serverId,
      epoch,
      client,
      credentialsCurrent: () => read(() => client?.accessToken?.()) === token && read(() => client?.getUrl?.("/")) === root
    };
  }
  function isSameIdentity(owner, current) {
    return owner.client === current.client && owner.credentialsCurrent() && current.credentialsCurrent() && owner.userId === current.userId && owner.serverId === current.serverId && owner.epoch === current.epoch;
  }
  function optionalBridge() {
    const host = window;
    return host.JellyfinEnhanced;
  }

  // client/src/features/chrome/plugin-icons.ts
  var PLUGIN_ID = "f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b";
  var SECTION = 'ul[aria-labelledby="plugins-subheader"]';
  var LINK_ATTRIBUTE = "data-jellyfin-enhanced-plugin-id";
  var SIGNATURE_ATTRIBUTE = "data-jellyfin-enhanced-plugin-signature";
  function parseCustomPluginLinks(text) {
    if (typeof text !== "string" || !text.trim()) return [];
    const plugins = [];
    text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split("|").map((part) => part.trim());
      const [name, icon] = parts;
      if (parts.length >= 2 && name !== void 0 && icon !== void 0) {
        plugins.push({ name, icon, iconType: "material", id: `custom-${index}` });
      }
    });
    return plugins;
  }
  function testPlugins(value) {
    if (!Array.isArray(value)) return value ? [] : null;
    return value.map((entry, index) => ({
      name: String(entry?.name ?? ""),
      icon: String(entry?.icon ?? ""),
      iconType: "material",
      id: `test-${index}`
    }));
  }
  var signature = (plugin) => `${plugin.name}\0${plugin.icon}`;
  function createPluginIcons(JE2) {
    const host = window;
    let isProcessing = false;
    let rerun = false;
    let observer = null;
    let lifecycleActive = false;
    let debounceTimer;
    let renderedOwner = null;
    let cache = null;
    function injectCSS() {
      if (document.getElementById("plugin-icons-material")) return;
      const style = document.createElement("style");
      style.id = "plugin-icons-material";
      style.textContent = `
        .plugin-material-icon {
          font-family: 'Material Icons';
          font-size: 24px;
          line-height: 1;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          -webkit-font-smoothing: antialiased;
        }
      `;
      document.head.appendChild(style);
    }
    async function getCustomPlugins() {
      const preview = testPlugins(host.testCustomPluginLinks);
      if (preview) return preview;
      const client = host.ApiClient;
      const owner = captureIdentity(JE2.session, client);
      if (cache && isSameIdentity(cache.owner, owner)) return cache.plugins;
      try {
        if (!client) return void 0;
        const config = await client.getPluginConfiguration(PLUGIN_ID);
        const links = typeof config === "object" && config !== null && "CustomPluginLinks" in config ? config.CustomPluginLinks : "";
        const plugins = parseCustomPluginLinks(links || "");
        if (host.ApiClient !== client || !isSameIdentity(owner, captureIdentity(JE2.session, host.ApiClient))) return null;
        cache = { owner, plugins };
        return plugins;
      } catch (error) {
        console.warn("Failed to load custom plugins from server:", error);
      }
      return void 0;
    }
    function createCustomPluginLink(section, plugin) {
      const existing = [...section.querySelectorAll(`[${LINK_ATTRIBUTE}]`)].find((link2) => link2.getAttribute(LINK_ATTRIBUTE) === plugin.id);
      if (existing) return;
      const link = document.createElement("a");
      link.className = "MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters MuiListItemButton-root MuiListItemButton-gutters css-yknuxp";
      link.tabIndex = 0;
      link.href = `${window.location.origin + window.location.pathname}#/configurationpage?name=${encodeURIComponent(plugin.name)}`;
      link.setAttribute(LINK_ATTRIBUTE, plugin.id);
      link.setAttribute(SIGNATURE_ATTRIBUTE, signature(plugin));
      const iconDiv = document.createElement("div");
      iconDiv.className = "MuiListItemIcon-root css-5pks8q";
      const icon = document.createElement("span");
      icon.className = "material-icons plugin-material-icon";
      icon.textContent = plugin.icon;
      icon.setAttribute("aria-hidden", "true");
      iconDiv.appendChild(icon);
      const textDiv = document.createElement("div");
      textDiv.className = "MuiListItemText-root css-t3p1a1";
      const text = document.createElement("span");
      text.className = "MuiTypography-root MuiTypography-body1 MuiListItemText-primary css-pl8nxc";
      text.textContent = plugin.name;
      textDiv.appendChild(text);
      link.appendChild(iconDiv);
      link.appendChild(textDiv);
      section.appendChild(link);
    }
    function replacePluginIcon(config) {
      const iconDiv = document.querySelector(config.selector)?.querySelector(".MuiListItemIcon-root");
      if (!iconDiv) return false;
      if (iconDiv.querySelector(".plugin-material-icon, .plugin-custom-icon-img")) return false;
      const oldIcon = iconDiv.querySelector("svg, .material-icons");
      if (!oldIcon) return false;
      let element;
      if (config.type === "image") {
        const img = document.createElement("img");
        img.src = config.src;
        img.style.width = "24px";
        img.style.height = "24px";
        img.alt = config.alt;
        img.className = "plugin-custom-icon-img";
        element = img;
      } else {
        element = document.createElement("span");
        element.className = "material-icons plugin-material-icon";
        element.textContent = config.icon;
        element.setAttribute("aria-hidden", "true");
      }
      oldIcon.replaceWith(element);
      return true;
    }
    function iconConfigs() {
      return [
        { selector: 'a[href*="Jellyfin%20Enhanced"]', type: "image", src: JE2.cdn.url("jellyfish", "logos/favicon.ico"), alt: "Jellyfin Enhanced" },
        { selector: 'a[href*="JavaScript%20Injector"]', type: "image", src: JE2.cdn.url("dashboard-icons", "svg/javascript.svg"), alt: "JavaScript" },
        { selector: 'a[href*="Intro%20Skipper"]', type: "material", icon: "redo" },
        { selector: 'a[href*="reports"]', type: "material", icon: "insert_chart_outlined" },
        { selector: 'a[href*="Jellysleep"]', type: "material", icon: "dark_mode" },
        { selector: 'a[href*="Home%20Screen%20Sections"]', type: "material", icon: "dashboard_customize" },
        { selector: 'a[href*="File%20Transformation"]', type: "material", icon: "file_open" },
        { selector: 'a[href*="Newsletters"]', type: "material", icon: "newspaper" },
        { selector: 'a[href*="Segment%20Editor"]', type: "material", icon: "content_cut" },
        { selector: 'a[href*="Jellyfin%20Helper"]', type: "image", src: JE2.cdn.url("jelly-helper", "media/favicon.ico"), alt: "Jellyfin Helper" },
        { selector: 'a[href*="Moonbase"]', type: "image", src: JE2.cdn.url("moonbase", "moonfin-client"), alt: "Moonbase" }
      ];
    }
    async function processPluginIcons() {
      if (isProcessing) {
        rerun = true;
        return;
      }
      isProcessing = true;
      try {
        if (!document.querySelector(SECTION)) return;
        for (const config of iconConfigs()) replacePluginIcon(config);
        const currentOwner = captureIdentity(JE2.session, host.ApiClient);
        if (renderedOwner && !isSameIdentity(renderedOwner, currentOwner)) {
          document.querySelectorAll("[" + LINK_ATTRIBUTE + "]").forEach((link) => link.remove());
          renderedOwner = null;
        }
        const plugins = await getCustomPlugins();
        if (plugins === void 0) return;
        if (!plugins) {
          rerun = true;
          return;
        }
        const section = document.querySelector(SECTION);
        if (!section) return;
        const wanted = new Map(plugins.map((plugin) => [plugin.id, signature(plugin)]));
        const previewActive = testPlugins(host.testCustomPluginLinks) !== null;
        section.querySelectorAll("[" + LINK_ATTRIBUTE + "]").forEach((link) => {
          if (previewActive && link.getAttribute(LINK_ATTRIBUTE)?.startsWith("custom-")) return;
          if (wanted.get(link.getAttribute(LINK_ATTRIBUTE) ?? "") !== link.getAttribute(SIGNATURE_ATTRIBUTE)) link.remove();
        });
        for (const plugin of plugins) createCustomPluginLink(section, plugin);
        renderedOwner = captureIdentity(JE2.session, host.ApiClient);
      } finally {
        isProcessing = false;
        if (rerun) {
          rerun = false;
          schedule(100);
        }
      }
    }
    function schedule(delay) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void processPluginIcons();
      }, delay);
    }
    function onMutations(mutations) {
      if (!document.body.classList.contains("dashboardDocument")) return;
      const relevant = mutations.some((mutation) => {
        const target = mutation.target;
        if (mutation.type !== "childList" || !(target instanceof Element)) return false;
        return target.matches(SECTION) || !!target.querySelector(SECTION) || !!target.closest(SECTION) || target === document.body || target.classList.contains("dashboardDocument") || target.classList.contains("settingsDocument") || target.classList.contains("dashboardPage");
      });
      if (relevant) schedule(100);
    }
    function startMonitoring() {
      if (observer) return;
      if (JE2.helpers?.onBodyMutation) {
        observer = JE2.helpers.onBodyMutation("plugin-icons", onMutations);
      } else {
        const native = new MutationObserver(onMutations);
        native.observe(document.body, { childList: true, subtree: true });
        observer = { unsubscribe: () => native.disconnect() };
      }
    }
    function stopMonitoring() {
      observer?.unsubscribe();
      observer = null;
      clearTimeout(debounceTimer);
      if (lifecycleActive) {
        JE2.core.lifecycle.register("plugin-icons").teardown();
        lifecycleActive = false;
      }
    }
    function setupNavigationListener() {
      const lifecycle = JE2.core.lifecycle.register("plugin-icons");
      lifecycle.teardown();
      lifecycleActive = true;
      lifecycle.track(JE2.core.navigation.onNavigate(() => {
        const hash = window.location.hash;
        if (hash.includes("#/dashboard") || hash.includes("#/settings") || hash.includes("#/configurationpage")) schedule(300);
      }));
    }
    async function initialize() {
      injectCSS();
      setupNavigationListener();
      let retries = 0;
      const tryInitialize = async () => {
        if (host.ApiClient) {
          await processPluginIcons();
          startMonitoring();
        } else if (retries < 10) {
          retries++;
          setTimeout(() => {
            void tryInitialize();
          }, 500);
        } else {
          console.warn("ApiClient not available after retries, custom plugin links will not work");
          await processPluginIcons();
          startMonitoring();
        }
      };
      void tryInitialize();
    }
    JE2.session?.onUserChange("plugin-icons", () => {
      cache = null;
      renderedOwner = null;
      host.testCustomPluginLinks = void 0;
      document.querySelectorAll("[" + LINK_ATTRIBUTE + "]").forEach((link) => link.remove());
      schedule(0);
    });
    return {
      initialize,
      stopMonitoring,
      refresh() {
        cache = null;
        void processPluginIcons();
      }
    };
  }

  // client/src/features/chrome/plugin-icons-entry.ts
  var JE = optionalBridge();
  if (JE) {
    const icons = createPluginIcons(JE);
    const own = chromeContext(JE, ["initializePluginIcons", "stopPluginIconsMonitoring", "customPlugins"]).own;
    own.initializePluginIcons = icons.initialize;
    own.stopPluginIconsMonitoring = icons.stopMonitoring;
    own.customPlugins = { refresh: icons.refresh };
  }
})();
})();
//# sourceMappingURL=plugin-icons.js.map
