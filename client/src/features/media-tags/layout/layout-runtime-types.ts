import type { LayoutDocument, Layout, Group } from './layout-rules';
import type { TagLook } from './tag-look';
import type { PosterColours } from './poster-colours';
export interface CardController {
    host: HTMLElement;
    itemId: string;
    groups: Map<Group, {
        master: HTMLElement;
        seq: number;
    }>;
    nodes: Map<Group, HTMLElement[]>;
    outlet: HTMLElement | null;
    pill: HTMLElement | null;
    layout: Layout | null;
    seq: number;
    arrived?: Map<Group, number>;
    narrow?: boolean;
    moreTip?: HTMLElement | null;
    described?: HTMLElement | null;
    lookKey: string;
    pendingPresentation?: boolean;
    shape: string | null;
    /** It is to be fitted again when the state it is waited out of ends (snap.ts snapLater). */
    refit?: boolean;
    /** Elements of the card the page's CSS moves or makes a layer (flow.ts layeredFlow). */
    layered: Set<HTMLElement>;
    /** The kinds of slot the card holds now (flow.ts laidOutAlike). */
    kinds: string;
    /** The kinds it held when it was last let into flow. */
    flowKinds: string;
}
export interface LayoutHost {
    currentSettings?: LayoutDocument & {
        tagsHideOnHover?: unknown;
    };
    pluginConfig?: LayoutDocument;
    core: {
        tagLook?: TagLook | undefined;
        ui?: {
            injectCss(id: string, css: string): unknown;
        };
        dom?: {
            afterNextPaint(callback: () => void): unknown;
        };
        tagRenderer?: {
            isIgnoredContext(host: HTMLElement): boolean;
        };
        tagScopes?: {
            excludes(group: string, element: HTMLElement): boolean;
        };
        /** Hidden tags (pipeline/tag-hidden.ts), read at call time. */
        tagHidden?: Pick<import('../pipeline/tag-hidden').TagHidden, 'any' | 'hides' | 'hidesAgeRating'> | undefined;
        /** Tag text (pipeline/tag-text.ts), read at call time. */
        tagText?: import('../pipeline/tag-text').TagText | undefined;
    };
    tagPosterColours?: Pick<PosterColours, 'track' | 'release'>;
    /** The status-tag backdrop painter (types/status/backdrop/), once its group has loaded. */
    statusTagBackdrop?: { resume?(host: HTMLElement): void };
    session?: {
        onUserChange?(name: string, callback: () => void): unknown;
    };
    t(key: string, values?: {
        tags: string;
    }): string;
}
