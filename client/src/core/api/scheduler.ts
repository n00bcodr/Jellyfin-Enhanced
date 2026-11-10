import { abortError, type ApiConfig, type ConcurrencyOptions, type Priority } from './types';
interface Queued {
    options: ConcurrencyOptions; enqueuedAt: number;
    start(lane: Priority): void; cancel(): void;
}
/** One scheduler instance owns all slots, including reservations awaiting a microtask. */
export function createScheduler(config: ApiConfig['concurrency'], now: () => number,
    recordWait: (priority: Priority, waitMs: number) => void) {
    let active = 0, activeLow = 0;
    const normal: Queued[] = [], low: Queued[] = [], stale: Queued[] = [];
    const queues = [normal, low, stale];
    const cap = () => normal.length === 0 && active === activeLow
        ? Math.max(config.maxLowConcurrent, config.maxConcurrent - 1) : config.maxLowConcurrent;
    function drain(): void {
        while (active < config.maxConcurrent) {
            let lane: Priority = 'normal';
            let next = normal.shift();
            if (!next) {
                if (activeLow >= cap()) break;
                next = low.shift() || stale.shift(); lane = 'low';
            }
            if (!next) break;
            active++; if (lane === 'low') activeLow++;
            recordWait(lane, now() - next.enqueuedAt); next.start(lane);
        }
    }
    function enqueue(options: ConcurrencyOptions): Promise<Priority> {
        const decorative = options.priority === 'low';
        const queue = decorative ? low : normal;
        const size = decorative ? low.length + stale.length : normal.length;
        if (size >= (decorative ? config.maxLowQueueSize : config.maxQueueSize)) {
            const evicted = decorative ? stale.shift() : undefined;
            if (!evicted) return Promise.reject(new Error('Request queue full - too many pending requests'));
            evicted.cancel();
        }
        return new Promise((resolve, reject) => {
            const signal = options.signal;
            const onAbort = () => {
                for (const list of queues) {
                    const index = list.indexOf(entry); if (index >= 0) list.splice(index, 1);
                }
                entry.cancel(); drain();
            };
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const entry: Queued = { options, enqueuedAt: now(),
                start(lane) { cleanup(); resolve(lane); },
                cancel() { cleanup(); reject(abortError()); }
            };
            if (signal?.aborted) { entry.cancel(); return; }
            signal?.addEventListener('abort', onAbort, { once: true }); queue.push(entry);
        });
    }
    async function run<T>(fn: () => Promise<T>, options: ConcurrencyOptions = {}): Promise<T> {
        if (options.signal?.aborted) throw abortError();
        let lane: Priority = options.priority === 'low' ? 'low' : 'normal';
        if (active < config.maxConcurrent && normal.length === 0 &&
            (lane === 'normal' || (low.length === 0 && activeLow < cap()))) {
            active++; if (lane === 'low') activeLow++;
        } else lane = await enqueue(options);
        try {
            // Cancellation can happen after a slot is reserved but before this continuation.
            if (options.signal?.aborted) throw abortError();
            return await fn();
        } finally { active--; if (lane === 'low') activeLow--; drain(); }
    }
    function promote(options: ConcurrencyOptions): void {
        if (options.priority !== 'low') return;
        options.priority = 'normal';
        for (const queue of [low, stale]) {
            const index = queue.findIndex(entry => entry.options === options);
            if (index < 0) continue;
            const entry = queue.splice(index, 1)[0];
            if (entry) normal.push(entry);
            drain(); return;
        }
    }
    return { run, promote,
        demote() { stale.push(...low.splice(0)); },
        cancelAll() { for (const queue of queues) for (const entry of queue.splice(0)) entry.cancel(); }
    };
}
