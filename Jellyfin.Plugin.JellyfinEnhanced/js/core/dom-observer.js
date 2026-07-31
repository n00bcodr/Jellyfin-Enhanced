// @ts-check
// /js/core/dom-observer.js
//
// Shared DOM observation layer (moved from enhanced/helpers.js).
//
// One multiplexed MutationObserver on document.body dispatches to all
// registered subscribers instead of N separate observers cloning N
// MutationRecord lists. Non-body/complex observers are created per-id and
// tracked so they can be disconnected by name.
//
// Public surface: JE.core.dom { onBodyMutation, removeBodySubscriber,
// createObserver, disconnectObserver, disconnectAllObservers, waitForElement }.
// JE.helpers keeps thin aliases for unmigrated callers.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    // Active observers registry for lifecycle management (non-body targets only)
    /** @type {Map<string, { disconnect: Function }>} */
    const activeObservers = new Map();

    // --- Multiplexed Body Observer ---
    // Single MutationObserver on document.body that dispatches to all registered subscribers.
    // This replaces the previous pattern of N separate observers on document.body,
    // reducing browser overhead from cloning MutationRecord lists N times and scheduling
    // N separate microtask callbacks down to a single observer + single dispatch loop.
    /** @type {Map<string, { callback: Function, priority: number }>} */
    const bodySubscribers = new Map();
    /** @type {MutationObserver|null} */
    let bodyObserver = null;

    function ensureBodyObserver() {
        if (bodyObserver) return;
        bodyObserver = new MutationObserver((mutations) => {
            // Fast-path: skip dispatch entirely if no nodes were added or removed.
            // This filters out attribute changes, text changes, hover effects, focus
            // changes, etc. that fire frequently but never add new content.
            let hasStructuralChange = false;
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0 || mutations[i].removedNodes.length > 0) {
                    hasStructuralChange = true;
                    break;
                }
            }
            if (!hasStructuralChange) return;

            // NOTE: Callbacks may call unsubscribe()/disconnect(), deleting from this Map
            // during iteration. ES spec guarantees Map iteration handles concurrent deletion.
            for (const [id, sub] of bodySubscribers) {
                try {
                    sub.callback(mutations);
                } catch (err) {
                    console.error(`🪼 Jellyfin Enhanced: Error in body observer subscriber "${id}":`, err);
                }
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        console.log('🪼 Jellyfin Enhanced: Shared body observer started');
    }

    function stopBodyObserverIfEmpty() {
        if (bodyObserver && bodySubscribers.size === 0) {
            bodyObserver.disconnect();
            bodyObserver = null;
            console.log('🪼 Jellyfin Enhanced: Shared body observer stopped (no subscribers)');
        }
    }

    /**
     * Re-sort bodySubscribers Map by priority (highest first).
     * Called when a subscriber with non-default priority is added.
     */
    function resortBodySubscribers() {
        const sorted = [...bodySubscribers.entries()].sort((a, b) => b[1].priority - a[1].priority);
        bodySubscribers.clear();
        for (const [id, sub] of sorted) {
            bodySubscribers.set(id, sub);
        }
    }

    /**
     * Register a callback with the shared body MutationObserver.
     * All subscribers share a single observer on document.body with { childList: true, subtree: true }.
     * @param {string} id - Unique identifier for this subscriber
     * @param {Function} callback - Called with (mutations) on each body mutation batch
     * @param {Object} [options] - Options
     * @param {number} [options.priority=0] - Execution priority. Higher values run first.
     *   Use priority > 0 for subscribers that should filter/hide content before others process it.
     * @returns {{ unsubscribe: Function, disconnect: Function }} Handle to remove this subscriber.
     *   Both unsubscribe() and disconnect() do the same thing -- provided so callers can use
     *   either the subscription convention or the MutationObserver convention consistently.
     */
    function onBodyMutation(id, callback, options) {
        const priority = (options && typeof options.priority === 'number') ? options.priority : 0;
        if (bodySubscribers.has(id)) {
            console.warn(`🪼 Jellyfin Enhanced: Replacing body observer subscriber: ${id}`);
        }
        bodySubscribers.set(id, { callback, priority });
        if (priority !== 0) {
            resortBodySubscribers();
        }
        ensureBodyObserver();
        console.log(`🪼 Jellyfin Enhanced: Body subscriber registered: ${id} (priority: ${priority}, total: ${bodySubscribers.size})`);
        const cleanup = () => {
            if (!bodySubscribers.has(id)) return;
            bodySubscribers.delete(id);
            console.log(`🪼 Jellyfin Enhanced: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
            stopBodyObserverIfEmpty();
        };
        return { unsubscribe: cleanup, disconnect: cleanup };
    }

    /**
     * Remove a subscriber from the shared body observer.
     * @param {string} id - The subscriber ID
     * @returns {boolean} True if found and removed
     */
    function removeBodySubscriber(id) {
        const removed = bodySubscribers.delete(id);
        if (removed) {
            console.log(`🪼 Jellyfin Enhanced: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
            stopBodyObserverIfEmpty();
        }
        return removed;
    }

    /**
     * Create a managed MutationObserver that can be properly cleaned up.
     * If target is document.body with { childList: true, subtree: true }, the callback
     * is automatically routed to the shared multiplexed body observer instead of
     * creating a separate MutationObserver instance.
     * @param {string} id - Unique identifier for this observer
     * @param {MutationCallback} callback - The mutation callback
     * @param {Node} target - The element to observe
     * @param {MutationObserverInit} config - The observer configuration
     * @returns {MutationObserver|{ disconnect: Function, unsubscribe: Function }} Observer handle
     */
    function createObserver(id, callback, target, config) {
        // Route body observers to the shared multiplexed observer
        const isBodyTarget = target === document.body || target === document.documentElement || target === document;
        const isSubtreeWatch = config && config.childList && config.subtree;

        if (isBodyTarget && isSubtreeWatch && !config.attributes && !config.attributeFilter && !config.characterData) {
            // Use shared body observer
            const handle = onBodyMutation(id, callback);
            // Return a duck-typed object compatible with both MutationObserver and subscription conventions
            const cleanup = () => handle.disconnect();
            const proxy = {
                disconnect: cleanup,
                unsubscribe: cleanup,
                observe() { /* no-op, already observing via shared observer */ },
                takeRecords() { return []; }
            };
            activeObservers.set(id, proxy);
            return proxy;
        }

        // For non-body targets or complex configs (attributes, characterData),
        // create a dedicated observer as before
        if (activeObservers.has(id)) {
            const existing = activeObservers.get(id);
            existing.disconnect();
            console.warn(`🪼 Jellyfin Enhanced: Replacing existing observer: ${id}`);
        }

        const observer = new MutationObserver(callback);
        observer.observe(target, config);

        activeObservers.set(id, observer);
        console.log(`🪼 Jellyfin Enhanced: Created dedicated observer: ${id} (total: ${activeObservers.size})`);

        return observer;
    }

    /**
     * Disconnect and remove a managed observer (or body subscriber)
     * @param {string} id - The observer ID
     * @returns {boolean} True if observer was found and disconnected
     */
    function disconnectObserver(id) {
        // Check body subscribers first
        if (bodySubscribers.has(id)) {
            removeBodySubscriber(id);
            activeObservers.delete(id);
            return true;
        }
        if (activeObservers.has(id)) {
            const observer = activeObservers.get(id);
            observer.disconnect();
            activeObservers.delete(id);
            console.log(`🪼 Jellyfin Enhanced: Disconnected observer: ${id} (remaining: ${activeObservers.size})`);
            return true;
        }
        return false;
    }

    /**
     * Disconnect all managed observers and body subscribers
     */
    function disconnectAllObservers() {
        activeObservers.forEach((observer) => {
            observer.disconnect();
        });
        activeObservers.clear();
        bodySubscribers.clear();
        if (bodyObserver) {
            bodyObserver.disconnect();
            bodyObserver = null;
        }
        console.log('🪼 Jellyfin Enhanced: All observers and body subscribers disconnected');
    }

    /**
     * Wait for an element to appear in the DOM
     * @param {string} selector - CSS selector
     * @param {number} timeout - Maximum wait time in ms (default: 10000)
     * @returns {Promise<Element|null>}
     */
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const existing = document.querySelector(selector);
            if (existing) {
                resolve(existing);
                return;
            }

            const observerId = `wait-${selector}-${Date.now()}`;
            /** @type {*} */
            let timeoutId = null;

            const handle = onBodyMutation(observerId, () => {
                const element = document.querySelector(selector);
                if (element) {
                    if (timeoutId) clearTimeout(timeoutId);
                    handle.unsubscribe();
                    resolve(element);
                }
            });

            // Set timeout
            timeoutId = setTimeout(() => {
                handle.unsubscribe();
                console.warn(`🪼 Jellyfin Enhanced: Timeout waiting for element: ${selector}`);
                resolve(null);
            }, timeout);
        });
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        disconnectAllObservers();
    });

    JE.core.dom = {
        onBodyMutation,
        removeBodySubscriber,
        createObserver,
        disconnectObserver,
        disconnectAllObservers,
        waitForElement,
        /** @returns {number} */
        getObserverCount: () => activeObservers.size,
        /** @returns {number} */
        getBodySubscriberCount: () => bodySubscribers.size
    };

    console.log('🪼 Jellyfin Enhanced: DOM observer core initialized');

})(window.JellyfinEnhanced);
