import type { SeerrDiscoveryHost } from '../host-discovery';
import { FILTER_MODES, isFilterMode, SORT_OPTIONS, tvSortValue } from './domain';
import type { FilterChange, FilterMode, SortChange } from './types';

const ACTIVE_BACKGROUND = 'rgba(255,255,255,0.15)';
const IDLE_BACKGROUND = 'rgba(255,255,255,0.05)';

/** Runtime-only filter and sort choices; each section starts on defaults instead of persisting them. */
export function createControls(JE: SeerrDiscoveryHost) {
    const filterModes = new Map<string, FilterMode>();
    const sortModes = new Map<string, string>();
    const getFilterMode = (name: string): FilterMode => filterModes.get(name) ?? FILTER_MODES.MIXED;
    function setFilterMode(name: string, mode: string): void {
        if (isFilterMode(mode)) filterModes.set(name, mode);
    }
    const getSortMode = (name: string): string => sortModes.get(name) || '';

    function createFilterControl(moduleName: string, onFilterChange?: FilterChange): HTMLElement {
        const currentMode = getFilterMode(moduleName);
        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-filter';
        container.style.cssText = 'display:inline-flex;gap:0;font-size:0.85em;vertical-align:middle;';
        const label = (key: string, fallback: string) => JE.t?.(key) || fallback;
        const buttons: ReadonlyArray<{ mode: FilterMode; label: string }> = [
            { mode: FILTER_MODES.MIXED, label: label('jellyseerr_discover_all', 'All') },
            { mode: FILTER_MODES.MOVIES, label: label('jellyseerr_card_badge_movie', 'Movies') },
            { mode: FILTER_MODES.TV, label: label('jellyseerr_card_badge_series', 'Series') }
        ];
        buttons.forEach((entry, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'jellyseerr-filter-btn';
            button.setAttribute('data-mode', entry.mode);
            button.textContent = entry.label;
            const radius = index === 0 ? '4px 0 0 4px' : index === buttons.length - 1 ? '0 4px 4px 0' : '0';
            const isActive = currentMode === entry.mode;
            button.style.cssText = `
                padding: 4px 10px;
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: ${radius};
                background: ${isActive ? ACTIVE_BACKGROUND : IDLE_BACKGROUND};
                color: rgba(255,255,255,0.8);
                cursor: pointer;
                font-size: inherit;
                font-family: inherit;
                margin-left: ${index > 0 ? '-1px' : '0'};
                transition: background 0.15s, border-color 0.15s;
                font-weight: ${isActive ? '600' : '400'};
            `;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (entry.mode === getFilterMode(moduleName)) return;
                setFilterMode(moduleName, entry.mode);
                for (const other of container.querySelectorAll<HTMLElement>('.jellyseerr-filter-btn')) {
                    const nowActive = other.getAttribute('data-mode') === entry.mode;
                    other.style.background = nowActive ? ACTIVE_BACKGROUND : IDLE_BACKGROUND;
                    other.style.fontWeight = nowActive ? '600' : '400';
                }
                onFilterChange?.(entry.mode);
            });
            button.addEventListener('mouseenter', () => {
                if (getFilterMode(moduleName) !== entry.mode) button.style.background = 'rgba(255,255,255,0.1)';
            });
            button.addEventListener('mouseleave', () => {
                button.style.background = getFilterMode(moduleName) === entry.mode ? ACTIVE_BACKGROUND : IDLE_BACKGROUND;
            });
            container.appendChild(button);
        });
        return container;
    }

    function createSortControl(moduleName: string, onSortChange?: SortChange): HTMLElement {
        const currentSort = getSortMode(moduleName);
        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-sort';
        container.style.cssText = 'display:inline-flex;align-items:center;gap:0.4em;font-size:0.85em;margin-left:auto;';
        const label = document.createElement('span');
        label.textContent = 'Sort:';
        label.style.cssText = 'color:rgba(255,255,255,0.5);';
        container.appendChild(label);
        const select = document.createElement('select');
        select.className = 'jellyseerr-sort-select';
        select.style.cssText = `
            background: rgba(255,255,255,0.08);
            color: rgba(255,255,255,0.85);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px;
            padding: 3px 8px;
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
            outline: none;
        `;
        for (const entry of SORT_OPTIONS) {
            const option = document.createElement('option');
            option.value = entry.value;
            option.textContent = entry.label;
            option.style.cssText = 'background:#1a1a2e;color:#fff;';
            if (currentSort === entry.value) option.selected = true;
            select.appendChild(option);
        }
        select.addEventListener('change', () => {
            sortModes.set(moduleName, select.value);
            onSortChange?.(select.value);
        });
        container.appendChild(select);
        return container;
    }

    function createSectionHeader(title: string, moduleName: string, showFilter: boolean,
        onFilterChange?: FilterChange, onSortChange?: SortChange): HTMLElement {
        const header = document.createElement('div');
        header.className = 'jellyseerr-discovery-header';
        header.style.cssText = 'display:flex;align-items:baseline;gap:1em;margin-bottom:1em;flex-wrap:wrap;width:100%;';
        const heading = document.createElement('h2');
        heading.className = 'sectionTitle sectionTitle-cards';
        heading.textContent = title;
        heading.style.margin = '0';
        header.appendChild(heading);
        if (showFilter) header.appendChild(createFilterControl(moduleName, onFilterChange));
        if (onSortChange) header.appendChild(createSortControl(moduleName, onSortChange));
        return header;
    }
    return {
        getFilterMode, setFilterMode, getSortMode,
        resetFilterMode: (name: string): void => { filterModes.delete(name); },
        getTvSortMode: (name: string): string => tvSortValue(getSortMode(name)),
        setSortMode: (name: string, sort: string): void => { sortModes.set(name, sort); },
        resetSortMode: (name: string): void => { sortModes.delete(name); },
        createFilterControl, createSortControl, createSectionHeader
    };
}

/** Filter visibility through a class on the container: fast, no DOM rebuild. */
export function applyFilterVisibility(container: HTMLElement | null, mode: string): void {
    if (!container) return;
    container.classList.remove('filter-movies', 'filter-tv');
    if (mode === FILTER_MODES.MOVIES) container.classList.add('filter-movies');
    else if (mode === FILTER_MODES.TV) container.classList.add('filter-tv');
}
export function injectFilterStyles(): void {
    if (document.getElementById('jellyseerr-filter-styles')) return;
    const style = document.createElement('style');
    style.id = 'jellyseerr-filter-styles';
    style.textContent = `
            .filter-movies [data-media-type="tv"] { display: none !important; }
            .filter-tv [data-media-type="movie"] { display: none !important; }
        `;
    document.head.appendChild(style);
}
