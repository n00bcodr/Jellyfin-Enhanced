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
  function optionalBoolean(value) {
    if (value == null) return void 0;
    if (typeof value !== "boolean") throw Error("Invalid response boolean");
    return value;
  }
  function array(value, decode) {
    if (!Array.isArray(value)) throw Error("Invalid response array");
    return value.map(decode);
  }

  // client/src/features/catchup/model.ts
  function readAdmin(value) {
    return optionalBoolean(object(object(value).Policy).IsAdministrator) === true;
  }
  function readEvents(value) {
    const v = object(value);
    return { users: array(v.users, string), events: array(v.events, (value2) => {
      const e = object(value2);
      const ts = string(e.ts);
      if (!Number.isFinite(Date.parse(ts))) throw Error("Invalid event timestamp");
      return { ts, user: string(e.user), action: optionalString(e.action), type: string(e.type), undoOf: optionalString(e.undoOf), ok: optionalBoolean(e.ok), itemId: optionalString(e.itemId), itemName: optionalString(e.itemName), kind: optionalString(e.kind), seasons: e.seasons == null ? void 0 : array(e.seasons, string) };
    }) };
  }
  function readSummary(value) {
    const v = object(value);
    const top = (value2) => array(value2, (value3) => {
      const t = object(value3);
      return { itemId: string(t.itemId), name: optionalString(t.name), count: number(t.count), users: array(t.users, string) };
    });
    return { users: array(v.users, (value2) => {
      const u = object(value2);
      return { user: string(u.user), watched: number(u.watched), dismiss: number(u.dismiss), watchlist: number(u.watchlist), lastSeen: optionalString(u.lastSeen) };
    }), topWatched: top(v.topWatched), topDismissed: top(v.topDismissed), topWatchlisted: top(v.topWatchlisted) };
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

  // client/src/features/catchup/catchup-activity.ts
  (function() {
    "use strict";
    const { ctx: context, getApi } = catchupHost();
    if (!context) return;
    const ctx = context, JE = ctx.core;
    if (!JE?.pluginConfig?.CatchUpEnabled) return;
    const runtime = ctx.own.catchUp;
    if (!runtime) return;
    const S = runtime;
    const { tt, h, icon } = S;
    const WIDE = () => window.innerWidth >= 1100;
    const REFRESH_MS = 1e4;
    const ACTIONS = ["watched", "dismiss", "watchlist", "open", "undo"];
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
    const rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(void 0, { numeric: "auto" }) : null;
    function ago(iso) {
      const mins = (new Date(iso).getTime() - Date.now()) / 6e4;
      if (!rtf) return new Date(iso).toLocaleString();
      if (Math.abs(mins) < 1) return rtf.format(0, "second");
      if (Math.abs(mins) < 60) return rtf.format(Math.round(mins), "minute");
      if (Math.abs(mins) < 1440) return rtf.format(Math.round(mins / 60), "hour");
      return rtf.format(Math.round(mins / 1440), "day");
    }
    const itemLink = (id, name) => {
      const a = h("a", "", name || id);
      a.onclick = () => S.navigateToItem(id);
      return a;
    };
    const fetchJson = (path) => JE.core.api.plugin(path, { skipCache: true, skipRetry: true });
    let disposePanel;
    function dispose() {
      disposePanel?.();
    }
    async function mount(root, headActions) {
      disposePanel?.();
      const identity = currentLease(JE.session, getApi);
      let disposed = false, request = 0;
      let cleanup;
      const disposeThis = () => {
        if (disposed) return;
        disposed = true;
        request++;
        cleanup?.();
        if (disposePanel === disposeThis) disposePanel = void 0;
      };
      disposePanel = disposeThis;
      const current = () => !disposed && root.isConnected && identity();
      try {
        const me = await S.jf("/Users/Me");
        if (!current() || !readAdmin(me)) {
          disposeThis();
          return;
        }
      } catch (_) {
        disposeThis();
        return;
      }
      let view = "feed";
      let timer;
      const aside = h("div", "je-catchup-activity"), panel = h("div", "panel");
      const title = h("h3", "", tt("catchup_activity", "Activity"));
      const refreshBtn = h("button", "je-catchup-btn", tt("catchup_refresh", "Refresh")), closeBtn = h("button", "je-catchup-btn", tt("catchup_hide", "Hide"));
      const head = h("div", "ahead");
      head.append(title, refreshBtn, closeBtn);
      const tabs = h("div", "atabs");
      [["feed", tt("catchup_activity_feed", "Feed")], ["summary", tt("catchup_activity_summary", "Summary")]].forEach(([v, label]) => {
        const b = h("button", v === view ? "on" : "", label);
        b.dataset.v = v;
        b.onclick = () => {
          view = v;
          tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
          load();
        };
        tabs.append(b);
      });
      const filters = h("div", "afilters");
      const userSel = h("select");
      userSel.append(new Option(tt("catchup_all_users", "All users"), ""));
      const search = h("input");
      search.placeholder = tt("catchup_search_titles", "Search titles");
      const chips = h("div", "fchips");
      chips.title = tt("catchup_filter_hint", "Pick one or more; none = all");
      ACTIONS.forEach((a) => {
        const c = h("button", "chip", a);
        c.dataset.a = a;
        c.onclick = () => {
          c.classList.toggle("on");
          load();
        };
        chips.append(c);
      });
      filters.append(userSel, search, chips);
      const body = h("div", "abody");
      panel.append(head, tabs, filters, body);
      aside.append(panel);
      root.append(aside);
      function renderFeed(d) {
        const cur = userSel.value;
        userSel.length = 1;
        d.users.forEach((u) => userSel.append(new Option(u, u)));
        userSel.value = cur;
        body.replaceChildren();
        if (!d.events.length) body.append(h("div", "aempty", tt("catchup_activity_empty", "No activity yet.")));
        for (const e of d.events) {
          const act = e.action || e.type, row = h("div", "arow"), t = h("div", "t", ago(e.ts));
          t.title = e.ts;
          const tag = h("span", "tag " + act, act === "undo" ? `undo ${e.undoOf || ""}`.trim() : act);
          if (e.ok === false) tag.classList.add("fail");
          const a = h("div", "a");
          a.append(tag);
          const i = h("div", "i");
          if (e.itemId) i.append(itemLink(e.itemId, e.itemName));
          const bits = [e.kind, e.seasons?.length ? `${tt("catchup_activity_seasons", "seasons")}: ${e.seasons.join(", ")}` : ""].filter(Boolean).join(" · ");
          i.append(h("small", "", bits));
          row.append(t, h("div", "u", e.user), a, i);
          body.append(row);
        }
      }
      function renderSummary(d) {
        body.replaceChildren();
        const cards = h("div", "ucards");
        d.users.forEach((u) => {
          const c = h("div", "ucard");
          c.append(h("b", "", u.user));
          const st = h("div", "stats");
          [["watched", tt("catchup_stamp_watched", "WATCHED")], ["dismiss", tt("catchup_stamp_dismiss", "DISMISS")], ["watchlist", tt("catchup_stamp_watchlist", "WATCHLIST")]].forEach(([k, label]) => {
            const x = h("div");
            x.append(h("span", "", String(u[k])), h("small", "", label));
            st.append(x);
          });
          c.append(st, h("div", "ls", tt("catchup_activity_last_seen", "last seen {when}", { when: u.lastSeen ? ago(u.lastSeen) : "—" })));
          cards.append(c);
        });
        body.append(cards);
        const tops = h("div", "tops");
        [[d.topWatched, tt("catchup_top_watched", "Most watched")], [d.topDismissed, tt("catchup_top_dismissed", "Most dismissed")], [d.topWatchlisted, tt("catchup_top_watchlisted", "Most watchlisted")]].forEach(([list, label]) => {
          const col = h("div");
          col.append(h("h4", "", label));
          if (!list.length) col.append(h("div", "aempty", tt("catchup_activity_empty", "No activity yet.")));
          list.forEach((t) => {
            const r = h("div", "toprow");
            r.append(itemLink(t.itemId, t.name), h("span", "", `${t.count} · ${t.users.join(", ")}`));
            col.append(r);
          });
          tops.append(col);
        });
        body.append(tops);
      }
      async function load() {
        if (!current()) return;
        const serial = ++request;
        filters.style.display = view === "feed" ? "" : "none";
        try {
          if (view === "feed") {
            const q = new URLSearchParams({ limit: "300" });
            if (userSel.value) q.set("user", userSel.value);
            const acts = [...chips.querySelectorAll(".chip.on")].map((b) => b.dataset.a);
            if (acts.length) q.set("action", acts.join(","));
            if (search.value.trim()) q.set("q", search.value.trim());
            const data = readEvents(await fetchJson(`/catchup/events?${q}`));
            if (current() && serial === request) renderFeed(data);
          } else {
            const data = readSummary(await fetchJson("/catchup/summary"));
            if (current() && serial === request) renderSummary(data);
          }
        } catch (e) {
          if (!current() || serial !== request) return;
          body.replaceChildren(h("div", "aempty", tt("catchup_failed", "Failed: {error}", { error: errorMessage(e) })));
        }
      }
      const toggle = h("button", "je-catchup-btn");
      toggle.append(icon("activity"), h("span", "", tt("catchup_activity", "Activity")));
      const isOpen = () => aside.classList.contains("open");
      function open() {
        aside.classList.add("open");
        toggle.classList.add("on");
        root.classList.toggle("docked", WIDE());
        load();
        clearInterval(timer);
        timer = setInterval(() => {
          if (!document.contains(root)) {
            clearInterval(timer);
            return;
          }
          load();
        }, REFRESH_MS);
      }
      function close() {
        request++;
        aside.classList.remove("open");
        toggle.classList.remove("on");
        root.classList.remove("docked");
        clearInterval(timer);
      }
      function layout() {
        if (!document.contains(root)) {
          window.removeEventListener("resize", layout);
          clearInterval(timer);
          return;
        }
        const want = WIDE() && store.get("je-catchup-dock") !== "0";
        if (want && !isOpen()) open();
        else if (!want && isOpen() && root.classList.contains("docked")) close();
        else if (isOpen()) root.classList.toggle("docked", WIDE());
      }
      window.addEventListener("resize", layout);
      headActions.prepend(toggle);
      toggle.onclick = () => {
        if (isOpen()) {
          if (root.classList.contains("docked")) store.set("je-catchup-dock", "0");
          close();
        } else {
          if (WIDE()) store.set("je-catchup-dock", "1");
          open();
        }
      };
      closeBtn.onclick = () => {
        if (root.classList.contains("docked")) store.set("je-catchup-dock", "0");
        close();
      };
      refreshBtn.onclick = load;
      aside.addEventListener("click", (e) => {
        if (e.target === aside && !root.classList.contains("docked")) close();
      });
      userSel.onchange = load;
      let debounce;
      search.oninput = () => {
        clearTimeout(debounce);
        debounce = setTimeout(load, 300);
      };
      const onKey = (e) => {
        if (e.key === "Escape" && isOpen() && !root.classList.contains("docked")) close();
      };
      document.addEventListener("keydown", onKey);
      const observer = new MutationObserver(() => {
        if (!current()) disposeThis();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      cleanup = () => {
        clearTimeout(debounce);
        clearInterval(timer);
        window.removeEventListener("resize", layout);
        document.removeEventListener("keydown", onKey);
        observer.disconnect();
        aside.remove();
        toggle.remove();
        root.classList.remove("docked");
      };
      layout();
    }
    S.activity?.dispose();
    S.activity = { mount, dispose };
  })();
})();
})();
//# sourceMappingURL=catchup-activity.js.map
