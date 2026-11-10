import type { PagesBridge } from '../host/bootstrap-pages-host';
import { mountPluginPage } from './page-mount';

mountPluginPage<NonNullable<PagesBridge['bookmarks']>>({
    name: 'Bookmarks',
    pageSelector: '.je-bookmarks-page',
    containerSelector: '.sections.bookmarks',
    createContainer: () => Object.assign(document.createElement('div'), { className: 'sections bookmarks' }),
    // library-modals and library-items re-render the first `.sections.bookmarks` in the document.
    exclusive: { kind: 'class', selector: '.sections.bookmarks', className: 'bookmarks' },
    // The bookmarks feature renders the active container itself once it appears.
    resolve: bridge => bridge.userConfig ? bridge.bookmarks : null,
    loadedMessage: 'Bookmarks Page Loaded.'
});
