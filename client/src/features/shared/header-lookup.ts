// Whether the legacy header is the one to put buttons in (helpers.ts getHeaderRightContainer), read with as few
// layouts as can be (upstream abcaa16d). offsetParent needs an up-to-date layout, and the lookup runs many times while
// the page is still being built (every feature that adds a header button, every header-actions pass): each call laid
// the whole document out again. The Modern layout hides the legacy header with an inline display:none wrapper, which
// the markup alone answers; a header that is not hidden that way (the Legacy layout, a theme's own rule) is measured
// once a navigation, and only a rendered answer is kept: a header not ready yet is asked again, so early retries still
// find it.

/** The navigation core, when it has loaded. */
type NavigationSource = () => { onNavigate?: (callback: () => void) => unknown } | undefined;

/**
 * Whether an element sits inside (or is) an element hidden by its own inline `display: none`, read from the markup
 * without a style or layout pass. False says nothing: a stylesheet may still hide it.
 */
export function hiddenByInlineStyle(element: Element): boolean {
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
        if ((node as HTMLElement).style?.display === 'none') return true;
    }
    return false;
}

/** @returns A check of a legacy header that remembers a rendered answer until the next navigation. */
export function createLegacyHeaderCheck(navigation: NavigationSource): (legacy: Element & { offsetParent?: Element | null }) => boolean {
    /** The legacy header last measured as rendered; forgotten on the next navigation (the video and login pages hide it). */
    let rendered: Element | null = null;
    let watched = false;
    return legacy => {
        if (hiddenByInlineStyle(legacy)) return false;
        if (legacy !== rendered && legacy.offsetParent === null) return false;
        if (rendered !== legacy) {
            rendered = legacy;
            const onNavigate = navigation()?.onNavigate;
            if (!watched && typeof onNavigate === 'function') {
                watched = true;
                onNavigate(() => { rendered = null; });
            }
        }
        return true;
    };
}
