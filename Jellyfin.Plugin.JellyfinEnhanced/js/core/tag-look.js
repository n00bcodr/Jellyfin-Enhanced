(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/features/media-tags/rules-host.ts
  function tagRulesHost() {
    const host = window;
    if (!host.JellyfinEnhanced)
      throw new Error("Jellyfin Enhanced must load before tag rules");
    return host.JellyfinEnhanced;
  }
  function lookApiClient() {
    const host = window;
    if (!host.ApiClient)
      throw new Error("Jellyfin client is unavailable");
    return host.ApiClient;
  }
  function captureTagSession(bridge2) {
    const identity = () => {
      try {
        const client = lookApiClient();
        const server = (typeof client.serverId === "function" ? client.serverId() : client.serverId) || client._serverInfo?.Id;
        return `${server || ""}|${client.getCurrentUserId?.() || ""}`;
      } catch {
        return "|";
      }
    };
    const owner = identity();
    const epoch = bridge2.session?.getEpoch?.();
    return () => owner === identity() && epoch === bridge2.session?.getEpoch?.();
  }

  // client/generated-shared/stub/client/src/features/media-tags/layout/layout-rules.ts
  var layout_rules_exports = {};
  __export(layout_rules_exports, {
    DEFAULT_CAPS: () => export0,
    DEFAULT_ORDER: () => export1,
    DEFAULT_PROFILES: () => export2,
    EDGE_SPACINGS: () => export3,
    ENABLED_SETTING: () => export4,
    GROUPS: () => export5,
    LAYOUTS: () => export6,
    LAYOUT_SLOTS: () => export7,
    MAX_CAP: () => export8,
    POSITION_SETTINGS: () => export9,
    POSITION_TO_SLOT: () => export10,
    RECOMMENDED_SHAPES: () => export11,
    SHAPES: () => export12,
    SLOT_TO_POSITION: () => export13,
    TAG_GAPS: () => export14,
    TAG_SCALES: () => export15,
    hasOwn: () => export16,
    isLayout: () => export17,
    isLegacySettings: () => export18,
    lookKeyOf: () => export19,
    lookSettings: () => export20,
    normalizeGroup: () => export21,
    normalizeGroupCaps: () => export22,
    normalizeLayout: () => export23,
    normalizeSettings: () => export24,
    pick: () => export25,
    positionSlot: () => export26,
    promoteLegacySettings: () => export27,
    readCap: () => export28,
    readEdge: () => export29,
    readGap: () => export30,
    readOrder: () => export31,
    readProfile: () => export32,
    readScale: () => export33,
    readShapeLook: () => export34,
    readShapeOverrides: () => export35,
    shapesToWire: () => export36,
    singleChipGroup: () => export37,
    validSlots: () => export38,
    withShape: () => export39
  });

  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/layout/layout-rules.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/layout/layout-rules");
  var export0 = /* @__PURE__ */ sharedExport(shared, "DEFAULT_CAPS");
  var export1 = /* @__PURE__ */ sharedExport(shared, "DEFAULT_ORDER");
  var export2 = /* @__PURE__ */ sharedExport(shared, "DEFAULT_PROFILES");
  var export3 = /* @__PURE__ */ sharedExport(shared, "EDGE_SPACINGS");
  var export4 = /* @__PURE__ */ sharedExport(shared, "ENABLED_SETTING");
  var export5 = /* @__PURE__ */ sharedExport(shared, "GROUPS");
  var export6 = /* @__PURE__ */ sharedExport(shared, "LAYOUTS");
  var export7 = /* @__PURE__ */ sharedExport(shared, "LAYOUT_SLOTS");
  var export8 = /* @__PURE__ */ sharedExport(shared, "MAX_CAP");
  var export9 = /* @__PURE__ */ sharedExport(shared, "POSITION_SETTINGS");
  var export10 = /* @__PURE__ */ sharedExport(shared, "POSITION_TO_SLOT");
  var export11 = /* @__PURE__ */ sharedExport(shared, "RECOMMENDED_SHAPES");
  var export12 = /* @__PURE__ */ sharedExport(shared, "SHAPES");
  var export13 = /* @__PURE__ */ sharedExport(shared, "SLOT_TO_POSITION");
  var export14 = /* @__PURE__ */ sharedExport(shared, "TAG_GAPS");
  var export15 = /* @__PURE__ */ sharedExport(shared, "TAG_SCALES");
  var export16 = /* @__PURE__ */ sharedExport(shared, "hasOwn");
  var export17 = /* @__PURE__ */ sharedExport(shared, "isLayout");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isLegacySettings");
  var export19 = /* @__PURE__ */ sharedExport(shared, "lookKeyOf");
  var export20 = /* @__PURE__ */ sharedExport(shared, "lookSettings");
  var export21 = /* @__PURE__ */ sharedExport(shared, "normalizeGroup");
  var export22 = /* @__PURE__ */ sharedExport(shared, "normalizeGroupCaps");
  var export23 = /* @__PURE__ */ sharedExport(shared, "normalizeLayout");
  var export24 = /* @__PURE__ */ sharedExport(shared, "normalizeSettings");
  var export25 = /* @__PURE__ */ sharedExport(shared, "pick");
  var export26 = /* @__PURE__ */ sharedExport(shared, "positionSlot");
  var export27 = /* @__PURE__ */ sharedExport(shared, "promoteLegacySettings");
  var export28 = /* @__PURE__ */ sharedExport(shared, "readCap");
  var export29 = /* @__PURE__ */ sharedExport(shared, "readEdge");
  var export30 = /* @__PURE__ */ sharedExport(shared, "readGap");
  var export31 = /* @__PURE__ */ sharedExport(shared, "readOrder");
  var export32 = /* @__PURE__ */ sharedExport(shared, "readProfile");
  var export33 = /* @__PURE__ */ sharedExport(shared, "readScale");
  var export34 = /* @__PURE__ */ sharedExport(shared, "readShapeLook");
  var export35 = /* @__PURE__ */ sharedExport(shared, "readShapeOverrides");
  var export36 = /* @__PURE__ */ sharedExport(shared, "shapesToWire");
  var export37 = /* @__PURE__ */ sharedExport(shared, "singleChipGroup");
  var export38 = /* @__PURE__ */ sharedExport(shared, "validSlots");
  var export39 = /* @__PURE__ */ sharedExport(shared, "withShape");

  // client/src/features/media-tags/layout/tag-look.ts
  function transportStatus(error) {
    try {
      if (typeof error === "object" && error !== null && "status" in error) {
        const status = error.status;
        if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
      }
    } catch {
    }
    return void 0;
  }
  function lockTimestamp(value) {
    const number = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }
  function createTagLook(host) {
    const FIELDS = ["library", "type", "genre", "ageRating"];
    const TYPES = ["Movie", "Series", "Season", "Episode", "BoxSet", "Video"];
    const DENSITIES = ["full", "compact"];
    const MAX_RULES = 50;
    const MAX_CONDITIONS = 5;
    const MAX_LOCKS = 500;
    const MAX_ITEM_OVERRIDES = 500;
    const PLUGIN_ID = "f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b";
    const SCALES = ["smaller", "default", "larger", "largest"];
    const GAPS = ["tight", "default", "roomy"];
    const EDGES = ["default", "tight", "flush"];
    const MAX_TEXT = 100;
    const RULE_ID = /^[A-Za-z0-9_-]{1,40}$/;
    const PRESET = /^[a-z0-9_-]{1,64}$/;
    function layoutSlots() {
      return export7 || {};
    }
    function normalizeId(raw) {
      if (typeof raw !== "string")
        return null;
      const id = raw.trim().replace(/-/g, "").toLowerCase();
      return /^[0-9a-f]{32}$/.test(id) ? id : null;
    }
    function normalizeLayout(raw) {
      const layout = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return export17(layout) ? layout : null;
    }
    function normalizeDensity(raw) {
      if (raw === void 0 || raw === null || raw === "")
        return "full";
      const density = String(raw).trim().toLowerCase();
      return DENSITIES.includes(density) ? density : null;
    }
    function normalizeSlots(raw, layout) {
      if (!raw || typeof raw !== "object")
        return null;
      const pairs = Array.isArray(raw) ? raw.map((entry) => [export25(entry, "group"), export25(entry, "slot")]) : Object.entries(raw);
      const layouts = layoutSlots();
      const valid = export17(layout) ? layouts[layout] : [];
      const out = {};
      for (const [rawGroup, rawSlot] of pairs) {
        const group = export21(rawGroup);
        const slot = typeof rawSlot === "string" ? rawSlot.trim().toLowerCase() : "";
        if (!group || out[group] || !valid.includes(slot))
          continue;
        if (slot === "dots" && group !== "quality")
          continue;
        out[group] = slot;
      }
      return Object.keys(out).length ? out : null;
    }
    function normalizeShapes(raw) {
      const shapes = export35(raw);
      return shapes && (shapes.landscape || shapes.list) ? shapes : null;
    }
    function normalizeCaps(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
      const layout = layout_rules_exports;
      const max = layout?.MAX_CAP ?? 10;
      const out = {};
      for (const group of layout?.GROUPS || []) {
        const value = export25(raw, group);
        const n = Number(value);
        if (value === void 0 || value === null || value === "" || !Number.isFinite(n))
          continue;
        out[group] = Math.max(0, Math.min(max, Math.round(n)));
      }
      return Object.keys(out).length ? out : null;
    }
    function choice(raw, values) {
      const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      return values.includes(value) ? value : null;
    }
    function normalizeCondition(raw) {
      const rawField = export25(raw, "field");
      const field = FIELDS.find((f) => typeof rawField === "string" && f.toLowerCase() === rawField.trim().toLowerCase());
      const rawValue = export25(raw, "value");
      const text = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!field || !text)
        return null;
      let value = null;
      if (field === "library")
        value = normalizeId(text);
      else if (field === "type")
        value = TYPES.find((t) => t.toLowerCase() === text.toLowerCase()) || null;
      else
        value = text.length <= MAX_TEXT ? text : null;
      return value ? { field, value } : null;
    }
    function normalizeRules(raw) {
      if (!Array.isArray(raw))
        return [];
      const out = [];
      const ids = /* @__PURE__ */ new Set();
      for (const rule of raw) {
        if (out.length >= MAX_RULES)
          break;
        if (!rule || typeof rule !== "object")
          continue;
        const layout = normalizeLayout(export25(rule, "layout"));
        const density = normalizeDensity(export25(rule, "density"));
        if (!layout || !density)
          continue;
        const whenRaw = export25(rule, "when");
        const when = (Array.isArray(whenRaw) ? whenRaw : []).map(normalizeCondition);
        if (when.length === 0 || when.length > MAX_CONDITIONS || when.includes(null))
          continue;
        let id = String(export25(rule, "id") ?? "").trim();
        if (!RULE_ID.test(id) || ids.has(id))
          id = newRuleId(ids);
        ids.add(id);
        const enabled = export25(rule, "enabled");
        const preset = String(export25(rule, "colourPreset") ?? "").trim().toLowerCase();
        out.push({
          id,
          enabled: enabled !== false,
          when: when.filter((condition) => condition !== null),
          layout,
          density,
          colourPreset: PRESET.test(preset) ? preset : null,
          slots: normalizeSlots(export25(rule, "slots"), layout),
          shapes: normalizeShapes(export25(rule, "shapes"))
        });
      }
      return out;
    }
    function newRuleId(taken) {
      let id;
      do {
        id = "r" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      } while (taken && taken.has(id));
      return id;
    }
    function normalizeLock(value) {
      if (!value || typeof value !== "object")
        return null;
      const layout = normalizeLayout(export25(value, "layout"));
      const density = normalizeDensity(export25(value, "density"));
      if (!layout || !density)
        return null;
      const preset = String(export25(value, "colourPreset") ?? "").trim().toLowerCase();
      return {
        layout,
        density,
        colourPreset: PRESET.test(preset) ? preset : null,
        slots: normalizeSlots(export25(value, "slots"), layout),
        shapes: normalizeShapes(export25(value, "shapes")),
        caps: normalizeCaps(export25(value, "caps")),
        tagScale: choice(export25(value, "tagScale"), SCALES),
        tagGap: choice(export25(value, "tagGap"), GAPS),
        edge: choice(export25(value, "edgeSpacing") ?? export25(value, "edge"), EDGES),
        scope: String(export25(value, "scope") ?? "").trim().toLowerCase() === "item" ? "item" : null,
        lockedAt: lockTimestamp(export25(value, "lockedAt"))
      };
    }
    function normalizeLocks(raw) {
      const byId = /* @__PURE__ */ new Map();
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return byId;
      for (const [key, value] of Object.entries(raw)) {
        const id = normalizeId(key);
        const lock = id ? normalizeLock(value) : null;
        if (!id || !lock)
          continue;
        const previous = byId.get(id);
        if (previous && previous.lockedAt >= lock.lockedAt)
          continue;
        byId.set(id, lock);
      }
      if (byId.size <= MAX_LOCKS)
        return byId;
      const newest = Array.from(byId.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_LOCKS);
      return new Map(newest);
    }
    function normalizeItemOverrides(raw) {
      if (!Array.isArray(raw))
        return /* @__PURE__ */ new Map();
      const byKey = {};
      for (const entry of raw) {
        const id = normalizeId(String(export25(entry, "itemId") ?? ""));
        if (!id)
          continue;
        const seen = byKey[id];
        if (seen && lockTimestamp(export25(seen, "lockedAt")) >= lockTimestamp(export25(entry, "lockedAt")))
          continue;
        byKey[id] = entry;
      }
      const looks = normalizeLocks(byKey);
      return looks.size <= MAX_ITEM_OVERRIDES ? looks : new Map(Array.from(looks).slice(0, MAX_ITEM_OVERRIDES));
    }
    function read(settings, plugin) {
      const s = settings || host.settings() || {};
      const p = plugin || host.config() || {};
      const legacy = export18(s);
      const own = s.tagLookRules;
      const rules = Array.isArray(own) ? normalizeRules(own) : legacy ? [] : normalizeRules(export25(p, "tagLookRules"));
      return { rules, locks: normalizeLocks(s.tagLayoutLocks), overrides: normalizeItemOverrides(export25(p, "tagLookItemOverrides")) };
    }
    function normalizeRating(raw) {
      if (raw === null || raw === void 0)
        return "";
      const text = String(raw).replace(/\s+/g, " ").trim();
      if (!text)
        return "";
      const shared2 = host.normalizeOfficialRating;
      return String((typeof shared2 === "function" ? shared2(text) : text) || text).toLowerCase();
    }
    function matches(rule, facts) {
      if (!rule || !rule.enabled || !rule.when.length)
        return false;
      return rule.when.every((cond) => {
        switch (cond.field) {
          case "library":
            return !!facts.libraryId && facts.libraryId === cond.value;
          case "type":
            return !!facts.type && facts.type.toLowerCase() === cond.value.toLowerCase();
          case "genre": {
            const wanted = cond.value.toLowerCase();
            return facts.genres.some((g) => String(g).trim().toLowerCase() === wanted);
          }
          case "ageRating": {
            const have = normalizeRating(facts.officialRating);
            return !!have && have === normalizeRating(cond.value);
          }
          default:
            return false;
        }
      });
    }
    function firstMatch(rules, facts) {
      for (const rule of rules) {
        if (matches(rule, facts))
          return rule;
      }
      return null;
    }
    function findLock(locks, facts) {
      if (!locks || !locks.size)
        return null;
      for (const id of facts.lockIds) {
        const lock = locks.get(id);
        if (!lock)
          continue;
        if (lock.scope === "item" && id === facts.seriesId && id !== facts.itemId)
          continue;
        return lock;
      }
      return null;
    }
    function factsFrom(entry, card = {}) {
      const e = entry;
      const itemId = normalizeId(card.itemId || "") || normalizeId(String(export25(e, "id") ?? "")) || "";
      const cardId = normalizeId(card.cardId || "") || "";
      const rawType = card.cardType || export25(e, "type");
      const type = typeof rawType === "string" ? rawType : null;
      const genresRaw = export25(e, "genres");
      const seriesId = type === "Season" || type === "Episode" || export25(e, "type") === "Season" || export25(e, "type") === "Episode" ? normalizeId(String(export25(e, "seriesId") ?? "")) : null;
      const lockIds = [];
      for (const id of [cardId, itemId, seriesId]) {
        if (id && !lockIds.includes(id))
          lockIds.push(id);
      }
      return {
        itemId: itemId || cardId,
        type,
        genres: Array.isArray(genresRaw) ? genresRaw : [],
        officialRating: export25(e, "officialRating") || null,
        libraryId: normalizeId(String(export25(e, "libraryId") ?? "")),
        seriesId,
        lockIds
      };
    }
    function slotsToWire(slots) {
      return slots ? Object.entries(slots).map(([group, slot]) => ({ group, slot })) : null;
    }
    function shapesToWire(shapes) {
      return shapes ? export36(shapes) || null : null;
    }
    const represent = host.represent;
    const captureSession = host.captureSession;
    function persist(key, value) {
      const isCurrent = captureSession();
      const settings = host.settings();
      const previous = settings[key];
      if (!isCurrent())
        return Promise.resolve(false);
      settings[key] = value;
      represent();
      if (!isCurrent())
        return Promise.resolve(false);
      const save = host.saveUserSettings;
      const rollback = () => {
        if (host.settings() === settings && settings[key] === value) {
          settings[key] = previous;
          represent();
        }
      };
      if (typeof save !== "function") {
        rollback();
        return Promise.resolve(false);
      }
      return new Promise((resolve) => resolve(save("settings.json", settings, { throwOnError: true, isCurrent, onError: rollback }))).then(() => isCurrent(), (err) => {
        if (!isCurrent())
          return false;
        console.warn("🪼 Jellyfin Enhanced [TagLook]: saving the tag looks failed:", err);
        return false;
      });
    }
    function saveRules(rules) {
      return persist("tagLookRules", normalizeRules(rules).map((rule) => ({ ...rule, slots: slotsToWire(rule.slots), shapes: shapesToWire(rule.shapes) })));
    }
    function lockToWire(lock) {
      const { edge, ...rest } = lock;
      return {
        ...rest,
        slots: slotsToWire(lock.slots),
        shapes: shapesToWire(lock.shapes),
        caps: lock.caps ? { ...lock.caps } : null,
        edgeSpacing: edge || null
      };
    }
    function locksToWire(locks) {
      const out = {};
      for (const [id, lock] of locks)
        out[id] = lockToWire(lock);
      return Object.keys(out).length ? out : null;
    }
    function lockFrom(look, others) {
      const lock = normalizeLock({ ...look && typeof look === "object" ? look : {}, edgeSpacing: export25(look, "edge") ?? null, lockedAt: 0, shapes: null, colourPreset: null });
      if (!lock)
        return null;
      lock.lockedAt = Math.max(Date.now(), ...Array.from(others, (l) => l.lockedAt + 1));
      return lock;
    }
    function lockItem(itemId, look) {
      const id = normalizeId(itemId);
      const locks = normalizeLocks(host.settings().tagLayoutLocks);
      const lock = id ? lockFrom(look, locks.values()) : null;
      if (!id || !lock)
        return Promise.resolve(false);
      locks.delete(id);
      locks.set(id, lock);
      return persist("tagLayoutLocks", locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }
    function unlockItems(ids) {
      const locks = normalizeLocks(host.settings().tagLayoutLocks);
      if (ids === void 0)
        locks.clear();
      else
        for (const raw of ids) {
          const id = normalizeId(raw);
          if (id)
            locks.delete(id);
        }
      return persist("tagLayoutLocks", locksToWire(locks));
    }
    function editLocks(set, remove = []) {
      const locks = normalizeLocks(host.settings().tagLayoutLocks);
      for (const raw of remove) {
        const id = normalizeId(raw);
        if (id)
          locks.delete(id);
      }
      for (const [raw, look] of Object.entries(set || {})) {
        const id = normalizeId(raw);
        const lock = id ? lockFrom(look, locks.values()) : null;
        if (!id || !lock)
          return Promise.resolve(false);
        locks.delete(id);
        locks.set(id, lock);
      }
      return persist("tagLayoutLocks", locksToWire(normalizeLocks(Object.fromEntries(locks))));
    }
    function restoreLocks(wire) {
      const locks = normalizeLocks(host.settings().tagLayoutLocks);
      for (const [id, lock] of normalizeLocks(wire)) {
        if (!locks.has(id) && locks.size < MAX_LOCKS)
          locks.set(id, lock);
      }
      return persist("tagLayoutLocks", locksToWire(locks));
    }
    function itemOverridesToWire(looks) {
      const out = Array.from(looks.entries()).sort((a, b) => b[1].lockedAt - a[1].lockedAt || (a[0] < b[0] ? -1 : 1)).map(([id, look]) => {
        const wire = lockToWire(look);
        return {
          ItemId: id,
          Layout: wire.layout,
          Density: wire.density,
          ColourPreset: wire.colourPreset,
          Slots: wire.slots ? wire.slots.map((e) => ({ Group: e.group, Slot: e.slot })) : null,
          Shapes: wire.shapes,
          Caps: capsToWire(wire.caps),
          TagScale: wire.tagScale,
          TagGap: wire.tagGap,
          EdgeSpacing: wire.edgeSpacing,
          Scope: wire.scope,
          LockedAt: wire.lockedAt
        };
      });
      return out.length ? out : null;
    }
    function capsToWire(caps) {
      if (!caps)
        return null;
      const out = {};
      for (const [group, n] of Object.entries(caps))
        out[group.charAt(0).toUpperCase() + group.slice(1)] = n;
      return out;
    }
    function itemOverridesWith(raw, itemId, look) {
      const id = normalizeId(itemId);
      if (!id)
        return void 0;
      const looks = normalizeItemOverrides(raw);
      looks.delete(id);
      if (look) {
        const lock = lockFrom(look, looks.values());
        if (!lock)
          return void 0;
        looks.set(id, lock);
      }
      return itemOverridesToWire(looks);
    }
    function restoreItemOverrides(raw, removed) {
      const looks = normalizeItemOverrides(raw);
      for (const [id, entry] of normalizeItemOverrides(removed)) {
        if (!looks.has(id) && looks.size < MAX_ITEM_OVERRIDES)
          looks.set(id, entry);
      }
      return itemOverridesToWire(looks);
    }
    function itemOverrideMutation(before, after) {
      const previous = normalizeItemOverrides(before);
      const next = normalizeItemOverrides(after);
      const sets = /* @__PURE__ */ new Map();
      const remove = [];
      const expected = {};
      for (const id of /* @__PURE__ */ new Set([...previous.keys(), ...next.keys()])) {
        if (JSON.stringify(previous.get(id)) === JSON.stringify(next.get(id)))
          continue;
        const value = next.get(id);
        if (value)
          sets.set(id, value);
        else
          remove.push(id);
        expected[id] = (Array.isArray(before) ? before.find((e) => normalizeId(export25(e, "itemId")) === id) : null) || null;
      }
      return { Set: itemOverridesToWire(sets) || [], Remove: remove, Expected: expected };
    }
    async function saveItemOverride(itemId, look, options = {}) {
      const isCurrent = captureSession();
      const id = normalizeId(itemId);
      if (!id)
        return false;
      const api = options.api || host.api;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!isCurrent())
            return false;
          const config = await api.get();
          if (!isCurrent())
            return false;
          const before = config?.TagLookItemOverrides ?? null;
          const current = normalizeItemOverrides(before);
          if (options.restoreOnly && (current.has(id) || current.size >= MAX_ITEM_OVERRIDES))
            return true;
          let next = before;
          for (const child of options.remove || [])
            next = itemOverridesWith(next, child, null);
          next = itemOverridesWith(next, id, look);
          if (next === void 0)
            return false;
          if (!isCurrent())
            return false;
          const mutation = itemOverrideMutation(before, next);
          const result = mutation.Set.length || mutation.Remove.length ? await api.patch({ TagLookItemOverrides: mutation }, {}) : null;
          if (!isCurrent())
            return false;
          const stored = result?.values?.TagLookItemOverrides ?? result?.Values?.TagLookItemOverrides ?? (result ? next : before);
          const configView = host.config();
          configView.TagLookItemOverrides = visibleItemLooks(stored, configView.TagLookItemOverrides, id);
          represent();
          return true;
        } catch (err) {
          if (!isCurrent())
            return false;
          if (transportStatus(err) === 409 && attempt === 0)
            continue;
          console.warn("🪼 Jellyfin Enhanced [TagLook]: saving the item look for everyone failed:", err);
          return false;
        }
      }
      return false;
    }
    function visibleItemLooks(stored, previous, id) {
      if (!Array.isArray(stored))
        return null;
      const visible = new Set(normalizeItemOverrides(previous).keys()).add(id);
      const kept = stored.filter((entry) => visible.has(normalizeId(String(export25(entry, "itemId") ?? "")) || ""));
      return kept.length ? kept : null;
    }
    return {
      captureSession,
      FIELDS: FIELDS.slice(),
      TYPES: TYPES.slice(),
      MAX_RULES,
      MAX_CONDITIONS,
      MAX_LOCKS,
      MAX_ITEM_OVERRIDES,
      normalizeId,
      normalizeRules,
      normalizeLocks,
      normalizeLock,
      normalizeItemOverrides,
      normalizeCaps,
      normalizeSlots,
      normalizeRating,
      read,
      matches,
      firstMatch,
      findLock,
      factsFrom,
      newRuleId,
      saveRules,
      lockItem,
      unlockItems,
      editLocks,
      restoreLocks,
      saveItemOverride,
      itemOverrideMutation,
      restoreItemOverrides,
      itemOverridesWith,
      itemOverridesToWire
    };
  }

  // client/src/features/media-tags/layout/tag-look-entry.ts
  var bridge = tagRulesHost();
  bridge.core ?? (bridge.core = {});
  bridge.core.tagLook = createTagLook({
    settings: () => bridge.currentSettings || {},
    config: () => bridge.pluginConfig || {},
    normalizeOfficialRating: (text) => bridge.normalizeOfficialRating?.(text) || text,
    represent: () => {
      bridge.core?.tagLayout?.invalidateSettings?.();
      bridge.reinitializeTagLayout?.();
    },
    captureSession: () => captureTagSession(bridge),
    get saveUserSettings() {
      return bridge.saveUserSettings?.bind(bridge);
    },
    api: {
      get: () => lookApiClient().getPluginConfiguration("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b"),
      patch: (changes, expected) => {
        const client = lookApiClient();
        return client.ajax({
          type: "POST",
          url: client.getUrl("/JellyfinEnhanced/admin/configuration"),
          data: JSON.stringify({ Changes: changes, Expected: expected }),
          contentType: "application/json",
          dataType: "json"
        });
      }
    }
  });
})();
})();
//# sourceMappingURL=tag-look.js.map
