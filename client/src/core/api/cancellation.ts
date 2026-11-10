import { abortError, type ApiDependencies } from './types';
/** Compose cancellation without shortening the lifetime of a streaming response. */
export function cancellation(deps: ApiDependencies, signals: readonly (AbortSignal | null | undefined)[], timeoutMs?: number) {
    const controller = deps.controller();
    // Native signal composition keeps cancellation connected through a Response's
    // streaming body, even after retryFetch returns its headers. The browser owns
    // these weak dependency links; there are no manual upstream listeners to leak
    // or detach too early. Dispose releases only this operation's deadline timer.
    const inputs: AbortSignal[] = [controller.signal];
    for (const signal of signals) if (signal) inputs.push(signal);
    const signal = deps.combineSignals(inputs);
    const timer = timeoutMs && timeoutMs > 0 ? deps.setTimer(() => controller.abort(), timeoutMs) : undefined;
    return { controller, signal,
        dispose() {
            if (timer !== undefined) deps.clearTimer(timer);
        }
    };
}
/** Reject promptly, but keep handlers on the underlying promise to consume late failures. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', onAbort); if (signal.aborted) reject(abortError()); else resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
}
