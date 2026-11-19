import type { Dom } from '../core/dom/runtime';
import type { PaintClock } from '../core/dom/scheduling';

export interface DomHost extends PaintClock {
    document: Document;
    createObserver(callback: MutationCallback): MutationObserver;
    isStructuralChange(record: MutationRecord): boolean;
    isBodyTarget(node: Node): boolean;
    onUnload(callback: () => void): void;
    warn(context: string, error?: unknown): void;
}
export interface DomBridge { core?: { dom?: Dom } }
/** Narrow legacy boundary; does not replace or enumerate other core members. */
export function domBridge(): DomBridge {
    const host: Window & { JellyfinEnhanced?: DomBridge } = window;
    if (!host.JellyfinEnhanced) throw new Error('Jellyfin Enhanced must be initialized before DOM core');
    return host.JellyfinEnhanced;
}
export function browserDomHost(): DomHost {
    // The player's clock and subtitle cue nodes, and a card's tag host (.je-tag-host): it holds
    // nothing but the tag chips JE itself draws, and they keep changing on a settled page (a
    // status badge lands when a lookup answers as its card scrolls into view, a live pass swaps
    // one). No subscriber looks inside a host, yet each of those writes used to wake every
    // subscriber after the next paint (tab and sidebar watchers, header layout, a full card
    // scan). The host itself being added to or removed from a card is still reported: its
    // record's target is the card.
    const noise = '.osdPositionText, .osdDurationText, .startTimeText, .endTimeText, .endsAtText, .videoSubtitlesInner, .videoSecondarySubtitlesInner, .je-tag-host';
    return {
        document,
        createObserver: callback => new MutationObserver(callback),
        isStructuralChange: record => (record.addedNodes.length > 0 || record.removedNodes.length > 0) &&
            !(record.target instanceof Element && record.target.closest(noise)),
        isBodyTarget: node => node === document.body || node === document.documentElement || node === document,
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: id => window.clearTimeout(id),
        requestFrame: callback => window.requestAnimationFrame(callback),
        cancelFrame: id => window.cancelAnimationFrame(id),
        onUnload: callback => window.addEventListener('beforeunload', callback),
        report: (context, error) => console.error(`🪼 Jellyfin Enhanced: ${context}`, error),
        warn: (context, error) => console.warn(`🪼 Jellyfin Enhanced: ${context}`, error)
    };
}
