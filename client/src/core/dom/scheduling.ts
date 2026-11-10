/** Timer ownership is per runtime instance, never module-global across IIFEs. */
export interface PaintClock {
    setTimeout(callback: () => void, delay: number): number;
    clearTimeout(id: number): void;
    requestFrame(callback: () => void): number;
    cancelFrame(id: number): void;
    report(context: string, error: unknown): void;
}
/** Coalesce callers into one frame/timer pair; hidden tabs still drain after 250ms. */
export function createPaintQueue(clock: PaintClock) {
    let queue: Array<() => void> = [];
    let scheduled = false;
    return (callback: () => void): void => {
        queue.push(callback);
        if (scheduled) return;
        scheduled = true;
        let done = false;
        let afterFrame: number | undefined;
        const run = () => {
            if (done) return;
            done = true;
            clock.clearTimeout(fallback);
            clock.cancelFrame(frame);
            if (afterFrame !== undefined) clock.clearTimeout(afterFrame);
            scheduled = false;
            const batch = queue;
            queue = [];
            for (const fn of batch) {
                try { fn(); } catch (error) { clock.report('Error in afterNextPaint callback:', error); }
            }
        };
        const fallback = clock.setTimeout(run, 250);
        const frame = clock.requestFrame(() => { if (!done) afterFrame = clock.setTimeout(run, 0); });
    };
}

export interface Subscription<Record> {
    callback(records: Record[]): void;
    priority: number;
}
/** Pure dispatch state: snapshot membership, replacement identity and teardown epoch. */
export function createBodyDispatch<Record>(afterPaint: (callback: () => void) => void,
    report: (id: string, error: unknown) => void) {
    const subscribers = new Map<string, Subscription<Record>>();
    let pending: Record[] = [];
    let starts = new Map<Subscription<Record>, number>();
    let scheduled = false;
    let generation = 0;
    const invoke = (id: string, sub: Subscription<Record>, records: Record[]) => {
        try { sub.callback(records); } catch (error) { report(id, error); }
    };
    const reset = () => { generation++; pending = []; starts.clear(); scheduled = false; };
    return {
        subscribers,
        reset,
        dispatch(records: Record[]) {
            const epoch = generation;
            const snapshot = [...subscribers].sort((a, b) => b[1].priority - a[1].priority);
            for (const [id, sub] of snapshot) {
                if (epoch !== generation) return;
                if (subscribers.get(id) !== sub) continue;
                if (sub.priority > 0) invoke(id, sub, records);
                else {
                    // Keep one mutation buffer for the multiplexed observer. A new
                    // subscription only sees the suffix captured during its lifetime.
                    if (!starts.has(sub)) starts.set(sub, pending.length);
                }
            }
            if (epoch !== generation || starts.size === 0) return;
            for (const record of records) pending.push(record);
            if (scheduled) return;
            scheduled = true;
            afterPaint(() => {
                if (epoch !== generation) return;
                scheduled = false;
                const batch = pending;
                const offsets = starts;
                pending = [];
                starts = new Map();
                for (const [id, sub] of [...subscribers].sort((a, b) => b[1].priority - a[1].priority)) {
                    if (epoch !== generation) return;
                    const start = offsets.get(sub);
                    if (subscribers.get(id) === sub && start !== undefined) {
                        invoke(id, sub, start === 0 ? batch : batch.slice(start));
                    }
                }
            });
        }
    };
}
