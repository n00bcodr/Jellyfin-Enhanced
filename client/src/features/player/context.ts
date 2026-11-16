import type { playerHost } from './host';
import type { PlayerLifetime } from './lifetime';
export type TrackKind = 'subtitle' | 'audio';
export interface PlayerContext {
 JE: ReturnType<typeof playerHost>['JE']; ApiClient: ReturnType<typeof playerHost>['ApiClient']; lifetime: PlayerLifetime;
 getVideo(): HTMLVideoElement | null; getCurrentVideoItemId(): string | null;
 tWithFallback(key: string, fallback: string, params?: Record<string, string | number>): string;
}
/**
 * The toast for a player action that needs a `<video>` element the current player does not have (mpv in
 * Jellyfin Desktop) and that jellyfin-web offers no other way to do.
 */
export const playerUnsupportedText = (context: Pick<PlayerContext, 'tWithFallback'>): string =>
    context.tWithFallback('toast_player_unsupported', '{{icon:info}} Not available with this player');
