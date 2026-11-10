import type { PlayerBridge } from './host';
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
