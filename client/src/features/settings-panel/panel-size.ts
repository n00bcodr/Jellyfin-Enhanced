/**
 * Pure rules for the settings panel's stored size (no DOM, no storage):
 * parsing the per-user value, the allowed range for a window, and the
 * pixel box a choice stands for.
 */
export const PANEL_SIZE_PRESETS = ['default', 'large', 'fill'] as const;
export type PanelSizePreset = typeof PANEL_SIZE_PRESETS[number];
export type PanelSize = { preset: PanelSizePreset } | { preset: 'custom'; width: number; height: number };
export interface Box { width: number; height: number }
export interface Viewport { width: number; height: number }

export const STORE_PREFIX = 'JE_panelSize_';
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;
/** Space kept between the panel and every window edge, in px. */
export const GUTTER = 24;

export const isPreset = (value: unknown): value is PanelSizePreset =>
    typeof value === 'string' && PANEL_SIZE_PRESETS.some(name => name === value);

/** Parse a stored value; anything unreadable or malformed counts as Default. */
export function parseSize(raw: string | null): PanelSize {
    if (!raw) return { preset: 'default' };
    try {
        const value: unknown = JSON.parse(raw);
        if (value === null || typeof value !== 'object') return { preset: 'default' };
        const preset: unknown = Reflect.get(value, 'preset');
        if (isPreset(preset)) return { preset };
        const width: unknown = Reflect.get(value, 'width');
        const height: unknown = Reflect.get(value, 'height');
        if (preset === 'custom' && typeof width === 'number' && typeof height === 'number'
            && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { preset: 'custom', width: Math.round(width), height: Math.round(height) };
        }
    } catch {
        // Not JSON: fall through to Default.
    }
    return { preset: 'default' };
}

/**
 * The allowed size range for a window: at least 720×480, at most the window
 * minus the gutter on each side (the maximum wins on a window too small for
 * the minimum).
 */
export function sizeBounds(view: Viewport): { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number } {
    const maxWidth = Math.max(0, view.width - GUTTER * 2);
    const maxHeight = Math.max(0, view.height - GUTTER * 2);
    return { minWidth: Math.min(MIN_WIDTH, maxWidth), minHeight: Math.min(MIN_HEIGHT, maxHeight), maxWidth, maxHeight };
}

/** Clamp a width and height to the allowed range. */
export function clampSize(width: number, height: number, view: Viewport): Box {
    const b = sizeBounds(view);
    return {
        width: Math.round(Math.min(b.maxWidth, Math.max(b.minWidth, width))),
        height: Math.round(Math.min(b.maxHeight, Math.max(b.minHeight, height)))
    };
}

/** The pixel size a stored choice (not Default, which is left to the CSS) stands for in a window. */
export function resolveSize(size: PanelSize, view: Viewport): Box {
    if (size.preset === 'large') return clampSize(view.width * 0.9, view.height * 0.9, view);
    if (size.preset === 'fill') return clampSize(Infinity, Infinity, view);
    if (size.preset === 'custom') return clampSize(size.width, size.height, view);
    return clampSize(view.width, view.height, view);
}

/** Arrow-key steps on the grip: [width, height] direction per key. */
export const KEY_STEPS: Readonly<Record<string, readonly [number, number]>> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
