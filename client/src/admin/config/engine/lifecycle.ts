/** Anything with a disconnect: observers. */
interface Disconnectable { disconnect(): void }

/** Owns everything one mount of the page registers, and releases it together. */
export class MountLifecycle {
    readonly #controller = new AbortController();
    readonly #timers = new Set<number>();
    readonly #intervals = new Set<number>();
    readonly #frames = new Set<number>();
    readonly #observers = new Set<Disconnectable>();
    readonly #cleanups = new Set<() => void>();

    get signal(): AbortSignal { return this.#controller.signal; }
    get disposed(): boolean { return this.#controller.signal.aborted; }

    track<T extends Disconnectable>(observer: T): T {
        this.#observers.add(observer);
        if (this.disposed) observer.disconnect();
        return observer;
    }

    /** A timer that never fires after disposal. */
    timeout(callback: () => void, delay: number): number {
        if (this.disposed) return 0;
        const id = window.setTimeout(() => { this.#timers.delete(id); callback(); }, delay);
        this.#timers.add(id);
        return id;
    }

    interval(callback: () => void, delay: number): number {
        if (this.disposed) return 0;
        const id = window.setInterval(callback, delay);
        this.#intervals.add(id);
        return id;
    }

    frame(callback: () => void): number {
        if (this.disposed) return 0;
        const id = window.requestAnimationFrame(() => { this.#frames.delete(id); callback(); });
        this.#frames.add(id);
        return id;
    }

    onDispose(cleanup: () => void): void {
        if (this.disposed) cleanup();
        else this.#cleanups.add(cleanup);
    }

    dispose(): void {
        if (this.disposed) return;
        this.#controller.abort();
        this.#timers.forEach(id => window.clearTimeout(id));
        this.#intervals.forEach(id => window.clearInterval(id));
        this.#frames.forEach(id => window.cancelAnimationFrame(id));
        this.#observers.forEach(observer => observer.disconnect());
        this.#cleanups.forEach(cleanup => cleanup());
        this.#timers.clear();
        this.#intervals.clear();
        this.#frames.clear();
        this.#observers.clear();
        this.#cleanups.clear();
    }
}
