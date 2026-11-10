(() => {
"use strict";
(() => {
  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE;
  }
  function adminTagsApi(JE) {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
  }
  function isCore(facade) {
    return typeof facade.registerSection === "function" && typeof facade.fmt === "function" && Array.isArray(facade.sections);
  }
  function apiClient() {
    const client = host().ApiClient;
    if (!client) throw new ReferenceError("ApiClient is not defined");
    return client;
  }

  // client/src/features/media-tags/admin/dom.ts
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function findAs(scope, selector, type) {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
  }
  function allAs(scope, selector, type) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el) => el instanceof type) : [];
  }
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/server.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'server',
      title: 'Server tag cache',
      writes: ['ClearLocalStorageTimestamp', 'TagCacheExcludedLibraryIds'],
          { id: 'tagCacheServerMode', key: 'TagCacheServerMode', type: 'switch', label: 'Server-side tag cache' },
          { id: 'tagCacheExcludeLibraries', key: 'TagCacheExcludeLibraries', type: 'switch', label: 'Exclude libraries from the tag cache' },
          { id: 'enableTagsLocalStorageFallback', key: 'EnableTagsLocalStorageFallback', type: 'switch', label: 'Keep a tag cache in each browser' },
          { id: 'tagsCacheTtlDays', key: 'TagsCacheTtlDays', type: 'number', label: 'Browser tag cache lifetime' },
  registerSection({
      tab: 'server',
      title: 'Native poster tags',
          { id: 'nativePosterTagsEnabled', key: 'NativePosterTagsEnabled', type: 'switch', label: 'Native poster tags (experimental)' },
          { id: 'nativePosterTagsWebClientNames', key: 'NativePosterTagsWebClientNames', type: 'textarea', label: 'Additional excluded apps' },
  */
  var normId = (id) => String(id).replace(/-/g, "").toLowerCase();
  var excludedIds = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  function foldersOf(list) {
    if (list && !Array.isArray(list)) throw new TypeError("The library list is not an array");
    const out = [];
    for (const f of Array.isArray(list) ? list : []) {
      if (!f || typeof f !== "object") continue;
      const id = Reflect.get(f, "ItemId");
      if (!id) continue;
      const name = Reflect.get(f, "Name");
      out.push({ ItemId: String(id), Name: name === void 0 || name === null ? "" : String(name) });
    }
    return out;
  }
  installSection((A) => {
    const libraryState = /* @__PURE__ */ new WeakMap();
    const librariesOf = (ctx) => {
      let state = libraryState.get(ctx);
      if (!state) libraryState.set(ctx, state = { folders: null, failed: false });
      return state;
    };
    A.registerSection({
      id: "server-cache",
      tab: "server",
      order: 10,
      title: "Server tag cache",
      hint: "Tag data for every item, worked out on the server. Browsers download it once, in pages, keep a copy and then fetch only what changed.",
      writes: ["ClearLocalStorageTimestamp", "TagCacheExcludedLibraryIds"],
      fields: [
        { id: "tagCacheServerMode", key: "TagCacheServerMode", type: "switch", label: "Server-side tag cache", desc: "Tags load at once, without per-page requests. Off uses the older per-page mode and releases the cache; turning it on again restores the last copy and catches up in the background.", read: (v) => v !== false, onChange: (on) => on ? {} : { EnableTagsLocalStorageFallback: true }, master: true },
        { id: "tagCacheExcludeLibraries", key: "TagCacheExcludeLibraries", type: "switch", label: "Exclude libraries from the tag cache", desc: "For very large libraries that use a lot of memory to scan. Takes effect on the next rebuild.", when: (c) => c.TagCacheServerMode !== false },
        // Without the server cache the browser fallback cache is always used (as on the old page).
        { id: "enableTagsLocalStorageFallback", key: "EnableTagsLocalStorageFallback", type: "switch", label: "Keep a tag cache in each browser", desc: "Without the server cache, browsers keep tag data in local storage for faster repeat visits.", visible: (c) => c.TagCacheServerMode === false, when: () => false, read: () => true },
        { id: "tagsCacheTtlDays", key: "TagsCacheTtlDays", type: "number", min: 1, max: 365, fallback: 30, unit: "days", label: "Browser tag cache lifetime", desc: "How long browsers keep tag data fetched without the server cache, and People Tags facts (1-365). The server cache keeps itself current.", read: (v) => Number(v) || 30 }
      ],
      render(ctx, body) {
        body.innerHTML = `<div class="je-ta-libs" data-libs role="group" aria-label="${ctx.tx("Libraries to exclude")}"><p class="je-ta-hint">${ctx.tx("Loading…")}</p></div>
                <div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="rebuildTagCacheBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx("Rebuild cache")}</button>
                    <button type="button" class="je-ta-button" id="clearTagsCacheBtn"><span class="material-icons" aria-hidden="true">delete_sweep</span>${ctx.tx("Clear all browser caches")}</button>
                </div>
                <p class="je-ta-hint" data-cache-help></p>`;
        body.querySelector("#rebuildTagCacheBtn")?.addEventListener("click", () => {
          void A.rebuildCache?.(ctx);
        });
        body.querySelector("#clearTagsCacheBtn")?.addEventListener("click", async () => {
          const ok = await ctx.confirm(A.fmt("Every browser clears its quality and genre tag data on its next page load."), A.fmt("Clear all browser caches"));
          if (!ok) return;
          ctx.set("ClearLocalStorageTimestamp", Date.now());
          const saved = await ctx.flush();
          if (ctx.isCurrent()) ctx.snack(A.fmt(saved ? "Clear signal sent. Browsers clear their caches on their next load." : "The clear signal could not be saved. Check the server log."));
        });
        const libs = find(body, "[data-libs]");
        if (!libs) return;
        body.closest("[data-section]")?.querySelector('[data-field-row="tagCacheExcludeLibraries"]')?.after(libs);
        libs.addEventListener("change", (e) => {
          const box = closest(e, "input[data-library-id]");
          if (!(box instanceof HTMLInputElement) || !librariesOf(ctx).folders) return;
          const id = box.dataset.libraryId || "";
          const ids = excludedIds(ctx.config.TagCacheExcludedLibraryIds).filter((x) => normId(x) !== id);
          if (box.checked) ids.push(id);
          ctx.set("TagCacheExcludedLibraryIds", ids.join(","));
        });
        const state = librariesOf(ctx);
        const client = apiClient();
        client.getJSON(client.getUrl("Library/VirtualFolders")).then((list) => {
          if (!ctx.isCurrent()) return;
          state.folders = foldersOf(list);
          state.failed = false;
          ctx.refresh({ controls: false });
        }).catch(() => {
          if (!ctx.isCurrent()) return;
          state.failed = true;
          ctx.refresh({ controls: false });
        });
      },
      refresh(ctx, body) {
        if (!body) return;
        const c = ctx.config;
        const cacheOn = c.TagCacheServerMode !== false;
        const libs = find(body.closest("[data-section]") || body, "[data-libs]");
        if (!libs) return;
        libs.hidden = !(cacheOn && c.TagCacheExcludeLibraries === true);
        if (!ctx.isCurrent()) return;
        const { folders, failed } = librariesOf(ctx);
        if (!folders) {
          const key = failed ? "Could not load the library list. The current selection is kept." : "Loading…";
          if (libs.dataset.libsState !== key) {
            libs.dataset.libsState = key;
            libs.innerHTML = `<p class="je-ta-hint">${ctx.tx(key)}</p>`;
          }
        } else {
          const selected = excludedIds(c.TagCacheExcludedLibraryIds).map(normId);
          const ids = folders.map((f) => normId(f.ItemId));
          const rows = allAs(libs, "input[data-library-id]", HTMLInputElement);
          if (libs.dataset.libsState === "list" && rows.length === ids.length && rows.every((r, i) => r.dataset.libraryId === ids[i])) {
            rows.forEach((r, i) => {
              const id = ids[i] ?? "";
              r.checked = selected.includes(id);
              const name = r.nextElementSibling;
              const folder = folders[i];
              if (name && folder && name.textContent !== folder.Name) name.textContent = folder.Name;
            });
          } else {
            libs.dataset.libsState = "list";
            A.redrawList(
              libs,
              folders.map((f, i) => `<label><input type="checkbox" data-library-id="${ctx.esc(ids[i])}" ${selected.includes(ids[i] ?? "") ? "checked" : ""}><span>${ctx.esc(f.Name)}</span></label>`).join(""),
              (el) => el.dataset.libraryId ? `[data-library-id="${el.dataset.libraryId}"]` : null
            );
          }
        }
        const rebuild = findAs(body, "#rebuildTagCacheBtn", HTMLButtonElement);
        if (rebuild) rebuild.hidden = !cacheOn;
        const clear = findAs(body, "#clearTagsCacheBtn", HTMLButtonElement);
        if (clear) clear.hidden = cacheOn;
        const help = body.querySelector("[data-cache-help]");
        if (help) help.textContent = A.fmt(cacheOn ? "Rebuild re-computes every item's tags. Use it after an update changes how tags are worked out, or when asked to. Large libraries take a few minutes." : "Clearing makes every browser drop its tag data on its next load, which may be slow once.");
      }
    });
    A.registerSection({
      id: "server-native",
      tab: "server",
      order: 20,
      title: "Native poster tags",
      hint: "Each user's tags drawn into poster images, for apps that can't show the web overlays.",
      fields: [
        { id: "nativePosterTagsEnabled", key: "NativePosterTagsEnabled", type: "switch", label: "Native poster tags (experimental)", desc: "Uses each user's own tag choices, corners and order. Users can turn it off with Show Tags in Native Clients.", master: true },
        { id: "nativePosterTagsWebClientNames", key: "NativePosterTagsWebClientNames", type: "textarea", label: "Additional excluded apps", desc: "Apps that already show these tags themselves, such as a wrapper around the web UI, by their name under Dashboard › Devices; one per line or comma separated. Jellyfin Web, Media Player, Desktop, WebOS and Android are always excluded.", placeholder: "One per line", when: (c) => c.NativePosterTagsEnabled === true, hideWhenOff: true }
      ],
      render(ctx, body) {
        body.innerHTML = `<ul class="je-ta-list">${["Web-based apps already show the overlays and keep the original posters.", "Each poster is drawn the first time it is viewed, which uses some server CPU, then cached.", "Apps may need to reopen the library or restart to show changes.", "Original artwork files are never modified."].map((k) => `<li>${ctx.tx(k)}</li>`).join("")}</ul>`;
      }
    });
  });
})();
})();
//# sourceMappingURL=server.js.map
