(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-core.ts
  function seerrCoreHost() {
    const host = window;
    const JE2 = host.JellyfinEnhanced;
    if (!JE2) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE: JE2, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/src/features/seerr/core/request-manager-entry.ts
  var { JE } = seerrCoreHost();
  var manager = JE.core?.api?.manager;
  if (!manager) throw new Error("Seerr request manager loaded before the core API client");
  JE.requestManager = manager;
})();
})();
//# sourceMappingURL=request-manager.js.map
