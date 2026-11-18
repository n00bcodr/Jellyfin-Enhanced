import type { TagRuntimeBridge } from '../host';

/**
 * Leaving Soon Custom Tab (upstream da0ea773, extras/leavingsoon-custom-tab.js). Creates
 * <div class="jellyfinenhanced leavingsoon"></div>, either inside a tab panel managed by the external Custom Tabs plugin
 * (LeavingSoonPageUseCustomTabs), or inside a panel JE creates itself via the shared native-tabs registry
 * (LeavingSoonPageUseNativeTab). The rest of this file doesn't care which one created the wrapping panel. Same mounting
 * pattern as the Activity custom tab: a persistent observer remounts when the home page DOM is rebuilt, and it suspends
 * while navigated away.
 */
export function mountLeavingSoonTab(JE: TagRuntimeBridge): void {
    const config = JE.pluginConfig;
    if (config?.LeavingSoonPageEnabled !== true) return;
    const useCustomTabs = config.LeavingSoonPageUseCustomTabs === true;
    const useNativeTab = config.LeavingSoonPageUseNativeTab === true;
    if (!useCustomTabs && !useNativeTab) return;

    if (useNativeTab) {
        JE.nativeTabs?.register('leavingsoon', JE.t('leavingsoon_title') || 'Leaving Soon', (panel) => {
            const marker = document.createElement('div');
            marker.className = 'jellyfinenhanced leavingsoon';
            panel.appendChild(marker);
        }, 'auto_delete');
    }

    JE.core.ui?.injectCss?.('je-leavingsoon-tab', [
        '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.leavingsoon) {',
        '  background: rgba(0, 0, 0, 0.7) !important;',
        '  opacity: 1 !important;',
        '}',
    ].join('\n'));

    let lastMountedContainer: HTMLElement | null = null;

    function isOnHomePage(): boolean {
        const hash = window.location.hash.replace(/^#!/, '#');
        return hash === '' || hash === '#/home' || hash === '#/home.html'
            || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1
            // (Or only the Recommendations filters' fragment after it: see seerr/discovery/address.ts.)
            || hash.indexOf('#/home#') === 0 || hash.indexOf('#/home.html#') === 0;
    }

    /** The container inside the active (non-hidden) home page, never a stale cached copy. */
    function findActiveContainer(): HTMLElement | null {
        const all = document.querySelectorAll<HTMLElement>('.jellyfinenhanced.leavingsoon');
        for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            if (el && JE.helpers?.isActiveTabContainer?.(el)) return el;
        }
        return null;
    }

    function render(container: HTMLElement): void {
        const page = JE.leavingSoonPage;
        if (!page) return;
        container.classList.remove('hide');
        container.style.display = '';
        const child = document.createElement('div');
        child.id = 'je-leavingsoon-container-tab';
        container.textContent = '';
        container.appendChild(child);
        page.injectStyles();
        page.renderForCustomTab(child);
        lastMountedContainer = container;
    }

    let wasOnHomePage = false;
    function tryMount(): void {
        const onHome = isOnHomePage();
        if (!onHome) {
            if (wasOnHomePage) { JE.leavingSoonPage?.stopPolling(); lastMountedContainer = null; }
            wasOnHomePage = false;
            return;
        }
        const justReturned = !wasOnHomePage;
        wasOnHomePage = true;
        const container = findActiveContainer();
        if (!container) {
            if (lastMountedContainer) JE.leavingSoonPage?.stopPolling();
            lastMountedContainer = null;
            return;
        }
        const shouldMount = justReturned
            || container !== lastMountedContainer
            || !container.hasChildNodes()
            || (lastMountedContainer && !document.contains(lastMountedContainer));
        if (shouldMount) render(container);
    }

    tryMount();
    // The shared navigation hook (it follows the hash) and the shared tab-container observer, instead of a listener of its own.
    JE.core.navigation?.onNavigate?.(tryMount);
    JE.helpers?.observeTabContainers?.('leavingsoon-custom-tab', '.jellyfinenhanced.leavingsoon', tryMount);
}
