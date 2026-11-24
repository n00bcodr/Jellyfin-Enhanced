import type { Ui } from '../core/ui/runtime';
import type { FeatureContextCore } from './context';

export interface ThemeVariables { secondaryBg?: string; primaryAccent?: string; blur?: string }
export interface UiBridge {
    core?: { ui?: Ui } & FeatureContextCore;
    CONFIG?: { TOAST_DURATION?: number };
    themer?: { getThemeVariables(): ThemeVariables | null | undefined };
    escapeHtml?: Ui['escapeHtml'];
    toast?: Ui['toast'];
}
export interface UiHost {
    document: Document;
    now(): number;
    /** performance.now(): unaffected by clock changes. */
    monotonicNow(): number;
    setTimeout(callback: () => void, delay: number): number;
    /** A keydown listener on window in the capture phase; the returned function removes it. */
    onKeydownCapture(listener: (event: KeyboardEvent) => void): () => void;
    toastDuration(): number | undefined;
    themeVariables(): ThemeVariables;
    contains(parent: EventTarget | null, child: EventTarget): boolean;
    isElement(target: EventTarget | null): target is Element;
    log(message: string): void;
}
/** Narrow legacy bridge; unrelated feature fields remain owned by their modules. */
export function uiBridge(): UiBridge {
    const host: Window & { JellyfinEnhanced?: UiBridge } = window;
    if (!host.JellyfinEnhanced) throw new Error('Jellyfin Enhanced must be initialized before UI core');
    return host.JellyfinEnhanced;
}
export function browserUiHost(bridge: UiBridge): UiHost {
    return {
        document,
        now: () => Date.now(),
        monotonicNow: () => window.performance.now(),
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        onKeydownCapture: listener => {
            window.addEventListener('keydown', listener, true);
            return () => window.removeEventListener('keydown', listener, true);
        },
        toastDuration: () => bridge.CONFIG?.TOAST_DURATION,
        themeVariables: () => bridge.themer?.getThemeVariables() ?? {},
        contains: (parent, child) => parent instanceof Node && child instanceof Node && parent.contains(child),
        isElement: (target): target is Element => target instanceof Element,
        log: message => console.log(`🪼 Jellyfin Enhanced: ${message}`)
    };
}
