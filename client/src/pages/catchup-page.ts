import type { CatchUpFacade } from '../host/bootstrap-pages-host';
import { mountPluginPage } from './page-mount';

mountPluginPage<CatchUpFacade>({
    name: 'Catch Up',
    pageSelector: '.je-catchup-page',
    containerSelector: '#je-catchup-container',
    createContainer: () => Object.assign(document.createElement('div'), { id: 'je-catchup-container' }),
    resolve: bridge => bridge.catchUpPage,
    render(facade, { container }) {
        facade.injectStyles();
        facade.renderPage(container);
    }
});
