// The section's side of the further filters: the Filters button beside the sort, its menu, the line of
// what is set, the note when nothing matches, and the further-filter selection and the person's titles
// seen, per section (by module name). The pure logic is in filters.ts, the lists in filter-data.ts and
// the menu's groups in filter-groups.ts. Published, with them, as JE.discoveryFilters.
import type { SeerrDiscoveryHost } from '../host-discovery';
import panelCss from './discovery-filter-panel.css';
import { injectStyleOnce } from './discovery-styles';
import { createFilterData } from './filter-data';
import { filterMenuGroups, filterTokens } from './filter-groups';
import {
    activeFilterCount, dayOf, feedFilterQuery, FILTER_SWITCHES, isBound, isReversed, keepByFilters, numberOf, offeredFilters, rolesOf
} from './filters';
import type {
    DiscoveryFiltersFacade, FeedKind, FilterData, FilterScope, FilterSelection, MenuGroup, Say, SeerrResult
} from './types';

export function createFilterPanel(JE: SeerrDiscoveryHost, label: Say): DiscoveryFiltersFacade {
    // The further filters set in a section, by module name.
    const moreFilters = new Map<string, FilterSelection>();
    /** The section's selection (empty when nothing is set). */
    const selectionOf = (name: string): FilterSelection => moreFilters.get(name) ?? {};
    // A person's titles as last given to be filtered: what the Role list is made of.
    const credits = new Map<string, SeerrResult[]>();
    // Per header: redraws its Filters button, and reloads its list after a change made outside the menu.
    // (`paint(at)`: the keys were on what is being taken away; they go on to the piece at that place, or to the Filters button.)
    const wiring = new WeakMap<Element, { paint(at?: number): void; reload(): void }>();
    let filterData: FilterData | null = null;

    /** The region whose services and ratings are offered: the admin's default region, else the US. */
    function adminRegion(): string {
        const region = String(JE.pluginConfig?.DEFAULT_REGION ?? '').trim().toUpperCase();
        return /^[A-Z]{2}$/.test(region) ? region : 'US';
    }
    /** The lists the filters offer, kept for the visit (made anew only should the admin's region change). */
    function dataOf(): FilterData {
        const region = adminRegion();
        if (!filterData || filterData.region !== region) {
            filterData = createFilterData({
                region,
                // The lists the further filters offer are asked for like every other lookup of these sections.
                fetch: (path, options) => JE.discoveryFilter?.fetchWithManagedRequest
                    ? JE.discoveryFilter.fetchWithManagedRequest(path, 'filters', options)
                    : Promise.reject(new Error('Discovery requests are not available')),
                fetchGenres: kind => JE.discoveryFilter?.fetchTmdbGenreList
                    ? JE.discoveryFilter.fetchTmdbGenreList(kind)
                    : Promise.reject(new Error('Discovery requests are not available'))
            });
        }
        return filterData;
    }
    /** The All choice of All / Movies / Series. */
    const MIXED = (): string => JE.discoveryFilter?.MODES?.MIXED ?? 'mixed';
    /** The section's All / Movies / Series choice. */
    const filterModeOf = (name: string): string => JE.discoveryFilter?.getFilterMode?.(name) ?? MIXED();
    /** Whether an id is one of All / Movies / Series. */
    const isFilterMode = (id: string): boolean =>
        (Object.values(JE.discoveryFilter?.MODES ?? { MIXED: 'mixed', MOVIES: 'movies', TV: 'tv' }) as string[]).includes(id);

    /** Where the page stands when a section's header is held at the top of the screen, just so. */
    function heldAt(section: HTMLElement, header: HTMLElement): number {
        if (typeof JE.discoveryBusy?.heldAt === 'function') return JE.discoveryBusy.heldAt(section, header);
        const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
        const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
        return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
    }

    /**
     * While the Filters menu is open its section is at least as tall as the screen under Jellyfin's
     * bar. The menu hangs from the section's header: a list a filter has made short (or empty) would
     * otherwise let the page fall back under the open menu and take the header, and the menu, down
     * the screen. So the header can always be brought to the top, and stays where it is.
     */
    function roomUnderMenu(section: HTMLElement | null, header: HTMLElement, open: boolean): void {
        if (!section) return;
        const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
        const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
        section.style.minHeight = open ? `${Math.ceil(window.innerHeight - bar + tuck + 4)}px` : '';
    }

    /**
     * The Filters button: Jellyfin's own filter icon, beside the sort. Its menu holds the section's
     * further filters as groups (see filterMenuGroups), less the ones the admin turned off, and
     * All / Movies / Series too where the tabs are out of sight. While anything it holds is narrowing
     * the list it is in the accent with a dot (as Jellyfin marks its own filter button), and what is
     * set is said in words on a line under the header, each piece with the way to take it away.
     */
    function createFiltersControl(header: HTMLElement, moduleName: string, scope: FilterScope, onChange: () => void,
        ownGenre?: string): HTMLButtonElement {
        injectStyleOnce('jellyseerr-discovery-filter-panel-styles', panelCss);
        const filtersLabel = label('discovery_filters', 'Filters');
        const clearLabel = label('discovery_filters_clear', 'Clear filters');
        /** The page's language. */
        const localeOf = (): string => document.documentElement.lang || 'en';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jellyseerr-filters-btn emby-tab-button emby-button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        const icon = document.createElement('span');
        icon.className = 'material-icons filter_alt';
        icon.setAttribute('aria-hidden', 'true');
        // On a phone, held, the tabs are out of sight: a choice other than All is then said beside the icon ("Movies").
        const typeWord = document.createElement('span');
        typeWord.className = 'jellyseerr-filters-type';
        // The button's name is what it holds: its own name (out of sight; the icon says it to the eye), with how many
        // filters are set, and the type's word where that shows. So what a screen reader hears is what is seen.
        const name = document.createElement('span');
        name.className = 'jellyseerr-filters-name';
        // (A space between the two, for a reader that would run them together; it takes no room in the button.)
        button.append(icon, name, ' ', typeWord);
        const offered = offeredFilters(scope, JE.pluginConfig);
        /** The header's All / Movies / Series picker, where the header has the tabs. */
        const typeOf = () => {
            const tabs = header.querySelector('[data-type-group]');
            return tabs ? JE.discoveryFilter?.typePickerOf?.(tabs) : undefined;
        };
        /** The section the header is in. */
        const sectionOf = (): HTMLElement | null => header.closest<HTMLElement>('.jellyseerr-discovery-section');
        /** The line of what is set, under the header (it is not held with it): made, redrawn, or taken away. */
        const paintSet = (focusAt = -1): void => {
            const section = sectionOf();
            let line = section?.querySelector<HTMLElement>('.jellyseerr-filters-set') ?? null;
            const tokens = filterTokens({ offered, label, locale: localeOf(), selection: selectionOf(moduleName) });
            // (Redrawn with the keys on one of its buttons, as after the list it narrowed is in: they stay at that place.)
            const focused = document.activeElement;
            const keyedAt = line && focusAt < 0 && focused instanceof HTMLButtonElement ? Array.from(line.querySelectorAll('button')).indexOf(focused) : -1;
            if (!section || tokens.length === 0) {
                line?.remove();
                if (focusAt >= 0 || keyedAt >= 0) button.focus();
                return;
            }
            if (!line) {
                line = document.createElement('div');
                line.className = 'jellyseerr-filters-set';
                line.setAttribute('role', 'group');
                line.setAttribute('aria-label', filtersLabel);
                header.after(line);
            }
            const removes: HTMLButtonElement[] = [];
            const pieces = tokens.map((token, index) => {
                const piece = document.createElement('span');
                piece.className = 'jellyseerr-filters-token';
                const words = document.createElement('span');
                words.dir = 'auto';
                words.textContent = token.words;
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'jellyseerr-filters-remove';
                const removeLabel = label('discovery_filter_remove', 'Remove: {filter}', { filter: token.words });
                remove.setAttribute('aria-label', removeLabel);
                remove.title = removeLabel;
                const cross = document.createElement('span');
                cross.className = 'material-icons close';
                cross.setAttribute('aria-hidden', 'true');
                remove.appendChild(cross);
                // (Taken away with the keys, the next piece's own button has them; with none left, the Filters button.)
                remove.addEventListener('click', () => change(token.without(selectionOf(moduleName)), document.activeElement === remove ? index : -1));
                removes.push(remove);
                piece.append(words, remove);
                return piece;
            });
            if (tokens.length > 1) {
                const all = document.createElement('button');
                all.type = 'button';
                all.className = 'jellyseerr-filters-clear';
                all.textContent = clearLabel;
                all.addEventListener('click', () => change({}, document.activeElement === all ? 0 : -1));
                pieces.push(all);
            }
            line.replaceChildren(...pieces);
            if (focusAt >= 0) (removes[Math.min(focusAt, removes.length - 1)] ?? button).focus();
            else if (keyedAt >= 0) {
                const again = line.querySelectorAll('button');
                (again[Math.min(keyedAt, again.length - 1)] ?? button).focus();
            }
        };
        /** Redraws the button, the role lines it steers, and the line of what is set. */
        const paint = (focusAt = -1): void => {
            const set = activeFilterCount(selectionOf(moduleName));
            const typed = filterModeOf(moduleName) === MIXED() ? 0 : 1;
            button.toggleAttribute('data-on', set > 0);
            // (All / Movies / Series shows on the button only where the tabs are out of sight: the stylesheet's part.)
            button.toggleAttribute('data-type-on', typed > 0);
            typeWord.textContent = typed > 0 ? typeOf()?.groupOf().choices?.find(choice => choice.selected)?.name ?? '' : '';
            // With nothing of its own to offer it is only for the place where the tabs are out of sight.
            button.toggleAttribute('data-type-only', offered.length === 0);
            name.textContent = set > 0 ? `${filtersLabel}: ${set}` : filtersLabel;
            // Asked for by a job (Directing) and not for acting, a title's jobs come before its part on the card.
            const roles = selectionOf(moduleName).role ?? [];
            const section = sectionOf();
            JE.discoveryBusy?.mark?.(section);
            section?.toggleAttribute('data-jobs-first', roles.length > 0 && !roles.some(role => role.id === 'cast'));
            // And among the jobs, the ones asked for lead ("Director, Writer" for Directing): a line that does not fit loses jobs from its end.
            if (section) {
                section.setAttribute(JE.discoveryRoles?.ROLE_ASKED ?? 'data-role-asked', roles.map(role => role.id).join('|'));
                JE.discoveryRoles?.fitRoleLines?.(section);
            }
            paintSet(focusAt);
        };
        wiring.set(header, { paint: (at = -1) => paint(at), reload: onChange });
        paint();
        /** Takes a new selection: redraws, keeps the list's place while it is rebuilt, and reloads it. */
        function change(next: FilterSelection, focusAt = -1): void {
            if (activeFilterCount(next) > 0) moreFilters.set(moduleName, next); else moreFilters.delete(moduleName);
            paint(focusAt);
            JE.discoveryBusy?.hold?.(button);
            onChange();
        }
        /** Opens the Filters menu under the button. */
        const open = (): void => {
            const menu = JE.discoveryMenu;
            const type = typeOf();
            const typeInMenu = !!type && !type.tabsShowing();
            // Where the tabs are out of sight the viewer may have come for them: that group is open.
            const groups: MenuGroup[] = type && typeInMenu ? [{ ...type.groupOf(), open: true }] : [];
            groups.push(...filterMenuGroups(JE, {
                offered, data: dataOf(), locale: localeOf(), label,
                selection: () => selectionOf(moduleName), change, ...(ownGenre ? { ownGenre } : {}),
                roles: () => rolesOf(credits.get(moduleName) ?? [], label('discovery_role_acting', 'Acting'),
                    department => label(`discovery_role_${department.toLowerCase().replace(/[^a-z]+/g, '_')}`, department))
            }));
            if (groups.length === 0 || typeof menu?.openMenu !== 'function') { roomUnderMenu(sectionOf(), header, false); return; }
            button.setAttribute('aria-expanded', 'true');
            menu.openMenu({
                anchor: button, title: filtersLabel, groups, clearLabel, doneLabel: label('discovery_filters_done', 'Done'),
                onClose: () => { button.setAttribute('aria-expanded', 'false'); roomUnderMenu(sectionOf(), header, false); },
                // The groups that are a list of choices; the others set themselves (filterMenuGroups).
                onPick(id, groupId) {
                    if (groupId === 'type' && isFilterMode(id)) type?.choose(id);
                },
                onClear() {
                    if (typeInMenu) type?.choose(MIXED());
                    if (activeFilterCount(selectionOf(moduleName)) > 0) change({});
                }
            });
        };
        button.addEventListener('click', () => {
            // The menu hangs from this button and is as tall as the room under it. With too little
            // room there (the section begins low on the screen), the section's header is first
            // brought to the top of the screen, where it is held: the menu then has the screen's height.
            const section = sectionOf();
            const tv = document.documentElement.classList.contains('layout-tv');
            if (!tv) roomUnderMenu(section, header, true);
            const room = window.innerHeight - button.getBoundingClientRect().bottom - 12;
            const wanted = JE.discoveryMenu?.groupedMenuRoom?.(offered.length + 1) ?? 0;
            const to = section && !tv && room < wanted ? Math.round(heldAt(section, header)) : 0;
            if (to <= window.scrollY + 1) { open(); return; }
            const before = window.scrollY;
            window.scrollTo({ top: to });
            if (Math.abs(window.scrollY - before) < 1) { open(); return; }
            // (The join sees the header held on the next frame: only then is it known whether the tabs are in sight.)
            requestAnimationFrame(() => requestAnimationFrame(open));
        });
        return button;
    }

    /**
     * Says so when the further filters leave a section's list empty, with the way out. (Without it
     * the header would stand over nothing.) `hasMore`: Seerr has more to look through, so not yet.
     */
    function noteIfEmpty(moduleName: string, container: HTMLElement | null | undefined, hasMore: boolean): void {
        if (!container) return;
        const section = container.closest('.jellyseerr-discovery-section');
        JE.discoveryBusy?.release?.(container);
        // (The line of what is set needs the section on the page: a header made with filters set gets its line here.)
        const headerOf = (): Element => section?.querySelector('.jellyseerr-discovery-header') ?? container;
        wiring.get(headerOf())?.paint();
        section?.querySelector('.jellyseerr-filters-none')?.remove();
        if (hasMore || activeFilterCount(selectionOf(moduleName)) === 0 || container.querySelector('.card')) return;
        const buildMessageRow = JE.discoverySection?.buildMessageRow;
        if (typeof buildMessageRow !== 'function') return;
        const note = buildMessageRow({
            message: label('discovery_filters_none', 'Nothing matches these filters.'),
            actionLabel: label('discovery_filters_clear', 'Clear filters'),
            onAction() {
                const wired = wiring.get(headerOf());
                // (This line goes when the new list is in, and its button with it: keys that were on it go to the Filters button now.)
                const keyed = note.contains(document.activeElement);
                moreFilters.delete(moduleName);
                wired?.paint(keyed ? 0 : -1);
                wired?.reload();
            }
        });
        note.classList.add('jellyseerr-filters-none');
        container.after(note);
    }

    injectStyleOnce('jellyseerr-discovery-filter-panel-styles', panelCss);
    return {
        FILTER_SWITCHES, offeredFilters, activeFilterCount, dayOf, numberOf, isBound, isReversed, feedFilterQuery,
        keepByFilters, rolesOf, createFilterData,
        createFiltersControl,
        /** What a feed's request carries for the section's further filters (the sort is the caller's). */
        feedQuery: (name: string, kind: FeedKind) => feedFilterQuery(selectionOf(name), kind, adminRegion()),
        /** A person's titles the section's filters keep; the titles are also kept as what the Role list is made of. */
        keep(name, results) {
            credits.set(name, results);
            return keepByFilters(results, selectionOf(name));
        },
        /** Whether any further filter is narrowing the section's list. */
        active: name => activeFilterCount(selectionOf(name)) > 0,
        /** A section starts with nothing narrowing it: its further filters and the titles seen go. */
        reset(name) {
            moreFilters.delete(name);
            credits.delete(name);
        },
        /** Redraws a header's Filters button (after All / Movies / Series changed); `element` is the header or inside it. */
        repaint(element) {
            if (!element) return;
            wiring.get(element.closest?.('.jellyseerr-discovery-header') ?? element)?.paint();
        },
        noteIfEmpty,
        roomUnderMenu,
        filterMenuGroups: options => filterMenuGroups(JE, options),
        filterTokens,
        /** The section's selection, for tests and the facade. */
        selectionOf
    };
}
