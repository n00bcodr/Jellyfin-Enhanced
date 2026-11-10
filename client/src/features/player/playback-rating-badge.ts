import { pickAdvisories } from './advisories';
import { playerHost } from './host';
import { decodeItem, decodeItems, decodeSessions, decodeSegments, type Item, type Stream, type PlayingSession, type MediaSegment } from './wire';
import { createPlayerLifetime } from './lifetime';
const { JE, ApiClient, ctx } = playerHost();
const lifetime = createPlayerLifetime(JE, 'playback-rating-badge');
const logPrefix = '🪼 Jellyfin Enhanced: Playback Rating Badge:';
  const BADGE_ID = 'je-playback-rating-badge';
  const STYLE_ID = 'je-playback-rating-badge-style';
  const SHOW_MS = 5000;
  const FADE_MS = 400;
  const MAX_LINE_ITEMS = 3;
  const nowPlaying = ctx.own.nowPlaying;
  type BadgeInfo = { rating: string; genres: string[]; advisories: string[] };
  const infoCache = new Map<string, BadgeInfo | null>();
  const seriesCache = new Map<string, Item | null>();
  let lastShownId: string | null = null;
  // Survives leaving the player: the OSD keeps this id until Jellyfin refreshes it
  let lastSeenId: string | null = null;
  let resolving = false;
  let announcement = 0;
  let hideTimer: number | undefined = undefined;
  let removeTimer: number | undefined = undefined;
  let initialized = false;

  JE.session?.onUserChange('playback-rating-badge', () => {
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
    const id = document.querySelector<HTMLElement>('.videoOsdBottom .btnUserRating[data-id]')?.dataset?.id;
    return id ? id.replace(/-/g, '').toLowerCase() : null;
  }

  async function fetchItems(userId: string, ids: string[]) {
    const result = await ApiClient.ajax({
      type: 'GET',
      url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: ids.join(','), Fields: 'OfficialRating,Genres,Tags' }),
      dataType: 'json'
    });
    return decodeItems(result);
  }

  async function fetchInfo(userId: string, itemId: string) {
    const lease = lifetime.lease();
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
          if (!seriesCache.has(item.SeriesId)) {
            const series = (await fetchItems(userId, [item.SeriesId]))[0] || null;
            if (!lease.current()) return null;
            seriesCache.set(item.SeriesId, series);
          }
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
    if (!lease.current()) return null;
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
    hideTimer = removeTimer = undefined;
    document.getElementById(BADGE_ID)?.remove();
  }

  function showBadge(info: BadgeInfo) {
    removeBadge();
    ensureStyles();

    const badge = document.createElement('div');
    badge.id = BADGE_ID;

    const rating = document.createElement('div');
    rating.className = 'je-age-rating mediaInfoOfficialRating';
    rating.setAttribute('rating', info.rating);
    rating.textContent = info.rating;
    badge.appendChild(rating);

    const lines: [string, string[]][] = [['je-age-why', info.advisories], ['je-age-genres', info.genres]];
    lines.forEach(([className, items]) => {
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

  const sleep = (ms: number, signal: AbortSignal) => lifetime.sleep(ms, signal);

  // Source URL, page hash, now-playing probe, then OSD button. The last two can still hold
  // the previous item, so wait for the id to change (unchanged after 6s means a replay).
  async function resolveItemId(video: HTMLVideoElement) {
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

  // The route can change to #/video just after playback starts
  async function waitForVideoPage(video: HTMLVideoElement) {
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

  async function announce(video: HTMLVideoElement) {
    const session = JE.session?.createLease?.();
    if (resolving) return;
    const request = ++announcement;
    let lease = lifetime.lease(video);
    resolving = true;
    let itemId;
    try {
      if (!(await waitForVideoPage(video)) || (session && !session.isCurrent()) || request !== announcement) return;
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

  function onPlaying(e: Event) {
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

lifetime.onReset(() => {
    // Route changes must retain the stale OSD marker; the account handler above clears it.
    infoCache.clear(); seriesCache.clear(); lastShownId = null; resolving = false; removeBadge();
});
