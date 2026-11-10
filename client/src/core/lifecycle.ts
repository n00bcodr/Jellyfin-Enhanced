export interface ListenerResource {
    el: EventTarget;
    type: string;
    fn: EventListenerOrEventListenerObject;
    opts?: boolean | AddEventListenerOptions | undefined;
}
export type Resource = null | undefined | number | (() => void) | ListenerResource |
    { intervalId: number } | { timeoutId: number } | { abort(): void } |
    { disconnect(): void } | { unsubscribe(): void };
export interface LifecycleDependencies {
    clearInterval(id: number): void;
    clearTimeout(id: number): void;
    onNavigate(callback: () => void): () => void;
    report(context: string, error: unknown): void;
}
export interface LifecycleHandle {
    readonly name: string;
    track<T extends Resource>(resource: T): T;
    untrack(resource: Resource): void;
    addListener(el: EventTarget, type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions): void;
    onTeardown(callback: () => void): LifecycleHandle;
    teardown(): void;
    teardownOn(eventName: 'navigate'): () => void;
}

/** Reusable feature lifetimes. Each teardown owns a fixed snapshot of resources. */
export function createLifecycle(deps: LifecycleDependencies) {
    const registry = new Map<string, LifecycleHandle>();
    function dispose(resource: Resource): void {
        try {
            if (resource == null) return;
            if (typeof resource === 'number') { deps.clearInterval(resource); return; }
            if (typeof resource === 'function') { resource(); return; }
            if ('el' in resource) { resource.el.removeEventListener(resource.type, resource.fn, resource.opts); return; }
            if ('intervalId' in resource) { deps.clearInterval(resource.intervalId); return; }
            if ('timeoutId' in resource) { deps.clearTimeout(resource.timeoutId); return; }
            if ('abort' in resource) { resource.abort(); return; }
            if ('disconnect' in resource) { resource.disconnect(); return; }
            if ('unsubscribe' in resource) { resource.unsubscribe(); return; }
            deps.report("Don't know how to dispose resource", resource);
        } catch (error) { deps.report('Error disposing resource', error); }
    }
    function register(name: string): LifecycleHandle {
        const existing = registry.get(name);
        if (existing) return existing;
        let tracked: Resource[] = [];
        const hooks: Array<() => void> = [];
        let tearingDown = false;
        const handle: LifecycleHandle = {
            name,
            track(resource) { tracked.push(resource); return resource; },
            untrack(resource) { tracked = tracked.filter(entry => entry !== resource); },
            addListener(el, type, fn, opts) {
                el.addEventListener(type, fn, opts);
                tracked.push({ el, type, fn, opts });
            },
            onTeardown(callback) { hooks.push(callback); return handle; },
            teardown() {
                if (tearingDown) return;
                tearingDown = true;
                const resources = tracked;
                const currentHooks = [...hooks];
                tracked = [];
                try {
                    for (const resource of resources) dispose(resource);
                    for (const hook of currentHooks) {
                        try { hook(); }
                        catch (error) { deps.report(`Error in teardown hook for "${name}"`, error); }
                    }
                } finally { tearingDown = false; }
            },
            teardownOn(eventName) {
                if (eventName !== 'navigate') {
                    deps.report('teardownOn: unsupported event', eventName);
                    return () => {};
                }
                return deps.onNavigate(() => handle.teardown());
            }
        };
        registry.set(name, handle);
        return handle;
    }
    let tearingDownAll = false;
    return {
        register,
        get: (name: string) => registry.get(name) || null,
        getFeatures: () => [...registry.keys()],
        teardownAll() {
            if (tearingDownAll) return;
            tearingDownAll = true;
            try { for (const handle of [...registry.values()]) handle.teardown(); }
            finally { tearingDownAll = false; }
        }
    };
}
export type Lifecycle = ReturnType<typeof createLifecycle>;
