import { safeExternalUrl } from '../shared/url-domain';
import { dashboard } from './host';
import type { ExternalLinkFactory, ExternalLinkOptions } from './host';

/** Only navigable schemes reach an href built from configuration or upstream data. */
export function safeHref(url: string): string {
    return safeExternalUrl(url, window.location.href);
}

/**
 * The shared `JE.helpers.createExternalLink` when helpers have loaded, else an
 * equivalent element (resolved per call, so a load-order race at init does not
 * pin the fallback for the whole session). Both sanitize the URL.
 */
export function externalLink(helpers: { createExternalLink?: ExternalLinkFactory } | undefined, url: string, options: ExternalLinkOptions = {}): HTMLAnchorElement {
    const shared = helpers?.createExternalLink;
    if (shared) return shared(url, options);
    const anchor = document.createElement('a');
    anchor.setAttribute('is', 'emby-linkbutton');
    anchor.href = safeHref(url);
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    if (options.title) anchor.title = options.title;
    if (options.className) anchor.className = options.className;
    if (options.text) anchor.textContent = options.text;
    if (options.resetStyle) anchor.style.cssText = 'padding:0;background:none;border-radius:0;min-width:0;';
    if (typeof options.setup === 'function') options.setup(anchor);
    return anchor;
}

/** Jellyfin's tag list route for a tag (prefix included). */
export function tagListRoute(tag: string, serverId: string): string {
    return `list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
}
/** SPA navigation the way Jellyfin's own links navigate, with a hash fallback. */
export function navigateRoute(route: string): void {
    const host = dashboard();
    if (host && typeof host.navigate === 'function') host.navigate(route);
    else window.location.hash = `!/${route}`;
}
/** Encodes one provider id for a request path, so a crafted id cannot reach another route. */
export function pathSegment(id: string): string {
    return encodeURIComponent(id);
}
