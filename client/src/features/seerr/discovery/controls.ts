import type { SeerrDiscoveryHost } from '../host-discovery';
import { FILTER_MODES, isFilterMode, SORT_OPTIONS, tvSortValue } from './domain';
import { createSay } from './say';
import type { FeedKind, FilterChange, FilterMode, FilterScope, SeerrResult, SortChange, TypePicker } from './types';

/** Runtime-only filter and sort choices; each section starts on defaults instead of persisting them. */
export function createControls(JE: SeerrDiscoveryHost) {
    const filterModes = new Map<string, FilterMode>();
    const sortModes = new Map<string, string>();
    // Per header's tabs: the All / Movies / Series choice, for the Filters menu to offer where the tabs are out of sight.
    const typePickers = new WeakMap<Element, TypePicker>();
    const label = createSay(JE);
    const getFilterMode = (name: string): FilterMode => filterModes.get(name) ?? FILTER_MODES.MIXED;
    function setFilterMode(name: string, mode: string): void {
        if (isFilterMode(mode)) filterModes.set(name, mode);
    }
    const getSortMode = (name: string): string => sortModes.get(name) || '';
    const getTvSortMode = (name: string): string => tvSortValue(getSortMode(name));

    /**
     * All / Movies / Series as Jellyfin's own tab buttons, so the active theme styles them.
     * Given a title (a section's header), it also carries what its row shows on a phone while the
     * header is held at the top of the screen: that title in the tabs' place. (The choice itself is
     * then in the Filters menu, beside it.)
     */
    function createFilterControl(moduleName: string, onFilterChange?: FilterChange, heldTitle?: string): HTMLElement {
        const filterLabel = label('discovery_filter_label', 'Filter');
        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-filter';
        container.setAttribute('role', 'group');
        container.setAttribute('aria-label', filterLabel);
        const buttons: ReadonlyArray<{ mode: FilterMode; label: string }> = [
            { mode: FILTER_MODES.MIXED, label: label('jellyseerr_discover_all', 'All') },
            { mode: FILTER_MODES.MOVIES, label: label('jellyseerr_quota_label_movie', 'Movies') },
            { mode: FILTER_MODES.TV, label: label('jellyseerr_quota_label_tv', 'Series') }
        ];
        /** Marks the type in use on its tab. */
        const paint = (): void => {
            const mode = getFilterMode(moduleName);
            for (const tab of container.querySelectorAll('.jellyseerr-filter-btn')) {
                const active = tab.getAttribute('data-mode') === mode;
                tab.classList.toggle('emby-tab-button-active', active);
                tab.setAttribute('aria-pressed', String(active));
            }
        };
        /** Takes a type: the tabs, the Filters button beside them, then the list. */
        const choose = (mode: string): void => {
            if (mode === getFilterMode(moduleName) || !isFilterMode(mode)) return;
            setFilterMode(moduleName, mode);
            paint();
            JE.discoveryFilters?.repaint?.(container.closest('.jellyseerr-discovery-header') ?? container);
            onFilterChange?.(mode);
        };
        for (const entry of buttons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'jellyseerr-filter-btn emby-tab-button emby-button';
            button.setAttribute('data-mode', entry.mode);
            button.textContent = entry.label;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                choose(entry.mode);
            });
            container.appendChild(button);
        }
        if (heldTitle) {
            // The heading itself is still on the page (above, out of sight): this copy is for the eye only.
            const held = document.createElement('span');
            held.className = 'jellyseerr-filter-held';
            const title = document.createElement('span');
            title.className = 'jellyseerr-filter-held-title';
            title.setAttribute('aria-hidden', 'true');
            title.textContent = heldTitle;
            held.appendChild(title);
            container.appendChild(held);
        }
        container.dataset.typeGroup = '';
        typePickers.set(container, {
            groupOf: () => ({
                id: 'type', name: label('discovery_filter_type', 'Type'),
                choices: buttons.map(entry => ({ id: entry.mode, name: entry.label, selected: entry.mode === getFilterMode(moduleName) }))
            }),
            choose,
            // (Known from what puts them out of sight, a held header at a phone's width, as the stylesheet has
            // it: their own style is no guide while they are still fading.)
            tabsShowing: () => !(container.closest('.jellyseerr-discovery-header')?.hasAttribute('data-stuck')
                && window.matchMedia?.('(max-width: 34em)').matches)
        });
        paint();
        return container;
    }

    /** The All / Movies / Series choice of a header's tabs (their container carries [data-type-group]). */
    function typePickerOf(tabs: Element | null): TypePicker | undefined {
        return tabs ? typePickers.get(tabs) : undefined;
    }

    /**
     * The sort control: a quiet text button in the filter tabs' type that names the current order
     * and opens a menu of the others (Jellyfin's action sheet, not the browser's select list).
     */
    function createSortControl(moduleName: string, onSortChange?: SortChange): HTMLElement {
        const sortLabel = label('discovery_sort_label', 'Sort');
        const nameOf = (value: string): string => {
            const entry = SORT_OPTIONS.find(option => option.value === value) ?? SORT_OPTIONS[0];
            return entry ? label(entry.labelKey, entry.label) : '';
        };
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jellyseerr-sort-btn emby-tab-button emby-button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const text = document.createElement('span');
        const chevron = document.createElement('span');
        chevron.className = 'material-icons expand_more';
        chevron.setAttribute('aria-hidden', 'true');
        button.append(text, chevron);
        /** Names the order in use. */
        const paint = (): void => {
            const current = nameOf(getSortMode(moduleName));
            text.textContent = current;
            // The visible word is the order; the label says what the button is for.
            button.setAttribute('aria-label', `${sortLabel}: ${current}`);
        };
        paint();
        button.addEventListener('click', () => {
            const current = getSortMode(moduleName);
            button.setAttribute('aria-expanded', 'true');
            JE.discoveryMenu?.openMenu({
                anchor: button, title: sortLabel, onClose: () => button.setAttribute('aria-expanded', 'false'),
                choices: SORT_OPTIONS.map(option => ({ id: option.value, name: label(option.labelKey, option.label), selected: option.value === current })),
                onPick(value) {
                    if (value === getSortMode(moduleName)) return;
                    sortModes.set(moduleName, value);
                    paint();
                    JE.discoveryBusy?.hold?.(button);
                    onSortChange?.(value);
                }
            });
        });
        return button;
    }

    /** Puts the filter in a header's bar, before the sort, so the two share a row. */
    function addFilterControl(header: Element, moduleName: string, onFilterChange?: FilterChange): void {
        const bar = header.querySelector('.jellyseerr-discovery-bar');
        if (!bar || bar.querySelector('.jellyseerr-discovery-filter')) return;
        bar.prepend(createFilterControl(moduleName, onFilterChange, header.querySelector('.sectionTitle')?.textContent || undefined));
        // On the bar for its own layout, and on the header for its compact form.
        bar.setAttribute('data-has-filter', '');
        header.setAttribute('data-has-filter', '');
    }

    /**
     * A section header: the title; under it one row: what the titles are, in words, and the controls
     * (All / Movies / Series, the Filters button, the sort). `subject`: the name the title is about, kept
     * whole when the title wraps; `scope`: which further filters the section can offer.
     */
    function createSectionHeader(title: string, moduleName: string, showFilter: boolean,
        onFilterChange?: FilterChange, onSortChange?: SortChange, subject?: string, scope: FilterScope = 'feed'): HTMLElement {
        const header = document.createElement('div');
        header.className = 'jellyseerr-discovery-header';
        // Said only when it is true: the admin's setting leaves library titles out of these sections.
        const notInLibrary = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        // The words of the line that goes to this section from the top of a long list page: what
        // pressing it does (with the title), then the rest of the phrase.
        const [lead = '', rest = ''] = (notInLibrary
            ? label('discovery_go_to_not_in_library', 'Go to {title}, not in the library')
            : label('discovery_go_to', 'Go to {title}')).split('{title}');
        header.setAttribute('data-jump-label', `${lead}${title}`);
        if (rest) header.setAttribute('data-jump-note', rest);
        // The title; under it one row: what the titles are, in words, and the controls.
        const name = document.createElement('h2');
        name.className = 'sectionTitle sectionTitle-cards';
        // The name the title is about is kept whole when the title takes two lines ("More from" / "Channel 4 Television").
        const at = subject ? title.indexOf(subject) : -1;
        if (subject && at >= 0) {
            const whole = document.createElement('span');
            whole.className = 'jellyseerr-discovery-name';
            whole.textContent = subject;
            name.append(title.slice(0, at), whole, title.slice(at + subject.length));
        } else name.textContent = title;
        const meta = document.createElement('div');
        meta.className = 'jellyseerr-discovery-meta';
        // While the header is held at the top of the screen this row shows the title in the summary's place.
        meta.setAttribute('data-title', title);
        const bar = document.createElement('div');
        bar.className = 'jellyseerr-discovery-bar';
        if (notInLibrary) {
            const summary = document.createElement('p');
            summary.className = 'jellyseerr-discovery-summary';
            summary.textContent = label('discovery_not_in_library', 'Not in the library');
            meta.appendChild(summary);
        }
        if (onSortChange) {
            // (On a genre's page that genre is given: its Genres list says so.)
            const filters = JE.discoveryFilters?.createFiltersControl?.(header, moduleName, scope,
                () => onSortChange(getSortMode(moduleName)), moduleName === 'genre' ? subject : undefined);
            if (filters) bar.appendChild(filters);
            bar.appendChild(createSortControl(moduleName, onSortChange));
        }
        meta.appendChild(bar);
        header.append(name, meta);
        if (showFilter) addFilterControl(header, moduleName, onFilterChange);
        return header;
    }

    return {
        getFilterMode, setFilterMode, getSortMode, getTvSortMode,
        /** A section starts with nothing narrowing it: neither the type nor the further filters. */
        resetFilterMode: (name: string): void => { filterModes.delete(name); JE.discoveryFilters?.reset?.(name); },
        setSortMode: (name: string, sort: string): void => { sortModes.set(name, sort); },
        resetSortMode: (name: string): void => { sortModes.delete(name); },
        createFilterControl, addFilterControl, typePickerOf, createSortControl, createSectionHeader,
        /** What a feed's request carries after its page: the order, then the further filters. */
        feedQuery(moduleName: string, kind: FeedKind): string {
            const sort = kind === 'tv' ? getTvSortMode(moduleName) : getSortMode(moduleName);
            return `${sort ? `&sortBy=${encodeURIComponent(sort)}` : ''}${JE.discoveryFilters?.feedQuery?.(moduleName, kind) ?? ''}`;
        },
        /** A person's titles as the further filters keep them (all of them when none is set). */
        keepByFilters: (moduleName: string, results: SeerrResult[]): SeerrResult[] => JE.discoveryFilters?.keep?.(moduleName, results) ?? results,
        /** Whether any further filter is narrowing a section. */
        hasMoreFilters: (moduleName: string): boolean => !!JE.discoveryFilters?.active?.(moduleName),
        /**
         * The rebuilt list takes its own height, and says so when the further filters leave it empty,
         * with the way out. `hasMore`: Seerr has more to look through, so not yet.
         */
        noteIfEmpty(moduleName: string, container: HTMLElement, hasMore: boolean): void {
            JE.discoveryBusy?.release?.(container);
            JE.discoveryFilters?.noteIfEmpty?.(moduleName, container, hasMore);
        }
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
