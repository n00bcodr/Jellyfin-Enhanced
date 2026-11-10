import { cdnUrl } from '../../../host/admin-config-host';
import type { PageModules } from './modules';
import { asControl } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type RegionsDeps = Pick<PageModules, 'context'>;

export function createRegions(m: RegionsDeps) {
        // Fallback used only if the CDN regions.txt fetch fails - mirrors js/elsewhere/elsewhere.js's fallback list.
        var JE_FALLBACK_REGIONS = {
            'US': 'United States', 'GB': 'United Kingdom', 'IN': 'India', 'CA': 'Canada',
            'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'AU': 'Australia',
            'BR': 'Brazil', 'MX': 'Mexico', 'IE': 'Ireland', 'IT': 'Italy',
            'ES': 'Spain', 'NL': 'Netherlands', 'SE': 'Sweden', 'NO': 'Norway',
            'DK': 'Denmark', 'FI': 'Finland'
        };

        // Renders the Default Region <select> from a {code: name} map, preserving whichever
        // code should end up selected. Only falls back to 'US' when there was no existing
        // selection to preserve - an existing valid-but-uncommon code (e.g. one missing from
        // the small hardcoded fallback list, or if the CDN regions.txt is unreachable) is kept
        // as a synthetic option rather than silently swapped for 'US' and lost on next Save.
        function renderRegionOptions(regionsMap: Readonly<Record<string, string>>, selectedCode?: string) : void {
            const select = asControl(document.querySelector('#DEFAULT_REGION'));
            if (!select) return;
            const wanted = selectedCode ? selectedCode.toUpperCase() : 'US';
            const map = regionsMap[wanted] ? regionsMap : { ...regionsMap, [wanted]: wanted };
            while (select.firstChild) select.removeChild(select.firstChild);
            Object.entries(map)
                .sort((a, b) => a[1].localeCompare(b[1]))
                .forEach(([code, name]) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = name;
                    select.appendChild(option);
                });
            select.value = wanted;
        }

        // Populates the Default Region dropdown from the same CDN resource js/elsewhere/elsewhere.js
        // uses for its per-item region picker, so admins can only ever pick a code that TMDB's
        // watch/providers response is actually keyed by - no more free-text region typos.
        function populateRegionSelect(selectedCode?: string) : void {
            renderRegionOptions(JE_FALLBACK_REGIONS, selectedCode);
            fetch(cdnUrl('elsewhere-res/regions.txt'))
                .then(response => response.ok ? response.text() : Promise.reject())
                .then(text => {
                    const regionsMap: Record<string, string> = {};
                    text.trim().split('\n').forEach(line => {
                        if (line.startsWith('#')) return;
                        const [code, name] = line.split('\t');
                        if (code && name) regionsMap[code] = name;
                    });
                    renderRegionOptions(regionsMap, selectedCode);
                })
                .catch(() => {
                    // Already rendered with JE_FALLBACK_REGIONS above.
                });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        populateRegionSelect,
    };
}
