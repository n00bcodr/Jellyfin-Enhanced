import { createBodyDispatch, createPaintQueue } from './scheduling';
import type { DomHost } from '../../host/dom-host';

export interface SubscriptionHandle { unsubscribe(): void; disconnect(): void }
export interface ObserverHandle {
    disconnect(): void;
    /** Shared body handles also retain the subscription spelling. */
    unsubscribe?: () => void;
    observe(target: Node, config?: MutationObserverInit): void;
    takeRecords(): MutationRecord[];
}
export interface WaitOptions {
    timeout?: number;
    /** Queried root; only structural changes below document.body retrigger the wait. */
    root?: ParentNode;
    predicate?: (element: Element) => boolean;
    quiet?: boolean;
    /** Cancellation resolves null, like timeout and global observer teardown. */
    signal?: AbortSignal;
}
type BodyCallback = (records: MutationRecord[]) => void;
interface Owner { disconnect(): void; managed: boolean }

/** Owns the compatibility facade; browser effects are supplied by the host adapter. */
export function createDom(host: DomHost) {
    const afterNextPaint = createPaintQueue(host);
    const body = createBodyDispatch<MutationRecord>(afterNextPaint,
        (id, error) => host.report(`Error in body observer subscriber "${id}":`, error));
    const owners = new Map<string, Owner>();
    const waits = new Set<() => void>();
    let observer: MutationObserver | null = null;
    let waitSequence = 0;
    let teardownGeneration = 0;
    function stopIfEmpty() {
        if (body.subscribers.size !== 0) return;
        observer?.disconnect();
        observer = null;
        body.reset();
    }
    function ensureBody() {
        if (observer) return;
        const current = host.createObserver(records => {
            if (observer !== current || !records.some(host.isStructuralChange)) return;
            body.dispatch(records);
        });
        current.observe(host.document.body, { childList: true, subtree: true });
        observer = current;
    }
    function disconnectObserver(id: string): boolean {
        const owner = owners.get(id);
        if (!owner) return false;
        owner.disconnect();
        return true;
    }
    function onBodyMutation(id: string, callback: BodyCallback, options?: { priority?: number }): SubscriptionHandle {
        // One name owns one resource, even when callers switch observation modes.
        disconnectObserver(id);
        const sub = { callback, priority: typeof options?.priority === 'number' ? options.priority : 0 };
        const owner: Owner = { managed: false, disconnect() {
            if (owners.get(id) !== owner) return;
            owners.delete(id);
            body.subscribers.delete(id);
            stopIfEmpty();
        } };
        owners.set(id, owner);
        body.subscribers.set(id, sub);
        ensureBody();
        return { disconnect: owner.disconnect, unsubscribe: owner.disconnect };
    }
    function removeBodySubscriber(id: string): boolean {
        return body.subscribers.has(id) && disconnectObserver(id);
    }
    function createObserver(id: string, callback: MutationCallback, target: Node, config: MutationObserverInit): ObserverHandle {
        disconnectObserver(id);
        if (host.isBodyTarget(target) && config.childList && config.subtree &&
            !config.attributes && !config.attributeFilter && !config.characterData && !config.characterDataOldValue && !config.attributeOldValue) {
            const handle = onBodyMutation(id, records => callback(records, proxy));
            const owner = owners.get(id);
            if (owner) owner.managed = true;
            const proxy = { ...handle,
                observe() { /* Already observes the shared body subtree, as the legacy proxy did. */ },
                takeRecords: (): MutationRecord[] => [] };
            return proxy;
        }
        const native = host.createObserver(records => {
            if (owners.get(id) === owner) callback(records, native);
        });
        // Preserve the native MutationObserver return surface (including instanceof)
        // while tying both explicit and callback-driven disconnects to this owner.
        const disconnectNative = native.disconnect.bind(native);
        const observeNative = native.observe.bind(native);
        const owner: Owner = { managed: true, disconnect() {
            disconnectNative();
            if (owners.get(id) === owner) owners.delete(id);
        } };
        observeNative(target, config);
        owners.set(id, owner);
        native.disconnect = owner.disconnect;
        native.observe = (node, options) => {
            observeNative(node, options);
            // Native observers may be reused after disconnect. An explicit observe
            // acquires this name again; merely disposing an old handle never does.
            if (owners.get(id) !== owner) {
                disconnectObserver(id);
                owners.set(id, owner);
            }
        };
        return native;
    }

    function disconnectAllObservers(): void {
        teardownGeneration++;
        // Clear owners before settling waits, so continuations start in a clean generation.
        for (const owner of [...owners.values()]) owner.disconnect();
        stopIfEmpty();
        for (const cancel of [...waits]) cancel();
    }
    function waitForElement(selector: string, options: number | WaitOptions | null = {}): Promise<Element | null> {
        const opts = typeof options === 'number' ? { timeout: options } : options ?? {};
        const root = opts.root ?? host.document;
        let warned = false;
        const find = (): Element | null => {
            if (!opts.predicate) return root.querySelector(selector);
            for (const element of Array.from(root.querySelectorAll(selector))) {
                try { if (opts.predicate(element)) return element; }
                catch (error) {
                    if (!warned) { warned = true; host.warn(`waitForElement predicate threw for ${selector}:`, error); }
                }
            }
            return null;
        };
        return new Promise((resolve) => {
            if (opts.signal?.aborted) { resolve(null); return; }
            const generation = teardownGeneration;
            const existing = find();
            // Predicates may abort or tear down all resources before this wait is registered.
            if (opts.signal?.aborted || generation !== teardownGeneration) { resolve(null); return; }
            if (existing) { resolve(existing); return; }
            let timer: number | undefined;
            let settled = false;
            let handle: SubscriptionHandle | undefined;
            const finish = (element: Element | null) => {
                if (settled) return;
                settled = true;
                if (timer !== undefined) host.clearTimeout(timer);
                handle?.unsubscribe();
                waits.delete(cancel);
                opts.signal?.removeEventListener('abort', cancel);
                resolve(element);
            };
            const cancel = () => finish(null);
            waits.add(cancel);
            handle = onBodyMutation(`wait-${selector}-${++waitSequence}`, () => {
                const element = find();
                if (element) finish(element);
            });
            opts.signal?.addEventListener('abort', cancel, { once: true });
            timer = host.setTimeout(() => {
                if (!opts.quiet) host.warn(`Timeout waiting for element: ${selector}`);
                finish(null);
            }, opts.timeout ?? 10000);
        });
    }
    host.onUnload(disconnectAllObservers);
    return { onBodyMutation, removeBodySubscriber, createObserver, disconnectObserver, disconnectAllObservers,
        waitForElement, afterNextPaint, getObserverCount: () => [...owners.values()].filter(owner => owner.managed).length,
        getBodySubscriberCount: () => body.subscribers.size };
}
export type Dom = ReturnType<typeof createDom>;
