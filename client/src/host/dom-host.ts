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
    const noise = '.osdPositionText, .osdDurationText, .startTimeText, .endTimeText, .endsAtText, .videoSubtitlesInner, .videoSecondarySubtitlesInner';
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
