/**
 * @file Subtitle sync: what jellyfin-web is drawing the subtitles with, and its subtitle offset.
 *
 * The offset is jellyfin-web's own, read from and written through its subtitle sync slider. A positive
 * offset shows subtitles earlier (htmlVideoPlayer subtracts it from each cue). Its hidden slider keeps an
 * earlier track's value after a track switch, while the player resets the offset to 0, so the renderer
 * (the cue track's first cue, or the drawn element) and every write through the slider are watched.
 */
import { cleanLineText, measureOffset, searchKey, type CueSample, type SubtitleLine } from './lines';

/** Cues compared with the lines to tell whether they are the same track. */
const CUE_SAMPLE_SIZE = 24;

/** jellyfin-web's subtitle sync slider: its control adds updateOffset(), which applies the offset. */
type SyncSlider = HTMLInputElement & { updateOffset?: unknown };
/** Which of jellyfin-web's renderers shows the primary subtitles, and what it draws with. */
export type Renderer = { kind: 'cues'; track: TextTrack; cue: TextTrackCue | null } | { kind: 'drawn'; el: Element } | { kind: 'none' };

const syncSlider = (): SyncSlider | null => document.querySelector<SyncSlider>('.subtitleSyncSlider');

/** The media element's source URL, used to notice a source change. */
export function videoSrc(video: HTMLVideoElement | null): string {
    return (video && (video.currentSrc || video.src)) || '';
}

/** jellyfin-web's current subtitle offset, read from its sync slider; null when the player has no sync control. */
export function currentOffset(): number | null {
    const slider = syncSlider();
    if (!slider || typeof slider.updateOffset !== 'function') return null;
    const v = parseFloat(slider.value);
    return Number.isFinite(v) ? v : 0;
}

/** The cue track jellyfin-web fills and shows for the primary subtitles, if it uses one. */
function shownCueTrack(video: HTMLVideoElement | null): TextTrack | null {
    try {
        const tracks = video && video.textTracks ? Array.from(video.textTracks) : [];
        return tracks.find(t => t && String(t.label || '') === 'manualTrack' && t.mode === 'showing') || null;
    } catch {
        return null;
    }
}

/** Up to CUE_SAMPLE_SIZE cues spread over the shown cue track, for measureOffset. */
export function cueSample(video: HTMLVideoElement | null): CueSample[] | null {
    const cues = shownCueTrack(video)?.cues;
    if (!cues || !cues.length) return null;
    const step = Math.max(1, Math.floor(cues.length / CUE_SAMPLE_SIZE));
    const sample: CueSample[] = [];
    for (let i = 0; i < cues.length && sample.length < CUE_SAMPLE_SIZE; i += step) {
        const cue = cues[i];
        if (cue) sample.push({ start: cue.startTime, key: searchKey(cleanLineText(Reflect.get(cue, 'text'))) });
    }
    return sample;
}

/**
 * The element jellyfin-web draws the primary subtitles on when it doesn't use a cue track: its custom
 * subtitle element or the libass canvas for ASS/SSA. It creates a new one for each track it shows, right
 * after resetting the subtitle offset to 0 (htmlVideoPlayer setTrackForDisplay).
 */
function drawnSurface(video: HTMLVideoElement | null): Element | null {
    const custom = document.querySelector('.videoSubtitles .videoSubtitlesInner');
    if (custom) return custom;
    return video?.parentElement?.querySelector('.libassjs-canvas-parent') || null;
}

/** The first cue object of the shown cue track. */
function firstCue(video: HTMLVideoElement | null): TextTrackCue | null {
    const cues = video ? shownCueTrack(video)?.cues : null;
    return cues && cues.length ? cues[0] ?? null : null;
}

/**
 * What identifies the subtitles jellyfin-web is drawing: its cue track's first cue object, or its drawn
 * element (libass, custom element). Both are new for every track it shows, and it creates them right
 * after resetting the offset to 0 (htmlVideoPlayer setTrackForDisplay → renderTracksEvents, jellyfin-web
 * 10.11 and 12), even for a file with the same text; an offset change only moves the existing cues' times.
 */
export function rendererKey(video: HTMLVideoElement | null): object | null {
    return video ? firstCue(video) || drawnSurface(video) : null;
}

export function rendererOf(video: HTMLVideoElement): Renderer {
    const track = shownCueTrack(video);
    if (track) return { kind: 'cues', track, cue: firstCue(video) };
    const el = drawnSurface(video);
    return el ? { kind: 'drawn', el } : { kind: 'none' };
}

/**
 * Whether two renderer readings are the same subtitles: the same cue track holding the same cues, the
 * same drawn element, or nothing drawn both times.
 */
export function sameRenderer(a: Renderer, b: Renderer): boolean {
    if (a.kind === 'cues') return b.kind === 'cues' && a.track === b.track && a.cue === b.cue;
    if (a.kind === 'drawn') return b.kind === 'drawn' && a.el === b.el;
    return b.kind === 'none';
}

/**
 * Whether the listed lines are still the subtitles on screen: jellyfin-web still draws them with what it
 * drew them with when they loaded (see sameRenderer), and cues, if any, carry their text. A track switch,
 * subtitles going off or another renderer appearing all fail it.
 */
export function linesStillShown(video: HTMLVideoElement, lines: readonly SubtitleLine[] | null, renderer: Renderer | null): boolean {
    if (!lines || !renderer) return false;
    if (!sameRenderer(renderer, rendererOf(video))) return false;
    return measureOffset(lines, cueSample(video)) !== 'mismatch';
}

/**
 * Whether jellyfin-web draws the current subtitles itself, so an offset moves them: a cue track it fills
 * ('manualTrack'), its custom subtitle element, or the libass canvas for ASS/SSA. Burned-in subtitles
 * have none of these.
 */
export function clientRendersSubtitles(video: HTMLVideoElement | null): boolean {
    if (shownCueTrack(video)) return true;
    if (document.querySelector('.videoSubtitles .videoSubtitlesInner')) return true;
    return !!video?.parentElement?.querySelector('.libassjs-canvas-parent, .libassjs-canvas');
}

/** Whether choosing a line can sync it, and if not, why. */
export function syncSupport(video: HTMLVideoElement): { ok: true } | { ok: false; reason: 'unavailable' | 'burned' } {
    if (currentOffset() === null) return { ok: false, reason: 'unavailable' };
    if (!clientRendersSubtitles(video)) return { ok: false, reason: 'burned' };
    return { ok: true };
}

/** The records of subtitle changes on screen and of writes to jellyfin-web's offset, for one page. */
export function createSubtitleWatch(getVideo: () => HTMLVideoElement | null) {
    /**
     * Writes to jellyfin-web's subtitle offset through its sync control since the page loaded: its slider's
     * updateOffset() (used by its G/H keys, its text field and JE) and dragging the slider.
     */
    let sliderWrites = 0;
    /** Sliders already watched (jellyfin-web makes a new one for each playback). */
    const watchedSliders = new WeakSet<Element>();
    /** When the subtitles on screen last changed (shown, switched or turned off), by this page's clock. */
    let changedAt = 0;
    /** Counts subtitle changes on screen; a load spanning a change can't trust what it read. */
    let generation = 0;
    /** The renderer key last seen (see rendererKey); undefined before the first look. */
    let keySeen: object | null | undefined;
    /**
     * Each renderer key seen, with the slider write count when it was first seen. A key seen again (Firefox
     * briefly hides the cues on every offset change) keeps its first record.
     */
    const firstSeen = new WeakMap<object, number>();
    /** The text track list watched for subtitle changes. */
    let watchedTrackList: TextTrackList | null = null;

    /**
     * Counts one offset write. A renderer that appeared since the last look is recorded first, so this
     * write counts as made after it (see effectiveOffset).
     */
    function countSliderWrite(): void {
        noteRenderer();
        sliderWrites++;
    }

    /**
     * Counts every write through jellyfin-web's subtitle sync slider: wraps its updateOffset (calling the
     * original unchanged) and listens for it being dragged.
     */
    function watchSliderWrites(): void {
        const slider = syncSlider();
        const original = slider?.updateOffset;
        if (!slider || watchedSliders.has(slider) || typeof original !== 'function') return;
        watchedSliders.add(slider);
        slider.updateOffset = function (this: unknown, ...args: unknown[]): unknown {
            countSliderWrite();
            return Reflect.apply(original, this, args);
        };
        slider.addEventListener('change', countSliderWrite);
    }

    /** A change of the video's text tracks, looked at once it settles (Firefox restores the mode after an offset change in a 0 ms timeout). */
    const onTrackListChange = (): void => { setTimeout(noteRenderer, 50); };

    /** Watches the video's text track list for changes, moving to a new video element when the player replaces it. */
    function watchSubtitleChanges(video: HTMLVideoElement | null): void {
        const list = video?.textTracks;
        if (!list || list === watchedTrackList || typeof list.addEventListener !== 'function') return;
        if (watchedTrackList && typeof watchedTrackList.removeEventListener === 'function') watchedTrackList.removeEventListener('change', onTrackListChange);
        watchedTrackList = list;
        list.addEventListener('change', onTrackListChange);
    }

    /**
     * Records the renderer when it changed, after making sure offset writes and track changes are watched.
     * A new renderer is seen soon after jellyfin-web creates it: this runs on every video-page DOM update
     * (the first of which comes before any subtitles are drawn), 50 ms after each text track change, and
     * before the dialog relies on it (a change can be newer than the last page update or that delay).
     */
    function noteRenderer(): void {
        watchSliderWrites();
        const video = getVideo();
        watchSubtitleChanges(video);
        const key = rendererKey(video);
        if (keySeen === undefined) {
            // The first look: what is there already is not a change, and its offset history is unknown
            // (the slider is trusted for it).
            keySeen = key;
            return;
        }
        if (key === keySeen) return;
        keySeen = key;
        if (key && firstSeen.has(key)) return;
        if (key) firstSeen.set(key, sliderWrites);
        // A subtitle change on screen.
        changedAt = Date.now();
        generation++;
    }

    /**
     * The offset the dialog shows and jumps with: 0 for subtitles jellyfin-web doesn't draw itself. With
     * enough cues it is measured from them; otherwise, when nobody has written the offset since the current
     * renderer appeared, it is 0; otherwise the slider's.
     * @returns null when the player has no subtitle offset.
     */
    function effectiveOffset(video: HTMLVideoElement, lines: readonly SubtitleLine[] | null): number | null {
        const slider = currentOffset();
        if (slider === null) return null;
        // Subtitles jellyfin-web doesn't draw itself (burned into the picture) never move with it.
        if (!clientRendersSubtitles(video)) return 0;
        if (lines) {
            const measured = measureOffset(lines, cueSample(video));
            if (typeof measured === 'number') return measured;
        }
        noteRenderer();
        const key = rendererKey(video);
        if (key && firstSeen.has(key) && firstSeen.get(key) === sliderWrites) return 0;
        return slider;
    }

    return {
        noteRenderer, effectiveOffset,
        generation: () => generation,
        changedAt: () => changedAt,
        /** Whether a renderer has been seen at the last look. */
        sawRenderer: () => !!keySeen,
    };
}
export type SubtitleWatch = ReturnType<typeof createSubtitleWatch>;
