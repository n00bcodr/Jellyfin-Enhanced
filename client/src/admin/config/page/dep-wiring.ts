import type { PageModules } from './modules';
import { asControl, asHtml, needHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type DepWiringDeps = Pick<PageModules, 'context' | 'connections' | 'dependencies' | 'gatedHelp'>;

export function createDepWiring(m: DepWiringDeps) {
        // Reactive dependency updates (debounced for text inputs, immediate for checkboxes)
        var depDebounce: ReturnType<typeof setTimeout> | undefined;

        /** Debounced wrapper that delays updateAllDependencies by 150ms. */
        function debouncedUpdateDeps() : void {
            clearTimeout(depDebounce);
            depDebounce = setTimeout(m.gatedHelp.updateAllDependencies, 150);
        }

        // Drop persisted "Last tested <date>" entries when the inputs that produced
        // those tests change — otherwise an admin who rotated their TMDB API key or
        // changed Seerr URLs would keep seeing a green checkmark from the previous
        // credentials. The next test (or page render) re-establishes the row.
        function _wireInvalidate(sel: string, key: string) : void {
            const el = asControl(document.querySelector(sel));
            if (!el) return;
            var lastValue = el.value;
            // Use 'change' (fires on blur/commit) rather than 'input' (fires per
            // keystroke). Input-per-keystroke would invalidate + rebuild the
            // service-status grid 30+ times during a TMDB key rotation, causing
            // visible lag on slower machines. Change-on-commit gets the same
            // correctness outcome without the churn.
            el.addEventListener('change', function() {
                if (el.value !== lastValue) {
                    m.connections.invalidatePersistedTest(key);
                    lastValue = el.value;
                }
            });
        }

        // Parent checkbox change listeners
        var parentIds: Record<string, boolean> = {};

        var searchExcludeLibraryCheckbox = asHtml(document.getElementById('jellyseerrSearchExcludeLibraryItems'));

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        ['#TMDB_API_KEY', '#jellyseerr_TMDB_API_KEY'].forEach(function(sel) {
            needHtml(document.querySelector(sel)).addEventListener('input', debouncedUpdateDeps);
        });

        needHtml(document.querySelector('#jellyseerrEnabled')).addEventListener('change', m.gatedHelp.updateAllDependencies);

        needHtml(document.querySelector('#metadataIconsEnabled')).addEventListener('change', m.gatedHelp.updateAllDependencies);

        ['#jellyseerrUrls', '#JellyseerrApiKey'].forEach(function(sel) {
            needHtml(document.querySelector(sel)).addEventListener('input', debouncedUpdateDeps);
        });

        _wireInvalidate('#TMDB_API_KEY',         'tmdb');

        _wireInvalidate('#jellyseerr_TMDB_API_KEY', 'tmdb');

        _wireInvalidate('#jellyseerrUrls',       'seerr');

        _wireInvalidate('#JellyseerrApiKey',     'seerr');

        m.dependencies.PARENT_DEPS.forEach(function(dep) {
            (dep.anyOf || [dep.parent]).forEach(function(id) { parentIds[id] = true; });
        });

        Object.keys(parentIds).forEach(function(id) {
            var el = asHtml(document.getElementById(id));
            if (el) el.addEventListener('change', m.gatedHelp.updateAllDependencies);
        });

        m.dependencies.CUSTOM_TABS_V12_HINTS.forEach(function(dep) {
            [dep.customId, dep.nativeId].forEach(function(id) {
                var el = asHtml(document.getElementById(id));
                if (el) el.addEventListener('change', function() { m.dependencies.updateCustomTabsV12Hint(dep); });
            });
        });

        if (searchExcludeLibraryCheckbox) searchExcludeLibraryCheckbox.addEventListener('change', m.dependencies.updateSearchExcludeLibraryWarning);
    }

    return {
        wire,
        debouncedUpdateDeps,
    };
}
