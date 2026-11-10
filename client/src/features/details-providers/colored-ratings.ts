/** Color-coded backgrounds for official media ratings on the item details page. */
import { bridge } from './host';
import type { ColoredRatingsBridge, ObserverHandleLike, Unregister } from './host';
import { normalizeRating } from './rating-domain';

const JE = bridge<ColoredRatingsBridge>('Colored ratings');
const CONFIG = {
    targetSelector: '.mediaInfoOfficialRating',
    attributeName: 'rating',
    debounceDelay: 100,
    cssUrl: JE.cdn.url('je-css', 'ratings.css'),
    cssId: 'jellyfin-ratings-style'
};

let observer: ObserverHandleLike | null = null;
let navigationUnsubscribers: (Unregister | undefined | void)[] = [];
let debounceTimer: number | null = null;
let processedElements = new WeakSet<Element>();

function isFeatureEnabled(): boolean {
    return Boolean(JE.pluginConfig?.ColoredRatingsEnabled);
}

function injectCSS(): void {
    if (document.getElementById(CONFIG.cssId)) return;
    try {
        const linkElement = document.createElement('link');
        linkElement.id = CONFIG.cssId;
        linkElement.rel = 'stylesheet';
        linkElement.type = 'text/css';
        linkElement.href = CONFIG.cssUrl;
        document.head.appendChild(linkElement);
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to inject ratings CSS', error);
    }
}

function processRatingElements(): void {
    try {
        document.querySelectorAll(CONFIG.targetSelector).forEach(element => {
            if (processedElements.has(element) && element.textContent?.trim() === element.getAttribute(CONFIG.attributeName)) return;
            const ratingText = element.textContent?.trim();
            if (!ratingText) return;
            const normalizedRating = normalizeRating(ratingText);
            if (element.getAttribute(CONFIG.attributeName) === normalizedRating) return;
            element.setAttribute(CONFIG.attributeName, normalizedRating);
            if (normalizedRating.startsWith('FSK-')) element.textContent = normalizedRating;
            processedElements.add(element);
            if (!element.getAttribute('aria-label')) element.setAttribute('aria-label', `Content rated ${normalizedRating}`);
            if (!element.getAttribute('title')) element.setAttribute('title', `Rating: ${normalizedRating}`);
        });
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Error processing rating elements', error);
    }
}

function debouncedProcess(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processRatingElements, CONFIG.debounceDelay);
}

function setupMutationObserver(): boolean {
    if (!window.MutationObserver) return false;
    try {
        // Any added element may be (or contain) a rating box, so the cheap,
        // idempotent pass runs for any of them. Jellyfin writes the rating via
        // textContent: a childList mutation on the element itself.
        const callback = (mutations: MutationRecord[]) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;
                for (const added of mutation.addedNodes) {
                    if (added.nodeType === Node.ELEMENT_NODE) {
                        debouncedProcess();
                        return;
                    }
                }
                const target = mutation.target;
                if (target instanceof Element && (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
                    debouncedProcess();
                    return;
                }
            }
        };
        // childList + subtree on body routes through the shared multiplexed observer.
        const createObserver = JE.helpers?.createObserver;
        if (createObserver) {
            observer = createObserver.call(JE.helpers, 'colored-ratings', callback, document.body, { childList: true, subtree: true }) || null;
        } else {
            const native = new MutationObserver(callback);
            native.observe(document.body, { childList: true, subtree: true });
            observer = native;
        }
        return true;
    } catch (error) {
        console.error('🪼 Jellyfin Enhanced: Failed to setup ratings observer', error);
        return false;
    }
}

/**
 * Re-check after navigation and view show: a cached detail page re-shown by
 * a class toggle alone produces no childList mutation.
 */
function setupNavigationTriggers(): void {
    const helpers = JE.helpers;
    if (!helpers?.onNavigate) return;
    navigationUnsubscribers.push(helpers.onNavigate(() => {
        if (!isFeatureEnabled()) return;
        setTimeout(processRatingElements, 500);
    }));
    navigationUnsubscribers.push(helpers.onViewPage?.(() => {
        if (isFeatureEnabled()) debouncedProcess();
    }));
}

/** Kept for the pause screen, which pauses/resumes the (removed) polling; a resume re-checks. */
function pausePolling(): void {}
function resumePolling(): void {
    if (isFeatureEnabled()) debouncedProcess();
}

function cleanup(): void {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    for (const unsubscribe of navigationUnsubscribers) {
        try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ }
    }
    navigationUnsubscribers = [];
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    processedElements = new WeakSet();
}

function initialize(): void {
    cleanup();
    if (!isFeatureEnabled()) return;
    injectCSS();
    processRatingElements();
    setupMutationObserver();
    setupNavigationTriggers();
}

if (typeof document.visibilityState !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isFeatureEnabled()) setTimeout(processRatingElements, 100);
    });
}
window.addEventListener('beforeunload', cleanup);
JE.initializeColoredRatings = initialize;
// Shared with poster age-rating badges, so they pick the same [rating=...] colour key.
JE.normalizeOfficialRating = normalizeRating;
// The pause screen controls these
JE.pauseRatingsPolling = pausePolling;
JE.resumeRatingsPolling = resumePolling;
