(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/media.ts
  function parseMediaType(value) {
    return value === "movie" || value === "tv" ? value : null;
  }

  // client/src/features/seerr/details/hss-discovery-entry.ts
  var JE = bridge();
  var logPrefix = `${SEERR_LOG} HSS Discovery Handler:`;
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".discover-requestbutton")) return;
    const card = event.target.closest(".discover-card");
    if (!card) return;
    const tmdbId = card.dataset.tmdbId;
    const mediaType = parseMediaType(card.dataset.mediaType);
    const open = JE.jellyseerrMoreInfo?.open;
    if (!tmdbId || !/^\d+$/.test(tmdbId) || !mediaType || !open) return;
    console.log(`${logPrefix} Opening more-info modal for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    event.preventDefault();
    event.stopPropagation();
    void open.call(JE.jellyseerrMoreInfo, tmdbId, mediaType);
  }, true);
})();
})();
//# sourceMappingURL=hss-discovery-handler.js.map
