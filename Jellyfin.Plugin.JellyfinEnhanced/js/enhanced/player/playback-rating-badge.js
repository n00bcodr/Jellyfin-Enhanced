(() => {
"use strict";
(() => {
  // client/src/features/player/advisories.ts
  var ADVISORY_PATTERNS = [
    /gore|gory|torture|mutilat|dismember|decapitat|cannibal|massacre|genocide|war crime|brutal|serial killer|mass murder|mass shooting|school shooting|snuff|sadis/i,
    /\brape\b|\braped\b|sexual (assault|abuse|violence)|molest|incest|child abuse|domestic (violence|abuse)|human trafficking|sex trafficking|pedophil|paedophil/i,
    /violen|murder|killing|kill(er|ings)|assault|stabbing|shootout|gunfight|shooting|beating|blood|bloody|execution|hostage|kidnap|abduct|terroris|bombing|hitman|assassin|revenge|vigilante|hand.to.hand|martial arts|fistfight|bar fight|brawl|\bfight/i,
    /\bsex\b|sex scene|sexual (content|situation|reference|theme)|nudity|\bnude\b|erotic|softcore|orgy|prostitut|brothel|striptease|stripper|pornograph|lingerie|seduction|adultery|infidelity|innuendo/i,
    /\bdrug|cocaine|heroin|methamphetamine|\bmeth\b|cannabis|marijuana|opioid|overdose|addict|alcohol|drunk|drinking|smoking|tobacco|cigarette|gambl|cartel|dealer/i,
    /(strong|coarse|bad|explicit|foul|crude) language|profan|swear|vulgar|obscen|f.word|slur|expletive|crude humou?r|toilet humou?r|rude humou?r/i,
    /horror|slasher|disturbing|frightening|terrifying|terror|body horror|psychological horror|gruesome|macabre|nightmare|jump scare|possession|exorcis|demon|satan|occult|haunted|creepy|ghost|zombie|undead|monster|vampire/i,
    /suicide|self.?harm|eating disorder|mental (illness|health)|depression|trauma|ptsd|abuse|neglect|racis|sexis|homophob|transphob|antisemit|nazi|holocaust|slavery|discriminat|hate crime|bigot|segregation/i,
    /peril|threat|scary|scare|spooky|intense|tension|suspense|chase|danger|survival|disaster|natural disaster|shipwreck|plane crash|car crash|explosion/i,
    /infiltrat|rogue agent|double agent|secret agent|undercover|espionage|\bspy\b|spies|conspiracy|sabotage|hijack|manhunt|cover.?up|betray|blackmail|assassination plot|coup|whistleblower/i,
    /\bdeath|dying|grief|bereave|funeral|terminal illness|cancer|illness|disease|injur|disabilit|hospital|orphan|bullying|loss of/i,
    /(mild|cartoon|fantasy|slapstick|comic|action) violence|slapstick|weapon|\bgun|sword|knife|war\b|military|soldier|battle|flashing|strobe|photosensitiv/i,
    /crime|gangster|mafia|mob boss|organized crime|heist|robbery|burglar|corrupt|prison|fraud|smuggl|underworld/i
  ];
  function pickAdvisories(tags) {
    const ranked = [];
    for (const tag of tags) {
      const rank = ADVISORY_PATTERNS.findIndex((re) => re.test(tag));
      if (rank !== -1) ranked.push({ tag, rank });
    }
    ranked.sort((x, y) => x.rank - y.rank);
    const names = ranked.map((r) => r.tag);
    return names.filter((n) => !names.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase()))).map((n) => n.replace(/(^|\s)(\S)/g, (_, sp, ch) => sp + ch.toUpperCase()));
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

  // client/generated-shared/stub/client/src/features/player/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/player/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "playerHost");

  // client/generated-shared/stub/client/src/features/player/wire.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/player/wire");
  var export1 = /* @__PURE__ */ sharedExport(shared2, "decodeItems");

  // client/generated-shared/stub/client/src/features/player/lifetime.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/player/lifetime");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "createPlayerLifetime");

  // client/src/features/player/playback-rating-badge.ts
  var { JE, ApiClient, ctx } = export0();
  var lifetime = export02(JE, "playback-rating-badge");
  var logPrefix = "🪼 Jellyfin Enhanced: Playback Rating Badge:";
  var BADGE_ID = "je-playback-rating-badge";
  var STYLE_ID = "je-playback-rating-badge-style";
  var SHOW_MS = 5e3;
  var FADE_MS = 400;
  var MAX_LINE_ITEMS = 3;
  var nowPlaying = ctx.own.nowPlaying;
  var infoCache = /* @__PURE__ */ new Map();
  var seriesCache = /* @__PURE__ */ new Map();
  var lastShownId = null;
  var lastSeenId = null;
  var resolving = false;
  var announcement = 0;
  var hideTimer = void 0;
  var removeTimer = void 0;
  var initialized = false;
  JE.session?.onUserChange("playback-rating-badge", () => {
    infoCache.clear();
    seriesCache.clear();
    lastShownId = null;
    lastSeenId = null;
    removeBadge();
  });
  function isEnabled() {
    return JE.pluginConfig?.ShowPlaybackRatingBadge === true;
  }
  function getOsdItemId() {
    const id = document.querySelector(".videoOsdBottom .btnUserRating[data-id]")?.dataset?.id;
    return id ? id.replace(/-/g, "").toLowerCase() : null;
  }
  async function fetchItems(userId, ids) {
    const result = await ApiClient.ajax({
      type: "GET",
      url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: ids.join(","), Fields: "OfficialRating,Genres,Tags" }),
      dataType: "json"
    });
    return export1(result);
  }
  async function fetchInfo(userId, itemId) {
    const lease = lifetime.lease();
    if (infoCache.has(itemId)) return infoCache.get(itemId);
    let info = null;
    try {
      const item = (await fetchItems(userId, [itemId]))[0];
      if (item) {
        let rating = item.OfficialRating || "";
        let genres = item.Genres || [];
        let tags = item.Tags || [];
        if (item.SeriesId) {
          if (!seriesCache.has(item.SeriesId)) {
            const series2 = (await fetchItems(userId, [item.SeriesId]))[0] || null;
            if (!lease.current()) return null;
            seriesCache.set(item.SeriesId, series2);
          }
          const series = seriesCache.get(item.SeriesId);
          if (series) {
            rating = rating || series.OfficialRating || "";
            if (!genres.length) genres = series.Genres || [];
            tags = [.../* @__PURE__ */ new Set([...tags, ...series.Tags || []])];
          }
        }
        const advisories = pickAdvisories(tags);
        info = {
          rating,
          genres: genres.slice(0, MAX_LINE_ITEMS),
          advisories: advisories.slice(0, MAX_LINE_ITEMS)
        };
      }
    } catch (e) {
      console.warn(`${logPrefix} Failed to fetch item ${itemId}`, e);
      return null;
    }
    if (!lease.current()) return null;
    infoCache.set(itemId, info);
    return info;
  }
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed; top: 12%; left: 0; z-index: 10001; pointer-events: none;
        display: flex; flex-direction: column; gap: 6px;
        padding: 12px 24px 12px 18px; max-width: min(80vw, 520px);
        background: rgba(16, 16, 16, 0.72); backdrop-filter: blur(10px);
        border-left: 4px solid var(--theme-primary-color, var(--primary-accent-color, #00a4dc));
        border-radius: 0 8px 8px 0; color: #fff;
        opacity: 0; transform: translateX(-24px);
        transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease;
      }
      #${BADGE_ID}.je-visible { opacity: 1; transform: none; }
      #${BADGE_ID} .je-age-rating {
        align-self: flex-start; padding: 2px 10px; border: 2px solid currentColor; border-radius: 5px;
        font-size: 1.7em; font-weight: 700; line-height: 1.2; letter-spacing: 0.02em;
      }
      #${BADGE_ID} .je-age-why { font-size: 1.1em; font-weight: 600; }
      #${BADGE_ID} .je-age-genres { font-size: 1em; font-weight: 500; opacity: 0.85; }
    `;
    document.head.appendChild(style);
  }
  function removeBadge() {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    hideTimer = removeTimer = void 0;
    document.getElementById(BADGE_ID)?.remove();
  }
  function showBadge(info) {
    removeBadge();
    ensureStyles();
    const badge = document.createElement("div");
    badge.id = BADGE_ID;
    const rating = document.createElement("div");
    rating.className = "je-age-rating mediaInfoOfficialRating";
    rating.setAttribute("rating", info.rating);
    rating.textContent = info.rating;
    badge.appendChild(rating);
    const lines = [["je-age-why", info.advisories], ["je-age-genres", info.genres]];
    lines.forEach(([className, items]) => {
      if (!items.length) return;
      const line = document.createElement("div");
      line.className = className;
      line.textContent = items.join(" • ");
      badge.appendChild(line);
    });
    document.body.appendChild(badge);
    requestAnimationFrame(() => requestAnimationFrame(() => badge.classList.add("je-visible")));
    hideTimer = setTimeout(() => {
      badge.classList.remove("je-visible");
      removeTimer = setTimeout(() => badge.remove(), FADE_MS);
    }, SHOW_MS);
  }
  var sleep = (ms, signal) => lifetime.sleep(ms, signal);
  async function resolveItemId(video) {
    const lease = lifetime.lease(video);
    const fromSrc = nowPlaying.itemIdFromSource(video);
    if (fromSrc) return fromSrc;
    const fromHash = nowPlaying.itemIdFromRoute();
    if (fromHash) return fromHash;
    for (let i = 0; i < 12; i++) {
      const id = await nowPlaying.itemIdFromSession() || getOsdItemId();
      if (!lease.current()) return null;
      if (id && id !== lastSeenId) return id;
      await sleep(500, lease.signal);
      if (!lease.current()) return null;
      if (video.ended || !JE.isVideoPage?.()) return null;
    }
    return await nowPlaying.itemIdFromSession() || getOsdItemId();
  }
  async function waitForVideoPage(video) {
    const session = JE.session?.createLease?.();
    const source = video.currentSrc || video.src;
    for (let i = 0; i < 20; i++) {
      if (session && !session.isCurrent()) return false;
      if (!video.isConnected || (video.currentSrc || video.src) !== source) return false;
      if (JE.isVideoPage?.()) return true;
      if (video.ended) return false;
      const signal = lifetime.lease().signal;
      await sleep(250, signal);
      if (signal.aborted && !JE.isVideoPage?.()) return false;
    }
    return !!JE.isVideoPage?.();
  }
  async function announce(video) {
    const session = JE.session?.createLease?.();
    if (resolving) return;
    const request = ++announcement;
    let lease = lifetime.lease(video);
    resolving = true;
    let itemId;
    try {
      if (!await waitForVideoPage(video) || session && !session.isCurrent() || request !== announcement) return;
      lease = lifetime.lease(video);
      itemId = await resolveItemId(video);
    } finally {
      if (request === announcement) resolving = false;
    }
    if (!lease.current() || request !== announcement) return;
    if (!itemId) {
      console.debug(`${logPrefix} Could not resolve the playing item`);
      return;
    }
    lastSeenId = itemId;
    if (itemId === lastShownId) return;
    lastShownId = itemId;
    const userId = ApiClient.getCurrentUserId?.();
    if (!userId) return;
    const info = await fetchInfo(userId, itemId);
    if (!info?.rating) console.debug(`${logPrefix} No rating for ${itemId}, nothing to show`);
    if (!lease.current() || !info?.rating || lastShownId !== itemId || !JE.isVideoPage?.()) return;
    showBadge(info);
  }
  function onPlaying(e) {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement) || !video.closest(".videoPlayerContainer")) return;
    if (!isEnabled()) return;
    console.debug(`${logPrefix} Playback started`, { hash: window.location.hash, src: (video.currentSrc || "").slice(0, 60) });
    announce(video);
  }
  function onHashChange() {
    if (JE.isVideoPage?.()) return;
    lastShownId = null;
    removeBadge();
  }
  JE.initializePlaybackRatingBadge = function() {
    if (initialized) return;
    if (!isEnabled()) return;
    initialized = true;
    document.addEventListener("playing", onPlaying, true);
    window.addEventListener("hashchange", onHashChange);
    console.log(`${logPrefix} Initialized successfully.`);
  };
  lifetime.onReset(() => {
    infoCache.clear();
    seriesCache.clear();
    lastShownId = null;
    resolving = false;
    removeBadge();
  });
})();
})();
//# sourceMappingURL=playback-rating-badge.js.map
