import { pagesBridge, showItem, type DownloadsPageFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage, settle, type PageView } from './page-mount';

const CONTAINER_ID = 'je-downloads-container';
const isShown = (element: HTMLElement) => element.offsetHeight > 0 && element.offsetWidth > 0;

function setPluginPageVisible(facade: DownloadsPageFacade, visible: boolean): void {
    if (facade._state) facade._state._pluginPageVisible = visible;
    else facade._pluginPageVisible = visible; // Fallback for a facade without public state.
}

/** Auto-refresh for a facade without startPolling. Owned by this activation. */
function startPollingFallback(facade: DownloadsPageFacade, { container, signal }: PageView): void {
    const config = pagesBridge()?.pluginConfig;
    if (!config?.DownloadsPagePollingEnabled) return;
    const seconds = config.DownloadsPollIntervalSeconds ?? 30;
    const timer = setInterval(() => {
        if (isShown(container)) settle('Downloads', facade.refresh());
    }, (Number.isFinite(seconds) ? Math.max(1, seconds) : 30) * 1000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
}

mountPluginPage<DownloadsPageFacade>({
    name: 'Downloads',
    pageSelector: '.je-downloads-page',
    containerSelector: `#${CONTAINER_ID}`,
    createContainer: () => Object.assign(document.createElement('div'), { id: CONTAINER_ID }),
    exclusive: { kind: 'id', id: CONTAINER_ID },
    resolve: bridge => bridge.downloadsPage,
    render(facade, view) {
        facade.injectStyles();
        facade.renderPage();
        settle('Downloads', facade.refresh());
        document.addEventListener('click', event => {
            const button = event.target instanceof Element ? event.target.closest('.je-request-watch-btn') : null;
            if (!button) return;
            event.preventDefault();
            const mediaId = button.getAttribute('data-media-id');
            if (mediaId) showItem(mediaId);
        }, { signal: view.signal });
        // The feature's polling respects config and page visibility, so mark the page first.
        setPluginPageVisible(facade, true);
        if (typeof facade.startPolling === 'function') facade.startPolling();
        else startPollingFallback(facade, view);
    },
    suspend(facade) {
        setPluginPageVisible(facade, false);
        // A custom tab or the standalone page may already own the shared poller.
        if (!facade._state?._customTabMode && !facade._state?.pageVisible) facade.stopPolling?.();
    },
    loadedMessage: 'Downloads Page Loaded.'
});
