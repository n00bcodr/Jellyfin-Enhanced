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

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export2 = /* @__PURE__ */ sharedExport(shared, "mediaTagsContext");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export42 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export13 = /* @__PURE__ */ sharedExport(shared2, "text");

  // client/src/features/media-tags/editor/tag-item-menu.ts
  function createItemMenu(JE, alsoCapture) {
    const DATA_ID = "je-media-tags";
    const CONTEXT_TTL_MS = 5e3;
    const ITEM_ROWS = ["addtocollection", "addtoplaylist", "share", "edit", "editimages", "editsubtitles", "identify", "moremediainfo", "refresh", "delete", "download", "copy-stream", "playallfromhere", "queueallfromhere", "resume", "play", "queue", "shuffle", "instantmix", "multiSelect", "removefromcollection"];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(", ");
    const featureCtx = export2(JE);
    let context = null;
    function detailItemId() {
      const query = window.location.hash.split("?")[1] || window.location.search.slice(1) || "";
      const id = new URLSearchParams(query).get("id");
      return id ? JE.core.tagLook?.normalizeId(id) || null : null;
    }
    function capture(e) {
      alsoCapture?.(e);
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el.closest(".actionSheet, .dialogContainer, .je-tie-backdrop")) return;
      const more = el.closest(".btnMoreCommands");
      if (more && more.closest("#itemDetailPage")) {
        const itemId2 = detailItemId();
        if (!itemId2) {
          context = null;
          return;
        }
        const userId = export0().getCurrentUserId();
        context = { itemId: itemId2, type: null, item: export0().getItem(userId, itemId2).catch(() => null), opener: more, ts: Date.now() };
        return;
      }
      const button = e.type === "contextmenu" ? el : el.closest('button[data-action="menu"]');
      if (!button) return;
      const card = button.closest(".card[data-id], .listItem[data-id], [data-id][data-type]");
      const itemId = card ? JE.core.tagLook?.normalizeId(card.dataset.id || "") : null;
      if (!itemId) {
        if (e.type !== "contextmenu") context = null;
        return;
      }
      context = { itemId, type: card?.dataset.type || null, item: null, opener: e.type === "contextmenu" ? card : button, ts: Date.now() };
    }
    function activeScroller() {
      const scrollers = document.querySelectorAll(".actionSheetScroller");
      for (let i = scrollers.length - 1; i >= 0; i--) {
        const el = scrollers[i];
        if (el && (el.offsetParent !== null || el.getClientRects().length)) return el;
      }
      return scrollers[scrollers.length - 1] || null;
    }
    function buildRow(scroller) {
      const shared3 = featureCtx.peer("homeRemoval")?.buildNativeActionSheetItem;
      if (typeof shared3 === "function") return shared3(scroller, { dataId: DATA_ID, icon: "local_offer", text: JE.t("common_media_tags") });
      const ref = scroller.querySelector(".actionSheetMenuItem");
      const button = document.createElement("button");
      button.setAttribute("is", "emby-button");
      button.type = "button";
      button.className = (ref?.getAttribute("class") || "listItem listItem-button actionSheetMenuItem").replace(/\bselected\b/g, "").replace(/\s+/g, " ").trim();
      button.dataset.id = DATA_ID;
      const icon = document.createElement("span");
      icon.className = "actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons local_offer";
      icon.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "listItemBody actionsheetListItemBody";
      const text = document.createElement("div");
      text.className = "listItemBodyText actionSheetItemText";
      text.textContent = JE.t("common_media_tags");
      body.appendChild(text);
      button.append(icon, body);
      return button;
    }
    function fitSheet(scroller) {
      const sheet = scroller.closest(".actionSheet, .dialog");
      if (!sheet) return;
      const top = parseFloat(sheet.style.top);
      if (!Number.isFinite(top)) return;
      const viewport = document.documentElement.clientHeight || window.innerHeight || 0;
      const overflow = top + sheet.offsetHeight - (viewport - 10);
      if (overflow > 0) sheet.style.top = `${Math.max(10, top - overflow)}px`;
    }
    async function inject() {
      const scroller = activeScroller();
      if (!scroller) return;
      const existing = scroller.querySelector(`[data-id="${DATA_ID}"]`);
      const ctx = context;
      if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
        if (existing && (!ctx || existing.dataset.jeItemId !== ctx.itemId)) existing.remove();
        return;
      }
      if (existing?.dataset.jeItemId === ctx.itemId) return;
      existing?.remove();
      let type = ctx.type;
      let item = null;
      if (!type && ctx.item) {
        const read = await ctx.item;
        item = export42(read) ? read : null;
        type = export13(item?.Type);
        if (context !== ctx || !scroller.isConnected) return;
      }
      context = null;
      const editor = JE.tagItemEditor;
      if (!editor?.anyTagsOn?.() || !type || !editor.TYPES.has(type)) return;
      if (scroller.querySelector(`[data-id="${DATA_ID}"]`)) return;
      const row = buildRow(scroller);
      row.dataset.jeItemId = ctx.itemId;
      const opener = ctx.opener;
      const itemId = ctx.itemId;
      row.addEventListener("click", () => {
        setTimeout(() => {
          void editor.open(itemId, { opener, ...item ? { item } : {} });
        }, 0);
      });
      const share = scroller.querySelector('[data-id="share"]');
      if (share) share.before(row);
      else scroller.appendChild(row);
      fitSheet(scroller);
    }
    let scheduled = false;
    const SHEET_SELECTOR = ".actionSheet, .actionSheetScroller, .dialogContainer";
    function touchesSheet(mutations) {
      for (const m of mutations) {
        if (m.target instanceof Element && m.target.closest(SHEET_SELECTOR)) return true;
        for (const node of m.addedNodes) {
          if (node instanceof Element && (node.matches(SHEET_SELECTOR) || node.querySelector(SHEET_SELECTOR))) return true;
        }
      }
      return false;
    }
    document.addEventListener("click", capture, true);
    document.addEventListener("contextmenu", capture, true);
    JE.core.dom?.onBodyMutation?.("tag-item-menu", (mutations) => {
      if (scheduled || !context || !touchesSheet(mutations)) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        inject().catch((err) => console.warn("🪼 Jellyfin Enhanced [TagLook]: could not add Media Tags to the item menu:", err));
      });
    }, { priority: 1 });
    JE.session?.onUserChange?.("tag-item-menu", () => {
      context = null;
    });
    JE.tagItemMenu = { inject, DATA_ID };
  }

  // client/src/features/media-tags/editor/maintainerr-item-menu.css
  var maintainerr_item_menu_default = ".je-mt-backdrop{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}\n.je-mt-dialog{background:#1f1f1f;color:#fff;border-radius:8px;padding:20px 22px;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.6);font-size:15px}\n.je-mt-title{margin:0 0 6px;font-size:1.25em}\n.je-mt-hint{margin:0 0 14px;opacity:.8}\n.je-mt-quick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}\n.je-mt-button{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:inherit;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}\n.je-mt-button:hover,.je-mt-button:focus-visible{background:rgba(255,255,255,.18);outline:none}\n.je-mt-custom{display:flex;align-items:flex-end;gap:8px;margin-bottom:16px}\n.je-mt-custom label{display:flex;flex-direction:column;gap:4px;flex:1}\n.je-mt-label{font-size:.85em;opacity:.8}\n.je-mt-input{background:rgba(255,255,255,.08);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:8px;font:inherit;width:100%;box-sizing:border-box}\n.je-mt-footer{display:flex;justify-content:space-between;gap:8px}\n";

  // client/src/features/media-tags/editor/maintainerr-item-menu.ts
  var RequestError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  };
  function createMaintainerrMenu(JE) {
    const ROWS = Object.freeze({ mark: "je-maintainerr-mark", keep: "je-maintainerr-keep", postpone: "je-maintainerr-postpone" });
    const ROW_SELECTOR = Object.values(ROWS).map((id) => `[data-id="${id}"]`).join(", ");
    const TYPES = /* @__PURE__ */ new Set(["Movie", "Series"]);
    const CONTEXT_TTL_MS = 5e3;
    const DAY_MS = 864e5;
    const QUICK_DAYS = [7, 14, 30, 90];
    const MAX_DAYS = 3650;
    const ITEM_ROWS = ["addtocollection", "addtoplaylist", "share", "edit", "editimages", "editsubtitles", "identify", "moremediainfo", "refresh", "delete", "download", "copy-stream", "playallfromhere", "queueallfromhere", "resume", "play", "queue", "shuffle", "instantmix", "multiSelect", "removefromcollection"];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(", ");
    const LOG = "🪼 Jellyfin Enhanced [Maintainerr]:";
    const featureCtx = export2(JE);
    let context = null;
    let adminCheck = null;
    function enabled() {
      return JE.pluginConfig?.MaintainerrActionsAvailable === true;
    }
    function isAdmin() {
      adminCheck ?? (adminCheck = Promise.resolve().then(() => export0().getCurrentUser()).then((user) => export42(user) && export42(user.Policy) && user.Policy.IsAdministrator === true).catch(() => {
        adminCheck = null;
        return false;
      }));
      return adminCheck;
    }
    function normalizeId(id) {
      const clean = String(id || "").replace(/-/g, "").toLowerCase();
      return /^[0-9a-f]{32}$/.test(clean) ? clean : null;
    }
    function detailItemId() {
      const query = window.location.hash.split("?")[1] || window.location.search.slice(1) || "";
      const id = new URLSearchParams(query).get("id");
      return id ? normalizeId(id) : null;
    }
    function capture(e) {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest(".actionSheet, .dialogContainer, .je-mt-backdrop")) return;
      const more = el.closest(".btnMoreCommands");
      if (more && more.closest("#itemDetailPage")) {
        const itemId2 = detailItemId();
        if (!itemId2) {
          context = null;
          return;
        }
        const userId = export0().getCurrentUserId();
        context = { itemId: itemId2, type: null, item: export0().getItem(userId, itemId2).catch(() => null), opener: more, ts: Date.now() };
        return;
      }
      const button = e.type === "contextmenu" ? el : el.closest('button[data-action="menu"]');
      if (!button) return;
      const card = button.closest(".card[data-id], .listItem[data-id], [data-id][data-type]");
      const itemId = card ? normalizeId(card.dataset.id || "") : null;
      if (!itemId) {
        if (e.type !== "contextmenu") context = null;
        return;
      }
      const opener = e.type === "contextmenu" ? card : button instanceof HTMLElement ? button : null;
      context = { itemId, type: card?.dataset.type || null, item: null, opener, ts: Date.now() };
    }
    function activeScroller() {
      const scrollers = document.querySelectorAll(".actionSheetScroller");
      for (let i = scrollers.length - 1; i >= 0; i--) {
        const el = scrollers[i];
        if (el && (el.offsetParent !== null || el.getClientRects().length)) return el;
      }
      return scrollers[scrollers.length - 1] || null;
    }
    function buildRow(scroller, dataId, icon, label) {
      const shared3 = featureCtx.peer("homeRemoval")?.buildNativeActionSheetItem;
      if (typeof shared3 === "function") return shared3(scroller, { dataId, icon, text: label });
      const ref = scroller.querySelector(".actionSheetMenuItem");
      const button = document.createElement("button");
      button.setAttribute("is", "emby-button");
      button.type = "button";
      button.className = (ref?.getAttribute("class") || "listItem listItem-button actionSheetMenuItem").replace(/\bselected\b/g, "").replace(/\s+/g, " ").trim();
      button.dataset.id = dataId;
      const iconEl = document.createElement("span");
      iconEl.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${icon}`;
      iconEl.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "listItemBody actionsheetListItemBody";
      const textEl = document.createElement("div");
      textEl.className = "listItemBodyText actionSheetItemText";
      textEl.textContent = label;
      body.appendChild(textEl);
      button.append(iconEl, body);
      return button;
    }
    function fitSheet(scroller) {
      const sheet = scroller.closest(".actionSheet, .dialog");
      if (!sheet) return;
      const top = parseFloat(sheet.style.top);
      if (!Number.isFinite(top)) return;
      const viewport = document.documentElement.clientHeight || window.innerHeight || 0;
      const overflow = top + sheet.offsetHeight - (viewport - 10);
      if (overflow > 0) sheet.style.top = `${Math.max(10, top - overflow)}px`;
    }
    async function request(method, path, body) {
      const client = export0();
      try {
        return await client.ajax({
          type: method,
          url: client.getUrl(`JellyfinEnhanced/maintainerr/${path}`),
          dataType: "json",
          ...body ? { data: JSON.stringify(body), contentType: "application/json" } : {}
        });
      } catch (err) {
        const failure = export42(err) ? err : {};
        let reason = null;
        try {
          const answer = typeof failure.json === "function" ? await failure.json() : null;
          reason = export42(answer) ? export13(answer.error) : null;
        } catch {
        }
        const status = typeof failure.status === "number" ? failure.status : void 0;
        const message = reason || (status ? `HTTP ${status}` : String(export13(failure.message) ?? err));
        throw new RequestError(message, status);
      }
    }
    function stateOf(value) {
      return export42(value) ? value : null;
    }
    function daysLeft(deleteAt) {
      if (typeof deleteAt !== "number" || !Number.isFinite(deleteAt)) return null;
      const day = (ms) => {
        const d = new Date(ms);
        return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
      };
      return day(deleteAt) - day(Date.now());
    }
    function withDays(key, state) {
      const days = daysLeft(state?.DeleteAt);
      return JE.escapeHtml(days === null ? JE.t(key) : JE.t(`${key}_days`, { days }));
    }
    async function act(path, body, doneKey, undo) {
      const lease = JE.session?.createLease?.();
      try {
        const state = stateOf(await request("POST", path, body));
        if (lease && !lease.isCurrent()) return state;
        JE.toast?.(withDays(doneKey, state), void 0, undo ? {
          action: {
            label: JE.t("maintainerr_undo"),
            onClick: () => {
              void act(undo.path, undo.body, undo.doneKey, null);
            }
          }
        } : void 0);
        return state;
      } catch (err) {
        console.warn(LOG, path, "failed:", err);
        if (lease && !lease.isCurrent()) return null;
        JE.toast?.(JE.escapeHtml(JE.t("maintainerr_failed", { error: err instanceof Error ? err.message : "" })), 6e3);
        return null;
      }
    }
    function postpone(itemId, state, opener) {
      document.getElementById("je-mt-dialog")?.remove();
      JE.core.ui?.injectCss?.("je-maintainerr-menu", maintainerr_item_menu_default);
      const backdrop = document.createElement("div");
      backdrop.className = "je-mt-backdrop";
      backdrop.id = "je-mt-dialog";
      const dialog = document.createElement("div");
      dialog.className = "je-mt-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "je-mt-title");
      const days = daysLeft(state.DeleteAt);
      dialog.innerHTML = `<h2 id="je-mt-title" class="je-mt-title"></h2><p class="je-mt-hint"></p><div class="je-mt-quick"></div><div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-apply"></button></div><div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-cancel"></button></div>`;
      const setText = (selector, value) => {
        const el = dialog.querySelector(selector);
        if (el) el.textContent = value;
      };
      setText(".je-mt-title", JE.t("maintainerr_postpone_title"));
      if (days === null) dialog.querySelector(".je-mt-hint")?.remove();
      else setText(".je-mt-hint", JE.t("maintainerr_postpone_hint", { days }));
      setText(".je-mt-label", JE.t("maintainerr_postpone_days_label"));
      setText(".je-mt-apply", JE.t("maintainerr_postpone_apply"));
      setText(".je-mt-reset", JE.t("maintainerr_reset_timer"));
      setText(".je-mt-cancel", JE.t("maintainerr_cancel"));
      const quick = dialog.querySelector(".je-mt-quick");
      const input = dialog.querySelector(".je-mt-input");
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      };
      const close = () => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        try {
          opener?.focus?.();
        } catch {
        }
      };
      const run = (count) => {
        close();
        void act("postpone", count === null ? { itemId } : { itemId, days: count }, count === null ? "maintainerr_reset" : "maintainerr_postponed", null);
      };
      for (const count of QUICK_DAYS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "je-mt-button je-mt-day";
        b.textContent = JE.t("maintainerr_postpone_plus_days", { days: count });
        b.addEventListener("click", () => run(count));
        quick?.appendChild(b);
      }
      const apply = () => {
        if (!input) return;
        const n = Math.floor(Number(input.value));
        if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) {
          input.focus();
          input.select?.();
          return;
        }
        run(n);
      };
      dialog.querySelector(".je-mt-apply")?.addEventListener("click", apply);
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      });
      dialog.querySelector(".je-mt-reset")?.addEventListener("click", () => run(null));
      dialog.querySelector(".je-mt-cancel")?.addEventListener("click", close);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
      });
      document.addEventListener("keydown", onKey, true);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      const first = quick?.firstElementChild;
      if (first instanceof HTMLElement) first.focus();
    }
    async function inject() {
      const scroller = activeScroller();
      if (!scroller) return;
      const existing = Array.from(scroller.querySelectorAll(ROW_SELECTOR));
      const ctx = context;
      if (!scroller.querySelector(ITEM_ROW_SELECTOR) || !ctx || Date.now() - ctx.ts > CONTEXT_TTL_MS) {
        for (const row of existing) if (!ctx || row.dataset.jeItemId !== ctx.itemId) row.remove();
        return;
      }
      if (existing.some((row) => row.dataset.jeItemId === ctx.itemId)) return;
      for (const row of existing) row.remove();
      if (!enabled()) return;
      let type = ctx.type;
      if (!type && ctx.item) {
        const read = await ctx.item;
        type = export42(read) ? export13(read.Type) : null;
        if (context !== ctx || !scroller.isConnected) return;
      }
      if (!type || !TYPES.has(type)) return;
      context = null;
      const lease = JE.session?.createLease?.();
      if (!await isAdmin()) return;
      let state = null;
      try {
        state = stateOf(await request("GET", `item/${ctx.itemId}`));
      } catch (err) {
        if (!(err instanceof RequestError && err.status === 404)) console.warn(LOG, "could not read the item state:", err);
        return;
      }
      if (lease && !lease.isCurrent()) return;
      if (!state || !state.Supported || !scroller.isConnected || scroller.querySelector(ROW_SELECTOR)) return;
      const itemId = ctx.itemId;
      const opener = ctx.opener;
      const current = state;
      const rows = [];
      if (current.Marked) {
        const keep = buildRow(scroller, ROWS.keep, "restore", JE.t("maintainerr_keep"));
        keep.addEventListener("click", () => {
          setTimeout(() => {
            void act("unmark", { itemId }, "maintainerr_kept", { path: "mark", body: { itemId }, doneKey: "maintainerr_marked" });
          }, 0);
        });
        const later = buildRow(scroller, ROWS.postpone, "more_time", JE.t("maintainerr_postpone"));
        later.addEventListener("click", () => {
          setTimeout(() => postpone(itemId, current, opener), 0);
        });
        rows.push(keep, later);
      } else {
        const mark = buildRow(scroller, ROWS.mark, "auto_delete", JE.t("maintainerr_mark"));
        mark.addEventListener("click", () => {
          setTimeout(() => {
            void act("mark", { itemId }, "maintainerr_marked", { path: "unmark", body: { itemId }, doneKey: "maintainerr_kept" });
          }, 0);
        });
        rows.push(mark);
      }
      const anchor = scroller.querySelector('[data-id="je-media-tags"], [data-id="share"]');
      for (const row of rows) {
        row.dataset.jeItemId = itemId;
        if (anchor) anchor.before(row);
        else scroller.appendChild(row);
      }
      fitSheet(scroller);
    }
    let scheduled = false;
    const SHEET_SELECTOR = ".actionSheet, .actionSheetScroller, .dialogContainer";
    function touchesSheet(mutations) {
      for (const m of mutations) {
        if (m.target instanceof Element && m.target.closest(SHEET_SELECTOR)) return true;
        for (const node of m.addedNodes) {
          if (node instanceof Element && (node.matches(SHEET_SELECTOR) || node.querySelector(SHEET_SELECTOR))) return true;
        }
      }
      return false;
    }
    JE.core.dom?.onBodyMutation?.("maintainerr-item-menu", (mutations) => {
      if (scheduled || !context || !touchesSheet(mutations)) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        inject().catch((err) => console.warn(LOG, "could not add the Maintainerr rows to the item menu:", err));
      });
    }, { priority: 1 });
    JE.session?.onUserChange?.("maintainerr-item-menu", () => {
      context = null;
      adminCheck = null;
    });
    const menu = { inject, postpone, ROWS };
    JE.maintainerrMenu = menu;
    return { menu, capture };
  }

  // client/src/features/media-tags/editor/tag-item-menu-entry.ts
  var maintainerr = createMaintainerrMenu(export4());
  createItemMenu(export4(), maintainerr.capture);
})();
})();
//# sourceMappingURL=tag-item-menu.js.map
