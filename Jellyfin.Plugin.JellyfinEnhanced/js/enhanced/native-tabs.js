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
  function chromeBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must initialize before chrome modules");
    return host.JellyfinEnhanced;
  }
  function hostClient() {
    const host = window;
    return host.ApiClient;
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

  // client/src/features/chrome/native-tabs.ts
  var OWN_ID_PREFIX = "je-native-tab-";
  var RESERVED_ID_PREFIX = "je-native-tab-reserved-";
  var DEEP_LINK_PARAM = "jeTab";
  var LOG = "🪼 Jellyfin Enhanced: [native-tabs]";
  function isHomeHash(hash) {
    return hash === "" || hash === "#/home" || hash === "#/home.html" || hash.includes("#/home?") || hash.includes("#/home.html?");
  }
  function hashParam(hash, name) {
    const match = new RegExp("[?&]" + name + "=([^&]*)").exec(hash);
    if (!match) return null;
    const raw = match[1] ?? "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  function homeRoute(hash) {
    return hash.indexOf("#/home") === 0 ? hash.split("?")[0] ?? "#/home" : "#/home";
  }
  function deepLinkHash(hash, index, id) {
    return homeRoute(hash) + "?tab=" + index + "&" + DEEP_LINK_PARAM + "=" + encodeURIComponent(id);
  }
  function linkedTabIndex(href) {
    const match = /^#\/home(?:\.html)?\?(?:[^#]*&)?tab=(\d+)/.exec(href);
    return match ? parseInt(match[1] ?? "", 10) : null;
  }
  var isOwnSlot = (element) => element.id.indexOf(OWN_ID_PREFIX) === 0;
  var slotIndex = (element) => parseInt(element.getAttribute("data-index") ?? "", 10);
  var isTabs = (element) => element instanceof HTMLElement;
  function createNativeTabs(JE2, readClient) {
    const host = window;
    let entries = [];
    let injectPending = false;
    let appliedDeepLink = null;
    let rewrittenHash = null;
    let userPickedHash = null;
    let selectingTab = false;
    let watchedTabs = null;
    let lastTabStripInput = 0;
    let wasOffHomePage = false;
    let customTabCount = null;
    let customTabsFetching = false;
    let checkedSlider = null;
    let visibilityCache = {};
    let backdrop = null;
    let backdropLoading = false;
    const watchedBackgrounds = /* @__PURE__ */ new WeakSet();
    let scope = captureIdentity(JE2.session, readClient());
    const hash = () => window.location.hash;
    const ownerNow = () => captureIdentity(JE2.session, readClient());
    function syncScope() {
      const now = ownerNow();
      if (isSameIdentity(scope, now)) return;
      scope = now;
      customTabCount = null;
      customTabsFetching = false;
      checkedSlider = null;
      backdrop = null;
      backdropLoading = false;
      removeBorrowedBackdrop();
    }
    function getTabsRoot() {
      const panels = document.querySelectorAll('.tabContent.pageTabContent[data-index="0"]');
      for (let i = panels.length - 1; i >= 0; i--) {
        const root = panels[i]?.parentElement;
        if (root && JE2.helpers.isActiveTabContainer(root)) return root;
      }
      return null;
    }
    function setCustomTabCount(count) {
      if (count === customTabCount) return;
      customTabCount = count;
      scheduleInject();
    }
    function refreshCustomTabCount() {
      if (customTabsFetching) return;
      if (JE2.hasCustomTabs === false) {
        setCustomTabCount(0);
        return;
      }
      const client = readClient();
      if (!client) return;
      const owner = scope;
      customTabsFetching = true;
      const request = (async () => client.fetch({
        url: client.getUrl("CustomTabs/Config"),
        type: "GET",
        dataType: "json",
        headers: { accept: "application/json" }
      }))();
      request.then((configs) => Array.isArray(configs) ? configs.length : 0, () => customTabCount || 0).then((count) => {
        if (owner !== scope) return;
        customTabsFetching = false;
        setCustomTabCount(count);
      });
    }
    function highestForeignIndex(slider, root) {
      let max = Math.max(1, (customTabCount || 0) + 1);
      const consider = (index) => {
        if (index !== null && !isNaN(index) && index > max) max = index;
      };
      slider.querySelectorAll(".emby-tab-button").forEach((el) => {
        if (!isOwnSlot(el)) consider(slotIndex(el));
      });
      root.querySelectorAll(".tabContent").forEach((el) => {
        if (!isOwnSlot(el)) consider(slotIndex(el));
      });
      document.querySelectorAll('a[href*="#/home?"], a[href*="#/home.html?"]').forEach((el) => {
        if (el.closest(`[id^="${OWN_ID_PREFIX}"]`)) return;
        consider(linkedTabIndex(el.getAttribute("href") || ""));
      });
      return max;
    }
    function relabel(entry, index) {
      const previous = entry.index;
      entry.index = index;
      const btn = document.getElementById(OWN_ID_PREFIX + "btn-" + entry.id);
      const panel = document.getElementById(OWN_ID_PREFIX + "panel-" + entry.id);
      btn?.setAttribute("data-index", String(index));
      panel?.setAttribute("data-index", String(index));
      if (previous == null) return;
      const tabs2 = document.querySelector('[is="emby-tabs"]');
      if (isTabs(tabs2) && btn?.classList.contains("emby-tab-button-active") && tabs2.selectedTabIndex === previous) tabs2.selectedTabIndex = index;
      console.log(`${LOG} "${entry.title}" moved from index ${previous} to ${index} (another tab now uses ${previous})`);
    }
    function createReservedSlot(kind, index) {
      let el;
      if (kind === "btn") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "emby-tab-button hide";
        button.tabIndex = -1;
        button.setAttribute("aria-hidden", "true");
        el = button;
      } else {
        el = document.createElement("div");
        el.className = "tabContent pageTabContent";
      }
      el.id = RESERVED_ID_PREFIX + kind + "-" + index;
      el.setAttribute("data-index", String(index));
      return el;
    }
    function alignSlots(container, kind, lastIndex) {
      const selector = kind === "btn" ? ".emby-tab-button" : ".tabContent";
      const items = () => [...container.querySelectorAll(selector)].filter((el) => el.parentElement === container);
      let changed = false;
      const claimed = /* @__PURE__ */ new Set();
      for (const el of items()) if (!isOwnSlot(el)) claimed.add(slotIndex(el));
      for (const entry of entries) if (entry.index != null) claimed.add(entry.index);
      for (const el of items()) {
        if (el.id.indexOf(RESERVED_ID_PREFIX) !== 0) continue;
        const index = slotIndex(el);
        if (claimed.has(index) || index >= lastIndex) {
          el.remove();
          changed = true;
        }
      }
      for (let i = 2; i < lastIndex; i++) {
        if (claimed.has(i)) continue;
        const slot = document.getElementById(RESERVED_ID_PREFIX + kind + "-" + i);
        if (slot && slot.parentElement === container) continue;
        container.appendChild(slot || createReservedSlot(kind, i));
        changed = true;
      }
      const all = items();
      if (all.some((el) => isNaN(slotIndex(el)))) return changed;
      const head = all.filter((el) => slotIndex(el) < 2);
      const tabs2 = all.filter((el) => slotIndex(el) >= 2);
      const sorted = tabs2.slice().sort((x, y) => slotIndex(x) - slotIndex(y) || tabs2.indexOf(x) - tabs2.indexOf(y));
      let ref = head[head.length - 1] ?? null;
      for (const el of sorted) {
        const target = ref ? ref.nextElementSibling : container.firstElementChild;
        if (target !== el) {
          container.insertBefore(el, target);
          changed = true;
        }
        ref = el;
      }
      return changed;
    }
    function mount(entry, panel) {
      try {
        entry.onMount(panel);
      } catch (error) {
        console.error(`${LOG} "${entry.title}" failed to mount:`, error);
      }
    }
    function ensureInjected() {
      if (entries.length === 0) return;
      if (!isHomeHash(hash())) {
        if (!wasOffHomePage) {
          wasOffHomePage = true;
          console.debug(`${LOG} not on home page (hash=${hash()}), skipping`);
        }
        return;
      }
      wasOffHomePage = false;
      syncScope();
      const slider = document.querySelector(".emby-tabs-slider");
      const root = getTabsRoot();
      if (!slider || !root) {
        console.debug(`${LOG} waiting for DOM - .emby-tabs-slider ${slider ? "found" : "MISSING"}, tab panel root ${root ? "found" : "MISSING"}`);
        return;
      }
      if (slider !== checkedSlider) {
        checkedSlider = slider;
        refreshCustomTabCount();
      }
      const tabsElement = slider.closest('[is="emby-tabs"]');
      watchUserTabChanges(isTabs(tabsElement) ? tabsElement : null);
      let addedTabButton = false;
      let nextIndex = highestForeignIndex(slider, root) + 1;
      for (const entry of entries) {
        const index = nextIndex++;
        if (entry.index !== index) relabel(entry, index);
        if (!document.getElementById(OWN_ID_PREFIX + "btn-" + entry.id)) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("is", "emby-button");
          btn.id = OWN_ID_PREFIX + "btn-" + entry.id;
          btn.className = "emby-tab-button";
          btn.setAttribute("data-index", String(entry.index));
          const label = document.createElement("div");
          label.className = "emby-button-foreground";
          label.textContent = entry.title;
          btn.appendChild(label);
          slider.appendChild(btn);
          host.CustomElements?.upgradeSubtree?.(slider);
          addedTabButton = true;
          console.log(`${LOG} added tab button "${entry.title}" at data-index=${entry.index}`);
        }
        const existing = document.getElementById(OWN_ID_PREFIX + "panel-" + entry.id);
        if (!existing) {
          const panel = document.createElement("div");
          panel.id = OWN_ID_PREFIX + "panel-" + entry.id;
          panel.className = "tabContent pageTabContent";
          panel.setAttribute("data-index", String(entry.index));
          root.appendChild(panel);
          mount(entry, panel);
          console.log(`${LOG} added tab panel "${entry.title}" at data-index=${entry.index}`);
        } else if (existing.parentElement !== root) {
          existing.classList.remove("is-active");
          root.appendChild(existing);
        }
      }
      const lastIndex = entries[entries.length - 1]?.index ?? 0;
      if (alignSlots(slider, "btn", lastIndex)) addedTabButton = true;
      alignSlots(root, "panel", lastIndex);
      for (const entry of entries) {
        const btn = document.getElementById(OWN_ID_PREFIX + "btn-" + entry.id);
        if (btn) isTabButtonVisible(btn, entry.id);
      }
      entries.forEach(ensureDiscoverable);
      if (addedTabButton) {
        const tabs2 = document.querySelector('[is="emby-tabs"]');
        if (isTabs(tabs2)) tabs2.refresh?.();
      }
      syncDeepLink(slider, root);
    }
    function getOrCreateGroup(headerRight) {
      const existing = document.getElementById("je-native-tabs-group");
      if (existing) return existing;
      const group = document.createElement("div");
      group.id = "je-native-tabs-group";
      group.style.cssText = "display:flex;align-items:center;order:-1;";
      const separator = document.createElement("span");
      separator.id = "je-native-tabs-separator";
      separator.setAttribute("aria-hidden", "true");
      separator.style.cssText = "display:inline-block;width:1px;height:1.4em;margin:0 0.5em;background:rgba(255,255,255,0.3);";
      group.appendChild(separator);
      headerRight.appendChild(group);
      return group;
    }
    function removeGroupIfEmpty() {
      const group = document.getElementById("je-native-tabs-group");
      if (group && group.children.length <= 1) group.remove();
    }
    function isTabButtonVisible(btn, id) {
      const cached = visibilityCache[id];
      const now = Date.now();
      if (cached && cached.btn === btn && now - cached.ts < 1e3) return cached.visible;
      const visible = btn.offsetParent !== null;
      visibilityCache[id] = { btn, ts: now, visible };
      return visible;
    }
    function ensureDiscoverable(entry) {
      const btn = document.getElementById(OWN_ID_PREFIX + "btn-" + entry.id);
      const linkId = OWN_ID_PREFIX + "link-" + entry.id;
      if (entry.index == null || btn && isTabButtonVisible(btn, entry.id)) {
        document.getElementById(linkId)?.remove();
        removeGroupIfEmpty();
        return;
      }
      if (document.getElementById(linkId)) return;
      const headerRight = JE2.helpers.getHeaderButtonTray?.();
      if (!headerRight) return;
      if (document.getElementById(linkId)) return;
      const group = getOrCreateGroup(headerRight);
      const separator = document.getElementById("je-native-tabs-separator");
      const link = document.createElement("button");
      link.id = linkId;
      link.type = "button";
      link.setAttribute("is", "paper-icon-button-light");
      link.className = "headerButton headerButtonRight paper-icon-button-light";
      link.title = entry.title;
      const icon = document.createElement("i");
      icon.className = "material-icons";
      icon.textContent = entry.icon || "tab";
      link.appendChild(icon);
      link.addEventListener("click", () => {
        if (entry.index != null) window.location.hash = deepLinkHash(hash(), entry.index, entry.id);
      });
      group.insertBefore(link, separator);
      console.log(`${LOG} tab button for "${entry.title}" is hidden (experimental layout), added header-tray fallback link`);
    }
    function watchUserTabChanges(tabs2) {
      if (!tabs2 || tabs2 === watchedTabs) return;
      watchedTabs = tabs2;
      tabs2.addEventListener("beforetabchange", (event) => {
        if (selectingTab) return;
        const urlIndex = parseInt(hashParam(hash(), "tab") ?? "", 10);
        const picked = parseInt(String(event instanceof CustomEvent ? event.detail?.selectedTabIndex : void 0), 10);
        if (picked !== (isNaN(urlIndex) ? 0 : urlIndex) || Date.now() - lastTabStripInput < 1e3) userPickedHash = hash();
      });
      tabs2.addEventListener("tabchange", (event) => {
        const picked = parseInt(String(event instanceof CustomEvent ? event.detail?.selectedTabIndex : void 0), 10);
        setTimeout(() => {
          clearStraySelection(tabs2, picked);
          syncBackdrop();
        }, 0);
      });
    }
    function clearStraySelection(tabs2, index) {
      const root = getTabsRoot();
      if (!root || isNaN(index) || tabs2.selectedIndex?.() !== index) return;
      const btn = tabs2.querySelectorAll(".emby-tab-button")[index];
      const panel = root.querySelectorAll(".tabContent")[index];
      if (!btn || !panel || slotIndex(btn) !== index || slotIndex(panel) !== index) return;
      if (!btn.classList.contains("emby-tab-button-active") || !panel.classList.contains("is-active")) return;
      root.querySelectorAll(".tabContent.is-active").forEach((el) => {
        if (el !== panel) el.classList.remove("is-active");
      });
      tabs2.querySelectorAll(".emby-tab-button-active").forEach((el) => {
        if (el !== btn) el.classList.remove("emby-tab-button-active");
      });
    }
    function syncDeepLink(slider, root) {
      const wantedId = hashParam(hash(), DEEP_LINK_PARAM);
      let wantedIndex = parseInt(hashParam(hash(), "tab") ?? "", 10);
      const entry = wantedId != null ? entries.find((e) => e.id === wantedId) : void 0;
      if (entry && entry.index != null && entry.index !== wantedIndex) {
        const staleHash = hash();
        const freshHash = deepLinkHash(staleHash, entry.index, entry.id);
        rewrittenHash = freshHash;
        history.replaceState(history.state, "", window.location.pathname + window.location.search + freshHash);
        wantedIndex = entry.index;
        if (userPickedHash === staleHash) userPickedHash = freshHash;
        const ownPanel = document.getElementById(OWN_ID_PREFIX + "panel-" + entry.id);
        if (appliedDeepLink && appliedDeepLink.hash === staleHash && appliedDeepLink.panel === ownPanel) {
          appliedDeepLink.hash = hash();
          appliedDeepLink.btn = document.getElementById(OWN_ID_PREFIX + "btn-" + entry.id);
        }
      }
      if (isNaN(wantedIndex) || wantedIndex < 2) return;
      if (userPickedHash === hash()) return;
      const found = slider.closest('[is="emby-tabs"]') || document.querySelector('[is="emby-tabs"]');
      const tabs2 = isTabs(found) ? found : null;
      const btn = tabs2?.querySelectorAll(".emby-tab-button")[wantedIndex];
      const panel = root.querySelectorAll(".tabContent")[wantedIndex];
      const select = tabs2?.selectedIndex?.bind(tabs2);
      if (!tabs2 || !select || !btn || !panel || slotIndex(btn) !== wantedIndex || slotIndex(panel) !== wantedIndex) return;
      const current = hash();
      if (appliedDeepLink && appliedDeepLink.hash === current && appliedDeepLink.root === root && appliedDeepLink.panel === panel && appliedDeepLink.tabs === tabs2) {
        const stillSelected = select() === wantedIndex && panel.classList.contains("is-active") && ![...tabs2.querySelectorAll(".emby-tab-button-active")].some((el) => el !== btn);
        if (appliedDeepLink.btn === btn || !stillSelected) {
          appliedDeepLink.btn = btn;
          return;
        }
      }
      const strays = () => [...root.querySelectorAll(".tabContent.is-active")].filter((el) => el !== panel).concat([...tabs2.querySelectorAll(".emby-tab-button-active")].filter((el) => el !== btn));
      const isApplied = () => select() === wantedIndex && panel.classList.contains("is-active") && btn.classList.contains("emby-tab-button-active") && strays().length === 0;
      if (!isApplied()) {
        selectingTab = true;
        try {
          select(wantedIndex);
        } finally {
          selectingTab = false;
        }
        strays().forEach((el) => el.classList.remove("is-active", "emby-tab-button-active"));
      }
      if (isApplied()) appliedDeepLink = { hash: current, root, panel, tabs: tabs2, btn };
    }
    function removeBorrowedBackdrop() {
      const bg = document.querySelector(".backgroundContainer");
      const holder = document.querySelector(".backdropContainer");
      const mine = holder?.querySelector(".je-backdrop");
      if (!bg || !holder || !mine) return;
      mine.remove();
      const other = [...holder.querySelectorAll(".backdropImage")].some((el) => el.style.backgroundImage);
      if (!other) bg.classList.remove("withBackdrop");
    }
    function syncBackdrop() {
      const bg = document.querySelector(".backgroundContainer");
      const holder = document.querySelector(".backdropContainer");
      if (!bg || !holder) return;
      syncScope();
      const onOurPage = !!document.querySelector("#indexPage .tabContent.is-active :is(.jellyfinenhanced, .sections.bookmarks)");
      if (!onOurPage || !isHomeHash(hash())) {
        removeBorrowedBackdrop();
        return;
      }
      if (!watchedBackgrounds.has(bg)) {
        watchedBackgrounds.add(bg);
        new MutationObserver(syncBackdrop).observe(bg, { attributes: true, attributeFilter: ["class"] });
      }
      if (bg.classList.contains("withBackdrop")) return;
      const borrowed = backdrop;
      if (borrowed && isSameIdentity(borrowed.owner, scope)) {
        holder.querySelector(".je-backdrop")?.remove();
        const el = document.createElement("div");
        el.className = "backdropImage displayingBackdropImage je-backdrop";
        el.style.zIndex = "auto";
        el.style.backgroundImage = `url("${borrowed.url}")`;
        holder.appendChild(el);
        bg.classList.add("withBackdrop");
        return;
      }
      if (backdropLoading) return;
      const client = readClient();
      if (!client) return;
      const owner = scope;
      backdropLoading = true;
      const finish = () => {
        if (owner === scope) backdropLoading = false;
      };
      (async () => client.getItems(client.getCurrentUserId(), {
        SortBy: "Random",
        Limit: 1,
        Recursive: true,
        IncludeItemTypes: "Movie,Series",
        ImageTypes: "Backdrop"
      }))().then((response) => {
        if (owner !== scope || !isSameIdentity(owner, ownerNow())) return;
        const items = typeof response === "object" && response !== null && "Items" in response ? response.Items : null;
        const item = Array.isArray(items) ? items[0] : null;
        if (typeof item !== "object" || item === null || !("Id" in item) || typeof item.Id !== "string") return;
        const tags = "BackdropImageTags" in item ? item.BackdropImageTags : null;
        const tag = Array.isArray(tags) ? tags[0] : null;
        if (typeof tag !== "string" || !tag) return;
        backdrop = { owner, url: client.getImageUrl(item.Id, { type: "Backdrop", tag, maxWidth: 1920, quality: 70 }) };
        finish();
        syncBackdrop();
      }).catch(() => {
      }).then(finish);
    }
    function scheduleInject() {
      if (injectPending) return;
      injectPending = true;
      JE2.core.dom.afterNextPaint(() => {
        injectPending = false;
        ensureInjected();
        syncBackdrop();
      });
    }
    const facade = {
      /** Register a self-contained Home tab. Repeated registration of an id is a no-op. */
      register(id, title, onMount, icon) {
        if (entries.some((e) => e.id === id)) return;
        entries.push({ id, title, onMount, icon, index: null });
        console.log(`${LOG} registered "${title}" (id=${id})`);
        scheduleInject();
      },
      unregister(id) {
        entries = entries.filter((e) => e.id !== id);
        delete visibilityCache[id];
        document.getElementById(OWN_ID_PREFIX + "btn-" + id)?.remove();
        document.getElementById(OWN_ID_PREFIX + "panel-" + id)?.remove();
        document.getElementById(OWN_ID_PREFIX + "link-" + id)?.remove();
        removeGroupIfEmpty();
      }
    };
    function noteTabStripInput(event) {
      if (event.isTrusted && event.target instanceof Element && event.target.closest('[is="emby-tabs"]')) lastTabStripInput = Date.now();
    }
    function start() {
      document.addEventListener("pointerdown", noteTabStripInput, { capture: true, passive: true });
      document.addEventListener("keydown", noteTabStripInput, { capture: true, passive: true });
      JE2.helpers.observeTabContainers("native-tabs", '.tabContent.pageTabContent[data-index="0"]', scheduleInject);
      JE2.core.navigation.onNavigate(() => {
        if (hash() !== rewrittenHash) {
          appliedDeepLink = null;
          userPickedHash = null;
        }
        rewrittenHash = null;
        scheduleInject();
      });
      JE2.core.navigation.onViewPage(scheduleInject, { fetchItem: false });
      JE2.session?.onUserChange("native-tabs", () => {
        appliedDeepLink = null;
        userPickedHash = null;
        visibilityCache = {};
        syncScope();
        scheduleInject();
      });
    }
    return { facade, start };
  }

  // client/src/features/chrome/native-tabs-entry.ts
  var JE = chromeBridge();
  var tabs = createNativeTabs(JE, () => hostClient());
  chromeContext(JE, ["nativeTabs"]).own.nativeTabs = tabs.facade;
  tabs.start();
})();
})();
//# sourceMappingURL=native-tabs.js.map
