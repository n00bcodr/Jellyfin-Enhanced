(() => {
"use strict";
(() => {
  // client/src/features/media-tags/host.ts
  function settingsUi(JE) {
    return JE.internals?.enhancedUi;
  }

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
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function findAs(scope, selector, type) {
    const el = scope?.querySelector(selector);
    return el instanceof type ? el : null;
  }
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
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
    for (const [key, member2] of Object.entries(value)) {
      if (member2 === void 0) continue;
      if (!isJson(member2)) return null;
      out[key] = member2;
    }
    return out;
  }
  function copy(value) {
    if (value === void 0) return null;
    const out = JSON.parse(JSON.stringify(value));
    return isJson(out) ? out : null;
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/portable.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'server',
      title: 'Import & export',
  registerSection({
      tab: 'server',
      title: 'Presets for users',
          { id: 'tagOfferedPresets', key: 'TagOfferedPresets', type: 'custom', label: 'Presets for users' },
  */
  var MAX_OFFERED = 20;
  var MAX_NAME = 60;
  var MAX_DESCRIPTION = 240;
  function offered(config) {
    try {
      const parsed = JSON.parse(String(config.TagOfferedPresets || "") || "[]");
      const value = copy(parsed);
      return Array.isArray(value) ? value.filter(isObject) : [];
    } catch {
      return [];
    }
  }
  function presetId(name, presets) {
    const base = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "preset";
    let id;
    do
      id = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    while (presets.some((p) => p.id === id));
    return id;
  }
  function request(type, path, body) {
    const client = apiClient();
    return client.ajax({
      type,
      url: client.getUrl(`/JellyfinEnhanced/${path}`),
      dataType: "json",
      ...body ? { data: JSON.stringify(body), contentType: "application/json" } : {}
    });
  }
  function changesOf(answer) {
    const raw = answer && typeof answer === "object" ? Reflect.get(answer, "changes") : void 0;
    const out = [];
    for (const c of Array.isArray(raw) ? raw : []) {
      if (!c || typeof c !== "object") continue;
      const field = Reflect.get(c, "field");
      if (typeof field !== "string") continue;
      out.push({ field, from: copy(Reflect.get(c, "from") ?? null), to: copy(Reflect.get(c, "to") ?? null) });
    }
    return out;
  }
  var member = (value, key) => value && typeof value === "object" ? Reflect.get(value, key) : void 0;
  function failed(P, d, message, retry = false) {
    const line = find(d.body, "[data-pt-loading]");
    if (line) line.hidden = true;
    d.status(message, "error");
    if (!retry || !P) return;
    const again = d.foot.querySelector('[data-pt-action="retry"]');
    if (again) {
      again.removeAttribute("aria-disabled");
      return;
    }
    const close = d.foot.querySelector('[data-pt-action="close"]') ? P.buttonHtml("close", "Close") : P.buttonHtml("cancel", "Cancel");
    d.foot.innerHTML = close + P.buttonHtml("retry", "Retry", { primary: true });
    find(d.foot, '[data-pt-action="retry"]')?.focus();
  }
  function startRetry(button) {
    if (!button || button.getAttribute("aria-disabled") === "true") return false;
    button.setAttribute("aria-disabled", "true");
    return true;
  }
  var actionOf = (e) => closest(e, "[data-pt-action]")?.getAttribute("data-pt-action") ?? null;
  installSection((A, JE) => {
    const tools = () => settingsUi(JE)?.tagPortable || null;
    async function reloadPage(ctx) {
      try {
        const fresh = configOf(await apiClient().getPluginConfiguration(A.PLUGIN_ID));
        if (ctx.isCurrent() && fresh) ctx.reload(fresh);
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: could not reload the configuration", err);
      }
    }
    A.registerSection({
      id: "server-portable",
      tab: "server",
      order: 30,
      title: "Import & export",
      hint: "Copy these server-wide Media Tags settings to another server, or keep a backup. You can also import your own settings from the Enhanced panel as the defaults. An import shows what changes and is saved like any edit on this page.",
      render(ctx, body) {
        const P = tools();
        body.innerHTML = `<div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaExport"><span class="material-icons" aria-hidden="true">download</span>${ctx.tx("Export server settings")}</button>
                    <button type="button" class="je-ta-button" id="jeTaImport"><span class="material-icons" aria-hidden="true">upload</span>${ctx.tx("Import server settings")}</button>
                </div>
                <p class="je-ta-hint">${ctx.tx("API keys and the custom rule key are never exported or imported.")}</p>`;
        if (!P) return;
        P.injectDialogCss();
        let dialog = null;
        const show = (titleKey) => {
          dialog?.close();
          const opened = P.openDialog({ host: ctx.root, title: A.fmt(titleKey), onClose: () => {
            dialog = null;
          } });
          dialog = opened;
          return opened;
        };
        ctx.signal.addEventListener("abort", () => dialog?.close());
        const exportHint = ctx.tx("Every setting on this page: defaults, groups, Tag Styles, custom rules, award lists, logo choices, status windows, cache options and offered presets.");
        body.querySelector("#jeTaExport")?.addEventListener("click", async () => {
          const d = show("Export server Media Tags settings");
          d.body.innerHTML = `<p class="je-pt-hint">${exportHint}</p><p class="je-pt-hint" data-pt-loading>${ctx.tx("Loading…")}</p>`;
          d.foot.innerHTML = P.buttonHtml("close", "Close");
          const load = async () => {
            let document2;
            try {
              const saved = await ctx.flush();
              if (!ctx.isCurrent() || d.closed()) return;
              if (!saved) {
                failed(P, d, A.fmt("Not exported: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then export again."), true);
                return;
              }
              document2 = await request("GET", "admin/media-tags/export");
            } catch (err) {
              if (!ctx.isCurrent() || d.closed()) return;
              console.warn("🪼 Jellyfin Enhanced: could not export the Media Tags settings", err);
              failed(P, d, A.fmt("Could not read the settings. Try again."), true);
              return;
            }
            if (!ctx.isCurrent() || d.closed()) return;
            d.status("");
            showExport(d, document2);
          };
          d.foot.onclick = (e) => {
            const button = closest(e, "[data-pt-action]");
            const action = button?.getAttribute("data-pt-action");
            if (action === "close") d.close();
            else if (action === "retry" && startRetry(button)) {
              const line = find(d.body, "[data-pt-loading]");
              if (line) line.hidden = false;
              d.status(A.fmt("Checking…"));
              void load();
            }
          };
          d.focusFirst();
          await load();
        }, { signal: ctx.signal });
        const showExport = (d, document2) => {
          const json = JSON.stringify(document2, null, 2);
          const settings = member(document2, "settings");
          const count = settings && typeof settings === "object" ? Object.keys(settings).length : 0;
          d.body.innerHTML = `<p class="je-pt-hint">${exportHint}</p>
                    <details class="je-pt-doc"><summary class="je-pt-doc-toggle"><span class="material-icons" aria-hidden="true">expand_more</span>${ctx.tx("Show the settings document ({count} {count|setting|settings})", { count })}</summary>
                    <label class="je-pt-label" for="jeTaExportText">${ctx.tx("Settings document ({count} {count|setting|settings})", { count })}</label>
                    <textarea id="jeTaExportText" class="je-pt-text" rows="12" readonly spellcheck="false">${ctx.esc(json)}</textarea></details>`;
          d.foot.innerHTML = P.buttonHtml("close", "Close") + P.buttonHtml("copy", "Copy", { icon: "content_copy" }) + P.buttonHtml("download", "Download", { icon: "download", primary: true });
          d.foot.onclick = async (e) => {
            const action = actionOf(e);
            if (action === "download") {
              P.download(document2, `jellyfin-media-tags-server-${P.stamp()}`);
              d.status(A.fmt("Downloaded."));
            } else if (action === "copy") d.status(A.fmt(await P.copyText(json, findAs(d.body, "textarea", HTMLTextAreaElement) ?? void 0) ? "Copied" : "Could not copy. Select the text and copy it yourself."));
            else if (action === "close") d.close();
          };
          find(d.foot, '[data-pt-action="download"]')?.focus();
        };
        const apply = async (d, changes) => {
          const before = Object.fromEntries(changes.map((c) => [c.field, copy(c.from ?? null)]));
          ctx.setMany(Object.fromEntries(changes.map((c) => [c.field, c.to])), { base: before });
          const saved = await ctx.flush();
          if (!ctx.isCurrent()) return;
          if (!saved) {
            d.status(A.fmt("Another administrator changed some of these settings meanwhile: choose Keep mine or Take theirs at the top of the page. The other settings were saved."), "error");
            return;
          }
          d.close();
          await reloadPage(ctx);
          ctx.snack(A.fmt("{count} server {count|setting|settings} changed.", { count: changes.length }), () => {
            ctx.setMany(before);
            void ctx.flush().then((ok) => ok ? reloadPage(ctx) : null);
          }, () => body.querySelector("#jeTaImport"));
        };
        body.querySelector("#jeTaImport")?.addEventListener("click", () => {
          const d = show("Import server Media Tags settings");
          const notSaved = () => A.fmt("Not previewed: changes on this page are not saved yet. Retry the save, or choose Keep mine or Take theirs, then preview again.");
          const preview = async (document2, note) => {
            d.status(A.fmt("Checking…"));
            const saved = await ctx.flush();
            if (!ctx.isCurrent() || d.closed()) return;
            if (!saved) {
              d.status(notSaved(), "error");
              return;
            }
            let fresh = null;
            try {
              fresh = configOf(await apiClient().getPluginConfiguration(A.PLUGIN_ID));
            } catch (err) {
              if (!ctx.isCurrent() || d.closed()) return;
              console.warn("🪼 Jellyfin Enhanced: could not read the configuration before the import preview", err);
            }
            if (!ctx.isCurrent() || d.closed()) return;
            if (!fresh) {
              d.status(A.fmt("Could not read the settings. Try again."), "error");
              return;
            }
            ctx.reload(fresh);
            let answer;
            try {
              answer = await request("POST", "admin/media-tags/preview", document2);
            } catch (err) {
              if (!ctx.isCurrent() || d.closed()) return;
              const { code } = await P.errorOf(err);
              d.status(code === "kind" ? A.fmt("This is not a Media Tags settings document. Paste an export from this page, or your own export from the Enhanced panel.") : P.errorText(code), "error");
              return;
            }
            if (!ctx.isCurrent() || d.closed()) return;
            d.status(note || "");
            const changes = changesOf(answer);
            const imported = member(answer, "imported");
            const fields = /* @__PURE__ */ new Set([...Object.keys(imported && typeof imported === "object" ? imported : {}), ...changes.map((c) => c.field)]);
            const snapshot = () => JSON.stringify(Array.from(fields, (f) => ctx.config[f] ?? null));
            const compared = snapshot();
            d.body.innerHTML = P.previewHtml(answer || {});
            d.foot.innerHTML = P.buttonHtml("back", "Back") + P.buttonHtml("cancel", "Cancel") + (changes.length ? P.buttonHtml("apply", A.fmt("Apply {count} {count|change|changes}", { count: changes.length }), { primary: true }) : "");
            d.foot.onclick = async (ev) => {
              const button = closest(ev, "[data-pt-action]");
              const next = button?.dataset.ptAction;
              if (next === "back") {
                d.status("");
                step();
                d.focusFirst();
              } else if (next === "cancel") d.close();
              else if (next === "apply" && button instanceof HTMLButtonElement) {
                const ok = await ctx.confirm(A.fmt("Change {count} server {count|setting|settings} for everyone?", { count: changes.length }), A.fmt("Import server Media Tags settings"));
                if (!ok || d.closed()) return;
                button.disabled = true;
                const settled = await ctx.flush();
                if (!ctx.isCurrent() || d.closed()) return;
                if (!settled) {
                  button.disabled = false;
                  d.status(notSaved(), "error");
                  return;
                }
                if (snapshot() !== compared) {
                  await preview(document2, A.fmt("Settings on this page changed since the preview. This is the preview again: check it, then apply."));
                  return;
                }
                await apply(d, changes);
                if (!d.closed()) button.disabled = false;
              }
            };
            (find(d.foot, '[data-pt-action="apply"]') || find(d.foot, '[data-pt-action="cancel"]'))?.focus();
          };
          const step = () => {
            d.body.innerHTML = P.sourceHtml("Choose a server export, or your own export from the Enhanced panel to make your settings the defaults, or paste its text. Settings the server does not accept are listed and skipped.");
            d.foot.innerHTML = P.buttonHtml("cancel", "Cancel") + P.buttonHtml("next", "Check", { primary: true });
            P.wireSource(d);
            d.foot.onclick = async (e) => {
              const action = actionOf(e);
              if (action === "cancel") {
                d.close();
                return;
              }
              if (action !== "next") return;
              const parsed = P.parseDocument(findAs(d.body, "[data-pt-paste]", HTMLTextAreaElement)?.value);
              if (parsed.error) {
                d.status(P.errorText(parsed.error), "error");
                return;
              }
              if (parsed.document) await preview(parsed.document);
            };
            d.focusFirst();
          };
          step();
        }, { signal: ctx.signal });
      }
    });
    A.registerSection({
      id: "server-presets",
      tab: "server",
      order: 40,
      title: "Presets for users",
      hint: "Offer these presets in every user's Presets list, next to the built-in ones. Up to 20.",
      fields: [
        { id: "tagOfferedPresets", key: "TagOfferedPresets", type: "custom", label: "Presets for users" }
      ],
      render(ctx, body) {
        const P = tools();
        body.innerHTML = `<div class="je-ta-offered" data-offered aria-live="polite"></div>
                <div class="je-ta-actions">
                    <button type="button" class="je-ta-button" id="jeTaOfferMine"><span class="material-icons" aria-hidden="true">person</span>${ctx.tx("Offer my settings")}</button>
                    <button type="button" class="je-ta-button" id="jeTaOfferImport"><span class="material-icons" aria-hidden="true">file_open</span>${ctx.tx("Offer from a file")}</button>
                </div>`;
        if (!P) return;
        P.injectDialogCss();
        let dialog = null;
        const show = (titleKey) => {
          dialog?.close();
          const opened = P.openDialog({ host: ctx.root, title: A.fmt(titleKey), onClose: () => {
            dialog = null;
          } });
          dialog = opened;
          return opened;
        };
        ctx.signal.addEventListener("abort", () => dialog?.close());
        const nameStep = (d, checked) => {
          d.body.innerHTML = `<p class="je-pt-hint">${ctx.tx("{count} {count|setting|settings}. Name the preset as users will see it.", { count: Object.keys(checked.imported).length })}</p>
                    <label class="je-pt-label" for="jeTaOfferName">${ctx.tx("Name")}</label>
                    <input id="jeTaOfferName" class="je-pt-input" type="text" maxlength="${MAX_NAME}" value="${ctx.esc(checked.name || "")}" data-pt-autofocus>
                    <label class="je-pt-label" for="jeTaOfferDesc">${ctx.tx("Description (optional)")}</label>
                    <textarea id="jeTaOfferDesc" class="je-pt-input" rows="2" maxlength="${MAX_DESCRIPTION}">${ctx.esc(checked.description || "")}</textarea>
                    ${checked.skipped.length ? P.previewHtml({ skipped: checked.skipped }, { summary: false }) : ""}`;
          d.foot.innerHTML = P.buttonHtml("cancel", "Cancel") + P.buttonHtml("offer", "Offer", { primary: true });
          let offeredId = "";
          d.foot.onclick = async (e) => {
            const button = closest(e, "[data-pt-action]");
            if (button?.dataset.ptAction === "cancel") {
              d.close();
              return;
            }
            if (button?.dataset.ptAction !== "offer" || !(button instanceof HTMLButtonElement)) return;
            const nameInput = findAs(d.body, "#jeTaOfferName", HTMLInputElement);
            const name = nameInput?.value.trim() || "";
            const description = findAs(d.body, "#jeTaOfferDesc", HTMLTextAreaElement)?.value.trim() || "";
            if (!name) {
              d.status(P.errorText("name"), "error");
              nameInput?.focus();
              return;
            }
            const presets = offered(ctx.config);
            const again = offeredId ? presets.findIndex((p) => p.id === offeredId) : -1;
            if (again < 0 && presets.length >= MAX_OFFERED) {
              d.status(A.fmt("{max} presets are offered already. Remove one first.", { max: MAX_OFFERED }), "error");
              return;
            }
            if (again < 0 && !offeredId) offeredId = presetId(name, presets);
            const preset = { v: 1, kind: "je-media-tags-preset", id: offeredId, name, description, settings: checked.imported };
            if (again < 0) presets.push(preset);
            else presets[again] = preset;
            button.disabled = true;
            ctx.set("TagOfferedPresets", JSON.stringify(presets));
            const saved = await ctx.flush();
            if (!ctx.isCurrent() || d.closed()) return;
            if (!saved) {
              button.disabled = false;
              d.status(A.fmt("Not saved. Try again."), "error");
              return;
            }
            d.close();
            ctx.snack(A.fmt("{name} is offered to users.", { name }));
          };
          d.focusFirst();
        };
        const check = async (d, document2, retry = false) => {
          d.status(A.fmt("Checking…"));
          let preview;
          try {
            preview = await request("POST", `user-settings/${currentUserId(apiClient())}/media-tags/preview`, document2);
          } catch (err) {
            if (!ctx.isCurrent() || d.closed()) return;
            const { code } = await P.errorOf(err);
            if (!ctx.isCurrent() || d.closed()) return;
            failed(P, d, P.errorText(code), retry);
            return;
          }
          if (!ctx.isCurrent() || d.closed()) return;
          d.status("");
          const importedRaw = copy(member(preview, "imported") ?? null);
          const skippedRaw = copy(member(preview, "skipped") ?? null);
          const skipped = Array.isArray(skippedRaw) ? skippedRaw : [];
          if (!isObject(importedRaw) || !Object.keys(importedRaw).length) {
            d.body.innerHTML = P.previewHtml({ skipped }, { summary: false });
            d.status(P.errorText("empty"), "error");
            return;
          }
          const textOf = (value) => value ? String(value) : "";
          nameStep(d, {
            name: textOf(member(preview, "name")) || textOf(member(document2, "name")),
            description: textOf(member(preview, "description")) || textOf(member(document2, "description")),
            imported: importedRaw,
            skipped
          });
        };
        body.querySelector("#jeTaOfferMine")?.addEventListener("click", async () => {
          const d = show("Offer a preset");
          d.body.innerHTML = `<p class="je-pt-hint" data-pt-loading>${ctx.tx("Loading…")}</p>`;
          d.foot.innerHTML = P.buttonHtml("cancel", "Cancel");
          const load = async () => {
            d.status(A.fmt("Checking…"));
            try {
              try {
                if (JE.currentSettings) await JE.saveUserSettings?.("settings.json", JE.currentSettings, { throwOnError: true, isCurrent: ctx.isCurrent });
              } catch (err) {
                if (!ctx.isCurrent() || d.closed()) return;
                console.warn("🪼 Jellyfin Enhanced: your own Media Tags settings are not saved yet", err);
                failed(P, d, A.fmt("Not offered: your latest change to your own Media Tags settings is not saved yet. Check the connection, then try again."), true);
                return;
              }
              if (!ctx.isCurrent() || d.closed()) return;
              const mine = await request("GET", `user-settings/${currentUserId(apiClient())}/media-tags/export`);
              if (!ctx.isCurrent() || d.closed()) return;
              await check(d, mine, true);
            } catch (err) {
              if (!ctx.isCurrent() || d.closed()) return;
              console.warn("🪼 Jellyfin Enhanced: could not read your Media Tags settings", err);
              failed(P, d, A.fmt("Could not read the settings. Try again."), true);
            }
          };
          d.foot.onclick = (e) => {
            const button = closest(e, "[data-pt-action]");
            const action = button?.getAttribute("data-pt-action");
            if (action === "cancel") d.close();
            else if (action === "retry" && startRetry(button)) {
              const line = find(d.body, "[data-pt-loading]");
              if (line) line.hidden = false;
              void load();
            }
          };
          d.focusFirst();
          await load();
        }, { signal: ctx.signal });
        body.querySelector("#jeTaOfferImport")?.addEventListener("click", () => {
          const d = show("Offer a preset");
          d.body.innerHTML = P.sourceHtml("Choose a preset or settings file, or paste one a user shared.");
          d.foot.innerHTML = P.buttonHtml("cancel", "Cancel") + P.buttonHtml("next", "Check", { primary: true });
          P.wireSource(d);
          d.foot.onclick = (e) => {
            const action = actionOf(e);
            if (action === "cancel") {
              d.close();
              return;
            }
            if (action !== "next") return;
            const parsed = P.parseDocument(findAs(d.body, "[data-pt-paste]", HTMLTextAreaElement)?.value);
            if (parsed.error) {
              d.status(P.errorText(parsed.error), "error");
              return;
            }
            void check(d, parsed.document);
          };
          d.focusFirst();
        }, { signal: ctx.signal });
        body.querySelector("[data-offered]")?.addEventListener("click", async (e) => {
          const button = closest(e, "[data-offer-action]");
          const item = button?.closest("[data-offer-id]");
          if (!button || !item) return;
          const presets = offered(ctx.config);
          const preset = presets.find((p) => p.id === item.getAttribute("data-offer-id"));
          if (!preset) return;
          const presetName = String(preset.name ?? "");
          if (button.dataset.offerAction === "share") {
            const copied = await P.copyText(JSON.stringify(preset, null, 2));
            ctx.snack(A.fmt(copied ? "{name} copied. Paste it to share it." : "Could not copy. Select the text and copy it yourself.", { name: presetName }));
            return;
          }
          const ok = await ctx.confirm(A.fmt("Stop offering {name}? Users who applied it keep their settings.", { name: presetName }), A.fmt("Remove"));
          if (!ok) return;
          const rest = presets.filter((p) => p !== preset);
          ctx.set("TagOfferedPresets", rest.length ? JSON.stringify(rest) : "");
          find(body, "#jeTaOfferMine")?.focus();
          ctx.snack(A.fmt("{name} removed.", { name: presetName }), () => ctx.set("TagOfferedPresets", JSON.stringify(presets)));
        }, { signal: ctx.signal });
      },
      refresh(ctx, body) {
        const box = find(body, "[data-offered]");
        if (!box || !body) return;
        const presets = offered(ctx.config);
        const count = `<p class="je-ta-hint">${ctx.tx("{count} of {max} offered", { count: presets.length, max: MAX_OFFERED })}</p>`;
        A.redrawList(box, count + (presets.length ? `<ul class="je-ta-list je-ta-offered-list">${presets.map((p) => `<li data-offer-id="${ctx.esc(p.id)}">
                    <span class="je-ta-offered-text"><strong>${ctx.esc(p.name)}</strong>${p.description ? `<span class="je-ta-hint">${ctx.esc(p.description)}</span>` : ""}</span>
                    <span class="je-ta-offered-buttons">
                        <button type="button" class="je-ta-button" data-offer-action="share" aria-label="${ctx.tx("Share {name} (copies it)", { name: String(p.name) })}">${ctx.tx("Share")}</button>
                        <button type="button" class="je-ta-button" data-offer-action="remove" aria-label="${ctx.tx("Remove {name}", { name: String(p.name) })}">${ctx.tx("Remove")}</button>
                    </span></li>`).join("")}</ul>` : `<p class="je-ta-hint">${ctx.tx("No presets offered yet.")}</p>`), (el) => {
          const id = el.closest("[data-offer-id]")?.getAttribute("data-offer-id");
          const act = el.dataset.offerAction;
          return id && act ? `[data-offer-id="${id.replace(/["\\]/g, "\\$&")}"] [data-offer-action="${act}"]` : null;
        });
        const full = presets.length >= MAX_OFFERED;
        for (const id of ["#jeTaOfferMine", "#jeTaOfferImport"]) {
          const button = findAs(body, id, HTMLButtonElement);
          if (button) button.disabled = full;
        }
      }
    });
  });
})();
})();
//# sourceMappingURL=portable.js.map
