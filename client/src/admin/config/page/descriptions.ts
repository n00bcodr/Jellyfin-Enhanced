import type { PageModules } from './modules';
import { asHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type DescriptionsDeps = Pick<PageModules, 'context'>;

export function createDescriptions(m: DescriptionsDeps) {
            // === Setting-description visibility toggle ===
            // Some admins want the full explanatory text under every setting;
            // others (who know the plugin) want a compact page. Persist the
            // preference in localStorage, default visible, expose a header
            // button to flip state. Visibility is driven by CSS on the body
            // class — toggling is instant and costs nothing per render.
            const descToggleBtn = asHtml(document.getElementById('toggleDescriptionsBtn'));

            const DESC_PREF_KEY = 'je-settings-descriptions-visible';

            function applyDescriptionVisibility(show: boolean) : void {
                try { document.body.classList.toggle('je-hide-descriptions', !show); } catch (e) {}
                if (descToggleBtn) {
                    descToggleBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
                    descToggleBtn.classList.toggle('je-desc-toggle-off', !show);
                    const state = asHtml(descToggleBtn.querySelector('.je-desc-toggle-state'));
                    if (state) state.textContent = show ? 'On' : 'Off';
                }
            }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
            (function initDescriptionVisibility() {
                let show = true;
                try {
                    const stored = localStorage.getItem(DESC_PREF_KEY);
                    if (stored === 'false') show = false;
                } catch (e) { /* private mode / quota — default visible */ }
                applyDescriptionVisibility(show);
            })();

            if (descToggleBtn) {
                descToggleBtn.addEventListener('click', function() {
                    const currentlyShown = !document.body.classList.contains('je-hide-descriptions');
                    const nextShown = !currentlyShown;
                    applyDescriptionVisibility(nextShown);
                    try { localStorage.setItem(DESC_PREF_KEY, nextShown ? 'true' : 'false'); }
                    catch (e) { /* private mode / quota — preference won't persist, UI still toggles */ }
                });
            }
    }

    return {
        wire,

    };
}
