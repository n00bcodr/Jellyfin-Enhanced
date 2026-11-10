import type { SpoilerHost } from './host';
/** Each installed component owns its listeners and timers; state.ts alone owns policy state. */
export function own(JE: SpoilerHost, name: string, navigation = true) {
    let controller = new AbortController();
    let disposed = false;
    const resources = new Set<() => void>();
    function reset() {
        controller.abort();
        controller = new AbortController();
        for (const dispose of resources) dispose();
        resources.clear();
    }
    const unregister = JE.session?.onUserChange(`spoilerguard-${name}-ownership`, reset);
    const life = JE.core?.lifecycle?.register(`spoiler-guard-${name}`);
    if (navigation) life?.teardownOn('navigate');
    life?.onTeardown(reset);
    function lease() {
        const signal = controller.signal;
        const epoch = JE.session?.getEpoch();
        const sessionLease = JE.session?.createLease?.();
        const current = () => !disposed && !signal.aborted && (sessionLease ? sessionLease.isCurrent() : epoch === undefined || JE.session?.isCurrent(epoch) === true);
        return { signal, current, check() { if (!current()) throw new DOMException('Stale Spoiler Guard operation', 'AbortError'); } };
    }
    function track(dispose: () => void) { resources.add(dispose); return () => { resources.delete(dispose); dispose(); }; }
    function later(callback: () => void, ms: number) {
        const token = lease();
        const timer = window.setTimeout(() => { resources.delete(cancel); if (token.current()) callback(); }, ms);
        const cancel = () => window.clearTimeout(timer);
        resources.add(cancel);
        return () => { resources.delete(cancel); cancel(); };
    }
    function listen(target: EventTarget, event: string, callback: EventListener, capture = false) {
        target.addEventListener(event, callback, capture);
        return track(() => target.removeEventListener(event, callback, capture));
    }
    return { lease, reset, track, later, listen, dispose() { disposed = true; reset(); unregister?.(); } };
}
export type Ownership = ReturnType<typeof own>;
