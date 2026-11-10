(() => {
"use strict";
(() => {
  // client/src/features/media-tags/host.ts
  function settingsUi(JE2) {
    return JE2.internals?.enhancedUi;
  }

  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE2 = host().JellyfinEnhanced;
    if (!JE2) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE2;
  }
  function apiClient() {
    const client = host().ApiClient;
    if (!client) throw new ReferenceError("ApiClient is not defined");
    return client;
  }
  function optionalApiClient() {
    return host().ApiClient;
  }
  function dashboard() {
    return host().Dashboard;
  }
  function cdnUrl(path) {
    const route = host().jeCdnUrl;
    if (typeof route !== "function") throw new ReferenceError("jeCdnUrl is not defined");
    return route(path);
  }

  // client/src/features/media-tags/admin/dom.ts
  function isDisabled(el) {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.disabled : false;
  }
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function must(scope, selector) {
    const el = find(scope, selector);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
  }
  function all(scope, selector) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el) => el instanceof HTMLElement) : [];
  }
  function allAs(scope, selector, type) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el) => el instanceof type) : [];
  }
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
  }
  function targetOf(event) {
    return event.target instanceof HTMLElement ? event.target : null;
  }
  function activeElement() {
    const el = document.activeElement;
    return el instanceof HTMLElement ? el : null;
  }
  function focus(el, options) {
    if (el instanceof HTMLElement) el.focus(options);
  }

  // client/src/features/media-tags/admin/values.ts
  function isJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJson);
    if (typeof value === "object") return Object.values(value).every(isJson);
    return false;
  }
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function configOf(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const out = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === void 0) continue;
      if (!isJson(member)) return null;
      out[key] = member;
    }
    return out;
  }
  function copy(value) {
    if (value === void 0) return null;
    const out = JSON.parse(JSON.stringify(value));
    return isJson(out) ? out : null;
  }
  var sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }
  var list = (value) => Array.isArray(value) ? value : [];
  var objects = (value) => list(value).filter(isObject);

  // client/src/features/media-tags/admin/mount.ts
  var toolbarRoot = null;
  function followToolbar(root) {
    const measure = () => {
      const tracked = toolbarRoot;
      if (!tracked?.isConnected) return;
      let bottom = 0;
      for (const bar of Array.from(document.querySelectorAll(".skinHeader, .MuiAppBar-root"))) {
        const style = getComputedStyle(bar);
        if (style.position !== "fixed" && style.position !== "sticky") continue;
        const box = bar.getBoundingClientRect();
        if (box.height > 0 && box.top <= 0) bottom = Math.max(bottom, Math.round(box.bottom));
      }
      const page = tracked.closest('[data-role="page"]');
      const header = find(page, ".je-sticky-header");
      if (header) {
        const style = getComputedStyle(header);
        if (style.position === "sticky") bottom = Math.max(bottom, Math.round((parseFloat(style.top) || 0) + header.getBoundingClientRect().height));
      }
      const nav = find(page, ".jea-nav");
      const navToggle = nav?.querySelector(".jea-nav-toggle");
      if (nav && navToggle && getComputedStyle(navToggle).display !== "none" && getComputedStyle(nav).position === "sticky") {
        bottom = Math.max(bottom, Math.round((parseFloat(getComputedStyle(nav).top) || 0) + navToggle.getBoundingClientRect().height));
      }
      tracked.style.setProperty("--je-ta-toolbar", `${bottom}px`);
      const main = tracked.closest(".jea-main");
      if (main) {
        const box = main.getBoundingClientRect();
        tracked.style.setProperty("--je-ta-main-x", `${Math.round(box.left + box.width / 2)}px`);
        tracked.style.setProperty("--je-ta-main-w", `${Math.round(box.width)}px`);
      }
    };
    if (!toolbarRoot) window.addEventListener("resize", () => measure(), { passive: true });
    toolbarRoot = root;
    measure();
    setTimeout(measure, 300);
  }
  function detectTheme(root) {
    try {
      const m = getComputedStyle(document.documentElement).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      root.classList.toggle("je-ta-light", !!m && Number(m[1]) + Number(m[2]) + Number(m[3]) > 450);
    } catch {
    }
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(el);
    });
  }
  function createLifecycle(deps) {
    const { mount: mount2, saves: saves2 } = deps;
    let modulesLoaded = null;
    const hiddenPages = /* @__PURE__ */ new WeakSet();
    let queue = Promise.resolve(null);
    let unloadWired = false;
    function activate(page) {
      queue = queue.then(() => show(page)).catch((err) => {
        console.error("🪼 Jellyfin Enhanced: the Media Tags tab failed to load", err);
        const root = find(page, ".je-tag-admin");
        if (root) showLoadError(page, root);
        return null;
      });
      return queue;
    }
    async function show(page) {
      const root = find(page, ".je-tag-admin");
      if (!root) throw new Error("The Media Tags tab has no .je-tag-admin element");
      detectTheme(root);
      followToolbar(root);
      const mark = saves2.sessionMark();
      const again = () => deps.signedIn() ? show(page) : null;
      const live = mount2.active;
      if (live && live.page === page && root.contains(live.ctx.root.firstElementChild)) {
        let fresh = null;
        try {
          const answer = await deps.getConfiguration(deps.pluginId);
          fresh = configOf(answer);
          if (!fresh && saves2.sameSession(mark)) console.warn("🪼 Jellyfin Enhanced: the configuration the server returned is not a settings document");
        } catch (err) {
          if (saves2.sameSession(mark)) console.warn("🪼 Jellyfin Enhanced: could not reload the configuration", err);
        }
        if (!saves2.sameSession(mark)) return again();
        const active = mount2.active;
        if (!active) return null;
        if (fresh) active.ctx.reload(fresh);
        if (!hiddenPages.has(page)) active.ctx.preview?.resume();
        const target = deps.freshTarget();
        if (target.tab) active.ctx.openTab(target.tab, { group: target.group });
        return active.ctx;
      }
      if (live) {
        mount2.active = null;
        await live.ctx.flush();
        live.ctx.dispose();
        live.root.replaceChildren();
        delete live.root.dataset.tab;
        if (!saves2.sameSession(mark)) return again();
      }
      dashboard()?.showLoadingMsg?.();
      let config = null;
      let failure = null;
      try {
        const answer = await deps.getConfiguration(deps.pluginId);
        config = configOf(answer);
        if (!config) failure = new TypeError("The configuration the server returned is not a settings document");
      } catch (err) {
        failure = err ?? new Error("The configuration could not be read");
      } finally {
        dashboard()?.hideLoadingMsg?.();
      }
      if (!saves2.sameSession(mark)) return again();
      if (failure || !config) {
        console.error("🪼 Jellyfin Enhanced: could not load the Media Tags settings", failure);
        showLoadError(page, root);
        return null;
      }
      const ctx = deps.createPage(root, config);
      mount2.active = { page, root, ctx };
      if (hiddenPages.has(page)) ctx.preview?.suspend();
      return ctx;
    }
    function showLoadError(page, root) {
      root.innerHTML = `<div class="je-ta-wait je-ta-load-error" role="alert"><p>${deps.tx("The Media Tags settings could not be loaded from the server.")}</p><button type="button" class="je-ta-button" data-je-reload><span class="material-icons" aria-hidden="true">refresh</span>${deps.tx("Retry")}</button></div>`;
      const retry = root.querySelector("[data-je-reload]");
      if (!(retry instanceof HTMLButtonElement)) return;
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void activate(page);
      }, { once: true });
    }
    async function mountTab(tab, version) {
      if (!modulesLoaded) {
        const query = version ? `?v=${encodeURIComponent(version)}` : "";
        const loading = deps.sectionFiles.reduce((chain, file) => chain.then(() => loadScript(deps.scriptUrl(file, query))), Promise.resolve());
        modulesLoaded = loading;
        loading.catch(() => {
          if (modulesLoaded === loading) modulesLoaded = null;
        });
      }
      await modulesLoaded;
      const closestPage = tab.closest('[data-role="page"]');
      const page = closestPage instanceof HTMLElement ? closestPage : tab;
      if (!page.dataset.jeTaWired) {
        page.dataset.jeTaWired = "1";
        page.addEventListener("viewshow", () => {
          hiddenPages.delete(page);
        });
        page.addEventListener("viewbeforehide", () => {
          hiddenPages.add(page);
          const active = mount2.active;
          if (active?.page !== page) return;
          active.ctx.preview?.suspend();
          void deps.leaveWithPending();
        });
      }
      if (!unloadWired) {
        unloadWired = true;
        window.addEventListener("beforeunload", (e) => {
          if (!saves2.hasPending()) return;
          void saves2.flush();
          e.preventDefault();
          e.returnValue = "";
        });
      }
      return activate(page);
    }
    return { activate, mountTab };
  }

  // client/src/features/media-tags/admin/format.ts
  var fmt = (text, params) => {
    let out = String(text);
    if (params) {
      out = out.replace(/\{(\w+)\|([^|{}]*)\|([^|{}]*)\}/g, (_m, name, one, many) => Number(params[name]) === 1 ? one : many);
      for (const [name, value] of Object.entries(params)) out = out.split("{" + name + "}").join(String(value));
    }
    return out;
  };
  var WORDS = {
    // Why a group has no control, by the key the shared settings matrix (core/tag-renderer-base.js) names it with.
    reason: {
      tag_scope_people_na: "People Tags appear on cast cards on detail pages, not on media cards, so they have no position, limit or Where to show.",
      tag_limit_single: "Always one tag: this group shows a single badge.",
      tag_item_editor_scope_note: "Where each group shows (movies, series, seasons, episodes and the home rows) is chosen for all titles in Media Tags settings."
    },
    type: { movie: "Movie", series: "Series", season: "Season", episode: "Episode", boxset: "Collection", video: "Video" },
    layout: { corners: "Corners", bands: "Bands", caption: "Caption", summary: "Summary", minimal: "Minimal" },
    preset: { default: "Default", glass: "Glass", outline: "Outline", dark: "Dark", light: "Light", mono: "Mono", poster: "Poster" },
    group: {
      status: "Status",
      quality: "Quality",
      rating: "Rating",
      age_rating: "Age Rating",
      logos: "Logos",
      language: "Language",
      genre: "Genre",
      custom: "Custom",
      awards: "Awards"
    },
    slot: {
      off: "Hidden",
      corners_tl: "Top left",
      corners_tc: "Top centre",
      corners_bc: "Bottom centre",
      corners_ml: "Left centre",
      corners_mr: "Right centre",
      corners_c: "Centre",
      corners_tr: "Top right",
      corners_bl: "Bottom left",
      corners_br: "Bottom right",
      bands_top: "Top band",
      bands_bottom: "Bottom row",
      caption_poster: "On poster",
      caption_caption: "Caption",
      summary_pill: "In pill",
      summary_hover: "On hover",
      minimal_top: "Top",
      minimal_dots: "Dots",
      minimal_corner: "Corner",
      minimal_hover: "On hover"
    },
    field: { library: "Library", type: "Type", genre: "Genre", agerating: "Age rating" },
    density: { full: "Full", compact: "Compact" },
    layoutName: {
      corners: "Corners: place each group anywhere on the poster",
      bands: "Bands: a strip along the top and bottom, the middle stays clear",
      caption: "Caption: tags in a line below the poster",
      summary: "Summary: one short fact pill, every tag on hover",
      minimal: "Minimal: status, quality dots and score, the rest on hover"
    },
    shape: { landscape: "Episode thumbnails", list: "List rows" },
    shapeRecommended: {
      landscape: "Recommended: bands, compact (status and age on top, quality and rating below)",
      list: "Recommended: corners, compact (quality, status and rating, up to 2 each)"
    },
    styleTarget: { web: "Web", native: "Native posters", both: "Both" },
    colourTarget: { web: "Web only", native: "Native posters only", both: "Web + native posters" }
  };
  function word(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }

  // client/src/features/media-tags/admin/fields.ts
  var checkbox = (f) => f.type === "switch" || f.type === "enable" || f.type === "ordered";
  function fieldValue(f, config) {
    if (f.secret) return "";
    const raw = config[f.key];
    if (f.read) return f.read(raw, config);
    if (checkbox(f)) return raw === true;
    if (f.type === "number") {
      const n = Number(raw);
      return Number.isFinite(n) && raw !== null && raw !== "" ? n : f.fallback;
    }
    if (raw === null || raw === void 0) return f.fallback ?? "";
    return f.type === "pills" || f.type === "select" ? String(raw) : raw;
  }
  function controlValue(f, el, config) {
    let value;
    const input = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el : null;
    if (checkbox(f)) value = el instanceof HTMLInputElement ? el.checked : false;
    else if (f.type === "pills") {
      const chosen = el.querySelector("input:checked");
      value = chosen instanceof HTMLInputElement ? chosen.value : f.fallback ?? null;
    } else if (f.type === "number") {
      const n = Math.round(Number(input?.value));
      let out = Number.isFinite(n) ? n : f.fallback;
      if (f.min !== void 0 && Number.isFinite(f.min)) out = Math.max(f.min, Number(out));
      if (f.max !== void 0 && Number.isFinite(f.max)) out = Math.min(f.max, Number(out));
      value = typeof out === "number" && !Number.isFinite(out) ? null : out ?? null;
    } else value = input ? input.value : "";
    if (f.type === "text" || f.type === "textarea") value = String(value).trim();
    return f.write ? f.write(value, config) : value;
  }
  var optionLabel = (kit2, label) => label.startsWith("=") ? kit2.esc(label.slice(1)) : kit2.tx(label);
  function fieldHtml(kit2, f, config) {
    const { esc: esc2, tx: tx2 } = kit2;
    const value = fieldValue(f, config);
    const descId = f.desc ? `${f.id}Desc` : "";
    const described = descId ? ` aria-describedby="${descId}"` : "";
    const data = `data-je-field="${esc2(f.key)}" data-je-setting-id="${esc2(f.id)}"`;
    const label = tx2(f.label) + (f.scope === "new" ? ` ${kit2.perUserMark()}` : "");
    const desc = f.desc ? `<span class="je-ta-switch-desc" id="${descId}">${tx2(f.desc, f.descParams)}</span>` : "";
    const text = `<span class="je-ta-switch-text"><span class="je-ta-switch-name" data-je-label>${label}</span>${desc}</span>`;
    const labelled = `<span class="je-ta-switch-text"><label class="je-ta-switch-name" for="${esc2(f.id)}" data-je-label>${label}</label>${desc}</span>`;
    switch (f.type) {
      case "switch":
        return `<label class="je-ta-switch${f.master ? " je-ta-switch--master" : ""}" data-field-row="${esc2(f.id)}"><input type="checkbox" id="${esc2(f.id)}" ${data} ${value ? "checked" : ""}${described}>${text}</label>`;
      case "select":
        return `<div class="je-ta-field" data-field-row="${esc2(f.id)}">${labelled}<span class="je-ta-field-control"><select id="${esc2(f.id)}" ${data}${described}>${(f.options || []).map(([v, k]) => `<option value="${esc2(v)}" ${String(v) === String(value) ? "selected" : ""}>${optionLabel(kit2, k)}</option>`).join("")}</select></span></div>`;
      case "number":
      case "text":
        return `<div class="je-ta-field" data-field-row="${esc2(f.id)}">${labelled}<span class="je-ta-field-control${f.wide ? " je-ta-field-control--wide" : ""}"><input type="${f.secret ? "password" : f.type}" id="${esc2(f.id)}" ${data} value="${esc2(value)}"${f.secret ? ' autocomplete="new-password" spellcheck="false"' : ""}${f.mask ? ' class="je-ta-masked" autocomplete="off" spellcheck="false"' : ""}${f.type === "number" ? ` min="${f.min}" max="${f.max}" inputmode="numeric"` : ""}${f.pattern ? ` pattern="${esc2(f.pattern)}"` : ""}${f.placeholder ? ` placeholder="${tx2(f.placeholder)}"` : ""}${described}>${f.unit ? `<span class="je-ta-unit">${tx2(f.unit)}</span>` : ""}</span></div>`;
      case "textarea":
        return `<div class="je-ta-field je-ta-field--block" data-field-row="${esc2(f.id)}">${labelled}<span class="je-ta-field-control"><textarea id="${esc2(f.id)}" ${data} rows="${f.rows || 4}" spellcheck="false"${f.pattern ? ` pattern="${esc2(f.pattern)}"` : ""}${f.placeholder ? ` placeholder="${tx2(f.placeholder)}"` : ""}${described}>${esc2(value)}</textarea></span></div>`;
      case "pills":
        return `<div class="je-ta-field" data-field-row="${esc2(f.id)}"><span class="je-ta-switch-text"><span class="je-ta-switch-name" id="${esc2(f.id)}Label" data-je-label>${label}</span>${desc}</span><span class="je-ta-field-control"><span class="je-ta-pills" role="radiogroup" id="${esc2(f.id)}" ${data} aria-labelledby="${esc2(f.id)}Label"${described}>${(f.options || []).map(([v, k]) => `<label class="je-ta-pill"><input type="radio" name="${esc2(f.id)}" value="${esc2(v)}" ${String(v) === String(value) ? "checked" : ""}><span>${optionLabel(kit2, k)}</span></label>`).join("")}</span></span></div>`;
      default:
        return "";
    }
  }
  function orderedHtml(kit2, fields, config) {
    const { esc: esc2, tx: tx2 } = kit2;
    const ranked = fields.map((f, i) => {
      const stored = f.orderKey === void 0 ? void 0 : config[f.orderKey];
      return { f, i, n: Number.isFinite(Number(stored)) ? Number(stored) : Number(f.defaultOrder) };
    }).sort((a, b) => a.n - b.n || Number(a.f.defaultOrder) - Number(b.f.defaultOrder) || a.i - b.i);
    return `<button type="button" class="je-ta-button je-ta-reorder" data-order-reorder aria-pressed="false"><span class="material-icons" aria-hidden="true">swap_vert</span><span>${tx2("Reorder categories")}</span></button><ol class="je-ta-order" data-ordered-list>${ranked.map(({ f }, i) => {
      const name = fmt(f.label);
      return `<li data-ordered="${esc2(f.id)}"><span class="je-ta-rank" aria-hidden="true">${i + 1}</span><label><input type="checkbox" id="${esc2(f.id)}" data-je-field="${esc2(f.key)}" data-je-setting-id="${esc2(f.id)}" ${config[f.key] === true ? "checked" : ""}><span class="je-ta-order-name" data-je-label>${esc2(name)}</span></label><button type="button" class="je-ta-icon-btn" data-move="-1" aria-label="${tx2("Move {name} up", { name })}" ${i === 0 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_upward</span></button><button type="button" class="je-ta-icon-btn" data-move="1" aria-label="${tx2("Move {name} down", { name })}" ${i === ranked.length - 1 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_downward</span></button></li>`;
    }).join("")}</ol>`;
  }
  function fieldsHtml(kit2, fields, config) {
    const out = [];
    let run = [];
    let kind = "";
    const flush = () => {
      if (!run.length) return;
      if (kind === "ordered") out.push(orderedHtml(kit2, run, config));
      else out.push(`<div class="${kind === "switch" ? "je-ta-switches" : "je-ta-fields"}">${run.map((f) => fieldHtml(kit2, f, config)).join("")}</div>`);
      run = [];
    };
    let more = "";
    const close = () => {
      if (more) out.push("</div></details>");
      more = "";
    };
    for (const f of fields || []) {
      if (f.type === "enable" || f.type === "custom" || f.place === "section") continue;
      const k = f.type === "switch" ? "switch" : f.type === "ordered" ? "ordered" : "field";
      if ((f.more || "") !== more) {
        flush();
        close();
        kind = "";
        if (f.more) {
          more = f.more;
          out.push(`<details class="je-ta-more" data-more="${kit2.esc(more)}"><summary class="je-ta-more-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${kit2.tx(more)}</summary><div class="je-ta-more-body">`);
        }
      }
      if (k !== kind || f.break) flush();
      kind = k;
      run.push(f);
    }
    flush();
    close();
    return out.join("");
  }
  function redrawList(list2, html, selectorOf) {
    const active = document.activeElement;
    const selector = active instanceof HTMLElement && active !== list2 && list2.contains(active) ? selectorOf(active) : null;
    list2.innerHTML = html;
    const again = selector ? list2.querySelector(selector) : null;
    if (again instanceof HTMLElement && !isDisabled(again)) again.focus({ preventScroll: true });
  }

  // client/src/features/media-tags/admin/page.ts
  function fieldName(sections2, key) {
    for (const s of sections2) {
      for (const f of s.fields || []) {
        if (f.key === key || f.orderKey === key) return fmt(f.label);
      }
    }
    return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }
  function valueLabel(key, value) {
    const control = all(document, ".je-tag-admin [data-je-field]").find((el) => el.getAttribute("data-je-field") === key) || null;
    if (typeof value === "boolean" || control instanceof HTMLInputElement && control.type === "checkbox") return fmt(value ? "On" : "Off");
    if (control instanceof HTMLSelectElement) {
      const option = Array.from(control.options).find((o) => o.value === String(value ?? ""));
      if (option) return option.textContent || String(value);
    }
    const radio = control ? allAs(control, 'input[type="radio"]', HTMLInputElement).find((r) => r.value === String(value ?? "")) : null;
    if (radio) return radio.closest("label")?.textContent?.trim() || String(value);
    return value === null || value === void 0 || value === "" ? fmt("Server default") : String(typeof value === "object" ? JSON.stringify(value) : value);
  }
  var SCOPE_LABELS = {
    movies: "Movies",
    series: "Series",
    seasons: "Seasons",
    episodes: "Episodes",
    continueWatching: "Continue Watching row",
    nextUp: "Next Up row"
  };
  var pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function createPage(deps, root, initial, options = {}) {
    const { kit: kit2, saves: saves2, sections: sections2, tabs: TABS2 } = deps;
    const { esc: esc2, tx: tx2, perUserMark: perUserMark2 } = kit2;
    const store = saves2.store;
    const JE2 = deps.JE;
    const host2 = options.api || {
      get: () => apiClient().getPluginConfiguration(deps.pluginId),
      patch: (changes, expected) => apiClient().ajax({
        type: "POST",
        url: apiClient().getUrl("/JellyfinEnhanced/admin/configuration"),
        data: JSON.stringify({ Changes: changes, Expected: expected }),
        contentType: "application/json",
        dataType: "json"
      })
    };
    const config = { ...initial };
    for (const section of sections2) for (const field of section.fields || []) if (field.secret) delete config[field.key];
    saves2.checkSession();
    store.host = host2;
    const contextMark = saves2.sessionMark();
    for (const [key, value] of store.values) config[key] = value;
    let disposed = false;
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let preview = null;
    let snackTimer = null;
    const openGroups = /* @__PURE__ */ new Map();
    root.classList.add("je-tag-admin");
    const groupSections = sections2.filter((s) => s.tab === "groups" && s.group);
    const docsLink = (tab) => `<a class="je-ta-docs" href="${deps.docsUrl}#${own(deps.docsAnchors, tab.id)}" target="_blank" rel="noopener" aria-label="${tx2("Learn more about {name} in the documentation (opens in a new tab)", { name: fmt(tab.nameKey) })}">${tx2("Learn more")}</a>`;
    const tabButtons = TABS2.map((tab, i) => `<button type="button" role="tab" class="je-ta-tab" id="jeTaTab-${tab.id}" data-tab="${tab.id}" aria-controls="jeTaPanel-${tab.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"${tab.shortKey ? ` aria-label="${tx2(tab.nameKey)}"` : ""}><span class="material-icons" aria-hidden="true">${tab.icon}</span><span class="je-ta-tab-long">${tx2(tab.nameKey)}</span>${tab.shortKey ? `<span class="je-ta-tab-short" aria-hidden="true">${tx2(tab.shortKey)}</span>` : ""}</button>`).join("");
    const panels = TABS2.map((tab, i) => {
      const ownSections = sections2.filter((s) => s.tab === tab.id && !s.group);
      const rows = tab.id === "groups" ? `<section class="je-ta-card je-ta-grows-card" aria-labelledby="jeTaSec-groups-all"><h3 class="je-ta-card-title" id="jeTaSec-groups-all"><span class="material-icons je-ta-card-icon" aria-hidden="true">label</span>${tx2("Tag groups")}</h3><p class="je-ta-hint">${tx2(tab.descKey)} ${docsLink(tab)}</p><div class="je-ta-grows">${groupSections.map((s) => groupRowHtml(s)).join("")}</div></section>` : "";
      return `<div class="je-ta-panel" role="tabpanel" id="jeTaPanel-${tab.id}" data-tab="${tab.id}"${tab.lead ? ` data-lead="${tab.lead}"` : ""} aria-labelledby="jeTaPanelTitle-${tab.id}" ${i === 0 ? "" : "hidden"}><div class="je-ta-panel-head"><h2 tabindex="-1" id="jeTaPanelTitle-${tab.id}">${tx2(tab.nameKey)}</h2></div><p class="je-ta-hint">${tx2(tab.descKey)} ${docsLink(tab)}</p>` + ownSections.map((s) => sectionHtml(s)).join("") + rows + "</div>";
    }).join("");
    root.innerHTML = `
            <div class="je-ta-intro je-tab-intro"><span class="material-icons" aria-hidden="true">info</span><p>${tx2("Changes save automatically. These are the defaults new users start with and the settings everyone shares; existing users keep theirs, and anyone can change their own look in their Media Tags settings.")}</p></div>
            <div class="je-ta-sections"><div class="je-ta-tabs" role="tablist" aria-label="${tx2("Media Tags")}">${tabButtons}</div></div>
            <span class="je-ta-saved" id="jeTaSaved" data-state="saved" role="status" aria-live="polite" tabindex="-1"><span class="je-ta-saved-long">${tx2("All changes saved")}</span><span class="je-ta-saved-short" aria-hidden="true">${tx2("Saved")}</span></span>
            <div class="je-ta-unsaved" data-je-unsaved hidden><span class="material-icons" aria-hidden="true">sync_problem</span><span data-je-unsaved-text></span><button type="button" class="je-ta-button" data-je-review>${tx2("Review")}</button></div>
            <div class="je-ta-body">
                <aside class="je-ta-preview" id="jeTaPreview" aria-label="${tx2("Preview: a new user's cards")}">
                    <button type="button" class="je-ta-preview-toggle" aria-expanded="false" aria-controls="jeTaPreviewBody" data-je-info>${tx2("Preview: a new user's cards")}<span class="material-icons" aria-hidden="true">expand_more</span></button>
                    <div class="je-ta-preview-body" id="jeTaPreviewBody"><div class="je-ta-preview-mount"></div><details class="je-ta-preview-why" data-je-info><summary>${tx2("How looks are chosen")}</summary><p class="je-ta-preview-note">${tx2("Locked looks come first, then server-wide item looks, then the first matching rule, then episode and list-row looks, then the default.")}</p></details><p class="je-ta-native" id="jeTaNative"></p></div>
                </aside>
                <div class="je-ta-panels">${panels}</div>
            </div>
            <div class="je-ta-live" role="status" aria-live="polite"></div>`;
    function sectionHtml(s) {
      const scope = own(deps.sectionScopes, s.id);
      if (!scope && s.tab !== "groups") {
        for (const f of s.fields || []) if (f.key && f.type !== "custom" && !f.scope) f.scope = deps.seededKeys.includes(f.key) ? "new" : "all";
      }
      const chip = scope === "new" ? ` ${perUserMark2()}` : "";
      if (s.note) {
        return `<details class="je-ta-more je-ta-note" data-section="${esc2(s.id)}" data-je-info><summary class="je-ta-more-toggle" id="jeTaSec-${esc2(s.id)}"><span class="material-icons" aria-hidden="true">expand_more</span>${tx2(s.noteLabel || s.title)}</summary><div class="je-ta-more-body">${s.hint ? `<p class="je-ta-hint">${tx2(s.hint)}</p>` : ""}${fieldsHtml(kit2, s.fields, config)}<div class="je-ta-section-body"></div></div></details>`;
      }
      const iconName = own(deps.sectionIcons, s.id);
      const icon = !iconName ? "" : iconName.startsWith("img:") ? `<span class="je-ta-card-icon je-ta-card-icon-img" aria-hidden="true"><img alt="" src="${esc2(cdnUrl(iconName.slice(4)))}"></span>` : `<span class="material-icons je-ta-card-icon" aria-hidden="true">${iconName}</span>`;
      return `<section class="je-ta-card${s.note ? " je-ta-card--note" : ""}" data-section="${esc2(s.id)}" aria-labelledby="jeTaSec-${esc2(s.id)}"><h3 class="je-ta-card-title" id="jeTaSec-${esc2(s.id)}">${icon}${tx2(s.title)}${chip}</h3>${s.hint ? `<p class="je-ta-hint">${tx2(s.hint)}</p>` : ""}` + fieldsHtml(kit2, s.fields, config) + '<div class="je-ta-section-body"></div></section>';
    }
    function groupRowHtml(s) {
      const groupId = s.group ? s.group.id : "";
      for (const f of s.fields || []) if (f.key && f.type !== "enable" && f.type !== "custom" && !deps.seededKeys.includes(f.key)) f.scope = "all";
      const enable = (s.fields || []).find((f) => f.type === "enable");
      const on = enable ? config[enable.key] === true : true;
      const name = fmt(s.title);
      const ownControls = hasOwnControls(s, groupId);
      const placement = JE2().core?.tagLayout?.GROUPS?.some((g) => g === groupId) ? `<a class="je-ta-link je-ta-crosslink" href="#" data-je-goto="layout:placement-${esc2(groupId)}"><span class="je-ta-link-text">${tx2("{group} position and limit (Layout defaults)", { group: name })}</span><span class="material-icons" aria-hidden="true">arrow_forward</span></a>` : "";
      const mark = enable ? ` ${perUserMark2()}` : "";
      if (!ownControls) {
        return `<div class="je-ta-grow" data-group="${esc2(groupId)}" data-section="${esc2(s.id)}" data-enabled="${on}" data-open="false" data-je-static><div class="je-ta-grow-head"><div class="je-ta-grow-text"><span class="je-ta-grow-name" id="jeTaSec-${esc2(s.id)}">${esc2(name)}${mark}</span><span class="je-ta-grow-sum"></span>${scopesHtml(groupId)}${placement}</div><span class="je-ta-grow-sample" aria-hidden="true"></span>` + (enable ? `<label class="je-ta-grow-check"><input type="checkbox" id="${esc2(enable.id)}" data-je-field="${esc2(enable.key)}" data-je-setting-id="${esc2(enable.id)}" ${on ? "checked" : ""} aria-label="${tx2(enable.label)}"></label>` : "") + "</div></div>";
      }
      return `<div class="je-ta-grow" data-group="${esc2(groupId)}" data-section="${esc2(s.id)}" data-enabled="${on}" data-open="false"><div class="je-ta-grow-head"><div class="je-ta-grow-text"><span class="je-ta-grow-name" id="jeTaSec-${esc2(s.id)}">${esc2(name)}${mark}</span><span class="je-ta-grow-sum" id="jeTaSum-${esc2(s.id)}"></span></div><span class="je-ta-grow-sample" aria-hidden="true"></span>` + (enable ? `<label class="je-ta-grow-check"><input type="checkbox" id="${esc2(enable.id)}" data-je-field="${esc2(enable.key)}" data-je-setting-id="${esc2(enable.id)}" ${on ? "checked" : ""} aria-labelledby="jeTaSec-${esc2(s.id)}" aria-describedby="jeTaSum-${esc2(s.id)}"></label>` : "") + `<button type="button" class="je-ta-expand" aria-expanded="false" aria-controls="jeTaGroup-${esc2(groupId)}" aria-label="${tx2("Edit {name} settings", { name })}"><span class="je-ta-expand-text">${tx2("Edit")}</span><span class="material-icons" aria-hidden="true">expand_more</span></button></div><div class="je-ta-grow-body" id="jeTaGroup-${esc2(groupId)}" role="region" aria-labelledby="jeTaSec-${esc2(s.id)}" hidden>${s.hint ? `<p class="je-ta-hint">${tx2(s.hint)}</p>` : ""}` + placement + `${fieldsHtml(kit2, s.fields, config)}${scopesHtml(groupId)}<div class="je-ta-section-body"></div></div></div>`;
    }
    function hasOwnControls(s, group) {
      const core2 = JE2().core;
      const S = core2.tagScopes;
      return (s.fields || []).some((f) => f.type !== "enable" && f.type !== "custom") || typeof s.render === "function" || !!S && core2.tagSettingsMatrix?.offers("admin", group, "scopes") === true && (group === "rating" || S.SCOPED_GROUPS.includes(group));
    }
    function scopesHtml(group) {
      const core2 = JE2().core;
      const S = core2.tagScopes;
      if (!S) return "";
      const offered = core2.tagSettingsMatrix?.offers("admin", group, "scopes") ?? true;
      if (offered !== true) return `<p class="je-ta-hint" data-je-scope-na="${esc2(group)}">${tx2(word(WORDS.reason, offered) || offered)}</p>`;
      if (group !== "rating" && !S.SCOPED_GROUPS.includes(group)) return "";
      return `<fieldset class="je-ta-scopes" data-je-scope-block="${esc2(group)}"><legend class="je-ta-sub">${tx2("Where to show")}</legend><p class="je-ta-hint">${tx2("New users start with these choices, and users who have not changed theirs follow them.")}</p>` + S.SCOPE_IDS.map((scope) => {
        const ratingId = `ratingTagsOn${pascal(scope)}`;
        return `<label class="je-ta-switch"><input type="checkbox" id="${group === "rating" ? ratingId : `jeTaScope-${esc2(group)}-${scope}`}"${group === "rating" ? ` data-je-setting-id="${ratingId}" data-je-field="RatingTagsOn${pascal(scope)}"` : ""} data-je-scope-admin="${esc2(group)}" data-je-scope="${scope}" ${S.scopeDefault(group, scope, config) ? "checked" : ""}><span class="je-ta-switch-text"><span class="je-ta-switch-name">${tx2(own(SCOPE_LABELS, scope))}</span></span></label>`;
      }).join("") + `<p class="je-ta-hint">${tx2("Item types apply everywhere, native posters included. The Continue Watching and Next Up rows apply on the web. Collections and other videos always show the group.")}</p></fieldset>`;
    }
    const tabs = all(root, '[role="tab"]');
    const live = must(root, ".je-ta-live");
    const savedChip = must(root, "#jeTaSaved");
    let savedHtml = savedChip.innerHTML;
    const unsaved = must(root, "[data-je-unsaved]");
    let chipInView = true;
    const drawUnsaved = () => {
      const open = (store.state === "conflict" || store.state === "error") && !chipInView;
      unsaved.hidden = !open;
      root.classList.toggle("je-ta-unsaved-on", open);
      if (open) must(unsaved, "[data-je-unsaved-text]").textContent = fmt("Unsaved changes: {count}", { count: Math.max(1, store.conflicts.size || store.failed.length || store.values.size) });
    };
    if (typeof IntersectionObserver === "function") {
      const watch = new IntersectionObserver(([entry]) => {
        chipInView = !!entry?.isIntersecting;
        drawUnsaved();
      });
      watch.observe(savedChip);
      signal.addEventListener("abort", () => watch.disconnect());
    }
    unsaved.querySelector("[data-je-review]")?.addEventListener("click", () => {
      savedChip.scrollIntoView?.({ block: "center" });
      (find(savedChip, "button") || savedChip).focus({ preventScroll: true });
    }, { signal });
    const drawSaveState = () => {
      const state = store.state;
      queueMicrotask(drawUnsaved);
      savedChip.dataset.state = state;
      const names = (keys) => Array.from(new Set(keys.map((k) => fieldName(sections2, k)))).join(", ");
      let html;
      if (state === "conflict") {
        const keys = Array.from(store.conflicts.keys());
        const first = keys[0];
        const one = keys.length === 1 && first !== void 0 && store.values.has(first);
        const theirs = one ? valueLabel(first, store.conflicts.get(first)) : "";
        const mine = one ? valueLabel(first, store.values.get(first)) : "";
        const pairs = () => keys.map((k) => store.values.has(k) ? fmt("{field} (yours: {mine}, saved elsewhere: {theirs})", { field: fieldName(sections2, k), theirs: valueLabel(k, store.conflicts.get(k)), mine: valueLabel(k, store.values.get(k)) }) : fieldName(sections2, k)).join("; ");
        html = `<span>${one ? tx2("{field} was changed elsewhere to {theirs} (yours: {mine})", { field: fieldName(sections2, first), theirs, mine }) : esc2(fmt("Changed elsewhere: {fields}", { fields: pairs() }))}</span><button type="button" data-je-keep>${one ? tx2("Keep {value}", { value: mine }) : tx2("Keep mine")}</button><button type="button" data-je-theirs>${one ? tx2("Use {value}", { value: theirs }) : tx2("Take theirs")}</button>`;
      } else if (state === "error") {
        const fields = names(store.failed.length ? store.failed : Array.from(store.values.keys()));
        html = `<span>${fields ? tx2("Not saved: {fields}", { fields }) : tx2("Not saved")}</span><button type="button" data-je-retry>${tx2("Retry")}</button>`;
      } else html = `<span class="je-ta-saved-long">${tx2(state === "saving" ? "Saving…" : "All changes saved")}</span><span class="je-ta-saved-short" aria-hidden="true">${tx2(state === "saving" ? "Saving…" : "Saved")}</span>`;
      if (html === savedHtml) return;
      savedHtml = html;
      const focused = activeElement();
      const inside = !!focused && savedChip.contains(focused);
      const key = inside && focused ? ["data-je-retry", "data-je-keep", "data-je-theirs"].find((a) => focused.hasAttribute(a)) : null;
      savedChip.innerHTML = html;
      if (state === "conflict" || state === "error") requestAnimationFrame(() => {
        const now = activeElement();
        if (!now || !root.contains(now) || savedChip.contains(now)) return;
        const row = now.closest("[data-field-row], .je-ta-field, .je-ta-switch") || now;
        const bar = savedChip.getBoundingClientRect();
        if (!bar.height) return;
        const over = row.getBoundingClientRect().bottom - (bar.top - 16);
        if (over > 0) document.scrollingElement?.scrollBy?.({ top: over, behavior: "smooth" });
      });
      if (!inside) return;
      const again = key && find(savedChip, `[${key}]`) || find(savedChip, "button");
      (again || savedChip).focus({ preventScroll: true });
    };
    savedChip.addEventListener("click", (e) => {
      const target = targetOf(e);
      if (!target) return;
      if (target.closest("[data-je-retry]")) void flush();
      else if (target.closest("[data-je-keep]")) void saves2.resolveConflicts(true);
      else if (target.closest("[data-je-theirs]")) void saves2.resolveConflicts(false);
    }, { signal });
    const flush = () => !disposed && saves2.sameSession(contextMark) ? saves2.flush() : Promise.resolve(false);
    const onStore = (event) => {
      if (disposed) return;
      let moved = false;
      if (event.type === "saved" && event.values) {
        for (const [key, value] of Object.entries(event.values)) {
          const shown = store.values.has(key) && key === "TagLookItemOverrides" ? store.values.get(key) : value;
          if (store.values.has(key) && key !== "TagLookItemOverrides" || sameValue(config[key], shown)) continue;
          config[key] = copy(shown);
          moved = true;
        }
      }
      if (moved) {
        for (const s of sections2) s.load?.(ctx, bodyOf(s));
        refresh();
      }
      if (event.type === "saved" && (event.theirs || event.values && Object.keys(event.values).some((key) => key.startsWith("TagStyle")))) void loadPreviewStyles();
      drawSaveState();
    };
    store.views.add(onStore);
    const owned = deps.pageFields();
    function setMany(values, opts = {}) {
      if (disposed) return;
      let edited = false;
      for (const [key, raw] of Object.entries(values)) {
        if (!owned.has(key)) {
          console.error(`🪼 Jellyfin Enhanced: the Media Tags tab does not declare ${key}; not saved`);
          continue;
        }
        const value = raw === void 0 ? null : raw;
        const known = opts.base && Object.prototype.hasOwnProperty.call(opts.base, key) ? opts.base[key] : config[key];
        if (!store.values.has(key) && sameValue(known, value)) continue;
        if (!store.values.has(key) && !store.base.has(key)) store.base.set(key, copy(known));
        if (key === "TagLookItemOverrides") saves2.recordItemEdit(config[key], value, !!opts.itemEdit);
        config[key] = value;
        store.values.set(key, value);
        edited = true;
      }
      if (edited) saves2.schedule();
      refresh(opts.redraw === false ? { controls: false } : {});
    }
    const allFields = sections2.flatMap((s) => (s.fields || []).map((f) => ({ f, s })));
    const fieldById = new Map(allFields.map(({ f, s }) => [f.id, { f, s }]));
    const scopeOf = (raw) => JE2().core.tagScopes?.SCOPE_IDS.find((id) => id === raw);
    function syncControls() {
      const S = JE2().core.tagScopes;
      allAs(root, "[data-je-scope-admin]", HTMLInputElement).forEach((el) => {
        const scope = scopeOf(el.dataset.jeScope);
        if (el !== document.activeElement && S && scope) el.checked = S.scopeDefault(el.dataset.jeScopeAdmin || "", scope, config);
      });
      for (const { f } of allFields) {
        if (f.type === "custom") continue;
        const el = find(root, `[data-je-setting-id="${f.id}"]`);
        if (!el || el === document.activeElement) continue;
        const value = fieldValue(f, config);
        if (f.type === "switch" || f.type === "enable" || f.type === "ordered") {
          if (el instanceof HTMLInputElement) el.checked = !!value;
        } else if (f.type === "pills") allAs(el, "input", HTMLInputElement).forEach((r) => {
          r.checked = r.value === String(value);
        });
        else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.value = String(value ?? "");
      }
    }
    function syncAvailability() {
      for (const { f } of allFields) {
        if (f.visible) {
          const row2 = find(root, `[data-field-row="${f.id}"]`);
          if (row2) row2.hidden = !f.visible(config);
        }
        if (!f.when) continue;
        const el = root.querySelector(`[data-je-setting-id="${f.id}"]`);
        const row = find(root, `[data-field-row="${f.id}"]`);
        const on = !!f.when(config);
        if (f.hideWhenOff && row) row.hidden = !on;
        if (el) {
          if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) el.disabled = !on;
          else allAs(el, "input", HTMLInputElement).forEach((i) => {
            i.disabled = !on;
          });
        }
      }
    }
    root.addEventListener("change", (e) => {
      const input = e.target;
      if (!(input instanceof HTMLInputElement)) return;
      const group = input.dataset.jeScopeAdmin;
      if (!group) return;
      const scope = input.dataset.jeScope || "";
      if (group === "rating") {
        setMany({ [`RatingTagsOn${pascal(scope)}`]: input.checked }, { redraw: false });
        return;
      }
      const stored = copy(config.TagGroupScopes || {});
      const scopes = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
      const previous = scopes[pascal(group)];
      const set = { ...previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {} };
      if (input.checked) delete set[pascal(scope)];
      else set[pascal(scope)] = false;
      if (Object.keys(set).length) scopes[pascal(group)] = set;
      else delete scopes[pascal(group)];
      setMany({ TagGroupScopes: Object.keys(scopes).length ? scopes : null }, { redraw: false });
    }, { signal });
    root.addEventListener("change", (e) => {
      const target = targetOf(e);
      const holder = target ? target.closest("[data-je-setting-id]") : null;
      const entry = holder instanceof HTMLElement ? fieldById.get(holder.dataset.jeSettingId || "") : void 0;
      if (!holder || !entry || entry.f.type === "custom") return;
      const value = controlValue(entry.f, holder, config);
      const extra = entry.f.onChange ? entry.f.onChange(value, config) || {} : {};
      setMany({ [entry.f.key]: value, ...extra }, { redraw: false });
      if (entry.f.type === "number" || entry.f.type === "text") syncControls();
      if (entry.f.type === "enable") {
        const row = holder.closest(".je-ta-grow");
        if (row instanceof HTMLElement) row.dataset.enabled = String(value);
      }
    }, { signal });
    root.addEventListener("click", (e) => {
      const toggle = closest(e, "[data-order-reorder]");
      if (!toggle) return;
      const on = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(on));
      if (toggle.lastElementChild) toggle.lastElementChild.textContent = fmt(on ? "Finish reordering" : "Reorder categories");
      toggle.focus({ preventScroll: true });
    }, { signal });
    root.addEventListener("click", (e) => {
      const button = closest(e, "[data-move]");
      if (!button || isDisabled(button)) return;
      const li = button.closest("li[data-ordered]");
      const list2 = li?.parentElement;
      if (!(li instanceof HTMLElement) || !list2) return;
      const dir = Number(button.dataset.move);
      const sibling = dir < 0 ? li.previousElementSibling : li.nextElementSibling;
      if (!sibling) return;
      if (dir < 0) list2.insertBefore(li, sibling);
      else list2.insertBefore(sibling, li);
      const values = {};
      Array.from(list2.children).forEach((row, i) => {
        const f = row instanceof HTMLElement ? fieldById.get(row.dataset.ordered || "")?.f : void 0;
        if (f?.orderKey) values[f.orderKey] = i + 1;
        const rank = row.querySelector(".je-ta-rank");
        if (rank) rank.textContent = String(i + 1);
        row.querySelector('[data-move="-1"]')?.toggleAttribute("disabled", i === 0);
        row.querySelector('[data-move="1"]')?.toggleAttribute("disabled", i === list2.children.length - 1);
      });
      setMany(values, { redraw: false });
      const again = find(li, `[data-move="${dir}"]`);
      focus(again && !isDisabled(again) ? again : li.querySelector("[data-move]:not([disabled])") || li.querySelector("input"));
      announce(fmt("{name} moved to position {n}", { name: li.querySelector(".je-ta-order-name")?.textContent || "", n: Array.from(list2.children).indexOf(li) + 1 }));
    }, { signal });
    const current = () => root.dataset.tab || "overview";
    const phone = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 900px)") : null;
    function focusTarget(id) {
      const panel = find(root, `#jeTaPanel-${id}`);
      if (!panel) return null;
      const card = panel.dataset.lead === "card" ? find(panel, ".je-ta-card-title") : null;
      if (card) {
        card.tabIndex = -1;
        return card;
      }
      return find(panel, `#jeTaPanelTitle-${id}`);
    }
    function placeSaved() {
      const target = phone?.matches ? root.querySelector(".je-ta-sections") : root.querySelector(`#jeTaPanel-${root.dataset.tab || "overview"} > .je-ta-panel-head`);
      if (!target || savedChip.parentElement === target) return;
      const hadFocus = savedChip.contains(document.activeElement);
      target.append(savedChip);
      if (hadFocus) (find(savedChip, "button") || savedChip).focus({ preventScroll: true });
    }
    phone?.addEventListener?.("change", placeSaved, { signal });
    function openTab(id, opts = {}) {
      const tab = tabs.find((t) => t.dataset.tab === id);
      if (!tab) return false;
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        const panel = find(root, `#jeTaPanel-${t.dataset.tab}`);
        if (panel) panel.hidden = !on;
      }
      root.dataset.tab = id;
      try {
        window.sessionStorage.setItem(deps.tabStoreKey, id);
      } catch {
      }
      for (const s of sections2) if (s.tab === id && s.show) s.show(ctx, bodyOf(s));
      if (opts.group) setGroupOpen(opts.group, true, { focus: opts.focus });
      placeSaved();
      if (!opts.group && opts.focus) focusTarget(id)?.focus();
      if (opts.focusTab) tab.focus();
      tab.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      syncSpotlight();
      root.dispatchEvent(new CustomEvent("je-media-tags-section", { bubbles: true, detail: { section: id } }));
      return true;
    }
    const tablist = must(root, '[role="tablist"]');
    tablist.addEventListener("click", (e) => {
      const tab = closest(e, '[role="tab"]');
      if (tab) openTab(tab.dataset.tab || "overview");
    }, { signal });
    tablist.addEventListener("keydown", (e) => {
      const focused = activeElement();
      const index = focused ? tabs.indexOf(focused) : -1;
      if (index < 0) return;
      let next = -1;
      const step = getComputedStyle(tablist).direction === "rtl" || tablist.closest("[dir]")?.getAttribute("dir") === "rtl" ? -1 : 1;
      if (e.key === "ArrowRight") next = (index + step + tabs.length) % tabs.length;
      else if (e.key === "ArrowLeft") next = (index - step + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      openTab(tabs[next]?.dataset.tab || "overview", { focusTab: true });
    }, { signal });
    root.addEventListener("click", (e) => {
      const goto = closest(e, "[data-je-goto]");
      if (!goto) return;
      e.preventDefault();
      const [tab = "", group] = String(goto.dataset.jeGoto).split(":");
      openTab(tab, { group: group || null, focus: true });
    }, { signal });
    function setGroupOpen(group, open, opts = {}) {
      const row = find(root, `.je-ta-grow[data-group="${group}"]`);
      if (!row) {
        let anchor = find(root, `[data-je-anchor="${group}"]`);
        if (anchor && opts.focus) {
          const opener = find(anchor, '[data-act="open"][aria-expanded="false"]');
          if (opener) {
            opener.click();
            anchor = find(root, `[data-je-anchor="${group}"]`) || anchor;
          }
          anchor.scrollIntoView?.({ block: "start" });
          find(anchor, '[data-act="open"], button, input, select')?.focus({ preventScroll: true });
        }
        return;
      }
      const body = must(row, ".je-ta-grow-body");
      const button = must(row, ".je-ta-expand");
      openGroups.set(group, open);
      row.dataset.open = String(open);
      body.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      const label = button.querySelector(".je-ta-expand-text");
      if (label) label.textContent = fmt("Edit");
      const s = sections2.find((x) => x.group?.id === group);
      if (open && s?.show) s.show(ctx, bodyOf(s));
      if (open && opts.focus) {
        row.scrollIntoView?.({ block: "start" });
        (find(body, "input, select, textarea, button") || button).focus({ preventScroll: true });
      }
      syncSpotlight();
    }
    root.querySelector(".je-ta-grows")?.addEventListener("click", (e) => {
      const button = closest(e, ".je-ta-expand");
      const row = button?.closest(".je-ta-grow");
      if (row instanceof HTMLElement) setGroupOpen(row.dataset.group || "", button?.getAttribute("aria-expanded") !== "true");
    }, { signal });
    function bodyOf(s) {
      return find(root, `[data-section="${s.id}"] .je-ta-section-body`);
    }
    function sampleChip([kind, value]) {
      if (kind === "flag") return `<img class="je-ta-chip je-ta-chip-flag" data-kind="lang" alt="" src="${esc2(cdnUrl("flag-icons/flags/4x3/" + value + ".svg"))}">`;
      if (kind === "icon") return `<span class="je-ta-chip" data-kind="genre"><i class="je-ts-genre-glyph" aria-hidden="true">${esc2(value)}</i></span>`;
      return `<span class="je-ta-chip" data-kind="${esc2(kind)}">${esc2(value)}</span>`;
    }
    function syncGroupRows() {
      for (const s of groupSections) {
        if (!s.group) continue;
        const row = find(root, `.je-ta-grow[data-group="${s.group.id}"]`);
        if (!row) continue;
        const enable = (s.fields || []).find((f) => f.type === "enable");
        row.dataset.enabled = String(enable ? config[enable.key] === true : true);
        const sum = row.querySelector(".je-ta-grow-sum");
        if (sum) sum.textContent = s.group.summary ? s.group.summary(ctx) : "";
        const sample = row.querySelector(".je-ta-grow-sample");
        if (sample) sample.innerHTML = (s.group.sample ? s.group.sample(ctx) : []).map(sampleChip).join("");
      }
    }
    const previewBox = must(root, "#jeTaPreview");
    const previewToggle = must(root, ".je-ta-preview-toggle");
    previewToggle.addEventListener("click", () => {
      const open = previewToggle.getAttribute("aria-expanded") !== "true";
      previewToggle.setAttribute("aria-expanded", String(open));
      previewBox.classList.toggle("je-ta-preview-open", open);
    }, { signal });
    const mount2 = must(root, ".je-ta-preview-mount");
    const createPreview = settingsUi(JE2())?.createTagPreview;
    if (typeof createPreview === "function") {
      preview = createPreview(mount2, { source: () => ({ settings: deps.seedUser(config), plugin: config }) });
      const why = find(root, ".je-ta-preview-why");
      const foot = mount2.querySelector(".je-mtp-foot");
      if (why && foot) why.insertBefore(foot, why.querySelector(".je-ta-preview-note"));
      const nativeLine = root.querySelector("#jeTaNative");
      if (why && nativeLine) why.append(nativeLine);
    }
    const previewBody = must(root, "#jeTaPreviewBody");
    previewBody.setAttribute(JE2().tagStyles?.SCOPE_ATTR || "data-je-tag-styles-scope", "");
    let stylesSeq = 0;
    async function loadPreviewStyles() {
      const seq = ++stylesSeq;
      const mark = saves2.sessionMark();
      let styles;
      try {
        const client = apiClient();
        styles = await client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/tag-styles"), dataType: "json" });
      } catch (err) {
        if (!disposed && saves2.sameSession(mark)) console.warn("🪼 Jellyfin Enhanced: could not load the Tag Styles for the preview", err);
        return;
      }
      if (!saves2.sameSession(mark) || disposed || seq !== stylesSeq) return;
      const bridge = JE2();
      const build = bridge.tagStyles?.buildCss;
      const css = typeof build === "function" ? build(styles || {}, "#jeTaPreviewBody") : "";
      if (css) bridge.core.ui.injectCss(deps.previewStyleId, css);
      else bridge.core.ui.removeCss(deps.previewStyleId);
    }
    function syncSpotlight() {
      if (!preview) return;
      const open = current() === "groups" ? Array.from(openGroups.keys()).find((g) => openGroups.get(g)) : null;
      const spot = current() === "badges" ? "status" : open && open !== "people" ? open : null;
      preview.setSpotlight(spot);
    }
    function syncNative() {
      const line = root.querySelector("#jeTaNative");
      if (!line) return;
      const on = config.NativePosterTagsEnabled === true;
      const colours = config.TagStylesEnabled === true && ["native", "both"].includes(String(config.TagStyleTarget || "both"));
      const names = WORDS.layout;
      const layout = String(config.TagLayout || "corners").toLowerCase();
      const name = (l) => fmt(word(names, l) || word(names, "corners") || "Corners");
      const look = ["corners", "bands"].includes(layout) ? fmt("{layout} · {density}", { layout: name(layout), density: fmt(config.TagLabelDensity === "compact" ? "Compact" : "Full") }) : fmt("{corners} · {full} ({layout} is drawn as {corners})", { corners: name("corners"), full: fmt("Full"), layout: name(layout) });
      line.innerHTML = `<strong>${tx2("Native posters:")}</strong> ${on ? tx2(colours ? "on, with your tag colours. Apps such as Android TV get these tags drawn into the poster, as {look}." : "on. Apps such as Android TV get these tags drawn into the poster, as {look}.", { look }) : tx2("off. Apps such as Android TV show untagged posters.")}`;
    }
    function announce(message) {
      live.textContent = "";
      setTimeout(() => {
        if (!disposed) live.textContent = message;
      }, 30);
    }
    async function confirmAction(question, title) {
      const mark = saves2.sessionMark();
      const ok = options.confirm ? await options.confirm(question, title) : await deps.askConfirm(question, title);
      return !!ok && !disposed && saves2.sameSession(mark);
    }
    const snackOrigins = /* @__PURE__ */ new WeakMap();
    function removeSnack(bar) {
      if (!bar) return;
      const focused = bar.contains(document.activeElement);
      bar.remove();
      if (!focused || disposed) return;
      (snackOrigins.get(bar)?.() || (phone?.matches ? find(root, '[role="tab"][aria-selected="true"]') : focusTarget(root.dataset.tab || "overview")))?.focus();
    }
    function snack(message, undo, origin) {
      removeSnack(root.querySelector(".je-ta-snack"));
      if (snackTimer !== null) clearTimeout(snackTimer);
      const opener = document.activeElement;
      const bar = document.createElement("div");
      snackOrigins.set(bar, () => {
        for (const el of [origin?.(), opener]) {
          if (el instanceof HTMLElement && el.isConnected && root.contains(el) && !el.closest("[hidden]") && !isDisabled(el)) return el;
        }
        return null;
      });
      bar.className = "je-ta-snack";
      bar.setAttribute("role", "status");
      const label = document.createElement("span");
      label.textContent = message;
      bar.appendChild(label);
      if (undo) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "je-ta-button";
        button.textContent = fmt("Undo");
        button.addEventListener("click", () => {
          removeSnack(bar);
          undo();
          announce(fmt("Undone"));
        });
        bar.appendChild(button);
      }
      root.appendChild(bar);
      snackTimer = setTimeout(() => removeSnack(bar), undo ? deps.undoMs : 4e3);
      announce(message);
    }
    function refresh(opts = {}) {
      if (disposed) return;
      if (opts.controls !== false) syncControls();
      syncAvailability();
      syncGroupRows();
      for (const s of sections2) if (s.refresh) s.refresh(ctx, bodyOf(s));
      syncNative();
      preview?.refresh();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      store.views.delete(onStore);
      if (snackTimer !== null) clearTimeout(snackTimer);
      preview?.dispose();
      preview = null;
      JE2().core.ui.removeCss(deps.previewStyleId);
      for (const s of sections2) s.dispose?.(ctx);
    }
    function reload(fresh) {
      if (disposed) return;
      const keep = saves2.protectedFields();
      for (const key of Object.keys(fresh)) if (!keep.has(key)) config[key] = fresh[key];
      for (const key of owned) if (!(key in fresh) && !keep.has(key)) config[key] = null;
      for (const { f } of allFields) if (f.secret && !keep.has(f.key)) delete config[f.key];
      for (const s of sections2) s.load?.(ctx, bodyOf(s));
      refresh();
      void loadPreviewStyles();
    }
    const ctx = {
      perUserMark: perUserMark2,
      root,
      config,
      t: fmt,
      tx: tx2,
      esc: esc2,
      set: (key, value) => setMany({ [key]: value }, { itemEdit: true }),
      isCurrent: () => !disposed && saves2.sameSession(contextMark),
      setMany,
      flush,
      refresh,
      reload,
      openTab,
      setGroupOpen,
      confirm: confirmAction,
      snack,
      announce,
      dispose,
      pageUrl: deps.pageUrl,
      mainPageUrl: deps.mainPageUrl,
      /** The tab shown now. */
      currentTab: current,
      /** Whether some change is not saved yet. */
      pending: saves2.hasPending,
      /** Whether the page was torn down (late asynchronous answers are dropped). */
      get disposed() {
        return disposed;
      },
      /** Aborted when the page is torn down: pass it to listeners on elements that outlive the page. */
      signal,
      get preview() {
        return preview;
      },
      layout: JE2().core?.tagLayout || null,
      fieldValue
    };
    for (const s of sections2) {
      const body = bodyOf(s);
      if (s.render && body) s.render(ctx, body);
    }
    refresh({ controls: false });
    drawSaveState();
    void loadPreviewStyles();
    let start = options.target || deps.freshTarget();
    if (!start.tab || !TABS2.some((t) => t.id === start.tab)) {
      let saved = null;
      try {
        saved = window.sessionStorage.getItem(deps.tabStoreKey);
      } catch {
      }
      start = { tab: TABS2.some((t) => t.id === saved) ? saved : "overview", group: null };
    }
    openTab(start.tab || "overview", { group: start.group });
    return ctx;
  }

  // client/src/features/media-tags/admin/save-store.ts
  var ITEM_KEY = "TagLookItemOverrides";
  async function rejectionOf(err) {
    if (!err || typeof err !== "object") return null;
    const status = Number(Reflect.get(err, "status"));
    if (status < 400 || status >= 500) return null;
    try {
      const json = Reflect.get(err, "json");
      const body = typeof json === "function" ? await Reflect.apply(json, err, []) : err;
      return body && typeof body === "object" ? { conflicts: Reflect.get(body, "conflicts"), error: Reflect.get(body, "error") } : null;
    } catch {
      return null;
    }
  }
  var statusOf = (err) => err && typeof err === "object" ? Reflect.get(err, "status") : void 0;
  function createSaveStore(deps) {
    const store = {
      values: /* @__PURE__ */ new Map(),
      base: /* @__PURE__ */ new Map(),
      conflicts: /* @__PURE__ */ new Map(),
      state: "saved",
      failed: [],
      timer: null,
      saving: null,
      host: null,
      views: /* @__PURE__ */ new Set(),
      owner: null,
      itemEdits: /* @__PURE__ */ new Map(),
      itemMode: null,
      itemFlight: null,
      generation: 0,
      hold: null
    };
    let holdTail = null;
    const clearTimer = () => {
      if (store.timer !== null) clearTimeout(store.timer);
      store.timer = null;
    };
    function notify(event) {
      for (const view of Array.from(store.views)) view(event);
      try {
        deps.announce({ type: event.type, values: event.values || null, state: store.state });
      } catch {
      }
    }
    function setState(state) {
      store.state = state;
      notify({ type: "state" });
    }
    function resetSession() {
      store.generation++;
      clearTimer();
      store.saving = null;
      store.values.clear();
      store.base.clear();
      store.itemEdits.clear();
      store.itemMode = null;
      store.itemFlight = null;
      store.conflicts.clear();
      store.failed = [];
      store.host = null;
      store.owner = null;
      store.state = "saved";
      store.hold = null;
      holdTail = null;
      deps.onReset();
      notify({ type: "state" });
    }
    function checkSession() {
      const now = deps.identity();
      if (store.owner !== null && store.owner !== now) resetSession();
      store.owner = now;
    }
    function sessionMark() {
      checkSession();
      return { generation: store.generation, owner: store.owner };
    }
    function sameSession(mark) {
      checkSession();
      return mark.generation === store.generation && mark.owner === store.owner;
    }
    const hasPending = () => store.values.size > 0 || !!store.saving || !!store.timer;
    const protectedFields = () => new Set(store.values.keys());
    function rebaseItemEdits(raw) {
      const look = deps.tagLook();
      const looks = look.normalizeItemOverrides(raw);
      for (const [id, edit] of store.itemEdits) {
        if (edit.value) {
          const entry = look.normalizeItemOverrides([edit.value]).get(id);
          if (entry) looks.set(id, entry);
        } else looks.delete(id);
      }
      return copy(look.itemOverridesToWire(looks));
    }
    function itemEditsMutation(edits) {
      return {
        Set: Array.from(edits.values()).filter((e) => e.value).map((e) => e.value),
        Remove: Array.from(edits).filter(([, e]) => !e.value).map(([id]) => id),
        Expected: Object.fromEntries(Array.from(edits, ([id, e]) => [id, e.expected]))
      };
    }
    const entriesById = (saved) => new Map(objects(saved).map((e) => [String(e.ItemId), e]));
    function flush() {
      clearTimer();
      checkSession();
      if (store.hold) {
        const hold = store.hold;
        const generation = store.generation;
        return hold.then(() => generation === store.generation ? flush() : false);
      }
      if (store.saving) return store.saving.then((ok) => ok && store.values.size ? flush() : ok);
      if (store.itemMode === "entries" && !store.conflicts.has(ITEM_KEY)) {
        const look = deps.tagLook();
        for (const [id, edit] of store.itemEdits) {
          const delta = look.itemOverrideMutation(edit.expected ? [edit.expected] : null, edit.value ? [edit.value] : null);
          if (!edit.acknowledge && !delta.Set.length && !delta.Remove.length) store.itemEdits.delete(id);
        }
        if (!store.itemEdits.size) {
          const value = store.base.get(ITEM_KEY) ?? null;
          store.values.delete(ITEM_KEY);
          store.base.delete(ITEM_KEY);
          store.itemMode = null;
          notify({ type: "saved", values: { [ITEM_KEY]: value } });
        }
      }
      const sent = new Map(Array.from(store.values).filter(([key]) => !store.conflicts.has(key)));
      if (!sent.size) {
        setState(store.conflicts.size ? "conflict" : "saved");
        return Promise.resolve(!store.conflicts.size);
      }
      const host2 = store.host;
      const mark = { generation: store.generation, owner: store.owner };
      const changes = Object.fromEntries(sent);
      const expected = {};
      const itemEdits = sent.has(ITEM_KEY) && store.itemMode === "entries" ? new Map(store.itemEdits) : null;
      for (const key of sent.keys()) {
        const base = store.base.get(key);
        if (store.base.has(key) && base !== void 0 && !deps.isSecret(key)) expected[key] = base;
      }
      if (sent.has(ITEM_KEY)) {
        if (itemEdits) {
          changes[ITEM_KEY] = itemEditsMutation(itemEdits);
          delete expected[ITEM_KEY];
        }
        store.itemFlight = { value: sent.get(ITEM_KEY), edits: itemEdits };
      }
      setState("saving");
      let refused = false;
      const saving = (async () => {
        try {
          if (!host2) throw new Error("No Media Tags page is open to save from");
          const result = await host2.patch(changes, expected);
          if (!sameSession(mark)) return false;
          const answered = result && typeof result === "object" ? configOf(Reflect.get(result, "values")) : null;
          if (!answered || Array.from(sent.keys()).some((key) => !Object.prototype.hasOwnProperty.call(answered, key))) {
            throw new Error("Media Tags save returned an incomplete acknowledgement");
          }
          const stored = answered;
          const savedValue = (key) => stored[key];
          for (const [key, value] of sent) {
            const saved = savedValue(key);
            if (store.values.has(key) && store.values.get(key) !== value) {
              store.base.set(key, copy(saved));
              if (key === ITEM_KEY && store.itemMode === "entries") {
                const savedEntries = entriesById(saved);
                for (const [id, edit] of itemEdits || []) {
                  const pending = store.itemEdits.get(id);
                  if (pending === edit) store.itemEdits.delete(id);
                  else if (pending) store.itemEdits.set(id, { ...pending, expected: copy(savedEntries.get(id)) });
                }
                store.values.set(key, rebaseItemEdits(saved));
              }
            } else {
              store.values.delete(key);
              store.base.delete(key);
              if (key === ITEM_KEY) {
                store.itemEdits.clear();
                store.itemMode = null;
              }
            }
          }
          store.failed = [];
          const values = {};
          for (const key of sent.keys()) values[key] = savedValue(key);
          notify({ type: "saved", values });
          return true;
        } catch (err) {
          const rejection = await rejectionOf(err);
          const rawConflicts = statusOf(err) === 409 ? configOf(rejection?.conflicts) : null;
          const conflictKeys = Object.keys(rawConflicts || {});
          const conflicts = conflictKeys.length && conflictKeys.every((key) => sent.has(key)) ? rawConflicts : null;
          const unwritten = !!conflicts && Object.keys(conflicts).length > 0 || typeof rejection?.error === "string" && rejection.error.includes(ITEM_KEY);
          if (!sameSession(mark)) return false;
          for (const [id, edit] of itemEdits || []) {
            const pending = store.itemEdits.get(id);
            if (!pending) continue;
            if (!unwritten) store.itemEdits.set(id, { ...pending, acknowledge: true });
            else if (pending !== edit) store.itemEdits.set(id, { ...pending, expected: edit.expected });
          }
          if (conflicts && Object.keys(conflicts).length) {
            for (const [key, theirs] of Object.entries(conflicts)) store.conflicts.set(key, theirs ?? null);
            refused = true;
          } else {
            deps.reportSaveError(err);
            store.failed = Array.from(sent.keys());
          }
          return false;
        } finally {
          if (mark.generation === store.generation) {
            store.saving = null;
            store.itemFlight = null;
          }
        }
      })();
      store.saving = saving;
      return saving.then((ok) => {
        if (!sameSession(mark)) return false;
        if (refused) return flush();
        if (!ok) setState("error");
        else if (store.values.size) return flush();
        else setState(store.conflicts.size ? "conflict" : "saved");
        return ok && !store.conflicts.size;
      });
    }
    function resolveConflicts(mine) {
      const theirs = Object.fromEntries(store.conflicts);
      store.conflicts.clear();
      for (const [key, value] of Object.entries(theirs)) {
        if (mine) {
          store.base.set(key, copy(value));
          if (key === ITEM_KEY && store.itemMode === "entries") {
            const entries = entriesById(value);
            for (const [id, edit] of store.itemEdits) store.itemEdits.set(id, { ...edit, expected: copy(entries.get(id)) });
            store.values.set(key, rebaseItemEdits(value));
          }
        } else {
          store.values.delete(key);
          store.base.delete(key);
          if (key === ITEM_KEY) {
            store.itemEdits.clear();
            store.itemMode = null;
          }
        }
      }
      if (!mine) notify({ type: "saved", values: theirs, theirs: true });
      return flush();
    }
    async function holdSaves(fn) {
      const mark = sessionMark();
      const previous = holdTail;
      let releaseQueue = () => {
      };
      const queued = new Promise((resolve) => {
        releaseQueue = resolve;
      });
      holdTail = queued;
      const requireOwner = () => {
        if (!sameSession(mark)) {
          const error = new Error("Media Tags action belongs to a previous session");
          error.name = "AbortError";
          throw error;
        }
      };
      try {
        if (previous) await previous;
        requireOwner();
        if (hasPending()) {
          try {
            await flush();
          } catch {
          }
          requireOwner();
        }
        let release = () => {
        };
        const hold = new Promise((resolve) => {
          release = resolve;
        });
        store.hold = hold;
        let active = true;
        const scope = {
          isCurrent: () => active && sameSession(mark),
          throwIfStale: () => {
            if (!active) {
              const error = new Error("Media Tags action has already finished");
              error.name = "AbortError";
              throw error;
            }
            requireOwner();
          }
        };
        try {
          return await fn(scope);
        } finally {
          active = false;
          if (store.hold === hold) store.hold = null;
          release();
        }
      } finally {
        if (holdTail === queued) holdTail = null;
        releaseQueue();
      }
    }
    function schedule() {
      clearTimer();
      setState("saving");
      store.timer = setTimeout(() => {
        store.timer = null;
        void flush();
      }, deps.saveDelayMs);
    }
    function recordItemEdit(before, value, itemEdit) {
      const replacing = store.itemMode === "replace";
      if (itemEdit && !replacing) {
        const delta = deps.tagLook().itemOverrideMutation(before, value);
        const sets = new Map(delta.Set.map((e) => [e.ItemId, e]));
        for (const id of Object.keys(delta.Expected)) {
          const previous = store.itemEdits.get(id);
          const inFlight = !!previous && store.itemFlight?.edits?.get(id) === previous;
          store.itemEdits.set(id, { value: copy(sets.get(id)), expected: previous && !inFlight ? previous.expected : copy(delta.Expected[id]), acknowledge: !!previous?.acknowledge });
        }
        store.itemMode = "entries";
      } else {
        store.itemEdits.clear();
        store.itemMode = "replace";
      }
    }
    return {
      store,
      notify,
      setState,
      resetSession,
      checkSession,
      sessionMark,
      sameSession,
      hasPending,
      protectedFields,
      flush,
      resolveConflicts,
      holdSaves,
      schedule,
      recordItemEdit
    };
  }

  // client/src/features/media-tags/admin/types.ts
  var TAB_IDS = ["overview", "layout", "groups", "rules", "colours", "badges", "server"];

  // client/src/features/media-tags/admin/admin-tags.ts
  var JE = adminBridge();
  var PLUGIN_ID = "f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b";
  var MAIN_PAGE_NAME = "Jellyfin Enhanced";
  var TAB_ID = "media-tags";
  var LEGACY_PAGE_NAME = "JellyfinEnhancedMediaTags";
  var SAVE_DELAY_MS = 400;
  var UNDO_MS = 1e4;
  var TAB_STORE_KEY = "JE_mediaTagsAdminTab";
  var PREVIEW_STYLE_ID = "je-tag-admin-preview-styles";
  var SECTION_FILES = [
    "tag-styles-editor.js",
    "custom-rules-editor.js",
    "sections/overview.js",
    "sections/layout.js",
    "sections/quality.js",
    "sections/genre.js",
    "sections/language.js",
    "sections/rating.js",
    "sections/agerating.js",
    "sections/status.js",
    "sections/people.js",
    "sections/awards.js",
    "sections/logos.js",
    "sections/custom.js",
    "sections/rules.js",
    "sections/colours.js",
    "sections/badges.js",
    "sections/server.js",
    "sections/portable.js"
  ];
  var SECTION_SCOPES = {
    "layout-look": "new",
    "layout-groups": "new",
    "layout-shapes": "new",
    rules: "new",
    "badges-families": "new",
    colours: "all",
    "badges-windows": "all",
    "badges-tmdb": "all",
    "badges-leaving": "all",
    "item-looks": "all",
    "server-cache": "all",
    "server-native": "all",
    "server-presets": "all"
  };
  var SECTION_ICONS = {
    "layout-look": "view_quilt",
    "layout-groups": "reorder",
    "layout-shapes": "crop_portrait",
    "layout-display": "tune",
    "rules": "rule",
    "rules-locks": "lock",
    "item-looks": "movie",
    "colours": "palette",
    "badges-families": "new_releases",
    "badges-windows": "schedule",
    "badges-tmdb": "img:selfhst/svg/tmdb.svg",
    "badges-leaving": "event_busy",
    "server-cache": "storage",
    "server-native": "devices",
    "server-portable": "import_export",
    "server-presets": "bookmarks"
  };
  var TABS = [
    { id: "overview", icon: "dashboard", nameKey: "Overview", descKey: "What new users get today and the state of the tag cache. Users can still change their own look in their Media Tags settings.", lead: "card" },
    { id: "layout", icon: "view_quilt", nameKey: "Layout defaults", shortKey: "Layout", descKey: "The layout, label density, group order, positions and limits new users start with.", lead: "card" },
    { id: "groups", icon: "label", nameKey: "Groups", descKey: "Turn each tag group on or off for new users, and open a group for its server settings.", lead: "card" },
    { id: "rules", icon: "rule", nameKey: "Rules", descKey: "Give some cards a different look by library, type, genre or age rating.", lead: "card" },
    { id: "colours", icon: "palette", nameKey: "Colours", descKey: "The colours of the tags, on the web and in native posters.", lead: "card" },
    { id: "badges", icon: "new_releases", nameKey: "Status badges", shortKey: "Badges", descKey: "Which status badges new users start with, and how long a title counts as new.", lead: "card" },
    { id: "server", icon: "dns", nameKey: "Server", descKey: "The tag data the server keeps, and tags drawn into poster images for other apps.", lead: "card" }
  ];
  var DOCS_URL = "https://n00bcodr.github.io/Jellyfin-Enhanced/enhanced/tags/";
  var DOCS_ANCHORS = { overview: "set-up-your-tags", layout: "layouts", groups: "tag-groups-order-position-limits", rules: "rules-and-locked-items", colours: "tag-styles-and-css", badges: "badges-and-priority", server: "server-side-tag-cache" };
  var SEEDED_KEYS = [
    "QualityTagsEnabled",
    "ShowResolutionTag",
    "ShowSourceTag",
    "ShowEditionTag",
    "EditionTagOrder",
    "ShowRuntimeTag",
    "RuntimeTagOrder",
    "ShowAspectRatioTag",
    "AspectRatioTagOrder",
    "ShowFrameRateTag",
    "FrameRateTagOrder",
    "ShowVersionsTag",
    "VersionsTagOrder",
    "ShowLowQualitySourceTag",
    "ShowDynamicRangeTag",
    "ShowSpecialFormatTag",
    "ShowVideoCodecTag",
    "ShowAudioInfoTag",
    "ResolutionTagOrder",
    "SourceTagOrder",
    "DynamicRangeTagOrder",
    "SpecialFormatTagOrder",
    "VideoCodecTagOrder",
    "AudioInfoTagOrder",
    "GenreTagsEnabled",
    "LanguageTagsEnabled",
    "RatingTagsEnabled",
    "AgeRatingTagsEnabled",
    "StatusTagsEnabled",
    "PeopleTagsEnabled",
    "TagsHideOnHover",
    "QualityTagsPosition",
    "QualityAudioDisplayMode",
    "QualityVideoCodecDisplayMode",
    "QualityHdrDisplayMode",
    "QualityMinimumResolution",
    "QualityHideSdr",
    "SeriesQualityAggregation",
    "GenreTagsPosition",
    "LanguageTagsPosition",
    "RatingTagsPosition",
    "RatingTagsShowCommunity",
    "RatingTagsShowCritic",
    "RatingTagsSources",
    "RatingTagsMinScore",
    "RatingTagsColorByScore",
    "AgeRatingTagsPosition",
    "StatusTagsPosition",
    "StatusTagsJustAdded",
    "StatusTagsNewRelease",
    "StatusTagsTrending",
    "StatusTagsSchedule",
    "StatusTagsMilestones",
    "StatusTagsSeriesStatus",
    "StatusTagsScenes",
    "StatusTagsLeaving",
    "StatusTagsDirectPlay",
    "AwardsTagsEnabled",
    "AwardsTagsPosition",
    "LogoTagsEnabled",
    "LogoTagsPosition",
    "CustomTagsEnabled",
    "CustomTagsPosition",
    "ShowRatingInPlayer",
    "TagLayout",
    "TagLabelDensity",
    "TagScale",
    "TagGap",
    "TagEdgeSpacing",
    "TagLayouts",
    "TagGroupOrder",
    "TagGroupCaps",
    "LanguageTagsShowAudio",
    "LanguageTagsShowSubtitles",
    "LanguageTagsStyle",
    "LanguageTagsCountBadge"
  ];
  var sections = [];
  var esc = (value) => JE.escapeHtml(String(value ?? ""));
  var tx = (value, params) => esc(fmt(value, params));
  var perUserMark = () => `<i class="material-icons je-ta-peruser" role="img" aria-label="${tx("Per-user setting")}" title="${tx("Each user has a personal copy. Existing users keep theirs until you overwrite it.")}">group</i>`;
  var kit = { esc, tx, perUserMark };
  function registerSection(def) {
    if (!def || !def.id || !TABS.some((t) => t.id === def.tab)) throw new Error(`JE admin tags: bad section ${def && def.id}`);
    const at = sections.findIndex((s) => s.id === def.id);
    if (at >= 0) sections.splice(at, 1);
    sections.push(def);
    const tabIndex = (s) => TABS.findIndex((t) => t.id === s.tab);
    sections.sort((a, b) => tabIndex(a) - tabIndex(b) || (a.order || 0) - (b.order || 0));
  }
  function pageFields() {
    const out = /* @__PURE__ */ new Set();
    for (const s of sections) {
      for (const f of s.fields || []) {
        out.add(f.key);
        if (f.orderKey) out.add(f.orderKey);
      }
      for (const key of s.writes || []) out.add(key);
    }
    return out;
  }
  function seedUser(config) {
    const out = {};
    for (const key of SEEDED_KEYS) {
      if (config[key] !== void 0) out[key.charAt(0).toLowerCase() + key.slice(1)] = config[key];
    }
    if (!Array.isArray(out.ratingTagsSources)) {
      out.ratingTagsSources = ["community", "critic"].filter((id) => (id === "community" ? config.RatingTagsShowCommunity : config.RatingTagsShowCritic) !== false);
    }
    out.tagLayoutSettingsVersion = 1;
    out.tagStylePreset = null;
    out.useNativePosterTags = null;
    return out;
  }
  function pageUrl(tab, group) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#/configurationpage?name=${encodeURIComponent(MAIN_PAGE_NAME)}&jeSection=${TAB_ID}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}${group ? `&group=${encodeURIComponent(group)}` : ""}`;
  }
  function mainPageUrl(section, tab) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}#/configurationpage?name=${encodeURIComponent(MAIN_PAGE_NAME)}${section ? `&jeSection=${encodeURIComponent(section)}` : ""}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`;
  }
  var honouredAddress = null;
  function freshTarget() {
    const target = requestedTarget();
    if (!target.tab || window.location.hash === honouredAddress) return { tab: null, group: null };
    honouredAddress = window.location.hash;
    return target;
  }
  function requestedTarget() {
    try {
      const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
      if (params.get("name") === LEGACY_PAGE_NAME) return { tab: params.get("tab"), group: params.get("group") };
      if (params.get("jeSection") === TAB_ID) return { tab: params.get("tab"), group: params.get("group") };
    } catch {
    }
    return { tab: null, group: null };
  }
  var identityStillCurrent = () => false;
  var identityRevision = 0;
  var identityAccount = "|";
  var identityFailedFor = null;
  function identity() {
    try {
      if (!identityStillCurrent()) {
        const client = optionalApiClient();
        const server = () => client && ((typeof client.serverId === "function" ? client.serverId() : client.serverId) || client._serverInfo?.Id);
        const serverId = server();
        const user = client?.getCurrentUserId?.();
        identityAccount = String(serverId || "") + "|" + String(user || "");
        const token = client?.accessToken?.();
        const root = client?.getUrl("/");
        identityStillCurrent = () => optionalApiClient() === client && server() === serverId && client?.getCurrentUserId?.() === user && client?.accessToken?.() === token && client?.getUrl("/") === root;
        identityFailedFor = null;
        identityRevision++;
      }
      return String(identityRevision);
    } catch {
      identityStillCurrent = () => false;
      const client = optionalApiClient();
      if (!identityFailedFor || identityFailedFor.client !== client) {
        identityFailedFor = { client };
        identityRevision++;
      }
      return String(identityRevision);
    }
  }
  var signedIn = () => {
    try {
      return !!optionalApiClient()?.getCurrentUserId?.();
    } catch {
      return false;
    }
  };
  var mount = { active: null };
  var saves = createSaveStore({
    identity,
    isSecret: (key) => sections.some((s) => s.fields?.some((f) => f.key === key && f.secret)),
    tagLook: () => {
      const look = JE.core.tagLook;
      if (!look) throw new TypeError("core/tag-look.js must load before the Media Tags tab saves item looks");
      return look;
    },
    announce: (detail) => {
      document.dispatchEvent(new CustomEvent("je-media-tags-store", { detail }));
    },
    onReset: () => {
      const previous = mount.active;
      if (!previous) return;
      mount.active = null;
      previous.ctx.dispose();
      previous.root.replaceChildren();
      delete previous.root.dataset.tab;
    },
    reportSaveError: (err) => console.error("🪼 Jellyfin Enhanced: could not save the Media Tags settings", err),
    saveDelayMs: SAVE_DELAY_MS
  });
  function askConfirm(text, title) {
    return new Promise((resolve) => {
      try {
        const dialog = dashboard();
        if (dialog && typeof dialog.confirm === "function") {
          dialog.confirm(esc(text).replace(/\n/g, "<br>"), title, (ok) => resolve(!!ok));
          return;
        }
      } catch {
      }
      resolve(window.confirm(`${title}

${text}`));
    });
  }
  var pageDeps = {
    JE: () => JE,
    kit,
    saves,
    sections,
    tabs: TABS,
    seededKeys: SEEDED_KEYS,
    sectionScopes: SECTION_SCOPES,
    sectionIcons: SECTION_ICONS,
    docsUrl: DOCS_URL,
    docsAnchors: DOCS_ANCHORS,
    pluginId: PLUGIN_ID,
    pageFields,
    seedUser,
    pageUrl,
    mainPageUrl,
    freshTarget,
    askConfirm,
    undoMs: UNDO_MS,
    tabStoreKey: TAB_STORE_KEY,
    previewStyleId: PREVIEW_STYLE_ID
  };
  function createPage2(root, config, options) {
    return createPage(pageDeps, root, config, options);
  }
  function onMediaTagsPage() {
    try {
      const name = new URLSearchParams(window.location.hash.split("?")[1] || "").get("name");
      return name === MAIN_PAGE_NAME || name === LEGACY_PAGE_NAME;
    } catch {
      return false;
    }
  }
  function savedTab() {
    let section = null;
    try {
      section = window.sessionStorage.getItem(TAB_STORE_KEY);
    } catch {
    }
    return TAB_IDS.some((id) => id === section) ? section : null;
  }
  async function leaveWithPending() {
    const mark = saves.sessionMark();
    if (!saves.hasPending()) return;
    const ok = await saves.flush();
    if (ok || !saves.sameSession(mark) || onMediaTagsPage()) return;
    const store = saves.store;
    const names = Array.from(new Set((store.failed.length ? store.failed : Array.from(store.values.keys())).map((k) => fieldName(sections, k)))).join(", ");
    const back = await askConfirm(fmt("These Media Tags changes could not be saved: {fields}. Go back to the Media Tags page to retry? They stay waiting there either way.", { fields: names }), fmt("Media Tags changes not saved"));
    if (!back || !saves.sameSession(mark) || onMediaTagsPage()) return;
    window.location.href = pageUrl(savedTab() ?? void 0);
  }
  var lifecycle = createLifecycle({
    mount,
    saves,
    signedIn,
    createPage: createPage2,
    pluginId: PLUGIN_ID,
    tx,
    sectionFiles: SECTION_FILES,
    getConfiguration: (id) => apiClient().getPluginConfiguration(id),
    scriptUrl: (file, query) => apiClient().getUrl(`/JellyfinEnhanced/js/enhanced/admintags/${file}`) + query,
    leaveWithPending,
    freshTarget
  });
  JE.session?.onUserChange?.("admin-tags", (change) => {
    const current = identity();
    if (!change || saves.store.owner !== current || identityAccount !== `${change.serverId || ""}|${change.userId || ""}`) saves.resetSession();
  });
  var core = {
    fmt,
    WORDS,
    TABS,
    SECTION_FILES,
    SEEDED_KEYS,
    MAIN_PAGE_NAME,
    TAB_ID,
    LEGACY_PAGE_NAME,
    PLUGIN_ID,
    sections,
    registerSection,
    pageFields,
    seedUser,
    pageUrl,
    mainPageUrl,
    fieldHtml: (f, config) => fieldHtml(kit, f, config),
    fieldsHtml: (fields, config) => fieldsHtml(kit, fields, config),
    redrawList,
    fieldValue,
    controlValue,
    createPage: createPage2,
    mountTab: lifecycle.mountTab,
    activate: lifecycle.activate,
    holdSaves: saves.holdSaves,
    /** The tab's context once it is built. */
    current: () => mount.active?.ctx || null,
    requestedTarget,
    /** The unsaved edits (tests, diagnostics). */
    pendingState: () => ({ state: saves.store.state, fields: Array.from(saves.store.values.keys()), failed: saves.store.failed.slice() }),
    leaveWithPending
  };
  JE.adminTags = core;
})();
})();
//# sourceMappingURL=admin-tags.js.map
