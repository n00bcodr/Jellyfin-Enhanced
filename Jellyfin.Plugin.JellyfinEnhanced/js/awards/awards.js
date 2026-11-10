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

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export3 = /* @__PURE__ */ sharedExport(shared, "currentUserId");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "detailPageHook");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "detailsLease");
  var export32 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "removeFirst");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export2 = /* @__PURE__ */ sharedExport(shared3, "pathSegment");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export5 = /* @__PURE__ */ sharedExport(shared4, "field");
  var export72 = /* @__PURE__ */ sharedExport(shared4, "isRecord");
  var export8 = /* @__PURE__ */ sharedExport(shared4, "list");
  var export92 = /* @__PURE__ */ sharedExport(shared4, "num");
  var export11 = /* @__PURE__ */ sharedExport(shared4, "str");
  var export122 = /* @__PURE__ */ sharedExport(shared4, "stringList");

  // client/src/features/details-providers/provider-domain.ts
  async function resolveProviderTarget(item, allowPerson, seriesLookup) {
    const type = item?.Type;
    if (!item) return { target: null, unsupported: true };
    if (type === "Movie") return { target: wrap(item.ProviderIds.Tmdb, "movie"), unsupported: false };
    if (type === "Person" && allowPerson) return { target: wrap(item.ProviderIds.Tmdb, "person"), unsupported: false };
    if (type === "Series" || type === "Season" || type === "Episode") {
      let tmdbId;
      if (type === "Series") tmdbId = item.ProviderIds.Tmdb;
      else if (item.SeriesId) {
        try {
          tmdbId = (await seriesLookup(item.SeriesId))?.ProviderIds.Tmdb;
        } catch {
        }
      }
      return { target: wrap(tmdbId, "tv"), unsupported: false };
    }
    return { target: null, unsupported: true };
  }
  function wrap(tmdbId, mediaType) {
    return tmdbId ? { tmdbId, mediaType } : null;
  }
  function isUnconfirmed(value) {
    return export5(value, "Confirmed") === false;
  }
  function normalizeAwardsData(data) {
    if (!export72(data)) return null;
    return {
      found: !!data.Found,
      wins: export92(data.Wins) || 0,
      nominations: export92(data.Nominations) || 0,
      awards: export8(data.Awards).filter(export72).map((award) => ({
        name: export11(award.Name) ?? "",
        result: export11(award.Result) ?? "",
        year: export92(award.Year),
        recipients: export122(award.Recipients),
        works: export122(award.Works)
      }))
    };
  }
  function sortAwards(awards) {
    return [...awards].sort((a, b) => {
      const yearDiff = (b.year || 0) - (a.year || 0);
      if (yearDiff !== 0) return yearDiff;
      return (a.result === "Won" ? 0 : 1) - (b.result === "Won" ? 0 : 1);
    });
  }
  var AWARD_BODY_ICONS = [
    ["Academy Award", "oscar"],
    ["Golden Globe Award", "golden-globe"],
    ["BAFTA Award", "bafta"],
    ["Primetime Emmy Award", "emmy"],
    ["Daytime Emmy Award", "emmy"],
    ["Screen Actors Guild Award", "sag"],
    ["Critics' Choice", "critics-choice"],
    ["National Board of Review", "national-board-of-review"],
    ["Saturn Award", "saturn", true],
    ["Kids' Choice Award", "kids-choice"],
    ["Toronto Film Critics Association Award", "toronto-critics", true],
    ["Palme d'Or", "cannes"],
    ["Cannes Film Festival Award", "cannes"]
  ];
  function awardBodyIcon(awardName) {
    const match = AWARD_BODY_ICONS.find(([prefix]) => awardName.startsWith(prefix));
    return match ? { file: match[1], invert: !!match[2] } : null;
  }
  function sparklesSvg() {
    const star = (x, y, size, opacity, extraClass = "") => `<svg class="${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}" style="left:${x}%; top:${y}%; opacity:${opacity};">
                    <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"/>
                </svg>`;
    const safe = star(38, 18, 8, 0.4) + star(50, 68, 12, 0.3) + star(28, 65, 7, 0.35);
    const wide = star(70, 20, 10, 0.5, "je-spark-wide") + star(80, 60, 16, 0.35, "je-spark-wide") + star(90, 25, 22, 0.9, "je-spark-wide");
    return safe + wide;
  }

  // client/src/features/details-providers/awards.ts
  var JE = export1("Awards");
  JE.initializeAwardsScript = function initializeAwardsScript() {
    if (!JE.pluginConfig?.ShowAwards) {
      console.log("🪼 Jellyfin Enhanced: Awards feature disabled.");
      return;
    }
    const logPrefix = "🪼 Jellyfin Enhanced: Awards:";
    const escapeHtml = (value) => typeof JE.escapeHtml === "function" ? JE.escapeHtml(value) : String(value);
    function injectCss() {
      const styleId = "je-awards-styles";
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = AWARDS_CSS;
      document.head.appendChild(style);
    }
    function removeAwardsSection(page) {
      try {
        export9(page, ".je-awards-section");
      } catch (e) {
        console.warn(`${logPrefix} removeAwardsSection failed:`, e);
      }
    }
    async function fetchAwards(tmdbId, apiMediaType) {
      try {
        const cacheKey = `awards:/${apiMediaType}/${tmdbId}`;
        const data = await JE.core.api.plugin(`/awards/${apiMediaType}/${export2(tmdbId)}`, { cacheKey });
        if (isUnconfirmed(data)) JE.core.api.manager.clearCacheMatching(cacheKey);
        return normalizeAwardsData(data);
      } catch (e) {
        console.warn(`${logPrefix} Failed to fetch awards.`, e);
        return null;
      }
    }
    function buildAwardsList(awardsData) {
      const list = document.createElement("div");
      list.className = "je-awards-list";
      for (const award of sortAwards(awardsData.awards)) {
        const row = document.createElement("div");
        row.className = "je-awards-row";
        const won = award.result === "Won";
        const badgeClass = won ? "je-awards-badge-won" : "je-awards-badge-nominated";
        const badgeText = won ? JE.t("awards_won") : JE.t("awards_nominated");
        let detail = "";
        if (award.recipients.length) {
          detail = `<div class="je-awards-recipients">${escapeHtml(award.recipients.join(", "))}</div>`;
        } else if (award.works.length) {
          detail = `<div class="je-awards-recipients">${escapeHtml(JE.t("awards_for_work", { work: award.works.join(", ") }))}</div>`;
        }
        const bodyIcon = awardBodyIcon(award.name);
        row.innerHTML = `
                    <div class="je-awards-row-main">
                        <span class="je-awards-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
                        <div>
                            <div class="je-awards-row-name">${escapeHtml(award.name)}</div>
                            ${detail}
                        </div>
                    </div>
                    <div class="je-awards-row-side">
                        ${award.year ? `<span class="je-awards-row-year">${escapeHtml(String(award.year))}</span>` : ""}
                    </div>
                `;
        if (bodyIcon) {
          const icon = document.createElement("img");
          icon.className = `je-awards-body-icon${bodyIcon.invert ? " je-awards-body-icon-invert" : ""}`;
          icon.src = JE.cdn.url("award-logos", bodyIcon.file);
          icon.alt = "";
          icon.loading = "lazy";
          icon.onerror = () => icon.remove();
          row.querySelector(".je-awards-row-side")?.prepend(icon);
        }
        list.appendChild(row);
      }
      return list;
    }
    function buildAwardsSection(awardsData) {
      const section = document.createElement("details");
      section.className = "detailSection je-awards-section";
      const parts = [];
      if (awardsData.wins > 0) parts.push(JE.t("awards_wins_count", { count: awardsData.wins }));
      if (awardsData.nominations > 0) parts.push(JE.t("awards_nominations_count", { count: awardsData.nominations }));
      const summary = document.createElement("summary");
      summary.className = "je-awards-summary";
      summary.innerHTML = `
                <div class="je-awards-sparkles" aria-hidden="true">${sparklesSvg()}</div>
                <div class="je-awards-label">
                    <span class="je-msym-rounded je-awards-star" aria-hidden="true">auto_awesome</span>
                    <span class="je-awards-wordmark">${escapeHtml(JE.t("awards_label"))}</span>
                </div>
                <div class="je-awards-divider"></div>
                <div class="je-awards-stats">${parts.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>
                <i class="material-icons expand-icon" aria-hidden="true">expand_more</i>
            `;
      section.appendChild(summary);
      section.appendChild(buildAwardsList(awardsData));
      return section;
    }
    function insertBanner(contextPage, awardsData) {
      removeAwardsSection(contextPage);
      if (!awardsData || !awardsData.found || awardsData.wins === 0 && awardsData.nominations === 0) return;
      const banner = buildAwardsSection(awardsData);
      const afterAnchor = contextPage.querySelector(".tmdb-reviews-section") || contextPage.querySelector(".streaming-lookup-container") || contextPage.querySelector(".itemExternalLinks") || contextPage.querySelector(".tagline");
      if (afterAnchor?.parentNode) {
        afterAnchor.parentNode.insertBefore(banner, afterAnchor.nextSibling);
        return;
      }
      const beforeAnchor = contextPage.querySelector("#similarCollapsible");
      if (beforeAnchor?.parentNode) {
        beforeAnchor.parentNode.insertBefore(banner, beforeAnchor);
        return;
      }
      console.error(`${logPrefix} Could not find a suitable anchor to insert the awards banner. contextPage:`, contextPage);
    }
    async function processPage(visiblePage) {
      if (!JE.pluginConfig?.ShowAwards) {
        removeAwardsSection(visiblePage);
        return;
      }
      try {
        const itemId = export32();
        const userId = export3();
        if (!itemId || !userId) return;
        const lease = export12(JE.session, itemId, visiblePage);
        const item = await export7(JE.helpers, itemId, true, userId);
        const { target } = await resolveProviderTarget(item, true, (seriesId) => export7(JE.helpers, seriesId, true, userId));
        if (!lease.current()) return;
        if (!target) {
          if (lease.current()) removeAwardsSection(visiblePage);
          return;
        }
        const awardsData = await fetchAwards(target.tmdbId, target.mediaType);
        if (lease.current()) insertBanner(visiblePage, awardsData);
      } catch (error) {
        console.error(`${logPrefix} Error processing page:`, error);
      }
    }
    injectCss();
    const unregister = JE.helpers.onViewPage(
      export0(() => !!JE.pluginConfig?.ShowAwards, () => unregister?.(), (page) => {
        void processPage(page);
      }, true),
      { pages: null, fetchItem: false, immediate: true }
    );
  };
  var AWARDS_CSS = `
                .je-awards-label .je-msym-rounded {
                    font-family: 'JE Material Symbols Rounded';
                    font-weight: normal;
                    font-style: normal;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    font-feature-settings: 'liga';
                }
                .je-awards-section {
                    /* Some themes (e.g. ElegantFin) style .detailSection as a
                       grid, which blows this <details> out to a huge width —
                       force flex like reviews.js's .tmdb-reviews-section. */
                    display: flex !important;
                    flex-direction: column;
                    width: 100%;
                    min-width: 0;
                    row-gap: 0px !important;
                    position: relative;
                    overflow: hidden;
                    margin: 1em 0;
                    border-radius: 10px;
                    color: #fff;
                    background: linear-gradient(115deg, #0d2b3a 0%, #113a4d 45%, #0f4a63 100%);
                    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
                }
                .je-awards-summary {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 14px;
                    padding: 14px 20px;
                    cursor: pointer;
                    list-style: none;
                }
                .je-awards-summary::-webkit-details-marker {
                    display: none;
                }
                .je-awards-summary .je-awards-sparkles {
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    opacity: 0.55;
                }
                .je-awards-summary .je-awards-sparkles svg {
                    position: absolute;
                    fill: #fff;
                }
                @media (max-width: 480px) {
                    .je-awards-summary .je-awards-sparkles .je-spark-wide {
                        display: none;
                    }
                }
                .je-awards-label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    z-index: 1;
                    white-space: nowrap;
                    line-height: 1;
                }
                .je-awards-label .je-awards-star {
                    font-size: 20px;
                    color: #ffd76b;
                }
                .je-awards-wordmark {
                    font-family: Georgia, 'Times New Roman', serif;
                    letter-spacing: 0.12em;
                    font-size: 18px;
                    font-weight: 600;
                    text-transform: uppercase;
                    line-height: 1;
                }
                .je-awards-divider {
                    z-index: 1;
                    width: 1px;
                    align-self: stretch;
                    background: rgba(255,255,255,0.25);
                }
                .je-awards-stats {
                    z-index: 1;
                    font-size: 13px;
                    font-weight: 500;
                    color: rgba(255,255,255,0.92);
                    white-space: nowrap;
                    line-height: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .je-awards-summary .expand-icon {
                    z-index: 1;
                    margin-left: auto;
                    opacity: 0.75;
                    transition: transform 0.2s ease-in-out;
                }
                .je-awards-section[open] .je-awards-summary .expand-icon {
                    transform: rotate(180deg);
                }

                .je-awards-list {
                    padding: 4px 12px 14px;
                }
                .je-awards-row {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 12px;
                    padding: 10px 8px;
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .je-awards-row-main {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    min-width: 0;
                }
                .je-awards-row-side {
                    flex: none;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .je-awards-body-icon {
                    flex: none;
                    width: 25px;
                    height: 25px;
                    object-fit: contain;
                }
                .je-awards-body-icon-invert {
                    /* Flat black silhouette on transparent, e.g. Saturn Award —
                       force white so it reads against the dark banner instead
                       of nearly disappearing. */
                    filter: brightness(0) invert(1);
                }
                .je-awards-badge {
                    flex: none;
                    margin-top: 1px;
                    padding: 2px 8px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.03em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 88px;
                    text-align: center;
                }
                @media (max-width: 480px) {
                    .je-awards-badge {
                        min-width: 58px;
                        padding: 2px 6px;
                        font-size: 9px;
                    }
                }
                .je-awards-badge-won {
                    background: rgba(255,215,107,0.18);
                    color: #ffd76b;
                }
                .je-awards-badge-nominated {
                    background: rgba(255,255,255,0.1);
                    color: rgba(255,255,255,0.75);
                }
                .je-awards-row-name {
                    font-size: 13.5px;
                    font-weight: 500;
                    line-height: 1.35;
                    color: #fff;
                }
                .je-awards-recipients {
                    margin-top: 2px;
                    font-size: 12px;
                    color: rgba(255,255,255,0.6);
                    line-height: 1.35;
                }
                .je-awards-row-year {
                    flex: none;
                    font-size: 12px;
                    color: rgba(255,255,255,0.5);
                }
            `;
})();
})();
//# sourceMappingURL=awards.js.map
