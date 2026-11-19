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
  var export5 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
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
        item = export4(read) ? read : null;
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
  var maintainerr_item_menu_default = ".je-mt-backdrop{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px;animation:je-mt-fade .15s ease}\n@keyframes je-mt-fade{from{opacity:0}to{opacity:1}}\n.je-mt-dialog{--je-mt-accent:#00a4dc;background:linear-gradient(180deg,#252a2f,#1b1f23);color:#fff;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px 22px 18px;max-width:460px;width:100%;box-shadow:0 18px 60px rgba(0,0,0,.65);font-size:15px;animation:je-mt-pop .18s ease}\n@keyframes je-mt-pop{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}\n.je-mt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}\n.je-mt-title{margin:0;font-size:1.3em;font-weight:600;display:flex;align-items:center;gap:12px}\n.je-mt-logo{width:34px;height:34px;object-fit:contain;flex:none}\n.je-mt-x{background:none;border:none;color:inherit;opacity:.65;cursor:pointer;border-radius:50%;width:34px;height:34px;display:flex;align-items:center;justify-content:center;padding:0}\n.je-mt-x:hover,.je-mt-x:focus-visible{opacity:1;background:rgba(255,255,255,.1);outline:none}\n.je-mt-current{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,.06);margin-bottom:16px}\n.je-mt-current .material-icons{color:var(--je-mt-accent);font-size:26px}\n.je-mt-hint{margin:0;font-weight:600}\n.je-mt-when{opacity:.7;font-size:.9em;margin-top:2px}\n.je-mt-section{margin-bottom:16px}\n.je-mt-quick{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}\n.je-mt-button{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:inherit;border-radius:10px;padding:9px 12px;cursor:pointer;font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,border-color .15s,transform .1s}\n.je-mt-button:hover,.je-mt-button:focus-visible{background:rgba(255,255,255,.16);outline:none}\n.je-mt-button:active{transform:scale(.97)}\n.je-mt-day{border-radius:999px;padding:9px 6px;font-weight:600;background:color-mix(in srgb,var(--je-mt-accent) 18%,transparent);border-color:color-mix(in srgb,var(--je-mt-accent) 45%,transparent)}\n.je-mt-day:hover,.je-mt-day:focus-visible{background:color-mix(in srgb,var(--je-mt-accent) 38%,transparent)}\n.je-mt-primary{background:var(--je-mt-accent);border-color:transparent;color:var(--je-mt-on-accent,#fff);font-weight:600;padding:9px 16px}\n.je-mt-primary:hover,.je-mt-primary:focus-visible{filter:brightness(1.12);background:var(--je-mt-accent)}\n.je-mt-ghost{background:none;border-color:transparent;opacity:.8}\n.je-mt-custom{display:flex;align-items:flex-end;gap:10px}\n.je-mt-custom label{display:flex;flex-direction:column;gap:5px;flex:1}\n.je-mt-label,.je-mt-datelabel{font-size:.8em;opacity:.7;text-transform:uppercase;letter-spacing:.04em}\n.je-mt-input,.je-mt-date{background:rgba(0,0,0,.28);color:inherit;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 11px;font:inherit;width:100%;box-sizing:border-box;color-scheme:dark}\n.je-mt-input:focus,.je-mt-date:focus{border-color:var(--je-mt-accent);outline:none}\n.je-mt-preview{min-height:1.4em;margin:-4px 0 12px;text-align:center;font-size:.9em;color:var(--je-mt-accent);font-weight:600}\n.je-mt-footer{display:flex;justify-content:space-between;align-items:center;gap:8px;border-top:1px solid rgba(255,255,255,.08);padding-top:14px}\n.je-mt-reset .material-icons{font-size:20px}\n@media (max-width:420px){.je-mt-quick{grid-template-columns:repeat(2,1fr)}}\n";

  // client/src/features/media-tags/editor/maintainerr-item-menu.ts
  var RequestError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  };
  function createMaintainerrMenu(JE) {
    const ROWS = Object.freeze({ mark: "je-maintainerr-mark", keep: "je-maintainerr-keep", postpone: "je-maintainerr-postpone", request: "je-maintainerr-request" });
    const ROW_SELECTOR = Object.values(ROWS).map((id) => `[data-id="${id}"]`).join(", ");
    const TYPES = /* @__PURE__ */ new Set(["Movie", "Series", "Season"]);
    const CONTEXT_TTL_MS = 5e3;
    const DAY_MS2 = 864e5;
    const QUICK_DAYS = [7, 14, 30, 90];
    const MAX_DAYS = 3650;
    const ITEM_ROWS = ["addtocollection", "addtoplaylist", "share", "edit", "editimages", "editsubtitles", "identify", "moremediainfo", "refresh", "delete", "download", "copy-stream", "playallfromhere", "queueallfromhere", "resume", "play", "queue", "shuffle", "instantmix", "multiSelect", "removefromcollection"];
    const ITEM_ROW_SELECTOR = ITEM_ROWS.map((id) => `[data-id="${id}"]`).join(", ");
    const LOG2 = "🪼 Jellyfin Enhanced [Maintainerr]:";
    const featureCtx = export2(JE);
    let context = null;
    let adminCheck = null;
    function enabled() {
      return JE.pluginConfig?.MaintainerrActionsAvailable === true || JE.pluginConfig?.RemovalRequestsAvailable === true;
    }
    function exactDates() {
      return JE.pluginConfig?.LeavingSoonProvider === "reclaimerr";
    }
    function dayToIso(day) {
      const d = /* @__PURE__ */ new Date(`${day}T12:00:00`);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    }
    function isAdmin() {
      adminCheck ?? (adminCheck = Promise.resolve().then(() => export0().getCurrentUser()).then((user) => export4(user) && export4(user.Policy) && user.Policy.IsAdministrator === true).catch(() => {
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
    function pickedVersion(opener) {
      const page = opener?.matches(".btnMoreCommands") ? opener.closest("#itemDetailPage") : null;
      const value = page?.querySelector("select.selectSource")?.value;
      return value ? { mediaSourceId: value } : {};
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
          // Each tool has its own routes: JellyfinEnhanced/reclaimerr/... or JellyfinEnhanced/maintainerr/..., whichever is in use.
          url: client.getUrl(`JellyfinEnhanced/${exactDates() ? "reclaimerr" : "maintainerr"}/${path}`),
          dataType: "json",
          ...body ? { data: JSON.stringify(body), contentType: "application/json" } : {}
        });
      } catch (err) {
        const failure = export4(err) ? err : {};
        let reason = null;
        try {
          const answer = typeof failure.json === "function" ? await failure.json() : null;
          reason = export4(answer) ? export13(answer.error) : null;
        } catch {
        }
        const status = typeof failure.status === "number" ? failure.status : void 0;
        const message = reason || (status ? `HTTP ${status}` : String(export13(failure.message) ?? err));
        throw new RequestError(message, status);
      }
    }
    function stateOf(value) {
      return export4(value) ? value : null;
    }
    function daysLeft(deleteAt) {
      if (typeof deleteAt !== "number" || !Number.isFinite(deleteAt)) return null;
      const day = (ms) => {
        const d = new Date(ms);
        return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS2);
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
        const waiting = state?.AlreadyRequested;
        if (waiting) {
          JE.toast?.(JE.escapeHtml(JE.t(waiting === "mine" ? "maintainerr_already_requested_mine" : "maintainerr_already_requested")));
          return state;
        }
        try {
          window.dispatchEvent(new CustomEvent("je-leaving-soon-changed"));
        } catch {
        }
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
        console.warn(LOG2, path, "failed:", err);
        if (lease && !lease.isCurrent()) return null;
        JE.toast?.(JE.escapeHtml(JE.t("maintainerr_failed", { error: err instanceof Error ? err.message : "" })), 6e3);
        return null;
      }
    }
    function onAccent(accent) {
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)?.map(Number);
      probe.remove();
      if (!rgb || rgb.length < 3) return null;
      const [r = 0, g = 0, b = 0] = rgb;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "#10151a" : "#fff";
    }
    function postpone(itemId, state, opener, mode = "postpone", mediaSourceId) {
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
      const exact = exactDates();
      const tool = exact ? "reclaimerr" : "maintainerr";
      dialog.innerHTML = `<div class="je-mt-head"><h2 id="je-mt-title" class="je-mt-title"><img class="je-mt-logo" alt="" width="34" height="34" /><span class="je-mt-titletext"></span></h2><button type="button" class="je-mt-x" aria-label="Close"><i class="material-icons" aria-hidden="true">close</i></button></div><div class="je-mt-current"><i class="material-icons" aria-hidden="true">event</i><div><p class="je-mt-hint"></p><div class="je-mt-when"></div></div></div><div class="je-mt-section"><div class="je-mt-quick"></div></div><div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-label"></span><input type="number" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric" class="je-mt-input" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-apply"></button></div></div>` + (exact ? '<div class="je-mt-section"><div class="je-mt-custom"><label><span class="je-mt-datelabel"></span><input type="date" class="je-mt-date" /></label><button type="button" class="je-mt-button je-mt-primary je-mt-applydate"></button></div></div>' : "") + '<div class="je-mt-preview" aria-live="polite"></div><div class="je-mt-footer"><button type="button" class="je-mt-button je-mt-reset"></button><button type="button" class="je-mt-button je-mt-ghost je-mt-cancel"></button></div>';
      const setText = (selector, value) => {
        const el = dialog.querySelector(selector);
        if (el) el.textContent = value;
      };
      const logo = dialog.querySelector(".je-mt-logo");
      if (logo) {
        try {
          logo.src = JE.cdn.url("selfhst", `svg/${tool}.svg`);
          logo.title = exact ? "Reclaimerr" : "Maintainerr";
        } catch {
          logo.remove();
        }
      }
      setText(".je-mt-titletext", JE.t(mode === "mark" ? "reclaimerr_schedule_title" : exact ? "reclaimerr_change_date" : "maintainerr_postpone_title"));
      setText(".je-mt-datelabel", JE.t("reclaimerr_pick_date"));
      setText(".je-mt-applydate", JE.t("reclaimerr_apply_date"));
      if (days === null) dialog.querySelector(".je-mt-hint")?.remove();
      else setText(".je-mt-hint", JE.t("maintainerr_postpone_hint", { days }));
      setText(".je-mt-label", JE.t("maintainerr_postpone_days_label"));
      setText(".je-mt-apply", JE.t("maintainerr_postpone_apply"));
      try {
        const accent = JE.themer?.getThemeVariables?.()?.primaryAccent;
        if (accent) {
          dialog.style.setProperty("--je-mt-accent", accent);
          const text = onAccent(accent);
          if (text) dialog.style.setProperty("--je-mt-on-accent", text);
        }
      } catch {
      }
      const resetEl = dialog.querySelector(".je-mt-reset");
      if (resetEl) {
        resetEl.innerHTML = '<i class="material-icons" aria-hidden="true">restart_alt</i><span></span>';
        const label = resetEl.querySelector("span");
        if (label) label.textContent = JE.t("maintainerr_reset_timer");
      }
      setText(".je-mt-cancel", JE.t("maintainerr_cancel"));
      const quick = dialog.querySelector(".je-mt-quick");
      const input = dialog.querySelector(".je-mt-input");
      const shortDate2 = (ms) => new Date(ms).toLocaleDateString(void 0, { day: "numeric", month: "short", year: "numeric" });
      const known = typeof state.DeleteAt === "number" && Number.isFinite(state.DeleteAt);
      const base = known ? state.DeleteAt : Date.now();
      const whenEl = dialog.querySelector(".je-mt-when");
      if (whenEl) {
        if (known) whenEl.textContent = shortDate2(base);
        else whenEl.remove();
      }
      let armed = false;
      const previewEl = dialog.querySelector(".je-mt-preview");
      const preview = (ms) => {
        if (previewEl) previewEl.textContent = ms === null ? "" : JE.t("reclaimerr_new_date", { date: shortDate2(ms) });
      };
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
      const markUndo = { path: "unmark", body: { itemId }, doneKey: "maintainerr_kept" };
      const version = mediaSourceId ? { mediaSourceId } : {};
      const run = (count) => {
        close();
        if (mode === "mark") {
          const at = new Date(Date.now() + (count ?? 30) * DAY_MS2).toISOString();
          void act("mark", exact ? { itemId, date: at, ...version } : { itemId, ...version }, "maintainerr_marked", markUndo);
          return;
        }
        void act("postpone", count === null ? { itemId } : { itemId, days: count }, count === null ? "maintainerr_reset" : "maintainerr_postponed", null);
      };
      const runDate = (day) => {
        const iso = dayToIso(day);
        if (!iso) return;
        close();
        if (mode === "mark") void act("mark", { itemId, date: iso, ...version }, "maintainerr_marked", markUndo);
        else void act("postpone", { itemId, date: iso }, "maintainerr_postponed", null);
      };
      for (const count of QUICK_DAYS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "je-mt-button je-mt-day";
        b.textContent = JE.t("maintainerr_postpone_plus_days", { days: count });
        b.addEventListener("click", () => run(count));
        b.addEventListener("mouseenter", () => preview(base + count * DAY_MS2));
        b.addEventListener("mouseleave", () => preview(null));
        b.addEventListener("focus", () => {
          if (armed) preview(base + count * DAY_MS2);
        });
        b.addEventListener("blur", () => preview(null));
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
      input?.addEventListener("input", () => {
        const n = Math.floor(Number(input.value));
        preview(Number.isFinite(n) && n >= 1 && n <= MAX_DAYS ? base + n * DAY_MS2 : null);
      });
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          apply();
        }
      });
      const dateInput = dialog.querySelector(".je-mt-date");
      if (dateInput) {
        const tomorrow = Date.now() + DAY_MS2;
        const floor = (state.CollectionId ?? 0) > 0 && state.DeleteAt ? Math.max(Date.now(), state.DeleteAt) + DAY_MS2 : tomorrow;
        dateInput.min = new Date(floor).toISOString().slice(0, 10);
        dateInput.value = new Date(Date.now() + (mode === "mark" || days === null ? 30 : Math.max(days, 1)) * DAY_MS2).toISOString().slice(0, 10);
        dialog.querySelector(".je-mt-applydate")?.addEventListener("click", () => {
          if (dateInput.value) runDate(dateInput.value);
          else dateInput.focus();
        });
        dateInput.addEventListener("input", () => {
          const iso = dayToIso(dateInput.value);
          preview(iso ? new Date(iso).getTime() : null);
        });
      }
      const resetButton = dialog.querySelector(".je-mt-reset");
      if (mode === "mark") resetButton?.remove();
      else resetButton?.addEventListener("click", () => run(null));
      dialog.querySelector(".je-mt-cancel")?.addEventListener("click", close);
      dialog.querySelector(".je-mt-x")?.addEventListener("click", close);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) close();
      });
      document.addEventListener("keydown", onKey, true);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      const first = quick?.firstElementChild;
      if (first instanceof HTMLElement) first.focus();
      setTimeout(() => {
        armed = true;
      }, 0);
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
        type = export4(read) ? export13(read.Type) : null;
        if (context !== ctx || !scroller.isConnected) return;
      }
      if (!type || !TYPES.has(type)) return;
      context = null;
      const lease = JE.session?.createLease?.();
      const admin = await isAdmin();
      if (!admin && JE.pluginConfig?.RemovalRequestsAvailable !== true) return;
      let state = null;
      try {
        state = stateOf(await request("GET", `item/${ctx.itemId}`));
      } catch (err) {
        if (!(err instanceof RequestError && err.status === 404)) console.warn(LOG2, "could not read the item state:", err);
        return;
      }
      if (lease && !lease.isCurrent()) return;
      if (!state || !state.Supported || !scroller.isConnected || scroller.querySelector(ROW_SELECTOR)) return;
      const itemId = ctx.itemId;
      const opener = ctx.opener;
      const current = state;
      const rows = [];
      const exact = exactDates();
      if (!admin) {
        if (current.Marked || current.canRequest !== true) return;
        const ask = buildRow(scroller, ROWS.request, "delete_sweep", JE.t("reclaimerr_request"));
        ask.addEventListener("click", () => {
          setTimeout(() => {
            void act("request", { itemId }, "reclaimerr_requested", null);
          }, 0);
        });
        rows.push(ask);
      } else if (current.Marked) {
        const keep = buildRow(scroller, ROWS.keep, "restore", JE.t("maintainerr_keep"));
        keep.addEventListener("click", () => {
          setTimeout(() => {
            void act("unmark", { itemId }, "maintainerr_kept", exact ? null : { path: "mark", body: { itemId, ...pickedVersion(opener) }, doneKey: "maintainerr_marked" });
          }, 0);
        });
        const later = buildRow(scroller, ROWS.postpone, exact ? "event" : "more_time", JE.t(exact ? "reclaimerr_change_date" : "maintainerr_postpone"));
        later.addEventListener("click", () => {
          setTimeout(() => postpone(itemId, current, opener), 0);
        });
        rows.push(keep, later);
      } else {
        const mark = buildRow(scroller, ROWS.mark, "auto_delete", JE.t("maintainerr_mark"));
        mark.addEventListener("click", () => {
          setTimeout(() => {
            const version = pickedVersion(opener);
            if (exact) postpone(itemId, current, opener, "mark", version.mediaSourceId);
            else void act("mark", { itemId, ...version }, "maintainerr_marked", { path: "unmark", body: { itemId }, doneKey: "maintainerr_kept" });
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
        inject().catch((err) => console.warn(LOG2, "could not add the Maintainerr rows to the item menu:", err));
      });
    }, { priority: 1 });
    JE.session?.onUserChange?.("maintainerr-item-menu", () => {
      context = null;
      adminCheck = null;
    });
    const menu = { inject, postpone, act, ROWS };
    JE.removalMenu = menu;
    JE.maintainerrMenu = menu;
    return { menu, capture };
  }

  // client/src/features/media-tags/leaving-soon/leaving-soon-page.css
  var leaving_soon_page_default = ".je-ls { width: 100%; box-sizing: border-box; padding: 20px 3vw 48px; }\n.je-ls-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }\n.je-ls-title { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 1.6em; font-weight: 500; }\n.je-ls-heading { display: inline-flex; align-items: baseline; gap: 10px; }\n.je-ls-count { opacity: .65; font-size: .55em; font-weight: 400; }\n.je-ls-spacer { flex: 1; }\n.je-ls-pills { display: flex; gap: 8px; }\n.je-ls-pill, .je-ls-btn { border: 1px solid rgba(128,128,128,.4); background: rgba(128,128,128,.16); color: inherit; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; font-size: .9em; }\n.je-ls-btn { border-radius: 6px; padding: 5px 10px; font-size: .85em; }\n.je-ls-pill:hover, .je-ls-btn:hover, .je-ls-pill:focus-visible, .je-ls-btn:focus-visible { background: rgba(128,128,128,.34); outline: none; }\n.je-ls-refresh { background: none; border: none; cursor: pointer; color: inherit; opacity: .75; padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }\n.je-ls-refresh:hover, .je-ls-refresh:focus-visible { background: rgba(128,128,128,.2); opacity: 1; outline: none; }\n.je-ls-refresh .material-icons { font-size: 22px; }\n.je-ls-refresh.spin .material-icons { animation: je-ls-spin .6s ease; }\n@keyframes je-ls-spin { to { transform: rotate(360deg); } }\n.je-ls-icon-btn { width: 36px; height: 36px; box-sizing: border-box; border: 1px solid rgba(128,128,128,.4); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: inherit; background: rgba(128,128,128,.16); padding: 0; flex: none; transition: background .15s, border-color .15s, color .15s; }\n.je-ls-icon-btn:hover, .je-ls-icon-btn:focus-visible { background: rgba(128,128,128,.34); outline: none; }\n.je-ls-icon-btn[disabled] { opacity: .5; cursor: default; }\n.je-ls-icon-btn .material-icons { font-size: 20px; line-height: 1; }\n.je-ls-icon-btn.approve, .je-ls-icon-btn.keep { color: #3fbf6a; border-color: rgba(63,191,106,.55); }\n.je-ls-icon-btn.deny { color: #ef5350; border-color: rgba(239,83,80,.55); }\n.je-ls-icon-btn.date { color: var(--je-ls-accent, #00a4dc); border-color: rgba(0,164,220,.55); }\n.je-ls-icon-btn.approve:hover, .je-ls-icon-btn.approve:focus-visible, .je-ls-icon-btn.keep:hover, .je-ls-icon-btn.keep:focus-visible { background: #2e9d4f; border-color: #2e9d4f; color: #fff; }\n.je-ls-icon-btn.deny:hover, .je-ls-icon-btn.deny:focus-visible { background: #d03a3a; border-color: #d03a3a; color: #fff; }\n.je-ls-icon-btn.date:hover, .je-ls-icon-btn.date:focus-visible { background: var(--je-ls-accent, #00a4dc); border-color: transparent; color: #fff; }\n.je-ls-pill.active { background: rgba(128,128,128,.34); border-color: var(--je-ls-accent, #00a4dc); font-weight: 600; }\n.je-ls-btn[disabled] { opacity: .5; cursor: default; }\n.je-ls-btn.danger { background: #d03a3a; border-color: transparent; color: #fff; }\n/* Cards: the Requests page's layout (poster left, details right), one column on a phone. */\n.je-ls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.1em; }\n.je-ls-card { display: flex; gap: 1em; padding: 1em; border-radius: .5em; background: rgba(128,128,128,.1); min-width: 0; }\n.je-ls-poster { position: relative; width: 80px; height: 120px; flex: none; border-radius: .5em; overflow: hidden; background: rgba(128,128,128,.18); cursor: pointer; }\n.je-ls-poster.plain { cursor: default; }\n.je-ls-poster img { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; object-fit: cover; display: block; }\n.je-ls-poster .je-ls-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2.2em; opacity: .35; }\n.je-ls-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .3em; }\n.je-ls-head { display: flex; align-items: baseline; gap: .4em; min-width: 0; }\n.je-ls-name { font-weight: 600; line-height: 1.25; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }\n.je-ls-name.plain { cursor: default; }\n.je-ls-year { opacity: .65; font-size: .85em; flex: none; }\n.je-ls-sub { opacity: .7; font-size: .85em; overflow-wrap: anywhere; }\n.je-ls-note { font-style: italic; }\n.je-ls-badges { display: flex; gap: .4em; flex-wrap: wrap; align-items: center; }\n.je-ls-chip, .je-ls-scope { display: inline-block; padding: .18em .6em; border-radius: 999px; font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; line-height: 1.4; color: #fff; background: rgba(90,90,90,.85); }\n.je-ls-scope { background: rgba(128,128,128,.28); color: inherit; text-transform: none; font-weight: 600; }\n.je-ls-chip.warn { background: #c77c0a; }\n.je-ls-chip.urgent { background: #c62828; }\n.je-ls-chip.ok { background: #2e7d32; }\n.je-ls-chip.soon { background: rgba(0,164,220,.85); }\n.je-ls-actions, .je-ls-reqactions { margin-top: auto; padding-top: .4em; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }\n.je-ls-reqactions:has(.je-ls-warn) { flex-direction: column; align-items: stretch; gap: 8px; }\n.je-ls-warn { font-size: .82em; line-height: 1.3; color: #ef7a6c; }\n.je-ls-confirm { display: flex; gap: 6px; flex-wrap: wrap; }\n.je-ls-note-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.45); background: rgba(128,128,128,.12); color: inherit; font: inherit; font-size: .85em; }\n.je-ls-who { display: flex; align-items: center; gap: 6px; font-size: .88em; opacity: .9; flex-wrap: wrap; }\n.je-ls-avatar { position: relative; width: 22px; height: 22px; border-radius: 50%; background: var(--je-ls-accent, #00a4dc); color: #fff; font-size: .75em; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex: none; }\n.je-ls-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }\n.je-ls-err { font-size: .82em; color: #ef7a6c; overflow-wrap: anywhere; }\n.je-ls-section { margin-top: 34px; }\n.je-ls-section h3 { margin: 0 0 12px; font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; }\n.je-ls-notice { padding: 10px 12px; border-radius: 8px; background: rgba(199,124,10,.18); font-size: .9em; margin-top: 24px; }\n.je-ls-empty { opacity: .7; padding: 40px 0; text-align: center; }\n@media (max-width: 600px) {\n  .je-ls-top { gap: 10px; }\n  .je-ls-title { flex: 1 0 100%; }\n  .je-ls-pills { order: 1; }\n  .je-ls-spacer { order: 2; }\n  .je-ls-refresh { order: 3; }\n  .je-ls-grid { grid-template-columns: minmax(0, 1fr); gap: .8em; }\n  .je-ls-card { padding: .8em; gap: .8em; }\n  .je-ls-poster { width: 72px; height: 108px; }\n}\n";

  // client/src/features/media-tags/leaving-soon/leaving-soon-page.ts
  var LOG = "🪼 Jellyfin Enhanced: Leaving Soon:";
  var POLL_MS = 5 * 60 * 1e3;
  var DAY_MS = 864e5;
  function listOf(value) {
    const data = export4(value) ? value : {};
    const items = Array.isArray(data.items) ? data.items.filter(export4) : [];
    const rows = (v) => Array.isArray(v) ? v.filter(export4) : [];
    return {
      provider: data.provider === "reclaimerr" ? "reclaimerr" : "maintainerr",
      admin: data.admin === true,
      canRequest: data.canRequest === true,
      actions: data.actions === true,
      items,
      requests: rows(data.requests),
      mine: rows(data.mine),
      requestsUnavailable: data.requestsUnavailable === true,
      canSchedule: data.canSchedule === true,
      graceDays: typeof data.graceDays === "number" && Number.isInteger(data.graceDays) ? data.graceDays : null
    };
  }
  var shortDate = (date) => date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  var utcDate = (value) => new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  var pad2 = (n) => String(n).padStart(2, "0");
  var localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  var parseColour = (value) => {
    const m = String(value || "").match(/[\d.]+/g);
    return m && m.length >= 3 ? m.map(Number) : null;
  };
  var brightness = (c) => 0.299 * (c[0] ?? 0) + 0.587 * (c[1] ?? 0) + 0.114 * (c[2] ?? 0);
  function opaqueSurface(el) {
    const candidates = [];
    for (let n = el.parentElement; n; n = n.parentElement) candidates.push(n);
    for (const sel of [".backgroundContainer", ".skinBody"]) {
      const n = document.querySelector(sel);
      if (n) candidates.push(n);
    }
    for (const n of candidates) {
      const c = parseColour(getComputedStyle(n).backgroundColor);
      if (c && (c.length === 3 || (c[3] ?? 0) >= 0.95)) return c;
    }
    return null;
  }
  function paintPopups(select, dateInput) {
    const text = parseColour(getComputedStyle(select).color);
    const light = !!text && brightness(text) > 140;
    const surface = opaqueSurface(select);
    const readable = !!text && !!surface && Math.abs(brightness(text) - brightness(surface)) > 90;
    const bg = readable && surface ? `rgb(${surface[0]}, ${surface[1]}, ${surface[2]})` : light ? "#2b2b2b" : "#ffffff";
    const fg = readable && text ? `rgb(${text[0]}, ${text[1]}, ${text[2]})` : light ? "#f2f2f2" : "#1a1a1a";
    for (const el of [select, dateInput]) if (el) el.style.colorScheme = light ? "dark" : "light";
    for (const option of select.options) {
      option.style.backgroundColor = bg;
      option.style.color = fg;
    }
  }
  function formatSize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
    const gb = bytes / 1073741824;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
  }
  function tmdbPoster(path) {
    if (!path) return null;
    if (path.startsWith("https://image.tmdb.org/")) return path;
    return path.startsWith("/") ? `https://image.tmdb.org/t/p/w185${path}` : null;
  }
  function requesterNote(note) {
    const text = (note ?? "").trim();
    if (/^(?:Approved|Denied) by .+ in Jellyfin$/.test(text)) return "";
    return text.replace(/ \((?:Approved|Denied) by [^()]+ in Jellyfin\)$/, "");
  }
  function navigateToItem(itemId) {
    if (!itemId) return;
    try {
      const host = window;
      if (host.Emby?.Page?.showItem) {
        host.Emby.Page.showItem(itemId);
        return;
      }
    } catch {
    }
    window.location.hash = `#!/details?id=${itemId}`;
  }
  function createLeavingSoonPage(JE) {
    if (JE.pluginConfig?.LeavingSoonPageEnabled !== true) return null;
    let pollTimer = null;
    let mounted = null;
    let filter = "all";
    let spinUntil = 0;
    let loadTicket = 0;
    let drawnHost = null;
    const t = (key, params) => {
      try {
        return JE.t(key, params);
      } catch {
        return key;
      }
    };
    const esc = (value) => JE.escapeHtml(String(value ?? ""));
    function daysLeft(deleteAt) {
      if (typeof deleteAt !== "number" || !Number.isFinite(deleteAt)) return null;
      const day = (ms) => {
        const d = new Date(ms);
        return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
      };
      return day(deleteAt) - day(Date.now());
    }
    function relativeDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const diff = Date.now() - date.getTime();
      if (diff < 0) return shortDate(date);
      const minutes = Math.floor(diff / 6e4), hours = Math.floor(diff / 36e5), days = Math.floor(diff / DAY_MS);
      if (minutes < 1) return t("requests_just_now");
      if (minutes < 60) return t("requests_minutes_ago").replace("{minutes}", String(minutes));
      if (hours < 24) return t("requests_hours_ago").replace("{hours}", String(hours));
      if (days < 30) return t("requests_days_ago").replace("{days}", String(days));
      return shortDate(date);
    }
    function chip(deleteAt) {
      const d = daysLeft(deleteAt);
      if (d === null) return { text: t("leavingsoon_soon"), level: "soon" };
      if (d <= 0) return { text: t("leavingsoon_today"), level: "urgent" };
      if (d === 1) return { text: t("leavingsoon_tomorrow"), level: "urgent" };
      return { text: t("leavingsoon_in_days", { days: d }), level: d <= 7 ? "warn" : "soon" };
    }
    function injectStyles() {
      JE.core.ui?.injectCss?.("je-leavingsoon-styles", leaving_soon_page_default);
      try {
        document.documentElement.style.setProperty("--je-ls-accent", JE.themer?.getThemeVariables?.()?.primaryAccent || "#00a4dc");
      } catch {
      }
    }
    async function load() {
      const client = export0();
      return listOf(await client.ajax({ type: "GET", url: client.getUrl("JellyfinEnhanced/leaving-soon/list"), dataType: "json" }));
    }
    async function reasonOf(err) {
      const failure = export4(err) ? err : {};
      try {
        const body = typeof failure.json === "function" ? await failure.json() : null;
        if (export4(body) && typeof body.error === "string" && body.error) return body.error;
      } catch {
      }
      return typeof failure.status === "number" ? String(failure.status) : "";
    }
    async function review(id, approve, button, note, timing) {
      button.disabled = true;
      try {
        const client = export0();
        await client.ajax({ type: "POST", url: client.getUrl(`JellyfinEnhanced/reclaimerr/requests/${id}/${approve ? "approve" : "deny"}`), data: JSON.stringify({ ...note ? { note } : {}, ...timing ?? {} }), contentType: "application/json", dataType: "json" });
        JE.toast?.(esc(t(approve ? "leavingsoon_approved" : "leavingsoon_denied")));
        void refresh();
      } catch (err) {
        JE.toast?.(esc(t("maintainerr_failed", { error: await reasonOf(err) })), 6e3);
        button.disabled = false;
      }
    }
    function iconButton(kind, icon, label) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `je-ls-icon-btn ${kind}`;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.innerHTML = `<i class="material-icons" aria-hidden="true">${esc(icon)}</i>`;
      return b;
    }
    function linkTo(el, itemId) {
      for (const target of el.querySelectorAll(".je-ls-poster, .je-ls-name")) {
        target.addEventListener("click", () => navigateToItem(itemId));
        target.addEventListener("keydown", (e) => {
          if (e.key === "Enter") navigateToItem(itemId);
        });
      }
    }
    function card(item, data) {
      const c = chip(item.deleteAt);
      const el = document.createElement("div");
      el.className = "je-ls-card";
      el.dataset.type = String(item.type ?? "");
      const poster = export0().getUrl(`Items/${encodeURIComponent(String(item.id))}/Images/Primary`, { maxHeight: 360, quality: 90 });
      const date = typeof item.deleteAt === "number" && Number.isFinite(item.deleteAt) ? shortDate(new Date(item.deleteAt)) : "";
      const when = [date ? t("leavingsoon_leaves_on", { date }) : "", formatSize(item.size)].filter(Boolean).join(" · ");
      el.innerHTML = `<div class="je-ls-poster" role="link" tabindex="0"><span class="je-ls-fallback material-icons" aria-hidden="true">${item.type === "Movie" ? "movie" : "tv"}</span><img alt="" loading="lazy" src="${esc(poster)}"/></div><div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name" role="link" tabindex="0" title="${esc(item.name)}">${esc(item.name)}</div>` + (item.year ? `<span class="je-ls-year">(${esc(item.year)})</span>` : "") + "</div>" + (item.detail ? `<div class="je-ls-sub">${esc(item.detail)}</div>` : "") + `<div class="je-ls-badges"><span class="je-ls-chip ${esc(c.level)}">${esc(c.text)}</span>` + (item.versionOnly ? `<span class="je-ls-scope">${esc(t("leavingsoon_one_version"))}</span>` : "") + "</div>" + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : "") + (data.actions ? '<div class="je-ls-actions"></div>' : "") + "</div>";
      const img = el.querySelector("img");
      img?.addEventListener("error", () => img.remove());
      linkTo(el, item.id);
      const actions = el.querySelector(".je-ls-actions");
      if (actions) {
        const reclaimerr = data.provider === "reclaimerr";
        const keep = iconButton("keep", "shield", t("maintainerr_keep"));
        keep.addEventListener("click", () => {
          void (JE.removalMenu ?? JE.maintainerrMenu)?.act?.("unmark", { itemId: item.id }, "maintainerr_kept", reclaimerr ? null : { path: "mark", body: { itemId: item.id }, doneKey: "maintainerr_marked" });
        });
        const when2 = iconButton("date", "event", t(reclaimerr ? "reclaimerr_change_date" : "maintainerr_postpone"));
        when2.addEventListener("click", () => (JE.removalMenu ?? JE.maintainerrMenu)?.postpone?.(item.id, { Marked: true, DeleteAt: item.deleteAt ?? null }, when2));
        actions.append(keep, when2);
      }
      return el;
    }
    function requestPoster(r) {
      if (r.itemId) return export0().getUrl(`Items/${encodeURIComponent(r.itemId)}/Images/Primary`, { maxHeight: 360, quality: 90 });
      return tmdbPoster(r.posterPath);
    }
    function scopeLabel(r) {
      if (r.scope === "season" && r.seasonNumber != null) return t("leavingsoon_scope_season", { season: r.seasonNumber });
      if (r.scope === "episode" && r.episodeNumber != null && r.seasonNumber != null) return t("leavingsoon_scope_episode", { season: r.seasonNumber, episode: r.episodeNumber });
      if (r.scope === "movie_version") return [t("leavingsoon_scope_version"), r.versionResolution, formatSize(r.versionSize)].filter(Boolean).join(" · ");
      return "";
    }
    function requestChip(r) {
      if (r.executionError || r.scheduleState === "failed" || r.scheduleState === "blocked") return { text: t("leavingsoon_status_failed"), level: "urgent" };
      if (r.deferred) return { text: t("leavingsoon_status_deferred"), level: "warn" };
      return { text: t(`leavingsoon_status_${r.status}`) || r.status, level: r.status === "denied" ? "urgent" : r.status === "approved" ? "ok" : "warn" };
    }
    function requestCard(r, admin, canSchedule = false, graceDays = null) {
      const el = document.createElement("div");
      el.className = "je-ls-card je-ls-reqcard";
      const when = r.createdAt ? relativeDate(r.createdAt) : "";
      const poster = requestPoster(r);
      const person = r.jellyfinUser || r.requestedBy || "";
      const linked = r.itemId ? ' role="link" tabindex="0"' : "";
      const state = requestChip(r);
      const scope = scopeLabel(r);
      const answer = admin ? "" : requesterNote(r.adminNotes);
      const leaves = r.scheduledAt && r.status === "approved" ? utcDate(r.scheduledAt) : null;
      const avatar = r.jellyfinUserId ? `<img alt="" src="${esc(export0().getUrl(`Users/${encodeURIComponent(r.jellyfinUserId)}/Images/Primary`, { maxHeight: 48, quality: 90 }))}"/>` : "";
      el.innerHTML = `<div class="je-ls-poster${r.itemId ? "" : " plain"}"${linked}><span class="je-ls-fallback material-icons" aria-hidden="true">${r.mediaType === "movie" ? "movie" : "tv"}</span>` + (poster ? `<img alt="" loading="lazy" src="${esc(poster)}"/>` : "") + `</div><div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name${r.itemId ? "" : " plain"}"${linked} title="${esc(r.title)}">${esc(r.title)}</div>` + (r.year ? `<span class="je-ls-year">(${esc(r.year)})</span>` : "") + `</div><div class="je-ls-badges"><span class="je-ls-chip ${esc(state.level)}">${esc(state.text)}</span>${scope ? `<span class="je-ls-scope">${esc(scope)}</span>` : ""}</div><div class="je-ls-who"${admin && r.requestedBy ? ` title="${esc(t("leavingsoon_reclaimerr_account", { name: r.requestedBy }))}"` : ""}>` + (person ? `<span class="je-ls-avatar" aria-hidden="true">${esc(person.charAt(0).toUpperCase())}${avatar}</span><span>${esc(t("leavingsoon_requested_by", { name: person }))}</span>` : "") + "</div>" + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : "") + (leaves && !Number.isNaN(leaves.getTime()) ? `<div class="je-ls-sub">${esc(t("leavingsoon_leaves_on", { date: shortDate(leaves) }))}</div>` : "") + (r.note ? `<div class="je-ls-sub je-ls-note">${esc(r.note)}</div>` : "") + (answer ? `<div class="je-ls-sub je-ls-note">${esc(answer)}</div>` : "") + (r.executionError ? `<div class="je-ls-err">${esc(r.executionError)}</div>` : "") + (admin && r.status === "pending" ? '<div class="je-ls-reqactions"></div>' : "") + "</div>";
      for (const img of el.querySelectorAll("img")) img.addEventListener("error", () => img.remove());
      if (r.itemId) linkTo(el, r.itemId);
      const actions = el.querySelector(".je-ls-reqactions");
      if (actions) {
        const box = actions;
        const showChoice = () => {
          box.textContent = "";
          const ok = iconButton("approve", "check", t("leavingsoon_approve"));
          const no = iconButton("deny", "close", t("leavingsoon_deny"));
          ok.addEventListener("click", showConfirm);
          no.addEventListener("click", () => {
            void review(r.id, false, no);
          });
          box.append(ok, no);
        };
        const deleteText = scope ? t("leavingsoon_confirm_delete_scope", { scope }) : t("leavingsoon_confirm_delete");
        const showConfirm = () => {
          box.textContent = "";
          const warn = document.createElement("div");
          warn.className = "je-ls-warn";
          warn.textContent = deleteText;
          const note = document.createElement("input");
          note.type = "text";
          note.className = "je-ls-note-input";
          note.maxLength = 300;
          note.placeholder = t("leavingsoon_note_placeholder");
          note.setAttribute("aria-label", t("leavingsoon_note_placeholder"));
          const row = document.createElement("div");
          row.className = "je-ls-confirm";
          const yes = document.createElement("button");
          yes.type = "button";
          yes.className = "je-ls-btn danger";
          yes.textContent = t(canSchedule ? "leavingsoon_approve" : "leavingsoon_delete_now");
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "je-ls-btn";
          cancel.textContent = t("maintainerr_cancel");
          const parts = [warn];
          let choice = null;
          if (canSchedule) {
            const when2 = document.createElement("select");
            when2.className = "je-ls-note-input";
            when2.setAttribute("aria-label", t("reclaimerr_schedule_title"));
            const options = [
              ["default", graceDays !== null && graceDays > 0 ? t("leavingsoon_when_default_days", { days: graceDays }) : t("leavingsoon_when_default")],
              ["now", t("leavingsoon_delete_now")],
              ["date", t("leavingsoon_when_date")]
            ];
            for (const [value, label] of options) {
              const option = document.createElement("option");
              option.value = value;
              option.textContent = label;
              when2.appendChild(option);
            }
            const day = document.createElement("input");
            day.type = "datetime-local";
            day.className = "je-ls-note-input";
            day.hidden = true;
            day.min = localInput(new Date(Date.now() + 6e4));
            day.value = localInput(new Date(Date.now() + 7 * DAY_MS));
            day.setAttribute("aria-label", t("leavingsoon_when_date"));
            const sync = () => {
              day.hidden = when2.value !== "date";
              const picked = new Date(day.value);
              const valid = when2.value !== "date" || day.value !== "" && !Number.isNaN(picked.getTime()) && picked.getTime() > Date.now();
              yes.disabled = !valid;
              warn.textContent = when2.value === "now" ? deleteText : when2.value === "date" ? valid ? t("leavingsoon_confirm_on", { date: shortDate(picked) }) : "" : graceDays === 0 ? deleteText : graceDays !== null && graceDays > 0 ? t("leavingsoon_confirm_on", { date: shortDate(new Date(Date.now() + graceDays * DAY_MS)) }) : t("leavingsoon_confirm_grace");
            };
            when2.addEventListener("change", sync);
            day.addEventListener("input", sync);
            parts.push(when2, day);
            choice = { when: when2, day };
            sync();
          }
          yes.addEventListener("click", () => {
            const timing = !choice ? null : choice.when.value === "date" ? { when: "date", date: new Date(choice.day.value).toISOString() } : { when: choice.when.value };
            void review(r.id, true, yes, note.value.trim(), timing);
          });
          cancel.addEventListener("click", showChoice);
          row.append(yes, cancel);
          box.append(...parts, note, row);
          if (choice) paintPopups(choice.when, choice.day);
        };
        showChoice();
      }
      return el;
    }
    function section(icon, title, rows, admin, data) {
      const sec = document.createElement("div");
      sec.className = "je-ls-section";
      sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">${esc(icon)}</span>${esc(title)}</h3>`;
      const grid = document.createElement("div");
      grid.className = "je-ls-grid";
      for (const r of rows) grid.appendChild(requestCard(r, admin, data?.canSchedule === true, data?.graceDays ?? null));
      sec.appendChild(grid);
      return sec;
    }
    function textButton(className, label) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = className;
      b.textContent = label;
      return b;
    }
    function topBar(host, data) {
      const items = data.items;
      const top = document.createElement("div");
      top.className = "je-ls-top";
      const title = document.createElement("h2");
      title.className = "je-ls-title";
      title.innerHTML = '<span class="material-icons" aria-hidden="true">auto_delete</span>';
      const heading = document.createElement("span");
      heading.className = "je-ls-heading";
      heading.textContent = t("leavingsoon_title");
      const count = document.createElement("span");
      count.className = "je-ls-count";
      count.textContent = `${items.length} ${t(items.length === 1 ? "leavingsoon_item" : "leavingsoon_items")}`;
      heading.appendChild(count);
      title.appendChild(heading);
      const spacer = document.createElement("span");
      spacer.className = "je-ls-spacer";
      const pills = document.createElement("div");
      pills.className = "je-ls-pills";
      if (items.length) {
        for (const [key, label] of [["all", "leavingsoon_all"], ["movies", "leavingsoon_movies"], ["shows", "leavingsoon_shows"]]) {
          const b = textButton(`je-ls-pill${filter === key ? " active" : ""}`, t(label));
          b.addEventListener("click", () => {
            filter = key;
            draw(host, data);
          });
          pills.appendChild(b);
        }
      }
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = `je-ls-refresh${Date.now() < spinUntil ? " spin" : ""}`;
      refreshButton.dataset.refresh = "";
      refreshButton.title = t("leavingsoon_refresh");
      refreshButton.setAttribute("aria-label", t("leavingsoon_refresh"));
      refreshButton.innerHTML = '<i class="material-icons" aria-hidden="true">refresh</i>';
      refreshButton.addEventListener("click", () => {
        spinUntil = Date.now() + 600;
        void refresh();
      });
      top.append(title, spacer, pills, refreshButton);
      return top;
    }
    function draw(host, data) {
      host.textContent = "";
      const root = document.createElement("div");
      root.className = "je-ls";
      const items = data.items;
      const shown = items.filter((i) => filter === "all" || (filter === "movies" ? i.type === "Movie" : i.type !== "Movie"));
      root.appendChild(topBar(host, data));
      if (!shown.length) {
        const empty = document.createElement("div");
        empty.className = "je-ls-empty";
        empty.textContent = t(items.length ? "leavingsoon_none_here" : "leavingsoon_none");
        root.appendChild(empty);
      } else {
        const grid = document.createElement("div");
        grid.className = "je-ls-grid";
        for (const item of shown) grid.appendChild(card(item, data));
        root.appendChild(grid);
      }
      if (data.requestsUnavailable) {
        const notice = document.createElement("div");
        notice.className = "je-ls-notice";
        notice.textContent = t("leavingsoon_requests_unavailable");
        root.appendChild(notice);
      }
      if (data.admin && data.requests.length) root.appendChild(section("inbox", t("leavingsoon_requests_title", { count: data.requests.length }), data.requests, true, data));
      if (!data.admin && data.mine.length) root.appendChild(section("outbox", t("leavingsoon_my_requests"), data.mine, false));
      host.appendChild(root);
      drawnHost = host;
    }
    async function refresh() {
      if (!mounted) return;
      const ticket = ++loadTicket;
      const lease = JE.session?.createLease?.();
      try {
        const data = await load();
        if (ticket === loadTicket && mounted && (!lease || lease.isCurrent())) draw(mounted, data);
      } catch (err) {
        console.warn(LOG, "could not load the list:", err);
        if (ticket === loadTicket && mounted && drawnHost !== mounted) mounted.textContent = t("leavingsoon_unavailable");
      }
    }
    const onChanged = () => {
      void refresh();
    };
    function stopPolling() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      window.removeEventListener("je-leaving-soon-changed", onChanged);
    }
    function renderForCustomTab(host) {
      stopPolling();
      if (mounted && mounted !== host) mounted.replaceChildren();
      mounted = host;
      drawnHost = null;
      injectStyles();
      host.textContent = t("leavingsoon_loading");
      void refresh();
      pollTimer = setInterval(() => {
        void refresh();
      }, POLL_MS);
      window.addEventListener("je-leaving-soon-changed", onChanged);
    }
    JE.core.navigation?.onNavigate?.(() => {
      if (mounted && !mounted.isConnected) {
        stopPolling();
        mounted = null;
      }
    });
    const page = { injectStyles, renderForCustomTab, stopPolling, chip, daysLeft };
    JE.leavingSoonPage = page;
    JE.session?.onUserChange?.("leaving-soon-page", () => {
      loadTicket++;
    });
    return page;
  }

  // client/src/features/media-tags/leaving-soon/leaving-soon-custom-tab.ts
  function mountLeavingSoonTab(JE) {
    const config = JE.pluginConfig;
    if (config?.LeavingSoonPageEnabled !== true) return;
    const useCustomTabs = config.LeavingSoonPageUseCustomTabs === true;
    const useNativeTab = config.LeavingSoonPageUseNativeTab === true;
    if (!useCustomTabs && !useNativeTab) return;
    if (useNativeTab) {
      JE.nativeTabs?.register("leavingsoon", JE.t("leavingsoon_title") || "Leaving Soon", (panel) => {
        const marker = document.createElement("div");
        marker.className = "jellyfinenhanced leavingsoon";
        panel.appendChild(marker);
      }, "auto_delete");
    }
    JE.core.ui?.injectCss?.("je-leavingsoon-tab", [
      ".backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.leavingsoon) {",
      "  background: rgba(0, 0, 0, 0.7) !important;",
      "  opacity: 1 !important;",
      "}"
    ].join("\n"));
    let lastMountedContainer = null;
    function isOnHomePage() {
      const hash = window.location.hash.replace(/^#!/, "#");
      return hash === "" || hash === "#/home" || hash === "#/home.html" || hash.indexOf("#/home?") !== -1 || hash.indexOf("#/home.html?") !== -1 || hash.indexOf("#/home#") === 0 || hash.indexOf("#/home.html#") === 0;
    }
    function findActiveContainer() {
      const all = document.querySelectorAll(".jellyfinenhanced.leavingsoon");
      for (let i = all.length - 1; i >= 0; i--) {
        const el = all[i];
        if (el && JE.helpers?.isActiveTabContainer?.(el)) return el;
      }
      return null;
    }
    function render(container) {
      const page = JE.leavingSoonPage;
      if (!page) return;
      container.classList.remove("hide");
      container.style.display = "";
      const child = document.createElement("div");
      child.id = "je-leavingsoon-container-tab";
      container.textContent = "";
      container.appendChild(child);
      page.injectStyles();
      page.renderForCustomTab(child);
      lastMountedContainer = container;
    }
    let wasOnHomePage = false;
    function tryMount() {
      const onHome = isOnHomePage();
      if (!onHome) {
        if (wasOnHomePage) {
          JE.leavingSoonPage?.stopPolling();
          lastMountedContainer = null;
        }
        wasOnHomePage = false;
        return;
      }
      const justReturned = !wasOnHomePage;
      wasOnHomePage = true;
      const container = findActiveContainer();
      if (!container) {
        if (lastMountedContainer) JE.leavingSoonPage?.stopPolling();
        lastMountedContainer = null;
        return;
      }
      const shouldMount = justReturned || container !== lastMountedContainer || !container.hasChildNodes() || lastMountedContainer && !document.contains(lastMountedContainer);
      if (shouldMount) render(container);
    }
    tryMount();
    JE.core.navigation?.onNavigate?.(tryMount);
    JE.helpers?.observeTabContainers?.("leavingsoon-custom-tab", ".jellyfinenhanced.leavingsoon", tryMount);
  }

  // client/src/features/media-tags/editor/tag-item-menu-entry.ts
  var maintainerr = createMaintainerrMenu(export5());
  createItemMenu(export5(), maintainerr.capture);
  createLeavingSoonPage(export5());
  mountLeavingSoonTab(export5());
})();
})();
//# sourceMappingURL=tag-item-menu.js.map
