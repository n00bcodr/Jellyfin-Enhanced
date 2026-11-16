import type { PlayerBridge } from './host';
import { record } from './wire';
type Translate = PlayerBridge['t'];
export function renderPauseProgress(progressBar: HTMLElement, progressMeta: HTMLElement, current: number, duration: number, t: Translate) {
          const fill = progressBar.firstElementChild;
          const pct = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
          if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;

          const timeEl = progressMeta.querySelector<HTMLElement>('.progress-time');
          const endsAtEl = progressMeta.querySelector<HTMLElement>('.progress-ends-at');
          const percentageEl = progressMeta.querySelector<HTMLElement>('.progress-percentage');

          if (timeEl) {
            timeEl.textContent = `${formatClock(current)} / ${formatClock(duration)}`;
          }

          if (percentageEl) {
            percentageEl.textContent = t('pausescreen_watched_percent', { percent: Math.round(pct) });
          }

          if (endsAtEl) {
            if (duration > 0 && current < duration) {
              const remainingSeconds = duration - current;
              const endTime = new Date(Date.now() + remainingSeconds * 1000);
              const formattedEndTime = endTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              endsAtEl.textContent = t('pausescreen_ends_at', { time: formattedEndTime });
            } else {
              endsAtEl.textContent = ''; // Clear it if video is over
            }
          }
        }
function formatClock(sec: number) {
          if (!isFinite(sec) || sec <= 0) return "0:00";
          const s = Math.floor(sec % 60).toString().padStart(2, '0');
          const m = Math.floor((sec / 60) % 60).toString().padStart(2, '0');
          const h = Math.floor(sec / 3600);
          return h > 0 ? `${h}:${m}:${s}` : `${Number(m)}:${s}`;
        }

/**
 * Whether a player-lifetime reset leaves `video`'s playback in place. jellyfin-web creates the <video> first and only
 * then changes the route to the player, so that navigation (which resets every player lifetime, lifetime.ts) belongs
 * to the playback the pause screen is already following: what it holds for that video is still about the item now
 * playing. Forgetting the video there made the next body mutation take it for a new one, clear the caches and request
 * the item and every image probe a second time. False for every other reset: leaving the player, no video, or a video
 * that is no longer in the page.
 */
export function continuesPlayback(JE: Pick<PlayerBridge, 'isVideoPage'>, video: HTMLVideoElement | null): boolean {
    return !!video?.isConnected && !!JE.isVideoPage?.();
}

/** A JE dialog that handles its own keys (subtitle sync's): the pause screen leaves its keys and its focus to it. */
export const OWN_KEYS_DIALOG = '[data-je-own-keys]';

/**
 * The signed-in user's id and token from jellyfin-web's stored credentials, for the active server.
 * @param activeServerId - The active server's id, when the client knows it (it may throw before sign-in).
 */
export function storedCredentials(activeServerId: () => string | null): { token: string; userId: string } | null {
    const creds = localStorage.getItem("jellyfin_credentials");
    if (!creds) return null;
    try {
        const parsed = record(JSON.parse(creds));
        const servers = Array.isArray(parsed.Servers) ? parsed.Servers.map(record) : [];
        // Prefer the ACTIVE server's entry — with multiple stored servers
        // Servers[0] may hold another server's user id/token.
        let active = null;
        try { active = activeServerId(); } catch { active = null; }
        // Fail closed: when the active server is known but has no stored
        // entry, do NOT fall back to another server's token/user id.
        const server = active ? servers.find(s => s.Id === active) : servers[0];
        return server && typeof server.AccessToken === 'string' && typeof server.UserId === 'string' ? { token: server.AccessToken, userId: server.UserId } : null;
    } catch {
        return null;
    }
}
