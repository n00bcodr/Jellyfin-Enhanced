(() => {
"use strict";
(() => {
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
  function cdnUrl(path) {
    const route = host().jeCdnUrl;
    if (typeof route !== "function") throw new ReferenceError("jeCdnUrl is not defined");
    return route(path);
  }

  // client/src/features/media-tags/admin/dom.ts
  function find(scope, selector) {
    const el2 = scope?.querySelector(selector);
    return el2 instanceof HTMLElement ? el2 : null;
  }
  function findAs(scope, selector, type) {
    const el2 = scope?.querySelector(selector);
    return el2 instanceof type ? el2 : null;
  }
  function allAs(scope, selector, type) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el2) => el2 instanceof type) : [];
  }
  function activeElement() {
    const el2 = document.activeElement;
    return el2 instanceof HTMLElement ? el2 : null;
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

  // client/src/features/media-tags/admin/tag-style-contrast.ts
  function rgbaOf(css) {
    const value = String(css || "").trim().toLowerCase();
    const hex = /^#([0-9a-f]{6})$/.exec(value);
    const digits = hex?.[1];
    if (digits) return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: 1 };
    const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (!fn) return null;
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === void 0 ? 1 : Number(fn[4]) };
  }
  function compositeOver(top, under) {
    const mix = (t, u) => Math.round(t * top.a + u * (1 - top.a));
    return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
  }
  function luminance(c) {
    const ch = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  function contrastRatio(text, background) {
    const t = rgbaOf(text), b = rgbaOf(background);
    if (!t || !b) return null;
    const bg = compositeOver(b, { r: 38, g: 38, b: 38 });
    const fg = compositeOver(t, bg);
    const l1 = luminance(fg), l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function contrastLevel(ratio) {
    if (ratio >= 4.5) return { level: "aa", label: "AA" };
    if (ratio >= 3) return { level: "large", label: fmt("AA large only") };
    return { level: "low", label: fmt("Low contrast") };
  }

  // client/src/features/media-tags/admin/tag-styles-model.ts
  var member = (value, key) => value && typeof value === "object" ? Reflect.get(value, key) : void 0;
  var entriesOf = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  var strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  function decodeCatalog(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const groups = {};
    for (const [g, labels] of entriesOf(member(value, "groups"))) {
      groups[g] = (Array.isArray(labels) ? labels : []).flatMap((l) => {
        const key = member(l, "key");
        const name = member(l, "name");
        return typeof key === "string" ? [{ key, name: typeof name === "string" ? name : key }] : [];
      });
    }
    const palettes = {};
    for (const [preset, labels] of entriesOf(member(value, "palettes"))) {
      const out = {};
      for (const [key, entry] of entriesOf(labels)) {
        const p = {};
        for (const f of ["background", "border", "color"]) {
          const v = member(entry, f);
          if (typeof v === "string") p[f] = v;
        }
        out[key] = p;
      }
      palettes[preset] = out;
    }
    const age = (Array.isArray(member(value, "age")) ? strictArray(member(value, "age")) : []).flatMap((a) => {
      const id = member(a, "id");
      return typeof id === "string" ? [{ id, ratings: strings(member(a, "ratings")) }] : [];
    });
    const genreIcons = {};
    for (const [key, icon] of entriesOf(member(value, "genreIcons"))) if (typeof icon === "string") genreIcons[key] = icon;
    const worst = member(member(value, "poster"), "worstContrast");
    return { presets: strings(member(value, "presets")), groups, palettes, age, genreIcons, poster: { worstContrast: typeof worst === "number" && Number.isFinite(worst) ? worst : null } };
  }
  function strictArray(value) {
    return Array.isArray(value) ? value : [];
  }
  var emptyState = (preset = "default") => ({ preset, groupPresets: {}, groups: {}, labels: {} });
  function ownOf(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : void 0;
  }

  // client/src/features/media-tags/admin/tag-styles-editor.ts
  var T = fmt;
  var JE = adminBridge();
  var EDITOR_HTML = `
        <div id="tagStyleEditor" class="je-ts-editor">
            <div class="je-ts-editing-head je-ts-preset-head"><div class="je-ts-section-label" id="tagStylePresetLabel"></div><span class="je-ts-editing-now" id="tagStylePresetNow"></span></div>
            <div id="tagStylePresets" class="je-ts-presets" role="radiogroup" aria-labelledby="tagStylePresetLabel"><div class="je-ta-hint"></div></div>
            <div id="tagStyleTabs" class="je-ts-tabs" role="tablist"></div>
            <label class="je-ts-group-select"><span class="je-ts-section-label" id="tagStyleGroupSelectLabel"></span><select id="tagStyleGroupSelect"></select></label>
            <div id="tagStyleGroupPanel" class="je-ts-group-panel" role="tabpanel">
                <label class="je-ts-group-preset"><span class="je-ts-section-label" id="tagStyleGroupPresetLabel"></span><select id="tagStyleGroupPreset"></select></label>
                <div class="je-ts-editing-head"><div class="je-ts-section-label" id="tagStyleTargetsLabel"></div><span class="je-ts-editing-now" id="tagStyleEditingNow" aria-live="polite"></span>
                    <button type="button" class="je-ts-target-toggle" id="tagStyleTargetToggle" aria-expanded="false" aria-controls="tagStyleTargetBox" hidden></button></div>
                <div class="je-ts-sample" id="tagStyleSample" aria-hidden="true"></div>
                <div id="tagStyleContrast" class="je-ts-contrast" role="status" aria-live="polite"></div>
                <div class="je-ts-target-box" id="tagStyleTargetBox" hidden>
                <p class="je-ts-target-hint" id="tagStyleTargetHint"></p>
                <input id="tagStyleTargetFilter" class="je-ts-target-filter" type="search" autocomplete="off" hidden>
                <div id="tagStyleTargets" class="je-ts-targets" role="radiogroup" aria-labelledby="tagStyleTargetsLabel"></div>
                </div>
                <div id="tagStyleGroupNote" class="je-ts-note"></div>
                <div id="tagStyleRows" class="je-ts-rows"></div>
            </div>
            <button type="button" class="je-ts-preview-toggle" id="tagStylePreviewToggle" aria-expanded="false" aria-controls="tagStylePreview" data-je-info><span class="je-ts-section-label" id="tagStylePreviewLabel"></span><span class="je-ts-preview-toggle-name"></span><span class="material-icons" aria-hidden="true">expand_more</span></button>
            <div id="tagStylePreview" class="je-ts-preview" aria-hidden="true" hidden></div>
        </div>`;
  var GROUPS = [
    { key: "quality", title: T("Quality") },
    { key: "ageRating", title: T("Age Rating") },
    { key: "rating", title: T("Rating") },
    { key: "genre", title: T("Genre") },
    { key: "status", title: T("Status") },
    { key: "language", title: T("Language") },
    { key: "awards", title: T("Awards") },
    { key: "logos", title: T("Logos") },
    { key: "custom", title: T("Custom") }
  ];
  var PRESET_TITLES = {
    default: T("Default"),
    glass: T("Glass"),
    outline: T("Outline"),
    dark: T("Dark"),
    light: T("Light"),
    mono: T("Mono"),
    poster: T("Poster")
  };
  var FIELDS = [["background", T("Background")], ["border", T("Border")], ["text", T("Text")]];
  var IN_SENTENCE = { background: T("background"), border: T("border"), text: T("text"), icon: T("icon") };
  var SWATCHES = ["#1e88e5", "#ef6c00", "#2e7d32", "#546e7a", "#8e24aa", "#ffd166", "#ff6b6b", "#111111", "#ffffff", "#e0e0e0"];
  var OPACITIES = [40, 60, 80, 100];
  var POSTER_NOTE = T("Poster: each tag takes its background from the artwork it sits on (white or black text, whichever reads better). Colours set here stay on top; Default falls back to the artwork. The preview shows a red poster.");
  var NOTES = {
    genre: "Each genre has its own colours (spellings and translations of a genre share them); Text colours the icon. Genres without an icon of their own use Other.",
    status: "Status badges use the same colours on web cards and native posters.",
    language: "Language chips use Background, Border and Text, including per-language colours and Dual/Multi. Flag images keep only their border ring; partial flags keep their dashed outline.",
    logos: "Colours the pill behind a logo, or the name chip a logo without an image shows (Text colours the name).",
    custom: "One target per label of the Custom tag rules above (labels shared by several rules share their colours). The icon takes the text colour."
  };
  var LOGO_SAMPLES = { provider: T("Stream"), company: T("Studio"), text: "HBO" };
  var RATING_SAMPLES = { community: ["star", "8.1"], critic: [null, "85%"], userReview: ["favorite", "9"], imdb: [null, "8.1"], tmdb: [null, "81%"], rtCritic: [null, "92%"], rtAudience: [null, "88%"], metacritic: [null, "74"], letterboxd: [null, "4.1"], trakt: [null, "85%"] };
  var STATUS_SAMPLES = { added: T("Just Added"), newMovie: T("New Movie"), newSeries: T("New Series"), newEpisode: T("New Episode"), trending: T("#{rank} Today", { rank: 3 }) };
  var RATING_IDS = ["community", "critic", "imdb", "tmdb", "rtCritic", "rtAudience", "metacritic", "letterboxd", "trakt"];
  var ALL = "*";
  var LEGACY_GENRE = "genre:genre";
  var TILE_GROUPS = ["genre"];
  var FILTER_MIN = 12;
  var GENRE_SAMPLES = { movie: ["horror", "comedy"], episode: ["animation"] };
  var CONTAINERS = {
    quality: "quality-overlay-container",
    ageRating: "age-rating-overlay-container",
    rating: "rating-overlay-container",
    genre: "genre-overlay-container",
    status: "status-overlay-container",
    language: "language-overlay-container",
    awards: "awards-overlay-container",
    logos: "logo-overlay-container",
    custom: "custom-overlay-container"
  };
  var toHex = (c) => "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  var toCss = (c) => "rgba(" + Math.round(c.r) + ", " + Math.round(c.g) + ", " + Math.round(c.b) + ", " + Math.round(c.a * 1e3) / 1e3 + ")";
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== void 0) n.textContent = text;
    return n;
  }
  var createTagStylesEditor = (root, customLabels = () => [], isCurrent = () => true) => {
    let cat = null;
    let state = emptyState();
    let current = "quality";
    let target = ALL;
    let filter = "";
    let openField = null;
    let targetsOpen = false;
    let previewOpen = false;
    let canvas = null;
    let legacy = null;
    let migrated = null;
    const canvasContext = () => {
      canvas = canvas || document.createElement("canvas").getContext("2d");
      return canvas;
    };
    function parse(css) {
      const direct = rgbaOf(css);
      if (direct) return direct;
      const ctx = canvasContext();
      if (!ctx) return { r: 0, g: 0, b: 0, a: 1 };
      ctx.fillStyle = "#000000";
      ctx.fillStyle = String(css);
      return rgbaOf(ctx.fillStyle) || { r: 0, g: 0, b: 0, a: 1 };
    }
    function parseColour(css) {
      const direct = rgbaOf(css);
      if (direct) return direct;
      const ctx = canvasContext();
      if (!ctx || typeof css !== "string" || !css.trim()) return null;
      ctx.fillStyle = "#000000";
      ctx.fillStyle = css;
      const overBlack = ctx.fillStyle;
      ctx.fillStyle = "#ffffff";
      ctx.fillStyle = css;
      return overBlack === ctx.fillStyle ? rgbaOf(overBlack) : null;
    }
    const norm = (css) => toCss(parse(css));
    const genreIcon = (l) => (cat ? ownOf(cat.genreIcons, l) : void 0) || "theaters";
    const genreGlyph = (l) => el("i", "je-ts-genre-glyph", genreIcon(l));
    const labelsOf = (g) => {
      if (g === "custom") return customLabels().map((l) => ({ key: l, name: l }));
      const labels = ((cat ? ownOf(cat.groups, g) : void 0) || []).slice();
      if (g === "language") {
        for (const key of Object.keys(state.labels).filter((k) => k.startsWith("language:")).map((k) => k.slice(9))) {
          if (!labels.some((l) => l.key === key)) labels.push({ key, name: key.toUpperCase() });
        }
      }
      return labels;
    };
    const labelKey = (g, l) => g + ":" + l;
    const fieldsOf = (g) => g === "language" && target === "flag" ? FIELDS.filter(([f]) => f === "border") : FIELDS;
    const labelColours = (key) => ownOf(state.labels, key);
    const groupColours = (g) => ownOf(state.groups, g);
    const presetOf = (g) => ownOf(state.groupPresets, g) || state.preset;
    function palette(preset, g, l) {
      const pal = (cat ? ownOf(cat.palettes, preset) : void 0) || {};
      const p = ownOf(pal, labelKey(g, l)) || (g === "custom" ? ownOf(pal, labelKey(g, ALL)) : void 0) || {};
      const out = {};
      if (p.background !== void 0) out.background = p.background;
      if (p.border !== void 0) out.border = p.border;
      if (p.color !== void 0) out.text = p.color;
      return out;
    }
    function effective(g, l) {
      const own = labelColours(labelKey(g, l)) || {};
      const shared = groupColours(g) || {};
      const kind = g === "language" && !["flag", "code", "subtitles", "countBadge"].includes(l) ? labelColours(labelKey(g, ["dual", "multi"].includes(l) ? "countBadge" : "code")) || {} : {};
      const pal = palette(presetOf(g), g, l);
      const out = {};
      FIELDS.forEach(([f]) => {
        const v = own[f] || kind[f] || shared[f] || pal[f];
        if (v) out[f] = v;
      });
      return out;
    }
    function targetColours() {
      if (target !== ALL) return effective(current, target);
      const shared = groupColours(current) || {};
      const out = {};
      FIELDS.forEach(([f]) => {
        const values = new Set(labelsOf(current).map((l) => palette(presetOf(current), current, l.key)[f]));
        const only = values.size === 1 ? [...values][0] : void 0;
        const v = shared[f] || only;
        if (v) out[f] = v;
      });
      return out;
    }
    const targetEntry = () => (target === ALL ? groupColours(current) : labelColours(labelKey(current, target))) || {};
    function setField(field, css, live = false) {
      const bag = target === ALL ? state.groups : state.labels;
      const key = target === ALL ? current : labelKey(current, target);
      const o = Object.assign({}, ownOf(bag, key) || {});
      if (css) o[field] = norm(css);
      else delete o[field];
      if (Object.keys(o).length) bag[key] = o;
      else delete bag[key];
      if (live) {
        renderTargets();
        renderContrast();
      } else renderGroup();
      renderPreview();
    }
    function rebuildKeepingFocus(box, build, fallback) {
      const active = activeElement();
      const key = active && box.contains(active) ? active.dataset.tsKey : null;
      build();
      if (!key) return;
      const again = allAs(box, "[data-ts-key]", HTMLElement).find((n) => n.dataset.tsKey === key);
      const next = again && !(again instanceof HTMLButtonElement && again.disabled) ? again : fallback ? fallback(key) : null;
      if (next) next.focus({ preventScroll: true });
    }
    function paint(n, g, c) {
      if (g !== "language" || !n.matches("img.language-flag")) {
        n.style.background = c.background || "";
        n.style.color = c.text || "";
      }
      if (g === "rating" || g === "language" && n.matches("img.language-flag")) {
        const ring = !!c.border && parse(c.border).a > 0;
        n.style.outline = ring ? "1px solid " + c.border : "";
        n.style.outlineOffset = ring ? "-1px" : "";
      } else {
        n.style.borderColor = c.border || "";
      }
      return n;
    }
    function languageSample(label) {
      const count = ["dual", "multi", "countBadge"].includes(label.key);
      const sample = label.key === "subtitles" ? "CC EN" : count ? label.key === "dual" ? T("Dual") : T("Multi") : label.key === "code" ? "EN" : label.key.toUpperCase();
      const n = el("span", "je-ts-chip language-chip " + (count ? "language-count-badge" : "language-code"), sample);
      n.dataset.jeLanguage = count ? "countBadge" : label.key === "subtitles" ? "subtitles" : "flag";
      n.dataset.jeLanguageLabel = count ? label.key === "dual" ? "dual" : "multi" : label.key === "code" || label.key === "subtitles" ? "en" : label.key;
      return n;
    }
    function sourceRatingChip(label) {
      const sample = (ownOf(RATING_SAMPLES, label.key) || [null, ""])[1];
      const id = RATING_IDS.find((r) => r === label.key);
      let n = id ? JE.ratingSources?.chip({ id, value: parseFloat(sample), text: sample, color: null }) ?? null : null;
      if (!n) {
        n = el("span", "rating-tag rating-tag--source");
        n.dataset.jeRatingSource = label.key;
        n.append(el("span", "je-ts-source-name", label.name), el("span", "rating-text", sample));
      }
      n.classList.add("je-ts-chip", "je-ts-rate");
      return n;
    }
    function flagChip(cls) {
      const n = el("img", cls);
      n.src = cdnUrl("flag-icons/flags/4x3/gb.svg");
      n.alt = "";
      return n;
    }
    function chip(g, label, c) {
      let n;
      if (g === "quality") {
        n = el("span", "je-ts-chip je-ts-q quality-overlay-label", label.name);
      } else if (g === "ageRating") {
        n = el("span", "je-ts-chip je-ts-age age-rating-tag", label.name);
      } else if (g === "rating" && !["community", "critic", "userReview"].includes(label.key)) {
        n = sourceRatingChip(label);
      } else if (g === "rating") {
        const [icon, sample] = ownOf(RATING_SAMPLES, label.key) || ["star", "8.1"];
        n = el("span", "je-ts-chip je-ts-rate rating-tag");
        n.appendChild(icon ? el("i", "material-icons je-ts-rate-icon", icon) : el("i", "je-ts-tomato"));
        n.appendChild(document.createTextNode(sample));
      } else if (g === "awards") {
        n = el("div", "awards-tag je-ts-chip je-ts-rate", label.name.includes("250") ? T("Top 250") : label.name);
        n.dataset.jeAward = label.key;
      } else if (g === "genre") {
        n = el("span", "je-ts-chip je-ts-genre genre-tag");
        n.appendChild(genreGlyph(label.key));
      } else if (g === "status") {
        n = el("span", "je-ts-chip je-ts-status status-tag", ownOf(STATUS_SAMPLES, label.key) || label.name);
      } else if (g === "logos") {
        n = el("span", "je-ts-chip je-ts-status je-logo-chip", ownOf(LOGO_SAMPLES, label.key) || label.name);
        n.dataset.jeLogoStyle = label.key;
      } else if (g === "custom") {
        n = el("span", "je-ts-chip je-ts-custom custom-tag", label.name);
      } else if (g === "language" && label.key !== "flag") {
        n = languageSample(label);
      } else {
        n = flagChip("je-ts-chip je-ts-flag language-flag");
      }
      return paint(n, g, c);
    }
    function radio(cls, checked, onClick) {
      const b = el("button", cls + (checked ? " active" : ""));
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(checked));
      b.addEventListener("click", onClick);
      return b;
    }
    const need = (selector) => find(root, selector);
    function renderPresets() {
      const bar = need("#tagStylePresets");
      if (!bar) return;
      rebuildKeepingFocus(bar, () => buildPresets(bar));
      rove(bar, ".je-ts-preset", "aria-checked");
      const now = need("#tagStylePresetNow");
      if (now) now.textContent = ownOf(PRESET_TITLES, state.preset) || state.preset || "";
      const previewToggle = need("#tagStylePreviewToggle");
      if (previewToggle && !previewToggle.onclick) {
        const name = previewToggle.querySelector(".je-ts-preview-toggle-name");
        if (name) name.textContent = T("Movie and episode samples");
        previewToggle.onclick = () => {
          previewOpen = !previewOpen;
          previewToggle.setAttribute("aria-expanded", String(previewOpen));
          const box = need("#tagStylePreview");
          if (box) box.hidden = !previewOpen;
        };
      }
    }
    function rove(box, selector, attr) {
      const items = allAs(box, selector, HTMLElement);
      items.forEach((item) => {
        item.tabIndex = item.getAttribute(attr) === "true" ? 0 : -1;
      });
      const first = items[0];
      if (first && !items.some((item) => item.tabIndex === 0)) first.tabIndex = 0;
      box.onkeydown = (e) => {
        const list = allAs(box, selector, HTMLElement);
        const from = e.target instanceof Element ? e.target.closest(selector) : null;
        const at = list.findIndex((n) => n === from);
        if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
        const back = getComputedStyle(box).direction === "rtl" ? 1 : -1;
        const step = ownOf({ ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }, e.key);
        const next = step ? list[(at + step + list.length) % list.length] : e.key === "Home" ? list[0] : e.key === "End" ? list[list.length - 1] : null;
        if (!next) return;
        e.preventDefault();
        const key = next.dataset.tsKey;
        next.click();
        const again = allAs(box, selector, HTMLElement).find((n) => n.dataset.tsKey === key);
        if (again) again.focus();
      };
    }
    function buildPresets(bar) {
      bar.textContent = "";
      if (!cat) return;
      const age = labelsOf("ageRating").find((l) => l.name === "PG-13") || labelsOf("ageRating")[0];
      cat.presets.forEach((id) => {
        const tile = radio("je-ts-preset", state.preset === id, () => {
          state.preset = id;
          render();
        });
        tile.dataset.preset = id;
        tile.dataset.tsKey = "preset:" + id;
        tile.appendChild(el("span", "je-ts-preset-title", ownOf(PRESET_TITLES, id) || id));
        const mini = el("span", "je-ts-preset-chips");
        mini.appendChild(chip("quality", { key: "4K", name: "4K" }, palette(id, "quality", "4K")));
        mini.appendChild(chip("rating", { key: "community", name: T("Community") }, palette(id, "rating", "community")));
        if (age) mini.appendChild(chip("ageRating", age, palette(id, "ageRating", age.key)));
        tile.appendChild(mini);
        bar.appendChild(tile);
      });
    }
    function renderTabs() {
      const tabs = need("#tagStyleTabs");
      if (!tabs) return;
      rebuildKeepingFocus(tabs, () => {
        tabs.textContent = "";
        GROUPS.forEach((g) => {
          const b = el("button", "je-ts-tab" + (g.key === current ? " active" : ""), g.title);
          b.type = "button";
          b.setAttribute("role", "tab");
          b.setAttribute("aria-selected", String(g.key === current));
          b.dataset.group = g.key;
          b.dataset.tsKey = "tab:" + g.key;
          b.id = "tagStyleTab-" + g.key;
          b.setAttribute("aria-controls", "tagStyleGroupPanel");
          b.addEventListener("click", () => {
            current = g.key;
            target = ALL;
            filter = "";
            renderTabs();
            renderGroup();
          });
          tabs.appendChild(b);
        });
      });
      rove(tabs, ".je-ts-tab", "aria-selected");
      const select = findAs(root, "#tagStyleGroupSelect", HTMLSelectElement);
      if (select) {
        select.innerHTML = GROUPS.map((g) => '<option value="' + g.key + '"' + (g.key === current ? " selected" : "") + ">" + g.title + "</option>").join("");
        select.onchange = () => find(tabs, '.je-ts-tab[data-group="' + select.value + '"]')?.click();
        const label = need("#tagStyleGroupSelectLabel");
        if (label) label.textContent = T("Tag group");
      }
      need("#tagStyleGroupPanel")?.setAttribute("aria-labelledby", "tagStyleTab-" + current);
    }
    function applyFilter() {
      const needle = filter.trim().toLocaleLowerCase();
      allAs(root, "#tagStyleTargets .je-ts-target", HTMLElement).forEach((cell) => {
        const label = cell.dataset.label;
        const name = (cell.getAttribute("aria-label") || "").toLocaleLowerCase();
        cell.hidden = !!needle && label !== ALL && label !== target && !name.includes(needle);
      });
    }
    function onTargetKey(e) {
      const box = e.currentTarget;
      if (!(box instanceof HTMLElement)) return;
      const cells = allAs(box, ".je-ts-target:not([hidden])", HTMLElement);
      const from = e.target instanceof Element ? e.target.closest(".je-ts-target") : null;
      const at = cells.findIndex((c) => c === from);
      if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      const back = getComputedStyle(box).direction === "rtl" ? 1 : -1;
      const step = ownOf({ ArrowLeft: back, ArrowRight: -back, ArrowUp: -1, ArrowDown: 1 }, e.key);
      let next;
      if (step) next = cells[(at + step + cells.length) % cells.length];
      else if (e.key === "Home") next = cells[0];
      else if (e.key === "End") next = cells[cells.length - 1];
      else return;
      e.preventDefault();
      next?.click();
    }
    function renderTargets() {
      const box = need("#tagStyleTargets");
      if (!box) return;
      const focused = box.contains(document.activeElement);
      box.textContent = "";
      box.onkeydown = onTargetKey;
      const tiles = TILE_GROUPS.includes(current);
      box.classList.toggle("je-ts-targets-tiles", tiles);
      const toggle = need("#tagStyleTargetToggle");
      if (toggle) {
        toggle.hidden = false;
        toggle.textContent = targetsOpen ? T("Close tag list") : T("Choose a tag");
        toggle.setAttribute("aria-expanded", String(targetsOpen));
        toggle.onclick = () => {
          targetsOpen = !targetsOpen;
          renderTargets();
          if (targetsOpen) find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus();
        };
      }
      const targetBox = need("#tagStyleTargetBox");
      if (targetBox) targetBox.hidden = !targetsOpen;
      const hint = need("#tagStyleTargetHint");
      if (hint) hint.textContent = T("Choose a tag to change only its colours.");
      const search = findAs(root, "#tagStyleTargetFilter", HTMLInputElement);
      if (search) {
        search.hidden = labelsOf(current).length <= FILTER_MIN;
        const filterKey = current === "genre" ? "Find a genre" : "Find a tag";
        search.placeholder = T(filterKey);
        search.setAttribute("aria-label", T(filterKey));
        search.value = search.hidden ? "" : filter;
        search.oninput = () => {
          filter = search.value;
          applyFilter();
        };
      }
      const now = need("#tagStyleEditingNow");
      if (now) {
        const groupTitle = GROUPS.find((g) => g.key === current)?.title || current;
        const label = target === ALL ? null : labelsOf(current).find((l) => l.key === target);
        now.replaceChildren(el("span", "je-ts-now-group", groupTitle + " · "), document.createTextNode(label ? label.name : T("Whole group")));
      }
      const all = radio("je-ts-target je-ts-target-all" + (groupColours(current) ? " changed" : ""), target === ALL, () => {
        target = ALL;
        renderGroup();
      });
      all.textContent = T("Whole group");
      all.dataset.label = ALL;
      box.appendChild(all);
      labelsOf(current).forEach((label) => {
        const changed = !!labelColours(labelKey(current, label.key));
        const cell = radio("je-ts-target" + (changed ? " changed" : ""), target === label.key, () => {
          target = label.key;
          renderGroup();
        });
        cell.dataset.label = label.key;
        cell.title = current === "ageRating" ? T("Applies to: {ratings}", { ratings: (cat?.age.find((a) => a.id === label.key)?.ratings || []).join(", ") }) : label.name;
        cell.setAttribute("aria-label", current === "ageRating" ? T("{name} board", { name: label.name }) : label.name);
        cell.appendChild(chip(current, label, effective(current, label.key)));
        if (tiles) cell.appendChild(el("span", "je-ts-target-name", label.name));
        box.appendChild(cell);
      });
      applyFilter();
      let selected = null;
      allAs(box, ".je-ts-target", HTMLElement).forEach((cell) => {
        const on = cell.getAttribute("aria-checked") === "true";
        cell.tabIndex = on ? 0 : -1;
        if (on) selected = cell;
      });
      const chosen = selected || find(box, ".je-ts-target");
      if (chosen) chosen.tabIndex = 0;
      if (focused && chosen) chosen.focus();
      if (hint) {
        const count = labelsOf(current).length;
        hint.textContent = T("Choose a tag to change only its colours.") + (targetsOpen && box.scrollHeight > box.clientHeight + 2 ? " " + T("{count} tags; scroll for more.", { count: Number(count) }) : "");
      }
      if (chosen && box.scrollHeight > box.clientHeight) {
        const top = chosen.offsetTop - box.offsetTop;
        if (top < box.scrollTop || top + chosen.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8);
      }
    }
    function renderRows() {
      const rows = need("#tagStyleRows");
      if (!rows) return;
      rebuildKeepingFocus(rows, () => buildRows(rows), (key) => {
        const field = key.split(":")[0];
        const row = allAs(rows, ".je-ts-field-row", HTMLElement).find((r) => r.dataset.field === field);
        return row ? find(row, "button:not([disabled]), input") : null;
      });
    }
    function buildRows(rows) {
      rows.textContent = "";
      const colours = targetColours();
      const own = targetEntry();
      const shared = target === ALL ? {} : groupColours(current) || {};
      fieldsOf(current).forEach(([field, name]) => {
        const shownColour = colours[field];
        const varies = !shownColour;
        const c = parse(shownColour || "rgba(0, 0, 0, 0)");
        const alpha = c.a > 0 && !varies ? c.a : 1;
        const shownName = current === "genre" && field === "text" ? T("Icon") : name;
        const sentenceName = (current === "genre" && field === "text" ? IN_SENTENCE.icon : ownOf(IN_SENTENCE, field)) || "";
        const row = el("div", "je-ts-field-row");
        row.dataset.field = field;
        const head = el("div", "je-ts-field-head");
        head.appendChild(el("span", "je-ts-row-name", shownName));
        const now = el("span", "je-ts-swatch je-ts-swatch-current" + (varies ? " je-ts-swatch-varies" : ""));
        if (shownColour) now.style.setProperty("--je-ts-swatch", shownColour);
        now.setAttribute("aria-hidden", "true");
        head.appendChild(now);
        const from = own[field] ? T("set here") : shared[field] ? T("from the group") : T("from the preset");
        head.appendChild(el("span", "je-ts-value", varies ? T("Varies by label") : T("{hex} · {percent}% · {from}", { hex: toHex(c), percent: Math.round(c.a * 100), from })));
        const open = openField === field;
        const bodyId = "tagStyleField-" + field;
        const edit = el("button", "je-ts-edit", open ? T("Done") : T("Change"));
        edit.type = "button";
        edit.setAttribute("aria-expanded", String(open));
        edit.setAttribute("aria-controls", bodyId);
        edit.setAttribute("aria-label", T(open ? "Done changing {name}" : "Change {name}", { name: sentenceName }));
        edit.dataset.tsKey = field + ":edit";
        edit.addEventListener("click", () => {
          openField = open ? null : field;
          renderRows();
        });
        head.appendChild(edit);
        const reset = el("button", "je-ts-reset", T("Reset"));
        reset.type = "button";
        reset.disabled = !own[field];
        reset.dataset.tsKey = field + ":reset";
        reset.setAttribute("aria-label", T("Reset {name}", { name: sentenceName }));
        reset.title = target === ALL ? T("Back to the preset colour") : T("Back to the group or preset colour");
        reset.addEventListener("click", () => setField(field, null));
        head.appendChild(reset);
        row.appendChild(head);
        const body = el("div", "je-ts-field-body");
        body.id = bodyId;
        body.hidden = !open;
        body.setAttribute("role", "group");
        body.setAttribute("aria-label", shownName);
        const list = el("div", "je-ts-swatches");
        SWATCHES.forEach((hex) => {
          const b = el("button", "je-ts-swatch");
          b.type = "button";
          b.style.setProperty("--je-ts-swatch", hex);
          b.setAttribute("aria-label", T("{name} {hex}", { name, hex }));
          b.dataset.tsKey = field + ":swatch:" + hex;
          b.title = hex;
          const ownColour = own[field];
          const picked = !!ownColour && toHex(parse(ownColour)) === hex;
          if (picked) b.classList.add("active");
          b.setAttribute("aria-pressed", String(picked));
          b.addEventListener("click", () => setField(field, toCss(Object.assign(parse(hex), { a: alpha }))));
          list.appendChild(b);
        });
        const any = el("input");
        any.type = "color";
        any.className = "je-ts-any";
        any.value = toHex(c);
        any.setAttribute("aria-label", T("Any {name} colour", { name: ownOf(IN_SENTENCE, field) || field }));
        any.dataset.tsKey = field + ":any";
        any.addEventListener("input", () => setField(field, toCss(Object.assign(parse(any.value), { a: alpha })), true));
        any.addEventListener("change", () => setField(field, toCss(Object.assign(parse(any.value), { a: alpha }))));
        list.appendChild(any);
        body.appendChild(list);
        const opacityRow = el("div", "je-ts-opacity-row");
        opacityRow.appendChild(el("span", "je-ts-opacity-label", T("Opacity")));
        const opacity = el("div", "je-ts-opacity");
        opacity.setAttribute("role", "group");
        opacity.setAttribute("aria-label", T("{name} opacity", { name }));
        OPACITIES.forEach((pct) => {
          const on = !varies && Math.round(c.a * 100) === pct;
          const b = el("button", "je-ts-pill je-ts-opacity-pill" + (on ? " active" : ""), pct + "%");
          b.type = "button";
          b.setAttribute("aria-pressed", String(on));
          b.dataset.tsKey = field + ":opacity:" + pct;
          b.disabled = varies;
          if (varies) b.title = T("Pick a colour first");
          b.addEventListener("click", () => setField(field, toCss(Object.assign({}, c, { a: pct / 100 }))));
          opacity.appendChild(b);
        });
        opacityRow.appendChild(opacity);
        body.appendChild(opacityRow);
        if (varies) body.appendChild(el("span", "je-ts-opacity-note", T("Choose a colour to set its opacity")));
        row.appendChild(body);
        rows.appendChild(row);
      });
    }
    function posterContrast(label) {
      if (presetOf(current) !== "poster" || current === "language" && label.key === "flag") return null;
      const own = labelColours(labelKey(current, label.key)) || {};
      const shared = groupColours(current) || {};
      const text = own.text || shared.text;
      const background = own.background || shared.background;
      if (text && background) return null;
      if (!text && !background) return cat?.poster.worstContrast || 4.5;
      const normalise = JE.tagPosterColours?.normalise;
      if (typeof normalise !== "function") return 1;
      let worst = 21;
      for (let hue = 0; hue < 360; hue += 10) {
        for (const [s, l] of [[1, 0.15], [1, 0.3], [1, 0.5], [0.6, 0.7], [1, 0.85]]) {
          const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(hue / 60 % 2 - 1)), m = l - c / 2;
          const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
          const band = normalise([Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]);
          const css = (v) => "rgb(" + v.join(", ") + ")";
          const ratio = contrastRatio(text || css(band.text), background || css(band.background));
          if (ratio !== null) worst = Math.min(worst, ratio);
        }
      }
      return worst;
    }
    function renderContrast() {
      const box = need("#tagStyleContrast");
      if (!box) return;
      box.textContent = "";
      if (current === "language" && target === "flag") return;
      let worst = null;
      let sampled = false;
      const candidates = target === ALL ? labelsOf(current) : [{ key: target }];
      for (const label of candidates) {
        let ratio = posterContrast(label);
        const poster = ratio !== null;
        if (poster) sampled = true;
        else {
          const c = effective(current, label.key);
          ratio = contrastRatio(c.text, c.background);
        }
        if (ratio !== null && (!worst || ratio < worst.ratio)) worst = { ratio, name: label.name, key: label.key, poster };
      }
      const found = worst;
      if (!found) return;
      const grade = contrastLevel(found.ratio);
      if (target === ALL && grade.level !== "low") return;
      let ratioText = found.ratio.toFixed(1);
      try {
        ratioText = new Intl.NumberFormat(JE.core?.mediaLanguage?.uiLocale?.() || void 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(found.ratio);
      } catch {
      }
      const badge = el("span", "je-ts-contrast-badge je-ts-contrast-" + grade.level, grade.label + " · " + ratioText + ":1");
      badge.dataset.level = grade.level;
      if (sampled) badge.dataset.poster = found.poster ? "worst" : "fixed";
      box.appendChild(badge);
      const hint = target === ALL ? T("Lowest in the group ({name}): text over background, on a dark poster", { name: String(found.name) }) : T("Text over background, on a dark poster");
      box.appendChild(el("span", "je-ts-contrast-hint", !sampled ? hint : found.poster ? T("Worst case over any artwork: Poster takes each tag's colours from the poster it sits on, so this is the lowest contrast the poster colours can give") : T("{hint}. Its colours are all set here; tags without their own take them from the poster they sit on", { hint })));
      if (target === ALL && found.key) {
        const inspect = el("button", "je-ts-inspect", T("Inspect {name}", { name: String(found.name) }));
        inspect.type = "button";
        inspect.addEventListener("click", () => {
          target = found.key;
          targetsOpen = true;
          renderGroup();
          find(root, '#tagStyleTargets .je-ts-target[tabindex="0"]')?.focus();
        });
        box.appendChild(inspect);
      }
    }
    function renderSample() {
      const box = need("#tagStyleSample");
      if (!box) return;
      box.textContent = "";
      const labels = labelsOf(current);
      let label = target === ALL ? void 0 : labels.find((l) => l.key === target);
      let weak = false;
      if (!label) {
        let low = null;
        for (const l of labels) {
          const c = effective(current, l.key);
          const ratio = contrastRatio(c.text, c.background);
          if (ratio !== null && (!low || ratio < low.ratio)) low = { ratio, l };
        }
        const lowest = low;
        weak = !!lowest && contrastLevel(lowest.ratio).level === "low";
        const typical = ownOf({ ageRating: "PG-13", quality: "1080p" }, current);
        label = weak && lowest ? lowest.l : typical && labels.find((l) => l.name === typical) || labels[0];
      }
      if (!label) return;
      box.appendChild(chip(current, label, effective(current, label.key)));
      box.appendChild(el("span", "je-ts-sample-note", target !== ALL ? T("Editing this tag") : T(weak ? "Lowest-contrast sample" : "Sample tag")));
    }
    function renderGroupPreset() {
      const select = findAs(root, "#tagStyleGroupPreset", HTMLSelectElement);
      if (!select || !cat) return;
      const label = need("#tagStyleGroupPresetLabel");
      if (label) label.textContent = T("Preset for this group");
      select.setAttribute("aria-labelledby", "tagStyleGroupPresetLabel");
      select.innerHTML = '<option value="">' + T("Same as the design ({name})", { name: ownOf(PRESET_TITLES, state.preset) || state.preset }) + "</option>" + cat.presets.map((id) => '<option value="' + id + '">' + (ownOf(PRESET_TITLES, id) || id) + "</option>").join("");
      select.value = ownOf(state.groupPresets, current) || "";
      select.onchange = () => {
        if (select.value) state.groupPresets[current] = select.value;
        else delete state.groupPresets[current];
        render();
      };
    }
    function renderGroup() {
      renderGroupPreset();
      renderTargets();
      const noteKey = ownOf(NOTES, current);
      const note = noteKey ? T(noteKey) : "";
      const noteBox = need("#tagStyleGroupNote");
      if (noteBox) noteBox.textContent = [presetOf(current) === "poster" && (current !== "language" || target !== "flag") ? POSTER_NOTE : "", note].filter(Boolean).join(" ");
      renderRows();
      renderContrast();
      renderSample();
    }
    function webModel() {
      const web = (c) => ({ background: c.background, border: c.border, color: c.text });
      const map = (g) => {
        const out = {};
        labelsOf(g).forEach((l) => {
          out[l.key] = web(effective(g, l.key));
        });
        return out;
      };
      return {
        quality: map("quality"),
        age: labelsOf("ageRating").map((l) => Object.assign(
          { ratings: (cat?.age.find((a) => a.id === l.key)?.ratings || []).slice() },
          web(effective("ageRating", l.key))
        )),
        rating: map("rating"),
        genre: map("genre"),
        status: map("status"),
        awards: map("awards"),
        custom: Object.assign({ "*": web(effective("custom", ALL)) }, map("custom")),
        language: web(effective("language", "code")),
        languageLabels: Object.fromEntries(labelsOf("language").map(({ key }) => [key, ["flag", "code", "subtitles", "countBadge"].includes(key) ? web(effective("language", key)) : web(labelColours(labelKey("language", key)) || {})])),
        logos: map("logos")
      };
    }
    function productionChip(g, label, inline) {
      let n;
      if (g === "quality") {
        n = el("div", "quality-overlay-label je-ts-chip je-ts-q", label.name);
        n.dataset.quality = label.key;
      } else if (g === "ageRating") {
        n = el("div", "age-rating-tag je-ts-chip je-ts-age", label.name);
        n.setAttribute("rating", label.name);
      } else if (g === "rating" && !["community", "critic", "userReview"].includes(label.key)) {
        n = sourceRatingChip(label);
      } else if (g === "rating") {
        const [icon, sample] = ownOf(RATING_SAMPLES, label.key) || ["star", "8.1"];
        const kind = ownOf({ community: "rating-tag-tmdb", critic: "rating-tag-critic", userReview: "rating-tag-userreview je-userreview-tag" }, label.key) || "rating-tag--source";
        n = el("div", "rating-tag " + kind + " je-ts-chip je-ts-rate");
        if (label.key === "community") n.appendChild(el("i", "material-icons rating-star-icon je-ts-rate-icon", icon ?? void 0));
        else if (label.key === "userReview") {
          const wrap = el("span", "je-userreview-icon je-ts-rate-icon");
          wrap.appendChild(el("i", "material-icons je-ts-rate-icon", icon ?? void 0));
          n.appendChild(wrap);
        } else if (label.key === "critic") n.appendChild(el("i", "rating-tomato-icon fresh je-ts-tomato"));
        else {
          n.dataset.jeRatingSource = label.key;
          n.appendChild(el("span", "je-rating-source-logo", label.name));
        }
        n.appendChild(el("span", "rating-text", sample));
      } else if (g === "awards") {
        n = el("div", "awards-tag je-ts-chip je-ts-rate", label.name.includes("250") ? T("Top 250") : label.name);
        n.dataset.jeAward = label.key;
      } else if (g === "genre") {
        n = el("div", "genre-tag je-ts-chip je-ts-genre");
        n.dataset.jeGenre = label.key;
        n.title = label.name;
        n.appendChild(genreGlyph(label.key));
      } else if (g === "status") {
        n = el("div", "status-tag status-tag--" + label.key + " je-ts-chip je-ts-status");
        n.dataset.jeStatus = label.key;
        if (label.key === "trending") {
          const [before = "", after = ""] = T("#{rank} Today", { rank: "" }).split("");
          const hash = before.endsWith("#") ? "#" : "";
          n.append(before.slice(0, before.length - hash.length), el("span", "status-tag-rank", hash + "3"), after);
        } else n.textContent = ownOf(STATUS_SAMPLES, label.key) || label.name;
      } else if (g === "logos") {
        n = el("span", "je-logo-chip je-ts-chip je-ts-status", ownOf(LOGO_SAMPLES, label.key) || label.name);
        n.dataset.jeLogoStyle = label.key;
      } else if (g === "custom") {
        n = el("div", "custom-tag je-ts-chip je-ts-custom");
        n.dataset.jeCustom = label.key;
        n.appendChild(el("span", "custom-tag-text", label.name));
      } else if (g === "language" && label.key !== "flag") {
        n = languageSample(label);
      } else {
        n = flagChip("language-flag je-ts-chip je-ts-flag");
        n.dataset.lang = "gb";
      }
      return inline ? paint(n, g, effective(g, label.key)) : n;
    }
    function card(cls, title, corners, inline) {
      const n = el("div", "je-ts-card " + cls);
      const art = el("div", "je-ts-art");
      Object.keys(corners).forEach((corner) => {
        const stack = el("div", "je-ts-corner je-ts-corner-" + corner);
        let box = null;
        (ownOf(corners, corner) || []).forEach(([g, l]) => {
          const label = labelsOf(g).find((x) => x.key === l || x.name === l);
          if (!label) return;
          if (!box || box.dataset.group !== g) {
            box = el("div", (ownOf(CONTAINERS, g) || "undefined") + " je-ts-corner-group");
            box.dataset.group = g;
            stack.appendChild(box);
          }
          box.appendChild(productionChip(g, label, inline));
        });
        art.appendChild(stack);
      });
      n.appendChild(art);
      n.appendChild(el("div", "je-ts-card-title", title));
      return n;
    }
    function renderPreview() {
      const box = need("#tagStylePreview");
      if (!box) return;
      box.textContent = "";
      const build = JE.tagStyles?.buildCss;
      const generate = typeof build === "function" ? build : null;
      box.dataset.styles = generate ? "generated" : "inline";
      if (generate) {
        const sheet = el("style");
        sheet.id = "tagStylePreviewCss";
        sheet.textContent = generate(webModel(), "#tagStylePreview");
        box.appendChild(sheet);
      }
      const custom = labelsOf("custom").slice(0, 2).map((l) => ["custom", l.key]);
      const genres = (list) => list.map((l) => ["genre", l]);
      const movieQuality = [["quality", "4K"], ["quality", "Dolby Vision"], ["quality", "ATMOS"]];
      const movieStatus = [["status", "trending"]];
      const episodeStatus = [["status", "newEpisode"]];
      box.appendChild(card("je-ts-card-movie", T("Movie"), {
        tl: movieQuality.concat(custom),
        tr: movieStatus.concat(genres(GENRE_SAMPLES.movie)),
        bl: [["language", "flag"]],
        br: [["rating", "critic"], ["rating", "community"], ["ageRating", "PG-13"]]
      }, !generate));
      box.appendChild(card("je-ts-card-episode", T("Episode"), {
        tl: [["quality", "1080p"], ["quality", "HEVC"]],
        tr: episodeStatus.concat(genres(GENRE_SAMPLES.episode)),
        bl: [["language", "flag"]],
        br: [["rating", "userReview"], ["ageRating", "R"]]
      }, !generate));
    }
    function render() {
      if (!cat) return;
      renderPresets();
      renderTabs();
      renderGroup();
      renderPreview();
    }
    function readColours(o, textKey) {
      if (!o || typeof o !== "object") return null;
      const out = {};
      for (const [f, k] of [["background", "background"], ["border", "border"], ["text", textKey]]) {
        const v = Reflect.get(o, k);
        if (typeof v === "string" && v) out[f] = norm(v);
      }
      return Object.keys(out).length ? out : null;
    }
    function migrateV1(doc) {
      state = emptyState();
      for (const [section, g] of [["quality", "quality"], ["age", "ageRating"], ["rating", "rating"], ["genre", "genre"]]) {
        const entries = section === "genre" ? { genre: doc.genre } : doc[section];
        if (!entries || typeof entries !== "object") continue;
        for (const [l, o] of Object.entries(entries)) {
          if (section !== "genre" && !labelsOf(g).some((x) => x.key === l) || !labelsOf(g).length || g === "rating" && l === "userReview" || !o || typeof o !== "object") continue;
          const stored = {};
          for (const [f, k] of [["background", "background"], ["border", "border"], ["text", "color"]]) {
            const raw = Reflect.get(o, k);
            const c = (g !== "rating" || f !== "border") && typeof raw === "string" ? parseColour(raw) : null;
            if (c) stored[f] = toCss(c);
          }
          if (!Object.keys(stored).length) continue;
          const builtin = palette("default", g, section === "genre" ? labelsOf(g)[0]?.key ?? "" : l);
          const out = {};
          fieldsOf(g).forEach(([f]) => {
            if (g === "rating" && f === "border") return;
            const v = stored[f] || builtin[f];
            if (v) out[f] = v;
          });
          if (section === "genre") state.groups.genre = out;
          else state.labels[labelKey(g, l)] = out;
        }
      }
    }
    function migrateLoaded(json, doc) {
      migrateV1(doc);
      migrated = { from: json + "|default", to: serialize() + "|" + state.preset };
    }
    function load(jsonValue, presetValue) {
      const json = jsonValue ? String(jsonValue) : "";
      const preset = typeof presetValue === "string" ? presetValue : String(presetValue ?? "");
      state = emptyState(ownOf(PRESET_TITLES, preset) ? preset : "default");
      if (!GROUPS.some((g) => g.key === current)) current = "quality";
      if (target !== ALL && !labelsOf(current).some((l) => l.key === target)) target = ALL;
      legacy = null;
      migrated = null;
      try {
        const p = json ? JSON.parse(json) : {};
        if (p && typeof p === "object" && Reflect.get(p, "v") === 2) {
          const groupPresets = Reflect.get(p, "groupPresets");
          for (const [g, value] of Object.entries(groupPresets && typeof groupPresets === "object" ? groupPresets : {})) {
            if (GROUPS.some((x) => x.key === g) && typeof value === "string" && ownOf(PRESET_TITLES, value)) state.groupPresets[g] = value;
          }
          const groups = Reflect.get(p, "groups");
          for (const [g, value] of Object.entries(groups && typeof groups === "object" ? groups : {})) {
            const c = readColours(value, "text");
            if (c) state.groups[g] = c;
          }
          const labels = Reflect.get(p, "labels");
          for (const [k, value] of Object.entries(labels && typeof labels === "object" ? labels : {})) {
            const c = readColours(value, "text");
            if (c) state.labels[k] = c;
          }
          const legacyGenre = labelColours(LEGACY_GENRE);
          if (legacyGenre) {
            delete state.labels[LEGACY_GENRE];
            state.groups.genre = Object.assign({}, groupColours("genre"), legacyGenre);
            migrated = { from: json + "|" + state.preset, to: serialize() + "|" + state.preset };
          }
        } else if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length) {
          const doc = Object.fromEntries(Object.entries(p));
          state.preset = "default";
          if (cat) migrateLoaded(json, doc);
          else legacy = { json, doc };
        }
      } catch {
      }
      if (!cat) {
        const client = apiClient();
        client.ajax({ type: "GET", url: client.getUrl("JellyfinEnhanced/tag-styles/catalog"), dataType: "json" }).then((answer) => {
          if (!isCurrent()) return;
          const decoded = decodeCatalog(answer);
          if (!decoded) throw new TypeError("The Tag Styles catalog is not an object");
          cat = decoded;
          if (legacy) {
            const l = legacy;
            legacy = null;
            migrateLoaded(l.json, l.doc);
          }
          render();
        }).catch(() => {
          if (!isCurrent()) return;
          const presets = need("#tagStylePresets");
          if (presets) presets.textContent = T("Could not load the tag list.");
        });
      }
      render();
    }
    function snapshot() {
      const now = serialize() + "|" + state.preset;
      return migrated && now === migrated.to ? migrated.from : now;
    }
    function canonical(map) {
      const out = {};
      Object.keys(map).sort().forEach((key) => {
        const c = {};
        const entry = ownOf(map, key) || {};
        FIELDS.forEach(([f]) => {
          const v = entry[f];
          if (v) c[f] = v;
        });
        out[key] = c;
      });
      return out;
    }
    function serialize() {
      if (legacy) return legacy.json;
      if (!Object.keys(state.groupPresets).length && !Object.keys(state.groups).length && !Object.keys(state.labels).length) return "";
      const out = { v: 2, preset: state.preset };
      if (Object.keys(state.groupPresets).length) out.groupPresets = Object.fromEntries(Object.keys(state.groupPresets).sort().map((g) => [g, state.groupPresets[g]]));
      if (Object.keys(state.groups).length) out.groups = canonical(state.groups);
      if (Object.keys(state.labels).length) out.labels = canonical(state.labels);
      return JSON.stringify(out);
    }
    return {
      load,
      serialize,
      snapshot,
      settings: () => ({ preset: state.preset }),
      refreshLabels() {
        if (current === "custom" && target !== ALL && !labelsOf("custom").some((l) => l.key === target)) target = ALL;
        render();
      }
    };
  };
  var A = JE.adminTags = JE.adminTags || {};
  A.EDITOR_HTML = EDITOR_HTML;
  A.createTagStylesEditor = createTagStylesEditor;
  A.tagStyleContrast = { rgbaOf, compositeOver, luminance, contrastRatio, contrastLevel };
})();
})();
//# sourceMappingURL=tag-styles-editor.js.map
