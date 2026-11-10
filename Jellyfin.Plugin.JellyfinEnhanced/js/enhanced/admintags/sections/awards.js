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
  function must(scope, selector) {
    const el = find(scope, selector);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/awards.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'Awards',
      group: { id: 'awards' },
      writes: ['TagGroupScopes'],
          { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'Awards ribbons for new users' },
          { id: 'awardsTagsImdb', key: 'AwardsTagsImdb', type: 'switch', label: 'IMDb Top 250' },
          { id: 'awardsTagsCertifiedFresh', key: 'AwardsTagsCertifiedFresh', type: 'switch', label: 'Certified Fresh' },
          { id: 'awardsTagsOscar', key: 'AwardsTagsOscar', type: 'switch', label: 'Oscar winners' },
          { id: 'awardsTagsEmmy', key: 'AwardsTagsEmmy', type: 'switch', label: 'Emmy winners' },
          { id: 'awardsTagsLetterboxd', key: 'AwardsTagsLetterboxd', type: 'switch', label: 'Letterboxd Top 250' },
          { id: 'awardsTagsImdbList', key: 'AwardsTagsImdbList', type: 'text', label: 'IMDb Top 250 list (MDBList id or owner/slug)' },
          { id: 'awardsTagsLetterboxdList', key: 'AwardsTagsLetterboxdList', type: 'text', label: 'Letterboxd Top 250 list (MDBList id or owner/slug)' },
          { id: 'awardsTagsRefreshHours', key: 'AwardsTagsRefreshHours', type: 'number', label: 'Refresh cadence (hours)' },
  */
  var SOURCES = ["AwardsTagsImdb", "AwardsTagsCertifiedFresh", "AwardsTagsOscar", "AwardsTagsEmmy", "AwardsTagsLetterboxd"];
  installSection((A) => {
    A.registerSection({
      id: "group-awards",
      tab: "groups",
      order: 65,
      title: "Awards",
      hint: "Ribbons from ratings and award sources. MDBList credentials stay on the main settings page. Failed lookups retry after an hour.",
      group: {
        id: "awards",
        // The current choice, short (the description stays inside the group).
        summary: (ctx) => A.fmt("{n} of {total} sources · refreshed every {hours} h", { n: SOURCES.filter((k) => ctx.config[k] === true).length, total: 5, hours: Number(ctx.config.AwardsTagsRefreshHours) || 24 }),
        sample: () => [["status", A.fmt("Awards")]]
      },
      // "Where to show" (drawn for every group row by admin-tags.js).
      writes: ["TagGroupScopes"],
      fields: [
        { id: "awardsTagsEnabled", key: "AwardsTagsEnabled", type: "enable", label: "Awards ribbons for new users" },
        { id: "awardsTagsImdb", key: "AwardsTagsImdb", type: "switch", label: "IMDb Top 250" },
        { id: "awardsTagsCertifiedFresh", key: "AwardsTagsCertifiedFresh", type: "switch", label: "Certified Fresh" },
        { id: "awardsTagsOscar", key: "AwardsTagsOscar", type: "switch", label: "Oscar winners" },
        { id: "awardsTagsEmmy", key: "AwardsTagsEmmy", type: "switch", label: "Emmy winners" },
        { id: "awardsTagsLetterboxd", key: "AwardsTagsLetterboxd", type: "switch", label: "Letterboxd Top 250" },
        { id: "awardsTagsImdbList", key: "AwardsTagsImdbList", type: "text", pattern: "(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})", label: "IMDb Top 250 list (MDBList id or owner/slug)", desc: "An MDBList list, not an IMDb link. Find one at mdblist.com/lists; its items must be in rank order, number 1 first." },
        { id: "awardsTagsLetterboxdList", key: "AwardsTagsLetterboxdList", type: "text", pattern: "(?:[1-9][0-9]{0,17}|[a-zA-Z0-9_\\-]{1,80}/[a-zA-Z0-9_\\-]{1,160})", label: "Letterboxd Top 250 list (MDBList id or owner/slug)", desc: "An MDBList list, not a Letterboxd link, in rank order." },
        { id: "awardsTagsRefreshHours", key: "AwardsTagsRefreshHours", type: "number", label: "Refresh cadence (hours)", min: 1, max: 168, fallback: 24 }
      ],
      // What the group depends on, and whether it has been fetched yet (nothing shows until the first refresh has run).
      render(ctx, body) {
        body.innerHTML = `<h4 class="je-ta-sub">${ctx.tx("What it needs")}</h4>
                <div class="je-ta-card" style="margin:0" data-awards-needs>
                    <div class="je-ta-card-head"><span class="je-ta-state" data-awards-key></span></div>
                    <p class="je-ta-hint">${ctx.tx("IMDb Top 250, Letterboxd Top 250 and Certified Fresh come from MDBList and need its API key. Oscar and Emmy wins come from Wikidata and need no key.")}</p>
                    <p class="je-ta-hint" data-awards-run></p>
                    <a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl("mdblistRatingsEnabled"))}"><span class="je-ta-link-text">${ctx.tx("MDBList settings")}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>
                </div>`;
      },
      refresh(ctx, body) {
        const box = find(body, "[data-awards-needs]");
        if (!box) return;
        const key = String(ctx.config.MdblistApiKey || "").trim() !== "";
        const state = must(box, "[data-awards-key]");
        state.dataset.state = key ? "on" : "warn";
        state.textContent = A.fmt(key ? "MDBList key set" : "No MDBList key: the charts and Certified Fresh stay empty");
        const run = must(box, "[data-awards-run]");
        if (box.dataset.runLoaded) return;
        box.dataset.runLoaded = "1";
        const base = A.fmt("The Refresh Awards Tags task (Dashboard › Scheduled Tasks) fetches the facts, nightly at 04:00 and once when Awards is first turned on. Nothing shows until it has run.");
        run.textContent = base;
        const client = apiClient();
        client.ajax({ type: "GET", url: client.getUrl("ScheduledTasks"), dataType: "json" }).then((tasks) => {
          if (!ctx.isCurrent() || !Array.isArray(tasks)) return;
          const task = tasks.find((t) => !!t && typeof t === "object" && Reflect.get(t, "Key") === "JellyfinEnhancedRefreshAwardTags");
          if (!task || typeof task !== "object") return;
          const result = Reflect.get(task, "LastExecutionResult");
          const end = result && typeof result === "object" ? Reflect.get(result, "EndTimeUtc") : void 0;
          const last = end ? Date.parse(String(end)) : 0;
          let when = A.fmt("never");
          if (last) {
            const minutes = Math.max(0, Math.round((Date.now() - last) / 6e4));
            try {
              when = new Intl.RelativeTimeFormat(void 0, { numeric: "auto" }).format(minutes < 120 ? -minutes : -Math.round(minutes / 60), minutes < 120 ? "minute" : "hour");
            } catch {
              when = new Date(last).toLocaleString();
            }
          }
          run.textContent = `${base} ${A.fmt(Reflect.get(task, "State") === "Running" ? "It is running now." : "Last run: {when}.", { when })}`;
        }).catch(() => {
        });
      }
    });
  });
})();
})();
//# sourceMappingURL=awards.js.map
