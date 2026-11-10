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
  var export0 = /* @__PURE__ */ sharedExport(shared, "api");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export3 = /* @__PURE__ */ sharedExport(shared, "currentUserId");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "detailPageHook");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "detailsLease");
  var export32 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export03 = /* @__PURE__ */ sharedExport(shared3, "externalLink");
  var export2 = /* @__PURE__ */ sharedExport(shared3, "pathSegment");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export5 = /* @__PURE__ */ sharedExport(shared4, "field");
  var export6 = /* @__PURE__ */ sharedExport(shared4, "int");
  var export72 = /* @__PURE__ */ sharedExport(shared4, "isRecord");
  var export8 = /* @__PURE__ */ sharedExport(shared4, "list");
  var export9 = /* @__PURE__ */ sharedExport(shared4, "num");
  var export11 = /* @__PURE__ */ sharedExport(shared4, "str");

  // client/src/features/details-providers/provider-domain.ts
  async function resolveProviderTarget(item, allowPerson, seriesLookup) {
    const type = item?.Type;
    if (!item) return { target: null, unsupported: true };
    if (type === "Movie") return { target: wrap(item.ProviderIds.Tmdb, "movie"), unsupported: false };
    if (type === "Person" && allowPerson) return { target: wrap(item.ProviderIds.Tmdb, "person"), unsupported: false };
    if (type === "Series" || type === "Season" || type === "Episode") {
      let tmdbId;
      if (type === "Series") tmdbId = item.ProviderIds.Tmdb;
      else if (item.SeriesId) {
        try {
          tmdbId = (await seriesLookup(item.SeriesId))?.ProviderIds.Tmdb;
        } catch {
        }
      }
      return { target: wrap(tmdbId, "tv"), unsupported: false };
    }
    return { target: null, unsupported: true };
  }
  function wrap(tmdbId, mediaType) {
    return tmdbId ? { tmdbId, mediaType } : null;
  }
  function isUnconfirmed(value) {
    return export5(value, "Confirmed") === false;
  }
  function decodeDddEntry(value) {
    if (!export72(value) || !value.Found) return null;
    const topics = export8(value.Topics).filter(export72).flatMap((topic) => {
      const id = export6(topic.Id);
      return id === void 0 ? [] : [{ Id: id, Name: export11(topic.Name) ?? "", Yes: export9(topic.Yes) ?? 0, No: export9(topic.No) ?? 0 }];
    });
    return topics.length ? { ItemId: export6(value.ItemId), Topics: topics } : null;
  }
  function decodeDddCatalog(value) {
    return export8(export5(value, "Topics")).filter(export72).flatMap((topic) => {
      const id = export6(topic.Id);
      return id === void 0 ? [] : [{ Id: id, Name: export11(topic.Name) ?? "", Category: export11(topic.Category) ?? "", Group: export11(topic.Group) ?? "" }];
    });
  }
  function decodeDddTriggers(value) {
    if (!export72(value)) return null;
    if (!Object.prototype.hasOwnProperty.call(value, "Triggers")) return [];
    if (!Array.isArray(value.Triggers)) return null;
    const ids = value.Triggers.map(export6);
    if (ids.some((id) => id === void 0)) return null;
    return ids.filter((id) => id !== void 0);
  }
  var DDD_PRESENT_PCT = 50;
  var DDD_MIN_VOTES = 3;
  var dddVotes = (topic) => topic.Yes + topic.No;
  var dddPercent = (topic) => Math.round(topic.Yes / (topic.Yes + topic.No) * 100);
  var dddTone = (pct) => pct >= 90 ? "je-ddd-hi" : pct >= 75 ? "je-ddd-mid" : "je-ddd-low";
  var capitalize = (value) => value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  function dddView(topics, picked) {
    const byVotes = (a, b) => dddVotes(b) - dddVotes(a);
    const present = topics.filter((topic) => dddPercent(topic) >= DDD_PRESENT_PCT && dddVotes(topic) >= DDD_MIN_VOTES).sort(byVotes);
    const hasPicks = picked.size > 0;
    const mine = hasPicks ? topics.filter((topic) => picked.has(topic.Id)) : [];
    return {
      hasPicks,
      present,
      mine,
      hits: mine.filter((topic) => dddPercent(topic) >= DDD_PRESENT_PCT).sort(byVotes),
      misses: mine.filter((topic) => dddPercent(topic) < DDD_PRESENT_PCT),
      rest: hasPicks ? present.filter((topic) => !picked.has(topic.Id)) : []
    };
  }
  function filterCatalog(topics, query) {
    const q = query.trim().toLowerCase();
    return topics.filter((topic) => !q || topic.Name.toLowerCase().includes(q) || topic.Category.toLowerCase().includes(q)).sort((a, b) => a.Group.localeCompare(b.Group) || a.Category.localeCompare(b.Category) || a.Name.localeCompare(b.Name));
  }

  // client/src/features/details-providers/doesthedogdie.ts
  var JE = export1("DoesTheDogDie");
  JE.initializeDoesTheDogDieScript = function initializeDoesTheDogDieScript() {
    if (!JE.pluginConfig?.DoesTheDogDieEnabled) {
      console.log("🪼 Jellyfin Enhanced: DoesTheDogDie feature disabled.");
      return;
    }
    const logPrefix = "🪼 Jellyfin Enhanced: DoesTheDogDie:";
    const SECTION_CLASS = "je-ddd-section";
    const POWERED_BY = "Powered by DoesTheDogDie.com";
    let picked = null;
    let catalogPromise = null;
    const owner = () => `${export0().getUrl("/")}|${export0().accessToken()}|${export3() ?? ""}|${JE.session ? JE.session.getEpoch() : 0}`;
    JE.session?.onUserChange("doesthedogdie", () => {
      picked = null;
      document.querySelectorAll(".je-ddd-modal").forEach((modal) => modal.remove());
    });
    function injectCss() {
      const styleId = "je-ddd-styles";
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = DDD_CSS;
      document.head.appendChild(style);
    }
    function el(tag, className, textContent) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (textContent != null) node.textContent = textContent;
      return node;
    }
    async function loadPicked() {
      const key = owner();
      if (picked && picked.owner === key) return picked.ids;
      try {
        const client = export0();
        const userId = client.getCurrentUserId();
        const doc = await client.ajax({
          type: "GET",
          url: client.getUrl(`/JellyfinEnhanced/user-settings/${userId}/ddd-triggers.json?_=${Date.now()}`),
          dataType: "json"
        });
        const ids = decodeDddTriggers(doc);
        if (!ids) throw new Error("Invalid trigger document");
        if (owner() !== key) return null;
        picked = { owner: key, ids: new Set(ids) };
        return picked.ids;
      } catch (e) {
        console.warn(`${logPrefix} Could not load your triggers.`, e);
        return null;
      }
    }
    function chip(topic) {
      const pct = dddPercent(topic);
      const node = el("span", `je-ddd-chip ${dddTone(pct)}`);
      node.title = `${topic.Yes} / ${topic.No}`;
      node.append(el("span", "je-ddd-dot"), el("b", null, capitalize(topic.Name)), el("small", null, `${pct}% · ${(topic.Yes + topic.No).toLocaleString()}`));
      return node;
    }
    function clearChip(topic) {
      const node = el("span", "je-ddd-chip je-ddd-clear");
      node.title = `${topic.Yes} / ${topic.No}`;
      node.append(el("span", "je-ddd-dot"), el("b", null, capitalize(topic.Name)), el("small", null, JE.t("ddd_not_reported")));
      return node;
    }
    function buildSection(entry, picks, rebuild) {
      const view = dddView(entry.Topics, picks);
      const section = el("details", `detailSection ${SECTION_CLASS}`);
      section.open = true;
      const summary = el("summary", "sectionTitle", JE.t("ddd_title"));
      const gear = el("i", "material-icons je-ddd-gear", "settings");
      gear.title = JE.t("ddd_choose_triggers");
      gear.setAttribute("role", "button");
      gear.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openPicker(rebuild);
      });
      summary.append(gear, el("i", "material-icons expand-icon", "expand_more"));
      section.appendChild(summary);
      let expanded = false;
      const body = el("div");
      section.appendChild(body);
      const render = () => {
        body.replaceChildren();
        const sum = el("div", "je-ddd-sum");
        sum.textContent = !view.hasPicks ? view.present.length ? JE.t("ddd_summary_all", { count: view.present.length }) : JE.t("ddd_summary_none") : JE.t("ddd_summary_mine", { hits: view.hits.length, total: view.mine.length });
        body.appendChild(sum);
        const grid = el("div", "je-ddd-grid");
        for (const topic of view.hasPicks ? view.hits : view.present) grid.appendChild(chip(topic));
        for (const topic of view.misses) grid.appendChild(clearChip(topic));
        body.appendChild(grid);
        if (view.rest.length) {
          const more = el("button", "je-ddd-more", expanded ? JE.t("ddd_hide_others") : JE.t("ddd_show_others", { count: view.rest.length }));
          more.type = "button";
          more.addEventListener("click", () => {
            expanded = !expanded;
            render();
          });
          body.appendChild(more);
          if (expanded) {
            body.appendChild(el("div", "je-ddd-label", JE.t("ddd_other_label")));
            const other = el("div", "je-ddd-grid");
            for (const topic of view.rest) other.appendChild(chip(topic));
            body.appendChild(other);
          }
        }
        const foot = el("div", "je-ddd-foot");
        const href = `https://www.doesthedogdie.com/media/${entry.ItemId}`;
        foot.appendChild(export03(JE.helpers, href, { text: POWERED_BY, resetStyle: true }));
        body.appendChild(foot);
      };
      render();
      return section;
    }
    function getCatalog() {
      catalogPromise ?? (catalogPromise = JE.core.api.plugin("/ddd/topics", { cacheKey: "ddd:topics" }).then(decodeDddCatalog).catch((e) => {
        catalogPromise = null;
        throw e;
      }));
      return catalogPromise;
    }
    async function openPicker(onSaved) {
      const key = owner();
      const modal = el("div", "je-ddd-modal");
      const box = el("div", "je-ddd-box");
      const search = el("input");
      search.type = "text";
      search.placeholder = JE.t("ddd_picker_search");
      const list = el("div", "je-ddd-list");
      list.innerHTML = JE.core.ui.skeletonGridHtml(6, { minWidth: "100%", height: "2em", label: JE.t("ddd_picker_loading") });
      const cancel = el("button", null, JE.t("elsewhere_settings_cancel"));
      const save = el("button", "je-ddd-save", JE.t("elsewhere_settings_save"));
      cancel.type = save.type = "button";
      save.disabled = true;
      const buttons = el("div", "je-ddd-btns");
      buttons.append(cancel, save);
      box.append(el("h3", null, JE.t("ddd_picker_title")), search, list, buttons);
      modal.appendChild(box);
      document.body.appendChild(modal);
      const close = () => modal.remove();
      cancel.addEventListener("click", close);
      modal.addEventListener("click", (event) => {
        if (event.target === modal) close();
      });
      let topics;
      let current;
      try {
        [topics, current] = await Promise.all([getCatalog(), loadPicked()]);
      } catch {
        list.textContent = JE.t("ddd_picker_failed");
        return;
      }
      if (!modal.isConnected) return;
      if (!current || owner() !== key) {
        list.textContent = JE.t("ddd_picker_failed");
        return;
      }
      const draft = new Set(current);
      const fill = (query) => {
        list.replaceChildren();
        let lastGroup = null;
        for (const topic of filterCatalog(topics, query)) {
          const group = topic.Category ? `${topic.Group} / ${topic.Category}` : topic.Group;
          if (group !== lastGroup) {
            list.appendChild(el("div", "je-ddd-group", group));
            lastGroup = group;
          }
          const row = el("label", "je-ddd-row");
          const checkbox = el("input");
          checkbox.type = "checkbox";
          checkbox.checked = draft.has(topic.Id);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) draft.add(topic.Id);
            else draft.delete(topic.Id);
          });
          row.append(checkbox, el("span", null, capitalize(topic.Name)));
          list.appendChild(row);
        }
      };
      fill("");
      search.addEventListener("input", () => fill(search.value));
      let saving = false;
      const failure = el("div", "je-ddd-save-error");
      failure.setAttribute("role", "alert");
      buttons.before(failure);
      save.disabled = false;
      save.addEventListener("click", async () => {
        if (saving || !modal.isConnected || owner() !== key) return;
        saving = true;
        save.disabled = true;
        const submitted = new Set(draft);
        try {
          await JE.saveUserSettings("ddd-triggers.json", { Triggers: Array.from(submitted) }, {
            throwOnError: true,
            isCurrent: () => owner() === key
          });
          if (owner() !== key) return;
          picked = { owner: key, ids: submitted };
          if (modal.isConnected) {
            close();
            onSaved();
          }
        } catch (_) {
          if (owner() === key && modal.isConnected) {
            const key2 = "ddd_picker_save_failed";
            const text = JE.t(key2);
            failure.textContent = text && text !== key2 ? text : "Could not save your choices. Try again.";
          }
        } finally {
          saving = false;
          if (owner() === key && modal.isConnected) save.disabled = false;
        }
      });
    }
    function removeSection(page) {
      const root = page || document.querySelector("#itemDetailPage:not(.hide)") || document;
      root.querySelectorAll(`.${SECTION_CLASS}`).forEach((node) => node.remove());
    }
    function insertSection(page, section) {
      removeSection(page);
      const reviews = page.querySelector(".tmdb-reviews-section");
      if (reviews?.parentNode) {
        reviews.parentNode.insertBefore(section, reviews);
        return;
      }
      const afterAnchor = page.querySelector(".streaming-lookup-container") || page.querySelector(".itemExternalLinks") || page.querySelector(".tagline");
      if (afterAnchor?.parentNode) {
        afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
        return;
      }
      const beforeAnchor = page.querySelector("#similarCollapsible");
      beforeAnchor?.parentNode?.insertBefore(section, beforeAnchor);
    }
    async function fetchEntry(type, tmdbId) {
      try {
        const cacheKey = `ddd:/${type}/${tmdbId}`;
        const data = await JE.core.api.plugin(`/ddd/${type}/${export2(tmdbId)}`, { cacheKey });
        if (isUnconfirmed(data)) JE.core.api.manager.clearCacheMatching(cacheKey);
        return decodeDddEntry(data);
      } catch (e) {
        console.warn(`${logPrefix} Failed to fetch content warnings.`, e);
        return null;
      }
    }
    async function processPage(page) {
      try {
        const itemId = export32();
        const userId = export3();
        if (!itemId || !userId) return;
        const lease = export12(JE.session, itemId, page);
        const item = await export7(JE.helpers, itemId, true, userId);
        const { target } = await resolveProviderTarget(item, false, (seriesId) => export7(JE.helpers, seriesId, true, userId));
        if (!lease.current()) return;
        if (!target) {
          if (lease.current()) removeSection(page);
          return;
        }
        const entry = await fetchEntry(target.mediaType, target.tmdbId);
        if (!entry) {
          if (lease.current()) removeSection(page);
          return;
        }
        const picks = await loadPicked() ?? /* @__PURE__ */ new Set();
        if (!lease.current()) return;
        const rebuild = () => {
          if (!lease.current()) return;
          insertSection(page, buildSection(entry, picked?.owner === owner() ? picked.ids : picks, rebuild));
        };
        rebuild();
      } catch (error) {
        console.error(`${logPrefix} Error processing page:`, error);
      }
    }
    injectCss();
    const unregister = JE.helpers.onViewPage(
      export02(() => !!JE.pluginConfig?.DoesTheDogDieEnabled, () => unregister?.(), (page) => {
        void processPage(page);
      }, true),
      { pages: null, fetchItem: false, immediate: true }
    );
  };
  var DDD_CSS = `
                .je-ddd-section { display: flex !important; flex-direction: column; width: 100%; min-width: 0; margin: 1.5em 0; }
                .je-ddd-section > summary { cursor: pointer; display: flex; align-items: center; gap: .5em; }
                .je-ddd-gear { margin-left: auto; opacity: .75; cursor: pointer; font-size: 1.2em; padding: .2em; border-radius: 50%; }
                .je-ddd-gear:hover { opacity: 1; background: rgba(255,255,255,.1); }
                .je-ddd-section .expand-icon { transition: transform .2s ease-in-out; }
                .je-ddd-section[open] > summary .expand-icon { transform: rotate(180deg); }
                .je-ddd-sum { margin: .6em 0 .8em; font-size: .95em; }
                .je-ddd-grid { display: flex; flex-wrap: wrap; gap: .5em; margin-bottom: .5em; }
                .je-ddd-chip { display: inline-flex; align-items: center; gap: .5em; padding: .4em .75em; border-radius: 999px; font-size: .88em; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); }
                .je-ddd-chip small { opacity: .7; }
                .je-ddd-dot { width: .55em; height: .55em; border-radius: 50%; background: currentColor; flex: none; }
                .je-ddd-hi { background: rgba(229,57,53,.2); border-color: rgba(229,57,53,.6); } .je-ddd-hi .je-ddd-dot { color: #e53935; }
                .je-ddd-mid { background: rgba(251,140,0,.17); border-color: rgba(251,140,0,.5); } .je-ddd-mid .je-ddd-dot { color: #fb8c00; }
                .je-ddd-low { background: rgba(253,216,53,.12); border-color: rgba(253,216,53,.4); } .je-ddd-low .je-ddd-dot { color: #fdd835; }
                .je-ddd-clear { background: rgba(76,175,80,.14); border-color: rgba(76,175,80,.45); } .je-ddd-clear .je-ddd-dot { color: #4caf50; }
                .je-ddd-more { cursor: pointer; background: none; border: 1px dashed rgba(255,255,255,.3); color: inherit; border-radius: 999px; padding: .4em .85em; font-size: .88em; font-family: inherit; }
                .je-ddd-more:hover { background: rgba(255,255,255,.08); }
                .je-ddd-label { font-size: .75em; opacity: .6; margin: .8em 0 .4em; text-transform: uppercase; letter-spacing: .06em; }
                .je-ddd-foot { margin-top: .8em; font-size: .8em; opacity: .8; }
                .je-ddd-foot a { color: inherit; text-decoration: underline; }
                .je-ddd-modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 100000; display: flex; align-items: center; justify-content: center; }
                .je-ddd-box { background: #1c1c1c; color: #fff; border-radius: 10px; padding: 20px; width: min(460px, 92vw); max-height: 85vh; display: flex; flex-direction: column; gap: 10px; }
                .je-ddd-box h3 { margin: 0; }
                .je-ddd-box input[type=text] { padding: 10px; border: 1px solid #444; border-radius: 6px; background: #2a2a2a; color: #fff; }
                .je-ddd-list { overflow: auto; border: 1px solid #333; border-radius: 6px; max-height: 340px; min-height: 120px; }
                .je-ddd-group { position: sticky; top: 0; background: #262626; padding: 6px 10px; font-size: .75em; text-transform: uppercase; letter-spacing: .06em; opacity: .85; }
                .je-ddd-row { display: flex; gap: 10px; align-items: center; padding: 8px 10px; cursor: pointer; }
                .je-ddd-row:hover { background: #2a2a2a; }
                .je-ddd-btns { display: flex; justify-content: flex-end; gap: 8px; }
                .je-ddd-btns button { padding: 9px 16px; border-radius: 6px; border: 1px solid #444; background: #2a2a2a; color: #fff; cursor: pointer; }
                .je-ddd-btns button.je-ddd-save { background: #0078d4; border: none; }
            `;
})();
})();
//# sourceMappingURL=doesthedogdie.js.map
