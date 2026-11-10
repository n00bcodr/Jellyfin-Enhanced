import type { ActivityFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage, settle } from './page-mount';

mountPluginPage<ActivityFacade>({
    name: 'Activity',
    pageSelector: '.je-activity-standalone-page',
    containerSelector: '.jellyfinenhanced.activity',
    createContainer: () => Object.assign(document.createElement('div'), { className: 'jellyfinenhanced activity' }),
    resolve: bridge => bridge.activityPage,
    render(facade, { container }) {
        facade.injectStyles();
        settle('Activity', facade.renderForCustomTab(container));
    },
    // A custom tab may have taken over the single poller; its render empties this feed first.
    suspend(facade, { container }) {
        if (container.querySelector('.je-activity-feed')?.hasChildNodes()) facade.stopPolling?.();
    },
    loadedMessage: 'Activity Page Loaded.'
});
