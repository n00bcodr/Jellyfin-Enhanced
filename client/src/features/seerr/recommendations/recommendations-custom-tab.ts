// /js/jellyseerr/recommendations/recommendations-custom-tab.js
// Mounts into <div class="jellyfinenhanced recommendations"></div>, inside a tab panel managed by the
// external Custom Tabs plugin (RecommendationsUseCustomTabs) or one JE creates through the shared
// native-tabs registry (RecommendationsUseNativeTab). Nothing below depends on which created it.
// The watcher remounts whenever the home page DOM is rebuilt, and a mount that stops being the active
// container is disposed: it holds no requests, observers or cards while nobody can see it.
import { translate } from '../host-discovery';
import { part, recommendationsHost } from './stage';

const CONTAINER_SELECTOR = '.jellyfinenhanced.recommendations';
const READY_POLL_MS = 100;
const READY_MAX_POLLS = 300;

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    const config = JE.pluginConfig;
    if (!config?.RecommendationsPageEnabled) return;
    if (!config.RecommendationsUseCustomTabs && !config.RecommendationsUseNativeTab) return;
    if (config.RecommendationsUseNativeTab) {
        JE.nativeTabs?.register('recommendations', translate(JE, 'recommendations_title'), panel => {
            const marker = document.createElement('div');
            marker.className = 'jellyfinenhanced recommendations';
            panel.appendChild(marker);
        }, 'auto_awesome');
    }
    const style = document.createElement('style');
    style.textContent = [
        '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.recommendations) {',
        '  background: rgba(0, 0, 0, 0.7) !important;',
        '  opacity: 1 !important;',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    /** The tab's wrapper and the child rendered into it, which is what the render owns. */
    let mounted: { readonly container: HTMLElement; readonly child: HTMLElement } | null = null;
    function unmount(): void {
        if (!mounted) return;
        part(P, 'disposeRender')(mounted.child);
        mounted.container.replaceChildren();
        mounted = null;
    }
    const isOnHomePage = () => /^(?:#\/home(?:\.html)?(?:\?.*)?)?$/.test(window.location.hash);
    /** The container of the active tab of the active home page; never a stale cached copy. */
    function findActiveContainer(): HTMLElement | null {
        const all = [...document.querySelectorAll<HTMLElement>(CONTAINER_SELECTOR)];
        return all.reverse().find(element => JE.helpers?.isActiveTabContainer?.(element)) ?? null;
    }
    function reconcile(): void {
        const container = isOnHomePage() ? findActiveContainer() : null;
        if (!container) { unmount(); return; }
        if (container === mounted?.container && mounted.child.isConnected) return;
        unmount();
        container.classList.remove('hide');
        container.style.display = '';
        const child = document.createElement('div');
        child.id = 'je-recommendations-container-tab';
        container.replaceChildren(child);
        mounted = { container, child };
        JE.recommendationsPage?.renderForCustomTab(child);
    }
    function watch(): void {
        reconcile();
        JE.helpers?.observeTabContainers?.('recommendations-custom-tab', CONTAINER_SELECTOR, reconcile);
    }
    // A mount made before the identity changed is not the new user's: remount on the next pass.
    JE.session?.onUserChange('recommendations-custom-tab', unmount);
    if (JE.recommendationsPage) { watch(); return; }
    let attempts = 0;
    const waiting = setInterval(() => {
        if (++attempts > READY_MAX_POLLS) { clearInterval(waiting); return; }
        if (!JE.recommendationsPage) return;
        clearInterval(waiting);
        watch();
    }, READY_POLL_MS);
})();
