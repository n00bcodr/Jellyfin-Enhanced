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
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
  }

  // client/src/features/media-tags/admin/format.ts
  function word(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/overview.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'overview',
      title: 'Tag group defaults',
  */
  var GROUPS = [
    ["quality", "QualityTagsEnabled", "Quality"],
    ["genre", "GenreTagsEnabled", "Genre"],
    ["language", "LanguageTagsEnabled", "Language"],
    ["rating", "RatingTagsEnabled", "Rating"],
    ["ageRating", "AgeRatingTagsEnabled", "Age Rating"],
    ["status", "StatusTagsEnabled", "Status"],
    ["awards", "AwardsTagsEnabled", "Awards"],
    ["logos", "LogoTagsEnabled", "Logos"],
    ["custom", "CustomTagsEnabled", "Custom"],
    ["people", "PeopleTagsEnabled", "People"]
  ];
  function summaryOfAnswer(value) {
    if (!value || typeof value !== "object") return null;
    return { entries: Reflect.get(value, "entries"), lastModified: Reflect.get(value, "lastModified"), rebuilding: Reflect.get(value, "rebuilding") };
  }
  installSection((A, JE) => {
    A.GROUP_SWITCHES = GROUPS;
    const summaries = /* @__PURE__ */ new WeakMap();
    const summaryOf = (ctx) => {
      let state = summaries.get(ctx);
      if (!state) summaries.set(ctx, state = { summary: null, error: false, seq: 0, timer: null, wasRebuilding: false });
      return state;
    };
    const stopTimer = (state) => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    };
    const uiLocale = () => JE.core?.mediaLanguage?.uiLocale?.() || void 0;
    function ago(ms) {
      if (!ms) return A.fmt("Never");
      const seconds = Math.max(0, Math.round((Date.now() - Number(ms)) / 1e3));
      try {
        const rtf = new Intl.RelativeTimeFormat(uiLocale(), { numeric: "auto" });
        if (seconds < 60) return rtf.format(-seconds, "second");
        if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), "minute");
        if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), "hour");
        return rtf.format(-Math.round(seconds / 86400), "day");
      } catch {
        return new Date(Number(ms)).toLocaleString(uiLocale());
      }
    }
    function drawCache(ctx) {
      const grid = find(ctx.root, '.je-ta-ov[data-section="overview"]');
      if (!grid) return;
      const c = ctx.config;
      const t = (key, params) => A.fmt(key, params);
      const cacheOn = c.TagCacheServerMode !== false;
      const { summary, error: summaryError } = summaryOf(ctx);
      const rebuilding = !!summary?.rebuilding;
      const state = find(grid, '[data-ov="cache-state"]');
      if (state) {
        state.dataset.state = cacheOn ? rebuilding ? "warn" : "on" : "off";
        state.textContent = t(cacheOn ? rebuilding ? "Rebuilding" : "On" : "Off");
      }
      const excluded = c.TagCacheExcludeLibraries === true ? String(c.TagCacheExcludedLibraryIds || "").split(",").filter(Boolean).length : 0;
      const body = grid.querySelector('[data-ov="cache"]');
      if (body) body.innerHTML = !cacheOn ? `<p class="je-ta-hint">${ctx.tx("Off: browsers fetch tag data page by page and keep their own copy.")}</p>` : summaryError ? `<p class="je-ta-hint">${ctx.tx("The cache state could not be read. Check the server log.")}</p>` : `<div class="je-ta-stat"><strong>${ctx.esc(summary ? Number(summary.entries).toLocaleString(uiLocale()) : "…")}</strong><span>${ctx.tx("items cached")}</span></div><dl class="je-ta-ov-dl"><dt>${ctx.tx("Last change")}</dt><dd>${ctx.esc(summary ? ago(summary.lastModified) : "…")}</dd><dt>${ctx.tx("Excluded")}</dt><dd>${ctx.esc(excluded ? t("{n} {n|library|libraries}", { n: excluded }) : t("None"))}</dd></dl>`;
      const rebuild = findAs(grid, '[data-ov="rebuild"]', HTMLButtonElement);
      if (rebuild) rebuild.disabled = !cacheOn || rebuilding;
    }
    async function cacheSummary(ctx) {
      const state = summaryOf(ctx);
      const seq = ++state.seq;
      stopTimer(state);
      let next = state.summary;
      let failed = false;
      try {
        const client = apiClient();
        next = summaryOfAnswer(await client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/tag-cache/summary"), dataType: "json" }));
      } catch (err) {
        failed = true;
        if (seq === state.seq && ctx.isCurrent()) console.warn("🪼 Jellyfin Enhanced: could not read the tag cache summary", err);
      }
      if (seq !== state.seq || !ctx.isCurrent()) return;
      const finished = state.wasRebuilding && next?.rebuilding === false && !failed;
      state.wasRebuilding = next?.rebuilding === true;
      state.summary = next;
      state.error = failed;
      drawCache(ctx);
      if (state.summary?.rebuilding) state.timer = setTimeout(() => {
        void cacheSummary(ctx);
      }, 3e3);
      if (finished) ctx.snack(A.fmt("Tag cache rebuilt: {count} {count|item|items} cached.", { count: Number(state.summary?.entries) }));
    }
    A.cacheSummary = cacheSummary;
    async function rebuildCache(ctx) {
      const unsaved = () => {
        if (ctx.isCurrent()) ctx.snack(A.fmt("Not rebuilt: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then rebuild again."));
      };
      if (!await ctx.flush()) {
        unsaved();
        return;
      }
      if (!ctx.isCurrent()) return;
      const ok = await ctx.confirm(A.fmt("This re-scans the whole library in the background and may take a few minutes. Tags keep serving from the existing cache until the rebuild is done."), A.fmt("Rebuild the server tag cache?"));
      if (!ok) return;
      if (!await ctx.flush()) {
        unsaved();
        return;
      }
      if (!ctx.isCurrent()) return;
      try {
        const client = apiClient();
        const res = await client.ajax({ type: "POST", url: client.getUrl("/JellyfinEnhanced/tag-cache/rebuild"), dataType: "json" });
        if (!ctx.isCurrent()) return;
        const message = res && typeof res === "object" ? Reflect.get(res, "message") : void 0;
        ctx.snack((message ? String(message) : "") || A.fmt("Rebuilding the tag cache in the background."));
      } catch (err) {
        if (!ctx.isCurrent()) return;
        const status = err && typeof err === "object" ? Reflect.get(err, "status") : void 0;
        ctx.snack(A.fmt(status === 409 ? "A tag cache rebuild is already in progress." : status === 400 ? "Turn on the server tag cache first." : "The rebuild could not start. Check the server log."));
        if (status !== 409 && status !== 400) console.error("🪼 Jellyfin Enhanced: tag cache rebuild failed to start", err);
      }
      void cacheSummary(ctx);
    }
    A.rebuildCache = rebuildCache;
    A.registerSection({
      id: "overview",
      tab: "overview",
      order: 10,
      title: "Tag group defaults",
      render(ctx, body) {
        const card = body.closest(".je-ta-card");
        if (!card) return;
        card.outerHTML = `<div class="je-ta-ov" data-section="overview">
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">label</span>${ctx.tx("Tag group defaults")} ${ctx.perUserMark()}</h3><p class="je-ta-hint">${ctx.tx("Open a group to change its settings.")}</p><div class="je-ta-ov-groups" data-ov="groups"></div></section>
                <section class="je-ta-card je-ta-ov-wide"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">view_quilt</span>${ctx.tx("Default look")} ${ctx.perUserMark()}</h3><dl class="je-ta-ov-dl" data-ov="look"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="layout"><span class="je-ta-link-text">${ctx.tx("Change layout defaults")}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">storage</span>${ctx.tx("Server tag cache")}</h3><span class="je-ta-state" data-ov="cache-state"></span></div><div data-ov="cache"></div><div class="je-ta-actions"><button type="button" class="je-ta-button" data-ov="rebuild"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx("Rebuild cache")}</button></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">devices</span>${ctx.tx("Native poster tags")}</h3><span class="je-ta-state" data-ov="native-state"></span></div><p class="je-ta-hint">${ctx.tx("Draws tags into poster images for apps that can't show the web overlays, such as Android TV.")}</p><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="server"><span class="je-ta-link-text">${ctx.tx("Server settings")}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">palette</span>${ctx.tx("Tag colours")}</h3><span class="je-ta-state" data-ov="colours-state"></span></div><dl class="je-ta-ov-dl" data-ov="colours"></dl><div class="je-ta-actions"><a class="je-ta-link" href="#" data-je-goto="colours"><span class="je-ta-link-text">${ctx.tx("Edit colours")}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a></div></section>
                <section class="je-ta-card" data-je-anchor="apply"><div class="je-ta-card-head"><h3 class="je-ta-card-title"><span class="material-icons je-ta-card-icon" aria-hidden="true">group</span>${ctx.tx("Apply defaults to all users")}</h3></div><p class="je-ta-hint">${ctx.tx("Copies the saved Jellyfin Enhanced defaults into every user's settings, replacing what they chose themselves.")}</p><div class="je-ta-actions"><button type="button" class="je-ta-button je-ta-button--danger" id="jeTaApplyAll"><span class="material-icons" aria-hidden="true">group</span>${ctx.tx("Apply defaults to all users")}</button></div></section>
            </div>`;
        const grid = find(ctx.root, '.je-ta-ov[data-section="overview"]');
        if (!grid) return;
        grid.querySelector('[data-ov="rebuild"]')?.addEventListener("click", () => {
          void rebuildCache(ctx);
        });
        grid.querySelector("#jeTaApplyAll")?.addEventListener("click", async () => {
          const ok = await ctx.confirm(A.fmt("Every user's Jellyfin Enhanced settings (all of them, not only Media Tags) are replaced with the saved defaults. This cannot be undone; users would have to set their own preferences again."), A.fmt("Apply defaults to all users"));
          if (!ok) return;
          const saved = await ctx.flush();
          if (!ctx.isCurrent()) return;
          if (!saved) {
            ctx.snack(A.fmt("The defaults could not be applied. Check the server log."));
            return;
          }
          try {
            const client = apiClient();
            await client.ajax({ type: "POST", url: client.getUrl("/JellyfinEnhanced/reset-all-users-settings"), dataType: "json" });
            if (!ctx.isCurrent()) return;
            ctx.snack(A.fmt("The defaults now apply to every user. They take effect after users reload."));
          } catch (err) {
            if (!ctx.isCurrent()) return;
            console.error("🪼 Jellyfin Enhanced: applying the defaults to all users failed", err);
            ctx.snack(A.fmt("The defaults could not be applied. Check the server log."));
          }
        });
        grid.querySelector('[data-ov="groups"]')?.addEventListener("click", (e) => {
          const button = closest(e, "[data-group]");
          if (button) ctx.openTab("groups", { group: button.dataset.group, focus: true });
        });
      },
      show(ctx) {
        void cacheSummary(ctx);
      },
      refresh(ctx) {
        const grid = find(ctx.root, '.je-ta-ov[data-section="overview"]');
        if (!grid) return;
        const c = ctx.config;
        const t = (key, params) => A.fmt(key, params);
        const set = (name, html) => {
          const el = grid.querySelector(`[data-ov="${name}"]`);
          if (el) el.innerHTML = html;
        };
        const state = (name, on, label) => {
          const el = find(grid, `[data-ov="${name}"]`);
          if (el) {
            el.dataset.state = on;
            el.textContent = label;
          }
        };
        const groups = grid.querySelector('[data-ov="groups"]');
        if (groups) A.redrawList(
          groups,
          GROUPS.map(([id, key, name]) => `<button type="button" class="je-ta-ov-group" data-group="${id}" data-on="${c[key] === true}" aria-label="${ctx.esc(t("{name}: {state}. Open its settings", { name: t(name), state: t(c[key] === true ? "On" : "Off") }))}">${ctx.esc(t(name))}<span class="je-ta-ov-state" aria-hidden="true">· ${ctx.esc(t(c[key] === true ? "On" : "Off"))}</span><span class="material-icons" aria-hidden="true">chevron_right</span></button>`).join(""),
          (el) => el.dataset.group ? `[data-group="${el.dataset.group}"]` : null
        );
        const L = ctx.layout;
        const conf = L ? L.normalizeSettings(A.seedUser(c), c) : null;
        const order = conf?.order || L?.DEFAULT_ORDER || [];
        const groupName = (g) => t(word(A.WORDS.group, `${g === "ageRating" ? "age_rating" : g}`));
        const rules = Array.isArray(c.TagLookRules) ? c.TagLookRules.length : 0;
        set("look", [
          [t("Layout"), t(word(A.WORDS.layout, conf?.layout || "corners"))],
          [t("Labels"), t(word(A.WORDS.density, conf?.density || "full"))],
          [t("Group order"), order.map(groupName).join(", ")],
          [t("Rules"), rules ? t("{n} {n|rule|rules}", { n: rules }) : t("None")]
        ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(""));
        drawCache(ctx);
        state("native-state", c.NativePosterTagsEnabled === true ? "on" : "off", t(c.NativePosterTagsEnabled === true ? "On" : "Off"));
        const styles = c.TagStylesEnabled === true;
        state("colours-state", styles ? "on" : "off", t(styles ? "On" : "Off"));
        const target = typeof c.TagStyleTarget === "string" && ["web", "native", "both"].includes(c.TagStyleTarget) ? c.TagStyleTarget : "both";
        set("colours", [
          [t("Preset"), t(word(A.WORDS.preset, String(c.TagStylePreset || "default")))],
          [t("Applies to"), t(word(A.WORDS.styleTarget, target))],
          [t("Users pick a preset"), t(c.TagStylesAllowUserPreset === true ? "Allowed" : "Not allowed")]
        ].map(([k, v]) => `<dt>${ctx.esc(k)}</dt><dd>${ctx.esc(v)}</dd>`).join(""));
      },
      dispose(ctx) {
        const state = summaryOf(ctx);
        state.seq++;
        stopTimer(state);
      }
    });
  });
})();
})();
//# sourceMappingURL=overview.js.map
