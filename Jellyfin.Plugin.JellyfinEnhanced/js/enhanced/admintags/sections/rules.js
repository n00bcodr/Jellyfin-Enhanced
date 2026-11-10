(() => {
"use strict";
(() => {
  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE;
  }
  function adminTagsApi(JE) {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
  }
  function isCore(facade) {
    return typeof facade.registerSection === "function" && typeof facade.fmt === "function" && Array.isArray(facade.sections);
  }
  function apiClient() {
    const client = host().ApiClient;
    if (!client) throw new ReferenceError("ApiClient is not defined");
    return client;
  }
  function currentUserId(client) {
    return String(client.getCurrentUserId?.());
  }

  // client/src/features/media-tags/admin/dom.ts
  function isDisabled(el) {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.disabled : false;
  }
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function findAs(scope, selector, type) {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
  }
  function must(scope, selector) {
    const el = find(scope, selector);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
  }
  function mustAs(scope, selector, type) {
    const el = findAs(scope, selector, type);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
  }
  function all(scope, selector) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el) => el instanceof HTMLElement) : [];
  }
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
  }
  function activeElement() {
    const el = document.activeElement;
    return el instanceof HTMLElement ? el : null;
  }
  function focus(el, options) {
    if (el instanceof HTMLElement) el.focus(options);
  }

  // client/src/features/media-tags/admin/format.ts
  function word(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
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
  function copy(value) {
    if (value === void 0) return null;
    const out = JSON.parse(JSON.stringify(value));
    return isJson(out) ? out : null;
  }
  function either(obj, key) {
    if (!isObject(obj)) return void 0;
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== void 0) return obj[key];
    const pascal = key.charAt(0).toUpperCase() + key.slice(1);
    return Object.prototype.hasOwnProperty.call(obj, pascal) ? obj[pascal] : void 0;
  }
  var list = (value) => Array.isArray(value) ? value : [];

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/rules.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'rules',
      title: 'Default tag look rules',
          { id: 'tagLookRulesJson', key: 'TagLookRules', type: 'custom', label: 'Edit as JSON' },
  registerSection({
      tab: 'rules',
      title: 'Locked items',
  registerSection({
      tab: 'rules',
      title: 'Server-wide item looks',
      writes: ['TagLookItemOverrides'],
  */
  var LAYOUTS = ["corners", "bands", "caption", "summary", "minimal"];
  var FIELDS = ["library", "type", "genre", "ageRating"];
  var TYPES = ["Movie", "Series", "Season", "Episode", "BoxSet", "Video"];
  var MAX_RULES = 50;
  var str = (obj, key) => {
    const v = either(obj, key);
    return v ? String(v) : "";
  };
  var rulesOf = (c) => Array.isArray(c.TagLookRules) ? c.TagLookRules.map((r) => isObject(r) ? { ...r } : {}) : [];
  var hasExtras = (rule) => {
    const slots = either(rule, "slots");
    return !!(Array.isArray(slots) && slots.length || either(rule, "shapes"));
  };
  installSection((A, JE) => {
    function parseRules(text) {
      const trimmed = (text || "").trim();
      if (!trimmed) return { rules: [], error: null };
      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch (e) {
        return { rules: [], error: A.fmt("Not valid JSON: {message}", { message: e instanceof Error ? e.message : String(e) }) };
      }
      const parsed = copy(raw);
      if (!Array.isArray(parsed)) return { rules: [], error: A.fmt("Expected a JSON array of rules.") };
      if (parsed.length > MAX_RULES) return { rules: [], error: A.fmt("At most {n} rules.", { n: MAX_RULES }) };
      const rules = [];
      for (let i = 0; i < parsed.length; i++) {
        const rule = parsed[i];
        const n = i + 1;
        if (!isObject(rule)) return { rules: [], error: A.fmt("Rule {n}: not an object.", { n }) };
        const layout = str(rule, "layout").toLowerCase();
        if (!LAYOUTS.includes(layout)) return { rules: [], error: A.fmt('Rule {n}: unknown layout "{layout}".', { n, layout }) };
        const density = String(either(rule, "density") || "full").toLowerCase();
        if (density !== "full" && density !== "compact") return { rules: [], error: A.fmt("Rule {n}: density must be full or compact.", { n }) };
        const when = either(rule, "when");
        if (!Array.isArray(when) || when.length < 1 || when.length > 5) return { rules: [], error: A.fmt('Rule {n}: "when" needs 1 to 5 conditions.', { n }) };
        const conditions = [];
        for (let j = 0; j < when.length; j++) {
          const field = str(when[j], "field");
          const value = str(when[j], "value").trim();
          if (!FIELDS.map((f) => f.toLowerCase()).includes(field.toLowerCase()) || !value) return { rules: [], error: A.fmt("Rule {n}: condition {m} needs a known field and a value.", { n, m: j + 1 }) };
          if (field.toLowerCase() === "library" && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, ""))) return { rules: [], error: A.fmt("Rule {n}: a library condition needs a library id.", { n }) };
          conditions.push({ Field: field, Value: value });
        }
        const slots = either(rule, "slots");
        const shapes = either(rule, "shapes");
        rules.push({
          Id: str(rule, "id"),
          Enabled: either(rule, "enabled") !== false,
          When: conditions,
          Layout: layout,
          Density: density,
          ColourPreset: null,
          Slots: Array.isArray(slots) ? slots.map((s) => ({ Group: str(s, "group"), Slot: str(s, "slot") })) : null,
          Shapes: shapes && typeof shapes === "object" ? shapes : null
        });
      }
      return { rules, error: null };
    }
    const libraryNames = /* @__PURE__ */ new WeakMap();
    const librariesOf = (ctx) => libraryNames.get(ctx) || {};
    function conditionText(cond, libraries = {}) {
      const field = str(cond, "field");
      const value = str(cond, "value");
      const key = field.toLowerCase();
      let shown = value;
      if (key === "library") shown = (Object.prototype.hasOwnProperty.call(libraries, value.replace(/-/g, "").toLowerCase()) ? libraries[value.replace(/-/g, "").toLowerCase()] : void 0) || value;
      else if (key === "type") shown = A.fmt(word(A.WORDS.type, value.toLowerCase()));
      return A.fmt("{field} is {value}", { field: A.fmt(word(A.WORDS.field, key)), value: shown });
    }
    const suggestions = /* @__PURE__ */ new WeakMap();
    const edits = /* @__PURE__ */ new WeakMap();
    const editsOf = (ctx) => edits.get(ctx) || { index: -1, id: "" };
    const drafts = /* @__PURE__ */ new WeakMap();
    function draftOf(body) {
      let state = drafts.get(body);
      if (!state) drafts.set(body, state = { loaded: "", dirty: false, check: null });
      return state;
    }
    function ruleHtml(ctx, rule, i, count) {
      const enabled = either(rule, "enabled") !== false;
      const when = list(either(rule, "when")).map((cond) => conditionText(cond, librariesOf(ctx))).join(A.fmt(" and "));
      const look = A.fmt("{layout} · {density}", { layout: A.fmt(word(A.WORDS.layout, String(either(rule, "layout") || "corners").toLowerCase())), density: word(A.WORDS.density, String(either(rule, "density") || "full").toLowerCase() === "compact" ? "compact" : "full") || "" });
      const extra = hasExtras(rule) ? ` <span class="je-ta-hint">${ctx.tx("(also sets positions; edit as JSON)")}</span>` : "";
      const name = A.fmt("Rule {n}", { n: i + 1 });
      const editing = editsOf(ctx).index === i;
      return `<li class="je-ta-rule" data-index="${i}" data-enabled="${enabled}"${editing ? ' data-editing="true"' : ""}>
            <span class="je-ta-rule-n">${i + 1}</span>
            <input type="checkbox" data-act="enable" ${enabled ? "checked" : ""} aria-label="${ctx.esc(A.fmt("{name} enabled", { name }))}">
            <span class="je-ta-rule-text">${ctx.esc(when)} → <strong>${ctx.esc(look)}</strong>${extra}</span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-button" data-act="edit" aria-label="${ctx.esc(A.fmt("Edit rule: {rule}", { rule: name }))}"${editing ? ' aria-current="true"' : ""}>${ctx.tx("Edit")}</button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="-1" aria-label="${ctx.esc(A.fmt("Move {name} up", { name }))}" ${i === 0 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="move" data-dir="1" aria-label="${ctx.esc(A.fmt("Move {name} down", { name }))}" ${i === count - 1 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                <button type="button" class="je-ta-icon-btn" data-act="delete" aria-label="${ctx.esc(A.fmt("Delete {name}", { name }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }
    function valueControl(ctx, field, value, id, first) {
      const attrs = `id="${id}" data-cond-value="1"${first ? ' data-rule="value"' : ""} aria-required="true"`;
      const choose = `<option value="">${ctx.tx("Choose…")}</option>`;
      const option = (v, label) => `<option value="${ctx.esc(v)}"${v === value ? " selected" : ""}>${ctx.esc(label)}</option>`;
      if (field === "type") return `<select ${attrs}>${choose}${TYPES.map((t) => option(t, A.fmt(word(A.WORDS.type, t.toLowerCase())))).join("")}</select>`;
      if (field === "library") {
        const entries = Object.entries(librariesOf(ctx));
        if (!entries.length) return `<input type="text" ${attrs} value="${ctx.esc(value)}" placeholder="${ctx.tx("Library id")}">`;
        const chosen = value.replace(/-/g, "").toLowerCase();
        if (chosen && !entries.some(([libId]) => libId === chosen)) entries.push([chosen, A.fmt("an unavailable library")]);
        return `<select ${attrs}>${choose}${entries.map(([libId, name]) => `<option value="${ctx.esc(libId)}"${libId === chosen ? " selected" : ""}>${ctx.esc(name)}</option>`).join("")}</select>`;
      }
      const known = suggestions.get(ctx);
      if (field === "genre" && known?.genres.length) {
        const match = known.genres.find((g) => g.toLowerCase() === value.toLowerCase());
        const genres = value && !match ? known.genres.concat([value]) : known.genres;
        return `<select ${attrs}>${choose}${genres.map((g) => `<option value="${ctx.esc(g)}"${g === (match || value) ? " selected" : ""}>${ctx.esc(g)}</option>`).join("")}</select>`;
      }
      const ratings = field === "ageRating" ? known?.ratings || [] : [];
      const listAttr = ratings.length ? ` list="${id}-ratings"` : "";
      return `<input type="text" ${attrs}${listAttr} maxlength="100" value="${ctx.esc(value)}" placeholder="${ctx.tx(field === "genre" ? "e.g. Animation" : "e.g. TV-Y")}">` + (ratings.length ? `<datalist id="${id}-ratings">${ratings.map((r) => `<option value="${ctx.esc(r)}"></option>`).join("")}</datalist>` : "");
    }
    let condSeq = 0;
    function conditionRowHtml(ctx, cond, first) {
      const n = ++condSeq;
      const field = FIELDS.find((f) => f.toLowerCase() === String(cond.field || "").toLowerCase()) || "library";
      return `<div class="je-ta-cond" data-cond>
            <span class="je-ta-cond-n" data-cond-n></span>
            <label class="je-ta-sr" for="jeTaCondField${n}" data-cond-field-label></label>
            <select id="jeTaCondField${n}" data-cond-field${first ? ' data-rule="field"' : ""}>${FIELDS.map((f) => `<option value="${f}"${f === field ? " selected" : ""}>${ctx.tx(word(A.WORDS.field, f.toLowerCase()))}</option>`).join("")}</select>
            <span class="je-ta-cond-is" aria-hidden="true">${ctx.tx("is")}</span>
            <label class="je-ta-sr" for="jeTaCondValue${n}" data-cond-value-label></label>
            <span class="je-ta-cond-value" data-rule-value>${valueControl(ctx, field, String(cond.value || ""), `jeTaCondValue${n}`, first)}</span>
            <button type="button" class="je-ta-icon-btn" data-cond-remove><span class="material-icons" aria-hidden="true">close</span></button>
        </div>`;
    }
    const valueIn = (row) => findAs(row, "[data-cond-value]", HTMLInputElement) || findAs(row, "[data-cond-value]", HTMLSelectElement);
    function loadRules(ctx, body, force = false) {
      const box = findAs(body, "#tagLookRulesJson", HTMLTextAreaElement);
      if (!box || !body) return;
      const draft = draftOf(body);
      const rules = rulesOf(ctx.config);
      const json = rules.length ? JSON.stringify(rules, null, 2) : "";
      const stale = find(body, "#tagLookRulesJsonStale");
      if (draft.dirty && !force) {
        if (stale) stale.hidden = json === draft.loaded;
        return;
      }
      draft.loaded = json;
      draft.dirty = false;
      if (stale) stale.hidden = true;
      box.value = json;
      draft.check?.();
    }
    A.registerSection({
      id: "rules",
      tab: "rules",
      order: 10,
      title: "Default tag look rules",
      hint: 'The first enabled rule that matches a card gives it its layout and density. New users (and "Apply defaults to all users") start with these; users edit their own copy.',
      fields: [
        { id: "tagLookRulesJson", key: "TagLookRules", type: "custom", label: "Edit as JSON" }
      ],
      render(ctx, body) {
        const max = JE.core.tagLook?.MAX_CONDITIONS || 5;
        body.innerHTML = `
                <p class="je-ta-empty" data-rules-empty>${ctx.tx("No rules. New users start with the default look.")}</p>
                <ol class="je-ta-rules" data-rules></ol>
                <h4 class="je-ta-sub" id="jeTaRuleAddTitle" tabindex="-1" data-rule-title>${ctx.tx("Add a rule")}</h4>
                <div class="je-ta-rule-form" role="group" aria-labelledby="jeTaRuleAddTitle">
                    <fieldset class="je-ta-conds">
                        <legend class="je-ta-conds-legend">${ctx.tx("When all of these hold")}</legend>
                        <div data-conds></div>
                        <div class="je-ta-cond-add"><button type="button" class="je-ta-button" data-rule="add-cond">${ctx.tx("+ Condition")}</button><span class="je-ta-hint" data-cond-count></span></div>
                    </fieldset>
                    <fieldset class="je-ta-rule-look">
                        <legend class="je-ta-conds-legend">${ctx.tx("Use this look")}</legend>
                        <div class="je-ta-rule-look-row">
                            <label>${ctx.tx("Layout")}<select data-rule="layout">${LAYOUTS.map((l) => `<option value="${l}">${ctx.tx(word(A.WORDS.layout, l))}</option>`).join("")}</select></label>
                            <label>${ctx.tx("Label density")}<select data-rule="density"><option value="full">${ctx.tx("Full")}</option><option value="compact">${ctx.tx("Compact")}</option></select></label>
                        </div>
                    </fieldset>
                    <p class="je-ta-rule-error" id="jeTaRuleError" aria-live="assertive"></p>
                    <p class="je-ta-hint" data-rule-extras hidden>${ctx.tx("This rule also sets its own group positions or episode and list-row looks. Saving keeps them; change them as JSON.")}</p>
                    <div class="je-ta-actions je-ta-rule-actions">
                        <button type="button" class="je-ta-button je-ta-button--primary" data-rule="add"><span class="material-icons" aria-hidden="true">add</span><span data-rule-save-label>${ctx.tx("Add rule")}</span></button>
                        <button type="button" class="je-ta-button" data-rule="cancel" hidden>${ctx.tx("Cancel")}</button>
                        <span class="je-ta-hint" data-rule-hint>${ctx.tx("Added at the end of the list.")}</span>
                    </div>
                </div>
                <details class="je-ta-json" style="margin-top:14px">
                    <summary class="je-ta-link" id="tagLookRulesJsonLabel">${ctx.tx("Edit as JSON")}</summary>
                    <p class="je-ta-hint">${ctx.tx("For what the form does not set: per-rule group positions and episode or list-row looks. Each rule: when (1-5 conditions, all must hold; field library, type, genre or ageRating), layout and density. At most 50 rules.")}</p>
                    <textarea id="tagLookRulesJson" rows="10" spellcheck="false" aria-labelledby="tagLookRulesJsonLabel" aria-describedby="tagLookRulesJsonStatus tagLookRulesJsonStale"></textarea>
                    <p class="je-ta-json-status" id="tagLookRulesJsonStatus" role="status"></p>
                    <p class="je-ta-json-status je-ta-json-stale" id="tagLookRulesJsonStale" role="status" hidden>${ctx.tx("The saved rules changed while you were editing. Save JSON replaces them with this text; Revert loads the saved rules.")}</p>
                    <div class="je-ta-actions"><button type="button" class="je-ta-button" data-rule="json-save">${ctx.tx("Save JSON")}</button><button type="button" class="je-ta-button" data-rule="json-revert">${ctx.tx("Revert")}</button></div>
                </details>`;
        const form = must(body, ".je-ta-rule-form");
        const conds = must(form, "[data-conds]");
        const addCond = mustAs(form, '[data-rule="add-cond"]', HTMLButtonElement);
        const saveButton = mustAs(form, '[data-rule="add"]', HTMLButtonElement);
        const cancelButton = mustAs(form, '[data-rule="cancel"]', HTMLButtonElement);
        const error = must(form, "#jeTaRuleError");
        const title = must(body, "[data-rule-title]");
        const layoutSelect = mustAs(form, '[data-rule="layout"]', HTMLSelectElement);
        const densitySelect = mustAs(form, '[data-rule="density"]', HTMLSelectElement);
        const saveLabel = must(form, "[data-rule-save-label]");
        const capacityHint = must(form, "[data-rule-hint]");
        const syncRows = () => {
          const rows = all(conds, "[data-cond]");
          rows.forEach((row, i) => {
            const n = String(i + 1);
            must(row, "[data-cond-n]").textContent = A.fmt("Condition {n}", { n });
            must(row, "[data-cond-field-label]").textContent = A.fmt("Condition {n} field", { n });
            must(row, "[data-cond-value-label]").textContent = A.fmt("Condition {n} value", { n });
            const remove = mustAs(row, "[data-cond-remove]", HTMLButtonElement);
            remove.disabled = rows.length <= 1;
            remove.setAttribute("aria-label", A.fmt("Remove condition {n}", { n }));
          });
          addCond.disabled = rows.length >= max;
          must(form, "[data-cond-count]").textContent = A.fmt("{count} of {max}", { count: rows.length, max });
        };
        const setRows = (rows) => {
          conds.innerHTML = rows.map((cond, i) => conditionRowHtml(ctx, cond, i === 0)).join("");
          syncRows();
        };
        const syncCapacity = () => {
          const editing = editsOf(ctx).index >= 0;
          const full = !editing && rulesOf(ctx.config).length >= MAX_RULES;
          saveButton.disabled = full;
          capacityHint.textContent = A.fmt(full ? "You have {count} rules, the most there can be." : editing ? "Keeps the rule's place and On/Off state." : "Added at the end of the list.", { count: MAX_RULES });
        };
        const fillForm = (rule, index = -1) => {
          if (rule) edits.set(ctx, { index, id: str(rule, "id") });
          else edits.delete(ctx);
          const when = rule ? list(either(rule, "when")).map((c) => ({ field: str(c, "field"), value: str(c, "value") })) : [];
          setRows(when.length ? when : [{ field: "library", value: "" }]);
          layoutSelect.value = rule ? String(either(rule, "layout") || "corners").toLowerCase() : "caption";
          densitySelect.value = rule && str(rule, "density").toLowerCase() !== "compact" ? "full" : "compact";
          title.textContent = rule ? `${A.fmt("Edit rule")} ${index + 1}` : A.fmt("Add a rule");
          saveLabel.textContent = A.fmt(rule ? "Save rule" : "Add rule");
          const icon = saveButton.querySelector(".material-icons");
          if (icon) icon.textContent = rule ? "check" : "add";
          cancelButton.hidden = !rule;
          must(form, "[data-rule-extras]").hidden = !(rule && hasExtras(rule));
          error.textContent = "";
          syncCapacity();
        };
        const backToAdding = () => {
          edits.delete(ctx);
          title.textContent = A.fmt("Add a rule");
          saveLabel.textContent = A.fmt("Add rule");
          cancelButton.hidden = true;
          syncCapacity();
        };
        conds.addEventListener("change", (e) => {
          const select = e.target;
          if (!(select instanceof HTMLElement)) return;
          if (select.matches("[data-cond-value]")) {
            select.removeAttribute("aria-invalid");
            select.removeAttribute("aria-describedby");
            return;
          }
          if (!select.matches("[data-cond-field]") || !(select instanceof HTMLSelectElement)) return;
          const row = select.closest("[data-cond]");
          const slot = find(row, "[data-rule-value]");
          const old = find(slot, "[data-cond-value]");
          if (!slot || !old) return;
          slot.innerHTML = valueControl(ctx, select.value, "", old.id, old.dataset.rule === "value");
        });
        conds.addEventListener("click", (e) => {
          const remove = closest(e, "[data-cond-remove]");
          if (!remove || isDisabled(remove)) return;
          const rows = all(conds, "[data-cond]");
          const own = remove.closest("[data-cond]");
          const at = rows.findIndex((r) => r === own);
          const kept = rows.filter((_, i) => i !== at).map((row) => ({ field: findAs(row, "[data-cond-field]", HTMLSelectElement)?.value || "", value: valueIn(row)?.value || "" }));
          setRows(kept);
          const left = all(conds, "[data-cond-field]");
          left[Math.min(at, left.length - 1)]?.focus();
        });
        addCond.addEventListener("click", () => {
          const rows = all(conds, "[data-cond]");
          if (rows.length >= max) return;
          conds.insertAdjacentHTML("beforeend", conditionRowHtml(ctx, { field: "type", value: "" }, rows.length === 0));
          syncRows();
          focus(conds.lastElementChild?.querySelector("[data-cond-field]"));
        });
        cancelButton.addEventListener("click", () => {
          const { index } = editsOf(ctx);
          fillForm(null);
          ctx.refresh({ controls: false });
          (find(body, `.je-ta-rule[data-index="${index}"] [data-act="edit"]`) || title).focus();
        });
        saveButton.addEventListener("click", () => {
          const when = [];
          for (const row of all(conds, "[data-cond]")) {
            const field = findAs(row, "[data-cond-field]", HTMLSelectElement)?.value || "";
            const control = valueIn(row);
            if (!control) continue;
            const value = String(control.value || "").trim();
            if (!value || field === "library" && !/^[0-9a-fA-F]{32}$/.test(value.replace(/-/g, ""))) {
              error.textContent = A.fmt(field === "library" ? "Pick a library." : "Choose or enter a value for every condition.");
              control.setAttribute("aria-invalid", "true");
              control.setAttribute("aria-describedby", "jeTaRuleError");
              control.focus();
              return;
            }
            when.push({ Field: field, Value: field === "library" ? value.replace(/-/g, "").toLowerCase() : value });
          }
          const rules = rulesOf(ctx.config);
          const { index, id } = editsOf(ctx);
          const at = index < 0 ? -1 : id ? rules.findIndex((r) => str(r, "id") === id) : index < rules.length ? index : -1;
          if (at < 0 && rules.length >= MAX_RULES) {
            error.textContent = A.fmt("You have {count} rules, the most there can be.", { count: MAX_RULES });
            return;
          }
          error.textContent = "";
          const layout = layoutSelect.value;
          const density = densitySelect.value;
          let n;
          const edited = at >= 0 ? rules[at] : void 0;
          if (edited) {
            const next = { ...edited, When: when, Layout: layout, Density: density };
            for (const lower of ["when", "layout", "density"]) delete next[lower];
            rules[at] = next;
            n = at + 1;
          } else {
            const taken = new Set(rules.map((r) => str(r, "id")));
            const look = JE.core.tagLook;
            rules.push({ Id: look?.newRuleId ? look.newRuleId(taken) : "", Enabled: true, When: when, Layout: layout, Density: density, ColourPreset: null, Slots: null });
            n = rules.length;
          }
          fillForm(null);
          ctx.set("TagLookRules", rules);
          ctx.announce(A.fmt(edited ? "Rule {n} saved" : "Rule {n} added", { n }));
          if (edited) find(body, `.je-ta-rule[data-index="${at}"] [data-act="edit"]`)?.focus();
        });
        body.querySelector("[data-rules]")?.addEventListener("click", (e) => {
          const button = closest(e, "button[data-act]");
          const row = button?.closest(".je-ta-rule");
          if (!button || !(row instanceof HTMLElement) || isDisabled(button)) return;
          const i = Number(row.dataset.index);
          const rules = rulesOf(ctx.config);
          if (button.dataset.act === "edit") {
            const rule = rules[i];
            if (!rule) return;
            fillForm(rule, i);
            ctx.refresh({ controls: false });
            find(conds, "[data-cond-field]")?.focus();
          } else if (button.dataset.act === "move") {
            const to = i + Number(button.dataset.dir);
            if (to < 0 || to >= rules.length) return;
            rules.splice(to, 0, ...rules.splice(i, 1));
            const editing = editsOf(ctx);
            if (editing.index === i) edits.set(ctx, { ...editing, index: to });
            else if (editing.index === to) edits.set(ctx, { ...editing, index: i });
            ctx.set("TagLookRules", rules);
            const again = find(body, `.je-ta-rule[data-index="${to}"] [data-act="move"][data-dir="${button.dataset.dir}"]`);
            focus(again && !isDisabled(again) ? again : body.querySelector(`.je-ta-rule[data-index="${to}"] [data-act="enable"]`));
          } else if (button.dataset.act === "delete") {
            const before = rulesOf(ctx.config);
            rules.splice(i, 1);
            const editing = editsOf(ctx);
            if (editing.index === i) backToAdding();
            else if (editing.index > i) edits.set(ctx, { ...editing, index: editing.index - 1 });
            ctx.set("TagLookRules", rules.length ? rules : null);
            ctx.snack(A.fmt("Rule {n} deleted", { n: i + 1 }), () => ctx.set("TagLookRules", before));
            focus(body.querySelector(`.je-ta-rule[data-index="${Math.min(i, rules.length - 1)}"] [data-act="delete"]`) || body.querySelector('[data-rule="field"]'));
          }
        });
        body.querySelector("[data-rules]")?.addEventListener("change", (e) => {
          const input = e.target;
          if (!(input instanceof HTMLInputElement)) return;
          const row = input.closest(".je-ta-rule");
          if (!(row instanceof HTMLElement) || input.dataset.act !== "enable") return;
          const rules = rulesOf(ctx.config);
          const i = Number(row.dataset.index);
          const next = { ...rules[i] || {}, Enabled: input.checked };
          delete next.enabled;
          rules[i] = next;
          ctx.set("TagLookRules", rules);
          find(body, `.je-ta-rule[data-index="${i}"] [data-act="enable"]`)?.focus();
        });
        const box = mustAs(body, "#tagLookRulesJson", HTMLTextAreaElement);
        const status = must(body, "#tagLookRulesJsonStatus");
        const draft = draftOf(body);
        const check = () => {
          const parsed = parseRules(box.value);
          status.textContent = parsed.error ? parsed.error : parsed.rules.length ? A.fmt("{n} {n|rule|rules} will be saved.", { n: parsed.rules.length }) : A.fmt("No rules. New users start with the default look.");
          status.dataset.error = String(!!parsed.error);
          return parsed;
        };
        draft.check = check;
        box.addEventListener("input", () => {
          draft.dirty = box.value !== draft.loaded;
          if (!draft.dirty) must(body, "#tagLookRulesJsonStale").hidden = true;
          check();
        });
        body.querySelector('[data-rule="json-save"]')?.addEventListener("click", () => {
          const parsed = check();
          if (parsed.error) {
            box.focus();
            return;
          }
          draft.dirty = false;
          ctx.set("TagLookRules", parsed.rules.length ? parsed.rules : null);
          ctx.announce(A.fmt("Rules saved"));
        });
        body.querySelector('[data-rule="json-revert"]')?.addEventListener("click", () => {
          loadRules(ctx, body, true);
        });
        const updateChoices = (field) => {
          for (const row of all(conds, "[data-cond]")) {
            if (findAs(row, "[data-cond-field]", HTMLSelectElement)?.value !== field) continue;
            const slot = find(row, "[data-rule-value]");
            const current = valueIn(row);
            if (!slot || !current) continue;
            const value = String(current.value || "").trim();
            const hadFocus = current === activeElement();
            const next = valueControl(ctx, field, value, current.id, current.dataset.rule === "value");
            if (current instanceof HTMLSelectElement) {
              const holder = document.createElement("div");
              holder.innerHTML = next;
              const fresh = holder.querySelector("select");
              if (fresh) {
                current.innerHTML = fresh.innerHTML;
                current.value = fresh.value;
              }
              continue;
            }
            if (value && field !== "ageRating") continue;
            slot.innerHTML = next;
            const placed = valueIn(slot);
            if (placed && field === "ageRating") placed.value = value;
            if (hadFocus) placed?.focus({ preventScroll: true });
          }
        };
        const client = apiClient();
        client.getJSON(client.getUrl("Library/VirtualFolders")).then((folders) => {
          if (!ctx.isCurrent()) return;
          if (folders && !Array.isArray(folders)) throw new TypeError("The library list is not an array");
          const names = {};
          for (const f of Array.isArray(folders) ? folders : []) {
            if (!f || typeof f !== "object") continue;
            const id = Reflect.get(f, "ItemId");
            if (id) names[String(id).replace(/-/g, "").toLowerCase()] = String(Reflect.get(f, "Name") ?? "");
          }
          libraryNames.set(ctx, names);
          updateChoices("library");
          ctx.refresh({ controls: false });
        }).catch((err) => console.warn("🪼 Jellyfin Enhanced: could not load the library list", err));
        client.getJSON(client.getUrl("Items/Filters", { userId: client.getCurrentUserId?.(), Recursive: true, IncludeItemTypes: "Movie,Series,Season,Episode,BoxSet,Video" })).then((filters) => {
          if (!ctx.isCurrent()) return;
          const values = (key) => {
            const raw = filters && typeof filters === "object" ? Reflect.get(filters, key) : void 0;
            return Array.isArray(raw) ? Array.from(new Set(raw.map((v) => String(v || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b)) : [];
          };
          suggestions.set(ctx, { genres: values("Genres"), ratings: values("OfficialRatings") });
          updateChoices("genre");
          updateChoices("ageRating");
        }).catch((err) => console.warn("🪼 Jellyfin Enhanced: could not load the genre and age rating suggestions", err));
        fillForm(null);
        loadRules(ctx, body);
      },
      load: (ctx, body) => loadRules(ctx, body),
      refresh(ctx, body) {
        const rowsBox = find(body, "[data-rules]");
        if (!rowsBox || !body) return;
        const rules = rulesOf(ctx.config);
        const editing = editsOf(ctx);
        if (editing.index >= 0 && (editing.id ? !rules.some((r) => str(r, "id") === editing.id) : editing.index >= rules.length)) {
          edits.delete(ctx);
          const title = find(body, "[data-rule-title]");
          if (title) title.textContent = A.fmt("Add a rule");
          const label = find(body, "[data-rule-save-label]");
          if (label) label.textContent = A.fmt("Add rule");
          const cancel = find(body, '[data-rule="cancel"]');
          if (cancel) cancel.hidden = true;
        } else if (editing.id) {
          const at = rules.findIndex((r) => str(r, "id") === editing.id);
          if (at !== editing.index) {
            edits.set(ctx, { ...editing, index: at });
            const title = find(body, "[data-rule-title]");
            if (title) title.textContent = `${A.fmt("Edit rule")} ${at + 1}`;
          }
        }
        A.redrawList(rowsBox, rules.map((r, i) => ruleHtml(ctx, r, i, rules.length)).join(""), (el) => {
          const row = el.closest(".je-ta-rule");
          const i = row instanceof HTMLElement ? row.dataset.index : void 0;
          if (i === void 0 || !el.dataset.act) return null;
          return `.je-ta-rule[data-index="${i}"] [data-act="${el.dataset.act}"]${el.dataset.dir ? `[data-dir="${el.dataset.dir}"]` : ""}`;
        });
        const empty = find(body, "[data-rules-empty]");
        if (empty) empty.hidden = rules.length > 0;
        const add = findAs(body, '[data-rule="add"]', HTMLButtonElement);
        const hint = find(body, "[data-rule-hint]");
        if (add && hint) {
          const full = editsOf(ctx).index < 0 && rules.length >= MAX_RULES;
          add.disabled = full;
          hint.textContent = A.fmt(full ? "You have {count} rules, the most there can be." : editsOf(ctx).index >= 0 ? "Keeps the rule's place and On/Off state." : "Added at the end of the list.", { count: MAX_RULES });
        }
        loadRules(ctx, body);
      }
    });
    A.registerSection({
      id: "rules-locks",
      tab: "rules",
      // A pointer, not a list: after the server-wide item looks, drawn as a note.
      order: 40,
      note: true,
      title: "Locked items",
      noteLabel: "How user-locked looks work",
      hint: "Locks keep one title's look whatever the rules say. They belong to each user, who sets them from an item's menu and manages them in their Media Tags settings, so there are none to set here."
    });
    const titleState = /* @__PURE__ */ new WeakMap();
    function titlesOf(ctx) {
      let state = titleState.get(ctx);
      if (!state) titleState.set(ctx, state = { titles: /* @__PURE__ */ new Map(), loading: /* @__PURE__ */ new Set() });
      return state;
    }
    async function loadItemTitles(ctx, ids) {
      const { titles, loading } = titlesOf(ctx);
      const missing = ids.filter((id) => !titles.has(id) && !loading.has(id));
      for (const id of missing) loading.add(id);
      try {
        for (let i = 0; i < missing.length; i += 50) {
          const batch = missing.slice(i, i + 50);
          try {
            const client = apiClient();
            const resp = await client.getJSON(client.getUrl(`Users/${currentUserId(client)}/Items`, { Ids: batch.join(","), EnableImages: false, EnableUserData: false }));
            if (!ctx.isCurrent()) return false;
            const items = resp && typeof resp === "object" ? Reflect.get(resp, "Items") : void 0;
            for (const item of Array.isArray(items) ? items : []) {
              if (!item || typeof item !== "object") continue;
              const name = Reflect.get(item, "Name");
              const type = Reflect.get(item, "Type");
              titles.set(String(Reflect.get(item, "Id")).replace(/-/g, "").toLowerCase(), { name: String(name || ""), type: String(type || "") });
            }
          } catch (err) {
            if (!ctx.isCurrent()) return false;
            console.warn("🪼 Jellyfin Enhanced: could not load the item titles", err);
          }
          for (const id of batch) if (!titles.has(id)) titles.set(id, { name: "", type: "" });
        }
      } finally {
        for (const id of missing) loading.delete(id);
      }
      return missing.length > 0;
    }
    function itemLookHtml(ctx, id, look) {
      const info = titlesOf(ctx).titles.get(id);
      const name = info ? info.name || A.fmt("Unavailable item") : A.fmt("Loading…");
      const type = info?.type ? `${A.fmt(word(A.WORDS.type, info.type.toLowerCase()))} · ` : "";
      const outcome = A.fmt("{layout} · {density}", { layout: A.fmt(word(A.WORDS.layout, look.layout)), density: word(A.WORDS.density, look.density) || "" });
      const scope = info?.type === "Series" ? ` · ${A.fmt(look.scope === "item" ? "This series poster only" : "This series and its seasons and episodes")}` : "";
      const label = info?.name || id;
      return `<li class="je-ta-rule" data-item="${ctx.esc(id)}" data-je-focus-key="admin-item-look-row-${ctx.esc(id)}">
            <span class="je-ta-rule-text"><strong class="je-ta-rule-title">${ctx.esc(name)}</strong> <span class="je-ta-rule-meta">${ctx.esc(type)}${ctx.esc(outcome)}${ctx.esc(scope)}</span></span>
            <span class="je-ta-rule-tools">
                <button type="button" class="je-ta-button" data-act="edit" data-je-focus-key="admin-item-look-edit-${ctx.esc(id)}" aria-label="${ctx.esc(A.fmt("Edit the server-wide look of {name}", { name: label }))}">${ctx.tx("Edit")}</button>
                <button type="button" class="je-ta-icon-btn" data-act="remove" data-je-focus-key="admin-item-look-remove-${ctx.esc(id)}" aria-label="${ctx.esc(A.fmt("Remove the server-wide look of {name}", { name: label }))}"><span class="material-icons" aria-hidden="true">delete</span></button>
            </span>
        </li>`;
    }
    function refreshItemLooks(ctx, body) {
      const listBox = find(body, "[data-item-looks]");
      const look = JE.core.tagLook;
      if (!listBox || !look || !body) return;
      const looks = look.normalizeItemOverrides(ctx.config.TagLookItemOverrides ?? null);
      const focused = activeElement();
      const focusKey = focused && listBox.contains(focused) ? focused.dataset.jeFocusKey : null;
      listBox.innerHTML = Array.from(looks.entries()).map(([id, entry]) => itemLookHtml(ctx, id, entry)).join("");
      if (focusKey) all(listBox, "[data-je-focus-key]").find((el) => el.dataset.jeFocusKey === focusKey)?.focus({ preventScroll: true });
      const empty = find(body, "[data-item-looks-empty]");
      if (empty) empty.hidden = looks.size > 0;
      void loadItemTitles(ctx, Array.from(looks.keys())).then((added) => {
        if (added && ctx.isCurrent()) refreshItemLooks(ctx, body);
      });
    }
    A.registerSection({
      id: "item-looks",
      tab: "rules",
      order: 30,
      title: "Server-wide item looks",
      hint: "Looks one title gets for every user, set with For everyone in the item's Media Tags editor (its ⋮ menu). A user's own locked look wins; rules never change these.",
      writes: ["TagLookItemOverrides"],
      render(ctx, body) {
        const heading = find(body.closest("[data-section]"), "h3");
        if (heading) heading.tabIndex = -1;
        body.innerHTML = `<p class="je-ta-empty" data-item-looks-empty>${ctx.tx("No server-wide item looks yet.")}</p><ol class="je-ta-rules" data-item-looks></ol>`;
        body.querySelector("[data-item-looks]")?.addEventListener("click", (e) => {
          const button = closest(e, "button[data-act]");
          const row = button?.closest("[data-item]");
          const look = JE.core.tagLook;
          if (!button || !(row instanceof HTMLElement) || !look) return;
          const id = row.dataset.item || "";
          const stored = ctx.config.TagLookItemOverrides ?? null;
          const name = titlesOf(ctx).titles.get(id)?.name || id;
          if (button.dataset.act === "remove") {
            const next = look.itemOverridesWith(stored, id, null);
            if (next === void 0) return;
            ctx.set("TagLookItemOverrides", copy(next));
            const entry = look.normalizeItemOverrides(stored).get(id);
            const removed = entry ? look.itemOverridesToWire(/* @__PURE__ */ new Map([[id, entry]])) : null;
            ctx.snack(A.fmt("Server-wide look removed from {name}", { name }), () => {
              if (ctx.isCurrent()) ctx.set("TagLookItemOverrides", copy(look.restoreItemOverrides(ctx.config.TagLookItemOverrides, removed)));
            });
            const nextRemove = find(body, '[data-item] [data-act="remove"]');
            if (nextRemove) nextRemove.focus();
            else {
              const cardTitle = find(body.closest(".je-ta-card"), ".je-ta-card-title");
              if (cardTitle) {
                cardTitle.tabIndex = -1;
                cardTitle.focus();
              }
            }
          } else if (button.dataset.act === "edit") {
            let focusTarget = id;
            JE.tagItemEditor?.open(id, {
              mode: "server",
              opener: button,
              returnFocus: () => find(body, `[data-item="${focusTarget}"] [data-act="edit"]`) || heading,
              look: look.normalizeItemOverrides(stored).get(id) || null,
              onSave: (chosen, target) => {
                let next = look.itemOverridesWith(ctx.config.TagLookItemOverrides ?? null, id, target === id ? chosen : null);
                if (next !== void 0 && target !== id) next = look.itemOverridesWith(next, target, chosen);
                if (next === void 0) return;
                focusTarget = target;
                ctx.set("TagLookItemOverrides", copy(next));
                ctx.announce(A.fmt("Server-wide look saved for {name}", { name }));
              }
            });
          }
        });
      },
      refresh: refreshItemLooks
    });
    A.rulesData = { parseRules, conditionText };
  });
})();
})();
//# sourceMappingURL=rules.js.map
