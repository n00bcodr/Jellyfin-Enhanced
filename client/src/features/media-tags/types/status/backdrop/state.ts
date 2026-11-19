import type { Gradient } from './css-values';

/** The class of a status tag (statustags.ts). */
export const tagClass = 'status-tag';
export const backdropLog = '🪼 Jellyfin Enhanced: Status tag backdrop:';
/** The Gaussian sigma of the look, in CSS pixels (the old `backdrop-filter: blur(6px)`). */
export const BLUR_PX = 6;
/** Pictures are drawn at the device's pixel density, up to this many pixels per CSS pixel. */
export const MAX_SCALE = 3;
/** Decoded artwork kept for cards drawn again (their chips moved, the window resized): images, and their pixels in all. */
export const ARTWORK_CAP = 12;
export const ARTWORK_PIXELS = 4e6;
/** Decodes in flight at once. */
export const MAX_DECODES = 4;
/** A slice starts another step only with this much idle time left (ms). */
export const STEP_MIN_MS = 3;
/** A slice's budget without an idle deadline (no requestIdleCallback), in ms. */
export const SLICE_BUDGET_MS = 6;
/** A measuring pass reads this many cards at a time and starts no further batch after this long (ms): the rest wait for the next paint. */
export const MEASURE_CARDS = 6;
export const MEASURE_BUDGET_MS = 3;
/** A window resize is measured this long after the last one (ms); a card that changed size is measured at once. */
export const RESIZE_SETTLE_MS = 200;
/** How far past its box a chip's shadow, ring or outline may paint (pixels of the grid). */
export const BENEATH_REACH = 6;
/** Artwork addresses remembered as unreadable. */
export const UNREADABLE_CAP = 500;
/**
 * How long after the pointer or focus has left a card its pictures come back (ms): once Jellyfin's overlay has faded
 * from the artwork, and before the layout controller rests the card (its 200 ms).
 */
export const LIVE_REST_MS = 180;
/** A scaled card is looked at again after this long, doubling up to the cap while it stays scaled (ms). */
export const HOLD_MS = 1000;
export const HOLD_MAX_MS = 30000;
/**
 * Pictures wait until no new card with a status tag has come for this long (ms): they are painted after a page has
 * finished loading, not while it does. (A tag drawn again on a card already watched does not restart the wait: that is
 * one card's work, not a page arriving.)
 */
export const QUIET_MS = 3000;
/** What ends a passing state of a card (measureAgainLater). */
export const AGAIN_EVENTS = ['transitionend', 'transitioncancel', 'animationend', 'pointerleave', 'focusout'];
/** The colour the canvas probe draws and must read back (isSupported). */
export const PROBE_RGB = [18, 52, 86];
/** The layout controller's own marks on a host: how the card is laid out and fades, never where a tag is. */
export const HOST_MARKS = new Set(['data-je-flow', 'data-je-live', 'data-je-blur']);

/** A background painted between the artwork and a tag (pixels in the image box; `host`: the host's own, under every chip). */
export interface Under { x: number; y: number; width: number; height: number; colour: string | null; gradients: Gradient[]; host: boolean }
/** A part of a tag's picture as one background layer: `sx`…`height` are its pixels within the picture, the rest its CSS box in the carrier. */
export interface Piece { carrier: HTMLElement; sx: number; sy: number; width: number; height: number; left: number; top: number; cssWidth: number; cssHeight: number }
/** One tag's picture to draw (pixels, relative to the image box). */
export interface Spec { x: number; y: number; width: number; height: number; radii: number[]; unders: Under[]; pieces: Piece[] }
/** A carrier's own background layers, kept under the pictures. */
export interface Base { image: string[]; position: string[]; size: string[]; repeat: string[] }
/** A picture layer as written. */
export interface Layer { url: string; x: number; y: number; width: number; height: number }
/** Decoded artwork. */
export interface Artwork { drawable: CanvasImageSource; bitmap: boolean; width: number; height: number }

/**
 * A watched card. `sig` is the geometry its pictures were last asked for ('' when it shows none), `carriers` the
 * elements that hold them, `kept` the last pictures drawn and what they were drawn for, `moved` whether its chips or
 * its size changed since it was last read, `on` the elements its last measured pictures belong on, `latest` the job
 * that measurement made (an older one in flight is dropped), `fullSig` what the last read of its layout found ('' for
 * nothing to draw), `again` the way to stop waiting for a passing state to end (measureAgainLater), `live` whether the
 * pointer or focus is on the card (its tags then keep the live filter, see use) and `resting` the timer that ends that.
 */
export interface Card {
    host: HTMLElement;
    chips: MutationObserver | null;
    art: MutationObserver | null;
    container: Element | null;
    img: HTMLImageElement | null;
    onLoad: () => void;
    sig: string;
    carriers: Set<HTMLElement>;
    kept: { job: Job; drawn: Array<string[] | null> } | null;
    moved: boolean;
    on: HTMLElement[];
    latest: Job | null;
    fullSig: string;
    again: (() => void) | null;
    live: boolean;
    resting: ReturnType<typeof setTimeout> | 0;
    holdMs: number;
}

/** A card's pictures being drawn. */
export interface Job {
    card: Card;
    sig: string;
    key: string;
    url: string;
    img: HTMLImageElement | null;
    scale: number;
    boxWidth: number;
    boxHeight: number;
    fit: { size: string; position: string };
    base: string | null;
    specs: Spec[];
    bases: Map<HTMLElement, Base>;
    partial: boolean;
}

/** What the painter reads from the page and calls (the tag runtime's surface). */
export interface BackdropHost {
    core?: {
        dom?: { afterNextPaint?(callback: () => void): unknown };
        tagLayout?: { syncFlowOf?(host: HTMLElement): void };
    };
    session?: { onUserChange?(name: string, callback: () => void): unknown };
}

/** The painter's mutable state, shared by its modules (one object per painter). */
export interface BackdropState {
    /** Host → its card. */
    readonly cards: Map<HTMLElement, Card>;
    /** Cards to measure after the next paint. */
    readonly dirty: Set<Card>;
    /** Carrier → how many of its background layers are pictures. */
    readonly applied: WeakMap<HTMLElement, number>;
    /** Cards waiting for a decode slot, and cards whose artwork is decoded, waiting for their pixel step. */
    readonly waiting: Job[];
    readonly ready: Job[];
    /** Artwork URL → its decode in flight. */
    readonly decoding: Map<string, { jobs: Set<Job> }>;
    /** Decoded artwork, most recent last. */
    readonly artwork: Map<string, Artwork>;
    /** Artwork that cannot be read (a tainted canvas, a broken image); the oldest are forgotten past UNREADABLE_CAP. */
    readonly unreadable: Set<string>;
    /** Origins whose artwork taints the canvas: nothing from them is decoded again. */
    readonly tainting: Set<string>;
    /** Cards found still in use when their pictures were due back (see rest). */
    readonly lingering: Set<Card>;
    /** Hosts released while they were off the page (see resume). */
    readonly detached: WeakSet<HTMLElement>;
    readonly counters: Record<'passes' | 'maxPassMs' | 'measures' | 'measureMs' | 'maxMeasureMs' | 'layoutMs' | 'cards' | 'reused' | 'slices' | 'sliceMs'
        | 'maxSliceMs' | 'decodes' | 'drawn' | 'plain' | 'pixelMs' | 'maxPixelMs' | 'failed', number>;
    active: boolean;
    /** Whether this browser can do the pixel work (decided when the first picture is due). */
    supported: boolean | null;
    generation: number;
    /** How long no new card must have been tracked before pictures are painted (ms; scheduleSlice), and when the last one was. */
    quietMs: number;
    lastTracked: number;
}

export function createBackdropState(): BackdropState {
    return {
        cards: new Map(), dirty: new Set(), applied: new WeakMap(), waiting: [], ready: [], decoding: new Map(), artwork: new Map(),
        unreadable: new Set(), tainting: new Set(), lingering: new Set(), detached: new WeakSet(),
        counters: { passes: 0, maxPassMs: 0, measures: 0, measureMs: 0, maxMeasureMs: 0, layoutMs: 0, cards: 0, reused: 0, slices: 0, sliceMs: 0, maxSliceMs: 0, decodes: 0, drawn: 0, plain: 0, pixelMs: 0, maxPixelMs: 0, failed: 0 },
        active: true, supported: null, generation: 0, quietMs: QUIET_MS, lastTracked: -Infinity,
    };
}

/** The painter modules' functions other modules call (through `fns`, filled in by createStatusTagBackdrop). */
export interface BackdropFns {
    markDirty(card: Card): void;
    watchArtwork(card: Card, container: Element | null, img: HTMLImageElement | null): void;
    measureAgainLater(card: Card, scaled?: boolean): void;
    originOf(url: string): string;
    markUnreadable(url: string): void;
    setBlur(host: HTMLElement, on: boolean): void;
    clear(carrier: HTMLElement): void;
    write(carrier: HTMLElement, layers: Layer[], base: Base | null): void;
    show(job: Job, drawn: Array<string[] | null>): void;
    scheduleSlice(): void;
    isSupported(): boolean;
    setActive(on: boolean): void;
}
