(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "spoilerHost");

  // client/src/features/spoiler-guard/spoiler-guard.css
  var spoiler_guard_default = "\n            .je-spoiler-blur-btn.je-spoiler-blur-on .detailButton-icon {\n                color: #d6c8ff;\n            }\n            .je-more-info-modal .je-more-info-secondary-actions {\n                display: flex;\n                flex-wrap: wrap;\n                gap: 0.5rem;\n                margin-top: 0.75rem;\n            }\n            .je-more-info-modal .je-more-info-secondary-actions:empty {\n                display: none;\n            }\n            .je-spoiler-pending-btn {\n                display: inline-flex;\n                align-items: center;\n                gap: 0.4em;\n                padding: 0.45em 0.9em;\n                font-size: 0.85em;\n                font-weight: 500;\n                line-height: 1.2;\n                background: rgba(255, 255, 255, 0.06);\n                color: rgba(255, 255, 255, 0.85);\n                border: 1px solid rgba(255, 255, 255, 0.14);\n                border-radius: 999px;\n                cursor: pointer;\n                transition: background 0.2s, border-color 0.2s, color 0.2s;\n            }\n            .je-spoiler-pending-btn:hover:not(:disabled) {\n                background: rgba(255, 255, 255, 0.1);\n                border-color: rgba(255, 255, 255, 0.25);\n                color: #fff;\n            }\n            .je-spoiler-pending-btn:disabled {\n                opacity: 0.55;\n                cursor: progress;\n            }\n            .je-spoiler-pending-btn.je-spoiler-pending-on {\n                background: rgba(90, 63, 184, 0.22);\n                color: #d6c8ff;\n                border-color: rgba(90, 63, 184, 0.55);\n            }\n            .je-spoiler-pending-btn.je-spoiler-pending-on:hover:not(:disabled) {\n                background: rgba(90, 63, 184, 0.32);\n                border-color: rgba(90, 63, 184, 0.75);\n                color: #fff;\n            }\n            .je-spoiler-pending-btn .material-icons { font-size: 1.1em; }\n        ";

  // client/src/features/spoiler-guard/styles.ts
  var { JE, internal } = export0();
  internal.injectStyles = function() {
    JE.core.ui.injectCss("je-spoiler-guard-styles", spoiler_guard_default);
  };
})();
})();
//# sourceMappingURL=styles.js.map
