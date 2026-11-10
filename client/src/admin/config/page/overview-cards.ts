import type { PageModules } from './modules';
import type { OverviewFeature } from './types';
import { asControl, asHtml, asInput } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type OverviewCardsDeps = Pick<PageModules, 'context' | 'displayCards' | 'plugins'>;

export function createOverviewCards(m: OverviewCardsDeps) {
        /**
         * Overview → Optional Dependencies
         * Renders a card per optional plugin with its detected state.
         * Sources the booleans populated by checkInstalledPlugins() —
         * `null` means the /Plugins probe hasn't completed (or failed),
         * rendered as "Checking…" rather than asserting missing.
         */
        var OPTIONAL_PLUGINS = [
            { key: 'fileTransformation', name: 'File Transformation', icon: 'transform',       url: 'https://github.com/IAmParadox27/jellyfin-plugin-file-transformation', purpose: 'Required by Custom Tabs, Plugin Pages, and other plugins that modify the web client.', getFlag: function(){ return m.plugins.hasFileTransformation; } },
            { key: 'pluginPages',        name: 'Plugin Pages',        icon: 'view_list',       url: 'https://github.com/IAmParadox27/jellyfin-plugin-pages',               purpose: 'Sidebar pages for Bookmarks, Hidden Content, Requests, Calendar.',                   getFlag: function(){ return m.plugins.hasPluginPages; } },
            { key: 'customTabs',         name: 'Custom Tabs',         icon: 'tab',             url: 'https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs',         purpose: 'Home-page tab entries for Bookmarks, Hidden Content, Requests, Calendar.',          getFlag: function(){ return m.plugins.hasCustomTabs; } },
            { key: 'introSkipper',       name: 'Intro Skipper',       icon: 'skip_next',       url: 'https://github.com/intro-skipper/intro-skipper',                      purpose: 'Source of timestamps for Auto-skip Intro / Auto-skip Outro.',                        getFlag: function(){ return m.plugins.hasIntroSkipper; } },
            { key: 'inPlayerEpisodePreview', name: 'In-Player Episode Preview', icon: 'movie_filter', url: 'https://github.com/Namo2/InPlayerEpisodePreview',            purpose: 'Enables the in-player Episode Preview keyboard shortcut.',                           getFlag: function(){ return m.plugins.hasInPlayerEpisodePreview; } },
            { key: 'kefinTweaks',        name: 'KefinTweaks',         icon: 'bookmark_border', url: 'https://github.com/ranaldsgift/KefinTweaks',                          purpose: 'Renders the Watchlist UI in Jellyfin. Required to view watchlisted items from the Seerr Watchlist features. Installs as a web-mod (not a normal plugin), detected via its injected scripts.', getFlag: function(){ return m.plugins.hasKefinTweaks; } }
        ];

        function renderOptionalPluginsDashboard() : void {
            const root = asHtml(document.getElementById('je-optional-plugins'));
            if (!root) return;
            root.textContent = '';
            OPTIONAL_PLUGINS.forEach(function(dep) {
                var flag = dep.getFlag();
                var state, statusText;
                if (flag === true)       { state = 'installed'; statusText = 'Installed'; }
                else if (flag === false) { state = 'missing';   statusText = 'Not installed'; }
                else                     { state = 'unknown';   statusText = 'Checking…'; }

                // When the plugin is installed-but-disabled (status ≠ Active),
                // flip to an amber "disabled" state so the admin knows to
                // re-enable it rather than wonder why features don't work.
                if (flag === false && m.plugins._jeDisabledPlugins[dep.key]) {
                    state = 'warn';
                    statusText = 'Installed but disabled in Dashboard > Plugins';
                }

                // Only surface a compat warning for Custom Tabs when we've
                // actually completed the probe — not while it's still pending
                // (customTabsCompatState === null). This avoids a transient
                // "incompatible" flash during the initial load.
                if (dep.key === 'customTabs' && flag === true) {
                    if (m.plugins.customTabsCompatState === 'incompatible') {
                        state = 'warn';
                        statusText = 'Installed, config shape not recognized (auto-create disabled)';
                    } else if (m.plugins.customTabsCompatState === 'probe-failed') {
                        state = 'warn';
                        statusText = "Installed, couldn't read config (auto-create disabled)";
                    } else if (m.plugins.customTabsCompatState === null) {
                        statusText = 'Installed, checking config…';
                    }
                }
                var card = document.createElement('div');
                card.className = 'je-optional-plugin-card je-state-' + state;
                var icon = document.createElement('i');
                icon.className = 'material-icons je-optional-plugin-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = state === 'installed' ? 'check_circle'
                                 : state === 'warn'      ? 'warning'
                                 : state === 'unknown'   ? 'help_outline'
                                 : 'radio_button_unchecked';
                card.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'je-optional-plugin-body';
                var name = document.createElement('div');
                name.className = 'je-optional-plugin-name';
                name.textContent = dep.name;
                body.appendChild(name);
                var status = document.createElement('div');
                status.className = 'je-optional-plugin-status';
                status.textContent = statusText;
                body.appendChild(status);
                var purpose = document.createElement('div');
                purpose.className = 'je-optional-plugin-purpose';
                purpose.textContent = dep.purpose;
                body.appendChild(purpose);
                card.appendChild(body);

                // External link icon in the top-right — opens the plugin's
                // home repo in a new tab. noopener/noreferrer both for security
                // and so the opened page can't manipulate this window.
                if (dep.url) {
                    var link = document.createElement('a');
                    link.className = 'je-optional-plugin-link';
                    link.href = dep.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = 'Open ' + dep.name + ' on GitHub';
                    link.setAttribute('aria-label', 'Open ' + dep.name + ' on GitHub');
                    var linkIcon = document.createElement('i');
                    linkIcon.className = 'material-icons';
                    linkIcon.setAttribute('aria-hidden', 'true');
                    linkIcon.textContent = 'open_in_new';
                    link.appendChild(linkIcon);
                    card.appendChild(link);
                }

                root.appendChild(card);
            });
        }

        /**
         * Overview → Features
         * Renders a row per JE feature with one of three states:
         *   - on   (green)   : enabled and all required deps/config present
         *   - warn (amber)   : enabled but missing a dep or required config
         *   - off  (faded)   : disabled
         * Clicking a row jumps to the tab where the feature lives.
         *
         * Rules reference form inputs (live DOM) rather than a snapshot so this
         * updates correctly after every dependency re-evaluation.
         */
        function renderFeaturesDashboard() : void {
            const root = asHtml(document.getElementById('je-features-dashboard'));
            if (!root) return;

            function bool(id: string): boolean {
                var el = asInput(document.getElementById(id));
                return !!(el && el.checked);
            }
            function val(id: string): string {
                var el = asControl(document.getElementById(id));
                return el ? (el.value || '').trim() : '';
            }
            function anyArrConfigured() {
                var cards = document.querySelectorAll<HTMLElement>('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
                for (var i = 0; i < cards.length; i++) {
                    const card = cards[i];
                    if (!card) continue;
                    var url = asControl(card.querySelector('.arr-instance-url'));
                    var key = asControl(card.querySelector('.arr-instance-apikey'));
                    if (url && key && url.value.trim() && key.value.trim()) return true;
                }
                return false;
            }
            function seerrConfigured() {
                return !!val('jellyseerrUrls') && !!val('JellyseerrApiKey');
            }

            var features: OverviewFeature[] = [];
            function feat(name: string, enabled: boolean, tab: string, detail: string, warn?: boolean): void {
                if (!enabled) { features.push({ name: name, state: 'off', tab: tab, detail: 'Disabled' }); return; }
                features.push({ name: name, state: warn ? 'warn' : 'on', tab: tab, detail: detail });
            }

            // Display
            feat('Remove from Continue Watching', bool('removeContinueWatchingEnabled'), 'display', 'Enabled');
            var tagCount = ['QualityTagsEnabled','GenreTagsEnabled','LanguageTagsEnabled','RatingTagsEnabled','AgeRatingTagsEnabled','StatusTagsEnabled','AwardsTagsEnabled','LogoTagsEnabled','CustomTagsEnabled','PeopleTagsEnabled'].filter(function (k) { return m.displayCards._jeMediaTagsConfig && m.displayCards._jeMediaTagsConfig[k] === true; }).length;
            feat('Media Tags', tagCount > 0, 'display', tagCount + ' tag type(s) enabled');
            feat('Random Button', bool('randomButtonEnabled'), 'display', 'Enabled');

            // Playback
            feat('Custom Pause Screen', bool('pauseScreenEnabled'), 'playback', 'Enabled');
            feat('Age Rating on Playback Start', bool('showPlaybackRatingBadge'), 'playback', 'Enabled');
            feat('Long press for 2x speed', bool('longPress2xEnabled'), 'playback', 'Enabled (touch devices)');
            var autoSkip = bool('autoSkipIntro') || bool('autoSkipOutro');
            var autoSkipWarn = autoSkip && m.plugins.hasIntroSkipper !== true;
            feat('Auto-skip Intro/Outro', autoSkip, 'playback',
                autoSkipWarn ? 'Enabled but Intro Skipper plugin is missing' : 'Enabled',
                autoSkipWarn);
            var tabSwitch = bool('autoPauseEnabled') || bool('autoResumeEnabled') || bool('autoPipEnabled');
            feat('Tab-switch actions', tabSwitch, 'playback', 'Auto-pause / resume / PiP');

            // Pages
            var bookmarksWarn = bool('bookmarksEnabled') && (
                (bool('bookmarksUsePluginPages') && m.plugins.hasPluginPages !== true) ||
                (bool('bookmarksUseCustomTabs')  && m.plugins.hasCustomTabs  !== true)
            );
            feat('Bookmarks', bool('bookmarksEnabled'), 'pages',
                bookmarksWarn ? 'Missing required integration plugin' : 'Enabled',
                bookmarksWarn);
            var hcWarn = bool('hiddenContentEnabled') && (
                (bool('hiddenContentUsePluginPages') && m.plugins.hasPluginPages !== true) ||
                (bool('hiddenContentUseCustomTabs')  && m.plugins.hasCustomTabs  !== true)
            );
            feat('Hidden Content', bool('hiddenContentEnabled'), 'pages',
                hcWarn ? 'Missing required integration plugin' : 'Enabled',
                hcWarn);
            var reqWarn = bool('downloadsPageEnabled') && !seerrConfigured() && !anyArrConfigured();
            feat('Requests Page', bool('downloadsPageEnabled'), 'pages',
                reqWarn ? 'Enabled but neither Seerr nor *arr is configured' : 'Enabled',
                reqWarn);
            var calWarn = bool('calendarPageEnabled') && !anyArrConfigured();
            feat('Calendar Page', bool('calendarPageEnabled'), 'pages',
                calWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                calWarn);

            // Custom splash screen / branding. Both the splash screen and the
            // branding image uploads (icons/favicon/logos) are handled by Jellyfin
            // Enhanced itself at request time, so no extra plugin is required.
            var splashOn = bool('enableCustomSplashScreen');
            feat('Custom splash / branding', splashOn, 'extras', 'Enabled', false);

            // Extras
            var elsewhereWarn = bool('elsewhereEnabled') && !val('TMDB_API_KEY');
            feat('Elsewhere (streaming providers)', bool('elsewhereEnabled'), 'elsewhere',
                elsewhereWarn ? 'Enabled but TMDB API key is missing' : 'Enabled',
                elsewhereWarn);

            // Seerr
            var seerrWarn = bool('jellyseerrEnabled') && !seerrConfigured();
            feat('Seerr integration', bool('jellyseerrEnabled'), 'seerr',
                seerrWarn ? 'Enabled but Seerr URL or API key missing' : 'Enabled',
                seerrWarn);

            var seerrLinkOn = bool('jellyseerrEnabled') && bool('jellyseerrShowDetailPageLink');
            var seerrLinkWarn = seerrLinkOn && !seerrConfigured();
            feat('Seerr detail-page link', seerrLinkOn, 'seerr',
                seerrLinkWarn ? 'Enabled but Seerr URL or API key missing' : 'Enabled',
                seerrLinkWarn);

            // Watchlist (Seerr tab). Sync and "add requested → watchlist" both
            // need KefinTweaks to actually render the watchlist UI in Jellyfin;
            // the feature writes the data either way, but the user can't see
            // it without KefinTweaks.
            var watchlistAny = bool('addRequestedMediaToWatchlist') || bool('syncJellyseerrWatchlist');
            var watchlistWarn = watchlistAny && m.plugins.hasKefinTweaks !== true;
            feat('Watchlist sync', watchlistAny, 'seerr',
                watchlistWarn ? 'Enabled but KefinTweaks plugin not installed (watchlist UI won\'t render)' : 'Enabled',
                watchlistWarn);

            // *arr
            var arrLinksWarn = bool('arrLinksEnabled') && !anyArrConfigured();
            feat('*arr detail-page links', bool('arrLinksEnabled'), 'arr',
                arrLinksWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                arrLinksWarn);
            var tagsSyncWarn = bool('arrTagsSyncEnabled') && !anyArrConfigured();
            feat('*arr tags sync', bool('arrTagsSyncEnabled'), 'arr',
                tagsSyncWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                tagsSyncWarn);

            // Stable ordering: warnings first, then on, then off
            features.sort(function(a, b) {
                var ord: Readonly<Record<string, number>> = { warn: 0, on: 1, off: 2 };
                return (ord[a.state] ?? 0) - (ord[b.state] ?? 0);
            });

            root.textContent = '';
            if (features.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'je-checklist-empty';
                empty.textContent = 'No features configured yet.';
                root.appendChild(empty);
                return;
            }
            features.forEach(function(f) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'je-feature-row je-state-' + f.state;
                row.setAttribute('data-target', f.tab);
                var icon = document.createElement('i');
                icon.className = 'material-icons je-feature-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = f.state === 'on'   ? 'check_circle'
                                 : f.state === 'warn' ? 'warning'
                                 : 'radio_button_unchecked';
                row.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'je-feature-body';
                var name = document.createElement('div');
                name.className = 'je-feature-name';
                name.textContent = f.name;
                body.appendChild(name);
                var detail = document.createElement('div');
                detail.className = 'je-feature-detail';
                detail.textContent = f.detail;
                body.appendChild(detail);
                row.appendChild(body);
                row.addEventListener('click', function() {
                    var targetTab = f.tab;
                    var tabBtn = asHtml(document.querySelector('.jellyfin-tab-button[data-tab="' + targetTab + '"]'));
                    if (tabBtn) tabBtn.click();
                });
                root.appendChild(row);
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        renderFeaturesDashboard,
        renderOptionalPluginsDashboard,
    };
}
