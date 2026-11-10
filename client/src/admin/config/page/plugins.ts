import { kefinTweaksConfig } from '../../../host/admin-config-host';
import type { PageModules } from './modules';
import { asObjects, shown, text } from '../domain/config';
import { asHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type PluginsDeps = Pick<PageModules, 'context' | 'customTabs' | 'gatedHelp' | 'serviceStatus' | 'whatsNew' | 'load'>;

export function createPlugins(m: PluginsDeps) {
    const { ApiClient } = m.context;

        // Plugin detection state.
        //
        // Each `hasX` is tri-state: `null` (not yet probed or probe failed),
        // `true` (installed AND Status === "Active"), `false` (not installed
        // OR installed but disabled). When the plugin is installed-but-
        // disabled, we additionally record it in `_jeDisabledPlugins` so the
        // Optional Dependencies card can surface "Installed (disabled)"
        // instead of the blunt "Not installed".
        var hasPluginPages: boolean | null = null;

        var hasCustomTabs: boolean | null = null;

        var isJellyfin12 = (function() {
            try {
                var version = ApiClient.serverVersion && ApiClient.serverVersion();
                return parseInt((version || '').split('.')[0] ?? '', 10) >= 12;
            } catch (e) {
                return false;
            }
        })();

        var hasIntroSkipper: boolean | null = null;

        var hasInPlayerEpisodePreview: boolean | null = null;

        var hasFileTransformation: boolean | null = null;

        var hasKefinTweaks: boolean | null = null;

        var _jeCurrentPluginVersion: string | null = null;

        var _jeDisabledPlugins: Record<string, string> = {};

 // key -> true when installed but Status !== 'Active'
        // Tri-state compat probe result for Custom Tabs:
        //   null           — not yet probed (or Custom Tabs not installed)
        //   'ok'           — /Plugins/.../Configuration returned the expected shape
        //   'incompatible' — config read but shape doesn't match { Tabs:[{Title,ContentHtml}] }
        //   'probe-failed' — HTTP/JSON/auth error reading the config
        var customTabsCompatState: 'ok' | 'incompatible' | 'probe-failed' | null = null;

        /**
         * Checks installed plugins (Plugin Pages, Custom Tabs, etc.) and updates
         * dependency state for Plugin Pages / Custom Tabs dependent settings.
         * Called during loadConfig() on page load.
         */
        function checkInstalledPlugins() : void {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins'),
                dataType: 'json'
            }).then(function(response) {
                const plugins = asObjects(response);
                setProbeWarning('plugins', null);
                // Status-aware plugin lookup. Returns tri-state:
                //   true  → installed AND active
                //   false → either not installed OR disabled
                // When disabled, also records it in _jeDisabledPlugins[key] so
                // the Optional Dependencies card can show "Installed (disabled)".
                _jeDisabledPlugins = {};
                function probe(key: string, names: readonly string[]): boolean {
                                        var lowered = names.map(function(n) { return n.toLowerCase(); });
                    var match = plugins.find(function(p) { return lowered.indexOf(text(p.Name).toLowerCase()) !== -1; });
                    if (!match) return false;
                    // Jellyfin returns Status as one of: Active, Disabled, Restart,
                    // NotSupported, Malfunctioned, Superseded. Anything else → log
                    // once and treat as disabled so the dashboard surfaces a warning
                    // rather than silently passing through. Old builds that omit
                    // Status entirely are caught here too — better to see "Installed
                    // but status unknown" than misreport as Active.
                    //
                    // Rendering note: `_jeDisabledPlugins[key]` captures the raw
                    // Status string. The Optional Dependencies dashboard renders
                    // "Installed but disabled in Dashboard > Plugins" for any
                    // non-Active value. That copy is accurate for Disabled but
                    // slightly misleading for Restart ("waiting for server restart")
                    // and Superseded ("replaced by newer version, probably still
                    // usable"). Callers wanting distinct copy per status should
                    // branch on the raw value.
                    var status = text(match.Status);
                    var active = status === 'Active';
                    if (!active) {
                        _jeDisabledPlugins[key] = status || 'Status unknown';
                        if (status && ['Disabled', 'Restart', 'NotSupported', 'Malfunctioned', 'Superseded'].indexOf(status) === -1) {
                            console.warn('[JE] plugin ' + text(match.Name) + ' has unexpected Status value: ' + JSON.stringify(status));
                        }
                    }
                    return active;
                }
                hasFileTransformation = probe('fileTransformation', ['File Transformation']);
                hasPluginPages        = probe('pluginPages',        ['Plugin Pages']);
                hasCustomTabs         = probe('customTabs',         ['Custom Tabs']);
                hasIntroSkipper       = probe('introSkipper',       ['Intro Skipper', 'SkipIntro']);
                hasInPlayerEpisodePreview = probe('inPlayerEpisodePreview', ['In Player Episode Preview', 'In-Player Episode Preview', 'InPlayerEpisodePreview']);

                var self = plugins.find(function(p) { return text(p.Name).toLowerCase() === 'jellyfin enhanced'; });
                if (self && self.Version) _jeCurrentPluginVersion = shown(self.Version);

                // KefinTweaks installs as a web-mod (files in /config/KefinTweaks/
                // injected via File Transformation into index.html), NOT as a
                // .NET plugin — so it never appears in /Plugins. Detect it at
                // runtime instead: the injector sets `kefinTweaksConfig()`
                // and adds script tags whose src contains "KefinTweaks".
                try {
                    hasKefinTweaks = !!(kefinTweaksConfig() ||
                        asHtml(document.querySelector('script[src*="KefinTweaks"]')));
                } catch (e) {
                    // Extremely unlikely (the selector is literal and the window
                    // read is same-origin), but a future isolation/CSP quirk could
                    // throw — log so we can distinguish "detection bug" from
                    // "legitimately not installed" in bug reports.
                    console.warn('[JE] KefinTweaks detection threw; treating as absent:', e);
                    hasKefinTweaks = false;
                }

                // Toggle body classes so descriptions hide install-only content
                // (e.g., "Install the Custom Tabs plugin...") and surface a positive
                // "detected" badge when an integration plugin is already present.
                document.body.classList.toggle('je-has-customtabs',        hasCustomTabs         === true);
                document.body.classList.toggle('je-has-pluginpages',       hasPluginPages        === true);
                document.body.classList.toggle('je-has-introskipper',      hasIntroSkipper       === true);
                document.body.classList.toggle('je-has-inplayerepisodepreview', hasInPlayerEpisodePreview === true);
                document.body.classList.toggle('je-has-kefintweaks',       hasKefinTweaks        === true);

                // If Custom Tabs is present, probe its config to decide whether the
                // schema matches what we know how to write. Only on success do we
                // reveal the "Add the Custom Tabs entry for me" toggles.
                if (hasCustomTabs === true) {
                    customTabsCompatState = null; // re-probing
                    m.customTabs.checkCustomTabsConfigCompat();
                } else {
                    document.body.classList.remove('je-has-customtabs-compat');
                    customTabsCompatState = null;
                }

                // Re-run dependencies now that plugin info is available
                m.gatedHelp.updateAllDependencies();
                m.whatsNew.checkHostCompat();
                m.whatsNew.checkWhatsNew();
            }).catch(function(err) {
                // Plugin list request failed (network, auth expiry, server offline, ...).
                // Leave hasPluginPages/hasIntroSkipper at null so individual deps show
                // "unknown" rather than incorrectly disabling toggles. Still refresh
                // the dashboard so cards don't sit stuck on "Checking..." forever.
                console.warn('[JE] plugin detection failed; resetting detection state to avoid stale UI:', err);
                // Reset detection state so prior-success flags don't contradict
                // the visible "couldn't reach /Plugins" warning. Body classes,
                // module flags, and dep gates all flip back to "unknown" so the
                // UI is internally consistent after a failed retry.
                hasPluginPages = null;
                hasCustomTabs = null;
                hasIntroSkipper = null;
                hasInPlayerEpisodePreview = null;
                hasFileTransformation = null;
                hasKefinTweaks = null;
                customTabsCompatState = null;
                document.body.classList.remove('je-has-customtabs', 'je-has-pluginpages', 'je-has-introskipper', 'je-has-inplayerepisodepreview', 'je-has-customtabs-compat', 'je-has-kefintweaks');
                setProbeWarning('plugins', "Couldn't reach the Jellyfin /Plugins endpoint to verify which integrations are installed (auth expiry, network, or server issue). Dependency hints and \"plugin detected\" badges are now hidden until you retry.");
                try { m.gatedHelp.updateAllDependencies(); } catch (e) {
                    console.warn('[JE] updateAllDependencies threw during plugin-detect fallback:', e);
                }
                try {
                    m.serviceStatus.updateStatusDashboard();
                } catch (e) {
                    console.warn('[JE] updateStatusDashboard threw during plugin-detect fallback:', e);
                }
            });
            // Probe-warning retry — re-runs plugin detection (which also re-runs
            // the Custom Tabs config probe inside its .then). One handler only;
            // checkInstalledPlugins is idempotent.
            var probeRetry = asHtml(document.getElementById('je-probe-retry-btn'));
            if (probeRetry && !probeRetry.dataset.jeWired) {
                probeRetry.dataset.jeWired = '1';
                probeRetry.onclick = function() {
                    setProbeWarning('plugins', null);
                    setProbeWarning('customtabs', null);
                    // Reading the saved settings failed too: loading them runs the detection as well.
                    if (m.load.configLoaded) checkInstalledPlugins();
                    else m.load.loadConfig();
                };
            }
        }

        // Surfaces a single probe-failure banner above the form. Multiple probes
        // (plugin list, Custom Tabs config schema) can fail independently — the
        // banner aggregates them so the admin sees one actionable message instead
        // of nothing. Pass an empty/null msg to clear the banner for that source.
        var _jeProbeWarnings: Record<string, string> = Object.create(null);

        function setProbeWarning(source: string, msg: string | null) : void {
            if (msg) _jeProbeWarnings[source] = msg;
            else delete _jeProbeWarnings[source];
            var banner = asHtml(document.getElementById('je-probe-warning'));
            var msgEl = asHtml(document.getElementById('je-probe-warning-msg'));
            if (!banner || !msgEl) return;
            var keys = Object.keys(_jeProbeWarnings);
            if (keys.length === 0) {
                banner.style.display = 'none';
                msgEl.textContent = '';
            } else {
                msgEl.textContent = ': ' + keys.map(function(k) { return _jeProbeWarnings[k]; }).join(' / ');
                banner.style.display = '';
            }
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        get _jeDisabledPlugins() { return _jeDisabledPlugins; },
        set _jeDisabledPlugins(value) { _jeDisabledPlugins = value; },
        checkInstalledPlugins,
        get customTabsCompatState() { return customTabsCompatState; },
        set customTabsCompatState(value) { customTabsCompatState = value; },
        get hasCustomTabs() { return hasCustomTabs; },
        set hasCustomTabs(value) { hasCustomTabs = value; },
        get hasFileTransformation() { return hasFileTransformation; },
        set hasFileTransformation(value) { hasFileTransformation = value; },
        get hasInPlayerEpisodePreview() { return hasInPlayerEpisodePreview; },
        set hasInPlayerEpisodePreview(value) { hasInPlayerEpisodePreview = value; },
        get hasIntroSkipper() { return hasIntroSkipper; },
        set hasIntroSkipper(value) { hasIntroSkipper = value; },
        get hasKefinTweaks() { return hasKefinTweaks; },
        set hasKefinTweaks(value) { hasKefinTweaks = value; },
        get hasPluginPages() { return hasPluginPages; },
        set hasPluginPages(value) { hasPluginPages = value; },
        isJellyfin12,
        setProbeWarning,
    };
}
