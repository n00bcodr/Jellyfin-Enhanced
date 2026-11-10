// /js/jellyseerr/recommendations/recommendations-page.js
// Recommendations Page: the standalone (sidebar-link) page container and its show/hide lifecycle.
import { translate } from '../host-discovery';
import { LOG_PREFIX, OTHER_PAGE, PAGE_ID, part, recommendationsHost } from './stage';

const HASH = '#/recommendations';
const CONTAINER_ID = 'je-recommendations-container';

(function () {
    'use strict';
    const { JE, P } = recommendationsHost();
    const title = () => translate(JE, 'recommendations_title');

    function createPageContainer(): HTMLElement {
        const existing = document.getElementById(PAGE_ID);
        if (existing) return existing;
        const page = document.createElement('div');
        page.id = PAGE_ID;
        page.className = 'page type-interior mainAnimatedPage hide';
        page.setAttribute('data-title', title());
        page.setAttribute('data-backbutton', 'true');
        page.setAttribute('data-url', HASH);
        page.setAttribute('data-type', 'custom');
        page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-recommendations-page">
            <div id="${CONTAINER_ID}" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;
        (document.querySelector('.mainAnimatedPages') ?? document.body).appendChild(page);
        return page;
    }
    function showPage(): void {
        const state = part(P, 'state');
        if (state.categoryPageVisible) part(P, 'hideCategoryPage')();
        if (state.pageVisible) return;
        const config = JE.pluginConfig;
        if (!config?.RecommendationsPageEnabled) return;
        if (P.pluginPagesExists && config.RecommendationsUsePluginPages) return;
        state.pageVisible = true;
        const page = createPageContainer();
        if (window.location.hash !== HASH) history.pushState({ page: 'recommendations' }, title(), HASH);
        const activePage = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${PAGE_ID})`);
        if (activePage) {
            state.previousPage = activePage;
            activePage.classList.add('hide');
            activePage.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'interior' } }));
        }
        page.classList.remove('hide');
        page.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'custom', isRestored: false, options: {} } }));
        page.dispatchEvent(new CustomEvent('pageshow', { bubbles: true, detail: {} }));
        // Plugin Pages use the same id; this page's container is the one inside it.
        const container = page.querySelector<HTMLElement>(`#${CONTAINER_ID}`);
        if (container) {
            Promise.resolve(part(P, 'renderInto')(container))
                .catch(error => console.error(`${LOG_PREFIX} Failed to render`, error));
        }
    }
    function hidePage(): void {
        const state = part(P, 'state');
        if (!state.pageVisible) return;
        // Cleared first: restoring the previous page below announces a viewshow.
        state.pageVisible = false;
        const page = document.getElementById(PAGE_ID);
        if (page) {
            page.classList.add('hide');
            page.dispatchEvent(new CustomEvent('viewhide', { bubbles: true, detail: { type: 'custom' } }));
        }
        const previous = state.previousPage;
        state.previousPage = null;
        if (previous && !document.querySelector(OTHER_PAGE)) {
            previous.classList.remove('hide');
            previous.dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { type: 'interior', isRestored: true } }));
        }
        state.currentAbortController?.abort();
        const container = page?.querySelector<HTMLElement>(`#${CONTAINER_ID}`);
        if (container) P.disposeRender?.(container);
    }
    P.createPageContainer = createPageContainer;
    P.showPage = showPage;
    P.hidePage = hidePage;
})();
