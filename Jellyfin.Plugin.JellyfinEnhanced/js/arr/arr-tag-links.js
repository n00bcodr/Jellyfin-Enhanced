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

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export9 = /* @__PURE__ */ sharedExport(shared, "serverId");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "sessionLease");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "visibleDetailPage");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export12 = /* @__PURE__ */ sharedExport(shared3, "navigateRoute");
  var export4 = /* @__PURE__ */ sharedExport(shared3, "tagListRoute");

  // client/src/features/details-providers/arr-domain.ts
  function slugifyTagName(name) {
    try {
      return name.toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "-").replace(/--+/g, "-").replace(/^-+|-+$/g, "");
    } catch {
      return name;
    }
  }
  var lines = (raw, prefix) => raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).map((line) => `${prefix}${line}`);
  function relevantArrTags(tags, prefix, allowRaw, hideRaw) {
    const allowed = lines(allowRaw, prefix).map((tag) => tag.toLowerCase());
    const hidden = lines(hideRaw, prefix).map((tag) => tag.toLowerCase());
    let relevant = tags.filter((tag) => tag.startsWith(prefix));
    if (hidden.length > 0) relevant = relevant.filter((tag) => !hidden.includes(tag.toLowerCase()));
    if (allowed.length > 0) relevant = relevant.filter((tag) => allowed.includes(tag.toLowerCase()));
    return relevant;
  }

  // client/src/features/details-providers/arr-tag-links.ts
  var JE = export1("Arr tag links");
  JE.initializeArrTagLinksScript = async function initializeArrTagLinksScript() {
    const logPrefix = "🪼 Jellyfin Enhanced: Arr Tag Links:";
    if (!JE.pluginConfig?.ArrTagsShowAsLinks) {
      console.log(`${logPrefix} Tag links display disabled in plugin settings.`);
      return;
    }
    console.log(`${logPrefix} Initializing...`);
    let isAddingLinks = false;
    let rescan = false;
    const withoutTags = /* @__PURE__ */ new Set();
    JE.session?.onUserChange("arr-tag-links", () => withoutTags.clear());
    function removeLinks(container) {
      container.querySelectorAll(".arr-tag-link").forEach((link) => {
        if (link.previousSibling?.nodeType === Node.TEXT_NODE) link.previousSibling.remove();
        link.remove();
      });
    }
    async function addTagLinks(itemId, externalLinksContainer) {
      if (isAddingLinks) {
        rescan = true;
        return;
      }
      const existing = externalLinksContainer.querySelector(".arr-tag-link");
      if (existing && existing.dataset.itemId === itemId) return;
      removeLinks(externalLinksContainer);
      if (withoutTags.has(itemId)) return;
      isAddingLinks = true;
      const session = export10(JE.session);
      const stillValid = () => session() && export3() === itemId && externalLinksContainer.isConnected && export11()?.contains(externalLinksContainer) === true;
      try {
        const item = await export7(JE.helpers, itemId, false);
        if (!stillValid()) return;
        const tags = item?.Tags ?? [];
        const tagPrefix = JE.pluginConfig?.ArrTagsPrefix || "JE Arr Tag: ";
        const relevantTags = tags.length === 0 ? [] : relevantArrTags(
          tags,
          tagPrefix,
          JE.pluginConfig?.ArrTagsLinksFilter || "",
          JE.pluginConfig?.ArrTagsLinksHideFilter || ""
        );
        if (relevantTags.length === 0) {
          withoutTags.add(itemId);
          return;
        }
        if (externalLinksContainer.querySelector(".arr-tag-link")) return;
        const server = export9();
        for (const tag of relevantTags) {
          externalLinksContainer.appendChild(document.createTextNode(" "));
          const tagName = tag.slice(tagPrefix.length).trim();
          const slug = slugifyTagName(tagName);
          const route = export4(tag, server);
          const link = document.createElement("a");
          link.setAttribute("is", "emby-linkbutton");
          link.className = "button-link emby-button arr-tag-link";
          link.href = `#!/${route}`;
          link.title = `View all items with tag: ${tag}`;
          link.addEventListener("click", (event) => {
            event.preventDefault();
            export12(route);
          });
          link.dataset.itemId = itemId;
          link.dataset.id = slug;
          link.dataset.tag = tag;
          link.dataset.tagName = tagName;
          link.dataset.tagPrefix = tagPrefix;
          const icon = document.createElement("span");
          icon.className = "arr-tag-link-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.innerHTML = JE.icon(JE.IconName.TAG);
          icon.style.marginRight = "5px";
          const label = document.createElement("span");
          label.className = "arr-tag-link-text";
          label.dataset.id = slug;
          label.dataset.tag = tag;
          label.dataset.tagName = tagName;
          label.dataset.tagPrefix = tagPrefix;
          label.textContent = tag;
          link.append(icon, label);
          externalLinksContainer.appendChild(link);
        }
      } catch (err) {
        console.error(`${logPrefix} Error adding tag links:`, err);
      } finally {
        isAddingLinks = false;
        if (rescan) {
          rescan = false;
          scheduleCheck();
        }
      }
    }
    function checkAndAddLinks() {
      const externalLinksContainer = export11()?.querySelector(".itemExternalLinks");
      if (!externalLinksContainer) return;
      const itemId = export3();
      if (itemId) void addTagLinks(itemId, externalLinksContainer);
    }
    const scheduleCheck = JE.helpers.debounce(checkAndAddLinks, 100);
    JE.helpers.createObserver("arr-tag-links", () => {
      if (!JE.pluginConfig?.ArrTagsShowAsLinks) return;
      scheduleCheck();
    }, document.body, { childList: true, subtree: true });
    const lifecycle = JE.core.lifecycle.register("arr-tag-links");
    lifecycle.track(JE.core.navigation.onNavigate(scheduleCheck));
    lifecycle.track(JE.core.navigation.onViewPage(scheduleCheck));
    setTimeout(checkAndAddLinks, 500);
    console.log(`${logPrefix} Initialized successfully`);
  };
})();
})();
//# sourceMappingURL=arr-tag-links.js.map
