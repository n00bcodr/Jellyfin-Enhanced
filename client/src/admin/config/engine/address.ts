/**
 * The configuration page's address keeps the tab and card shown (#/configurationpage?name=Jellyfin%20Enhanced&tab=seerr&card=requests;
 * jeSection=media-tags&tab=<its section> for the Media Tags tab), so a reload or a shared link returns there (upstream b0a8a963).
 */
const PAGE_NAME = 'Jellyfin Enhanced';

/** A card's name in the address: its title in lower case, other characters between words as one hyphen. */
export function slugOf(text: string | null | undefined): string {
    return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Set one parameter of this page's address, or remove it when there is no value, without navigating. Only while the
 * address is this page's: work that finishes after the administrator moved on leaves the next page's address alone.
 */
export function setHash(key: string, value: string | null | undefined): void {
    const [path = '', query = ''] = window.location.hash.split('?');
    if (!path.includes('configurationpage')) return;
    const params = new URLSearchParams(query);
    if (params.get('name') !== PAGE_NAME) return;
    if ((params.get(key) ?? '') === (value ?? '')) return;
    if (value) params.set(key, value); else params.delete(key);
    // The router's own history entry state stays as it is; only the address changes. A space is written %20, as
    // Jellyfin's own links write the page name (URLSearchParams writes `+`; a `+` in a value is %2B) (upstream 5201d47b).
    window.history.replaceState(window.history.state, '', path + '?' + params.toString().replace(/\+/g, '%20'));
}
