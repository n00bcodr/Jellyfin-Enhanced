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

  // client/generated-shared/stub/client/src/features/spoiler-guard/ownership.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/ownership");
  var export0 = /* @__PURE__ */ sharedExport(shared, "own");

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "spoilerHost");

  // client/src/features/spoiler-guard/dialog.ts
  var { JE, internal, host } = export02();
  var owner = export0(JE, "dialog", true);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  function showConfirmDialog() {
    const token = owner.lease();
    const title = JE.t("spoiler_disable_confirm_title");
    const body = JE.t("spoiler_disable_confirm_body");
    const snoozeLabel = JE.t("spoiler_disable_confirm_snooze");
    const marker = `je-sb-snooze-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const escape = typeof JE.escapeHtml === "function" ? JE.escapeHtml : (value) => String(value);
    const html = `<div>${escape(body)}</div><label class="${marker}" style="display:flex;align-items:center;gap:.5em;margin-top:1em;cursor:pointer;"><input type="checkbox"><span>${escape(snoozeLabel)}</span></label>`;
    return new Promise(function(resolve) {
      if (!host.Dashboard || typeof host.Dashboard.confirm !== "function") {
        console.warn(`${logPrefix} Dashboard.confirm unavailable; using native confirm without snooze`);
        resolve(token.current() && window.confirm(`${title}

${body}`));
        return;
      }
      if (!token.current()) {
        resolve(false);
        return;
      }
      const cancel = () => {
        cleanup();
        resolve(false);
      };
      token.signal.addEventListener("abort", cancel, { once: true });
      let snoozeChecked = false;
      function captureChange(event) {
        try {
          const target = event.target;
          if (target instanceof HTMLInputElement && target.type === "checkbox" && target.closest(`.${marker}`)) {
            snoozeChecked = !!target.checked;
          }
        } catch (_) {
        }
      }
      function cleanup() {
        document.removeEventListener("change", captureChange, true);
        token.signal.removeEventListener("abort", cancel);
      }
      document.addEventListener("change", captureChange, true);
      try {
        host.Dashboard.confirm(html, title, function(ok) {
          try {
            const checkbox = document.querySelector(`.${marker} input[type="checkbox"]`);
            if (checkbox) snoozeChecked = !!checkbox.checked;
          } catch (_) {
          }
          cleanup();
          const confirmed = !!ok && token.current();
          if (confirmed && snoozeChecked) internal.setDisableSnooze();
          resolve(confirmed);
        });
      } catch (e) {
        cleanup();
        console.warn(`${logPrefix} Dashboard.confirm failed; using native confirm:`, e);
        resolve(token.current() && window.confirm(`${title}

${body}`));
      }
    });
  }
  internal.confirmDisableSpoiler = function() {
    const token = owner.lease();
    return internal.whenLoaded().then(function() {
      if (!token.current() || !internal.isLoadOk()) return false;
      if (internal.getUserPrefs().SkipDisableConfirm) return true;
      if (internal.isDisableSnoozed()) return true;
      return showConfirmDialog();
    });
  };
})();
})();
//# sourceMappingURL=dialog.js.map
