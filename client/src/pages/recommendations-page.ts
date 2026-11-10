import type { RecommendationsPageFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage } from './page-mount';

mountPluginPage<RecommendationsPageFacade>({
    name: 'Recommendations',
    pageSelector: '.je-recommendations-page',
    containerSelector: '#je-recommendations-container',
    createContainer: () => Object.assign(document.createElement('div'), { id: 'je-recommendations-container' }),
    resolve: bridge => bridge.recommendationsPage,
    render(facade, { container }) { facade.renderForCustomTab(container); },
    loadedMessage: 'Recommendations Page Loaded.'
});
