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
  function optionalApiClient() {
    return host().ApiClient;
  }

  // client/src/features/media-tags/admin/dom.ts
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function findAs(scope, selector, type) {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
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
  var escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // client/src/features/media-tags/admin/values.ts
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function pick(obj, key) {
    if (!isObject(obj)) return void 0;
    const own = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : void 0;
    if (own !== void 0 && own !== null) return own;
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    const other = Object.prototype.hasOwnProperty.call(obj, pascal) ? obj[pascal] : void 0;
    return other !== void 0 && other !== null ? other : void 0;
  }

  // client/src/features/media-tags/admin/custom-rules-model.ts
  var MAX_RULES = 20;
  var MAX_LABEL = 24;
  var ICONS = [
    "theaters",
    "sports_martial_arts",
    "explore",
    "animation",
    "mood",
    "local_police",
    "article",
    "theater_comedy",
    "family_restroom",
    "auto_awesome",
    "history_edu",
    "skull",
    "music_note",
    "psychology_alt",
    "favorite",
    "science",
    "tv",
    "psychology",
    "military_tech",
    "landscape",
    "domino_mask",
    "music_video",
    "menu_book",
    "sports_soccer",
    "quiz",
    "live_tv"
  ];
  function clean(value) {
    return String(value || "").replace(/[\p{White_Space}\p{Cc}]+/gu, " ").replace(/^ | $/g, "");
  }
  function isReservedLabel(value) {
    const label = clean(value);
    return label !== "" && /^[\p{P}\p{White_Space}]+$/u.test(label);
  }
  function collectRules(rows) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    rows.forEach((r) => {
      const value = clean(r.value);
      const label = clean(r.label).slice(0, MAX_LABEL).replace(/ $/, "");
      const key = r.match + ":" + value.toLowerCase();
      if (!value || !label || isReservedLabel(label) || seen.has(key) || out.length >= MAX_RULES) return;
      seen.add(key);
      out.push({ Match: r.match, Value: value, Label: label, Icon: r.icon !== null && ICONS.indexOf(r.icon) >= 0 ? r.icon : null });
    });
    return out;
  }
  function readRows(stored) {
    return (Array.isArray(stored) ? stored : []).slice(0, MAX_RULES).map((r) => {
      const match = String(pick(r, "match") || "").toLowerCase();
      const icon = String(pick(r, "icon") || "");
      return {
        match: match === "collection" ? "collection" : "tag",
        value: String(pick(r, "value") || ""),
        label: String(pick(r, "label") || ""),
        icon: ICONS.indexOf(icon) >= 0 ? icon : null
      };
    });
  }

  // client/src/features/media-tags/admin/custom-rules-editor.ts
  var tr = fmt;
  var trHtml = (key, params) => escapeText(String(tr(key, params)));
  var customHtml = () => `<div id="customTagRules" class="je-ct-rules" role="table" aria-describedby="customTagRulesHelp">
                                        <div class="je-ct-row je-ct-head" role="row">
                                            <span role="columnheader">${trHtml("Match")}</span><span role="columnheader">${trHtml("Tag or collection")}</span><span role="columnheader">${trHtml("Label")}</span><span role="columnheader">${trHtml("Icon")}</span><span role="columnheader"><span class="je-ct-sr">${trHtml("Remove")}</span></span>
                                        </div>
                                        <div id="customTagRuleRows" role="rowgroup"></div>
                                    </div>
                                    <div class="je-ct-actions">
                                        <button id="customTagRuleAdd" is="emby-button" type="button" class="raised raised-mini emby-button"><span>${trHtml("Add rule")}</span></button>
                                        <span id="customTagRulesStatus" class="fieldDescription" role="status" aria-live="polite"></span>
                                    </div>
                                    <datalist id="customTagTagOptions"></datalist>
                                    <datalist id="customTagCollectionOptions"></datalist>`;
  function names(answer, key, name) {
    const items = answer && typeof answer === "object" ? Reflect.get(answer, key) : void 0;
    return Array.isArray(items) ? items.map(name).filter(Boolean).map(String) : [];
  }
  var createCustomTagRules = (root, onChange = () => {
  }, isCurrent = () => true) => {
    const byId = (id) => find(root, "#" + id);
    let rows = [];
    let sourcesLoaded = false;
    let onLabels = null;
    function labels() {
      const out = [];
      collectRules(rows).forEach((r) => {
        if (out.indexOf(r.Label) < 0) out.push(r.Label);
      });
      return out;
    }
    function changed() {
      if (!isCurrent()) return;
      onChange(collectRules(rows));
      if (typeof onLabels === "function") onLabels();
    }
    function loadSources() {
      const client = optionalApiClient();
      if (sourcesLoaded || !client) return;
      sourcesLoaded = true;
      const userId = client.getCurrentUserId?.();
      const fill = (id, list) => {
        const box = byId(id);
        if (!isCurrent() || !box) return;
        box.textContent = "";
        list.slice().sort((a, b) => a.localeCompare(b)).forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          box.appendChild(option);
        });
      };
      client.ajax({ type: "GET", url: client.getUrl("Items/Filters2", { UserId: userId, Recursive: true }), dataType: "json" }).then((r) => fill("customTagTagOptions", names(r, "Tags", (t) => t))).catch(() => {
      });
      client.ajax({ type: "GET", url: client.getUrl("Items", { UserId: userId, IncludeItemTypes: "BoxSet", Recursive: true, SortBy: "SortName", EnableImages: false, EnableUserData: false }), dataType: "json" }).then((r) => fill("customTagCollectionOptions", names(r, "Items", (i) => i && typeof i === "object" ? Reflect.get(i, "Name") : void 0))).catch(() => {
      });
    }
    function render() {
      const box = byId("customTagRuleRows");
      if (!box) return;
      const active = document.activeElement;
      let keep = null;
      if (active && box.contains(active)) {
        const activeRow = active.closest(".je-ct-row");
        const activeCell = active.closest('[role="cell"]');
        const text = active instanceof HTMLInputElement ? active : null;
        keep = activeRow instanceof HTMLElement && activeCell ? {
          index: activeRow.dataset.index,
          cell: activeCell.className,
          start: text && typeof text.selectionStart === "number" ? text.selectionStart : null,
          end: text && typeof text.selectionEnd === "number" ? text.selectionEnd : null
        } : null;
      }
      box.textContent = "";
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "je-ct-empty fieldDescription";
        empty.textContent = tr("No rules yet. Add one to turn a tag or collection into a chip.");
        box.appendChild(empty);
      }
      rows.forEach((r, index) => {
        const n = index + 1;
        const row = document.createElement("div");
        row.className = "je-ct-row";
        row.setAttribute("role", "row");
        row.dataset.index = String(index);
        const cell = (cls, control) => {
          const c = document.createElement("span");
          c.className = cls;
          c.setAttribute("role", "cell");
          c.appendChild(control);
          row.appendChild(c);
          return control;
        };
        const value = document.createElement("input");
        const match = document.createElement("select");
        match.setAttribute("aria-label", tr("Rule {n} match", { n }));
        [["tag", tr("Tag")], ["collection", tr("Collection")]].forEach(([optionValue = "", label2 = ""]) => {
          const option = document.createElement("option");
          option.value = optionValue;
          option.textContent = label2;
          option.selected = r.match === optionValue;
          match.appendChild(option);
        });
        match.addEventListener("change", () => {
          r.match = match.value;
          value.setAttribute("list", r.match === "collection" ? "customTagCollectionOptions" : "customTagTagOptions");
          changed();
        });
        cell("je-ct-match", match);
        value.type = "text";
        value.maxLength = 200;
        value.value = r.value;
        value.placeholder = tr("e.g. 4K Remaster");
        value.setAttribute("list", r.match === "collection" ? "customTagCollectionOptions" : "customTagTagOptions");
        value.setAttribute("aria-label", tr("Rule {n} tag or collection name", { n }));
        value.setAttribute("aria-invalid", String(!clean(r.value)));
        value.addEventListener("focus", loadSources);
        value.addEventListener("input", () => {
          r.value = value.value;
          value.setAttribute("aria-invalid", String(!clean(r.value)));
          changed();
        });
        cell("je-ct-value", value);
        const label = document.createElement("input");
        label.type = "text";
        label.maxLength = MAX_LABEL;
        label.value = r.label;
        label.placeholder = tr("e.g. Remaster");
        label.setAttribute("aria-label", tr("Rule {n} label", { n }));
        const hint = document.createElement("span");
        hint.className = "je-ct-hint fieldDescription";
        hint.id = "customTagRuleLabelHint" + index;
        label.setAttribute("aria-describedby", hint.id);
        const checkLabel = () => {
          const reserved = isReservedLabel(r.label);
          label.setAttribute("aria-invalid", String(!clean(r.label) || reserved));
          hint.textContent = reserved ? tr("Use a letter, number or symbol: punctuation alone (such as *) is reserved, and this rule will not be saved.") : "";
          hint.hidden = !reserved;
        };
        checkLabel();
        label.addEventListener("input", () => {
          r.label = label.value;
          checkLabel();
          changed();
        });
        cell("je-ct-label", label).parentNode?.appendChild(hint);
        const icon = document.createElement("select");
        icon.setAttribute("aria-label", tr("Rule {n} icon", { n }));
        [""].concat(ICONS).forEach((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name ? name.replace(/_/g, " ") : tr("No icon");
          option.selected = (r.icon || "") === name;
          icon.appendChild(option);
        });
        icon.addEventListener("change", () => {
          r.icon = icon.value || null;
          changed();
        });
        cell("je-ct-icon", icon);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "raised raised-mini je-ct-remove";
        remove.setAttribute("aria-label", tr("Remove rule {n}", { n }));
        remove.innerHTML = '<i class="material-icons" aria-hidden="true">delete</i>';
        remove.addEventListener("click", () => {
          rows.splice(index, 1);
          render();
          const next = find(root, '#customTagRuleRows .je-ct-row[data-index="' + Math.min(index, rows.length - 1) + '"] .je-ct-remove') || byId("customTagRuleAdd");
          if (next) next.focus();
          changed();
        });
        cell("je-ct-remove-cell", remove);
        box.appendChild(row);
      });
      if (keep) {
        const again = find(box, '.je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] select, .je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] input, .je-ct-row[data-index="' + keep.index + '"] [class="' + keep.cell + '"] button');
        if (again) {
          again.focus({ preventScroll: true });
          if (keep.start !== null && again instanceof HTMLInputElement) {
            try {
              again.setSelectionRange(keep.start, keep.end);
            } catch {
            }
          }
        }
      }
      const add2 = findAs(root, "#customTagRuleAdd", HTMLButtonElement);
      if (add2) add2.disabled = rows.length >= MAX_RULES;
      const status = byId("customTagRulesStatus");
      if (status) status.textContent = tr("{count} of {max} rules", { count: rows.length, max: MAX_RULES });
    }
    function load(config) {
      rows = readRows(config.CustomTagRules);
      render();
      if (typeof onLabels === "function") onLabels();
    }
    function collect(config) {
      const out = collectRules(rows).map((r) => ({ ...r }));
      config.CustomTagRules = out;
    }
    const add = byId("customTagRuleAdd");
    if (!add) throw new Error("The Custom rules table markup (CUSTOM_HTML) is missing");
    add.addEventListener("click", () => {
      if (rows.length >= MAX_RULES) return;
      rows.push({ match: "tag", value: "", label: "", icon: null });
      render();
      const inputs = root.querySelectorAll("#customTagRuleRows .je-ct-row:last-child input");
      const first = inputs[0];
      if (first instanceof HTMLElement) first.focus();
      changed();
    });
    return {
      load,
      collect,
      labels,
      snapshot: () => JSON.stringify(collectRules(rows)),
      onLabelsChanged: (fn) => {
        onLabels = fn;
      }
    };
  };
  var JE = adminBridge();
  var A = JE.adminTags = JE.adminTags || {};
  Object.defineProperty(A, "CUSTOM_HTML", { get: customHtml, configurable: true, enumerable: true });
  A.createCustomTagRules = createCustomTagRules;
})();
})();
//# sourceMappingURL=custom-rules-editor.js.map
