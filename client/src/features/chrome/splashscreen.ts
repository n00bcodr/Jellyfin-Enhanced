/**
 * Custom boot splash. Loaded as its own early script (plugin.js `loadSplashScreenEarly`),
 * before the component bundle, so it depends only on the optional plugin config.
 */
export interface SplashBridge {
    pluginConfig?: { EnableCustomSplashScreen?: unknown; SplashScreenImageUrl?: unknown };
    initializeSplashScreen?: () => void;
    hideSplashScreen?: () => void;
}

export const SPLASH_TIMING = Object.freeze({
    progressUpdateInterval: 150,
    fadeOutDuration: 400,
    completionDuration: 300,
    hardTimeout: 20000,
    removalInterval: 100,
    removalDuration: 5000
});

const READY_SELECTORS = [
    '.manualLoginForm',
    '#mainAnimatedPage',
    '.homeSectionsContainer',
    '.pageContainer',
    '.slides-container',
    '.backdrop-container',
    // Baseline element-name selector; it matches nothing on 12.x but is kept verbatim.
    'customTabButton_0',
    '.editorsChoiceItemBanner'
];
const DEFAULT_IMAGE = '/web/assets/img/banner-light.png';

/** Next simulated progress step: decelerating, randomized, never past 95% before the UI is ready. */
export function nextProgress(progress: number, lastIncrement: number, random: number): { progress: number; lastIncrement: number } {
    if (progress >= 95) return { progress, lastIncrement };
    const increment = Math.max(0.5, lastIncrement * 0.98);
    return { progress: Math.min(95, progress + increment * (0.8 + random * 0.4)), lastIncrement: increment };
}

function isElementShown(element: Element | null): boolean {
    return element instanceof HTMLElement && element.offsetParent !== null;
}
function isUIReady(): boolean {
    for (const selector of READY_SELECTORS) {
        const element = document.querySelector(selector);
        if (isElementShown(element) || (element && selector === '#mainAnimatedPage')) return true;
    }
    return false;
}

/** @param readConfig Live plugin config; read per call like the baseline's `window.JellyfinEnhanced?.pluginConfig`. */
export function createSplashScreen(readConfig: () => SplashBridge['pluginConfig']) {
    let splashElement: HTMLElement | null = null;
    let styleElement: HTMLStyleElement | null = null;
    let permanentBlockStyle: HTMLStyleElement | null = null;
    let readyObserver: MutationObserver | null = null;
    let mediaBarBlocker: MutationObserver | null = null;
    let progressTimer: number | null = null;
    let hardTimeout: number | null = null;
    let detachReadyListeners: (() => void) | null = null;
    /** The boot splash is one-shot per document: once hidden it never reappears (CHR-SPLASH-1). */
    let isHidden = false;

    function installPreemptiveStyles(): void {
        try {
            const style = document.createElement('style');
            style.id = 'je-preempt-styles';
            style.textContent = `
                html.je-splash-booting .bar-loading,
                html.je-splash-booting #page-loader,
                html.je-splash-booting #splashscreen,
                html.je-splash-booting .splash,
                html.je-splash-booting [data-plugin-splash] {
                    display: none !important;
                }
            `;
            document.documentElement.classList.add('je-splash-booting');
            (document.head || document.documentElement).appendChild(style);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Failed to install preemptive styles', error);
        }
    }

    function installPermanentBlock(): void {
        if (permanentBlockStyle) return;
        try {
            permanentBlockStyle = document.createElement('style');
            permanentBlockStyle.id = 'je-permanent-block';
            permanentBlockStyle.textContent = `
                #page-loader,
                .bar-loading:not(.je-loading),
                #splashscreen:not(.je-loading),
                .splash:not(.je-loading),
                [data-plugin-splash]:not(.je-loading) {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
            `;
            document.head.appendChild(permanentBlockStyle);
            console.log('🪼 Jellyfin Enhanced: Permanent splash block installed');
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Failed to install permanent block', error);
        }
    }

    function removeMediaBarSplash(): void {
        document.querySelectorAll('#page-loader, .bar-loading:not(.je-loading)').forEach(element => {
            if (element.parentNode) {
                console.log('🪼 Jellyfin Enhanced: Removing media-bar splash element');
                element.remove();
            }
        });
    }

    function startMediaBarBlocker(): void {
        if (mediaBarBlocker) return;
        mediaBarBlocker = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node instanceof HTMLElement && (node.id === 'page-loader' ||
                        (node.classList.contains('bar-loading') && !node.classList.contains('je-loading')))) {
                        console.log('🪼 Jellyfin Enhanced: Blocking media-bar splash attempt');
                        node.remove();
                    }
                });
            }
        });
        mediaBarBlocker.observe(document.body, { childList: true, subtree: false });
    }

    function hideSplashScreen(reason: string): void {
        if (isHidden) return;
        isHidden = true;
        if (progressTimer !== null) { clearInterval(progressTimer); progressTimer = null; }
        if (hardTimeout !== null) { clearTimeout(hardTimeout); hardTimeout = null; }
        if (readyObserver) { readyObserver.disconnect(); readyObserver = null; }
        detachReadyListeners?.();
        detachReadyListeners = null;

        const progressBar = document.getElementById('je-progress-bar');
        const unfilledBar = document.getElementById('je-unfilled-bar');
        const completeRemoval = (): void => {
            if (splashElement) splashElement.style.opacity = '0';
            setTimeout(() => {
                splashElement?.remove();
                splashElement = null;
                styleElement?.remove();
                styleElement = null;
                document.body.classList.remove('je-splash-active');
                const removalInterval = setInterval(removeMediaBarSplash, SPLASH_TIMING.removalInterval);
                setTimeout(() => clearInterval(removalInterval), SPLASH_TIMING.removalDuration);
                if (reason) console.log(`🪼 Jellyfin Enhanced: Splash screen hidden → ${reason}`);
            }, SPLASH_TIMING.fadeOutDuration);
        };
        if (progressBar && unfilledBar) {
            progressBar.style.transition = 'width 300ms ease-in-out';
            progressBar.style.width = '100%';
            unfilledBar.style.width = '0%';
            setTimeout(completeRemoval, SPLASH_TIMING.completionDuration);
        } else {
            completeRemoval();
        }
    }

    function startProgressAnimation(): void {
        const progressBar = document.getElementById('je-progress-bar');
        const unfilledBar = document.getElementById('je-unfilled-bar');
        if (!progressBar || !unfilledBar) return;
        let state = { progress: 0, lastIncrement: 5 };
        progressTimer = setInterval(() => {
            if (state.progress >= 95) return;
            state = nextProgress(state.progress, state.lastIncrement, Math.random());
            progressBar.style.width = state.progress + '%';
            unfilledBar.style.width = (100 - state.progress) + '%';
        }, SPLASH_TIMING.progressUpdateInterval);
    }

    function startReadyObserver(): void {
        if (readyObserver) return;
        if (isUIReady()) { hideSplashScreen('UI already ready'); return; }
        readyObserver = new MutationObserver(() => {
            removeMediaBarSplash();
            if (document.querySelector('.bar-loading:not(.je-loading)')) document.body.classList.add('je-splash-active');
            if (isUIReady()) hideSplashScreen('core UI detected');
        });
        readyObserver.observe(document.body, { childList: true, subtree: true });
        const onHash = (): void => { if (isUIReady()) hideSplashScreen('hashchange ready'); };
        const onVisibility = (): void => { if (!document.hidden && isUIReady()) hideSplashScreen('visibilitychange ready'); };
        window.addEventListener('hashchange', onHash);
        document.addEventListener('visibilitychange', onVisibility);
        detachReadyListeners = () => {
            window.removeEventListener('hashchange', onHash);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }

    function buildSplash(imageUrl: string): HTMLElement {
        const splash = document.createElement('div');
        splash.className = 'je-loading';
        splash.innerHTML = `
            <div class="je-loader-content">
                <h1><img alt="Server Logo" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"></h1>
                <div class="je-progress">
                    <div id="je-progress-bar"></div>
                    <div class="je-gap"></div>
                    <div id="je-unfilled-bar"></div>
                </div>
            </div>
        `;
        // An attribute, never markup: the configured URL cannot inject elements (CHR-SPLASH-2).
        splash.querySelector('img')?.setAttribute('src', imageUrl);
        return splash;
    }

    function createSplash(): void {
        if (splashElement) return;
        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();
        styleElement = document.createElement('style');
        styleElement.id = 'je-splash-styles';
        styleElement.textContent = `
            body.je-splash-active .bar-loading:not(.je-loading) { display: none !important; }
            body.je-splash-active #page-loader { display: none !important; }
            .je-loading {
                z-index: 99999999 !important;
                position: fixed;
                inset: 0;
                background: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 1;
                transition: opacity 0.4s ease-in-out;
                overflow: hidden;
            }
            .je-loader-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 20px;
                width: 250px;
            }
            .je-loading h1 {
                width: 250px;
                height: 250px;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 0;
            }
            .je-loading h1 img {
                width: 250px;
                max-height: 250px;
                object-fit: contain;
                opacity: 1;
                transition: opacity 0.5s ease-in-out;
            }
            .je-progress {
                width: 200px;
                height: 6px;
                display: flex;
                align-items: center;
                position: relative;
            }
            #je-progress-bar {
                height: 5px;
                background: #fff;
                border-radius: 2px;
                width: 0;
            }
            .je-gap {
                width: 6px;
                height: 5px;
                flex-shrink: 0;
            }
            #je-unfilled-bar {
                height: 5px;
                background: #686868;
                border-radius: 2px;
                flex-grow: 1;
            }
        `;
        document.head.appendChild(styleElement);
        const configured = readConfig()?.SplashScreenImageUrl;
        splashElement = buildSplash(typeof configured === 'string' && configured ? configured : DEFAULT_IMAGE);
        document.body.appendChild(splashElement);
        startProgressAnimation();
        startReadyObserver();
        hardTimeout = setTimeout(() => hideSplashScreen('hard timeout 20s'), SPLASH_TIMING.hardTimeout);
        // The UI can already be ready: the splash then hides before the timeout exists.
        if (isHidden && hardTimeout !== null) { clearTimeout(hardTimeout); hardTimeout = null; }
    }

    function cleanup(): void {
        document.documentElement.classList.remove('je-splash-booting');
        document.getElementById('je-preempt-styles')?.remove();
        permanentBlockStyle?.remove();
        permanentBlockStyle = null;
        mediaBarBlocker?.disconnect();
        mediaBarBlocker = null;
    }

    function initializeSplashScreen(): void {
        if (!readConfig()?.EnableCustomSplashScreen) {
            cleanup();
            console.log('🪼 Jellyfin Enhanced: Custom splash screen disabled');
            return;
        }
        // plugin.js calls this from the early script load and again after config. A
        // splash that already completed must not be resurrected, and a body-less
        // document (script in <head>) waits for the body instead of throwing.
        if (isHidden) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', initializeSplashScreen, { once: true });
            return;
        }
        document.body.classList.add('je-splash-active');
        document.documentElement.classList.remove('je-splash-booting');
        document.getElementById('je-preempt-styles')?.remove();
        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();
        createSplash();
        console.log('🪼 Jellyfin Enhanced: Splash screen initialized');
    }

    return { installPreemptiveStyles, initializeSplashScreen, hide: () => hideSplashScreen('requested by plugin.js') };
}
