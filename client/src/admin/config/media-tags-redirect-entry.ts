import { mediaTagsRedirectTarget } from './media-tags-redirect';

// The Media Tags settings are a tab of the main Jellyfin Enhanced page now. This page only keeps the older
// links working (the settings panel, bookmarks, the docs): it forwards them, keeping their tab and group.
const target = mediaTagsRedirectTarget(window.location.hash || '');
if (target) window.location.replace(target);
