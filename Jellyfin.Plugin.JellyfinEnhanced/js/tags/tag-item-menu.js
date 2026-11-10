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
  function createItemMenu(JE) {
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

  // client/src/features/media-tags/editor/tag-item-menu-entry.ts
  createItemMenu(export4());
})();
})();
//# sourceMappingURL=tag-item-menu.js.map
