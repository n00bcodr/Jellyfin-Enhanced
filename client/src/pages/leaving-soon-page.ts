import type { LeavingSoonFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage } from './page-mount';

// The Leaving soon page through Plugin Pages (upstream da0ea773, PluginPages/LeavingSoonPage.html).
mountPluginPage<LeavingSoonFacade>({
    name: 'Leaving Soon',
    pageSelector: '.je-leavingsoon-standalone-page',
    containerSelector: '.jellyfinenhanced.leavingsoon',
    createContainer: () => Object.assign(document.createElement('div'), { className: 'jellyfinenhanced leavingsoon' }),
    resolve: bridge => bridge.leavingSoonPage,
    render(facade, { container }) {
        facade.injectStyles();
        facade.renderForCustomTab(container);
    },
    // A custom tab that mounted since took the single poller and emptied this container; otherwise the poller is ours.
    suspend(facade, { container }) {
        if (container.hasChildNodes()) facade.stopPolling();
    },
    loadedMessage: 'Leaving Soon Page Loaded.'
});
