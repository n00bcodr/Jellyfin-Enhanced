// A discovery controller's section: built around its header, put in its place on the page, and the row
// that says a lookup failed. The parts come from JE.discoverySection, read at call time (the controller
// is bundled apart from it); without it the same parts are built here, with no join.
import { filterOf, type SeerrDiscoveryHost } from '../host-discovery';
import { createSay } from './say';
import type { FilterChange, SectionPage, SortChange } from './types';

export interface ChassisOptions {
    readonly key: string;
    readonly page: SectionPage;
    /** The client-paged machine (a person's titles), whose further filters differ from a feed's. */
    readonly personScope: boolean;
}

export function createSectionChassis(JE: SeerrDiscoveryHost, { key, page, personScope }: ChassisOptions) {
    const label = createSay(JE);

    /** The section with its header (the title, then a row with the filter and sort controls). `name`: the name the title is about. */
    function createSectionContainer(title: string, showFilter: boolean, onFilterChange: FilterChange, onSortChange: SortChange,
        name?: string): HTMLElement {
        const header = filterOf(JE).createSectionHeader(title, key, showFilter, onFilterChange, onSortChange, name,
            personScope ? 'person' : 'feed');
        if (JE.discoverySection?.buildSection) return JE.discoverySection.buildSection({ key, page, header });
        // (Without the section module: the same parts, with no join.)
        const section = document.createElement('div');
        section.className = `verticalSection jellyseerr-${key}-discovery-section jellyseerr-discovery-section${page === 'list' ? '' : ' detailVerticalSection'}`;
        section.setAttribute(`data-jellyseerr-${key}-discovery`, 'true');
        section.appendChild(header);
        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'itemsContainer vertical-wrap';
        section.appendChild(itemsContainer);
        return section;
    }

    /** Puts the section in its place on the page (see JE.discoverySection.placeSection). */
    function placeInPage(anchor: HTMLElement, section: HTMLElement): boolean {
        if (JE.discoverySection?.placeSection) return JE.discoverySection.placeSection(anchor, section, page);
        // (Without the section module: the same place, with no join.)
        if (page === 'detail') {
            const view = anchor.closest<HTMLElement>('.itemDetailPage') ?? anchor;
            (view.querySelector<HTMLElement>('.detailPagePrimaryContent .detailSection') ?? anchor).appendChild(section);
            return true;
        }
        const own = anchor.closest('.verticalSection');
        const wrapper = own ? own.parentElement : anchor.parentElement;
        if (!wrapper) return false;
        wrapper.appendChild(section);
        return true;
    }

    /** Places the section; its header keeps to the top of the screen, just under Jellyfin's own, while it is read. */
    function place(anchor: HTMLElement, section: HTMLElement): boolean {
        if (!placeInPage(anchor, section)) return false;
        section.style.setProperty('--jellyseerr-sticky-top', `${Math.max(0, Math.round(JE.helpers?.getHeaderBottom?.() ?? 0))}px`);
        return true;
    }

    /** A section that says Seerr did not answer, with a button to try again (null without the section module). */
    function buildRetrySection(onAction: () => void): HTMLElement | null {
        if (!JE.discoverySection?.buildRetrySection) return null;
        return JE.discoverySection.buildRetrySection(key, label('discovery_load_failed', 'Seerr did not answer.'),
            label('discovery_retry', 'Try again'), onAction);
    }

    /** The cards that hold a list section's place until its first page lands (none without the section module). */
    function placeholders(cardClass: string): DocumentFragment | null {
        const parts = JE.discoverySection;
        return parts?.buildPlaceholderCards ? parts.buildPlaceholderCards(parts.PLACEHOLDER_CARDS, cardClass) : null;
    }

    return { createSectionContainer, placeInPage, place, buildRetrySection, placeholders };
}
