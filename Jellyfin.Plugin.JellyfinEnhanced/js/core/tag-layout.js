(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function publishSharedModules(modules) {
    const JE = window.JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ?? (JE.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/media-tags/layout/layout-rules.ts
  var layout_rules_exports = {};
  __export(layout_rules_exports, {
    DEFAULT_CAPS: () => DEFAULT_CAPS,
    DEFAULT_ORDER: () => DEFAULT_ORDER,
    DEFAULT_PROFILES: () => DEFAULT_PROFILES,
    EDGE_SPACINGS: () => EDGE_SPACINGS,
    ENABLED_SETTING: () => ENABLED_SETTING,
    GROUPS: () => GROUPS,
    LAYOUTS: () => LAYOUTS,
    LAYOUT_SLOTS: () => LAYOUT_SLOTS,
    MAX_CAP: () => MAX_CAP,
    POSITION_SETTINGS: () => POSITION_SETTINGS,
    POSITION_TO_SLOT: () => POSITION_TO_SLOT,
    RECOMMENDED_SHAPES: () => RECOMMENDED_SHAPES,
    SHAPES: () => SHAPES,
    SLOT_TO_POSITION: () => SLOT_TO_POSITION,
    TAG_GAPS: () => TAG_GAPS,
    TAG_SCALES: () => TAG_SCALES,
    hasOwn: () => hasOwn,
    isLayout: () => isLayout,
    isLegacySettings: () => isLegacySettings,
    lookKeyOf: () => lookKeyOf,
    lookSettings: () => lookSettings,
    normalizeGroup: () => normalizeGroup,
    normalizeGroupCaps: () => normalizeGroupCaps,
    normalizeLayout: () => normalizeLayout,
    normalizeSettings: () => normalizeSettings,
    pick: () => pick,
    positionSlot: () => positionSlot,
    promoteLegacySettings: () => promoteLegacySettings,
    readCap: () => readCap,
    readEdge: () => readEdge,
    readGap: () => readGap,
    readOrder: () => readOrder,
    readProfile: () => readProfile,
    readScale: () => readScale,
    readShapeLook: () => readShapeLook,
    readShapeOverrides: () => readShapeOverrides,
    shapesToWire: () => shapesToWire,
    singleChipGroup: () => singleChipGroup,
    validSlots: () => validSlots,
    withShape: () => withShape
  });
  var hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function isLayout(value) {
    return LAYOUTS.some((layout2) => layout2 === value);
  }
  var DEFAULT_ORDER = ["status", "quality", "rating", "ageRating", "language", "genre", "awards", "logos", "custom"];
  var GROUPS = new Set(DEFAULT_ORDER);
  var LAYOUT_SLOTS = withoutPrototype({
    corners: ["tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br", "off"],
    bands: ["top", "bottom", "off"],
    caption: ["poster", "caption", "off"],
    summary: ["pill", "hover", "off"],
    minimal: ["top", "dots", "corner", "hover", "off"]
  });
  var LAYOUTS = ["corners", "bands", "caption", "summary", "minimal"];
  var DEFAULT_PROFILES = {
    bands: { quality: "bottom", genre: "off", language: "bottom", rating: "bottom", ageRating: "top", status: "top", awards: "bottom", logos: "top", custom: "bottom" },
    caption: { quality: "caption", genre: "off", language: "caption", rating: "caption", ageRating: "caption", status: "poster", awards: "caption", logos: "caption", custom: "caption" },
    summary: { quality: "pill", genre: "hover", language: "hover", rating: "pill", ageRating: "hover", status: "pill", awards: "hover", logos: "hover", custom: "hover" },
    minimal: { quality: "dots", genre: "hover", language: "hover", rating: "corner", ageRating: "hover", status: "top", awards: "hover", logos: "hover", custom: "hover" }
  };
  var SHAPES = ["landscape", "list"];
  var RECOMMENDED_SHAPES = {
    landscape: {
      layout: "bands",
      density: "compact",
      caps: null,
      slots: { status: "top", ageRating: "top", quality: "bottom", rating: "bottom", language: "off", genre: "off", custom: "off" }
    },
    list: {
      layout: "corners",
      density: "compact",
      caps: { quality: 2, status: 2, rating: 2 },
      slots: { quality: "tl", status: "tr", rating: "br", ageRating: "off", language: "off", genre: "off", custom: "off" }
    }
  };
  var EDGE_SPACINGS = withoutPrototype({ default: 6, tight: 3, flush: 0 });
  var DEFAULT_CAPS = { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 };
  var MAX_CAP = 10;
  var TAG_SCALES = { smaller: 0.85, default: 1, larger: 1.15, largest: 1.3 };
  var TAG_GAPS = { tight: 0.75, default: 1, roomy: 1.5 };
  function readScale(value) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    return hasOwn(TAG_SCALES, key) ? key : null;
  }
  function readGap(value) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    return hasOwn(TAG_GAPS, key) ? key : null;
  }
  var POSITION_SETTINGS = {
    quality: { userKey: "qualityTagsPosition", pluginKey: "QualityTagsPosition", fallback: "top-left" },
    genre: { userKey: "genreTagsPosition", pluginKey: "GenreTagsPosition", fallback: "top-right" },
    language: { userKey: "languageTagsPosition", pluginKey: "LanguageTagsPosition", fallback: "bottom-left" },
    rating: { userKey: "ratingTagsPosition", pluginKey: "RatingTagsPosition", fallback: "bottom-right" },
    ageRating: { userKey: "ageRatingTagsPosition", pluginKey: "AgeRatingTagsPosition", fallback: "bottom-right" },
    awards: { userKey: "awardsTagsPosition", pluginKey: "AwardsTagsPosition", fallback: "top-left" },
    status: { userKey: "statusTagsPosition", pluginKey: "StatusTagsPosition", fallback: "top-right" },
    logos: { userKey: "logoTagsPosition", pluginKey: "LogoTagsPosition", fallback: "bottom-left" },
    custom: { userKey: "customTagsPosition", pluginKey: "CustomTagsPosition", fallback: "top-left" }
  };
  var POSITION_TO_SLOT = withoutPrototype({ "top-left": "tl", "top-right": "tr", "bottom-left": "bl", "bottom-right": "br", "top-center": "tc", "bottom-center": "bc", "center-left": "ml", "center-right": "mr", "center": "c" });
  var ENABLED_SETTING = {
    quality: "qualityTagsEnabled",
    genre: "genreTagsEnabled",
    language: "languageTagsEnabled",
    rating: "ratingTagsEnabled",
    ageRating: "ageRatingTagsEnabled",
    status: "statusTagsEnabled",
    awards: "awardsTagsEnabled",
    logos: "logoTagsEnabled",
    custom: "customTagsEnabled"
  };
  var SLOT_TO_POSITION = withoutPrototype({ tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right", tc: "top-center", bc: "bottom-center", ml: "center-left", mr: "center-right", c: "center" });
  function pick(obj, key) {
    if (!obj || typeof obj !== "object")
      return void 0;
    const record = Object.fromEntries(Object.entries(obj));
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    return (hasOwn(record, key) ? record[key] : void 0) ?? (hasOwn(record, pascal) ? record[pascal] : void 0) ?? void 0;
  }
  function normalizeGroup(name) {
    if (typeof name !== "string")
      return null;
    const lowered = name.trim().toLowerCase();
    for (const group of DEFAULT_ORDER) {
      if (group.toLowerCase() === lowered)
        return group;
    }
    return null;
  }
  function normalizeLayout(value) {
    const lowered = typeof value === "string" ? value.trim().toLowerCase() : "";
    return isLayout(lowered) ? lowered : "corners";
  }
  function readProfile(profiles, layout2) {
    const out = {};
    const groups = pick(pick(profiles, layout2), "groups");
    if (!Array.isArray(groups))
      return out;
    for (const entry of groups) {
      const group = normalizeGroup(pick(entry, "group"));
      const raw = pick(entry, "slot");
      const slot = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!group || out[group] || !LAYOUT_SLOTS[layout2].includes(slot))
        continue;
      if (slot === "dots" && group !== "quality")
        continue;
      out[normalizeGroup(group) || "quality"] = slot;
    }
    return out;
  }
  function readOrder(order) {
    if (!Array.isArray(order))
      return null;
    const out = [];
    for (const entry of order) {
      const group = normalizeGroup(entry);
      if (group && !out.includes(group))
        out.push(group);
    }
    return out.length ? out : null;
  }
  function readEdge(value) {
    if (value === null || value === void 0 || value === "")
      return null;
    const lowered = String(value).trim().toLowerCase();
    return hasOwn(EDGE_SPACINGS, lowered) ? lowered : "default";
  }
  function readCap(value) {
    const n = Number(value);
    if (value === null || value === void 0 || value === "" || !Number.isFinite(n))
      return void 0;
    return Math.max(0, Math.min(MAX_CAP, Math.round(n)));
  }
  function singleChipGroup(group, config = {}) {
    return group === "status" || group === "ageRating" || group === "logos" && Number(pick(config, "logoTagsMaxLogos") ?? 1) < 2;
  }
  function normalizeGroupCaps(caps, config = {}) {
    return { ...caps, ...Object.fromEntries(DEFAULT_ORDER.map((group) => [group, singleChipGroup(group, config) ? 1 : caps[group]])) };
  }
  function readShapeLook(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return null;
    const layoutRaw = pick(raw, "layout");
    const candidate = typeof layoutRaw === "string" ? layoutRaw.trim().toLowerCase() : "";
    const layout2 = isLayout(candidate) ? candidate : null;
    const densityRaw = String(pick(raw, "density") ?? "").trim().toLowerCase();
    const slotsRaw = pick(raw, "slots");
    const slots = {};
    const pairs = Array.isArray(slotsRaw) ? slotsRaw.map((entry) => [pick(entry, "group"), pick(entry, "slot")]) : slotsRaw && typeof slotsRaw === "object" ? Object.entries(slotsRaw) : [];
    const valid = layout2 ? LAYOUT_SLOTS[layout2] : LAYOUTS.flatMap((name) => LAYOUT_SLOTS[name]);
    for (const [rawGroup, rawSlot] of pairs) {
      const group = normalizeGroup(rawGroup);
      const slot = typeof rawSlot === "string" ? rawSlot.trim().toLowerCase() : "";
      if (!group || slots[group] || !valid.includes(slot) || slot === "dots" && group !== "quality")
        continue;
      slots[group] = slot;
    }
    const caps = {};
    const capsRaw = pick(raw, "caps");
    for (const group of DEFAULT_ORDER) {
      const cap = readCap(pick(capsRaw, group));
      if (cap !== void 0)
        caps[group] = cap;
    }
    return {
      layout: layout2,
      density: densityRaw === "compact" || densityRaw === "full" ? densityRaw : null,
      ...readScale(pick(raw, "tagScale")) ? { tagScale: readScale(pick(raw, "tagScale")) } : {},
      ...readGap(pick(raw, "tagGap")) ? { tagGap: readGap(pick(raw, "tagGap")) } : {},
      slots: Object.keys(slots).length ? slots : null,
      caps: Object.keys(caps).length ? caps : null
    };
  }
  function readShapeOverrides(raw) {
    const out = { landscape: null, list: null };
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return out;
    for (const shape of SHAPES)
      out[shape] = readShapeLook(pick(raw, shape));
    return out;
  }
  function shapesToWire(shapes) {
    if (!shapes || !SHAPES.some((shape) => shapes[shape]))
      return null;
    const out = {};
    for (const shape of SHAPES) {
      const look = shapes[shape];
      out[shape] = look ? {
        layout: look.layout || null,
        density: look.density || null,
        ...look.tagScale ? { tagScale: look.tagScale } : {},
        ...look.tagGap ? { tagGap: look.tagGap } : {},
        slots: look.slots ? Object.entries(look.slots).map(([group, slot]) => ({ group, slot })) : null,
        caps: look.caps ? { ...look.caps } : null
      } : null;
    }
    return out;
  }
  function positionSlot(settings, plugin, group) {
    const p = POSITION_SETTINGS[group];
    const pos = String(settings?.[p.userKey] || plugin?.[p.pluginKey] || p.fallback);
    if (hasOwn(POSITION_TO_SLOT, pos))
      return POSITION_TO_SLOT[pos] || "br";
    const isTop = pos.includes("top");
    const isLeft = pos.includes("left");
    return isTop ? isLeft ? "tl" : "tr" : isLeft ? "bl" : "br";
  }
  function isLegacySettings(settings = {}) {
    return !(Number(settings.tagLayoutSettingsVersion) >= 1);
  }
  function normalizeSettings(s = {}, p = {}) {
    const legacy = isLegacySettings(s);
    const layout2 = legacy ? "corners" : normalizeLayout(s.tagLayout);
    const densityRaw = legacy ? "full" : String(s.tagLabelDensity || "").toLowerCase();
    const density = densityRaw === "compact" ? "compact" : "full";
    const profiles = { corners: {}, bands: {}, caption: {}, summary: {}, minimal: {} };
    const indicatorGap = /* @__PURE__ */ new Set();
    const ownCorners = readProfile(s.tagLayouts, "corners");
    for (const group of DEFAULT_ORDER) {
      const pos = POSITION_SETTINGS[group];
      const raw = s[pos.userKey] || p[pos.pluginKey] || pos.fallback;
      if (ownCorners[group] ? ownCorners[group] === "tr" : raw === "top-right")
        indicatorGap.add(group);
    }
    for (const name of LAYOUTS) {
      const own = readProfile(s.tagLayouts, name);
      const admin = name === "corners" ? {} : readProfile(pick(p, "tagLayouts"), name);
      const profile = {};
      for (const group of DEFAULT_ORDER) {
        profile[group] = own[group] || admin[group] || (name === "corners" ? positionSlot(s, p, group) : DEFAULT_PROFILES[name][group] || "off");
      }
      profiles[name] = profile;
    }
    let order = null;
    let orderChosen = false;
    if (!legacy) {
      const own = readOrder(s.tagGroupOrder);
      orderChosen = !!own;
      const chosen = own || (layout2 === "corners" ? null : DEFAULT_ORDER);
      if (chosen)
        order = chosen.concat(DEFAULT_ORDER.filter((g) => !chosen.includes(g)));
    }
    const caps = {};
    for (const group of DEFAULT_ORDER) {
      const own = legacy ? void 0 : readCap(pick(s.tagGroupCaps, group));
      const admin = legacy ? void 0 : readCap(pick(pick(p, "tagGroupCaps"), group));
      caps[group] = singleChipGroup(group, p) ? 1 : own ?? admin ?? DEFAULT_CAPS[group];
    }
    const reserveCaption = layout2 === "caption" && DEFAULT_ORDER.some((g) => profiles.caption[g] === "caption" && !!s[ENABLED_SETTING[g]] && (g !== "awards" || p.AwardsTagsEnabled !== false));
    const ownShapes = s.tagShapeOverrides;
    const shapes = readShapeOverrides(ownShapes && typeof ownShapes === "object" ? ownShapes : legacy ? null : pick(p, "tagShapeOverrides"));
    const tagScale = legacy ? "default" : readScale(s.tagScale) || (s.tagScale != null ? "default" : readScale(pick(p, "tagScale"))) || "default";
    const tagGap = legacy ? "default" : readGap(s.tagGap) || (s.tagGap != null ? "default" : readGap(pick(p, "tagGap"))) || "default";
    const edge = legacy ? "default" : readEdge(s.tagEdgeSpacing) || readEdge(pick(p, "tagEdgeSpacing")) || "default";
    const conf = { layout: layout2, legacy, density, tagScale, tagGap, order, orderChosen, caps: { ...DEFAULT_CAPS, ...caps }, profiles, slots: profiles[layout2], indicatorGap, reserveCaption, locked: false, shapes, edge, lookKey: "" };
    conf.lookKey = lookKeyOf(conf);
    return conf;
  }
  function promoteLegacySettings(s) {
    if (!s || !isLegacySettings(s))
      return false;
    s.tagLayout = "corners";
    s.tagLabelDensity = "full";
    s.tagScale = "default";
    s.tagGap = "default";
    s.tagGroupCaps = { ...DEFAULT_CAPS };
    s.tagGroupOrder = null;
    if (!Array.isArray(s.tagLookRules))
      s.tagLookRules = [];
    if (!s.tagShapeOverrides || typeof s.tagShapeOverrides !== "object" || Array.isArray(s.tagShapeOverrides)) {
      s.tagShapeOverrides = { landscape: null, list: null };
    }
    if (!readEdge(s.tagEdgeSpacing))
      s.tagEdgeSpacing = "default";
    s.tagLayoutSettingsVersion = 1;
    return true;
  }
  function lookKeyOf(conf) {
    return [
      conf.layout,
      conf.density,
      conf.tagScale,
      conf.tagGap,
      conf.locked ? "L" : "",
      DEFAULT_ORDER.map((g) => conf.slots[g] || "").join(","),
      DEFAULT_ORDER.map((g) => conf.caps[g]).join(","),
      conf.edge === "default" ? "" : conf.edge
    ].join("|");
  }
  function validSlots(layout2, slots) {
    const out = {};
    for (const [group, slot] of Object.entries(slots || {})) {
      if (normalizeGroup(group) !== null && LAYOUT_SLOTS[layout2].includes(slot) && (slot !== "dots" || group === "quality"))
        out[normalizeGroup(group) || "quality"] = slot;
    }
    return out;
  }
  function withShape(look, shapeLook) {
    if (!shapeLook)
      return { ...look, caps: look.caps || null };
    const switches = !!shapeLook.layout && shapeLook.layout !== look.layout;
    const slots = switches ? shapeLook.slots : look.slots || shapeLook.slots ? { ...look.slots || {}, ...shapeLook.slots || {} } : null;
    const caps = look.caps || shapeLook.caps ? { ...look.caps || {}, ...shapeLook.caps || {} } : null;
    return {
      layout: shapeLook.layout || look.layout,
      density: shapeLook.density || look.density,
      tagScale: shapeLook.tagScale || look.tagScale,
      tagGap: shapeLook.tagGap || look.tagGap,
      edge: look.edge || null,
      slots,
      caps
    };
  }
  function lookSettings(base, look, locked, settings = {}, plugin = {}) {
    const layout2 = look.layout ? normalizeLayout(look.layout) : base.layout;
    const own = validSlots(layout2, look.slots);
    const slots = { ...base.profiles[layout2], ...own };
    const conf = {
      ...base,
      layout: layout2,
      density: look.density ? look.density === "compact" ? "compact" : "full" : base.density,
      tagScale: readScale(look.tagScale) || base.tagScale,
      tagGap: readGap(look.tagGap) || base.tagGap,
      // A lock or item look may set its own edge spacing (an unknown one inherits).
      edge: (look.edge && hasOwn(EDGE_SPACINGS, look.edge) ? look.edge : null) || base.edge,
      caps: look.caps ? normalizeGroupCaps({ ...base.caps, ...look.caps }, plugin) : base.caps,
      // A chosen order applies everywhere; otherwise corners keeps
      // arrival order and the other layouts the built-in order.
      order: base.orderChosen ? base.order : layout2 === "corners" ? null : DEFAULT_ORDER,
      profiles: { ...base.profiles, [layout2]: slots },
      slots,
      indicatorGap: Object.keys(own).length && layout2 === "corners" ? new Set(DEFAULT_ORDER.filter((g) => slots[g] === "tr")) : base.indicatorGap,
      reserveCaption: layout2 === "caption" && DEFAULT_ORDER.some((g) => slots[g] === "caption" && !!settings[ENABLED_SETTING[g]] && (g !== "awards" || plugin.AwardsTagsEnabled !== false)),
      locked,
      lookKey: ""
    };
    conf.lookKey = lookKeyOf(conf);
    return conf;
  }
  function withoutPrototype(value) {
    Object.setPrototypeOf(value, null);
    return value;
  }

  // client/generated-shared/publish/js/core/tag-layout.js.ts
  publishSharedModules({ "features/media-tags/layout/layout-rules": layout_rules_exports });

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export3 = /* @__PURE__ */ sharedExport(shared, "settingsUi");

  // client/src/features/media-tags/rules-host.ts
  function tagRulesHost() {
    const host = window;
    if (!host.JellyfinEnhanced)
      throw new Error("Jellyfin Enhanced must load before tag rules");
    return host.JellyfinEnhanced;
  }

  // client/src/features/media-tags/layout/state.ts
  function contextElement(context) {
    return context instanceof HTMLElement ? context : context && "host" in context ? context.host : null;
  }
  function childrenOf(element) {
    return Array.from(element.children).filter((child) => child instanceof HTMLElement);
  }
  function cloneElement(element) {
    const clone = element.cloneNode(true);
    if (!(clone instanceof HTMLElement))
      throw new Error("Expected an HTML tag");
    return clone;
  }
  var STACK_INSET = 6;
  var STACK_LIFT = "--je-stack-lift";
  var INDICATOR_BEFORE = "--je-indicator-before";
  function createLayoutState() {
    return {
      SLOT_ORDER: [...new Set(Object.values(LAYOUT_SLOTS).flat().filter((slot) => slot !== "off"))],
      PORTRAIT_CARD: /^(?:overflow)?(?:portrait|square)card$/i,
      LANDSCAPE_CARD: /^(?:overflow)?(?:backdrop|smallbackdrop|banner|thumb)card$/i,
      CONTAINER_CLASS: {
        quality: "quality-overlay-container",
        genre: "genre-overlay-container",
        language: "language-overlay-container",
        rating: "rating-overlay-container",
        ageRating: "age-rating-overlay-container",
        status: "status-overlay-container",
        awards: "awards-overlay-container",
        logos: "logo-overlay-container",
        custom: "custom-overlay-container"
      },
      SUMMARY_SLOTS: /* @__PURE__ */ new Set(["pill", "dots", "corner"]),
      FIT_LAYOUTS: /* @__PURE__ */ new Set(["bands", "caption", "summary", "minimal"]),
      CENTRE_SLOTS: /* @__PURE__ */ new Set(["tc", "bc", "ml", "mr", "c"]),
      STACK_SLOTS: { minimal: ["top", "corner"], caption: ["poster"] },
      DYNAMIC_RANGE: ["Dolby Vision", "HDR10+", "HDR10", "HLG", "HDR"],
      DOT_KIND: [
        ["resolution", "resolution"],
        ["video-codec", "range"],
        ["audio-codec", "audio"],
        ["video-format", "codec"],
        ["other-quality", "codec"]
      ],
      cachedSettings: null,
      cachedSource: null,
      cachedLooks: null,
      controllers: /* @__PURE__ */ new WeakMap(),
      cardData: /* @__PURE__ */ new WeakMap(),
      awaitingData: /* @__PURE__ */ new WeakMap(),
      waitGeneration: 0,
      outletSeq: 0,
      stylesInjected: false,
      resizeQueued: false,
      pendingFit: /* @__PURE__ */ new Set(),
      fitScheduled: false,
      fitting: false,
      sizeObserver: null,
      genreAfterFit: /* @__PURE__ */ new Set(),
      revealedCard: null,
      moreTipSeq: 0,
      reinitPending: null
    };
  }

  // client/src/features/media-tags/layout/card-context.ts
  var AWAIT_CONTEXT_MS = 8e3;
  function createCardContext(s, JE, deps) {
    function identityOf(el) {
      const holder = el.closest("[data-id]") || el.closest("[data-itemid]");
      const raw = holder?.getAttribute("data-id") || holder?.getAttribute("data-itemid") || "";
      return raw.replace(/-/g, "").toLowerCase();
    }
    function shapeOfCard(el) {
      if (!el || typeof el.closest !== "function")
        return null;
      if (el.closest(".listItemImage-large"))
        return "list";
      const origin = el.classList.contains("je-tag-host") ? el.parentElement : el;
      const explicit = origin?.closest("[data-je-shape]:not(.je-tag-host)")?.getAttribute("data-je-shape");
      if (explicit === "portrait" || explicit === "list" || explicit === "landscape")
        return explicit;
      const card = el.closest(".card");
      if (!card)
        return null;
      for (const cls of card.classList) {
        if (s.PORTRAIT_CARD.test(cls))
          return "portrait";
        if (s.LANDSCAPE_CARD.test(cls))
          return "landscape";
      }
      return null;
    }
    function shapeOf(cardContext) {
      if (cardContext && "host" in cardContext)
        return cardContext.shape || "portrait";
      if (cardContext instanceof HTMLElement) {
        const ctrl = s.controllers.get(findHost(cardContext) || cardContext);
        return ctrl?.shape || shapeOfCard(cardContext) || "portrait";
      }
      return cardContext?.shape === "list" || cardContext?.shape === "landscape" ? cardContext.shape : "portrait";
    }
    function shapesInUse() {
      const base = deps.currentSettings();
      if (SHAPES.some((shape) => shape === "list" || shape === "landscape" ? base.shapes[shape] : null))
        return true;
      const looks = deps.currentLooks();
      return looks.rules.some((rule) => !!rule.shapes) || Array.from(looks.locks.values()).some((lock) => !!lock.shapes) || Array.from(looks.overrides.values()).some((look) => !!look.shapes);
    }
    function findHost(target) {
      if (!target)
        return null;
      if (target.classList?.contains("je-tag-host"))
        return target;
      for (const child of childrenOf(target)) {
        if (child.classList.contains("je-tag-host"))
          return child;
      }
      return null;
    }
    function ensureHost(target) {
      const existing = findHost(target);
      if (existing || !target)
        return existing;
      const host = document.createElement("div");
      host.className = "je-tag-host";
      const overlay = target.classList.contains("cardScalable") ? childrenOf(target).find((c) => c.classList.contains("cardOverlayContainer")) || null : null;
      target.insertBefore(host, overlay);
      return host;
    }
    function captionAnchor(host) {
      const scalable = host.closest(".cardScalable");
      const box = scalable?.parentElement;
      if (!scalable || !box || !box.classList.contains("cardBox"))
        return null;
      for (let next = scalable.nextElementSibling; next; next = next.nextElementSibling) {
        if (next.classList.contains("je-tag-caption"))
          continue;
        if (next.classList.contains("cardText") || next.querySelector(".cardText")) {
          return { parent: box, before: next };
        }
      }
      return null;
    }
    function isIgnoredContext(host) {
      const check = JE.core.tagRenderer?.isIgnoredContext;
      return typeof check === "function" ? check(host) : false;
    }
    function controllerFor(target, create) {
      const host = create ? ensureHost(target) : findHost(target);
      if (!host)
        return null;
      let ctrl = s.controllers.get(host) || null;
      const itemId = identityOf(host);
      if (ctrl && ctrl.itemId !== itemId) {
        deps.forget(ctrl);
        ctrl = null;
      }
      if (!ctrl && create) {
        deps.injectStyles();
        ctrl = { host, itemId, groups: /* @__PURE__ */ new Map(), nodes: /* @__PURE__ */ new Map(), outlet: null, pill: null, layout: null, seq: 0, moreTip: null, described: null, lookKey: "", shape: shapeOfCard(host) };
        s.controllers.set(host, ctrl);
      }
      return ctrl;
    }
    function cardFacts(cardContext) {
      const look = deps.requireLook();
      const el = contextElement(cardContext);
      if (!el)
        return look.factsFrom(cardContext, { itemId: cardContext && "itemId" in cardContext ? cardContext.itemId || "" : "", cardType: cardContext && "cardType" in cardContext ? cardContext.cardType || null : null });
      const cardId = cardContext && "host" in cardContext ? cardContext.itemId : identityOf(el);
      const data = contextOf(s.cardData, el);
      const usable = data && (!data.cardId || data.cardId === cardId);
      const cardType = el.closest("[data-type]")?.getAttribute("data-type") || null;
      return look.factsFrom(usable ? data.entry : null, { itemId: usable ? data.itemId : "", cardId, cardType });
    }
    function contextOf(map, el) {
      return map.get(el) || (el.parentElement ? map.get(el.parentElement) : void 0);
    }
    function needsCardData(cardType) {
      const looks = deps.currentLooks();
      const perItem = looks.locks.size + looks.overrides.size;
      if (!looks.rules.length && !perItem)
        return false;
      if (!cardType)
        return true;
      if (looks.rules.some((rule) => rule.enabled && rule.when.some((cond) => cond.field !== "type")))
        return true;
      return perItem > 0 && (cardType === "Season" || cardType === "Episode");
    }
    function isAwaiting(host) {
      const rec = contextOf(s.awaitingData, host);
      return !!rec && rec.cardId === identityOf(host);
    }
    function resolveLayout(cardContext) {
      const base = deps.currentSettings();
      const source = lookSource(cardContext);
      const shape = source.shape;
      if (source.lock)
        return deps.lookSettings(base, withShape(source.lock, shape === "list" || shape === "landscape" ? source.lock.shapes?.[shape] : null), source.source === "lock" || "locked" in source.lock && !!source.lock.locked);
      if (source.rule)
        return deps.lookSettings(base, withShape(source.rule, shape === "list" || shape === "landscape" ? source.rule.shapes?.[shape] : null), false);
      if (source.source === "shape") {
        return deps.lookSettings(base, withShape({ layout: base.layout, density: base.density, slots: null, caps: null }, shape === "list" || shape === "landscape" ? base.shapes[shape] : null), false);
      }
      return base;
    }
    function lookSource(cardContext) {
      const looks = deps.currentLooks();
      const shape = shapeOf(cardContext);
      const el = contextElement(cardContext);
      const preview = el ? contextOf(previewLooks, el) : void 0;
      if (preview)
        return { source: "preview", lock: preview, rule: null, index: -1, shape };
      const shaped = (shape === "list" || shape === "landscape") && !!deps.currentSettings().shapes[shape];
      const none = { source: shaped ? "shape" : "default", lock: null, rule: null, index: -1, shape };
      if (!looks.rules.length && !looks.locks.size && !looks.overrides.size)
        return none;
      const facts = cardFacts(cardContext);
      const lock = deps.requireLook().findLock(looks.locks, facts);
      if (lock)
        return { source: "lock", lock, rule: null, index: -1, shape };
      const override = deps.requireLook().findLock(looks.overrides, facts);
      if (override)
        return { source: "override", lock: override, rule: null, index: -1, shape };
      const rule = deps.requireLook().firstMatch(looks.rules, facts);
      return rule ? { source: "rule", lock: null, rule, index: looks.rules.indexOf(rule), shape } : none;
    }
    const previewLooks = /* @__PURE__ */ new WeakMap();
    function setPreviewLook(target, look) {
      if (!target)
        return;
      if (look)
        previewLooks.set(target, look);
      else
        previewLooks.delete(target);
      deps.refreshPresentation(target);
    }
    function cardIdentity(target) {
      return target ? identityOf(findHost(target) || target) : "";
    }
    function setCardContext(target, entry, itemId, cardId) {
      if (!target || !entry)
        return false;
      const host = findHost(target) || target;
      const current = identityOf(host);
      if (cardId !== void 0 && cardId !== null && cardId !== current)
        return false;
      s.cardData.set(host, { entry, itemId, cardId: current });
      const waited = endAwait(host);
      const ctrl = s.controllers.get(host);
      if (!ctrl || !ctrl.host.isConnected || !ctrl.groups.size)
        return true;
      const looks = deps.currentLooks();
      if (waited || (looks.rules.length || looks.locks.size) && resolveLayout(ctrl).lookKey !== ctrl.lookKey)
        deps.presentAll(ctrl);
      return true;
    }
    function awaitCardContext(target, cardId, cardType) {
      if (!target || !needsCardData(cardType))
        return false;
      const host = findHost(target) || target;
      endAwait(host);
      const token = { cardId, generation: ++s.waitGeneration };
      const timer = setTimeout(() => releaseCardContext(target, token), AWAIT_CONTEXT_MS);
      s.awaitingData.set(host, { cardId, timer, token });
      return token;
    }
    function endAwait(el) {
      let waited = false;
      for (const key of [el, el.parentElement]) {
        const rec = key ? s.awaitingData.get(key) : void 0;
        if (!rec)
          continue;
        clearTimeout(rec.timer);
        if (key)
          s.awaitingData.delete(key);
        waited = true;
      }
      return waited;
    }
    function releaseCardContext(target, token) {
      if (!target)
        return;
      const host = findHost(target) || target;
      const rec = contextOf(s.awaitingData, host);
      if (!rec || rec.token !== token || token.cardId !== identityOf(host))
        return;
      if (!endAwait(host))
        return;
      const ctrl = s.controllers.get(host);
      if (!ctrl || !ctrl.groups.size)
        return;
      if (ctrl.host.isConnected)
        deps.presentAll(ctrl);
      else
        ctrl.pendingPresentation = true;
    }
    function resumePresentation(target) {
      const ctrl = target ? controllerFor(target, false) : null;
      if (ctrl?.pendingPresentation && ctrl.host.isConnected)
        deps.presentAll(ctrl);
    }
    return { shapeOfCard, shapeOf, shapesInUse, findHost, ensureHost, captionAnchor, isIgnoredContext, controllerFor, contextOf, isAwaiting, resolveLayout, lookSource, setPreviewLook, cardIdentity, setCardContext, awaitCardContext, endAwait, releaseCardContext, resumePresentation };
  }

  // client/src/features/media-tags/layout/fit-apply.ts
  var GENRE_NAME_GAP = 4;
  var GENRE_NAME_MIN = 24;
  var GENRE_NAME_SHARE = 0.6;
  var FOCUSABLE = 'a[href], button, [tabindex]:not([tabindex="-1"])';
  function createFitApply(s, JE, deps) {
    function applyFit(ctrl, plan) {
      for (const row of plan.rows) {
        if (row.width !== void 0)
          row.slot.style.setProperty("--je-anchor-width", `${row.width}px`);
        if (row.firstWidth !== void 0 && row.chips[0]) {
          deps.prepareFitText(row.chips[0]);
          row.chips[0].setAttribute("data-je-fit-width", "");
          row.chips[0].style.setProperty("--je-chip-fit-width", `${row.firstWidth}px`);
        }
      }
      for (const { chip, width } of plan.stacks) {
        deps.prepareFitText(chip);
        chip.setAttribute("data-je-fit-width", "");
        chip.style.setProperty("--je-chip-fit-width", `${width}px`);
      }
      if (plan.lift?.lift)
        plan.lift.slot.style.setProperty(STACK_LIFT, `${Math.round(plan.lift.lift * 100) / 100}px`);
      if (plan.lift?.hidden.length) {
        for (const chip of plan.lift.hidden)
          chip.setAttribute("data-je-overflow", "");
        for (const group of childrenOf(plan.lift.slot)) {
          if (childrenOf(group).every((chip) => chip.hasAttribute("data-je-overflow")))
            group.setAttribute("data-je-overflow", "");
        }
      }
      if (ctrl.layout === "corners" && deps.resolveLayout(ctrl).edge === "flush") {
        for (const row of plan.rows) {
          const slot = row.slot.dataset.jeSlot;
          if (!["tc", "bc"].includes(slot || ""))
            continue;
          const last = Math.max(0, ...row.chips.map((chip, i) => row.shown[i] ? row.fittedRows?.[i] || 0 : 0), row.shown.includes(false) && row.more ? row.fittedMoreRow || 0 : 0);
          row.chips.forEach((chip, i) => {
            chip.toggleAttribute("data-je-flush-top", slot === "tc" && !row.slot.hasAttribute("data-je-flush-detached") && row.shown[i] && row.fittedRows?.[i] === 1);
            chip.toggleAttribute("data-je-flush-bottom", slot === "bc" && row.shown[i] && row.fittedRows?.[i] === last);
          });
          const more = deps.moreChipOf(row.slot);
          const visible = row.more && row.shown.includes(false);
          more?.toggleAttribute("data-je-flush-top", visible && slot === "tc" && !row.slot.hasAttribute("data-je-flush-detached") && row.fittedMoreRow === 1);
          more?.toggleAttribute("data-je-flush-bottom", visible && slot === "bc" && row.fittedMoreRow === last);
        }
      }
      if (plan.pillFacts >= 0 && ctrl.pill) {
        Array.from(ctrl.pill.querySelectorAll(".je-tag-pill-fact")).slice(plan.pillFacts).forEach((fact) => {
          fact.setAttribute("data-je-overflow", "");
          fact.previousElementSibling?.setAttribute("data-je-overflow", "");
        });
      }
      const names = applyChipRows(plan.rows);
      describeHidden(ctrl, names);
      for (const slot of deps.posterStack(ctrl)) {
        for (const group of childrenOf(slot)) {
          const chips = childrenOf(group);
          if (group.dataset.jeGroup && chips.length && chips.every((chip) => chip.hasAttribute("data-je-overflow")))
            group.setAttribute("data-je-overflow", "");
        }
      }
      for (const { el, before } of plan.indicator) {
        const value = before === null ? "" : `${Math.round(before * 100) / 100}px`;
        if (el.style.getPropertyValue(INDICATOR_BEFORE) === value)
          continue;
        if (value)
          el.style.setProperty(INDICATOR_BEFORE, value);
        else
          el.style.removeProperty(INDICATOR_BEFORE);
      }
    }
    function applyChipRows(rows) {
      const names = [];
      for (const { slot, chips, shown, more: room } of rows) {
        const more = deps.moreChipOf(slot);
        if (!more)
          continue;
        const hidden = chips.filter((chip, i) => !shown[i]);
        for (const chip of hidden)
          chip.setAttribute("data-je-overflow", "");
        names.push(...hidden.map(deps.chipLabel).filter(Boolean));
        if (!room && !shown.some(Boolean))
          slot.setAttribute("data-je-overflow", "");
        if (hidden.length === 0 || !room) {
          more.setAttribute("data-je-overflow", "");
          more.removeAttribute("title");
          continue;
        }
        more.textContent = `+${hidden.length}`;
        more.title = hidden.map(deps.chipLabel).filter(Boolean).join(", ");
      }
      return names;
    }
    function isRevealed(host) {
      const card = host.closest(".card, .je-mtp-card, .je-tie-card");
      if (!card)
        return false;
      try {
        return card.classList.contains("je-tag-reveal") || card.matches(":hover, :focus-within");
      } catch {
        return false;
      }
    }
    function fitReveal(host) {
      if (!host)
        return;
      const ctrl = s.controllers.get(host);
      if (ctrl && s.fitScheduled && s.pendingFit.has(ctrl)) {
        s.genreAfterFit.add(host);
        return;
      }
      const names = Array.from(host.querySelectorAll(':scope > .je-tag-slot:not([data-je-slot="hover"]) .genre-tag > .genre-text'));
      const tip = host.querySelector(":scope > .je-tag-more-tip");
      if (names.length === 0 && !tip)
        return;
      if (tip) {
        delete tip.dataset.jeTipFit;
        tip.style.removeProperty("top");
      }
      for (const name of names) {
        delete name.dataset.jeGenreFit;
        for (const prop of ["max-width", "left", "right", "top", "transform"])
          name.style.removeProperty(prop);
      }
      const card = host.getBoundingClientRect();
      if (!(card.width > 0) || !(card.height > 0))
        return;
      const left = card.left + STACK_INSET;
      const right = card.right - STACK_INSET;
      const obstacles = Array.from(host.querySelectorAll(':scope > .je-tag-slot:not([data-je-slot="hover"]) > [data-je-group] > *')).map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0);
      const items = names.map((name) => {
        const tag = name.parentElement || name;
        const icon = tag.getBoundingClientRect();
        const box = name.getBoundingClientRect();
        const floating = getComputedStyle(name).position === "absolute";
        return { tag, name, icon, floating, height: box.height, natural: box.width, floatsLeft: box.right <= icon.left + 0.5, borderLeft: tag.clientLeft, borderTop: tag.clientTop };
      }).filter((m) => m.icon.width > 0 && m.floating);
      const groups = /* @__PURE__ */ new Map();
      for (const item of items) {
        const group = item.tag.parentElement;
        if (!groups.has(group))
          groups.set(group, []);
        groups.get(group)?.push(item);
      }
      const writes = [];
      for (const members of groups.values()) {
        const row = members.length > 1 && members.every((m) => Math.abs(m.icon.top - (members[0]?.icon.top || 0)) < 1);
        if (!row) {
          for (const m of members) {
            const top = m.icon.top + (m.icon.height - m.height) / 2;
            const bottom = top + m.height;
            let blocked = top < card.top - 0.5 || bottom > card.bottom + 0.5;
            const near = m.floatsLeft ? m.icon.left - GENRE_NAME_GAP : m.icon.right + GENRE_NAME_GAP;
            let limit = m.floatsLeft ? left : right;
            for (const { el, r } of obstacles) {
              if (el === m.tag || r.bottom <= top + 0.5 || r.top >= bottom - 0.5)
                continue;
              if (m.floatsLeft && r.left < m.icon.left - 0.5) {
                if (r.right <= near + 0.5)
                  limit = Math.max(limit, r.right + GENRE_NAME_GAP);
                else
                  blocked = true;
              }
              if (!m.floatsLeft && r.right > m.icon.right + 0.5) {
                if (r.left >= near - 0.5)
                  limit = Math.min(limit, r.left - GENRE_NAME_GAP);
                else
                  blocked = true;
              }
            }
            const room2 = blocked ? 0 : Math.floor(m.floatsLeft ? near - limit : limit - near);
            const needed = Math.min(m.natural, Math.max(GENRE_NAME_MIN, GENRE_NAME_SHARE * m.natural));
            writes.push({ name: m.name, mode: room2 < needed - 0.5 ? "hidden" : "side", room: Math.max(0, room2) });
          }
          continue;
        }
        const rowLeft = Math.min(...members.map((m) => m.icon.left));
        const rowTop = Math.min(...members.map((m) => m.icon.top));
        const rowBottom = Math.max(...members.map((m) => m.icon.bottom));
        const below = (rowTop + rowBottom) / 2 < card.top + card.height / 2;
        const room = Math.floor(right - left);
        members.forEach((m, i) => {
          const width = Math.min(m.natural, room);
          const x = Math.min(Math.max(rowLeft, left), right - width);
          const line = m.height + 2;
          const y = below ? rowBottom + GENRE_NAME_GAP + i * line : rowTop - GENRE_NAME_GAP - (members.length - i) * line + 2;
          const inside = y >= card.top + STACK_INSET - 0.5 && y + m.height <= card.bottom - STACK_INSET + 0.5;
          writes.push({ name: m.name, mode: inside ? "list" : "hidden", room, x: x - m.icon.left - m.borderLeft, y: y - m.icon.top - m.borderTop });
        });
      }
      for (const w of writes) {
        w.name.dataset.jeGenreFit = w.mode;
        w.name.style.maxWidth = `${w.room}px`;
        if (w.mode !== "list")
          continue;
        w.name.style.left = `${Math.round((w.x ?? 0) * 100) / 100}px`;
        w.name.style.right = "auto";
        w.name.style.top = `${Math.round((w.y ?? 0) * 100) / 100}px`;
        w.name.style.transform = "none";
      }
      if (tip)
        placeMoreTip(host, tip, card);
      host.dataset.jeGenreBound = "1";
    }
    function placeMoreTip(host, tip, card) {
      const box = tip.getBoundingClientRect();
      const busy = Array.from(host.querySelectorAll(':scope > .je-tag-slot:not([data-je-slot="hover"]) > [data-je-group] > *, :scope > .je-tag-slot:not([data-je-slot="hover"]) .genre-tag > .genre-text')).filter((el) => !el.matches(".genre-text") || el.dataset.jeGenreFit !== "hidden" && getComputedStyle(el).display !== "none").map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      const left = card.left + (card.width - box.width) / 2;
      const right = left + box.width;
      const free = (top2) => busy.every((r) => r.right <= left - GENRE_NAME_GAP + 0.5 || r.left >= right + GENRE_NAME_GAP - 0.5 || r.bottom <= top2 - GENRE_NAME_GAP + 0.5 || r.top >= top2 + box.height + GENRE_NAME_GAP - 0.5);
      const tops = [card.top + STACK_INSET, ...busy.map((r) => r.bottom + GENRE_NAME_GAP)].sort((a, b) => a - b);
      const top = tops.find((y) => y >= card.top + STACK_INSET - 0.5 && y + box.height <= card.bottom - STACK_INSET + 0.5 && free(y));
      if (top === void 0) {
        tip.dataset.jeTipFit = "hidden";
        return;
      }
      tip.dataset.jeTipFit = "placed";
      tip.style.top = `${Math.round((top - card.top) * 100) / 100}px`;
    }
    function onReveal(event) {
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest(".card");
      if (!card || card === s.revealedCard)
        return;
      s.revealedCard = card;
      fitReveal(card.querySelector(".je-tag-host"));
    }
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("pointerover", onReveal, { passive: true });
      document.addEventListener("focusin", onReveal);
      document.addEventListener("pointerout", (event) => {
        if (s.revealedCard && !(event.relatedTarget instanceof Node && s.revealedCard.contains(event.relatedTarget)))
          s.revealedCard = null;
      }, { passive: true });
    }
    function cardLinkOf(host) {
      const card = host.closest(".card, .listItem");
      const image = card?.querySelector(`.cardImageContainer:is(${FOCUSABLE})`);
      if (image)
        return image;
      const around = host.parentElement?.closest(FOCUSABLE);
      if (around)
        return around;
      return card?.querySelector(FOCUSABLE) || null;
    }
    function toggleDescribedBy(el, id, on) {
      const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter((t) => t && t !== id);
      if (on)
        ids.push(id);
      if (ids.length)
        el.setAttribute("aria-describedby", ids.join(" "));
      else
        el.removeAttribute("aria-describedby");
    }
    function describeHidden(ctrl, names) {
      const link = names.length ? cardLinkOf(ctrl.host) : null;
      if (ctrl.described && (ctrl.described !== link || !names.length) && ctrl.moreTip) {
        toggleDescribedBy(ctrl.described, ctrl.moreTip.id, false);
        ctrl.described = null;
      }
      if (!names.length) {
        ctrl.moreTip?.remove();
        ctrl.moreTip = null;
        return;
      }
      let tip = ctrl.moreTip;
      if (!tip || tip.parentElement !== ctrl.host) {
        tip?.remove();
        tip = document.createElement("span");
        tip.className = "je-tag-more-tip";
        tip.id = `je-tag-more-${++s.moreTipSeq}`;
        tip.setAttribute("aria-hidden", "true");
        ctrl.host.appendChild(tip);
        ctrl.moreTip = tip;
      }
      const list = names.join(", ");
      const label = typeof JE.t === "function" ? JE.t("tag_layout_more_tags", { tags: list }) : "";
      const text = label && label !== "tag_layout_more_tags" ? label : list;
      if (tip.textContent !== text)
        tip.textContent = text;
      if (link && link !== ctrl.described) {
        toggleDescribedBy(link, tip.id, true);
        ctrl.described = link;
      }
    }
    return { applyFit, applyChipRows, isRevealed, fitReveal, cardLinkOf, describeHidden };
  }

  // client/src/features/media-tags/types/quality/compact-quality.ts
  var COMPACT_QUALITY = {
    "Dolby Vision": [
      "DV",
      true
    ],
    "HDR10+": [
      "HDR+",
      true
    ],
    "BluRay": [
      "BD",
      true
    ],
    "Dolby Digital": [
      "DD",
      true
    ],
    "Dolby Digital+": [
      "DD+",
      true
    ],
    "DTS-HD MA": [
      "DTS-HD",
      true
    ],
    "DTS-HD HRA": [
      "DTS-HD",
      true
    ],
    "DTS-HD": [
      "DTS-HD",
      true
    ],
    "Dolby TrueHD": [
      "TrueHD",
      true
    ],
    "Dolby Atmos": [
      "Atmos",
      true
    ],
    "DTS:X": [
      "DTS:X",
      true
    ],
    "ATMOS": [
      "ATMOS",
      false
    ],
    "TRUEHD ATMOS": [
      "ATMOS",
      false
    ],
    "DD+ ATMOS": [
      "ATMOS",
      false
    ],
    "DTS-X": [
      "DTS-X",
      false
    ],
    "TRUEHD": [
      "TRUEHD",
      false
    ],
    "DTS": [
      "DTS",
      false
    ]
  };

  // client/src/features/media-tags/layout/layout-fitting.ts
  var SHAPE_RATIO = 1.2;
  function preserveLegacySizing(css) {
    return css.replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selector, body) => {
      if (!body.includes("--je-tag-scale"))
        return rule;
      const declarations = body.split(";").filter((declaration) => declaration.includes("--je-tag-scale")).join(";") + ";";
      const original = declarations.replace(/calc\((clamp\([^)]*\)|[\d.]+(?:px|rem|em|cqw|vw)) \* var\(--je-tag-scale, 1\)(?: \* var\(--je-tag-gap, 1\))?\)/g, "$1");
      if (original === declarations)
        return rule;
      const scoped = selector.includes(".je-tag-host") ? selector.trim().replace(/\.je-tag-host/g, ".je-tag-host[data-je-legacy]") : `.je-tag-host[data-je-legacy] :is(${selector.trim()})`;
      return `${rule}
${scoped} {${original}}`;
    });
  }
  function revealSettings(conf) {
    return conf.density === "compact" ? conf : { ...conf, density: "compact" };
  }
  var FIT_MAX_ROWS = 2;
  var centreRowLimit = (height, offset) => Math.max(0, Math.min(height / 3, height / 2 - offset));
  function shapeOfSize(width, height) {
    return width > 0 && height > 0 && width / height > SHAPE_RATIO ? "landscape" : "portrait";
  }
  function compactQualityLabel(label) {
    const audio = /^(.*) (\d+\.\d+(?:\.\d+)?)$/.exec(label);
    const base = audio?.[1] || label;
    const compact = hasOwn(COMPACT_QUALITY, base) ? COMPACT_QUALITY[base] : void 0;
    if (!compact)
      return label;
    const [text, keepChannels] = compact;
    return text + (audio && keepChannels ? ` ${audio[2]}` : "");
  }
  function chipsThatFit(widths, available, gap, maxRows, moreWidth, rowsOut, moreOut) {
    const fits = (need, room) => need <= room + 0.01;
    const rowOf = [];
    let rows = 0;
    let x = 0;
    for (const w of widths) {
      if (rows === 0 || !fits(x + gap + w, available)) {
        rows++;
        x = w;
      } else
        x += gap + w;
      rowOf.push(rows);
    }
    if (rows <= maxRows && widths.every((w) => fits(w, available))) {
      rowsOut?.push(...rowOf);
      if (moreOut)
        moreOut.row = 0;
      return widths.map(() => true);
    }
    const roomOn = (row2) => row2 === maxRows ? available - gap - moreWidth : available;
    const usable = (w) => fits(w, maxRows === 1 ? roomOn(1) : available);
    let row = 1;
    x = 0;
    let ended = false;
    const shown = widths.map((w) => {
      if (maxRows > 0 && !ended && usable(w)) {
        if (fits(x === 0 ? w : x + gap + w, roomOn(row))) {
          x = x === 0 ? w : x + gap + w;
          rowsOut?.push(row);
          return true;
        }
        if (row < maxRows && x > 0 && fits(w, roomOn(row + 1))) {
          row++;
          x = w;
          rowsOut?.push(row);
          return true;
        }
        ended = true;
      }
      rowsOut?.push(0);
      return false;
    });
    if (moreOut)
      moreOut.row = x === 0 || fits(x + gap + moreWidth, available) ? Math.max(1, row) : row + 1;
    return shown;
  }
  function rowBudget(heights, moreHeight, limit, rowGap) {
    const tallest = [moreHeight, ...heights].filter((h) => h > 0).sort((a, b) => b - a);
    if (!tallest.length)
      return FIT_MAX_ROWS;
    for (let rows = FIT_MAX_ROWS; rows >= 1; rows--) {
      const height = tallest.slice(0, rows).reduce((sum, h) => sum + h, 0) + rowGap * (rows - 1);
      if (height <= limit + 0.01)
        return rows;
    }
    return 0;
  }
  function rowsHeight(shown, rows, heights, moreHeight, gap, moreRow) {
    const tallest = [];
    shown.forEach((on, i) => {
      if (on)
        tallest[(rows[i] ?? 0) - 1] = Math.max(tallest[(rows[i] ?? 0) - 1] || 0, heights[i] ?? 0);
    });
    if (shown.includes(false) && moreRow > 0)
      tallest[moreRow - 1] = Math.max(tallest[moreRow - 1] || 0, moreHeight);
    const used = tallest.filter((h) => h !== void 0);
    return used.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, used.length - 1);
  }

  // client/src/features/media-tags/layout/fit-measure.ts
  var NARROW_CARD_PX = 160;
  var SAME_WIDTH_PX = 0.01;
  function createFitMeasure(s, JE, deps) {
    function holdsGroups(slotEl) {
      return childrenOf(slotEl).some((c) => !!c.dataset.jeGroup);
    }
    function moreChipOf(slotEl) {
      const last = slotEl.lastElementChild;
      return last instanceof HTMLElement && last.classList.contains("je-tag-more") ? last : null;
    }
    function rowSlots(ctrl) {
      const slots = [];
      if (ctrl.outlet && ctrl.outlet.isConnected)
        slots.push(ctrl.outlet);
      const wrapping = ctrl.layout === "bands" ? "bottom" : "hover";
      for (const child of childrenOf(ctrl.host)) {
        if (child.classList.contains("je-tag-slot") && (child.dataset.jeSlot === wrapping || ctrl.layout === "corners" && s.CENTRE_SLOTS.has(child.dataset.jeSlot || ""))) {
          slots.push(child);
        }
      }
      return slots;
    }
    function posterStack(ctrl) {
      const slot = ctrl.layout === "caption" ? ctrl.host.querySelector(':scope > .je-tag-slot[data-je-slot="poster"]') : null;
      return slot ? [slot] : [];
    }
    function slotChips(slotEl) {
      const chips = [];
      for (const child of childrenOf(slotEl)) {
        if (child.dataset.jeGroup)
          chips.push(...childrenOf(child));
      }
      return chips;
    }
    function chipLabel(chip) {
      return chip.getAttribute("title") || chip.getAttribute("alt") || chip.querySelector(".rating-text")?.textContent?.trim() || (chip.textContent || "").trim();
    }
    function rowWidth(slotEl, style) {
      const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const width = parseFloat(style.width);
      if (!Number.isFinite(width))
        return slotEl.clientWidth - pad;
      return style.boxSizing === "border-box" ? width - pad - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0) : width;
    }
    function indicatorGapsToMeasure(ctrl) {
      if (ctrl.layout !== "corners" || ctrl.host.dataset.jeLegacy !== "1")
        return null;
      for (const child of childrenOf(ctrl.host)) {
        const slot = child;
        if (!slot.classList.contains("je-tag-slot") || slot.dataset.jeSlot !== "tr")
          continue;
        const items = childrenOf(slot);
        const needs = items.some((el, i) => !!el.dataset.jeIndicatorGap && (i > 0 && !items[i - 1]?.dataset.jeIndicatorGap || !!el.style.getPropertyValue(INDICATOR_BEFORE)));
        return needs ? slot : null;
      }
      return null;
    }
    function needsShape(ctrl) {
      return deps.shapeOfCard(ctrl.host) === null && deps.shapesInUse();
    }
    function scheduleFit(ctrl) {
      if (s.fitting || !(s.FIT_LAYOUTS.has(ctrl.layout || "") || centreSlots(ctrl).length || cornerLanguageGroups(ctrl).length || indicatorGapsToMeasure(ctrl) || needsShape(ctrl) || needsRadius(ctrl)))
        return;
      s.pendingFit.add(ctrl);
      watchSize(ctrl.host);
      if (s.fitScheduled)
        return;
      s.fitScheduled = true;
      if (typeof JE.core.dom?.afterNextPaint === "function")
        JE.core.dom.afterNextPaint(flushFit);
      else
        requestAnimationFrame(flushFit);
    }
    const fittedWidths = /* @__PURE__ */ new WeakMap();
    function watchSize(host) {
      if (typeof ResizeObserver !== "function" || fittedWidths.has(host))
        return;
      s.sizeObserver ?? (s.sizeObserver = new ResizeObserver(refitOnSizeChange));
      fittedWidths.set(host, { observed: -1, observedHeight: -1, fitted: -1, fittedHeight: -1, measured: null });
      s.sizeObserver.observe(host);
    }
    function unwatchSize(host) {
      if (!fittedWidths.has(host))
        return;
      fittedWidths.delete(host);
      s.sizeObserver?.unobserve(host);
    }
    function refitOnSizeChange(entries) {
      for (const entry of entries) {
        const host = entry.target;
        if (!(host instanceof HTMLElement))
          continue;
        const ctrl = s.controllers.get(host);
        const sizes = fittedWidths.get(host);
        if (!ctrl || !sizes || !host.isConnected) {
          unwatchSize(host);
          continue;
        }
        const width = entry.contentRect.width;
        const height = entry.contentRect.height;
        if (width <= 0)
          continue;
        sizes.observed = width;
        sizes.observedHeight = height;
        if (sizes.fitted < 0) {
          sizes.fitted = width;
          sizes.fittedHeight = height;
          continue;
        }
        const measured = sizes.measured;
        sizes.measured = null;
        if (measured && Math.abs(width - measured.width) < 1 && Math.abs(height - measured.height) < 1) {
          sizes.fitted = width;
          sizes.fittedHeight = height;
          continue;
        }
        if (Math.abs(width - sizes.fitted) < SAME_WIDTH_PX && Math.abs(height - sizes.fittedHeight) < SAME_WIDTH_PX)
          continue;
        scheduleFit(ctrl);
      }
    }
    function edgeOf(ctrl) {
      const edge = ctrl.layout === "corners" ? ctrl.host.dataset.jeEdge : void 0;
      return (edge && hasOwn(EDGE_SPACINGS, edge) ? EDGE_SPACINGS[edge] : EDGE_SPACINGS.default) ?? 6;
    }
    function needsRadius(ctrl) {
      return ctrl.host.dataset.jeEdge === "flush" && !ctrl.host.style.getPropertyValue("--je-card-radius");
    }
    function cardRadiusOf(ctrl) {
      const parent = ctrl.host.parentElement;
      const art = parent?.classList.contains("cardScalable") && parent.querySelector(".cardImageContainer") || parent;
      if (!art)
        return "0px";
      const style = getComputedStyle(art);
      return style.borderTopLeftRadius || style.borderRadius.split(" ")[0] || "0px";
    }
    function flushFit() {
      s.fitScheduled = false;
      const list = Array.from(s.pendingFit).filter((c) => c.host.isConnected && s.controllers.get(c.host) === c);
      s.pendingFit.clear();
      if (list.length === 0)
        return;
      s.fitting = true;
      try {
        const widths = list.map((ctrl) => ctrl.host.clientWidth);
        const hostHeights = list.map((ctrl, i) => (widths[i] ?? 0) > 0 ? ctrl.host.clientHeight : 0);
        list.forEach((ctrl, i) => {
          const sizes = fittedWidths.get(ctrl.host);
          if (!sizes)
            return;
          sizes.fitted = (widths[i] ?? 0) > 0 ? sizes.observed : 0;
          sizes.fittedHeight = (widths[i] ?? 0) > 0 ? sizes.observedHeight : 0;
          const moved = (widths[i] ?? 0) > 0 && sizes.observed >= 0 && (Math.abs((widths[i] ?? 0) - sizes.observed) >= 1 || Math.abs((hostHeights[i] ?? 0) - sizes.observedHeight) >= 1);
          sizes.measured = moved ? { width: widths[i] ?? 0, height: hostHeights[i] ?? 0 } : null;
        });
        const heights = list.map((ctrl, i) => needsShape(ctrl) ? hostHeights[i] ?? 0 : 0);
        const radii = list.map((ctrl, i) => (widths[i] ?? 0) > 0 && needsRadius(ctrl) ? cardRadiusOf(ctrl) : null);
        const shown = list.filter((ctrl, i) => (widths[i] ?? 0) > 0);
        const presented = /* @__PURE__ */ new Set();
        const narrowed = /* @__PURE__ */ new Set();
        list.forEach((ctrl, i) => {
          const narrow = (widths[i] ?? 0) > 0 && (widths[i] ?? 0) < NARROW_CARD_PX;
          if ((widths[i] ?? 0) === 0 || narrow === !!ctrl.narrow)
            return;
          ctrl.narrow = narrow;
          narrowed.add(ctrl);
        });
        list.forEach((ctrl, i) => {
          if (!needsShape(ctrl))
            return;
          const shape = (widths[i] ?? 0) > 0 ? shapeOfSize(widths[i] ?? 0, heights[i] ?? 0) : "portrait";
          const changed = shape !== ctrl.shape;
          ctrl.shape = shape;
          if (changed) {
            deps.presentAll(ctrl);
            presented.add(ctrl);
          }
        });
        for (const ctrl of narrowed) {
          if (ctrl.layout === "bands" && !presented.has(ctrl))
            deps.presentAll(ctrl);
        }
        list.forEach((ctrl, i) => {
          if (typeof radii[i] === "string")
            ctrl.host.style.setProperty("--je-card-radius", radii[i]);
        });
        for (const ctrl of shown)
          prepareFit(ctrl);
        const languages = shown.map(measureCornerLanguages);
        languages.forEach(deps.applyChipRows);
        const anchors = shown.map(measureAnchors);
        shown.forEach((ctrl, i) => applyAnchors(anchors[i] || []));
        const plans = shown.map((ctrl, i) => {
          const plan = measureFit(ctrl);
          plan.rows.unshift(...languages[i] || []);
          return plan;
        });
        shown.forEach((ctrl, i) => plans[i] && deps.applyFit(ctrl, plans[i]));
      } finally {
        s.fitting = false;
      }
      const bound = new Set(s.genreAfterFit);
      s.genreAfterFit.clear();
      for (const ctrl of list)
        if (ctrl.host.dataset.jeGenreBound && deps.isRevealed(ctrl.host))
          bound.add(ctrl.host);
      for (const host of bound)
        if (host.isConnected)
          deps.fitReveal(host);
    }
    function centreSlots(ctrl) {
      return ctrl.layout === "corners" ? childrenOf(ctrl.host).filter((el) => s.CENTRE_SLOTS.has(el.dataset.jeSlot || "")) : [];
    }
    function measureAnchors(ctrl) {
      const centres = centreSlots(ctrl);
      if (!centres.length)
        return [];
      const conf = deps.resolveLayout(ctrl);
      const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
      const edge = edgeOf(ctrl);
      const host = ctrl.host.getBoundingClientRect();
      const boxes = {};
      for (const el of childrenOf(ctrl.host)) {
        const slot = el.dataset.jeSlot;
        if (!["tl", "tr", "bl", "br"].includes(slot || ""))
          continue;
        boxes[slot || ""] = childrenOf(el).filter((g) => g.dataset.jeGroup).map((g) => g.getBoundingClientRect());
      }
      const width = (slots) => Math.max(edge, ...slots.flatMap((s2) => (boxes[s2] || []).map((b) => s2.endsWith("l") ? b.right - host.left + gap : host.right - b.left + gap)));
      const height = (slots) => Math.max(edge, ...slots.flatMap((s2) => (boxes[s2] || []).map((b) => s2.startsWith("t") ? b.bottom - host.top + gap : host.bottom - b.top + gap)));
      const scalable = ctrl.host.parentElement;
      const progress = scalable?.querySelector(".itemProgressBar, .cardProgressBar, .cardProgress");
      const flush = conf.edge === "flush";
      const bottom = progress ? Math.max(edge, host.bottom - progress.getBoundingClientRect().top + (flush ? 0 : gap)) : edge;
      let top = edge;
      const cornerReserve = width(["tl", "tr"]);
      let topReserve = cornerReserve;
      let overlayBottom = 0;
      for (const overlay of scalable?.querySelectorAll(".cardIndicators > *, .countIndicator, .playedIndicator") || []) {
        if (flush && overlay.querySelector(".countIndicator, .playedIndicator"))
          continue;
        const b = overlay.getBoundingClientRect();
        if (flush && (!b.width || !b.height))
          continue;
        if (b.bottom <= host.top || b.top >= host.top + host.height / 3)
          continue;
        overlayBottom = Math.max(overlayBottom, b.bottom - host.top + gap);
        const middle = host.left + host.width / 2;
        if (b.left < middle && b.right > middle)
          top = Math.max(top, b.bottom - host.top + gap);
        else
          topReserve = Math.max(topReserve, b.right <= middle ? b.right - host.left + gap : host.right - b.left + gap);
      }
      if (flush) {
        const row = centres.find((el) => el.dataset.jeSlot === "tc");
        const first = row && slotChips(row)[0];
        const firstWidth = first?.getBoundingClientRect().width || 0;
        if (top > 0 || firstWidth > host.width - 2 * topReserve + 0.01) {
          const below = Math.max(overlayBottom, height(["tl", "tr"]));
          if (below + (first?.getBoundingClientRect().height || 0) <= host.height / 2 + 0.01) {
            top = below;
            topReserve = 0;
          }
        } else
          top = 0;
      }
      const crossing = (slots, from, to) => Math.max(0, ...slots.flatMap((s2) => (boxes[s2] || []).filter((b) => b.bottom - host.top > from && b.top - host.top < to).map((b) => s2.endsWith("l") ? b.right - host.left + gap : host.right - b.left + gap)));
      const topRow = top + centreRowLimit(host.height, top);
      const bottomRow = host.height - bottom - centreRowLimit(host.height, bottom);
      topReserve = Math.max(topReserve, crossing(["bl", "br"], top, topRow));
      const bottomReserve = Math.max(width(["bl", "br"]), crossing(["tl", "tr"], bottomRow, host.height - bottom));
      return centres.map((el) => {
        const slot = el.dataset.jeSlot;
        return { el, top, bottom, reserve: slot === "tc" ? topReserve : slot === "bc" ? bottomReserve : slot === "ml" ? height(["tl", "bl"]) : slot === "mr" ? height(["tr", "br"]) : edge };
      });
    }
    function applyAnchors(anchors) {
      for (const { el, reserve, top, bottom } of anchors) {
        el.style.setProperty("--je-anchor-reserve", `${reserve}px`);
        el.style.setProperty("--je-anchor-top", `${top}px`);
        el.style.setProperty("--je-anchor-bottom", `${bottom}px`);
        el.toggleAttribute("data-je-flush-detached", el.dataset.jeSlot === "tc" && top > 0);
      }
    }
    function cornerLanguageGroups(ctrl) {
      return ctrl.layout === "corners" ? Array.from(ctrl.host.querySelectorAll(':scope > .je-tag-slot:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) > [data-je-group="language"]')).filter((group) => group.querySelector(".language-chip") && childrenOf(ctrl.host).some((slot) => slot.dataset.jeSlot === ((group.parentElement?.dataset.jeSlot || "").startsWith("t") ? "tc" : "bc") && slot.querySelector(".rating-tag"))) : [];
    }
    function measureCornerLanguages(ctrl) {
      const rows = [];
      const conf = deps.resolveLayout(ctrl);
      const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
      const inner = Math.max(0, ctrl.host.clientWidth - 2 * edgeOf(ctrl));
      for (const group of cornerLanguageGroups(ctrl)) {
        const slot = group.parentElement?.dataset.jeSlot || "";
        const centre = childrenOf(ctrl.host).find((el) => el.dataset.jeSlot === (slot.startsWith("t") ? "tc" : "bc"));
        const rating = centre?.querySelector(".rating-tag");
        const centreMore = centre && moreChipOf(centre);
        const more = moreChipOf(group);
        if (!rating || !centreMore || !more)
          continue;
        const chips = childrenOf(group).filter((chip) => chip !== more);
        if (!chips.length)
          continue;
        const rects = chips.map((chip) => chip.getBoundingClientRect());
        const ratingWidth = rating.getBoundingClientRect().width;
        const moreRect = more.getBoundingClientRect();
        const languageMinimum = Math.max(rects[0]?.width || 0, chips.length > 1 ? moreRect.width : 0);
        const fullRoom = (inner - ratingWidth) / 2 - gap;
        const minimum = languageMinimum <= fullRoom ? Math.max(ratingWidth, centreMore.getBoundingClientRect().width) : centreMore.getBoundingClientRect().width;
        const available = Math.max(rects[0]?.width || 0, (inner - minimum) / 2 - gap);
        const height = ctrl.host.clientHeight * 0.9;
        const rowGap = parseFloat(getComputedStyle(group).rowGap) || 0;
        const shown = chipsThatFit(rects.map((rect, i) => i === 0 || rect.width <= available + 0.01 ? rect.height : Infinity), height, rowGap, 1, moreRect.height);
        shown[0] = true;
        rows.push({ slot: group, chips, shown, more: moreRect.width <= available + 0.01 && (rects[0]?.height || 0) + rowGap + moreRect.height <= height });
      }
      return rows;
    }
    function prepareFit(ctrl) {
      ctrl.host.querySelector(':scope > .je-tag-slot[data-je-slot="corner"]')?.style.removeProperty(STACK_LIFT);
      for (const root of [ctrl.host, ctrl.outlet]) {
        root?.querySelectorAll("[data-je-overflow]").forEach((el) => el.removeAttribute("data-je-overflow"));
        root?.querySelectorAll(".je-tag-fit-text").forEach((text) => text.replaceWith(...text.childNodes));
        root?.querySelectorAll("[data-je-fit-width]").forEach((el) => {
          el.removeAttribute("data-je-fit-width");
          el.style.removeProperty("--je-chip-fit-width");
        });
      }
      const languages = cornerLanguageGroups(ctrl);
      for (const slotEl of [...rowSlots(ctrl), ...languages, ...posterStack(ctrl)]) {
        const count = languages.includes(slotEl) ? childrenOf(slotEl).filter((el) => !el.classList.contains("je-tag-more")).length : slotChips(slotEl).length;
        let more = moreChipOf(slotEl) || slotEl.querySelector(":scope > .je-tag-more");
        if (count === 0) {
          more?.remove();
          continue;
        }
        if (!more) {
          more = document.createElement("span");
          more.className = "je-tag-more";
        }
        if (more !== slotEl.lastElementChild)
          slotEl.appendChild(more);
        const text = `+${count}`;
        if (more.textContent !== text)
          more.textContent = text;
      }
    }
    function rowRoom(ctrl, style, slotEl) {
      const raw = style.maxHeight;
      if (slotEl === ctrl.outlet) {
        const height = parseFloat(style.height);
        return height > 0 ? { inside: height, oneRow: height, gap: parseFloat(style.rowGap) || 0 } : null;
      }
      if (!raw || raw === "none")
        return ctrl.layout === "bands" && slotEl.dataset.jeSlot === "bottom" ? bandRoom(ctrl, style) : null;
      let limit = parseFloat(raw);
      if (raw.endsWith("%")) {
        const height = ctrl.host.clientHeight;
        if (!(height > 0))
          return null;
        limit = limit / 100 * height;
      }
      if (!Number.isFinite(limit))
        return null;
      const padTop = parseFloat(style.paddingTop) || 0;
      const padBottom = parseFloat(style.paddingBottom) || 0;
      return { inside: limit - padTop - padBottom, oneRow: limit - padBottom, gap: parseFloat(style.rowGap) || 0 };
    }
    function bandRoom(ctrl, style) {
      const height = ctrl.host.clientHeight;
      const top = ctrl.host.querySelector(':scope > .je-tag-slot[data-je-slot="top"]');
      const bottoms = Array.from(top?.querySelectorAll(":scope > [data-je-group] > *") || []).map((chip) => chip.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.bottom);
      if (!(height > 0) || !bottoms.length)
        return null;
      const below = Math.max(...bottoms) - ctrl.host.getBoundingClientRect().top;
      const gap = parseFloat(style.rowGap) || 0;
      const inside = height - (parseFloat(style.paddingBottom) || 0) - below - gap;
      return { inside, oneRow: inside, gap };
    }
    function measureFit(ctrl) {
      const plan = { pillFacts: ctrl.pill ? pillFactsThatFit(ctrl.pill) : -1, rows: measurePosterStack(ctrl), indicator: measureIndicatorGaps(ctrl), stacks: measureStacks(ctrl), lift: measureCornerLift(ctrl) };
      const slots = rowSlots(ctrl);
      const sides = new Map(slots.filter((el) => ["ml", "mr"].includes(el.dataset.jeSlot || "")).map((el) => [el.dataset.jeSlot, slotChips(el).map((chip) => chip.getBoundingClientRect())]));
      const conf = deps.resolveLayout(ctrl);
      const mixedRatingSlots = new Set(cornerLanguageGroups(ctrl).map((group) => (group.parentElement?.dataset.jeSlot || "").startsWith("t") ? "tc" : "bc"));
      const innerWidth = sides.size ? Math.max(0, ctrl.host.clientWidth - 2 * edgeOf(ctrl)) : 0;
      const sideGap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
      const half = Math.max(0, (innerWidth - sideGap) / 2);
      for (const slotEl of slots) {
        const chips = slotChips(slotEl);
        const more = moreChipOf(slotEl);
        if (chips.length === 0 || !more)
          continue;
        const style = getComputedStyle(slotEl);
        const vertical = ctrl.layout === "corners" && ["ml", "mr"].includes(slotEl.dataset.jeSlot || "");
        const opposite = sides.get(slotEl.dataset.jeSlot === "ml" ? "mr" : "ml") || [];
        const oppositeWidth = Math.min(half, Math.max(0, ...opposite.map((rect) => rect.width)));
        const available = vertical ? Math.max(0, Math.min(opposite.length ? half : innerWidth, innerWidth - oppositeWidth - sideGap)) : rowWidth(slotEl, style);
        const gap = parseFloat(style.columnGap) || 0;
        const rects = chips.map((chip) => chip.getBoundingClientRect());
        const widths = rects.map((r) => r.width);
        const moreRect = more.getBoundingClientRect();
        if (!(available > 0) && ctrl.layout !== "corners") {
          plan.rows.push({ slot: slotEl, chips, shown: chips.map(() => true), more: true });
          continue;
        }
        if (ctrl.layout === "corners") {
          const measured = parseFloat(slotEl.style.getPropertyValue("--je-anchor-reserve"));
          const reserve = Number.isFinite(measured) ? measured : edgeOf(ctrl);
          const offset = parseFloat(slotEl.style.getPropertyValue(slotEl.dataset.jeSlot === "tc" ? "--je-anchor-top" : "--je-anchor-bottom"));
          const limit = Math.max(0, vertical ? ctrl.host.clientHeight - 2 * reserve : ["tc", "bc"].includes(slotEl.dataset.jeSlot || "") ? centreRowLimit(ctrl.host.clientHeight, Number.isFinite(offset) ? offset : reserve) : ctrl.host.clientHeight / 3);
          if (!vertical && ctrl.host.clientHeight > 0 && available < moreRect.width - 0.01) {
            plan.rows.push({ slot: slotEl, chips, shown: chips.map(() => false), more: false });
            continue;
          }
          const heights2 = rects.map((r) => r.height);
          const rowGap = parseFloat(style.rowGap) || 0;
          let shown2 = null;
          let fittedRows = [];
          let fittedMoreRow = 0;
          const ratingFirst = mixedRatingSlots.has(slotEl.dataset.jeSlot || "") && !!chips[0]?.matches(".rating-tag");
          const fitWidths = widths.map((width, i) => i === 0 && !ratingFirst ? Math.min(width, Math.max(0, available)) : width);
          if (vertical) {
            shown2 = chipsThatFit(heights2.map((height, i) => (fitWidths[i] ?? 0) <= available + 0.01 ? height : Infinity), limit, rowGap, 1, moreRect.height);
          } else {
            const rows = [], moreRow = { row: 0 };
            const budget2 = rowBudget(heights2, moreRect.height, limit, rowGap);
            if (budget2 > 0) {
              shown2 = chipsThatFit(fitWidths, available, gap, budget2, moreRect.width, rows, moreRow);
              fittedRows = rows;
              fittedMoreRow = moreRow.row;
            }
          }
          if (!shown2?.[0] && !ratingFirst) {
            shown2 = chips.map((_, i) => i === 0);
            fittedRows = chips.map((_, i) => i === 0 ? 1 : 0);
            fittedMoreRow = 2;
          }
          if (!shown2)
            shown2 = chips.map(() => false);
          const moreFits = vertical ? (shown2.some(Boolean) ? (heights2[0] ?? 0) + rowGap : 0) + moreRect.height <= limit : rowsHeight(shown2, fittedRows, heights2, moreRect.height, rowGap, fittedMoreRow) <= limit;
          plan.rows.push({
            slot: slotEl,
            chips,
            shown: shown2,
            fittedRows,
            fittedMoreRow,
            width: vertical ? available : void 0,
            firstWidth: !ratingFirst && (widths[0] ?? 0) > available ? Math.max(0, available) : void 0,
            more: moreFits && limit >= moreRect.height && available >= moreRect.width
          });
          continue;
        }
        const room = rowRoom(ctrl, style, slotEl);
        if (!room) {
          plan.rows.push({ slot: slotEl, chips, shown: chipsThatFit(widths, available, gap, FIT_MAX_ROWS, moreRect.width), more: true });
          continue;
        }
        const heights = rects.map((r) => r.height);
        let budget = rowBudget(heights, moreRect.height, room.inside, room.gap);
        if (budget === 0 && Math.max(moreRect.height, ...heights) <= room.oneRow + 0.01)
          budget = 1;
        const shown = chipsThatFit(widths, available, gap, budget, moreRect.width);
        plan.rows.push(budget > 0 ? { slot: slotEl, chips, shown, more: true } : { slot: slotEl, chips, shown: chips.map(() => false), more: false });
      }
      return plan;
    }
    function measurePosterStack(ctrl) {
      const slot = posterStack(ctrl)[0];
      const more = slot && moreChipOf(slot);
      if (!more)
        return [];
      const height = ctrl.host.clientHeight;
      const chips = slotChips(slot);
      const top = ctrl.host.getBoundingClientRect().top;
      const bottoms = chips.map((chip) => chip.getBoundingClientRect().bottom - top);
      const limit = height - STACK_INSET;
      if (!(height > 0) || bottoms.every((bottom) => bottom <= limit + 0.01))
        return [{ slot, chips, shown: chips.map(() => true), more: true }];
      const room = limit - more.getBoundingClientRect().height - (parseFloat(getComputedStyle(slot).rowGap) || 0);
      let fits = true;
      return [{ slot, chips, shown: bottoms.map((bottom) => fits = fits && bottom <= room + 0.01), more: true }];
    }
    function measureStacks(ctrl) {
      const slots = s.STACK_SLOTS[ctrl.layout || ""];
      if (!slots)
        return [];
      const width = Math.max(0, ctrl.host.clientWidth - 2 * STACK_INSET);
      const out = [];
      for (const slot of childrenOf(ctrl.host)) {
        if (!slots.includes(slot.dataset.jeSlot || ""))
          continue;
        for (const group of childrenOf(slot)) {
          if (!group.dataset.jeGroup)
            continue;
          for (const chip of childrenOf(group)) {
            if (chip.getBoundingClientRect().width > width + 0.01)
              out.push({ chip, width });
          }
        }
      }
      return out;
    }
    function measureCornerLift(ctrl) {
      if (ctrl.layout !== "minimal")
        return null;
      const slots = childrenOf(ctrl.host);
      const corner = slots.find((el) => el.dataset.jeSlot === "corner");
      if (!corner)
        return null;
      const dots = slots.find((el) => el.dataset.jeSlot === "dots")?.getBoundingClientRect();
      const chipRects = (slot) => Array.from(slot?.querySelectorAll(":scope > [data-je-group] > *") || []).map((chip) => ({ chip, r: chip.getBoundingClientRect() })).filter(({ r }) => r.width > 0);
      const chips = chipRects(corner);
      const conf = deps.resolveLayout(ctrl);
      const gap = 4 * (TAG_SCALES[conf.tagScale] ?? 1) * (TAG_GAPS[conf.tagGap] ?? 1);
      const meets = !!dots?.width && chips.some(({ r }) => r.left < dots.right + gap && r.top < dots.bottom && r.bottom > dots.top);
      const lift = meets ? Math.max(0, corner.getBoundingClientRect().bottom - dots.top + gap) : 0;
      const host = ctrl.host.getBoundingClientRect();
      if (!(ctrl.host.clientHeight > 0))
        return { slot: corner, lift, hidden: [] };
      const ceiling = host.top + STACK_INSET;
      const above = chipRects(slots.find((el) => el.dataset.jeSlot === "top")).map(({ r }) => r);
      const hidden = [];
      for (const { chip, r } of chips.sort((a, b) => b.r.bottom - a.r.bottom)) {
        const top = r.top - lift;
        if (hidden.length || top < ceiling - 0.01 || above.some((t) => r.left < t.right && r.right > t.left && top < t.bottom + gap - 0.01))
          hidden.push(chip);
      }
      return { slot: corner, lift, hidden };
    }
    function measureIndicatorGaps(ctrl) {
      const slot = indicatorGapsToMeasure(ctrl);
      if (!slot)
        return [];
      const items = childrenOf(slot);
      const top = slot.getBoundingClientRect().top;
      const gap = parseFloat(getComputedStyle(slot).rowGap) || 0;
      const out = [];
      items.forEach((el, i) => {
        if (!el.dataset.jeIndicatorGap)
          return;
        const prev = items[i - 1];
        out.push({ el, before: !prev || prev.dataset.jeIndicatorGap ? null : Math.max(0, prev.getBoundingClientRect().bottom + gap - top) });
      });
      return out;
    }
    function pillFactsThatFit(pill) {
      const facts = Array.from(pill.querySelectorAll(".je-tag-pill-fact"));
      const excess = pill.scrollWidth - pill.clientWidth;
      let keep = facts.length;
      let freed = 0;
      while (keep > 1 && freed < excess - 0.5) {
        const fact = facts[keep - 1];
        if (!fact)
          break;
        const sep = fact.previousElementSibling;
        freed += fact.getBoundingClientRect().width + (sep ? sep.getBoundingClientRect().width : 0);
        keep--;
      }
      return keep;
    }
    function prepareFitText(first) {
      const chip = first.matches(".awards-link, .language-link") ? first.firstElementChild : first;
      if (!chip)
        return;
      if (chip.matches(".status-tag, .quality-overlay-label, .age-rating-tag, .je-logo-text")) {
        const text = document.createElement("span");
        text.className = "je-tag-fit-text";
        text.append(...chip.childNodes);
        chip.append(text);
      } else if (chip.matches(".language-chip")) {
        for (const node of Array.from(chip.childNodes)) {
          if (node.nodeType !== 3)
            continue;
          const text = document.createElement("span");
          text.className = "je-tag-fit-text";
          node.replaceWith(text);
          text.append(node);
        }
      }
    }
    return { holdsGroups, moreChipOf, posterStack, chipLabel, scheduleFit, unwatchSize, flushFit, prepareFitText };
  }

  // client/src/features/media-tags/layout/groups.ts
  function createGroups(s, JE, deps) {
    function commitGroup(target, groupId, overlay) {
      const group = normalizeGroup(groupId);
      if (!group || !target)
        return false;
      if (!overlay || overlay.children.length === 0) {
        removeGroup(target, group);
        return false;
      }
      const ctrl = deps.controllerFor(target, true);
      if (!ctrl)
        return false;
      const conf = deps.resolveLayout(ctrl);
      const previous = ctrl.groups.get(group);
      if (!ctrl.arrived)
        ctrl.arrived = /* @__PURE__ */ new Map();
      if (!ctrl.arrived.has(group))
        ctrl.arrived.set(group, previous ? previous.seq : ++ctrl.seq);
      ctrl.groups.set(group, { master: overlay, seq: ctrl.arrived.get(group) ?? ctrl.seq });
      if (ctrl.layout !== conf.layout || ctrl.lookKey !== conf.lookKey) {
        deps.presentAll(ctrl);
      } else if (!deps.isAwaiting(ctrl.host)) {
        deps.presentGroup(ctrl, conf, group);
        if (conf.layout === "summary")
          deps.refreshPill(ctrl, conf);
        deps.syncIndicatorGap(ctrl, conf);
        deps.scheduleFit(ctrl);
      }
      return true;
    }
    function removeGroup(target, groupId) {
      const group = normalizeGroup(groupId);
      const ctrl = target ? deps.controllerFor(target, false) : null;
      if (!group || !ctrl || !ctrl.groups.has(group))
        return;
      ctrl.groups.delete(group);
      deps.removeNodes(ctrl, group);
      if (deps.isAwaiting(ctrl.host))
        return;
      const conf = deps.resolveLayout(ctrl);
      if (conf.layout === "summary")
        deps.refreshPill(ctrl, conf);
      deps.syncIndicatorGap(ctrl, conf);
      deps.scheduleFit(ctrl);
    }
    function hasGroup(target, groupId) {
      const group = normalizeGroup(groupId);
      const ctrl = target ? deps.controllerFor(target, false) : null;
      return !!(group && ctrl && ctrl.groups.has(group));
    }
    function getGroup(target, groupId) {
      const group = normalizeGroup(groupId);
      const ctrl = target ? deps.controllerFor(target, false) : null;
      return group && ctrl?.groups.get(group)?.master || null;
    }
    function refreshPresentation(targets) {
      const list = targets === void 0 ? Array.from(document.querySelectorAll(".je-tag-host")) : Array.isArray(targets) ? targets : [targets];
      for (const target of list) {
        const ctrl = deps.controllerFor(target, false);
        if (ctrl && ctrl.host.isConnected)
          deps.presentAll(ctrl);
      }
    }
    function describe(target) {
      const ctrl = target ? deps.controllerFor(target, false) : null;
      if (!ctrl)
        return [];
      const conf = deps.resolveLayout(ctrl);
      return Array.from(ctrl.groups.entries()).sort((a, b) => a[1].seq - b[1].seq).map(([group, rec]) => ({
        group,
        slot: conf.slots[group] === "caption" && !ctrl.outlet ? "poster" : conf.slots[group] || "off",
        seq: rec.seq,
        element: ctrl.nodes.get(group)?.[0] || null
      }));
    }
    function clearCard(target) {
      if (target?.dataset)
        delete target.dataset.jeReviewKey;
      if (target)
        s.cardData.delete(target);
      const host = deps.findHost(target);
      if (!host)
        return;
      s.cardData.delete(host);
      if (host.parentElement)
        s.cardData.delete(host.parentElement);
      delete host.dataset.jeReviewKey;
      deps.endAwait(host);
      const ctrl = host ? s.controllers.get(host) : null;
      if (!ctrl)
        return;
      forget(ctrl);
    }
    function forget(ctrl) {
      if (deps.contextOf(s.awaitingData, ctrl.host)?.cardId === ctrl.itemId)
        deps.endAwait(ctrl.host);
      deps.teardown(ctrl);
      s.controllers.delete(ctrl.host);
      deps.unwatchSize(ctrl.host);
      JE.tagPosterColours?.release(ctrl.host);
    }
    function removeGroupEverywhere(groupId) {
      for (const host of document.querySelectorAll(".je-tag-host")) {
        const reserve = deps.reservesCaption(deps.resolveLayout(s.controllers.get(host) || host), host);
        removeGroup(host, groupId);
        const ctrl = reserve ? null : s.controllers.get(host);
        if (ctrl?.outlet && !deps.holdsGroups(ctrl.outlet)) {
          ctrl.outlet.remove();
          ctrl.outlet = null;
        }
      }
    }
    function clearAll() {
      for (const host of document.querySelectorAll(".je-tag-host"))
        clearCard(host);
      document.querySelectorAll(".je-tag-caption").forEach((el) => el.remove());
      document.querySelectorAll("[data-je-review-key]").forEach((el) => {
        delete el.dataset.jeReviewKey;
      });
    }
    function prepareCard(target) {
      if (!target || !deps.reservesCaption(deps.resolveLayout(deps.findHost(target) || target), target))
        return;
      const host = deps.ensureHost(target);
      if (!host || deps.isIgnoredContext(host))
        return;
      const ctrl = deps.controllerFor(host, true);
      if (ctrl && (ctrl.layout !== "caption" || !ctrl.outlet?.isConnected && deps.captionAnchor(ctrl.host)))
        deps.presentAll(ctrl);
    }
    function syncBodyClasses() {
      if (!document.body)
        return;
      document.body.classList.toggle("je-tags-hide-on-hover", !!JE.currentSettings?.tagsHideOnHover);
    }
    function reinitialize() {
      deps.invalidateSettings();
      syncBodyClasses();
      if (s.reinitPending)
        return s.reinitPending;
      s.reinitPending = Promise.resolve().then(() => {
        s.reinitPending = null;
        deps.invalidateSettings();
        const owned = /* @__PURE__ */ new Set();
        for (const host of document.querySelectorAll(".je-tag-host")) {
          const el = host;
          const reserve = deps.reservesCaption(deps.resolveLayout(s.controllers.get(el) || el), el);
          const ctrl = deps.controllerFor(el, reserve && !deps.isIgnoredContext(el));
          if (!ctrl)
            continue;
          deps.presentAll(ctrl);
          if (ctrl.outlet)
            owned.add(ctrl.outlet);
        }
        document.querySelectorAll(".je-tag-caption").forEach((el) => {
          if (!owned.has(el))
            el.remove();
        });
        document.dispatchEvent(new CustomEvent("je:tag-layout-changed"));
      });
      return s.reinitPending;
    }
    return { commitGroup, removeGroup, hasGroup, getGroup, refreshPresentation, describe, clearCard, forget, removeGroupEverywhere, clearAll, prepareCard, reinitialize };
  }

  // client/src/features/media-tags/layout/looks.ts
  function createLooks(s, JE, deps) {
    function requireLook() {
      const look = JE.core.tagLook;
      if (!look)
        throw new Error("Tag looks must load before resolving item rules");
      return look;
    }
    const normalizeSettings2 = (settings, plugin) => normalizeSettings(settings ?? JE.currentSettings, plugin ?? JE.pluginConfig);
    const isLegacySettings2 = (settings) => isLegacySettings(settings ?? JE.currentSettings);
    const singleChipGroup2 = (group, config = JE.pluginConfig) => singleChipGroup(group, config);
    const promoteLegacySettings2 = (settings) => {
      const source = settings ?? JE.currentSettings;
      const changed = promoteLegacySettings(source);
      if (changed && source === JE.currentSettings) invalidateSettings();
      return changed;
    };
    const lookSettingsCache = /* @__PURE__ */ new Map();
    const lookSettings2 = (base, look, locked) => {
      const settings = lookSettings(base, look, locked, JE.currentSettings, JE.pluginConfig);
      const key = settings.lookKey + "|" + (settings.order ? "o" : "");
      const cached = lookSettingsCache.get(key);
      if (cached)
        return cached;
      lookSettingsCache.set(key, settings);
      return settings;
    };
    function applySize(element, conf) {
      element.style.setProperty("--je-tag-scale", String(TAG_SCALES[conf.tagScale] ?? 1));
      element.style.setProperty("--je-tag-gap", String(TAG_GAPS[conf.tagGap] ?? 1));
    }
    function settingsSource() {
      const s2 = JE.currentSettings;
      return { settings: s2, plugin: JE.pluginConfig, enabled: DEFAULT_ORDER.map((g) => s2?.[ENABLED_SETTING[g]] ? "1" : "0").join("") };
    }
    function currentSettings() {
      const source = settingsSource();
      if (!s.cachedSettings || !s.cachedSource || s.cachedSource.settings !== source.settings || s.cachedSource.plugin !== source.plugin || s.cachedSource.enabled !== source.enabled) {
        s.cachedSettings = normalizeSettings2();
        s.cachedSource = source;
      }
      return s.cachedSettings;
    }
    function invalidateSettings() {
      lookSettingsCache.clear();
      s.cachedSettings = null;
      s.cachedLooks = null;
    }
    function currentLooks() {
      if (!s.cachedLooks)
        s.cachedLooks = JE.core.tagLook?.read() || { rules: [], locks: /* @__PURE__ */ new Map(), overrides: /* @__PURE__ */ new Map() };
      if (!s.cachedLooks.overrides)
        s.cachedLooks.overrides = /* @__PURE__ */ new Map();
      return s.cachedLooks;
    }
    function injectStyles() {
      if (s.stylesInjected || typeof deps.api.buildStyles !== "function" || !JE.core.ui?.injectCss)
        return;
      s.stylesInjected = true;
      JE.core.ui.injectCss("je-tag-layout", deps.api.buildStyles());
      window.addEventListener("resize", refitOnResize, { passive: true });
    }
    function refitOnResize() {
      if (s.resizeQueued)
        return;
      s.resizeQueued = true;
      requestAnimationFrame(() => {
        s.resizeQueued = false;
        for (const host of document.querySelectorAll(".je-tag-host")) {
          const ctrl = s.controllers.get(host);
          if (ctrl)
            deps.scheduleFit(ctrl);
        }
      });
    }
    return { requireLook, normalizeSettings: normalizeSettings2, isLegacySettings: isLegacySettings2, singleChipGroup: singleChipGroup2, promoteLegacySettings: promoteLegacySettings2, lookSettings: lookSettings2, applySize, settingsSource, currentSettings, invalidateSettings, currentLooks, injectStyles };
  }

  // client/src/features/media-tags/layout/present.ts
  var PILL_MAX_FACTS = 3;
  function createPresent(s, JE, deps) {
    function applyDensityAndCap(group, node, conf) {
      if (conf.density === "compact") {
        if (group === "quality") {
          for (const chip of node.querySelectorAll(".quality-overlay-label")) {
            const text = chip.textContent || "";
            const short = chip.dataset.jeCompact || compactQualityLabel(text);
            if (short !== text)
              chip.textContent = short;
          }
        } else if (group === "rating") {
          for (const chip of node.querySelectorAll(".rating-tag--source"))
            chip.dataset.jeRatingCompact = "1";
          if (node.querySelector(".rating-tag-tmdb"))
            node.querySelector(".rating-tag-critic")?.remove();
        } else if (group === "status") {
          for (const chip of node.querySelectorAll("[data-je-compact]")) {
            chip.textContent = chip.dataset.jeCompact || chip.textContent;
          }
        }
      }
      const cap = conf.caps[group];
      if (cap > 0) {
        while (node.children.length > cap)
          node.lastElementChild?.remove();
      }
    }
    function buildChips(group, master, conf, host) {
      const node = cloneElement(master);
      node.dataset.jeGroup = group;
      for (const img of node.querySelectorAll("img"))
        img.onerror = () => img.remove();
      applyDensityAndCap(group, node, conf);
      if ((group === "language" || group === "awards") && host) {
        const link = deps.cardLinkOf(host);
        if (link?.matches("a[href]") && !link.contains(host)) {
          for (const chip of childrenOf(node)) {
            const anchor = document.createElement("a");
            anchor.className = group === "language" ? "language-link" : "awards-link";
            anchor.href = link.getAttribute("href") || "";
            anchor.title = chip.getAttribute("title") || "";
            anchor.setAttribute("tabindex", "-1");
            for (const attr of ["target", "rel"]) {
              if (link.hasAttribute(attr))
                anchor.setAttribute(attr, link.getAttribute(attr) || "");
            }
            chip.replaceWith(anchor);
            anchor.appendChild(chip);
          }
        }
      }
      return node;
    }
    function buildDots(master, conf) {
      const copy = buildChips("quality", master, { ...conf, density: "full" });
      const labels = [];
      const dots = document.createElement("div");
      dots.className = "je-tag-dots";
      dots.dataset.jeGroup = "quality";
      for (const chip of childrenOf(copy)) {
        const label = chip.textContent || "";
        const kind = s.DOT_KIND.find(([cls]) => !!cls && chip.classList.contains(cls))?.[1] || "codec";
        const dot = document.createElement("span");
        dot.className = "je-tag-dot";
        dot.dataset.jeDot = kind;
        dot.title = label;
        dot.setAttribute("aria-hidden", "true");
        dots.appendChild(dot);
        labels.push(label);
      }
      if (labels.length === 0)
        return null;
      dots.setAttribute("role", "img");
      dots.setAttribute("aria-label", labels.join(", "));
      dots.title = labels.join(" · ");
      return dots;
    }
    function pillFact(group, master) {
      switch (group) {
        case "quality": {
          const labels = Array.from(master.querySelectorAll(".quality-overlay-label"));
          const resolution = labels.find((l) => l.classList.contains("resolution"))?.textContent || "";
          const range = labels.map((l) => l.dataset.quality || "").find((q) => s.DYNAMIC_RANGE.includes(q)) || "";
          const text = [resolution, range ? compactQualityLabel(range) : ""].filter(Boolean).join(" ") || labels[0]?.textContent || "";
          return text ? { text } : null;
        }
        case "rating": {
          const source = master.querySelector(".rating-tag--source");
          if (source)
            return { text: source.getAttribute("aria-label") || source.textContent };
          const community = master.querySelector(".rating-tag-tmdb .rating-text")?.textContent;
          if (community)
            return { text: community, glyph: "★" };
          const critic = master.querySelector(".rating-tag-critic .rating-text")?.textContent;
          if (critic)
            return { text: critic };
          const review = master.querySelector(".je-userreview-tag .rating-text")?.textContent;
          return review ? { text: review, glyph: "♥" } : null;
        }
        case "awards": {
          const chip = childrenOf(master)[0];
          return chip ? { text: chip.textContent, title: chip.title } : null;
        }
        case "status":
        case "ageRating": {
          const text = (master.firstElementChild?.textContent || "").trim();
          return text ? { text } : null;
        }
        case "language": {
          const first = childrenOf(master)[0];
          if (first?.classList.contains("language-code") || first?.classList.contains("language-count-badge")) {
            const copy = cloneElement(first);
            const marker = copy.querySelector(".language-cc");
            const glyph = marker?.textContent || void 0;
            marker?.remove();
            return { text: (copy.textContent || "").trim(), glyph, title: first.getAttribute("title") || void 0 };
          }
          const img = first instanceof HTMLImageElement ? first : first?.querySelector("img");
          if (!img)
            return null;
          const flag = cloneElement(img);
          flag.className = "je-tag-pill-flag";
          flag.onerror = () => flag.remove();
          return {
            text: img.getAttribute("alt") || "",
            title: first?.getAttribute("title") || void 0,
            glyph: first?.querySelector(".language-cc")?.textContent || void 0,
            flag
          };
        }
        case "genre": {
          const text = master.querySelector(".genre-tag")?.getAttribute("title") || "";
          return text ? { text } : null;
        }
        case "logos": {
          const text = master.querySelector(".je-logo-chip")?.getAttribute("title") || "";
          return text ? { text } : null;
        }
        case "custom": {
          const text = childrenOf(master)[0]?.dataset.jeCustom || "";
          return text ? { text } : null;
        }
        default:
          return null;
      }
    }
    function rankOf(ctrl, conf, group) {
      if (conf.order)
        return conf.order.indexOf(group);
      return ctrl.groups.get(group)?.seq ?? Number.MAX_SAFE_INTEGER;
    }
    function slotElement(ctrl, slot) {
      if (slot === "caption")
        return ensureOutlet(ctrl);
      for (const child of childrenOf(ctrl.host)) {
        if (child.classList.contains("je-tag-slot") && child.dataset.jeSlot === slot) {
          return child;
        }
      }
      const el = document.createElement("div");
      el.className = "je-tag-slot";
      el.dataset.jeSlot = slot;
      const rank = s.SLOT_ORDER.indexOf(slot);
      const children = childrenOf(ctrl.host);
      const isSlot = (child) => child.classList.contains("je-tag-slot");
      let next = children.find((child) => isSlot(child) && s.SLOT_ORDER.indexOf(child.dataset.jeSlot || "") > rank);
      if (!next) {
        let last = -1;
        children.forEach((child, i) => {
          if (isSlot(child))
            last = i;
        });
        next = last >= 0 ? children[last + 1] : void 0;
      }
      if (next)
        ctrl.host.insertBefore(el, next);
      else
        ctrl.host.appendChild(el);
      return el;
    }
    function ensureOutlet(ctrl) {
      if (ctrl.outlet && ctrl.outlet.isConnected)
        return ctrl.outlet;
      const anchor = deps.captionAnchor(ctrl.host);
      if (!anchor)
        return null;
      let outlet = childrenOf(anchor.parent).find((c) => c.classList.contains("je-tag-caption")) || null;
      if (!outlet) {
        outlet = document.createElement("div");
        outlet.className = "je-tag-slot je-tag-caption";
        outlet.dataset.jeSlot = "caption";
        anchor.parent.insertBefore(outlet, anchor.before);
      }
      outlet.dataset.jeOwner = String(++s.outletSeq);
      outlet.replaceChildren();
      ctrl.outlet = outlet;
      return ctrl.outlet;
    }
    function reservesCaption(conf, el) {
      if (!conf.reserveCaption)
        return false;
      const scopes = JE.core.tagScopes;
      if (!scopes)
        return true;
      return DEFAULT_ORDER.some((g) => conf.slots[g] === "caption" && !!JE.currentSettings?.[ENABLED_SETTING[g]] && !scopes.excludes(g, el));
    }
    function placeSorted(ctrl, conf, slotEl, node) {
      if (!slotEl)
        return;
      const rank = rankOf(ctrl, conf, normalizeGroup(node.dataset.jeGroup) || "quality");
      let before = null;
      for (const sibling of childrenOf(slotEl)) {
        const group = normalizeGroup(sibling.dataset.jeGroup);
        if (group && rankOf(ctrl, conf, group) > rank) {
          before = sibling;
          break;
        }
      }
      slotEl.insertBefore(node, before || deps.moreChipOf(slotEl));
    }
    function removeNodes(ctrl, group) {
      const nodes = ctrl.nodes.get(group);
      if (!nodes)
        return;
      ctrl.nodes.delete(group);
      for (const node of nodes) {
        const slot = node.parentElement;
        node.remove();
        if (slot && slot !== ctrl.outlet && slot.classList.contains("je-tag-slot") && !deps.holdsGroups(slot))
          slot.remove();
      }
    }
    function effectiveSlot(ctrl, conf, group) {
      const slot = conf.slots[group] || "off";
      if (slot === "caption" && !ensureOutlet(ctrl))
        return "poster";
      return slot;
    }
    function refreshPill(ctrl, conf) {
      if (ctrl.pill) {
        const slot = ctrl.pill.parentElement;
        ctrl.pill.remove();
        if (slot && slot.children.length === 0)
          slot.remove();
        ctrl.pill = null;
      }
      if (conf.layout !== "summary")
        return;
      const groups = Array.from(ctrl.groups.keys()).filter((g) => conf.slots[g] === "pill").sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
      const facts = [];
      for (const group of groups) {
        const master = ctrl.groups.get(group)?.master;
        if (!master)
          continue;
        const shown = buildChips(group, master, conf);
        const fact = pillFact(group, shown);
        if (fact)
          facts.push({ group, ...fact });
        if (facts.length >= PILL_MAX_FACTS)
          break;
      }
      if (facts.length === 0)
        return;
      const link = facts.some((f) => f.group === "language" || f.group === "awards") ? deps.cardLinkOf(ctrl.host) : null;
      const pill = document.createElement(link?.matches("a[href]") && !link.contains(ctrl.host) ? "a" : "div");
      if (pill.tagName === "A" && link) {
        pill.setAttribute("href", link.getAttribute("href") || "");
        pill.setAttribute("tabindex", "-1");
        for (const attr of ["target", "rel"]) {
          if (link.hasAttribute(attr))
            pill.setAttribute(attr, link.getAttribute(attr) || "");
        }
      }
      pill.className = "je-tag-pill";
      const spoken = [];
      facts.forEach((fact, i) => {
        if (i > 0) {
          const sep = document.createElement("span");
          sep.className = "je-tag-pill-sep";
          sep.setAttribute("aria-hidden", "true");
          sep.textContent = "·";
          pill.appendChild(sep);
        }
        const span = document.createElement("span");
        span.className = "je-tag-pill-fact";
        span.dataset.jeGroup = fact.group;
        if (fact.title)
          span.title = fact.title;
        if (fact.glyph) {
          const glyph = document.createElement("span");
          glyph.className = fact.group === "language" ? "language-cc" : "je-tag-pill-glyph";
          glyph.setAttribute("aria-hidden", "true");
          glyph.textContent = fact.glyph;
          span.append(glyph, " ");
        }
        if (fact.flag) {
          span.appendChild(fact.flag);
        } else {
          span.append(fact.text);
        }
        pill.appendChild(span);
        spoken.push(fact.title || fact.text);
      });
      pill.title = spoken.join(" · ");
      pill.setAttribute("aria-label", spoken.join(", "));
      slotElement(ctrl, "pill")?.appendChild(pill);
      ctrl.pill = pill;
    }
    function presentGroup(ctrl, conf, group) {
      removeNodes(ctrl, group);
      const rec = ctrl.groups.get(group);
      if (!rec)
        return;
      const slot = effectiveSlot(ctrl, conf, group);
      if (slot === "off")
        return;
      const nodes = [];
      if (slot === "dots") {
        const dots = buildDots(rec.master, conf);
        if (dots) {
          placeSorted(ctrl, conf, slotElement(ctrl, "dots"), dots);
          nodes.push(dots);
        }
      } else if (slot !== "pill") {
        const chips = buildChips(group, rec.master, slot === "hover" || conf.layout === "bands" && ctrl.narrow ? revealSettings(conf) : conf, ctrl.host);
        if (conf.layout === "corners")
          chips.dataset.jeCorner = SLOT_TO_POSITION[slot];
        if (conf.layout === "corners" && conf.legacy && conf.indicatorGap.has(group))
          chips.dataset.jeIndicatorGap = "1";
        if (chips.children.length > 0) {
          placeSorted(ctrl, conf, slotElement(ctrl, slot), chips);
          nodes.push(chips);
        }
      }
      if (s.SUMMARY_SLOTS.has(slot) && (conf.layout === "summary" || conf.layout === "minimal")) {
        const full = buildChips(group, rec.master, revealSettings(conf), ctrl.host);
        if (full.children.length > 0) {
          placeSorted(ctrl, conf, slotElement(ctrl, "hover"), full);
          nodes.push(full);
        }
      }
      ctrl.nodes.set(group, nodes);
    }
    function syncIndicatorGap(ctrl, conf) {
      const on = conf.layout === "corners" && !conf.legacy && Array.from(ctrl.groups.keys()).some((g) => conf.indicatorGap.has(g) && (ctrl.nodes.get(g)?.length || 0) > 0);
      if (on)
        ctrl.host.dataset.jeIndicatorGap = "1";
      else
        delete ctrl.host.dataset.jeIndicatorGap;
    }
    function teardown(ctrl) {
      for (const group of Array.from(ctrl.nodes.keys()))
        removeNodes(ctrl, group);
      ctrl.pill?.remove();
      ctrl.pill = null;
      for (const child of childrenOf(ctrl.host)) {
        if (child.classList.contains("je-tag-slot"))
          child.remove();
      }
      ctrl.outlet?.remove();
      ctrl.outlet = null;
      deps.describeHidden(ctrl, []);
      ctrl.layout = null;
      ctrl.lookKey = "";
      ctrl.host.style.removeProperty("--je-tag-scale");
      ctrl.host.style.removeProperty("--je-tag-gap");
      delete ctrl.host.dataset.jeLayout;
      delete ctrl.host.dataset.jeLegacy;
      delete ctrl.host.dataset.jeLocked;
      delete ctrl.host.dataset.jeIndicatorGap;
      delete ctrl.host.dataset.jeShape;
      delete ctrl.host.dataset.jeEdge;
      delete ctrl.host.dataset.jeGenreBound;
    }
    function presentAll(ctrl) {
      ctrl.pendingPresentation = false;
      const declaredShape = deps.shapeOfCard(ctrl.host);
      if (declaredShape)
        ctrl.shape = declaredShape;
      const conf = deps.resolveLayout(ctrl);
      const shaped = deps.shapesInUse();
      teardown(ctrl);
      ctrl.layout = conf.layout;
      ctrl.lookKey = conf.lookKey;
      ctrl.host.dataset.jeLayout = conf.layout;
      deps.applySize(ctrl.host, conf);
      if (shaped) {
        if (ctrl.shape === null) {
          ctrl.lookKey = "";
          deps.scheduleFit(ctrl);
          return;
        }
        ctrl.host.dataset.jeShape = ctrl.shape;
      }
      if (conf.legacy)
        ctrl.host.dataset.jeLegacy = "1";
      if (reservesCaption(conf, ctrl.host) && !deps.isIgnoredContext(ctrl.host)) {
        const outlet = ensureOutlet(ctrl);
        if (outlet)
          deps.applySize(outlet, conf);
      }
      if (conf.locked)
        ctrl.host.dataset.jeLocked = "1";
      if (conf.layout === "corners" && conf.edge && conf.edge !== "default")
        ctrl.host.dataset.jeEdge = conf.edge;
      if (deps.isAwaiting(ctrl.host))
        return;
      const groups = Array.from(ctrl.groups.keys()).sort((a, b) => rankOf(ctrl, conf, a) - rankOf(ctrl, conf, b));
      for (const group of groups)
        presentGroup(ctrl, conf, group);
      refreshPill(ctrl, conf);
      syncIndicatorGap(ctrl, conf);
      deps.scheduleFit(ctrl);
      JE.tagPosterColours?.track(ctrl.host);
    }
    return { reservesCaption, removeNodes, refreshPill, presentGroup, syncIndicatorGap, teardown, presentAll };
  }

  // client/src/features/media-tags/layout/tag-layout.ts
  function createTagLayout(JE) {
    const s = createLayoutState();
    const deps = {};
    Object.assign(deps, createLooks(s, JE, deps));
    Object.assign(deps, createCardContext(s, JE, deps));
    Object.assign(deps, createPresent(s, JE, deps));
    Object.assign(deps, createFitMeasure(s, JE, deps));
    Object.assign(deps, createFitApply(s, JE, deps));
    Object.assign(deps, createGroups(s, JE, deps));
    JE.session?.onUserChange?.("tag-layout", () => {
      deps.invalidateSettings();
      deps.clearAll();
      s.cardData = /* @__PURE__ */ new WeakMap();
      s.awaitingData = /* @__PURE__ */ new WeakMap();
    });
    const VOCABULARY_KEYS = {
      group: {},
      slot: {},
      language: {},
      tab: {},
      adminTab: {},
      field: {},
      builtin: {},
      "type": {
        "movie": "jellyseerr_card_badge_movie",
        "series": "tag_looks_type_series",
        "season": "jellyseerr_report_issue_season",
        "episode": "jellyseerr_report_issue_episode",
        "boxset": "jellyseerr_card_badge_collection",
        "video": "jellyseerr_report_issue_type_video"
      },
      "layout": {
        "corners": "tag_looks_layout_corners",
        "bands": "tag_looks_layout_bands",
        "caption": "panel_settings_ui_tag_slot_caption_caption",
        "summary": "tag_layout_summary",
        "minimal": "tag_looks_layout_minimal"
      },
      "edge": {
        "default": "common_default",
        "tight": "panel_settings_ui_tag_edge_tight",
        "flush": "panel_settings_ui_tag_edge_flush"
      },
      "gap": {
        "tight": "panel_settings_ui_tag_edge_tight",
        "default": "common_default",
        "roomy": "tag_gap_roomy"
      },
      "preset": {
        "default": "common_default",
        "glass": "panel_settings_ui_tag_style_preset_glass",
        "outline": "panel_settings_ui_tag_style_preset_outline",
        "dark": "panel_settings_ui_tag_style_preset_dark",
        "light": "panel_settings_ui_tag_style_preset_light",
        "mono": "panel_settings_ui_tag_style_preset_mono",
        "poster": "panel_settings_ui_tag_style_preset_poster"
      }
    };
    VOCABULARY_KEYS.group = {
      "status": "panel_settings_ui_tag_group_status",
      "quality": "panel_settings_ui_tag_group_quality",
      "rating": "panel_settings_ui_tag_group_rating",
      "age_rating": "panel_settings_ui_tag_group_age_rating",
      "logos": "common_logos",
      "language": "panel_settings_ui_tag_group_language",
      "genre": "common_genre",
      "custom": "common_custom",
      "awards": "awards_label"
    };
    VOCABULARY_KEYS.slot = {
      "off": "panel_settings_ui_tag_slot_off",
      "corners_tl": "panel_settings_ui_tag_slot_corners_tl",
      "corners_tc": "panel_settings_ui_tag_slot_corners_tc",
      "corners_bc": "panel_settings_ui_tag_slot_corners_bc",
      "corners_ml": "panel_settings_ui_tag_slot_corners_ml",
      "corners_mr": "panel_settings_ui_tag_slot_corners_mr",
      "corners_c": "panel_settings_ui_tag_slot_corners_c",
      "corners_tr": "panel_settings_ui_tag_slot_corners_tr",
      "corners_bl": "panel_settings_ui_tag_slot_corners_bl",
      "corners_br": "panel_settings_ui_tag_slot_corners_br",
      "bands_top": "panel_settings_ui_tag_slot_bands_top",
      "bands_bottom": "panel_settings_ui_tag_slot_bands_bottom",
      "caption_poster": "panel_settings_ui_tag_slot_caption_poster",
      "caption_caption": "panel_settings_ui_tag_slot_caption_caption",
      "summary_pill": "panel_settings_ui_tag_slot_summary_pill",
      "summary_hover": "panel_settings_ui_tag_slot_summary_hover",
      "minimal_top": "panel_settings_ui_tag_slot_minimal_top",
      "minimal_dots": "panel_settings_ui_tag_slot_minimal_dots",
      "minimal_corner": "panel_settings_ui_tag_slot_minimal_corner",
      "minimal_hover": "panel_settings_ui_tag_slot_summary_hover"
    };
    VOCABULARY_KEYS.language = {
      "partial_tooltip": "language_tags_partial_tooltip",
      "audio": "jellyseerr_report_issue_type_audio",
      "subtitles": "jellyseerr_report_issue_type_subtitles",
      "style": "panel_settings_subtitles_style",
      "flags": "language_tags_flags",
      "codes": "language_tags_codes",
      "count_badge": "language_tags_count_badge",
      "badge_off": "track_off",
      "badge_only": "language_tags_badge_only",
      "badge_both": "language_tags_badge_both",
      "dual": "language_tags_dual",
      "multi": "language_tags_multi",
      "count_tooltip": "language_tags_count_tooltip",
      "subtitles_sdh": "language_tags_subtitles_sdh"
    };
    VOCABULARY_KEYS.tab = {
      "layout": "common_layout",
      "groups": "common_groups",
      "badges": "panel_media_tags_tab_badges",
      "badges_short": "common_badges",
      "rules": "panel_media_tags_tab_rules",
      "rules_short": "common_rules",
      "colours": "common_colours",
      "server": "common_server",
      "server_name": "panel_media_tags_tab_server_name"
    };
    VOCABULARY_KEYS.adminTab = {
      "overview": "admin_tags_tab_overview",
      "layout": "admin_tags_tab_layout",
      "groups": "common_groups",
      "rules": "common_rules",
      "colours": "common_colours",
      "badges": "panel_media_tags_tab_badges",
      "server": "common_server"
    };
    VOCABULARY_KEYS.field = {
      "library": "tag_looks_field_library",
      "type": "tag_looks_field_type",
      "genre": "common_genre",
      "agerating": "tag_looks_field_agerating"
    };
    VOCABULARY_KEYS.builtin = {
      "cinephile": "tag_presets_builtin_cinephile",
      "cinephile_desc": "tag_presets_builtin_cinephile_desc",
      "minimal": "tag_looks_layout_minimal",
      "minimal_desc": "tag_presets_builtin_minimal_desc",
      "kids": "tag_presets_builtin_kids",
      "kids_desc": "tag_presets_builtin_kids_desc"
    };
    function sizeLabel(kind, value) {
      return kind === "scale" ? `${Math.round((TAG_SCALES[value] ?? 1) * 100)}%` : JE.t(VOCABULARY_KEYS.gap[value] || "");
    }
    const api = {
      sizeLabel,
      VOCABULARY_KEYS,
      isLegacySettings: deps.isLegacySettings,
      GROUPS: DEFAULT_ORDER.slice(),
      LAYOUT_SLOTS,
      DEFAULT_ORDER: DEFAULT_ORDER.slice(),
      DEFAULT_CAPS: { ...DEFAULT_CAPS },
      MAX_CAP,
      preserveLegacySizing,
      TAG_SCALES,
      TAG_GAPS,
      readScale,
      readGap,
      EDGE_SPACINGS: { ...EDGE_SPACINGS },
      DEFAULT_PROFILES,
      SHAPES: SHAPES.slice(),
      RECOMMENDED_SHAPES,
      CONTAINER_CLASS: s.CONTAINER_CLASS,
      SLOT_TO_POSITION,
      POSITION_TO_SLOT,
      POSITION_SETTINGS,
      buildStyles: null,
      normalizeGroup,
      readEdge,
      normalizeSettings: deps.normalizeSettings,
      promoteLegacySettings: deps.promoteLegacySettings,
      invalidateSettings: deps.invalidateSettings,
      resolveLayout: deps.resolveLayout,
      lookSource: deps.lookSource,
      setPreviewLook: deps.setPreviewLook,
      shapeOf: deps.shapeOf,
      shapeOfCard: deps.shapeOfCard,
      readShapeOverrides,
      shapesToWire,
      setCardContext: deps.setCardContext,
      cardIdentity: deps.cardIdentity,
      awaitCardContext: deps.awaitCardContext,
      releaseCardContext: deps.releaseCardContext,
      resumePresentation: deps.resumePresentation,
      ensureHost: deps.ensureHost,
      commitGroup: deps.commitGroup,
      removeGroup: deps.removeGroup,
      hasGroup: deps.hasGroup,
      getGroup: deps.getGroup,
      refreshPresentation: deps.refreshPresentation,
      describe: deps.describe,
      clearCard: deps.clearCard,
      clearAll: deps.clearAll,
      removeGroupEverywhere: deps.removeGroupEverywhere,
      prepareCard: deps.prepareCard,
      compactQualityLabel,
      singleChipGroup: deps.singleChipGroup,
      reinitialize: deps.reinitialize,
      flushFit: deps.flushFit,
      fitReveal: deps.fitReveal,
      chipsThatFit,
      rowsHeight,
      rowBudget,
      isGroup: (name) => normalizeGroup(name) !== null
    };
    Object.assign(deps, { api });
    return api;
  }

  // client/src/features/media-tags/layout/tag-layout-entry.ts
  var bridge = tagRulesHost();
  bridge.core ?? (bridge.core = {});
  var layout = createTagLayout({
    get currentSettings() {
      return bridge.currentSettings || {};
    },
    get pluginConfig() {
      return bridge.pluginConfig || {};
    },
    core: {
      get tagLook() {
        return bridge.core?.tagLook;
      },
      ui: { injectCss: (id, css) => bridge.core?.ui?.injectCss(id, css) },
      dom: { afterNextPaint: (callback) => bridge.core?.dom?.afterNextPaint ? bridge.core.dom.afterNextPaint(callback) : requestAnimationFrame(callback) },
      tagRenderer: { isIgnoredContext: (element) => bridge.core?.tagRenderer?.isIgnoredContext(element) ?? false },
      tagScopes: { excludes: (group, element) => bridge.core?.tagScopes?.excludes(group, element) ?? false }
    },
    // Resolve these services at call time: their ordered entries follow the layout.
    tagPosterColours: {
      track: (host) => bridge.tagPosterColours?.track(host),
      release: (host) => bridge.tagPosterColours?.release(host)
    },
    session: { onUserChange: (name, callback) => bridge.session?.onUserChange?.(name, callback) },
    t: (key, values) => bridge.t(key, values)
  });
  bridge.mediaTagsSettingsUi = { get registry() {
    return export3(bridge);
  } };
  bridge.core.tagLayout = layout;
  bridge.reinitializeTagLayout = layout.reinitialize;
})();
})();
//# sourceMappingURL=tag-layout.js.map
