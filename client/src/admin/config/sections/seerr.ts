import type { DefineSections } from '../engine/schema';

export function defineSeerr(define: DefineSections): void {
/* Seerr tab sections. See jeAdmin.js for the field spec. Fields marked manual are rendered here but still loaded
 * and saved by configPage.html (clamping, URL validation or multi-field logic). Native elements only. */
    // Secret/key row: native input, a status icon span and a Test button, all keyed by id/class for the page's handlers.
    const keyRow = (id: string, name: string, label: string, statusId: string, btn: string, desc: string): string =>
        '<div class="inputContainer jea-row"><label class="inputLabel" for="' + id + '">' + label + '</label>' +
        '<div class="jea-inline"><input id="' + id + '" name="' + name + '" type="text" class="jea-input" autocomplete="off"/>' +
        '<span id="' + statusId + '" class="material-icons"></span>' + btn + '</div></div>' +
        '<div class="je-setting-description" data-desc-for="' + id + '"><div class="fieldDescription">' + desc + '</div></div>';

define({
    'seerr-connection': {
        title: 'Seerr Connection Setup', icon: 'link', attrs: { 'data-dep-setup': '' },
        items: [
            { id: 'jellyseerrEnabled', prop: 'JellyseerrEnabled', type: 'toggle', main: true, label: 'Enable Seerr integration',
              desc: 'Enables all Seerr-powered features for this server: Seerr search results, request buttons, the Requests page, auto-requests, and user import. Required for any Seerr feature to work.' },
            { id: 'jellyseerrUrls', type: 'textarea', manual: true, rows: 3, label: 'Seerr URL(s) (One per line)',
              placeholder: 'http://192.168.1.10:5055\nhttps://jellyseerr.example.com',
              desc: 'Enter your Seerr instance URLs, one per line. The script will use the first one that connects successfully.' },
            { type: 'custom', html: keyRow('JellyseerrApiKey', 'JellyseerrApiKey', 'Seerr API Key', 'jellyseerrStatusIndicator',
                '<button type="button" id="testJellyseerrBtn" class="jea-btn">Test</button>',
                'API key from Seerr. (Settings &gt; General Settings &gt; API Key)') },
            { type: 'custom', html: keyRow('jellyseerr_TMDB_API_KEY', 'TMDB_API_KEY', 'TMDB API Key', 'jellyseerrTmdbStatusIndicator',
                '<button type="button" class="testTmdbBtn jea-btn">Test</button>',
                'Your API key from The Movie DB (TMDB). <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">How to?</a><br/>TMDB API key for automatic movie collection requests and Seerr Collection Results. Shared with Elsewhere Settings') },
            { type: 'group', title: 'Advanced URL Mappings', items: [
                { id: 'jellyseerrUrlMappings', type: 'textarea', manual: true, rows: 4, label: 'Seerr URL Mappings',
                  placeholder: 'https://jellyfin.mydomain.com|https://jellyseerr.mydomain.com',
                  desc: 'Map your Jellyfin URLs to specific Seerr URLs for displaying links to users. Users will get the appropriate Seerr link when using "Link result titles to Seerr instead of TMDB", based on what link they use to access Jellyfin.<br/>Format: <code>JellyfinURL|SeerrURL</code>, one mapping per line.<br/>If no mapping matches or this is empty, the first URL from above will be used.' },
                { type: 'note', html: '<strong>URL Mapping Examples:</strong><br/>Remote access: <code>https://jellyfin.mydomain.com|https://jellyseerr.mydomain.com</code><br/>Local access: <code>http://192.168.1.10:8096|http://192.168.1.10:5055</code><br/>With base URL: <code>https://example.com/jellyfin|https://example.com/jellyseerr</code>' },
                { type: 'note', tone: 'warn', html: 'Make sure proper mappings are added to appropriate URLs in order for mobile clients to open Seerr links correctly.' },
                { type: 'note', html: '"<b>Enable Jellyfin Sign-In</b>" must be enabled in Seerr User Settings (/settings/users). All users must be imported to Seerr as Jellyfin users for them to be able to request content.' },
                { type: 'button', id: 'validateSeerrMappingsBtn', label: 'Validate Mappings' },
                { type: 'custom', html: '<div id="seerrMappingsValidationResult" style="display: none;"></div>' }
            ] },
            { type: 'note', html: '<b>Jellyfin Enhanced is not affiliated with Seerr.</b> Seerr is an independent project. This plugin only uses Seerr\'s public API to integrate request and discovery features into Jellyfin. Please report plugin issues to the <a href="https://github.com/n00bcodr/Jellyfin-Enhanced/issues" target="_blank" rel="noopener">Jellyfin Enhanced issue tracker</a>, not the Seerr team.' }
        ]
    },

    'seerr-search': {
        title: 'Search & Requests', icon: 'search',
        items: [
            { id: 'jellyseerrShowSearchResults', prop: 'JellyseerrShowSearchResults', type: 'toggle', default: true, label: 'Show Seerr Results in Search',
              desc: 'Enhance Jellyfin search by showing results from Seerr.<br/>This allows users to discover and request missing movies and shows directly from Jellyfin.' },
            { id: 'jellyseerrSearchExcludeLibraryItems', prop: 'JellyseerrSearchExcludeLibraryItems', type: 'toggle', label: 'Exclude search items already in library',
              desc: 'Hide Seerr search results that already exist in your Jellyfin library (the ones marked as available), including shows where only some seasons are in the library.<br/>If disabled, available items are shown and link to the media item in the library.' },
            { type: 'custom', html: '<div class="jea-note jea-note-warn" id="je-search-exclude-library-warning" style="display:none;"><strong>Warning:</strong> A movie in the library in a lower quality won\'t appear to request in higher quality like 4K, and a show with only some seasons won\'t appear to request the rest. Missing seasons can still be requested with the <strong>Request More</strong> button on the show\'s page, and anything can still be requested directly in Seerr.</div>' },
            { id: 'showCollectionsInSearch', prop: 'ShowCollectionsInSearch', type: 'toggle', default: true, label: 'Show Collections in Seerr Results',
              desc: 'Display TMDB collections (e.g., Harry Potter, Marvel Cinematic Universe) in Seerr search results with an option to request the entire collection at once.' },
            { id: 'jellyseerrEnable4kRequests', prop: 'JellyseerrEnable4KRequests', type: 'toggle', label: 'Enable 4K Requests',
              desc: 'When enabled, movie request buttons include a dropdown to request a 4K version.' },
            { id: 'jellyseerrEnable4kTvRequests', prop: 'JellyseerrEnable4KTvRequests', type: 'toggle', label: 'Enable 4K TV Requests',
              desc: 'When enabled, TV request buttons include a dropdown that opens the season request modal in 4K mode.' },
            { id: 'jellyseerrShowAdvanced', prop: 'JellyseerrShowAdvanced', type: 'toggle', label: 'Show advanced request options',
              desc: 'Lets users choose the Server, Quality and Path while requesting. Only shown to users with the Advanced Requests (or Manage Requests) permission in Seerr. <br/> Note: This will disregard any Override Rules set in Seerr.' },
            { id: 'jellyseerrSingleSeasonRequestOnly', prop: 'JellyseerrSingleSeasonRequestOnly', type: 'toggle', label: 'Only allow requesting one season at a time',
              desc: 'Removes "Select All" and lets users pick only one season per request. Requires "Partial requests" to be enabled in Seerr; otherwise Seerr itself requires all seasons.' },
            { id: 'jellyseerrShowQuotaInfo', prop: 'JellyseerrShowQuotaInfo', type: 'toggle', default: true, label: 'Show request quota info',
              desc: 'When enabled, request modals display a chip showing the user\'s request usage and when their next slot frees up. Quota errors get a detailed dialog instead of a vanishing toast.' }
        ]
    },

    'seerr-discovery': {
        title: 'Discovery & UI Extras', icon: 'explore',
        items: [
            { id: 'jellyseerrUseMoreInfoModal', prop: 'JellyseerrUseMoreInfoModal', type: 'toggle', label: 'Open results in "More Info" modal',
              desc: 'When enabled, clicking a Seerr result title or poster opens an in-app More Info modal.<br/>When disabled, clicking will open the item in Seerr.' },
            { id: 'jellyseerrAvailablePosterLinksToJellyfin', prop: 'JellyseerrAvailablePosterLinksToJellyfin', type: 'toggle', label: 'Link available items\' posters straight to Jellyfin',
              desc: 'For a Seerr result that\'s already available in your library, clicking the poster goes straight to the Jellyfin item, just like the title link already does. If "Open results in More Info modal" above is enabled, the modal can no longer be opened by clicking the poster of an available item.' },
            { id: 'jellyseerrShowReportButton', prop: 'JellyseerrShowReportButton', type: 'toggle', label: 'Show "Report Issue" button on items',
              desc: 'When enabled, a small report icon will be added to item action icons allowing users to report playback/content issues to Seerr.' },
            { id: 'jellyseerrShowIssueIndicator', prop: 'JellyseerrShowIssueIndicator', type: 'toggle', label: 'Show open issue indicator',
              desc: 'When enabled, the report issue button turns orange and shows a count badge if the item has open issues in Seerr.' },
            { id: 'showElsewhereOnJellyseerr', prop: 'ShowElsewhereOnJellyseerr', type: 'toggle', label: 'Show Streaming Providers on Posters',
              desc: 'Displays icons of available streaming services (from your default region) on Seerr Posters.<br/><br/><b>Requires TMDB API Key to be configured in Elsewhere Settings</b>' },
            { id: 'jellyseerrShowDetailPageLink', prop: 'JellyseerrShowDetailPageLink', type: 'toggle', default: true, label: 'Show Seerr link on item detail pages',
              desc: 'Adds a Seerr tag to the External Links row on movie/show detail pages (the same row TMDB/IMDb icons appear in, and *arr links when enabled; it shows there regardless of whether *arr links are configured). If "Open results in More Info modal" above is enabled, clicking it opens that modal (status, downloads, and who requested it); otherwise it links straight to the item on Seerr.' },
            { id: 'jellyseerrShowDetailPageLinkAsText', prop: 'JellyseerrShowDetailPageLinkAsText', type: 'toggle', label: 'Show as text instead of icon',
              desc: 'Renders the Seerr detail-page link as the word "Seerr" instead of the icon. Independent of the *arr links "show as text" setting, so it applies even when *arr links are disabled.' },
            { type: 'group', title: 'Item Pages Discovery', items: [
                { id: 'jellyseerrShowSimilar', prop: 'JellyseerrShowSimilar', type: 'toggle', default: true, label: 'Show similar items',
                  desc: 'Displays similar movies/shows from Seerr on item details pages. Limited to 20 items.' },
                { id: 'jellyseerrShowRecommended', prop: 'JellyseerrShowRecommended', type: 'toggle', default: true, label: 'Show recommended items',
                  desc: 'Displays recommended movies/shows from Seerr on item details pages. Limited to 20 items.' },
                { id: 'jellyseerrShowRequestMoreOnSeries', prop: 'JellyseerrShowRequestMoreOnSeries', type: 'toggle', default: true, label: 'Show "Request More" button on Series',
                  desc: 'Adds a "Request More" button beside the Seasons section heading on Series detail pages when the show has unrequested seasons in Seerr. Lets users request additional seasons without going through the search bar.' },
                { id: 'jellyseerrExcludeLibraryItems', prop: 'JellyseerrExcludeLibraryItems', type: 'toggle', default: true, label: 'Exclude items already in library',
                  desc: 'Hide similar/recommended items that already exist in your Jellyfin library from the results.<br/>If disabled, the items that are available link to the media item in the library.' },
                { id: 'jellyseerrExcludeBlocklistedItems', prop: 'JellyseerrExcludeBlocklistedItems', type: 'toggle', label: 'Exclude blocklisted items',
                  desc: 'When enabled, items marked as blocklisted in Seerr will not appear in similar/recommended suggestions.' }
            ] },
            { type: 'group', title: '"More" Discovery', items: [
                { id: 'jellyseerrShowNetworkDiscovery', prop: 'JellyseerrShowNetworkDiscovery', type: 'toggle', default: true, label: 'Show "More from Network"',
                  desc: 'When viewing a network page (e.g., Netflix, HBO), displays additional content from that network available in Seerr.' },
                { id: 'jellyseerrShowGenreDiscovery', prop: 'JellyseerrShowGenreDiscovery', type: 'toggle', default: true, label: 'Show "More Genre"',
                  desc: 'When viewing a genre page (e.g., Action, Comedy), displays additional content in that genre from Seerr.' },
                { id: 'jellyseerrShowTagDiscovery', prop: 'JellyseerrShowTagDiscovery', type: 'toggle', default: true, label: 'Show "More Tag"',
                  desc: 'When viewing a tag page (e.g., cooking, superhero), displays additional content with that keyword from Seerr.' },
                { id: 'jellyseerrShowPersonDiscovery', prop: 'JellyseerrShowPersonDiscovery', type: 'toggle', default: true, label: 'Show "More from Actor"',
                  desc: 'When viewing an actor/person page, displays their filmography from Seerr including content not in your library.' },
                { id: 'jellyseerrShowCollectionDiscovery', prop: 'JellyseerrShowCollectionDiscovery', type: 'toggle', default: true, label: 'Show missing collection movies',
                  desc: 'When viewing a collection/BoxSet page, shows movies from the collection that are not yet in your library with request buttons.' }
            ] }
        ]
    },

    'seerr-auto-season': {
        title: 'Auto Season Requests', icon: 'playlist_add',
        items: [
            { id: 'autoSeasonRequestEnabled', prop: 'AutoSeasonRequestEnabled', type: 'toggle', main: true, label: 'Enable Automatic Advance Season Requests',
              desc: 'Automatically request the next season in Seerr when a user is about to finish the current season.' },
            { id: 'autoSeasonRequestRequireAllWatched', prop: 'AutoSeasonRequestRequireAllWatched', type: 'toggle', label: 'Require All Prior Episodes Watched',
              desc: 'Require all episodes before the threshold to be watched. For example, if threshold is 2 and there are 10 episodes, when watching episode 8, all episodes 1-7 must be watched or marked as watched. This prevents accidentally triggering requests by jumping to later episodes.<br/>This might cause requests to not be triggered if users skip episodes.' },
            { id: 'autoSeasonRequestThresholdValue', prop: 'AutoSeasonRequestThresholdValue', type: 'number', min: 1, max: 20, default: 2, label: 'Episodes Remaining Threshold',
              toConfig: (v) => Math.trunc(v) || 2,
              desc: 'Request the next season when the number of unwatched episodes is at or below this number. Default: 2 episodes.' },
            { type: 'note', html: 'Requests are triggered when users start or complete watching episodes.<br/>Set the threshold to 2-3 episodes to give time for downloading before users finish watching.<br/>Example: with threshold 2, when a user starts episode 8 of 10 of season 1, season 2 is requested.<br/>If a user has already triggered a request for a season, it is not requested again even if another user reaches the threshold.' }
        ]
    },

    'seerr-auto-movie': {
        title: 'Auto Movie Requests', icon: 'movie',
        items: [
            { id: 'autoMovieRequestEnabled', prop: 'AutoMovieRequestEnabled', type: 'toggle', main: true, label: 'Enable Auto Movie Requests',
              desc: 'Automatically request the next movie in a collection based on configured triggers.<br/><strong>Requirements:</strong> TMDB API key must be configured.' },
            // Triggers map to one AutoMovieRequestTriggerType value, so these three stay loaded and saved by configPage.html.
            { id: 'autoMovieRequestTriggerOnStart', manual: true, type: 'toggle', label: 'When movie starts',
              desc: 'Trigger an auto-request for the next movie in the collection as soon as a user starts a movie.' },
            { id: 'autoMovieRequestTriggerOnMinutesWatched', manual: true, type: 'toggle', label: 'After X minutes watched',
              desc: 'Select one or both triggers. If both are selected, the request will be triggered if either condition is met.' },
            { id: 'autoMovieRequestMinutesWatched', manual: true, type: 'number', min: 1, max: 180, placeholder: '20', label: 'Minutes Watched Threshold',
              desc: 'How many minutes a user should watch before triggering a request? Must be between 1 and 180 minutes.' },
            { id: 'autoMovieRequestCheckReleaseDate', prop: 'AutoMovieRequestCheckReleaseDate', type: 'toggle', default: true, label: 'Only request if released',
              desc: 'When enabled, future releases will be skipped. Only movies that have already been released will be requested.' },
            { id: 'autoMovieRequestQualityMode', prop: 'AutoMovieRequestQualityMode', type: 'select', default: 'default', label: 'Quality Profile Mode',
              options: [['default', 'Default'], ['original', 'Original'], ['custom', 'Custom']],
              desc: '<strong>Default:</strong> Seerr uses its default Radarr server and quality profile.<br/><strong>Original:</strong> Uses the same quality profile as the movie being watched (falls back to default if not found).<br/><strong>Custom:</strong> Always uses the specific Radarr server, quality profile, and root folder selected below.' },
            { id: 'autoMovieRequestFallbackOn4k', prop: 'AutoMovieRequestFallbackOn4k', type: 'toggle', default: true, label: 'Use default instead of 4K fallback',
              desc: 'Only applies when Quality Profile Mode is set to "Original". If the watched movie was requested with a 4K profile, the auto-request will use Seerr\'s default profile instead. This prevents requests from failing or requiring manual approval for users who don\'t have 4K request permissions in Seerr. Disable this if all your users have 4K request access and you want to preserve the original 4K profile.' },
            { type: 'custom', html:
              '<div id="autoMovieRequestCustomSettings" class="jea-custom-box" style="display:none;">' +
                '<div class="inputContainer jea-row"><label class="inputLabel" for="autoMovieRequestServer">Radarr Server</label><select id="autoMovieRequestServer" name="autoMovieRequestServer" class="jea-input"></select></div>' +
                '<div class="inputContainer jea-row"><label class="inputLabel" for="autoMovieRequestProfile">Quality Profile</label><select id="autoMovieRequestProfile" name="autoMovieRequestProfile" class="jea-input"></select></div>' +
                '<div class="inputContainer jea-row"><label class="inputLabel" for="autoMovieRequestRootFolder">Root Folder</label><select id="autoMovieRequestRootFolder" name="autoMovieRequestRootFolder" class="jea-input"></select></div>' +
                '<div class="je-setting-description" data-desc-for="autoMovieRequestRootFolder"><div class="fieldDescription">These settings are only used when Quality Profile Mode is set to "Custom".</div></div>' +
              '</div>' },
            { type: 'note', html: 'Only works for movies that are part of a TMDB collection (e.g., <a class="je-bold-link" href="https://www.themoviedb.org/collection/86311" target="_blank">The Avengers Collection</a>, <a class="je-bold-link" href="https://www.themoviedb.org/collection/10" target="_blank">Star Wars Collection</a>).<br/>Automatically requests the next movie in the collection based on release order.<br/>Movies already available or requested are skipped.' }
        ]
    },

    'seerr-sync': {
        title: 'Recently Added Sync to Seerr', icon: 'sync',
        items: [
            { id: 'triggerSeerrScanOnItemAdded', prop: 'TriggerSeerrScanOnItemAdded', type: 'toggle', main: true, label: 'Trigger Seerr recently-added scan when new Jellyfin items are added',
              desc: 'When Jellyfin reports new library items added, enabling this triggers the "Jellyfin Recently Added Scan" job so that request statuses are immediately updated instead of waiting till next schedule run. Events are debounced, so a bulk import collapses into a single trigger.<br/><strong>Tip:</strong> With this enabled, you can set Seerr\'s recently-added scan Frequency to a much longer interval (60 minutes) to reduce noise.' },
            // Clamped to 5..3600 on save, so loaded and saved by configPage.html.
            { id: 'seerrScanDebounceSeconds', manual: true, type: 'number', min: 5, max: 3600, step: 1, label: 'Debounce (seconds)',
              desc: 'Wait this many seconds after the LAST item added before firing the scan. Default 60. Range 5 to 3600.' },
            { type: 'custom', html: '<div class="jea-actions"><button type="button" id="triggerSeerrScanNowBtn" class="jea-btn">Trigger scan now</button><span id="triggerSeerrScanNowStatus" class="material-icons" aria-hidden="true"></span></div>' +
              '<div class="je-setting-description" data-desc-for="triggerSeerrScanNowBtn"><div class="fieldDescription">Uses the Seerr URL and API key entered in the Connection Setup section above. If multiple URLs are configured, the first reachable one is used.</div></div>' }
        ]
    },

    'seerr-watchlist': {
        title: 'Watchlist', icon: 'bookmark_added',
        items: [
            { type: 'note', html: 'A <strong>Jellyfin watchlist</strong> is the list kept by KefinTweaks (items a user has "liked"). Each user also has a <strong>Seerr watchlist</strong>. These settings decide how the two lists follow each other. <strong>Adding</strong> and <strong>removing</strong> are chosen separately. Each sync runs from Jellyfin Dashboard &gt; Scheduled Tasks.<br/><strong>Note:</strong> Requires <a class="je-bold-link" href="https://github.com/ranaldsgift/KefinTweaks" target="_blank">KefinTweaks</a> to actually show the Jellyfin watchlist. <span class="je-installed-badge" data-plugin="kefintweaks"><i class="material-icons" aria-hidden="true">check_circle</i>KefinTweaks detected</span>' },
            { type: 'group', title: 'Adding items', open: true, items: [
                { type: 'note', html: 'Choose which direction new items travel. Turn on both to have a new item added on either side appear on the other.' },
                { id: 'addRequestedMediaToWatchlist', prop: 'AddRequestedMediaToWatchlist', type: 'toggle', label: 'Requested media goes on the requester\'s watchlist',
                  desc: 'Something a user requests through Seerr Search here goes on that user\'s Seerr watchlist as soon as the request is made, and on their Jellyfin watchlist when it arrives in your library. This is independent of the two adding options below. Changing it needs a Jellyfin restart.' },
                { id: 'syncJellyseerrWatchlist', prop: 'SyncJellyseerrWatchlist', type: 'toggle', label: 'Seerr → Jellyfin: add Seerr watchlist items to Jellyfin',
                  desc: 'Items a user adds to their Seerr watchlist are added to their Jellyfin watchlist (only if the item is in your library).<br/>Runs in Scheduled Tasks &gt; "Sync Watchlist from Seerr to Jellyfin".' },
                { id: 'syncJellyfinWatchlistToSeerr', prop: 'SyncJellyfinWatchlistToSeerr', type: 'toggle', label: 'Jellyfin → Seerr: add Jellyfin watchlist items to Seerr',
                  desc: 'Items a user adds to their Jellyfin watchlist are added to their Seerr watchlist.<br/>Runs in Scheduled Tasks &gt; "Sync Watchlist from Jellyfin to Seerr".' },
                { id: 'preventWatchlistReAddition', prop: 'PreventWatchlistReAddition', type: 'toggle', default: true, label: 'Don\'t re-add items a user removed from Jellyfin',
                  desc: 'An item from Seerr is put on a user\'s Jellyfin watchlist only once. If they remove it, the Seerr → Jellyfin sync will not put it back.' },
                // Clamped to 1..3650 on save; shown only while the toggle above is on and the removal mode below leaves
                // something to re-add (updateWatchlistMemoryVisibility in page/dependencies.ts).
                { id: 'watchlistMemoryRetentionDays', manual: true, type: 'number', min: 1, max: 3650, step: 1, label: 'Remember removed items for (days)',
                  desc: 'After this many days an item the user removed may be added again, if it is still on their Seerr watchlist or requests. 365 is recommended; 3650 is nearly permanent.' }
            ] },
            { type: 'group', title: 'Removing items', open: true, items: [
                { type: 'note', html: 'Decide whose removals count. Removing an item, or <strong>watching it</strong> (KefinTweaks drops watched items from the Jellyfin watchlist), is a removal. Only items that were on <strong>both</strong> lists are ever removed, so something added on one side and not yet synced is never deleted.' },
                { id: 'watchlistRemovalSync', prop: 'WatchlistRemovalSync', type: 'select', default: 'jellyfin', label: 'When an item is removed from a watchlist',
                  options: [
                      ['jellyfin', 'Jellyfin decides: removed from Jellyfin → also removed from Seerr'],
                      ['seerr', 'Seerr decides: removed from Seerr → also removed from Jellyfin'],
                      ['both', 'Both stay in sync: a removal on either side is copied to the other'],
                      ['off', 'Never remove anything automatically']
                  ],
                  desc: '<strong>Jellyfin decides</strong> (recommended): removing or watching an item in Jellyfin removes it from Seerr. Removing it only in Seerr changes nothing in Jellyfin.<br/><strong>Seerr decides</strong>: the opposite. Removing it only in Jellyfin changes nothing in Seerr.<br/><strong>Both stay in sync</strong>: whichever side an item is removed from, the other follows.<br/><strong>Never</strong>: no removals are copied.<br/>Runs daily in Scheduled Tasks &gt; "Sync Watchlist Removals between Jellyfin and Seerr", after the two add syncs. The first run only records what is on both lists and removes nothing. Does nothing unless at least one of the adding options above is on.<br/>With <strong>Jellyfin decides</strong> or <strong>Both</strong>, an item removed in Jellyfin is also removed from Seerr, so it can\'t come back and the "Don\'t re-add" options above are hidden. They appear for <strong>Seerr decides</strong> and <strong>Never</strong>.' }
            ] }
        ]
    },

    'seerr-users': {
        title: 'Users', icon: 'group_add',
        items: [
            { id: 'jellyseerrAutoImportUsers', prop: 'JellyseerrAutoImportUsers', type: 'toggle', label: 'Auto import Jellyfin users to Seerr',
              desc: 'Automatically import Jellyfin users into Seerr so they can use Seerr Search without needing to visit Seerr directly. New users are imported the first time they use Seerr Search; a scheduled task also bulk-imports periodically. Already-imported users are skipped.<br/>Configure the bulk import frequency in Jellyfin Dashboard &gt; Scheduled Tasks &gt; "Import Jellyfin Users to Seerr".' },
            { type: 'custom', html:
              '<details id="blockedUsersDetails" class="jea-group">' +
                '<summary>Blocked Users <span id="blockedUsersCount">(none)</span></summary>' +
                '<div class="jea-group-body">' +
                  '<div class="fieldDescription">Select users to exclude from Seerr import. Blocked users will never be looked up or imported. No API calls are made for them.</div>' +
                  '<div id="blockedUsersContainer" style="max-height: 200px; overflow-y: auto;"><span class="je-loading-text">Loading users...</span></div>' +
                  '<div id="blockedUsersScrollHint" style="display: none;">▼ scroll for more</div>' +
                '</div>' +
              '</details>' +
              '<input id="jellyseerrImportBlockedUsers" type="hidden" value=""/>' },
            { type: 'button', id: 'btnImportJellyseerrUsers', label: 'Import Users Now', variant: 'primary' },
            { type: 'custom', html: '<div id="importUsersResult" style="display: none; margin-top:10px;"></div>' }
        ]
    },

    'seerr-audit': {
        title: 'Permission Audit', icon: 'verified_user',
        items: [
            { type: 'note', html: 'Check which users are missing Seerr permissions required for the features you have enabled. Only users linked to a Seerr account are checked.' },
            { type: 'button', id: 'btnPermissionAudit', label: 'Run Audit', variant: 'primary' },
            { type: 'custom', html: '<div id="permissionAuditResult" style="display: none; margin-top: 1em;"></div>' }
        ]
    },

    'seerr-debug': {
        title: 'Debug & Caching', icon: 'bug_report',
        items: [
            { id: 'jellyseerrDisableCache', prop: 'JellyseerrDisableCache', type: 'toggle', label: 'Disable server-side response cache',
              desc: 'When enabled, all Seerr proxy requests bypass the server-side cache and are fetched fresh from Seerr every time. This is useful for testing but will increase load on your Seerr instance. <b>Not recommended for normal use.</b>' },
            { id: 'jellyseerrResponseCacheTtlMinutes', prop: 'JellyseerrResponseCacheTtlMinutes', type: 'number', min: 1, default: 10, label: 'Response Cache TTL (min)',
              toConfig: (v) => Math.trunc(v) || 10,
              desc: 'How long Seerr API responses (search, discovery, recommendations) are cached. Default: 10 minutes.' },
            { id: 'jellyseerrUserIdCacheTtlMinutes', prop: 'JellyseerrUserIdCacheTtlMinutes', type: 'number', min: 1, default: 30, label: 'User ID Cache TTL (min)',
              toConfig: (v) => Math.trunc(v) || 30,
              desc: 'How long the Jellyfin → Seerr user ID mapping is cached. Default: 30 minutes.' }
        ]
    }
});
}
