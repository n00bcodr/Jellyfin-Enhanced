import type { CalendarPageFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage, settle } from './page-mount';

const CONTAINER_ID = 'je-calendar-container';

mountPluginPage<CalendarPageFacade>({
    name: 'Calendar',
    pageSelector: '.je-calendar-page',
    containerSelector: `#${CONTAINER_ID}`,
    createContainer: () => Object.assign(document.createElement('div'), { id: CONTAINER_ID }),
    exclusive: { kind: 'id', id: CONTAINER_ID },
    resolve: bridge => bridge.calendarPage,
    render(facade, view) {
        facade.injectStyles();
        facade.loadSettings();
        facade.renderPage();
        // renderPage() creates the hidden standalone page, with the same id, on first use.
        if (view.reclaim() && !view.container.hasChildNodes()) facade.renderPage();
        settle('Calendar', facade.refresh());
        // Plugin Pages mode skips the feature's own registration. The same function added
        // twice stays one listener, and removing it could remove the feature's, so it stays.
        document.addEventListener('click', facade.handleEventClick);
    },
    loadedMessage: 'Calendar Page Loaded.'
});
