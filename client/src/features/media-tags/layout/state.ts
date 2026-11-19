import type * as rules from './layout-rules';
import { LAYOUT_SLOTS, type Group, type LayoutDocument, type LayoutSettings, type ShapeLook } from './layout-rules';
import type { CardController } from './layout-runtime-types';
import type { TagLayout } from './tag-layout';
import type { LayoutLock, LookRule, TagLook } from './tag-look';

export interface FitRow {
    slot: HTMLElement;
    chips: HTMLElement[];
    shown: boolean[];
    more: boolean;
    width?: number | undefined;
    firstWidth?: number | undefined;
    fittedRows?: number[];
    fittedMoreRow?: number;
}
export interface FitPlan {
    pillFacts: number;
    rows: FitRow[];
    indicator: {
        el: HTMLElement;
        before: number | null;
    }[];
    stacks: {
        chip: HTMLElement;
        width: number;
    }[];
    lift: {
        slot: HTMLElement;
        lift: number;
        hidden: HTMLElement[];
    } | null;
}
export type PreviewLook = ShapeLook & {
    shapes?: import('./layout-rules').ShapeOverrides | null;
    locked?: boolean;
};
export type CardContext = CardController | HTMLElement | {
    itemId?: string;
    cardType?: string | null;
    shape?: string;
    Type?: string;
    Genres?: unknown;
    OfficialRating?: unknown;
    LibraryId?: unknown;
    SeriesId?: unknown;
} | null | undefined;
export function contextElement(context: CardContext): HTMLElement | null { return context instanceof HTMLElement ? context : context && 'host' in context ? context.host : null; }
export function childrenOf(element: Element): HTMLElement[] {
    const children: HTMLElement[] = [];
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) { if (child instanceof HTMLElement) children.push(child); }
    return children;
}
export function cloneElement(element: HTMLElement): HTMLElement { const clone = element.cloneNode(true); if (!(clone instanceof HTMLElement))
    throw new Error('Expected an HTML tag'); return clone; }

/**
 * A card's sizes as the size observer and the fitting pass saw them (fit-measure.ts watchSize).
 * `snapWidth` and `snapHeight` are the size the whole-pixel pass last measured the card at (snap.ts noteSnapSize;
 * undefined: it never did); `boxWidth` and `boxHeight` the border box as last observed (snap.ts scaled).
 */
export interface FittedSize {
    observed: number;
    observedHeight: number;
    fitted: number;
    fittedHeight: number;
    measured: { width: number; height: number } | null;
    snapWidth?: number | undefined;
    snapHeight?: number | undefined;
    boxWidth?: number | undefined;
    boxHeight?: number | undefined;
}

/** Counts of the idle pass's questions and of the whole-pixel pass (performance checks and tests). */
export interface FlowCounters { probes: number; inspections: number }
export interface SnapCounters { passes: number; cards: number; moved: number; deferred: number; passMs: number; held: number }

/** A size that differs by less than this is the same size (CSS px; a layout unit is several times this on any screen). */
export const SNAP_SAME_PX = 0.002;

/** How long after the pointer leaves a card its host goes back to flow: past the genre names' 0.12s fade (live.ts). */
export const REST_AFTER_MS = 200;

export const STACK_INSET = 6;
export const STACK_LIFT = '--je-stack-lift';
export const INDICATOR_BEFORE = '--je-indicator-before';

/** The layout's mutable state, shared by every module (one object per createTagLayout call). */
export interface LayoutState {
    readonly SLOT_ORDER: string[];
    readonly PORTRAIT_CARD: RegExp;
    readonly LANDSCAPE_CARD: RegExp;
    readonly CONTAINER_CLASS: { quality: string; genre: string; language: string; rating: string; ageRating: string; status: string; awards: string; logos: string; custom: string; };
    readonly SUMMARY_SLOTS: Set<string>;
    readonly FIT_LAYOUTS: Set<string>;
    readonly CENTRE_SLOTS: Set<string>;
    readonly STACK_SLOTS: Partial<Record<string, string[]>>;
    readonly DYNAMIC_RANGE: string[];
    readonly DOT_KIND: string[][];
    cachedSettings: LayoutSettings | null;
    cachedSource: ReturnType<LayoutFns['settingsSource']> | null;
    cachedLooks: ReturnType<import('./tag-look').TagLook['read']> | null;
    // ── Card context ───────────────────────────────────────────────────
    readonly controllers: WeakMap<HTMLElement, CardController>;
    cardData: WeakMap<HTMLElement, {
        entry: unknown;
        itemId: string;
        cardId: string;
    }>;
    awaitingData: WeakMap<HTMLElement, {
        cardId: string;
        timer: number;
        token: {
            cardId: string;
            generation: number;
        };
    }>;
    waitGeneration: number;
    outletSeq: number;
    stylesInjected: boolean;
    resizeQueued: boolean;
    readonly pendingFit: Set<CardController>;
    fitScheduled: boolean;
    fitting: boolean;
    sizeObserver: ResizeObserver | null;
    readonly genreAfterFit: Set<HTMLElement>;
    revealedCard: HTMLElement | null;
    moreTipSeq: number;
    reinitPending: Promise<void> | null;
    // ── Resting flow and whole pixels (upstream abcaa16d: flow.ts, flow-idle.ts, live.ts, snap*.ts) ──
    readonly fittedWidths: WeakMap<HTMLElement, FittedSize>;
    /** Kind of slot → whether the browser lays it out in flow exactly as positioned. */
    readonly flowAlike: Map<string, boolean>;
    /** Kind of element → whether the page's CSS makes it a layer of its own. */
    readonly flowVerdicts: Map<string, boolean>;
    /** Goes up whenever what was learnt of the page's CSS is forgotten: elements inspected under an older number are inspected again. */
    flowEpoch: number;
    /** Cards holding a kind of slot the browser has not been asked about, cards another card's answer freed, cards to measure for whole pixels. */
    readonly pendingAlike: Set<CardController>;
    readonly pendingFreed: Set<CardController>;
    readonly pendingSnap: Set<CardController>;
    /** Cards that had no size when their layout was to be decided: decided when they get one. */
    readonly unmeasured: WeakSet<CardController>;
    /** Hosts due back in flow after the pointer left (live.ts restLater), and a live host found still hovered when it was due. */
    readonly restTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>>;
    lingering: HTMLElement | null;
    /** The host of the card the pointer last left, and when (performance.now()): its slots ease back for a moment. */
    readonly lastLeft: { host: HTMLElement | null; at: number };
    /** Hosts whose slots were fading when they were to be inspected: looked at when the pointer has left. */
    readonly uninspected: WeakSet<HTMLElement>;
    /** Layout pixels per CSS pixel: the grid boxes are snapped to. 0 until the browser has said (snap.ts watchScale). */
    layoutScale: number;
    readonly flowCounters: FlowCounters;
    readonly snapCounters: SnapCounters;
}

/**
 * The initial state: the same initial values, in the same order, as the variables it replaces.
 */
export function createLayoutState(): LayoutState {
    return {
        SLOT_ORDER: [...new Set(Object.values(LAYOUT_SLOTS).flat().filter((slot) => slot !== 'off'))],
        PORTRAIT_CARD: /^(?:overflow)?(?:portrait|square)card$/i,
        LANDSCAPE_CARD: /^(?:overflow)?(?:backdrop|smallbackdrop|banner|thumb)card$/i,
        CONTAINER_CLASS: {
            quality: 'quality-overlay-container',
            genre: 'genre-overlay-container',
            language: 'language-overlay-container',
            rating: 'rating-overlay-container',
            ageRating: 'age-rating-overlay-container',
            status: 'status-overlay-container',
            awards: 'awards-overlay-container',
            logos: 'logo-overlay-container',
            custom: 'custom-overlay-container',
        },
        SUMMARY_SLOTS: new Set(['pill', 'dots', 'corner']),
        FIT_LAYOUTS: new Set(['bands', 'caption', 'summary', 'minimal']),
        CENTRE_SLOTS: new Set(['tc', 'bc', 'ml', 'mr', 'c']),
        STACK_SLOTS: { minimal: ['top', 'corner'], caption: ['poster'] },
        DYNAMIC_RANGE: ['Dolby Vision', 'HDR10+', 'HDR10', 'HLG', 'HDR'],
        DOT_KIND: [
            ['resolution', 'resolution'],
            ['video-codec', 'range'],
            ['audio-codec', 'audio'],
            ['video-format', 'codec'],
            ['other-quality', 'codec'],
        ],
        cachedSettings: null,
        cachedSource: null,
        cachedLooks: null,
        controllers: new WeakMap(),
        cardData: new WeakMap(),
        awaitingData: new WeakMap(),
        waitGeneration: 0,
        outletSeq: 0,
        stylesInjected: false,
        resizeQueued: false,
        pendingFit: new Set(),
        fitScheduled: false,
        fitting: false,
        sizeObserver: null,
        genreAfterFit: new Set(),
        revealedCard: null,
        moreTipSeq: 0,
        reinitPending: null,
        fittedWidths: new WeakMap(),
        flowAlike: new Map(),
        flowVerdicts: new Map(),
        flowEpoch: 1,
        pendingAlike: new Set(),
        pendingFreed: new Set(),
        pendingSnap: new Set(),
        unmeasured: new WeakSet(),
        restTimers: new WeakMap(),
        lingering: null,
        lastLeft: { host: null, at: 0 },
        uninspected: new WeakSet(),
        layoutScale: 0,
        flowCounters: { probes: 0, inspections: 0 },
        snapCounters: { passes: 0, cards: 0, moved: 0, deferred: 0, passMs: 0, held: 0 },
    };
}

/** The layout modules' functions and values other modules call (through `deps`), and the published api. */
export interface LayoutFns {
    api: TagLayout;
    applyChipRows: (rows: FitPlan["rows"]) => string[];
    applyFit: (ctrl: CardController, plan: FitPlan) => void;
    applySize: (element: HTMLElement, conf: LayoutSettings) => void;
    awaitCardContext: (target: HTMLElement, cardId: string, cardType: string | null) => false | { cardId: string; generation: number; };
    captionAnchor: (host: HTMLElement) => { parent: HTMLElement; before: Element; } | null;
    cardIdentity: (target: HTMLElement) => string;
    cardLinkOf: (host: HTMLElement) => HTMLElement | null;
    chipLabel: (chip: HTMLElement) => string;
    clearAll: () => void;
    clearCard: (target: HTMLElement) => void;
    commitGroup: (target: HTMLElement, groupId: string, overlay: HTMLElement) => boolean;
    contextOf: <T>(map: WeakMap<HTMLElement, T>, el: HTMLElement) => T | undefined;
    controllerFor: (target: HTMLElement, create: boolean) => CardController | null;
    currentLooks: () => { rules: LookRule[]; locks: Map<string, LayoutLock>; overrides: Map<string, LayoutLock>; };
    currentSettings: () => rules.LayoutSettings;
    describe: (target: HTMLElement) => { group: rules.Group; slot: string; seq: number; element: HTMLElement | null; }[];
    describeHidden: (ctrl: CardController, names: string[]) => void;
    endAwait: (el: HTMLElement) => boolean;
    ensureHost: (target: HTMLElement) => HTMLElement | null;
    findHost: (target: HTMLElement) => HTMLElement | null;
    fitReveal: (host: HTMLElement | null | undefined) => void;
    flushFit: () => void;
    forget: (ctrl: CardController) => void;
    getGroup: (target: HTMLElement, groupId: string) => HTMLElement | null;
    hasGroup: (target: HTMLElement, groupId: string) => boolean;
    holdsGroups: (slotEl: Element) => boolean;
    injectStyles: () => void;
    invalidateSettings: () => void;
    isAwaiting: (host: HTMLElement) => boolean;
    isIgnoredContext: (host: HTMLElement) => boolean;
    isLegacySettings: (settings?: LayoutDocument | null) => boolean;
    isRevealed: (host: HTMLElement) => boolean;
    lookSettings: (base: LayoutSettings, look: ShapeLook, locked: boolean) => rules.LayoutSettings;
    lookSource: (cardContext: CardContext) => { source: string; lock: null; rule: null; index: number; shape: string; } | { source: string; lock: PreviewLook; rule: null; index: number; shape: string; } | { source: string; lock: LayoutLock; rule: null; index: number; shape: string; } | { source: string; lock: null; rule: LookRule; index: number; shape: string; };
    moreChipOf: (slotEl: HTMLElement) => HTMLElement | null;
    normalizeSettings: (settings?: LayoutDocument | null, plugin?: LayoutDocument | null) => rules.LayoutSettings;
    posterStack: (ctrl: CardController) => HTMLElement[];
    prepareCard: (target: HTMLElement) => void;
    prepareFitText: (first: HTMLElement) => void;
    presentAll: (ctrl: CardController) => void;
    presentGroup: (ctrl: CardController, conf: LayoutSettings, group: Group) => void;
    promoteLegacySettings: (settings?: LayoutDocument | null) => boolean;
    refreshPill: (ctrl: CardController, conf: LayoutSettings) => void;
    refreshPresentation: (targets?: HTMLElement | HTMLElement[]) => void;
    reinitialize: () => Promise<void>;
    releaseCardContext: (target: HTMLElement, token: { cardId: string; generation: number; }) => void;
    removeGroup: (target: HTMLElement, groupId: string) => void;
    removeGroupEverywhere: (groupId: string) => void;
    removeNodes: (ctrl: CardController, group: Group) => void;
    requireLook: () => TagLook;
    reservesCaption: (conf: LayoutSettings, el: HTMLElement) => boolean;
    resolveLayout: (cardContext: CardContext) => rules.LayoutSettings;
    resumePresentation: (target: HTMLElement) => void;
    scheduleFit: (ctrl: CardController) => void;
    setCardContext: (target: HTMLElement, entry: unknown, itemId: string, cardId?: string) => boolean;
    setPreviewLook: (target: HTMLElement, look: PreviewLook | null) => void;
    settingsSource: () => { settings: (rules.LayoutDocument & { tagsHideOnHover?: unknown; }) | undefined; plugin: rules.LayoutDocument | undefined; enabled: string; };
    shapeOf: (cardContext: CardContext) => string;
    shapeOfCard: (el: Element | null) => "landscape" | "list" | "portrait" | null;
    shapesInUse: () => boolean;
    singleChipGroup: (group: Group, config?: rules.LayoutDocument | undefined) => boolean;
    syncIndicatorGap: (ctrl: CardController, conf: LayoutSettings) => void;
    teardown: (ctrl: CardController) => void;
    unwatchSize: (host: HTMLElement) => void;
    // ── Resting flow and whole pixels (upstream abcaa16d) ──
    watchSize: (host: HTMLElement) => void;
    edgeOf: (ctrl: CardController) => number;
    forgetPageCss: () => void;
    flowFor: (ctrl: CardController, conf: LayoutSettings, read?: boolean) => boolean | null;
    syncFlow: (ctrl: CardController, conf: LayoutSettings) => void;
    decideFlow: (ctrl: CardController, conf: LayoutSettings) => boolean | null;
    markFlow: (ctrl: CardController, flow: boolean, measure?: boolean) => void;
    layeredFlow: (ctrl: CardController, conf: LayoutSettings, read: boolean, fresh?: Set<string>) => boolean | null;
    measurableKinds: (ctrl: CardController, conf: LayoutSettings) => Array<[HTMLElement, string]>;
    awaitSize: (ctrl: CardController) => void;
    awaitImages: (ctrl: CardController) => void;
    imagesLoading: (slot: Element) => boolean;
    queueReprobe: () => void;
    inspectLater: (ctrl: CardController, hovered: boolean) => void;
    queueFlow: (ctrl: CardController) => void;
    queueIdle: () => void;
    flushAlike: (cards?: CardController[]) => number;
    snapSupported: () => boolean;
    snapReady: () => boolean;
    scheduleSnap: (ctrl: CardController, settle?: boolean) => void;
    unsnap: (ctrl: CardController) => void;
    snapAgain: (ctrl: CardController) => void;
    snapLater: (ctrl: CardController) => void;
    measureSnap: (cards?: CardController[]) => import('./snap').SnapPlan[] | null;
    applySnap: (plans: import('./snap').SnapPlan[]) => void;
    flushSnap: () => void;
    watchFonts: () => void;
    bandNudges: (slot: HTMLElement, origin: { x: number; y: number }, items: import('./snap').SnapItem[]) => Array<{ vx: number; left: number } | null>;
    watchBand: (slot: HTMLElement) => void;
    noteBandWrite: (slot: Element) => void;
    bandHeld: (slot: Element) => boolean;
    goLive: (host: HTMLElement | null) => boolean;
    showNames: (host: HTMLElement) => void;
    restLater: (card: Element) => void;
    notAtRest: (host: HTMLElement) => boolean;
    hidesOnHover: (host: HTMLElement | null) => boolean;
    releaseScale: () => void;
    releaseBands: () => void;
}
