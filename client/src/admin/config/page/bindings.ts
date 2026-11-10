import type { PageModules } from './modules';
import { asHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type BindingsDeps = Pick<PageModules, 'context' | 'arr' | 'autoMovie' | 'depWiring' | 'load' | 'save'>;

export function createBindings(m: BindingsDeps) {
    const { form, lifecycle, page } = m.context;



    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        page.addEventListener('pageshow', m.load.loadConfig);

        form.addEventListener('submit', m.save.saveFromForm);

        m.save.resetAllUserSettingsBtn?.addEventListener('click', m.save.resetAllUserSettings);

        m.autoMovie.initAutoMovieQualityMode();

        // Live-update the Requests Page requirements banner AND the dependency
        // gates as the admin types into Seerr fields or adds/edits/removes/
        // toggles *arr instances. Without this, the *arr UI Links / Tags Sync
        // gate banners would stay up until the next form save + reload even
        // though hasAnyArrService() is already true.
        (function wireRequestsBannerReactive() {
            var formEl = asHtml(document.getElementById('JellyfinEnhancedForm'));
            if (!formEl) {
                console.error('[JE] #JellyfinEnhancedForm missing — reactive dep updates disabled');
                return;
            }
            function relevant(target: EventTarget | null): boolean {
                if (!target) return false;
                if (!(target instanceof HTMLElement)) return false;
                if (target.id === 'jellyseerrUrls' || target.id === 'JellyseerrApiKey') return true;
                return target.classList.contains('arr-instance-url')
                    || target.classList.contains('arr-instance-apikey')
                    || target.classList.contains('arr-instance-enabled');
            }
            function refresh() {
                try {
                    m.arr.updateRequestsRequirementsBanner();
                    m.depWiring.debouncedUpdateDeps();
                } catch (err) {
                    // Observer + listener callbacks must never throw — a throw
                    // here would leave gate banners frozen in their last state
                    // and keep firing on every subsequent mutation.
                    console.error('[JE] dep refresh failed', err);
                }
            }
            // `input` covers all relevant cases: per-keystroke for text/api-key
            // fields, and bubbled-from-checkbox for `.arr-instance-enabled`
            // clicks/keyboard toggles. We deliberately skip a parallel `change`
            // listener — native checkboxes fire BOTH events per toggle, which
            // would double-fire refresh() (debouncedUpdateDeps collapses it,
            // but the synchronous updateRequestsRequirementsBanner pass would
            // run twice).
            formEl.addEventListener('input', function(e) {
                if (relevant(e.target)) refresh();
            });
            // Instance add/remove happens via button clicks that mutate
            // #sonarrInstancesList / #radarrInstancesList. Observe both so the
            // banner updates immediately on remove (no input event fires).
            ['sonarrInstancesList', 'radarrInstancesList'].forEach(function(id) {
                var root = asHtml(document.getElementById(id));
                if (!root) return;
                new MutationObserver(refresh).observe(root, { childList: true, subtree: true });
            });
        })();

        // Apply the blurred background to .je-sticky-header only when the
        // surrounding scroll container has actually scrolled — at scrollTop=0
        // the header stays transparent so it doesn't cover the Jellyfin top
        // bar / user avatar. We don't know ahead of time which element
        // actually scrolls (Jellyfin's layout has several candidates: the
        // page view wrapper, body, and window — and Jellyfin's `.scrollY`
        // utility class decorates some non-scrolling nodes), so we attach
        // scroll listeners to every reasonable candidate (matching ancestor
        // + window) and read whichever reports a non-zero scroll position.
        // This IIFE runs once at script parse; the listeners persist across
        // SPA navigation since Jellyfin keeps the config page DOM alive.
        (function wireStickyHeaderScroll() {
            const header = asHtml(document.querySelector('.je-sticky-header'));
            if (!header) return;
            // Collect all overflow-y:auto|scroll ancestors as scroll-candidate
            // nodes. We don't trust scrollHeight>clientHeight at bind time
            // (async content hasn't landed yet); we don't pick just the
            // first match (Jellyfin's .scrollY utility flags decorative
            // containers that don't actually scroll). Listening on all
            // matches plus window means whichever actually scrolls drives
            // the class toggle.
            function findScrollCandidates(el: Element | null): Element[] {
                var nodes: Element[] = [];
                var node = el && el.parentElement;
                while (node && node !== document.body) {
                    var oy = getComputedStyle(node).overflowY;
                    if (oy === 'auto' || oy === 'scroll') nodes.push(node);
                    node = node.parentElement;
                }
                return nodes;
            }
            // Filled in the first frame (below): getComputedStyle on every
            // ancestor here, in the middle of the page's insertion, forced a
            // style pass over the whole page.
            var candidates: Element[] = [];
            var ticking = false;
            function currentScrollTop() {
                var winTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
                var contTop = 0;
                for (var i = 0; i < candidates.length; i++) {
                    var n = candidates[i];
                    if (!n) continue;
                    // Skip detached nodes: their scrollTop freezes at the last
                    // value, which would incorrectly pin `.je-is-scrolled` on
                    // after the live scroller returns to top.
                    if (!n.isConnected) continue;
                    var t = n.scrollTop || 0;
                    if (t > contTop) contTop = t;
                }
                return winTop > contTop ? winTop : contTop;
            }
            function read(): void {
                try {
                    if (!header) return;
                    header.classList.toggle('je-is-scrolled', currentScrollTop() > 4);
                } catch (e) {
                    console.warn('[JE] sticky-header read failed:', e);
                } finally {
                    // Guarantees the rAF pipeline doesn't wedge on `ticking` if read() throws.
                    ticking = false;
                }
            }
            function onScroll() {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(read);
            }
            // Always listen on window (document-scrolling layouts) and on
            // each overflow-declared ancestor (mid-tree scrollers).
            window.addEventListener('scroll', onScroll, { signal: lifecycle.signal, passive: true });
            // The ancestors and the first read in the next frame, before it
            // paints (so the header's first frame is already right): reading
            // scrollTop here forced a full layout of the settings page (~0.5 s
            // on first open) that its first paint then does anyway.
            requestAnimationFrame(function() {
                candidates = findScrollCandidates(header);
                if (candidates.length === 0) {
                    console.warn('[JE] sticky-header: no overflow:auto|scroll ancestors found; relying on window scroll only.');
                }
                candidates.forEach(function(n) {
                    n.addEventListener('scroll', onScroll, { passive: true });
                });
                read();
            });
        })();
    }

    return {
        wire,

    };
}
