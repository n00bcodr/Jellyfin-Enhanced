(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared3 = core.core?.featureContext;
    if (typeof shared3 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared3(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");
  var export23 = /* @__PURE__ */ sharedExport(shared, "isUserQuota");

  // client/generated-shared/stub/client/src/features/seerr/core/display.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/display");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "formatNextReset");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "formatQuotaLine");

  // client/src/features/seerr/core/runtime.ts
  var LOG_UI = "🪼 Jellyfin Enhanced: Seerr UI:";
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  function escapeWith(JE) {
    return (value) => {
      const escape = JE.escapeHtml;
      if (typeof escape === "function") return escape(value);
      return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
    };
  }
  function translated(JE, key, fallback, params) {
    const text2 = params ? JE.t(key, params) : JE.t(key);
    return text2 && text2 !== key ? text2 : fallback;
  }
  function text(read) {
    try {
      const value = read();
      return export22(value) && value ? value : null;
    } catch {
      return null;
    }
  }
  function captureOrigin(host) {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
      const client = host.apiClient();
      const id = client?.serverId;
      return typeof id === "function" ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl("/"));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
      epoch,
      current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
  }
  function thrownProperty(error, key) {
    if (typeof error !== "object" || error === null) return void 0;
    const value = Reflect.get(error, key);
    return value;
  }
  function errorStatus(error) {
    const status = thrownProperty(error, "status");
    return export18(status) ? status : null;
  }
  function errorBody(error) {
    const body = thrownProperty(error, "responseJSON");
    if (!export19(body)) return { message: null, code: null, requestOutcome: null };
    return {
      message: export22(body.message) && body.message ? body.message : null,
      code: export22(body.code) && body.code ? body.code : null,
      requestOutcome: body.requestOutcome === "unknown" || body.requestOutcome === "rejected" || body.requestOutcome === "not_sent" ? body.requestOutcome : null
    };
  }
  var RequestNotSentError = class extends Error {
    constructor(reason, detail) {
      super(detail);
      this.reason = reason;
      this.name = "SeerrRequestNotSent";
    }
  };
  function classifyFailure(error, quotaEnabled) {
    if (error instanceof RequestNotSentError || error instanceof Error && error.name === "SeerrRequestNotSent") return "not-sent";
    const status = errorStatus(error);
    const { message, requestOutcome } = errorBody(error);
    if (requestOutcome === "unknown") return "uncertain";
    if (requestOutcome === "not_sent") return "not-sent";
    if (status === null || status >= 500 && requestOutcome !== "rejected") return "uncertain";
    if (status === 403 && quotaEnabled && /quota\s+exceeded/i.test(message || "")) return "quota";
    if (status === 404) return "user-not-found";
    if (status === 403) return "permission";
    return "rejected";
  }
  function uncertainMessage(JE) {
    return translated(JE, "jellyseerr_request_outcome_unknown", "Request status unknown. Check Seerr before requesting again.");
  }

  // client/src/features/seerr/core/ui/quota.ts
  function installQuota(host) {
    const { JE, document: document2 } = host;
    if (!firstInstall(JE, "ui-quota")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    const t = JE.t;
    const quotaEnabled = () => JE.pluginConfig?.JellyseerrShowQuotaInfo !== false;
    function isQuotaError(error) {
      return quotaEnabled() && classifyFailure(error, true) === "quota";
    }
    const nextReset = (resetAt) => export3(resetAt, Date.now(), t);
    const quotaLine = (quota, type) => export4(quota, type, Date.now(), t);
    function buildQuotaChip(value, mediaType) {
      if (!export23(value)) return null;
      const side = mediaType === "tv" ? value.tv : value.movie;
      const line = quotaLine(side, mediaType === "tv" ? "tv" : "movie");
      if (!line.text || line.unlimited) return null;
      const chip = document2.createElement("div");
      chip.className = "jellyseerr-quota-chip";
      const remaining = Number(side?.remaining);
      if (line.restricted) chip.classList.add("jellyseerr-quota-chip-restricted");
      else if (remaining > 0 && remaining <= 2) chip.classList.add("jellyseerr-quota-chip-warning");
      chip.textContent = line.text;
      const sub = (text2) => {
        const element = document2.createElement("div");
        element.className = "jellyseerr-quota-chip-sub";
        element.textContent = text2;
        chip.appendChild(element);
      };
      if (line.restricted) sub(t("jellyseerr_quota_restricted_hint"));
      if (line.resetText) sub(line.resetText);
      return chip;
    }
    async function showQuotaErrorDialog(error, mediaType) {
      const origin = captureOrigin(host);
      const quota = await JE.jellyseerrAPI?.fetchUserQuota?.({ skipCache: true }) ?? null;
      if (!origin.current()) return;
      const upstreamMessage = errorBody(error).message || "";
      const lines = [];
      if (upstreamMessage) lines.push(upstreamMessage);
      if (quota) {
        const movie = quotaLine(quota.movie, "movie");
        const tv = quotaLine(quota.tv, "tv");
        const [lead, other] = mediaType === "tv" ? [tv, movie] : [movie, tv];
        if (lead.text) lines.push(lead.text);
        if (lead.resetText) lines.push(lead.resetText);
        if (other.text) lines.push(other.text);
      }
      lines.push(t("jellyseerr_quota_dialog_hint"));
      const title = t("jellyseerr_quota_dialog_title");
      const message = lines.map((line) => escapeHtml(line)).join("<br><br>");
      const dashboard = host.window.Dashboard;
      if (typeof dashboard?.alert === "function") {
        try {
          dashboard.alert({ title, message });
          return;
        } catch (dialogError) {
          console.warn(`${LOG_UI} Dashboard.alert threw, falling back to toast:`, dialogError);
        }
      }
      if (!origin.current()) return;
      JE.toast?.(escapeHtml(`${title}: ${lines.join(" — ")}`), 8e3);
    }
    async function handleRequestError(error, mediaType, requestBtn, resetLabel) {
      const origin = captureOrigin(host);
      const kind = classifyFailure(error, quotaEnabled());
      if (isQuotaError(error)) {
        await showQuotaErrorDialog(error, mediaType);
      } else if (kind === "uncertain") {
        JE.toast?.(escapeHtml(uncertainMessage(JE)), 6e3);
      } else {
        const upstream = errorBody(error).message;
        JE.toast?.(upstream ? escapeHtml(upstream) : t("jellyseerr_modal_toast_request_fail"), 4e3);
      }
      if (!origin.current()) return;
      if (requestBtn) {
        requestBtn.disabled = false;
        requestBtn.textContent = resetLabel;
      }
    }
    ui.isQuotaError = isQuotaError;
    ui.showQuotaErrorDialog = showQuotaErrorDialog;
    ui.buildQuotaChip = buildQuotaChip;
    internals.isQuotaError = isQuotaError;
    internals.formatNextReset = nextReset;
    internals.formatQuotaLine = quotaLine;
    internals.buildQuotaChip = buildQuotaChip;
    internals.showQuotaErrorDialog = showQuotaErrorDialog;
    internals.handleRequestError = handleRequestError;
  }

  // client/src/features/seerr/core/ui/quota-entry.ts
  installQuota(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-quota.js.map
