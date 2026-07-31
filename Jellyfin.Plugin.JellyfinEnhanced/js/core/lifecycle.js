// @ts-check
// /js/core/lifecycle.js
//
// Per-feature resource registry. Features register once, track every
// disposable they create (observers, intervals, abort controllers, event
// listeners, unsubscribe functions), and get a single teardown() that
// disposes the lot. teardownOn('navigate') wires teardown to the shared
// je:navigate pipeline so cleanup fires on EVERY nav path — including the
// pushState transitions that ad-hoc hashchange listeners used to miss.
//
// Public surface: JE.core.lifecycle { register(name), get(name), teardownAll() }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced: Lifecycle:';

    /** @type {Map<string, ReturnType<typeof createHandle>>} */
    const registry = new Map();

    /**
     * Dispose a single tracked resource. Never throws.
     * @param {*} resource
     */
    function dispose(resource) {
        try {
            if (resource == null) return;

            // Interval id (setInterval return value)
            if (typeof resource === 'number') {
                clearInterval(resource);
                return;
            }

            // Plain cleanup / unsubscribe function
            if (typeof resource === 'function') {
                resource();
                return;
            }

            // { el, type, fn, opts } — a tracked addEventListener registration
            if (resource.el && typeof resource.type === 'string' && typeof resource.fn === 'function') {
                resource.el.removeEventListener(resource.type, resource.fn, resource.opts);
                return;
            }

            // Explicit timer wrappers
            if (typeof resource.intervalId === 'number') {
                clearInterval(resource.intervalId);
                return;
            }
            if (typeof resource.timeoutId === 'number') {
                clearTimeout(resource.timeoutId);
                return;
            }

            // AbortController (or anything abortable)
            if (typeof resource.abort === 'function') {
                resource.abort();
                return;
            }

            // MutationObserver / IntersectionObserver / shared-body-observer handles
            if (typeof resource.disconnect === 'function') {
                resource.disconnect();
                return;
            }
            if (typeof resource.unsubscribe === 'function') {
                resource.unsubscribe();
                return;
            }

            console.warn(`${logPrefix} Don't know how to dispose resource:`, resource);
        } catch (err) {
            console.warn(`${logPrefix} Error disposing resource:`, err);
        }
    }

    /**
     * @param {string} name - Feature identifier (used for logging / lookup).
     */
    function createHandle(name) {
        /** @type {Array<*>} */
        let tracked = [];
        /** @type {Array<Function>} */
        const teardownHooks = [];

        const handle = {
            name,

            /**
             * Track a disposable resource for teardown. Accepts:
             * - a MutationObserver / IntersectionObserver / anything with disconnect()
             * - a shared-observer handle (unsubscribe())
             * - an interval id (number) or { intervalId } / { timeoutId }
             * - an AbortController (anything with abort())
             * - { el, type, fn, opts } describing an added event listener
             * - a plain cleanup/unsubscribe function
             * @template T
             * @param {T} resource
             * @returns {T} The same resource, for chaining.
             */
            track(resource) {
                tracked.push(resource);
                return resource;
            },

            /**
             * Stop tracking a resource without disposing it.
             * @param {*} resource
             */
            untrack(resource) {
                tracked = tracked.filter(r => r !== resource);
            },

            /**
             * addEventListener + track in one step, so teardown() removes it.
             * @param {EventTarget} el
             * @param {string} type
             * @param {EventListenerOrEventListenerObject} fn
             * @param {boolean|AddEventListenerOptions} [opts]
             */
            addListener(el, type, fn, opts) {
                el.addEventListener(type, fn, opts);
                tracked.push({ el, type, fn, opts });
            },

            /**
             * Register a persistent teardown hook, invoked on EVERY teardown()
             * (unlike tracked resources, which are one-shot and cleared).
             * Use this to route a module's existing cleanup() function through
             * the lifecycle.
             * @param {Function} fn
             * @returns {typeof handle}
             */
            onTeardown(fn) {
                teardownHooks.push(fn);
                return handle;
            },

            /**
             * Dispose all tracked resources and run the persistent teardown
             * hooks. The handle stays usable — features re-track resources
             * they create on the next page render.
             */
            teardown() {
                const resources = tracked;
                tracked = [];
                for (const resource of resources) {
                    dispose(resource);
                }
                for (const fn of teardownHooks) {
                    try {
                        fn();
                    } catch (err) {
                        console.error(`${logPrefix} Error in teardown hook for "${name}":`, err);
                    }
                }
            },

            /**
             * Automatically run teardown() on an app event. Currently supports
             * 'navigate' (the deduplicated je:navigate/hashchange/popstate
             * pipeline from JE.core.navigation).
             * @param {'navigate'} eventName
             * @returns {Function} Unsubscribe function for the auto-teardown wiring.
             */
            teardownOn(eventName) {
                if (eventName !== 'navigate') {
                    console.warn(`${logPrefix} teardownOn: unsupported event "${eventName}"`);
                    return () => {};
                }
                // Deliberately NOT tracked: the wiring must survive teardown()
                // so cleanup keeps firing on every subsequent navigation.
                return JE.core.navigation.onNavigate(() => handle.teardown());
            }
        };

        return handle;
    }

    /**
     * Register (or fetch the existing) lifecycle handle for a feature.
     * @param {string} name
     */
    function register(name) {
        const existing = registry.get(name);
        if (existing) return existing;
        const handle = createHandle(name);
        registry.set(name, handle);
        return handle;
    }

    /**
     * Look up an existing handle without creating one.
     * @param {string} name
     */
    function get(name) {
        return registry.get(name) || null;
    }

    /** Tear down every registered feature (page unload / hard reset). */
    function teardownAll() {
        for (const handle of registry.values()) {
            handle.teardown();
        }
    }

    JE.core.lifecycle = {
        register,
        get,
        teardownAll,
        /** @returns {string[]} Registered feature names (diagnostics). */
        getFeatures: () => [...registry.keys()]
    };

    console.log(`${logPrefix} initialized`);

})(window.JellyfinEnhanced);
