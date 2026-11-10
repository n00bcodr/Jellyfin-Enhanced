import type { PageModules } from './modules';
import { asHtml, asInput } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type GatedHelpDeps = Pick<PageModules, 'context' | 'actions' | 'banners' | 'dependencies' | 'overviewCards' | 'serviceStatus'>;

export function createGatedHelp(m: GatedHelpDeps) {
        // ==============================================================
        // Gated help (phase 5). Any setup-instruction block that only
        // applies when a specific toggle is on lives under a
        // [data-gated-by="<checkbox-id>"] attribute. Hidden when the
        // toggle is off; visible when on. Transitions from off→on also
        // auto-open the accordion so the admin doesn't have to hunt
        // for the freshly-revealed help.
        //
        // Declarative tag + generic dispatcher = no per-section wiring.
        // Adding a new gated help block means: drop data-gated-by on
        // the element + add the checkbox id below to GATED_HELP_IDS.
        // ==============================================================

        // Track prior checked state per gated-help parent so we can
        // detect an off→on transition in the change listener and
        // auto-expand the just-revealed accordion.
        var _jeGatedHelpState = Object.create(null);

        /**
         * Syncs visibility of every [data-gated-by] element to its
         * parent checkbox's checked state. If autoExpandOnRise is true
         * AND a parent just went from unchecked to checked, the gated
         * `<details>` is auto-opened.
         */
        function applyGatedHelp(autoExpandOnRise?: boolean) : void {
            var gated = document.querySelectorAll<HTMLElement>('[data-gated-by]');
            gated.forEach(function(el) {
                var parentAttr = el.getAttribute('data-gated-by');
                if (!parentAttr) return;
                // Allow comma-separated IDs: ALL listed parents must be checked
                // for the gated element to show. Used by Custom Tabs auto-manage
                // toggles which depend on BOTH `*UseCustomTabs` AND the master
                // `*Enabled` toggle for the feature.
                var parentIds = parentAttr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var allOn = true;
                var anyRise = false;
                parentIds.forEach(function(parentId) {
                    var parent = asInput(document.getElementById(parentId));
                    if (!parent) { allOn = false; return; }
                    var thisOn = !!parent.checked;
                    if (!thisOn) allOn = false;
                    var wasOn = _jeGatedHelpState[parentId] === true;
                    if (thisOn && !wasOn) anyRise = true;
                    _jeGatedHelpState[parentId] = thisOn;
                });
                el.hidden = !allOn;
                if (autoExpandOnRise && allOn && anyRise && el instanceof HTMLDetailsElement) {
                    el.open = true;
                }
            });
        }

        // A page can use the native Home tab or Custom Tabs, never both: the two
        // would register competing tabs for the same page.
        var TAB_EXCLUSIVE_PAIRS = ['bookmarks', 'hiddenContent', 'downloads', 'calendar', 'recommendations', 'activityFeed', 'catchUp'].map(function(p) {
            return { native: p + 'UseNativeTab', custom: p + 'UseCustomTabs' };
        });

        function enforceTabExclusivity(changedId?: string): void {
            TAB_EXCLUSIVE_PAIRS.forEach(function(pair) {
                var nativeBox = asInput(document.getElementById(pair.native));
                var customBox = asInput(document.getElementById(pair.custom));
                if (!nativeBox || !customBox || !nativeBox.checked || !customBox.checked) return;
                // The box the admin just ticked wins; on load/save the native tab wins.
                var loser = changedId === pair.native ? customBox : changedId === pair.custom ? nativeBox : customBox;
                loser.checked = false;
                loser.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }

        /**
         * Orchestrator: evaluates all section, individual, and parent dependency rules.
         * Each step is isolated so a throw in the status dashboard (which reads a lot
         * of field values) can't cascade and break dependency updates.
         */
        function updateAllDependencies() : void {
            enforceTabExclusivity();
            m.dependencies.SECTION_DEPS.forEach(m.dependencies.updateSectionDep);
            m.dependencies.INDIVIDUAL_DEPS.forEach(m.dependencies.updateIndividualDep);
            m.dependencies.CUSTOM_TABS_V12_HINTS.forEach(m.dependencies.updateCustomTabsV12Hint);
            m.dependencies.updateSearchExcludeLibraryWarning();
            m.dependencies.PARENT_DEPS.forEach(m.dependencies.updateParentDep);
            m.dependencies.updateWatchlistMemoryVisibility();
            m.actions.updateClearTagCachesQuickBtnVisibility();
            // `updateStatusDashboard` and the legacy `renderChecklist` both
            // now delegate to `renderServiceStatusDashboard`. Calling both
            // here would rebuild the service grid TWICE per dependency tick
            // (~30 times during a TMDB key rotation). One call is enough.
            try {
                m.serviceStatus.renderServiceStatusDashboard();
            } catch (e) {
                console.warn('[JE] renderServiceStatusDashboard threw; dashboard may be stale:', e);
            }
            try {
                m.overviewCards.renderOptionalPluginsDashboard();
            } catch (e) {
                console.warn('[JE] renderOptionalPluginsDashboard threw:', e);
            }
            try {
                m.overviewCards.renderFeaturesDashboard();
            } catch (e) {
                console.warn('[JE] renderFeaturesDashboard threw:', e);
            }
            try {
                // Re-sync banner parent gating. loadConfig sets .checked
                // programmatically, which DOESN'T fire the change event our
                // banner listener uses — so we need an explicit refresh here.
                m.banners.syncAllBannerParents();
            } catch (e) {
                console.warn('[JE] syncAllBannerParents threw:', e);
            }
            try {
                // Don't auto-expand when triggered by a bulk dep sync —
                // that would fire `open = true` on every tick the parent
                // is checked, which is noisy. Real off→on transitions
                // go through the dedicated change listener above.
                applyGatedHelp(false);
            } catch (e) {
                console.warn('[JE] applyGatedHelp threw; gated help may be stale:', e);
            }
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Wire one change listener per unique parent id referenced by
        // [data-gated-by]. A single bulk dispatch refreshes every gated
        // element regardless of which parent fired.
        //
        // We also prime `_jeGatedHelpState` with each parent's current
        // checked value at wire time. Without priming, the first user
        // click on a gated parent that was already checked (e.g. after a
        // config load flipped the DOM state out of band) would be read
        // as `wasOn === undefined (falsy) → isOn === true`, i.e. a rise,
        // and auto-expand when it shouldn't. Priming closes that hole
        // for the initial render AND for any parent the config loader
        // set programmatically (programmatic `.checked = true` does NOT
        // fire a change event, so the listener wouldn't see it).
        (function wireGatedHelp() {
            var gated = document.querySelectorAll<HTMLElement>('[data-gated-by]');
            var uniqueParents = Object.create(null);
            gated.forEach(function(el) {
                var attr = el.getAttribute('data-gated-by');
                if (!attr) return;
                attr.split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) {
                    uniqueParents[id] = true;
                });
            });
            Object.keys(uniqueParents).forEach(function(id) {
                var parent = asInput(document.getElementById(id));
                if (!parent) {
                    console.warn('[JE] gated-help: parent checkbox #' + id + ' not found — help will stay hidden');
                    return;
                }
                _jeGatedHelpState[id] = !!parent.checked;
                parent.addEventListener('change', function() {
                    try { applyGatedHelp(true); } catch (e) {
                        console.warn('[JE] applyGatedHelp threw in change handler:', e);
                    }
                });
            });
            // Reflect initial visibility once so the DOM matches the primed
            // state immediately (no flicker when loadConfig eventually
            // triggers updateAllDependencies → applyGatedHelp(false)).
            try { applyGatedHelp(false); } catch (e) {
                console.warn('[JE] applyGatedHelp threw during init:', e);
            }
        })();

        TAB_EXCLUSIVE_PAIRS.forEach(function(pair) {
            [pair.native, pair.custom].forEach(function(id) {
                var box = asHtml(document.getElementById(id));
                if (box) box.addEventListener('change', function() { enforceTabExclusivity(id); });
            });
        });
    }

    return {
        wire,
        enforceTabExclusivity,
        updateAllDependencies,
    };
}
