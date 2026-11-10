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
    };
    tagPosterColours?: Pick<PosterColours, 'track' | 'release'>;
    session?: {
        onUserChange?(name: string, callback: () => void): unknown;
    };
    t(key: string, values?: {
        tags: string;
    }): string;
}
