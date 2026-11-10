import { bookmarksHost, type BookmarkHost } from './host';
import { createLifetime } from './lifetime';
import libraryCss from './library.css';
const { ctx, host, getApi } = bookmarksHost();
/**
 * Bookmarks Library View — styles.
 * Existing library CSS plus explicit search visibility.
 * Creates <div class="sections bookmarks"></div> for CustomTabs plugin
 * (see bookmarks-library-init.js for the boot sequence).
 */
function install(JE: BookmarkHost) {
  const lifetime = createLifetime(ctx, 'library-styles');

  
  ctx.own.bookmarksLibrary = ctx.own.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) {
    console.log('🪼 Jellyfin Enhanced: Bookmarks library feature is disabled');
    return;
  }

  // Inject custom styles
  const style = document.createElement('style');
  style.textContent = libraryCss;
  document.head.appendChild(style);
  lifetime.keep(() => style.remove());

  const backdropStyle = document.createElement('style');
  backdropStyle.textContent = [
    '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .sections.bookmarks) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '  opacity: 1 !important;',
    '}'
  ].join('\n');
  document.head.appendChild(backdropStyle);
  lifetime.keep(() => backdropStyle.remove());

}
install(ctx.core);
