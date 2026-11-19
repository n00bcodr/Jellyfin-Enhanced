// The blurred backdrop of status tags (upstream abcaa16d, tags/statustags.js "The blurred backdrop"). A status tag is
// a 72% dark pill over the card's artwork, and the artwork behind it is blurred. That blur is a picture painted under
// the tag by the status-tag painter (types/status/backdrop/, JE.statusTagBackdrop), a component group of its own that is
// fetched when the first status tag is drawn: a page that shows none never downloads it. A tag does not wait for it: it
// is drawn at once with the live backdrop filter (`data-je-blur` on its host), which the painter takes off once its
// picture stands in.

/** The component group holding the painter (js/component-groups.json). */
const BACKDROP_GROUP = 'tag-status-backdrop';
/** After a request that brought no painter, the next one waits this long, doubling up to the cap (ms). */
const BACKDROP_RETRY_MS = 5000;
const BACKDROP_RETRY_MAX_MS = 60000;

/** What the request reads from the tag runtime. */
export interface BackdropRequestHost {
    statusTagBackdrop?: { track(host: HTMLElement): void } | undefined;
    loader?: { ensure(ids: string[], options?: { pace?: 'boot' | 'background' | 'now' }): Promise<unknown>; state?(): Record<string, string> } | undefined;
    core?: { tagLayout?: { syncFlowOf?(host: HTMLElement): void } | undefined };
}

/**
 * The status tags' side of the painter: have a card's tags backed by their picture, asking the loader for the painter
 * the first time one is drawn.
 * @param tagClass - The class of a status tag.
 */
export function createBackdropRequest(JE: BackdropRequestHost, tagClass: string) {
    /** True while a request for the painter is out. */
    let backdropAsked = false;
    /** The pause before the next request (0 until one failed), when it ends (ms since the epoch) and its timer. */
    let backdropPause = 0;
    let backdropNotBefore = 0;
    let backdropTimer: ReturnType<typeof setTimeout> | 0 = 0;

    /**
     * Have the status tag of a card backed by its blurred picture: by the painter when it is loaded, otherwise once it
     * has arrived (it takes up every status tag on the page when it starts).
     * @param host - The card's .je-tag-host.
     */
    function trackBackdrop(host: HTMLElement | null): void {
        if (!host) return;
        if (JE.statusTagBackdrop) {
            JE.statusTagBackdrop.track(host);
            return;
        }
        // No painter (yet): the tag has the live filter, as it always had. The painter takes the mark off once its
        // picture stands in; without one (a failure, no loader) it stays.
        if (host.dataset.jeBlur !== '1') {
            host.dataset.jeBlur = '1';
            JE.core?.tagLayout?.syncFlowOf?.(host);
        }
        if (Date.now() >= backdropNotBefore) askForBackdrop();
    }

    /**
     * Ask the loader for the painter, once at a time. It is fetched like the boot bundle, when the page is idle and at
     * low priority: the tags are drawn already, and their pictures can wait for the page. A request that brings
     * nothing (offline, a server that restarted) is made again after a pause that doubles, by the next tag drawn or, on
     * a page that has settled, by a timer while a status tag is still there.
     */
    function askForBackdrop(): void {
        const loader = JE.loader;
        if (backdropAsked || JE.statusTagBackdrop || typeof loader?.ensure !== 'function') return;
        backdropAsked = true;
        if (backdropTimer) clearTimeout(backdropTimer);
        backdropTimer = 0;
        let asked: Promise<unknown>;
        try {
            asked = Promise.resolve(loader.ensure([BACKDROP_GROUP], { pace: 'boot' }));
        } catch {
            asked = Promise.resolve();
        }
        asked.catch(() => {}).then(() => {
            backdropAsked = false;
            if (JE.statusTagBackdrop) return;
            // The group ran and left no painter (its file threw): asking again would bring nothing.
            let ran = false;
            try { ran = loader.state?.()[BACKDROP_GROUP] === 'ready'; } catch { ran = false; }
            if (ran) { backdropNotBefore = Infinity; return; }
            backdropPause = Math.min(BACKDROP_RETRY_MAX_MS, backdropPause ? backdropPause * 2 : BACKDROP_RETRY_MS);
            backdropNotBefore = Date.now() + backdropPause;
            backdropTimer = setTimeout(() => {
                backdropTimer = 0;
                if (document.querySelector(`.je-tag-host .${tagClass}`)) askForBackdrop();
            }, backdropPause);
        });
    }

    /** The .je-tag-host a render target's badges are placed in (the layout controller's), if it has one. */
    function hostOf(el: HTMLElement): HTMLElement | null {
        if (el.classList?.contains('je-tag-host')) return el;
        const host = Array.from(el.children || []).find((child) => child.classList.contains('je-tag-host'));
        return host instanceof HTMLElement ? host : null;
    }

    return { trackBackdrop, hostOf };
}

/**
 * A filtered tag is a compositor layer and promotes whatever paints over it. On a card, a resting tag has the blurred
 * artwork painted under it as a picture instead: its host carries data-je-blur for as long as the live filter has to
 * stand in. Tags drawn anywhere else (a sample, a caption) keep the filter.
 */
export const backdropStyles = (tagClass: string): string => `
                .je-tag-host:not([data-je-blur]) .${tagClass} {
                    -webkit-backdrop-filter: none;
                    backdrop-filter: none;
                }`;
