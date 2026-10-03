// /js/enhanced/player/playback-rating-badge.js
// Shows the age rating, advisory tags and genres briefly when playback starts, once per item.
(function(JE) {
  'use strict';

  const logPrefix = '🪼 Jellyfin Enhanced: Playback Rating Badge:';
  const BADGE_ID = 'je-playback-rating-badge';
  const STYLE_ID = 'je-playback-rating-badge-style';
  const SHOW_MS = 5000;
  const FADE_MS = 400;
  const MAX_LINE_ITEMS = 3;
  // Advisory tag patterns, most serious first
  const ADVISORY_PATTERNS = [
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
      const rank = ADVISORY_PATTERNS.findIndex(re => re.test(tag));
      if (rank !== -1) ranked.push({ tag, rank });
    }
    ranked.sort((x, y) => x.rank - y.rank);
    const names = ranked.map(r => r.tag);
    // Drop tags contained in another ("murder" in "mass murder")
    return names
      .filter(n => !names.some(o => o !== n && o.toLowerCase().includes(n.toLowerCase())))
      .map(n => n.replace(/(^|\s)(\S)/g, (_, sp, ch) => sp + ch.toUpperCase()));
  }

  const infoCache = new Map();
  const seriesCache = new Map();
  let lastShownId = null;
  // Survives leaving the player: the OSD keeps this id until Jellyfin refreshes it
  let lastSeenId = null;
  let resolving = false;
  let hideTimer = null;
  let removeTimer = null;
  let initialized = false;

  window.JellyfinEnhanced.session?.onUserChange('playback-rating-badge', () => {
    infoCache.clear();
    seriesCache.clear();
    lastShownId = null;
    lastSeenId = null;
    removeBadge();
  });

  function isEnabled() {
    return JE.pluginConfig?.ShowPlaybackRatingBadge === true;
  }

  function parseItemIdFromSrc(video) {
    const src = (video && (video.currentSrc || video.src)) || '';
    const match = src.match(/\/Videos\/([0-9a-f]{32}|[0-9a-f-]{36})\//i);
    return match ? match[1].replace(/-/g, '').toLowerCase() : null;
  }

  function getOsdItemId() {
    const id = document.querySelector('.videoOsdBottom .btnUserRating[data-id]')?.dataset?.id;
    return id ? id.replace(/-/g, '').toLowerCase() : null;
  }

  async function fetchItems(userId, ids) {
    const result = await ApiClient.ajax({
      type: 'GET',
      url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: ids.join(','), Fields: 'OfficialRating,Genres,Tags' }),
      dataType: 'json'
    });
    return result?.Items || [];
  }

  async function fetchInfo(userId, itemId) {
    if (infoCache.has(itemId)) return infoCache.get(itemId);
    let info = null;
    try {
      const item = (await fetchItems(userId, [itemId]))[0];
      if (item) {
        let rating = item.OfficialRating || '';
        let genres = item.Genres || [];
        let tags = item.Tags || [];
        // Episodes fall back to their series
        if (item.SeriesId) {
          if (!seriesCache.has(item.SeriesId)) seriesCache.set(item.SeriesId, (await fetchItems(userId, [item.SeriesId]))[0] || null);
          const series = seriesCache.get(item.SeriesId);
          if (series) {
            rating = rating || series.OfficialRating || '';
            if (!genres.length) genres = series.Genres || [];
            tags = [...new Set([...tags, ...(series.Tags || [])])];
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
    infoCache.set(itemId, info);
    return info;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
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
    hideTimer = removeTimer = null;
    document.getElementById(BADGE_ID)?.remove();
  }

  function showBadge(info) {
    removeBadge();
    ensureStyles();

    const badge = document.createElement('div');
    badge.id = BADGE_ID;

    const rating = document.createElement('div');
    rating.className = 'je-age-rating mediaInfoOfficialRating';
    rating.setAttribute('rating', info.rating);
    rating.textContent = info.rating;
    badge.appendChild(rating);

    [['je-age-why', info.advisories], ['je-age-genres', info.genres]].forEach(([className, items]) => {
      if (!items.length) return;
      const line = document.createElement('div');
      line.className = className;
      line.textContent = items.join(' • ');
      badge.appendChild(line);
    });

    document.body.appendChild(badge);
    requestAnimationFrame(() => requestAnimationFrame(() => badge.classList.add('je-visible')));

    hideTimer = setTimeout(() => {
      badge.classList.remove('je-visible');
      removeTimer = setTimeout(() => badge.remove(), FADE_MS);
    }, SHOW_MS);
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeId(id) {
    return id ? String(id).replace(/-/g, '').toLowerCase() : null;
  }

  // Server's view of what this device is playing, for blob: sources with no id in the URL
  async function probeNowPlayingId(userId) {
    try {
      const deviceId = ApiClient.deviceId?.();
      if (!deviceId) return null;
      const sessions = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl('/Sessions', { ControllableByUserId: userId }),
        dataType: 'json'
      });
      if (!Array.isArray(sessions)) return null;
      const matches = sessions.filter(x => x?.DeviceId === deviceId && x?.NowPlayingItem?.Id);
      return matches.length === 1 ? normalizeId(matches[0].NowPlayingItem.Id) : null;
    } catch (e) {
      console.debug(`${logPrefix} Now-playing probe failed`, e);
      return null;
    }
  }

  // Source URL, page hash, now-playing probe, then OSD button. The last two can still hold
  // the previous item, so wait for the id to change (unchanged after 6s means a replay).
  async function resolveItemId(video) {
    const fromSrc = parseItemIdFromSrc(video);
    if (fromSrc) return fromSrc;

    const fromHash = normalizeId(JE.internals?.player?.getCurrentVideoItemId?.());
    if (fromHash) return fromHash;

    const userId = ApiClient.getCurrentUserId?.();
    for (let i = 0; i < 12; i++) {
      const id = (userId && await probeNowPlayingId(userId)) || getOsdItemId();
      if (id && id !== lastSeenId) return id;
      await sleep(500);
      if (video.ended || !JE.isVideoPage?.()) return null;
    }
    return (userId && await probeNowPlayingId(userId)) || getOsdItemId();
  }

  // The route can change to #/video just after playback starts
  async function waitForVideoPage(video) {
    for (let i = 0; i < 20; i++) {
      if (JE.isVideoPage?.()) return true;
      if (video.ended) return false;
      await sleep(250);
    }
    return !!JE.isVideoPage?.();
  }

  async function announce(video) {
    if (resolving) return;
    resolving = true;
    let itemId;
    try {
      if (!(await waitForVideoPage(video))) return;
      itemId = await resolveItemId(video);
    } finally {
      resolving = false;
    }
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
    if (!info?.rating || lastShownId !== itemId || !JE.isVideoPage?.()) return;
    showBadge(info);
  }

  function onPlaying(e) {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement) || !video.closest('.videoPlayerContainer')) return;
    if (!isEnabled()) return;
    console.debug(`${logPrefix} Playback started`, { hash: window.location.hash, src: (video.currentSrc || '').slice(0, 60) });
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
    // Media events don't bubble
    document.addEventListener('playing', onPlaying, true);
    window.addEventListener('hashchange', onHashChange);
    console.log(`${logPrefix} Initialized successfully.`);
  };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
