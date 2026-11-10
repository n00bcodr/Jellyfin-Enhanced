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
  function optionalApiClient() {
    return host().ApiClient;
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

  // client/src/features/media-tags/admin/values.ts
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/badges.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  const FAMILY_FIELDS = [
      { id: 'statusTagsJustAdded', key: 'StatusTagsJustAdded', type: 'switch', label: 'Just Added' },
      { id: 'statusTagsNewRelease', key: 'StatusTagsNewRelease', type: 'switch', label: 'New releases' },
      { id: 'statusTagsTrending', key: 'StatusTagsTrending', type: 'switch', label: 'Trending' },
      { id: 'statusTagsSchedule', key: 'StatusTagsSchedule', type: 'switch', label: 'Schedule' },
      { id: 'statusTagsMilestones', key: 'StatusTagsMilestones', type: 'switch', label: 'Milestones' },
      { id: 'statusTagsSeriesStatus', key: 'StatusTagsSeriesStatus', type: 'switch', label: 'Series status' },
      { id: 'statusTagsScenes', key: 'StatusTagsScenes', type: 'switch', label: 'Scenes' },
      { id: 'statusTagsLeaving', key: 'StatusTagsLeaving', type: 'switch', label: 'Leaving soon' },
      { id: 'statusTagsDirectPlay', key: 'StatusTagsDirectPlay', type: 'switch', label: 'Direct-play warning' },
  ];
  registerSection({
      tab: 'badges',
      title: 'Badge families',
      fields: FAMILY_FIELDS,
  registerSection({
      tab: 'badges',
      title: 'Time windows',
          { id: 'statusTagsJustAddedDays', key: 'StatusTagsJustAddedDays', type: 'number', label: 'Just added' },
          { id: 'statusTagsNewReleaseDays', key: 'StatusTagsNewReleaseDays', type: 'number', label: 'New release' },
  registerSection({
      tab: 'badges',
      title: 'TMDB API key',
  registerSection({
      tab: 'badges',
      title: 'Leaving soon',
          { id: 'leavingSoonMaintainerrUrl', key: 'LeavingSoonMaintainerrUrl', type: 'text', label: 'Maintainerr URL' },
          { id: 'leavingSoonMaintainerrApiKey', key: 'LeavingSoonMaintainerrApiKey', type: 'text', label: 'Maintainerr API key' },
          { id: 'leavingSoonCollections', key: 'LeavingSoonCollections', type: 'textarea', label: 'Leaving collections' },
          { id: 'leavingSoonRefreshHours', key: 'LeavingSoonRefreshHours', type: 'number', label: 'Refresh every' },
  */
  var SAMPLES = {
    statusTagsJustAdded: ["added", "added", "Just Added"],
    statusTagsNewRelease: ["new", "newMovie", "New Movie"],
    statusTagsTrending: ["trending", "trending", "#{rank} Today"],
    statusTagsSchedule: ["schedule", "airing_today", "Airing Today"],
    statusTagsMilestones: ["milestone", "season_finale", "Season Finale"],
    statusTagsSeriesStatus: ["status", "returning", "Returning"],
    statusTagsScenes: ["scenes", "post_credits", "Post-credits"],
    statusTagsLeaving: ["leaving", "leaving", "Leaving in {days}d", { days: 5 }],
    statusTagsDirectPlay: ["playback", "direct_play", "Transcode"]
  };
  var FAMILY_FIELDS = [
    { id: "statusTagsJustAdded", key: "StatusTagsJustAdded", type: "switch", place: "section", label: "Just Added", desc: "Recently added to a library" },
    { id: "statusTagsNewRelease", key: "StatusTagsNewRelease", type: "switch", place: "section", label: "New releases", desc: "New Movie / New Series / New Episode" },
    { id: "statusTagsTrending", key: "StatusTagsTrending", type: "switch", place: "section", label: "Trending", desc: "Rank in TMDB's daily trending list (needs the TMDB API key), or Seerr's weekly list without one. Off also stops the server fetching the list." },
    { id: "statusTagsSchedule", key: "StatusTagsSchedule", type: "switch", place: "section", label: "Schedule", desc: "When a series’ next episode airs (needs the TMDB API key), and Coming Soon for movies and series that have not premiered yet." },
    { id: "statusTagsMilestones", key: "StatusTagsMilestones", type: "switch", place: "section", label: "Milestones", desc: "Season milestones from the library’s episode dates; Season Finale and Series Finale need the TMDB API key." },
    { id: "statusTagsSeriesStatus", key: "StatusTagsSeriesStatus", type: "switch", place: "section", label: "Series status", desc: "The series status, when no other badge applies. Jellyfin supplies Returning and Ended; TMDB can refine Ended to Cancelled. Off by default." },
    { id: "statusTagsScenes", key: "StatusTagsScenes", type: "switch", place: "section", label: "Scenes", desc: "Show a movie’s post-credits or mid-credits marker from TMDB keywords. Requires a TMDB key; refreshed daily." },
    { id: "statusTagsLeaving", key: "StatusTagsLeaving", type: "switch", place: "section", label: "Leaving soon", desc: "Items in Maintainerr's collections or the leaving collections (set the source under Leaving soon)." },
    { id: "statusTagsDirectPlay", key: "StatusTagsDirectPlay", type: "switch", place: "section", label: "Direct-play warning", desc: "Each browser checks the movies and episodes on screen against its own playback support (web only; native posters have no client profile). Items Jellyfin would probe to answer, .strm items and media never probed, are skipped." }
  ];
  function statusOfAnswer(value) {
    if (!value || typeof value !== "object") return null;
    const read = (key) => Reflect.get(value, key);
    return {
      LastError: read("LastError"),
      LastSuccess: read("LastSuccess"),
      NextRefresh: read("NextRefresh"),
      Collections: read("Collections"),
      CollectionsFound: read("CollectionsFound"),
      Items: read("Items"),
      Dated: read("Dated")
    };
  }
  var LEAVING_STATES = { "Up to date": "on", "No source set": "off" };
  function leavingState(configured, s) {
    const key = !configured ? "No source set" : !s ? "Status unavailable" : s.LastError ? "Last refresh failed: {error}" : s.LastSuccess ? "Up to date" : "Not read yet";
    return { key, state: own(LEAVING_STATES, key) ?? "warn" };
  }
  var numberOr = (value, fallback) => typeof value === "number" || typeof value === "string" ? value : value === null || value === void 0 ? fallback : String(value);
  installSection((A, JE) => {
    function chipHtml(ctx, sample) {
      if (!sample) return "";
      const [kind, status, labelKey, params] = sample;
      const label = kind === "trending" ? A.fmt(labelKey, { rank: 1 }) : A.fmt(labelKey, params);
      return `<span class="je-ta-chip" data-kind="status" data-je-status="${status}">${ctx.esc(label)}</span>`;
    }
    const leavingStates = /* @__PURE__ */ new WeakMap();
    function leavingOf(ctx) {
      let state = leavingStates.get(ctx);
      if (!state) leavingStates.set(ctx, state = { status: null, busy: false });
      return state;
    }
    function when(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
      try {
        return new Date(ms).toLocaleString(JE.core?.mediaLanguage?.uiLocale?.() || void 0);
      } catch {
        return new Date(ms).toISOString();
      }
    }
    async function loadLeavingStatus(ctx, refresh) {
      const leaving = leavingOf(ctx);
      const client = optionalApiClient();
      if (leaving.busy || !client) return;
      leaving.busy = true;
      const button = findAs(ctx.root, "#leavingSoonRefreshBtn", HTMLButtonElement);
      if (button) button.disabled = true;
      try {
        const saved = refresh ? await ctx.flush() : true;
        if (!ctx.isCurrent()) return;
        if (!saved) {
          ctx.snack(A.fmt("Not refreshed: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then refresh again."));
          return;
        }
        const answer = await client.ajax({
          type: refresh ? "POST" : "GET",
          url: client.getUrl(refresh ? "JellyfinEnhanced/admin/leaving-soon/refresh" : "JellyfinEnhanced/admin/leaving-soon"),
          dataType: "json"
        });
        if (!ctx.isCurrent()) return;
        leaving.status = statusOfAnswer(answer);
        if (refresh) ctx.snack(A.fmt(leaving.status?.LastError ? "Leaving soon refresh failed" : "Leaving soon refreshed"));
      } catch {
        if (!ctx.isCurrent()) return;
        leaving.status = null;
        if (refresh) ctx.snack(A.fmt("Leaving soon refresh failed"));
      } finally {
        leaving.busy = false;
        if (ctx.isCurrent()) ctx.refresh({ controls: false });
      }
    }
    A.registerSection({
      id: "badges-families",
      tab: "badges",
      order: 10,
      title: "Badge families",
      hint: "One badge per poster, first match wins (the order per card type is in the documentation). Users can override the family switches in their personal settings; the day windows apply to everyone.",
      fields: FAMILY_FIELDS,
      render(ctx, body) {
        body.innerHTML = `<p class="je-ta-off" data-badges-off>${ctx.tx("Status tags are off for new users, so none of these show.")} <a class="je-ta-link" href="#" data-je-goto="groups:status">${ctx.tx("Turn Status on")}</a></p><div class="je-ta-badges">${FAMILY_FIELDS.map((f) => `<div class="je-ta-badge">${A.fieldHtml(f, ctx.config)}<span class="je-ta-badge-sample" aria-hidden="true">${chipHtml(ctx, own(SAMPLES, f.id))}</span></div>`).join("")}</div>`;
      },
      refresh(ctx, body) {
        const off = find(body, "[data-badges-off]");
        if (off) off.hidden = ctx.config.StatusTagsEnabled === true;
      }
    });
    A.registerSection({
      id: "badges-windows",
      tab: "badges",
      order: 20,
      title: "Time windows",
      hint: "These apply to everyone.",
      fields: [
        { id: "statusTagsJustAddedDays", key: "StatusTagsJustAddedDays", type: "number", min: 1, max: 365, fallback: 7, unit: "days", label: "Just added", desc: "An item counts as just added (and a series or season shows New Episode) for this many days after it reached the library.", read: (v) => Number(v) || 7 },
        { id: "statusTagsNewReleaseDays", key: "StatusTagsNewReleaseDays", type: "number", min: 1, max: 365, fallback: 30, unit: "days", label: "New release", desc: "A movie or series counts as new for this many days after its premiere.", read: (v) => Number(v) || 30 }
      ]
    });
    A.registerSection({
      id: "badges-tmdb",
      tab: "badges",
      order: 30,
      title: "TMDB API key",
      render(ctx, body) {
        body.innerHTML = `<div class="je-ta-state-row"><span class="je-ta-state" data-tmdb-state></span></div><p class="je-ta-hint">${ctx.tx("Daily popular ranks, next air dates and season and series finales use the TMDB API key. Without it, trending can use Seerr's weekly list.")}</p><a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl(null, "services"))}"><span class="je-ta-link-text">${ctx.tx("TMDB API key setting")}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
      },
      refresh(ctx, body) {
        const state = find(body, "[data-tmdb-state]");
        if (!state) return;
        const set = String(ctx.config.TMDB_API_KEY || "").trim() !== "";
        state.dataset.state = set ? "on" : "warn";
        state.textContent = A.fmt(set ? "Set" : "Not set");
      }
    });
    A.registerSection({
      id: "badges-leaving",
      tab: "badges",
      order: 40,
      title: "Leaving soon",
      hint: "Where the Leaving soon badge comes from: Maintainerr's collections (with the day each item goes), or existing Jellyfin collections by name (no date).",
      fields: [
        { id: "leavingSoonMaintainerrUrl", key: "LeavingSoonMaintainerrUrl", type: "text", placeholder: "http://maintainerr:6246", pattern: "https?://[^\\s?#]+", label: "Maintainerr URL", desc: "The address this server reaches Maintainerr at. Empty uses only the collection names." },
        { id: "leavingSoonMaintainerrApiKey", key: "LeavingSoonMaintainerrApiKey", type: "text", secret: true, label: "Maintainerr API key", desc: "Optional. Kept on the server like the other keys and never sent to users." },
        { id: "leavingSoonCollections", key: "LeavingSoonCollections", type: "textarea", rows: 3, placeholder: "Leaving Soon", label: "Leaving collections", desc: "Existing collection names, one per line, whose items count as leaving soon (for setups without the API). Up to 20." },
        { id: "leavingSoonRefreshHours", key: "LeavingSoonRefreshHours", type: "number", min: 1, max: 168, fallback: 6, unit: "hours", label: "Refresh every", desc: "How often the server reads the source again (1–168 hours). A failed request is retried sooner.", read: (v) => Number(v) || 6 }
      ],
      render(ctx, body) {
        body.innerHTML = `<div class="je-ta-state-row"><span class="je-ta-state" data-leaving-state></span></div><p class="je-ta-hint" data-leaving-detail></p><div class="je-ta-actions"><button type="button" class="je-ta-button" id="leavingSoonRefreshBtn"><span class="material-icons" aria-hidden="true">refresh</span>${ctx.tx("Refresh now")}</button></div><p class="je-ta-hint">${ctx.tx("Cards never ask Maintainerr: the server reads it on this schedule and keeps the answer in the tag cache.")}</p>`;
        body.querySelector("#leavingSoonRefreshBtn")?.addEventListener("click", () => {
          void loadLeavingStatus(ctx, true);
        });
        void loadLeavingStatus(ctx, false);
      },
      refresh(ctx, body) {
        if (!body) return;
        const state = find(body, "[data-leaving-state]");
        const detail = body.querySelector("[data-leaving-detail]");
        const button = findAs(body, "#leavingSoonRefreshBtn", HTMLButtonElement);
        const { status: s, busy } = leavingOf(ctx);
        const configured = String(ctx.config.LeavingSoonMaintainerrUrl || "").trim() !== "" || String(ctx.config.LeavingSoonCollections || "").trim() !== "";
        if (button) button.disabled = busy || !configured;
        if (!state || !detail) return;
        const shown = leavingState(configured, s);
        state.dataset.state = shown.state;
        state.textContent = A.fmt(shown.key, { error: s?.LastError ? String(s.LastError) : "" });
        const collections = s?.Collections ? ` · ${A.fmt("{found} of {names} collections found", { found: numberOr(s.CollectionsFound, 0), names: numberOr(s.Collections, 0) })}` : "";
        detail.textContent = configured && s ? A.fmt("{items} {items|item|items} leaving ({dated} with a date) · last read {last} · next {next}", {
          items: numberOr(s.Items, 0),
          dated: numberOr(s.Dated, 0),
          last: when(s.LastSuccess),
          next: when(s.NextRefresh)
        }) + collections : "";
      }
    });
  });
})();
})();
//# sourceMappingURL=badges.js.map
