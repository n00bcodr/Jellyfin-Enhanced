import type { PlayerBridge } from './host';
/** Each entry creates one owner. Importing this factory never creates shared state. */
export function createPlayerLifetime(JE: PlayerBridge, name: string) {
    let generation = 0;
    let controller = new AbortController();
    const cleanups = new Set<() => void>();
    const timers = new Set<number>();
    function reset() {
        generation++;
        controller.abort();
        controller = new AbortController();
        for (const cleanup of cleanups) cleanup();
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    }
    JE.session?.onUserChange(name + '-lifetime', reset);
    if (JE.core?.navigation) JE.core.navigation.onNavigate(reset);
    else window.addEventListener('hashchange', reset);
    // The callbacks above live for the script lifetime, once per ordered entry.
    function lease(video?: HTMLVideoElement | null) {
        const captured = generation, hash = location.hash;
        const session = JE.session?.createLease?.();
        const source = video ? video.currentSrc || video.src : null;
        return { signal: controller.signal, current: () => captured === generation && hash === location.hash
            && (!session || session.isCurrent())
            && (!video || (video.isConnected && (video.currentSrc || video.src) === source)) };
    }
    return {
        lease, reset,
        onReset(cleanup: () => void) { cleanups.add(cleanup); return () => cleanups.delete(cleanup); },
        timeout(callback: () => void, delay: number) {
            const id = window.setTimeout(() => { timers.delete(id); callback(); }, delay);
            timers.add(id); return id;
        },
        cancel(id: number | null | undefined) { if (id != null) { clearTimeout(id); timers.delete(id); } },
        sleep(delay: number, signal: AbortSignal): Promise<void> {
            return new Promise(resolve => {
                if (signal.aborted) { resolve(); return; }
                const done = () => { clearTimeout(id); signal.removeEventListener('abort', done); resolve(); };
                const id = window.setTimeout(done, delay);
                signal.addEventListener('abort', done, { once: true });
            });
        }
    };
}
export type PlayerLifetime = ReturnType<typeof createPlayerLifetime>;
