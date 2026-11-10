/** Where the older Media Tags page's address now leads, or null for any other address. */
export function mediaTagsRedirectTarget(hash: string): string | null {
    if (hash.indexOf('name=JellyfinEnhancedMediaTags') === -1) return null;
    const params = new URLSearchParams(hash.split('?')[1] || '');
    let target = '#/configurationpage?name=' + encodeURIComponent('Jellyfin Enhanced') + '&jeSection=media-tags';
    for (const key of ['tab', 'group']) {
        const value = params.get(key);
        if (value) target += '&' + key + '=' + encodeURIComponent(value);
    }
    return target;
}
