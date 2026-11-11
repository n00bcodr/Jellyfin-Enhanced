(() => {
"use strict";
(() => {
  // client/src/features/shared/wire.ts
  function currentLease(session, getApi) {
    const epoch = session?.getEpoch(), user = getApi?.()?.getCurrentUserId(), server = getApi?.()?.getUrl("/");
    return () => (epoch === void 0 || session?.isCurrent(epoch) === true) && user === getApi?.()?.getCurrentUserId() && server === getApi?.()?.getUrl("/");
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function object(value) {
    if (!record(value)) throw Error("Invalid response object");
    return value;
  }
  function string(value) {
    if (typeof value !== "string") throw Error("Invalid response string");
    return value;
  }
  function number(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error("Invalid response number");
    return value;
  }
  function optionalString(value) {
    return value == null ? void 0 : string(value);
  }
  function optionalNumber(value) {
    return value == null ? void 0 : number(value);
  }
  function array(value, decode) {
    if (!Array.isArray(value)) throw Error("Invalid response array");
    return value.map(decode);
  }

  // client/src/features/catchup/model.ts
  function readItem(value) {
    const v = object(value), tags = v.ImageTags == null ? {} : object(v.ImageTags), user = v.UserData == null ? {} : object(v.UserData);
    return {
      Id: string(v.Id),
      Name: string(v.Name),
      Type: optionalString(v.Type),
      SeriesId: optionalString(v.SeriesId),
      SeriesPrimaryImageTag: optionalString(v.SeriesPrimaryImageTag),
      ImageTags: { Primary: optionalString(tags.Primary) },
      Genres: v.Genres == null ? void 0 : array(v.Genres, string),
      Overview: optionalString(v.Overview),
      ChildCount: optionalNumber(v.ChildCount),
      RunTimeTicks: optionalNumber(v.RunTimeTicks),
      ProductionYear: optionalNumber(v.ProductionYear),
      CommunityRating: optionalNumber(v.CommunityRating),
      IndexNumber: optionalNumber(v.IndexNumber),
      UserData: { UnplayedItemCount: optionalNumber(user.UnplayedItemCount) }
    };
  }
  function readItems(value) {
    return array(object(value).Items, readItem);
  }

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/catchup/host.ts
  function catchupHost() {
    const host = window, JE = host.JellyfinEnhanced;
    const ctx = JE && featureContext("catchup", JE, {
      facades: ["catchUpPage"],
      internalSlots: ["catchUp"],
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
    return { host, ctx, getApi: () => host.ApiClient, Emby: host.Emby };
  }

  // client/src/features/catchup/catchup-deck.ts
  (function() {
    "use strict";
    const { ctx: context, getApi } = catchupHost();
    if (!context) return;
    const ctx = context, JE = ctx.core;
    if (!JE?.pluginConfig?.CatchUpEnabled) return;
    const runtime = ctx.own.catchUp;
    if (!runtime) return;
    const S = runtime;
    const { state, tt, h, icon, ACTIONS, ACT_NAME } = S;
    const THRESHOLD = 110;
    const REFILL_AT = 6;
    const FLY = { right: [1, 0], left: [-1, 0], up: [0, -1] };
    const store = {
      get: (k) => {
        try {
          return localStorage.getItem(k);
        } catch (_) {
          return null;
        }
      },
      set: (k, v) => {
        try {
          localStorage.setItem(k, v);
        } catch (_) {
        }
      }
    };
    let ui = null;
    let observer;
    let removeKeys;
    let busy = false;
    function dispose() {
      S.activity?.dispose();
      observer?.disconnect();
      observer = void 0;
      removeKeys?.();
      removeKeys = void 0;
      S.reset();
      ui?.root.replaceChildren();
      ui = null;
      busy = false;
    }
    function viewLease() {
      const mounted = ui, route = window.location.hash, current = S.lease();
      return () => route === window.location.hash && !!mounted && ui === mounted && mounted.root.isConnected && current();
    }
    const cards = /* @__PURE__ */ new WeakMap();
    const liveCards = () => ui ? [...ui.stage.querySelectorAll(".je-catchup-card:not(.leaving)")].flatMap((el) => {
      const item = cards.get(el);
      return item ? [Object.assign(el, { item })] : [];
    }) : [];
    const topCard = () => {
      const c = liveCards();
      return c[c.length - 1];
    };
    const toast = (msg) => {
      try {
        JE.toast(msg);
      } catch (_) {
      }
    };
    function subline(item) {
      let length = "";
      if (state.mode === "Series") {
        if (item.ChildCount) length = tt("catchup_seasons", "{n} season(s)", { n: item.ChildCount });
      } else if (item.RunTimeTicks) {
        length = tt("catchup_minutes", "{n} min", { n: Math.round(item.RunTimeTicks / 6e8) });
      }
      return [item.ProductionYear, length, item.CommunityRating ? "★ " + item.CommunityRating.toFixed(1) : "", (item.Genres || []).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
    }
    function cardEl(item) {
      const el = Object.assign(h("div", "je-catchup-card"), { item });
      cards.set(el, item);
      const img = document.createElement("img");
      img.draggable = false;
      img.alt = "";
      img.src = S.imageUrl(S.imageOf(item), 700);
      const meta = h("div", "je-catchup-meta");
      meta.append(h("h2", "", item.Name), h("p", "", subline(item)), h("div", "ov", item.Overview || ""));
      el.append(
        img,
        meta,
        h("div", "je-catchup-stamp r", tt("catchup_stamp_watched", "WATCHED")),
        h("div", "je-catchup-stamp l", tt("catchup_stamp_dismiss", "DISMISS")),
        h("div", "je-catchup-stamp u", tt("catchup_stamp_watchlist", "WATCHLIST")),
        h("div", "je-catchup-stamp d", tt("catchup_stamp_open", "OPEN"))
      );
      attachDrag(el);
      return el;
    }
    function render() {
      if (!ui) return;
      liveCards().forEach((c) => {
        if (S.isHidden(c.item)) c.remove();
      });
      state.queue = state.queue.filter((i) => !S.isHidden(i));
      const have = liveCards();
      while (have.length < 2 && state.queue.length) {
        const c = cardEl(state.queue.shift());
        ui.stage.prepend(c);
        have.unshift(c);
      }
      liveCards().forEach((c, i, all) => c.classList.toggle("back", i < all.length - 1));
      ui.empty.style.display = liveCards().length ? "none" : "flex";
      if (state.queue.length < REFILL_AT) {
        const current = viewLease();
        S.refill().then((n) => {
          if (current() && ui) {
            ui.empty.textContent = tt("catchup_empty", "Nothing more to show here.");
            if (n && liveCards().length < 2) render();
          }
        }).catch((e) => {
          if (current() && ui) ui.empty.textContent = tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) });
        });
      }
    }
    const flash = (el, k) => {
      const s = el.querySelector(".je-catchup-stamp." + k);
      if (s) s.style.opacity = "1";
    };
    function resetCard(el) {
      el.style.transition = "transform .25s";
      el.style.transform = "";
      el.querySelectorAll(".je-catchup-stamp").forEach((x) => {
        x.style.opacity = "0";
      });
    }
    async function fire(dir, opts) {
      const el = topCard();
      const current = viewLease();
      const identity = currentLease(JE.session, getApi);
      if (!el || busy || !current() || state.pickerOpen && !opts) return;
      if (dir === "right" && state.mode === "Series" && !opts) return pickSeasons(el);
      if (dir === "down") {
        S.logSwipe(el.item, dir, null, true);
        S.navigateToItem(el.item.Id);
        resetCard(el);
        return;
      }
      busy = true;
      const item = el.item, act = ACTIONS[dir];
      try {
        const prior = await act.run(item, opts);
        if (!current()) {
          if (identity() && ui?.root.isConnected) await start();
          return;
        }
        S.logSwipe(item, dir, opts, true);
        state.undoStack.push({ item, dir, opts, prior });
        const [x, y] = FLY[dir];
        flash(el, dir.charAt(0));
        el.style.transition = "transform .3s ease-in, opacity .3s";
        el.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px) rotate(${x * 25}deg)`;
        el.style.opacity = "0";
        el.classList.add("leaving");
        el.classList.remove("back");
        setTimeout(() => el.remove(), 300);
        render();
      } catch (e) {
        if (!current()) {
          if (identity() && ui?.root.isConnected) await start();
          return;
        }
        S.logSwipe(item, dir, opts, false);
        toast(tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) }));
        await start();
      } finally {
        if (current()) busy = false;
      }
    }
    async function undo() {
      const current = viewLease();
      const identity = currentLease(JE.session, getApi);
      if (busy || !current()) return;
      const last = state.undoStack[state.undoStack.length - 1];
      if (!last) return;
      busy = true;
      try {
        await ACTIONS[last.dir].undo(last.item, last.opts, last.prior);
        if (!current()) {
          if (identity() && ui?.root.isConnected) await start();
          return;
        }
        state.undoStack.pop();
        S.logEvent({ type: "swipe", action: "undo", undoOf: ACT_NAME[last.dir], itemId: last.item.Id, ok: true });
        const live = liveCards();
        state.queue.unshift(last.item, ...live.slice().reverse().map((c) => c.item));
        live.forEach((c) => c.remove());
        render();
      } catch (e) {
        if (!current()) {
          if (identity() && ui?.root.isConnected) await start();
          return;
        }
        S.logEvent({ type: "swipe", action: "undo", undoOf: ACT_NAME[last.dir], itemId: last.item.Id, ok: false });
        toast(tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) }));
        await start();
      } finally {
        if (current()) busy = false;
      }
    }
    async function pickSeasons(el) {
      const item = el.item;
      const current = viewLease();
      state.pickerOpen = true;
      resetCard(el);
      let seasons = [];
      try {
        const r = await S.jf(`/Shows/${item.Id}/Seasons?userId=${S.userId()}&Fields=ChildCount`);
        if (!current()) return;
        seasons = readItems(r).flatMap((x) => x.IndexNumber !== void 0 && x.IndexNumber > 0 ? [{ ...x, IndexNumber: x.IndexNumber }] : []).sort((a, b) => a.IndexNumber - b.IndexNumber);
      } catch (e) {
        if (!current()) return;
        state.pickerOpen = false;
        return toast(tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) }));
      }
      if (seasons.length < 2) {
        state.pickerOpen = false;
        return fire("right", { seasons: null, numbers: ["all"] });
      }
      if (!current() || !ui) return;
      const p = ui.picker;
      p.title.textContent = item.Name;
      p.grid.replaceChildren();
      const sel = /* @__PURE__ */ new Set(), btns = [];
      const paint = () => {
        btns.forEach((b, k) => b.classList.toggle("on", sel.has(k)));
        const n = sel.size;
        p.ok.disabled = !n;
        p.ok.textContent = !n ? tt("catchup_picker_select", "Select seasons") : tt("catchup_picker_mark", "Mark {n} season(s) watched", { n });
      };
      seasons.forEach((s, k) => {
        const total = s.ChildCount || 0, left = s.UserData?.UnplayedItemCount ?? total, seen = Math.max(0, total - left);
        const b = h("button", seen && seen >= total ? "done" : "", String(s.IndexNumber));
        if (total) b.append(h("small", "", `${seen}/${total}`));
        b.onclick = () => {
          if (sel.has(k)) sel.delete(k);
          else for (let j = 0; j <= k; j++) sel.add(j);
          paint();
        };
        btns.push(b);
        p.grid.append(b);
      });
      const close = () => {
        p.root.style.display = "none";
        state.pickerOpen = false;
      };
      p.ok.onclick = () => {
        const picked = [...sel].sort((a, b) => a - b), all = picked.length === seasons.length;
        close();
        fire("right", { seasons: all ? null : picked.map((k) => seasons[k].Id), numbers: all ? ["all"] : picked.map((k) => String(seasons[k].IndexNumber)) });
      };
      p.cancel.onclick = close;
      paint();
      p.root.style.display = "flex";
    }
    function attachDrag(el) {
      let sx = 0, sy = 0, dragging = false;
      const stamp = (k) => el.querySelector(".je-catchup-stamp." + k);
      el.addEventListener("pointerdown", (e) => {
        if (el.classList.contains("back")) return;
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        el.setPointerCapture(e.pointerId);
        el.style.transition = "none";
      });
      el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy, horiz = Math.abs(dx) > Math.abs(dy);
        const o = (k) => Math.min(1, Math.max(0, k / THRESHOLD));
        el.style.transform = `translate(${dx}px,${dy}px) rotate(${dx / 20}deg)`;
        stamp("r").style.opacity = String(horiz && dx > 0 ? o(dx) : 0);
        stamp("l").style.opacity = String(horiz && dx < 0 ? o(-dx) : 0);
        stamp("u").style.opacity = String(!horiz && dy < 0 ? o(-dy) : 0);
        stamp("d").style.opacity = String(!horiz && dy > 0 ? o(dy) : 0);
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        const dx = e.clientX - sx, dy = e.clientY - sy, horiz = Math.abs(dx) > Math.abs(dy);
        const committed = Math.max(Math.abs(dx), Math.abs(dy)) > THRESHOLD;
        el.style.transition = "transform .25s";
        if (committed) fire(horiz ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up");
        if (!committed || !horiz && dy > 0 || horiz && dx > 0 && state.mode === "Series") resetCard(el);
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", () => {
        dragging = false;
        resetCard(el);
      });
    }
    function buildPicker() {
      const root = h("div", "je-catchup-modal"), box = h("div", "box");
      const title = h("h3"), grid = h("div", "je-catchup-grid");
      const ok = h("button", "primary"), cancel = h("button", "ghost", tt("catchup_picker_cancel", "Cancel"));
      box.append(title, h("p", "", tt("catchup_picker_help", "Select the seasons you have watched. Selecting a later season selects all the earlier ones too; select a selected season again to untick just that one.")), grid, ok, cancel);
      root.append(box);
      return { root, title, grid, ok, cancel };
    }
    function mount(root, main) {
      dispose();
      const head = h("div", "je-catchup-head");
      const headActions = h("div", "je-catchup-headbtns");
      head.append(h("div", "je-catchup-title", tt("catchup_title", "Catch Up")), headActions);
      const tabs = h("div", "je-catchup-tabs");
      [["Movie", tt("catchup_tab_movies", "Movies")], ["Series", tt("catchup_tab_shows", "Shows")]].forEach(([mode, label]) => {
        const b = h("button", "", label);
        b.dataset.mode = mode;
        b.onclick = () => {
          if (state.mode === mode) return;
          state.mode = mode;
          store.set("je-catchup-mode", mode);
          start();
        };
        tabs.append(b);
      });
      const stage = h("div", "je-catchup-stage"), empty = h("div", "je-catchup-empty", tt("catchup_empty", "Nothing more to show here."));
      stage.append(empty);
      const buttons = h("div", "je-catchup-buttons");
      const cap = (k, f) => {
        const w = tt(k, f);
        return w.charAt(0) + w.slice(1).toLowerCase();
      };
      const controls = [
        ["z", "undo", tt("catchup_btn_rewind", "Rewind (Backspace)"), undo],
        ["l", "x", `${cap("catchup_stamp_dismiss", "DISMISS")} (←)`, () => fire("left")],
        ["d", "info", `${cap("catchup_stamp_open", "OPEN")} (↓)`, () => fire("down")],
        ["u", "bookmark", `${cap("catchup_stamp_watchlist", "WATCHLIST")} (↑)`, () => fire("up")],
        ["r", "check", `${cap("catchup_stamp_watched", "WATCHED")} (→)`, () => fire("right")]
      ];
      controls.forEach(([cls, ic, title, fn]) => {
        const b = h("button", cls);
        b.title = title;
        b.setAttribute("aria-label", title);
        b.append(icon(ic));
        b.onclick = fn;
        buttons.append(b);
      });
      const hint = h("div", "je-catchup-hint", tt("catchup_hint", "→ watched · ← dismiss · ↑ watchlist · ↓ open · Backspace = rewind"));
      const picker = buildPicker();
      main.append(head, tabs, stage, buttons, hint);
      root.append(picker.root);
      ui = { root, stage, empty, picker, tabs };
      const onKey = (e) => {
        if (!document.contains(root)) {
          document.removeEventListener("keydown", onKey);
          if (ui && ui.root === root) ui = null;
          return;
        }
        const activityModal = root.querySelector(".je-catchup-activity.open") && !root.classList.contains("docked");
        if (e.target instanceof Element && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || state.pickerOpen || activityModal) return;
        const directions = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down" };
        const dir = directions[e.key];
        if (dir) {
          e.preventDefault();
          fire(dir);
        } else if (e.key === "Backspace" || e.key === "z") undo();
      };
      document.addEventListener("keydown", onKey);
      observer = new MutationObserver(() => {
        if (ui?.root === root && !root.isConnected) dispose();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const route = window.location.hash;
      const onRoute = () => {
        if (window.location.hash !== route && ui?.root === root) dispose();
      };
      window.addEventListener("hashchange", onRoute);
      removeKeys = () => {
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("hashchange", onRoute);
      };
      const saved = store.get("je-catchup-mode");
      state.mode = saved === "Series" ? "Series" : "Movie";
      return { start, headActions };
    }
    async function start() {
      if (!ui) return;
      ui.tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
      S.reset();
      busy = false;
      ui.picker.root.style.display = "none";
      const current = viewLease();
      S.loadDismissed();
      state.queue = [];
      state.seen = /* @__PURE__ */ new Set();
      state.undoStack = [];
      ui.stage.querySelectorAll(".je-catchup-card").forEach((c) => c.remove());
      try {
        await S.refill();
      } catch (e) {
        if (current() && ui) {
          ui.empty.textContent = tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) });
          ui.empty.style.display = "flex";
        }
        return;
      }
      if (current() && ui) {
        ui.empty.textContent = tt("catchup_empty", "Nothing more to show here.");
        render();
      }
    }
    S.deck = { mount, start, dispose };
  })();
})();
})();
//# sourceMappingURL=catchup-deck.js.map
