import { abortable } from './cancellation';
import { abortError, type ConcurrencyOptions } from './types';
interface Entry {
    promise: Promise<unknown>; controller: AbortController; limit: ConcurrencyOptions;
    subscribers: number; settled: boolean;
}
/** Each subscriber owns cancellation; only the last departure cancels shared transport. */
export function createDedup(controller: () => AbortController, promote: (options: ConcurrencyOptions) => void) {
    const entries = new Map<string, Entry>();
    function run(key: string, start: (signal: AbortSignal, limit: ConcurrencyOptions) => Promise<unknown>,
        signal: AbortSignal, priority: 'low' | 'normal'): Promise<unknown> {
        if (signal.aborted) return Promise.reject(abortError());
        let entry = entries.get(key);
        if (!entry || entry.controller.signal.aborted) {
            const ctl = controller();
            const limit: ConcurrencyOptions = { priority, signal: ctl.signal };
            // start runs synchronously so admitted transport retains the legacy immediate-start behavior.
            const promise = start(ctl.signal, limit);
            entry = { promise, controller: ctl, limit, subscribers: 0, settled: false };
            const created = entry;
            entries.set(key, created);
            const finish = () => { created.settled = true; if (entries.get(key) === created) entries.delete(key); };
            void promise.then(finish, finish);
        } else if (priority !== 'low') promote(entry.limit);
        const current = entry;
        current.subscribers++;
        let left = false;
        const leave = () => {
            if (left) return; left = true;
            signal.removeEventListener('abort', leave);
            current.subscribers--;
            if (current.subscribers === 0 && !current.settled) {
                if (entries.get(key) === current) entries.delete(key);
                current.controller.abort();
            }
        };
        signal.addEventListener('abort', leave, { once: true });
        return abortable(current.promise, signal).finally(leave);
    }
    return { run,
        forget(pattern = '') { for (const key of entries.keys()) if (key.includes(pattern)) entries.delete(key); }
    };
}
