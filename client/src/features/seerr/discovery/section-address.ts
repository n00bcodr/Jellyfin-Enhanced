// A discovery section's filters in its page's address (address.ts): which page this is, as opposed to what its section
// shows; what the section starts on (what the address says, else nothing); what its controls are set to, written back;
// and a feed page's request with the filters asked and kept as the route needs (routeFeed).
import type { SeerrDiscoveryHost } from '../host-discovery';
import type { DiscoverySpec, FeedKind, FeedPage } from './types';

export function createSectionAddress(JE: SeerrDiscoveryHost, spec: DiscoverySpec, isClientPaged: boolean) {
    const { key } = spec;
    return {
        /** The page's address without the section's filter pairs (they change in place): which page this is. */
        pageHash: (): string => JE.discoveryAddress?.withoutOwn?.(window.location.hash) ?? window.location.hash,
        /**
         * A section starts with what its page's address says (a link, a reload, Back to it), and with nothing narrowing it
         * where the address says nothing. `offersType`: both kinds can be shown, so All / Movies / Series is offered.
         */
        start(offersType: boolean): void {
            JE.discoveryFilter?.resetFilterMode?.(key);
            JE.discoveryFilter?.resetSortMode?.(key);
            JE.discoveryAddress?.adopt?.(key, key, { withType: offersType, withSort: true, scope: isClientPaged ? 'person' : 'feed' });
        },
        /** What the section's controls are set to goes into its page's address (its entry is replaced). */
        write(): void {
            if (spec.getIdFromUrl()) JE.discoveryAddress?.write?.(key, key, true);
        },
        /**
         * A feed page's request after its base path: the page, the order, then the further filters, asked (and kept here)
         * as routeFeed says where the route names a list itself. `keep` narrows the decoded answer: a copy, never the cached one.
         */
        feed(base: string, page: number, kind: FeedKind): { readonly path: string; keep(answer: FeedPage): FeedPage } {
            const query = JE.discoveryFilter?.feedQuery?.(key, kind) ?? '';
            const routed = JE.discoveryFilters?.routeFeed?.(base, kind, JE.discoveryFilters.selectionOf?.(key) ?? {}, query) ?? { query, keep: null };
            const kept = routed.keep;
            return {
                path: `${base}?page=${page}${routed.query}`,
                keep: answer => kept ? { ...answer, results: answer.results.filter(kept) } : answer
            };
        }
    };
}
