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

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/custom.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'Custom',
      group: { id: 'custom' },
      writes: ['TagGroupScopes'],
          { id: 'customTagsEnabled', key: 'CustomTagsEnabled', type: 'enable', label: 'Custom tags for new users' },
          { id: 'customTagRules', key: 'CustomTagRules', type: 'custom', label: 'Custom tag rules' },
  */
  installSection((A) => {
    let loadEditor = null;
    A.registerSection({
      id: "group-custom",
      tab: "groups",
      order: 80,
      title: "Custom",
      hint: "Match existing tags or collections to labels and icons. Up to 20 rules; labels up to 24 characters. Collections require the server cache.",
      group: {
        id: "custom",
        summary: (ctx) => A.fmt("{n} of {max} rules", { n: Array.isArray(ctx.config.CustomTagRules) ? ctx.config.CustomTagRules.length : 0, max: 20 }),
        sample: () => [["status", A.fmt("Custom")]]
      },
      // "Where to show" (drawn for every group row by admin-tags.js).
      writes: ["TagGroupScopes"],
      fields: [
        { id: "customTagsEnabled", key: "CustomTagsEnabled", type: "enable", label: "Custom tags for new users" },
        { id: "customTagRules", key: "CustomTagRules", type: "custom", label: "Custom tag rules" }
      ],
      render(ctx, body) {
        body.innerHTML = `<p class="je-ta-hint" id="customTagRulesHelp">${ctx.tx("Match existing tags or collections to labels and icons. Up to 20 rules; labels up to 24 characters. Collections require the server cache.")}</p>` + (A.CUSTOM_HTML ?? "");
        const create = A.createCustomTagRules;
        if (!create) {
          loadEditor = null;
          return;
        }
        const editor = create(body, (rules) => {
          ctx.set("CustomTagRules", rules);
          ctx.root.dispatchEvent(new CustomEvent("je-custom-labels"));
        }, () => ctx.isCurrent());
        let last = "";
        loadEditor = () => {
          const next = JSON.stringify(ctx.config.CustomTagRules || []);
          if (next === last) return;
          last = next;
          editor.load(ctx.config);
        };
        body.addEventListener("input", () => {
          last = JSON.stringify(ctx.config.CustomTagRules || []);
        });
        body.addEventListener("change", () => {
          last = JSON.stringify(ctx.config.CustomTagRules || []);
        });
        loadEditor();
      },
      load() {
        loadEditor?.();
      }
    });
  });
})();
})();
//# sourceMappingURL=custom.js.map
