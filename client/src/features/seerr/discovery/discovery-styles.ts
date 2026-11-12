// The stylesheet of the Seerr discovery sections: the header and its join with the page, the filter tabs
// and the sort, the line that goes to a section, the sort and filter menus, a section's place while it
// loads, and the line that says Seerr did not answer (also the scroll engine's retry row). The further
// filters' own rules (filter-panel.ts), the busy state (busy.ts) and the role line (roles.ts) inject
// their own. Published as JE.discoveryStyles { inject }.
import discoveryCss from './discovery.css';

/** Adds a stylesheet to the page once, under its id. */
export function injectStyleOnce(id: string, css: string): void {
    if (typeof document === 'undefined' || !document.head || document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}

/** Adds the discovery sections' stylesheet to the page (once). */
export function injectDiscoveryStyles(): void {
    injectStyleOnce('jellyseerr-discovery-styles', discoveryCss);
}
