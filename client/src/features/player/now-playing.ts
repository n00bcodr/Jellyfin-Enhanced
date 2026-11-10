import { playerHost } from './host';
import { decodeItem, decodeItems, decodeSessions, decodeSegments, type Item, type Stream, type PlayingSession, type MediaSegment } from './wire';
import { createPlayerLifetime } from './lifetime';
const { JE, ApiClient, ctx } = playerHost();
const lifetime = createPlayerLifetime(JE, 'now-playing');
const logPrefix = '🪼 Jellyfin Enhanced: Now Playing:';
  const DURATION_TOLERANCE_SECONDS = 2;
  const TICKS_PER_SECOND = 10000000;

  function normalizeId(id: unknown) {
    return id ? String(id).replace(/-/g, '').toLowerCase() : null;
  }

  /** Item id from the stream URL; null for blob: sources. */
  function itemIdFromSource(video?: HTMLVideoElement | null) {
    const src = (video && (video.currentSrc || video.src)) || '';
    const match = src.match(/\/Videos\/([0-9a-f]{32}|[0-9a-f-]{36})\//i);
    return normalizeId(match && match[1]);
  }

  function itemIdFromRoute() {
    return normalizeId(ctx.own.player?.getCurrentVideoItemId?.());
  }

  /** Item the server reports for this device; null unless one session matches and its runtime fits the video. */
  async function itemIdFromSession(video?: HTMLVideoElement | null) {
    const lease = lifetime.lease(video);
    try {
      const userId = ApiClient.getCurrentUserId?.();
      const deviceId = ApiClient.deviceId?.();
      if (!userId || !deviceId) return null;
      const sessions = await ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl('/Sessions', { ControllableByUserId: userId }),
        dataType: 'json'
      });
      if (!lease.current() || !Array.isArray(sessions)) return null;
      const matches = decodeSessions(sessions).filter(s => s?.DeviceId === deviceId && s?.NowPlayingItem?.Id);
      if (matches.length !== 1) return null;
      const item = matches[0]?.NowPlayingItem;
      if (!item) return null;
      if (video && item.RunTimeTicks && Number.isFinite(video.duration)
        && Math.abs(item.RunTimeTicks / TICKS_PER_SECOND - video.duration) > DURATION_TOLERANCE_SECONDS) {
        return null;
      }
      return normalizeId(item.Id);
    } catch (e) {
      console.debug(`${logPrefix} Session probe failed`, e);
      return null;
    }
  }

  /** Stream URL, then page route, then server session; null if none identifies it. */
  async function resolveItemId(video?: HTMLVideoElement | null) {
    return itemIdFromSource(video) || itemIdFromRoute() || await itemIdFromSession(video);
  }

  ctx.own.nowPlaying = { normalizeId, itemIdFromSource, itemIdFromRoute, itemIdFromSession, resolveItemId };
