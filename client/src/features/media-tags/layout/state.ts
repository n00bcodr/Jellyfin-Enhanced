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
export function childrenOf(element: Element): HTMLElement[] { return Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement); }
export function cloneElement(element: HTMLElement): HTMLElement { const clone = element.cloneNode(true); if (!(clone instanceof HTMLElement))
    throw new Error('Expected an HTML tag'); return clone; }

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
}
