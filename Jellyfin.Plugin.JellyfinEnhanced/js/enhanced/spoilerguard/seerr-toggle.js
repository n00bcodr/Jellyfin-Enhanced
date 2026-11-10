(() => {
"use strict";
(() => {
  // client/src/features/spoiler-guard/wire.ts
  function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Spoiler Guard object");
    return Object.fromEntries(Object.entries(value));
  }
  function decodeSeerr(value) {
    const input = record(value);
    const id = input.id;
    if (typeof id !== "number" && typeof id !== "string") throw new Error("Invalid Seerr ID");
    const media = input.mediaInfo == null ? {} : record(input.mediaInfo);
    const items = input.jeSpoilerGuardItems ?? [];
    if (!Array.isArray(items)) throw new Error("Invalid guarded item list");
    const guarded = [];
    for (const item of items) {
      if (typeof item !== "string") throw new Error("Invalid guarded item");
      guarded.push(item);
    }
    for (const key of ["jeSpoilerGuard", "jeSpoilerGuardInherited"]) {
      if (input[key] !== void 0 && typeof input[key] !== "boolean") throw new Error("Invalid guard verdict");
    }
    if (media.jellyfinMediaId != null && typeof media.jellyfinMediaId !== "string") throw new Error("Invalid Jellyfin ID");
    return {
      id,
      title: typeof input.title === "string" ? input.title : "",
      name: typeof input.name === "string" ? input.name : "",
      mediaInfo: { jellyfinMediaId: typeof media.jellyfinMediaId === "string" ? media.jellyfinMediaId : null },
      jeSpoilerGuard: input.jeSpoilerGuard === true,
      jeSpoilerGuardInherited: input.jeSpoilerGuardInherited === true,
      jeSpoilerGuardItems: guarded
    };
  }

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

  // client/src/features/spoiler-guard/seerr-toggle.ts
  var { JE, internal, ctx } = export02();
  var owner = export0(JE, "seerr-toggle", true);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  internal.buildSeerrToggle = function(raw, mediaType) {
    const data = decodeSeerr(raw);
    const token = owner.lease();
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return null;
    if (mediaType !== "tv" && mediaType !== "movie") return null;
    const tmdbId = data?.id;
    if (!tmdbId) return null;
    const jellyfinMediaId = data?.mediaInfo?.jellyfinMediaId || null;
    const displayName = data?.title || data?.name || "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "je-spoiler-pending-btn";
    button.dataset.jeTmdbId = String(tmdbId);
    button.dataset.jeMediaType = mediaType;
    const icon = document.createElement("span");
    icon.className = "material-icons";
    const label = document.createElement("span");
    button.appendChild(icon);
    button.appendChild(label);
    const inherited = data?.jeSpoilerGuardInherited === true;
    function isEnabled() {
      return data?.jeSpoilerGuard === true || internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId);
    }
    function refresh() {
      if (!token.current()) {
        button.disabled = true;
        return;
      }
      const enabled = isEnabled();
      const onLabel = internal.isTmdbPending(mediaType, tmdbId) ? "spoiler_blur_pending_button_on" : "spoiler_blur_button_on";
      const text = JE.t(enabled ? onLabel : "spoiler_blur_pending_button_off");
      button.classList.toggle("je-spoiler-pending-on", enabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      const hint = JE.t("spoiler_blur_inherited_hint");
      button.title = inherited && hint !== "spoiler_blur_inherited_hint" ? hint : text;
      button.disabled = inherited || internal.isStateLoaded() && !internal.isLoadOk();
      icon.textContent = enabled ? "blur_on" : "blur_off";
      label.textContent = text;
    }
    refresh();
    internal.whenLoaded().then(refresh).catch(function() {
    });
    owner.listen(button, "click", function(event) {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      let wasEnabled = isEnabled();
      const modal = button.closest(".je-more-info-modal");
      const epoch = JE.session ? JE.session.getEpoch() : 0;
      const sameUser = () => token.current() && (!JE.session || JE.session.isCurrent(epoch));
      const sameView = () => sameUser() && button.isConnected && modal?.isConnected === true && button.closest(".je-more-info-modal") === modal && !("_isClosing" in modal && modal._isClosing === true);
      void (async function() {
        let changed = false;
        try {
          await internal.whenLoaded();
          if (!sameView() || !internal.isLoadOk()) return;
          wasEnabled = isEnabled();
          if (wasEnabled) {
            if (!sameView() || !await internal.confirmDisableSpoiler() || !sameView()) return;
            const result = await internal.disableForTmdb(mediaType, tmdbId);
            if (!sameView()) return;
            const items = data?.jeSpoilerGuardItems || [];
            const outcomes = await Promise.allSettled(items.map((id) => sameView() ? mediaType === "tv" ? internal.disableForSeries(id) : internal.disableForMovie(id) : Promise.resolve()));
            if (!sameView()) return;
            const removed = result?.removed !== false || outcomes.some((outcome) => outcome.status === "fulfilled");
            const failed = !removed || outcomes.some((outcome) => outcome.status === "rejected");
            JE.toast?.(JE.t(failed ? "spoiler_blur_pending_error_toast" : "spoiler_blur_pending_disabled_toast"));
            if (!removed) return;
          } else {
            const result = await internal.enableForTmdb(mediaType, tmdbId, displayName);
            if (!sameView()) return;
            JE.toast?.(JE.t(result?.promoted === "pending" ? "spoiler_blur_pending_enabled_toast" : "spoiler_blur_enabled_toast"));
          }
          changed = true;
        } catch (e) {
          if (!sameView()) return;
          console.warn(`${logPrefix} Seerr toggle failed:`, e);
          JE.toast?.(JE.t("spoiler_blur_pending_error_toast"));
        } finally {
          if (sameView()) refresh();
          button.disabled = inherited || !sameView() || !internal.isLoadOk();
        }
        if (changed && sameView()) {
          try {
            await ctx.peer("jellyseerrMoreInfo")?.open?.(tmdbId, mediaType);
          } catch (error) {
            if (sameView()) console.warn(`${logPrefix} Seerr refresh failed:`, error);
          }
        }
      })();
    });
    return button;
  };
  internal.appendSeerrToggle = function(mount, raw, mediaType) {
    if (!mount) return;
    try {
      const button = internal.buildSeerrToggle(raw, mediaType);
      if (button) mount.appendChild(button);
    } catch (e) {
      console.warn(`${logPrefix} Seerr toggle render failed:`, e);
    }
  };
})();
})();
//# sourceMappingURL=seerr-toggle.js.map
