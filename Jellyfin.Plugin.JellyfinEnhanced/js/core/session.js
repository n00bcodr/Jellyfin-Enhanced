(() => {
"use strict";
(() => {
  // client/src/core/session.ts
  function createSession(deps) {
    let identity = { userId: null, serverId: null };
    let epoch = 0;
    let adopted = false;
    let controller = deps.createAbortController();
    let authenticationDepth = 0;
    let authenticationSerial = 0;
    const handlers = /* @__PURE__ */ new Map();
    function transition(next, reason) {
      if (identity.userId === next.userId && identity.serverId === next.serverId) return;
      const silent = !adopted && identity.userId === null && next.userId !== null;
      if (silent) adopted = true;
      const change = Object.freeze({ ...next, previousUserId: identity.userId, epoch: ++epoch, reason });
      identity = { userId: next.userId, serverId: next.serverId };
      const previousController = controller;
      controller = deps.createAbortController();
      previousController.abort();
      if (silent || epoch !== change.epoch) return;
      for (const [name, entry] of [...handlers]) {
        if (epoch !== change.epoch) break;
        if (handlers.get(name) !== entry) continue;
        try {
          entry.callback(change);
        } catch (error) {
          deps.report(`reset handler "${name}" failed`, error);
        }
      }
      if (epoch === change.epoch) {
        try {
          deps.announce(change);
        } catch (error) {
          deps.report("je:user-changed dispatch failed", error);
        }
      }
    }
    function checkNow(reason) {
      if (authenticationDepth === 0) transition(deps.readIdentity(), reason);
    }
    const session = {
      getUserId: () => identity.userId,
      getServerId: () => identity.serverId,
      getEpoch: () => epoch,
      isCurrent: (captured) => captured === epoch,
      userScopedKey: (base) => `${base}:${identity.userId || deps.readIdentity().userId || "anonymous"}`,
      onUserChange(name, callback) {
        const entry = { callback };
        handlers.set(name, entry);
        return () => {
          if (handlers.get(name) === entry) handlers.delete(name);
        };
      },
      checkNow,
      createLease() {
        const capturedEpoch = epoch;
        let signal = controller.signal;
        if (authenticationDepth > 0) {
          const pending = deps.createAbortController();
          pending.abort();
          signal = pending.signal;
        }
        const isCurrent = () => !signal.aborted && capturedEpoch === epoch;
        return Object.freeze({
          ...identity,
          epoch: capturedEpoch,
          signal,
          isCurrent,
          throwIfStale() {
            if (!isCurrent()) {
              const error = new Error("Session lease is no longer current");
              error.name = "AbortError";
              throw error;
            }
          }
        });
      }
    };
    return {
      session,
      /** Synchronous Jellyfin 12 setter transaction; a nested setter supersedes its parent. */
      authenticate(next, install) {
        const serial = ++authenticationSerial;
        authenticationDepth++;
        try {
          transition(next, "authentication");
          if (serial !== authenticationSerial) return void 0;
          return install();
        } finally {
          authenticationDepth--;
          checkNow("authentication");
        }
      }
    };
  }

  // client/src/host/core-host.ts
  function coreHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must be initialized before core modules");
    return host;
  }
  function identityId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function readIdentity(client) {
    try {
      const userId = identityId(client?.getCurrentUserId?.());
      let serverId = null;
      try {
        serverId = identityId(typeof client?.serverId === "function" ? client.serverId() : client?.serverId) || identityId(client?._serverInfo?.Id);
      } catch {
      }
      return { userId, serverId };
    } catch {
      return { userId: null, serverId: null };
    }
  }

  // client/src/host/session-host.ts
  function installSession() {
    const host = coreHost();
    const je = host.JellyfinEnhanced;
    if (je.session) return;
    const runtime = createSession({
      readIdentity: () => readIdentity(host.ApiClient),
      createAbortController: () => new AbortController(),
      announce: (change) => document.dispatchEvent(new CustomEvent("je:user-changed", { detail: change })),
      report: (context, error) => console.error(`🪼 Jellyfin Enhanced: Session: ${context}:`, error)
    });
    const wrappers = /* @__PURE__ */ new WeakSet();
    function installAuthHook() {
      try {
        const client = host.ApiClient;
        const original = client?.setAuthenticationInfo;
        if (!client || typeof original !== "function" || wrappers.has(original)) return;
        const wrapped = function(token, userId, ...rest) {
          if (this !== host.ApiClient) return original.call(this, token, userId, ...rest);
          const next = { userId: identityId(userId), serverId: readIdentity(this).serverId };
          return runtime.authenticate(next, () => {
            if (this !== host.ApiClient) return void 0;
            return original.call(this, token, userId, ...rest);
          });
        };
        const descriptor = Object.getOwnPropertyDescriptor(client, "setAuthenticationInfo");
        if (descriptor && !descriptor.configurable) client.setAuthenticationInfo = wrapped;
        else Object.defineProperty(client, "setAuthenticationInfo", { value: wrapped, writable: true, configurable: true });
        wrappers.add(wrapped);
      } catch (error) {
        console.warn("🪼 Jellyfin Enhanced: Session: could not hook setAuthenticationInfo:", error);
      }
    }
    je.session = runtime.session;
    runtime.session.checkNow("startup");
    installAuthHook();
    je.core?.navigation?.onNavigate(() => {
      installAuthHook();
      runtime.session.checkNow("navigate");
    });
    window.setInterval(() => {
      installAuthHook();
      runtime.session.checkNow("reconcile");
    }, 5e3);
  }

  // client/src/core/session-entry.ts
  installSession();
})();
})();
//# sourceMappingURL=session.js.map
