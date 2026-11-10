import type { JsonValue } from './config';
import { isObject } from './config';

/** A shortcut as stored in the configuration; fields this page does not know are kept. */
export interface ShortcutEntry { Name: string; Key: string; Label?: string; Category?: string; [extra: string]: JsonValue | undefined }

function isShortcut(value: unknown): value is ShortcutEntry {
    return isObject(value) && typeof value.Name === 'string' && typeof value.Key === 'string';
}

/** The usable entries of the stored shortcut list. */
export function shortcutEntries(value: unknown): ShortcutEntry[] {
    return Array.isArray(value) ? value.filter(isShortcut) : [];
}

/** The list as configuration JSON. */
export function shortcutsToJson(entries: readonly ShortcutEntry[]): JsonValue {
    return entries.map(entry => Object.fromEntries(Object.entries(entry).filter((field): field is [string, JsonValue] => field[1] !== undefined)));
}

export const DEFAULT_SHORTCUTS: readonly ShortcutEntry[] = [
    { Name: "OpenSearch", Key: "/", Label: "Open Search", Category: "Global" },
    { Name: "GoToHome", Key: "Shift+H", Label: "Go to Home", Category: "Global" },
    { Name: "GoToDashboard", Key: "D", Label: "Go to Dashboard", Category: "Global" },
    { Name: "QuickConnect", Key: "Q", Label: "Quick Connect", Category: "Global" },
    { Name: "PlayRandomItem", Key: "R", Label: "Play Random Item", Category: "Global" },
    { Name: "CycleAspectRatio", Key: "A", Label: "Cycle Aspect Ratio", Category: "Player" },
    { Name: "ShowPlaybackInfo", Key: "I", Label: "Show Playback Info", Category: "Player" },
    { Name: "SubtitleMenu", Key: "S", Label: "Subtitle Menu", Category: "Player" },
    { Name: "CycleSubtitleTracks", Key: "C", Label: "Cycle Subtitle Tracks", Category: "Player" },
    { Name: "CycleAudioTracks", Key: "V", Label: "Cycle Audio Tracks", Category: "Player" },
    { Name: "IncreasePlaybackSpeed", Key: "+", Label: "Increase Playback Speed", Category: "Player" },
    { Name: "DecreasePlaybackSpeed", Key: "-", Label: "Decrease Playback Speed", Category: "Player" },
    { Name: "ResetPlaybackSpeed", Key: "R", Label: "Reset Playback Speed", Category: "Player" },
    { Name: "BookmarkCurrentTime", Key: "B", Label: "Bookmark Current Time", Category: "Player" },
    { Name: "OpenEpisodePreview", Key: "P", Label: "Open Episode Preview", Category: "Player" },
    { Name: "SkipIntroOutro", Key: "O", Label: "Skip Intro/Outro", Category: "Player" },
    { Name: "FrameStepBack", Key: ",", Label: "Step Back One Frame", Category: "Player" },
    { Name: "FrameStepForward", Key: ".", Label: "Step Forward One Frame", Category: "Player" },
    { Name: "DecreaseSubtitleOffset", Key: "[", Label: "Decrease Subtitle Offset", Category: "Player" },
    { Name: "IncreaseSubtitleOffset", Key: "]", Label: "Increase Subtitle Offset", Category: "Player" },
    { Name: "JumpToLastPosition", Key: "Z", Label: "Jump to Last Position", Category: "Player" },
    { Name: "JumpToPercentage", Key: "0-9", Label: "Jump to % of video", Category: "Player" }
];

// Same player-page actions and Jellyfin-native keys the per-user panel protects.
const PLAYER_KEYS_TAKEN: ReadonlySet<string> = new Set([' ', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'K', 'J', 'L', 'M', 'F', 'Shift+N', 'Shift+P']);

/** The stored name of a pressed key: letters upper-cased, Shift left out of the symbols it produces. */
export function shortcutCombo(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string {
    const isLetter = /^[a-zA-Z]$/.test(event.key);
    const isShiftedSymbol = event.key.length === 1 && event.key !== ' ' && !isLetter;
    return (event.metaKey ? 'Meta+' : '') + (event.ctrlKey ? 'Ctrl+' : '') + (event.altKey ? 'Alt+' : '')
        + (event.shiftKey && !isShiftedSymbol ? 'Shift+' : '') + (isLetter ? event.key.toUpperCase() : event.key);
}

/** Why a key cannot be assigned to a shortcut, or null when it can. */
export function shortcutClash(
    shortcut: ShortcutEntry,
    combo: string,
    all: readonly ShortcutEntry[],
    keyOf: (entry: ShortcutEntry) => string,
): string | null {
    if (combo === shortcut.Key) return null;
    if (shortcut.Category === 'Player' && PLAYER_KEYS_TAKEN.has(combo)) return "The key '" + combo + "' is already used by the Jellyfin player.";
    const other = all.find(entry => entry.Name !== shortcut.Name && keyOf(entry) === combo);
    return other ? "The key '" + combo + "' is already used by '" + other.Label + "'." : null;
}
