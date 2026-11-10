import type { JsonValue } from '../../contracts/generated';
import type { Shortcut } from './host';

/** Actions that only fire on the video player page (see JE.keyListener). */
export const PLAYER_ACTIONS: ReadonlySet<string> = new Set([
    'BookmarkCurrentTime', 'CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu',
    'CycleSubtitleTracks', 'CycleAudioTracks', 'ResetPlaybackSpeed', 'IncreasePlaybackSpeed',
    'DecreasePlaybackSpeed', 'OpenEpisodePreview', 'SkipIntroOutro', 'FrameStepBack',
    'FrameStepForward', 'DecreaseSubtitleOffset', 'IncreaseSubtitleOffset', 'JumpToLastPosition'
]);

/** Keys Jellyfin's built-in player handles natively (combo format matches JE.keyListener). */
export const JELLYFIN_PLAYER_KEYS: ReadonlySet<string> = new Set([
    ' ', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'PageUp', 'PageDown', 'Home', 'End', 'K', 'J', 'L', 'M', 'F', 'Shift+N', 'Shift+P'
]);

/** Player actions shown in the panel's Player column, in display order. */
export const PLAYER_COLUMN = ['CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu', 'CycleSubtitleTracks', 'CycleAudioTracks',
    'IncreasePlaybackSpeed', 'DecreasePlaybackSpeed', 'ResetPlaybackSpeed', 'BookmarkCurrentTime', 'OpenEpisodePreview',
    'SkipIntroOutro', 'FrameStepBack', 'FrameStepForward', 'DecreaseSubtitleOffset', 'IncreaseSubtitleOffset', 'JumpToLastPosition',
    'JumpToPercentage'] as const;

/**
 * Why a combo cannot be bound to an action: a player action can't take a key
 * Jellyfin's own player handles (both would fire on one press), and no two
 * actions may share a combo. Stored bindings may list modifiers in any order,
 * so they are compared through the key listener's canonical form.
 */
export function rejectsBinding(action: string, combo: string, active: Readonly<Record<string, string>>, canonical: (value: string) => string): boolean {
    const existingAction = Object.keys(active).find(name => canonical(active[name] ?? '') === combo);
    const isReservedPlayerKey = PLAYER_ACTIONS.has(action) && JELLYFIN_PLAYER_KEYS.has(combo);
    return isReservedPlayerKey || (!!existingAction && existingAction !== action);
}

/** Decode the plugin's default shortcut list (untrusted config JSON); entries without a string Name are dropped. */
export function pluginShortcutList(value: JsonValue | undefined): Shortcut[] {
    if (!Array.isArray(value)) return [];
    const list: Shortcut[] = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const name = entry.Name;
        if (typeof name !== 'string') continue;
        const key = entry.Key;
        list.push({ ...entry, Name: name, Key: typeof key === 'string' ? key : '' });
    }
    return list;
}

/** A user override for an action: the plugin default's fields with the new key. */
export function overrideFor(action: string, key: string, defaults: readonly Shortcut[]): Shortcut {
    const defaultConfig = defaults.find(s => s.Name === action);
    return { ...defaultConfig, Name: defaultConfig?.Name ?? action, Key: key };
}
