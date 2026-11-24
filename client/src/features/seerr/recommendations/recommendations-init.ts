// /js/jellyseerr/recommendations/recommendations-init.js
// Recommendations Page: sidebar link injection, navigation wiring, public surface and bootstrap.
import { translate } from '../host-discovery';
import { isRecord } from '../discovery/domain';
import { CATEGORY_PAGE_ID, LOG_PREFIX, PAGE_ID, part, PLUGIN_PAGE_LINK, recommendationsHost } from './stage';
import { createCustomElement } from '../../shared/dom';

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    const state = part(P, 'state');
    const showPage = () => part(P, 'showPage')();
    const hidePage = () => part(P, 'hidePage')();
    const hideCategoryPage = () => part(P, 'hideCategoryPage')();

    function handleNavigation(): void {
        part(P, 'sweepRenders')();
        // A category's own address (opened from the Home tab; Back and Forward between the tab and its
        // categories) is the category page's to follow.
        if (part(P, 'followUrl')()) return;
        // A pop that lands back on the open category's own entry is not a navigation away. The first
        // pop after a load is reported as one even on an unchanged URL, which closed the page here.
        if (state.categoryPageVisible && part(P, 'categoryOnOwnEntry')()) return;
        if (state.categoryPageVisible) hideCategoryPage();
        if (part(P, 'isPageHash')(window.location.hash)) showPage();
        else if (state.pageVisible) hidePage();
    }
    function handleViewShow(event: Event): void {
        if (!(event.target instanceof Element)) return;
        const { id } = event.target;
        if (id === PAGE_ID || id === CATEGORY_PAGE_ID) return;
        if (state.pageVisible) hidePage();
        if (state.categoryPageVisible) hideCategoryPage();
        // The router showing Home (a reload, a link, Back from a title, Forward) at a category's address: that page
        // opens over it once the router is done. (Not the page a category gave back on closing, which no longer names one.)
        const restored = event instanceof CustomEvent && isRecord(event.detail) && event.detail.jeRestored === true;
        const address = JE.discoveryAddress;
        if (!restored && address?.isHomeHash(window.location.hash) && address.categoryOfHash(window.location.hash)) {
            requestAnimationFrame(() => { part(P, 'followUrl')(); });
        }
    }
    /** The sidebar link belongs to the standalone page; the other hosts bring their own entry. */
    function linkHidden(): boolean {
        const config = JE.pluginConfig;
        return !!(P.pluginPagesExists && config?.RecommendationsUsePluginPages) ||
            !!config?.RecommendationsUseCustomTabs || !!config?.RecommendationsUseNativeTab;
    }
    function injectNavigation(): void {
        if (!JE.pluginConfig?.RecommendationsPageEnabled || linkHidden()) return;
        const pluginLink = P.sidebar?.querySelector<HTMLElement>(PLUGIN_PAGE_LINK);
        pluginLink?.style.setProperty('display', 'none', 'important');
        if (document.querySelector('.je-nav-recommendations-item')) return;
        const section = document.querySelector('.jellyfinEnhancedSection');
        if (!section) {
            console.log(`${LOG_PREFIX} jellyfinEnhancedSection not found, will wait for it`);
            return;
        }
        const navItem = createCustomElement('a', 'emby-linkbutton');
        navItem.className = 'navMenuOption lnkMediaFolder emby-button je-nav-recommendations-item';
        navItem.href = '#';
        const icon = document.createElement('span');
        icon.className = 'navMenuOptionIcon material-icons';
        icon.textContent = 'auto_awesome';
        const label = document.createElement('span');
        label.className = 'sectionName navMenuOptionText';
        label.textContent = translate(JE, 'recommendations_title');
        navItem.append(icon, label);
        navItem.addEventListener('click', event => {
            event.preventDefault();
            showPage();
        });
        section.appendChild(navItem);
        console.log(`${LOG_PREFIX} Navigation item injected`);
    }
    function setupNavigationWatcher(): void {
        if (!JE.pluginConfig?.RecommendationsPageEnabled || linkHidden()) return;
        // The shared watcher runs only when the link is gone and the section exists.
        JE.helpers?.onSidebarRebuilt?.('recommendations', '.je-nav-recommendations-item', () => {
            if (linkHidden()) return;
            console.log(`${LOG_PREFIX} Sidebar rebuilt, re-injecting navigation`);
            injectNavigation();
        });
    }
    function init(): void {
        if (!JE.pluginConfig?.RecommendationsPageEnabled) return;
        injectNavigation();
        setupNavigationWatcher();
        document.addEventListener('viewshow', handleViewShow);
        JE.helpers?.onNavigate?.(handleNavigation);
        handleNavigation();
    }
    P.handleNavigation = handleNavigation;
    P.handleViewShow = handleViewShow;
    P.injectNavigation = injectNavigation;
    P.setupNavigationWatcher = setupNavigationWatcher;
    JE.recommendationsPage = { renderForCustomTab: element => part(P, 'renderForCustomTab')(element), showPage, hidePage };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
