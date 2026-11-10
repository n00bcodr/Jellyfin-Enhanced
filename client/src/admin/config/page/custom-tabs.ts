import type { PageModules } from './modules';
import type { AdminConfig } from '../domain/config';
import type { CustomTabsSyncResult } from './types';
import { CUSTOM_TAB_MANAGED_ENTRIES, anyCustomTabIntent, isCustomTabsConfigShapeOk, planCustomTabsSync } from '../domain/custom-tabs';
import { failureMessage, isAbortError } from '../domain/http';
import type { WriteScope } from '../domain/write-scope';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type CustomTabsDeps = Pick<PageModules, 'context' | 'overviewCards' | 'plugins'>;

export function createCustomTabs(m: CustomTabsDeps) {
    const { ApiClient } = m.context;

        // ---------------------------------------------------------------------
        // Custom Tabs auto-management
        //
        // The Custom Tabs plugin (https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)
        // stores its tab list at /Plugins/{guid}/Configuration as
        // `{ "Tabs": [{ "Title": "...", "ContentHtml": "..." }, ...] }`.
        // We can manage individual entries on the user's behalf, but only when
        // the schema we observe matches that shape exactly. If the schema has
        // changed in a future release, every code path here bails out silently
        // and the related UI ("Add the Custom Tabs entry for me" toggles) stays
        // hidden — the user falls back to manual setup with no error noise.
        // ---------------------------------------------------------------------
        var CUSTOM_TABS_PLUGIN_ID = 'fbacd0b6fd464a05b0a42045d6a135b0';

        // Per managed Custom Tabs entry: which JE config flags drive it
        // (parent + auto-create), what Title to write, and the exact
        // ContentHtml snippet that JE's matching front-end module looks for.
        // ContentHtml strings are the SOURCE OF TRUTH for "this tab is ours" —
        // the sync logic identifies our entries by exact-string match.
        // `masterKey` is the top-level feature toggle (Enable Bookmarks / Enable
        // Hidden Content / Enable Requests Page / Enable Calendar Page). Sync
        // requires ALL THREE — masterKey, parentKey, autoKey — to be true for
        // the entry to exist. Without masterKey in the predicate, disabling the
        // master feature would leave an orphan Custom Tabs entry that opens to
        // broken/empty content (the JE module behind it is off).
        

        
        function checkCustomTabsConfigCompat() : void {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                dataType: 'json'
            }).then(function(cfg) {
                var ok = isCustomTabsConfigShapeOk(cfg);
                document.body.classList.toggle('je-has-customtabs-compat', ok);
                m.plugins.customTabsCompatState = ok ? 'ok' : 'incompatible';
                if (!ok) {
                    console.warn('[JE] Custom Tabs config schema not recognized; auto-manage toggles hidden.');
                    m.plugins.setProbeWarning('customtabs', "Custom Tabs config has an unrecognized shape. Auto-create toggles disabled until Jellyfin Enhanced supports the new schema.");
                } else {
                    m.plugins.setProbeWarning('customtabs', null);
                }
                try { m.overviewCards.renderOptionalPluginsDashboard(); } catch (e) {
                    console.warn('[JE] renderOptionalPluginsDashboard threw from checkCustomTabsConfigCompat (then):', e);
                }
            }).catch(function(err) {
                document.body.classList.remove('je-has-customtabs-compat');
                m.plugins.customTabsCompatState = 'probe-failed';
                console.warn('[JE] Custom Tabs config probe failed; auto-manage toggles hidden:', err);
                m.plugins.setProbeWarning('customtabs', "Couldn't read Custom Tabs config (check Jellyfin logs). Auto-create toggles disabled until the probe succeeds.");
                try { m.overviewCards.renderOptionalPluginsDashboard(); } catch (e) {
                    console.warn('[JE] renderOptionalPluginsDashboard threw from checkCustomTabsConfigCompat (catch):', e);
                }
            });
        }

        /**
         * Plan + apply Custom Tabs sync for every managed entry.
         *
         * Returns a promise resolving to `{ ok, status, detail, ownedUpdates }`:
         *  - `ok: true` → sync ran cleanly (or was a clean no-op)
         *  - `ok: false` → something failed; `detail` describes it (admin-visible)
         *  - `status: 'noop' | 'ok' | 'skipped' | 'failed'`
         *  - `ownedUpdates: [{ ownedKey, value }]` — *JE-side* flag updates the caller
         *    must persist alongside the rest of the JE config so future syncs know
         *    which entries we created vs. which the admin added manually.
         *
         * Sync rules per managed entry (uses `ownedKey` to gate destructive deletes):
         *  - shouldExist (auto+parent both on) AND no matching CT entry → ADD; owned=true
         *  - shouldExist AND a matching CT entry exists → leave entry alone; preserve owned
         *  - !shouldExist AND a matching CT entry exists AND we own it → REMOVE; owned=false
         *  - !shouldExist AND a matching CT entry exists but we don't own it → leave it
         *    (it's the admin's manually-created tab); owned stays false
         *  - !shouldExist AND no matching entry → no-op; owned=false
         *
         * The single GET → mutate → single POST sequence avoids the race where
         * multiple per-entry round-trips would clobber each other.
         */
        function syncAllManagedCustomTabs(savedConfig: AdminConfig, scope: WriteScope) : Promise<CustomTabsSyncResult> {
            if (!document.body.classList.contains('je-has-customtabs-compat')) {
                // Bail early. If the admin has auto-create intent stored but we
                // can't act on it (compat probe failed / detection unknown),
                // return ok:false so the save-flow alert gate fires — otherwise
                // the green "Saved!" toast masks the dropped intent.
                // Mirror `shouldExist`: intent requires all three flags —
                // master + parent + auto. A disabled-at-master feature with
                // auto+parent still checked wouldn't have a real sync action
                // anyway, so shouldn't trigger the cosmetic "saved but CT
                // dropped your auto-create" alert.
                var anyIntent = anyCustomTabIntent(savedConfig);
                // Custom Tabs definitely absent (not installed, or installed
                // but disabled): there is nothing to sync and nothing the admin
                // can fix from here, so skip cleanly. Typical after a 10.11 →
                // 12 upgrade where Custom Tabs was dropped in favour of the
                // native home tabs; the stored intent is deliberately kept so
                // the entries sync again if the plugin is reinstalled. The
                // auto-create toggles are hidden in this state, so an ok:false
                // here would re-alert on every save with no way out.
                if (m.plugins.hasCustomTabs === false) {
                    return Promise.resolve({
                        ok: true,
                        status: 'skipped',
                        detail: 'Custom Tabs not installed; nothing to sync.',
                        ownedUpdates: []
                    });
                }
                return Promise.resolve({
                    ok: !anyIntent, // only "skipped cleanly" when there was nothing to do
                    status: 'skipped',
                    detail: anyIntent
                        ? (m.plugins.hasCustomTabs === true
                            ? 'Custom Tabs is installed, but its config could not be read or has an unrecognized shape, so the auto-create entry was skipped.'
                            : 'Plugin detection did not complete, so the auto-create entry was skipped.')
                          + ' Use the Retry button on the "Plugin detection issue" banner at the top of this page (or reload the page), then save again.'
                        : 'Custom Tabs compat probe not passed; nothing to sync.',
                    ownedUpdates: []
                });
            }
            return ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                dataType: 'json'
            }).then(function(cfg): CustomTabsSyncResult | Promise<CustomTabsSyncResult> {
                scope.throwIfStale();
                if (!isCustomTabsConfigShapeOk(cfg)) {
                    return {
                        ok: false,
                        status: 'failed',
                        detail: 'Custom Tabs configuration shape no longer matches what Jellyfin Enhanced knows how to write; auto-manage skipped to avoid corrupting it.',
                        ownedUpdates: []
                    };
                }
                const { changed, ownedUpdates } = planCustomTabsSync(cfg, savedConfig);
                if (!changed) {
                    return { ok: true, status: 'noop', detail: 'Custom Tabs already in sync.', ownedUpdates: ownedUpdates };
                }
                scope.throwIfStale();
                return ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/Plugins/' + CUSTOM_TABS_PLUGIN_ID + '/Configuration'),
                    contentType: 'application/json',
                    data: JSON.stringify(cfg)
                }).then(function(): CustomTabsSyncResult {
                    return { ok: true, status: 'ok', detail: 'Custom Tabs updated.', ownedUpdates: ownedUpdates };
                }).catch(function(err): CustomTabsSyncResult {
                    if (isAbortError(err)) throw err;
                    return {
                        ok: false,
                        status: 'failed',
                        detail: 'Custom Tabs update failed: ' + failureMessage(err, 'see console'),
                        ownedUpdates: []  // do NOT persist owned flags if the POST didn't land
                    };
                });
            }).catch(function(err): CustomTabsSyncResult {
                if (isAbortError(err)) throw err;
                return {
                    ok: false,
                    status: 'failed',
                    detail: 'Could not read Custom Tabs configuration: ' + failureMessage(err, 'see console'),
                    ownedUpdates: []
                };
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        CUSTOM_TAB_MANAGED_ENTRIES,
        checkCustomTabsConfigCompat,
        syncAllManagedCustomTabs,
    };
}
