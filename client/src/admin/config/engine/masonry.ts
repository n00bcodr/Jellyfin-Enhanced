import type { MountLifecycle } from './lifecycle';

// Packed columns that stay put. Each card is given a column once (shortest column first, when a tab is shown,
// resized, or leaves search/focus mode) and keeps it. Rows are 1px tracks, so a card spans its own height:
// when one grows, only the cards below it in the same column move.
const GAP = 20;
const MIN_COL = 500;

interface Placement { column?: number; watched?: boolean }
const placements = new WeakMap<Element, Placement>();
const tabColumns = new WeakMap<Element, number>();

function placementOf(element: Element): Placement {
    let placement = placements.get(element);
    if (!placement) placements.set(element, placement = {});
    return placement;
}

const isWide = (element: Element): boolean => element.tagName !== 'FIELDSET' || element.matches('.je-fieldset-wide, .je-overview-section');
const heightOf = (element: Element): number => element.getBoundingClientRect().height;
const htmlChildren = (tab: Element): HTMLElement[] => Array.from(tab.children).filter((c): c is HTMLElement => c instanceof HTMLElement);

function unpack(tab: HTMLElement): void {
    if (!tab.classList.contains('jea-masonry')) return;
    tab.classList.remove('jea-masonry');
    tab.style.removeProperty('--jea-cols');
    htmlChildren(tab).forEach(element => { element.style.gridColumn = ''; element.style.gridRow = ''; });
}

function layoutTab(tab: HTMLElement, repackRequested: boolean): void {
    const form = document.getElementById('JellyfinEnhancedForm');
    if (!tab.classList.contains('active') || tab.id === 'docs' || tab.classList.contains('jea-focused') || (form && form.classList.contains('je-search-mode'))) {
        unpack(tab);
        return;
    }
    let repack = repackRequested;
    const columns = Math.max(1, Math.floor((tab.clientWidth + GAP) / (MIN_COL + GAP)));
    if (tabColumns.get(tab) !== columns) { repack = true; tabColumns.set(tab, columns); }
    if (!tab.classList.contains('jea-masonry')) tab.classList.add('jea-masonry');
    tab.style.setProperty('--jea-cols', String(columns));
    const items = htmlChildren(tab).filter(element => getComputedStyle(element).display !== 'none');
    if (repack) {
        items.forEach(element => {
            element.style.gridColumn = isWide(element) ? '1 / -1' : '1';
            element.style.gridRow = 'auto';
            delete placementOf(element).column;
        });
    }
    const ends = new Array<number>(columns).fill(0);
    items.forEach(element => {
        const height = Math.ceil(heightOf(element));
        if (isWide(element)) {
            const start = Math.max(...ends);
            element.style.gridColumn = '1 / -1';
            element.style.gridRow = (start + 1) + ' / span ' + (height + GAP);
            ends.fill(start + height + GAP);
            return;
        }
        const placement = placementOf(element);
        if (placement.column === undefined) {
            placement.column = ends.indexOf(Math.min(...ends));
            element.style.gridColumn = String(placement.column + 1);
        }
        const column = placement.column;
        const end = ends[column] ?? 0;
        element.style.gridRow = (end + 1) + ' / span ' + (height + GAP);
        ends[column] = end + height + GAP;
    });
}

export function initMasonry(lifecycle: MountLifecycle): void {
    const form = document.getElementById('JellyfinEnhancedForm');
    if (!form || typeof ResizeObserver === 'undefined') return;
    const activeTabs = (): NodeListOf<HTMLElement> => form.querySelectorAll<HTMLElement>('.jellyfin-tab-content.active');
    let pending: { repack: boolean } | null = null;
    const schedule = (repack: boolean): void => {
        if (pending) { pending.repack = pending.repack || repack; return; }
        pending = { repack };
        lifecycle.frame(() => {
            const request = pending;
            pending = null;
            activeTabs().forEach(tab => layoutTab(tab, request?.repack ?? false));
        });
    };
    const resizes = lifecycle.track(new ResizeObserver(() => schedule(false)));
    const watch = (tab: Element): void => htmlChildren(tab).forEach(element => {
        const placement = placementOf(element);
        if (!placement.watched) { placement.watched = true; resizes.observe(element); }
    });
    form.querySelectorAll<HTMLElement>('.jellyfin-tab-content').forEach(tab => {
        watch(tab);
        // Showing, focusing or unfocusing a tab repacks it before the browser paints.
        let signature = tab.className.replace(/jea-masonry/g, '').trim();
        lifecycle.track(new MutationObserver(() => {
            // Our own jea-masonry class change must not retrigger the layout.
            const now = tab.className.replace(/jea-masonry/g, '').trim();
            if (now !== signature) { signature = now; layoutTab(tab, true); }
        })).observe(tab, { attributes: true, attributeFilter: ['class'] });
        // Late additions (dependency banners, dashboards) join the flow.
        lifecycle.track(new MutationObserver(() => { watch(tab); schedule(false); })).observe(tab, { childList: true });
    });
    lifecycle.track(new MutationObserver(() => activeTabs().forEach(tab => layoutTab(tab, true)))).observe(form, { attributes: true, attributeFilter: ['class'] });
    let timer: number | undefined;
    window.addEventListener('resize', () => {
        window.clearTimeout(timer);
        timer = lifecycle.timeout(() => schedule(true), 120);
    }, { signal: lifecycle.signal });
    activeTabs().forEach(tab => layoutTab(tab, true));
}
