import type { HiddenContentPageFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage } from './page-mount';

const CONTAINER_ID = 'je-hidden-content-container';

mountPluginPage<HiddenContentPageFacade>({
    name: 'Hidden Content',
    pageSelector: '.je-hidden-content-page',
    containerSelector: `#${CONTAINER_ID}`,
    createContainer: () => Object.assign(document.createElement('div'), { id: CONTAINER_ID }),
    exclusive: { kind: 'id', id: CONTAINER_ID },
    // Both must be initialized: JE.hiddenContent stays undefined while disabled server-wide.
    resolve: bridge => bridge.hiddenContent ? bridge.hiddenContentPage : null,
    render(facade, view) {
        if (typeof facade.injectStyles === 'function') facade.injectStyles();
        if (typeof facade.renderPage !== 'function') return;
        facade.renderPage();
        // renderPage() creates the hidden standalone page, with the same id, on first use.
        if (view.reclaim() && !view.container.hasChildNodes()) facade.renderPage();
    },
    loadedMessage: 'Hidden Content Page Loaded.'
});
