import type { playerHost } from './host';
import type { PlayerLifetime } from './lifetime';
export type TrackKind = 'subtitle' | 'audio';
export interface PlayerContext {
 JE: ReturnType<typeof playerHost>['JE']; ApiClient: ReturnType<typeof playerHost>['ApiClient']; lifetime: PlayerLifetime;
 getVideo(): HTMLVideoElement | null; getCurrentVideoItemId(): string | null;
 tWithFallback(key: string, fallback: string, params?: Record<string, string | number>): string;
}
