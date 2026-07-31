// @ts-check
// /js/jellyseerr/request-manager.js
//
// The retry/dedup/concurrency/cache machinery moved to js/core/api-client.js
// so every module (not just Seerr) can use it. This file keeps the frozen
// JE.requestManager surface as an alias; the navigation-abort wiring that
// used to live here is owned by core/api-client.js (via JE.core.navigation,
// which also covers the pushState transitions the old raw hashchange/popstate
// listeners missed).
(function(JE) {
    'use strict';

    JE.requestManager = JE.core.api.manager;

})(window.JellyfinEnhanced);
