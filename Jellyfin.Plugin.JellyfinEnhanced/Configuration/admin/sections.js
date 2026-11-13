/* Settings sections for every tab. Fields and cards are defined here; jeAdmin.js renders them. */

/* ===== display ===== */
/* Display tab sections. See jeAdmin.js for the field spec. */
JEAdmin.define({
        'ui-preferences': {
            title: 'UI Preferences',
            fields: [
                { id: 'showWatchProgress', prop: 'ShowWatchProgress', type: 'toggle', perUser: true, label: 'Show watch progress',
                  desc: 'Show watch progress for items in item details page.' },
                { id: 'watchProgressDefaultMode', prop: 'WatchProgressDefaultMode', type: 'select', default: 'percentage', label: 'Watch Progress Default',
                  options: [['percentage', 'Percentage'], ['time', 'Time Watched'], ['remaining', 'Time Remaining']],
                  desc: 'Choose default display for watch progress (percentage, time watched, or time remaining).' },
                { id: 'watchProgressTimeFormat', prop: 'WatchProgressTimeFormat', type: 'select', default: 'hours', label: 'Watch Progress Time Format',
                  options: [['hours', 'h:m'], ['full', 'y:mo:d:h:m']],
                  desc: 'Select how time-based progress is shown.' },
                { id: 'showFileSizes', prop: 'ShowFileSizes', type: 'toggle', perUser: true, label: 'Show file sizes',
                  desc: 'Display the file size of each item on item detail pages or collections pages.' },
                { id: 'showAudioLanguages', prop: 'ShowAudioLanguages', type: 'toggle', perUser: true, label: 'Show available audio languages on item detail page',
                  desc: 'List the audio language flags available for each title on its detail page.' },
                { id: 'removeContinueWatchingEnabled', prop: 'RemoveContinueWatchingEnabled', type: 'toggle', perUser: true, label: 'Enable "Remove from Continue Watching"',
                  desc: 'Adds a "Remove from Continue Watching" option to the right-click / long-press context menu. Hides items non-destructively, so playback position is preserved and entries appear in Hidden Content\'s management page (look for "Add back to Continue Watching" on each entry). Items also unhide automatically when you resume playback.' }
            ]
        },
        'icons-theme': {
            title: 'Icons & Theme',
            fields: [
                { id: 'useIcons', prop: 'UseIcons', type: 'toggle', main: true, default: true, label: 'Use Icons in UI', descClass: 'je-field-desc-lg',
                  desc: 'Display icons throughout the UI (toasts, settings panel headers, etc.)' },
                { id: 'iconStyle', prop: 'IconStyle', type: 'select', default: 'emoji', label: 'Icon Style',
                  options: [['emoji', 'Emoji'], ['lucide', 'Lucide Icons'], ['mui', 'Material UI Icons']],
                  desc: 'Choose between emoji characters, Lucide icons, or Material UI icons.' }
            ]
        },
        'content-warnings': {
            title: 'Content Warnings (DoesTheDogDie)', iconImg: 'ddd-static/favicon.ico',
            fields: [
                { id: 'doesTheDogDieEnabled', prop: 'DoesTheDogDieEnabled', type: 'toggle', main: true, label: 'Show Content Warnings',
                  toConfig: (v) => !!v, fromConfig: (v) => !!v,
                  desc: '<ul class="je-desc-list"><li>Shows community-voted content warnings (a dog dies, gore, flashing lights and more) on movie and show pages</li><li>Each user picks the triggers they care about with the gear icon on the section</li><li>Requires a free API key from doesthedogdie.com. The free tier is for non-commercial use and allows 5,000 requests a month for the whole server. Results are cached for weeks, so only titles nobody has opened yet cost requests</li></ul>' },
                { id: 'doesTheDogDieApiKey', prop: 'DoesTheDogDieApiKey', type: 'text', label: 'DoesTheDogDie API Key',
                  toConfig: (v) => String(v || '').trim(), fromConfig: (v) => v || '',
                  desc: 'Your API key from your <a class="sectionTitle" href="https://www.doesthedogdie.com/profile" target="_blank">doesthedogdie.com</a> profile page.' }
            ]
        },
        'awards': {
            title: 'Awards',
            fields: [
                { id: 'showAwards', prop: 'ShowAwards', type: 'toggle', main: true, label: 'Show Awards Banner', descClass: 'je-field-desc-sm-font-lg',
                  desc: 'Shows a wins/nominations banner on item-details pages, sourced from Wikidata by TMDB id. Data is as accurate as what is available in Wikidata.' }
            ]
        },
        'random-button': {
            title: 'Random Button',
            fields: [
                { id: 'randomButtonEnabled', prop: 'RandomButtonEnabled', type: 'toggle', perUser: true, main: true, label: 'Enable Random Button',
                  desc: 'Adds a "Play Random" button to the Jellyfin header that opens a random item from the user\'s accessible libraries.' },
                { id: 'randomUnwatchedOnly', prop: 'RandomUnwatchedOnly', type: 'toggle', perUser: true, label: 'Show unwatched only',
                  desc: 'When enabled, the random picker only chooses items the user has not watched yet.' },
                { id: 'randomIncludeMovies', prop: 'RandomIncludeMovies', type: 'toggle', perUser: true, label: 'Include movies',
                  desc: 'Include movies in the random pool.' },
                { id: 'randomIncludeShows', prop: 'RandomIncludeShows', type: 'toggle', perUser: true, label: 'Include shows',
                  desc: 'Include TV Shows in the random pool.' },
                { id: 'randomScopeCurrentContainer', prop: 'RandomScopeCurrentContainer', type: 'toggle', perUser: true, label: 'Scope to the current playlist or collection',
                  desc: 'On a playlist or collection page, the Random button picks from that container\'s items instead of the whole library. Users can also pin a playlist or collection as their permanent source in the Enhanced panel.' }
            ]
        },
        'audio-language-tags': {
            title: 'Audio Language Tags', icon: 'translate',
            fields: [
                { id: 'audioLanguageTagSyncEnabled', prop: 'AudioLanguageTagSyncEnabled', type: 'toggle', main: true, label: 'Enable Audio Language Tags Sync', descClass: 'je-field-desc-xl',
                  desc: 'Adds each movie\'s and series\' audio languages as Jellyfin tags. A regional track such as en-US gets a base tag ("JE Language: English") and a regional tag ("JE Language: English (United States)").<br/><br/>Existing items are tagged by the "Sync Audio Language Tags to Jellyfin" scheduled task. New and changed items are tagged after a library scan when the Server-Side Tag Cache is enabled.' },
                { id: 'audioLanguageTagPrefix', prop: 'AudioLanguageTagPrefix', type: 'text', label: 'Tag Prefix', placeholder: 'JE Language: ', default: 'JE Language: ',
                  desc: 'Prefix added before each language, e.g. "JE Language: English".' },
                { id: 'audioLanguageTagShowAsLinks', prop: 'AudioLanguageTagShowAsLinks', type: 'toggle', default: true, label: 'Link audio languages to their tag page', descClass: 'je-field-desc-xl',
                  desc: 'Links each audio language on item detail pages to Jellyfin\'s list of items with that tag.' }
            ]
        }
    });

/* Overview, Media Tags, Spoiler Guard, MDBList and Default Language. Fields marked manual: true keep their load/save
 * lines in configPage.html (clamps, defaults, JS-populated lists); the schema only renders them. */
(function () {
    const UL = (...li) => '<ul class="je-desc-list">' + li.map((x) => '<li>' + x + '</li>').join('') + '</ul>';
    const tog = (id, label, desc, extra) => Object.assign({ id, type: 'toggle', manual: true, label, desc }, extra);
    const sel = (id, label, options, desc, extra) => Object.assign({ id, type: 'select', manual: true, label, options, desc }, extra);
    const RS = [['tmdb', 'TMDB'], ['tomatoes', 'RT Critic'], ['popcorn', 'RT Audience'], ['imdb', 'IMDb'], ['trakt', 'Trakt'],
        ['metacritic', 'Metascore'], ['metacriticuser', 'Metacritic User'], ['letterboxd', 'Letterboxd'], ['myanimelist', 'MAL'], ['anilist', 'AniList'], ['master', 'Master']];
    const RSN = [['', 'None']].concat(RS);
    const arrow = (d) => '<i class="material-icons je-cat-arrow-icon" aria-hidden="true">arrow_' + d + 'ward</i>';

    JEAdmin.define({
        'overview-status': {
            title: 'Service Status', icon: 'sensors', class: 'je-overview-section',
            items: [{ type: 'custom', html: '<div class="je-service-dashboard" id="je-service-dashboard"><div class="je-checklist-empty">Loading service status…</div></div>' }]
        },
        'overview-plugins': {
            title: 'Optional Dependencies', icon: 'extension', class: 'je-overview-section', id: 'overview-optional-plugins-section',
            items: [{ type: 'custom', html: '<div class="je-optional-plugins-dashboard" id="je-optional-plugins"></div>' }]
        },
        'overview-features': {
            title: 'Features', icon: 'toggle_on', class: 'je-overview-section', id: 'overview-features-section',
            items: [{ type: 'custom', html: '<div class="je-features-dashboard" id="je-features-dashboard"><div class="je-checklist-empty">Loading features…</div></div>' }]
        },
        'overview-actions': {
            title: 'Quick Actions', icon: 'bolt', class: 'je-overview-section', id: 'overview-quick-actions-section',
            items: [{ type: 'custom', html: '<div class="je-quick-actions-grid" id="je-quick-actions-grid">'
                + '<button type="button" id="retestAllConnectionsBtn" class="je-quick-action" data-action="retest-all"><i class="material-icons je-quick-action-icon" aria-hidden="true">sync</i><div class="je-quick-action-text"><span class="je-quick-action-title">Re-test all service connections</span><span class="je-quick-action-detail">Re-runs the TMDB / Seerr / Sonarr / Radarr tests</span></div></button>'
                + '<button type="button" id="resetAllUserSettingsBtn" class="je-quick-action" data-action="apply-all-users"><i class="material-icons je-quick-action-icon" aria-hidden="true">group</i><div class="je-quick-action-text"><span class="je-quick-action-title">Apply all plugin settings to every user</span><span class="je-quick-action-detail">Copies every personal setting from the plugin (Display, Playback, ...) into each user, replacing the values they set for themselves</span></div></button>'
                + '<button type="button" id="clearTagCachesQuickBtn" class="je-quick-action" data-action="clear-tag-caches"><i class="material-icons je-quick-action-icon" aria-hidden="true">cleaning_services</i><div class="je-quick-action-text"><span class="je-quick-action-title">Clear all client tag caches</span><span class="je-quick-action-detail">Forces every client to rebuild its localStorage tag cache</span></div></button>'
                + '</div>' }]
        },

        // Media Tags settings (quality, genre, language, rating and the other tag groups, layout, rules, colours, the tag
        // cache and native poster tags) live on the Media Tags tab (#media-tags, outside this page's form, saved one field
        // at a time). This card has no fields, so this page's load, Save and apply-to-users never read or write any of
        // them; its links open that tab in place (configPage.html handles links to this page itself).
        'media-tags': {
            title: 'Media Tags', icon: 'sell', id: 'mediaTagsCard',
            items: [{ type: 'custom', html: '<div class="je-media-tags-card"><div class="je-media-tags-card-text">'
                + '<div class="fieldDescription">Poster tags (quality, genre, language, rating, age rating, status, people), their default layout, rules and colours, the tag cache and Native Poster Tags have their own tab, Media Tags, which saves each change as you make it.</div>'
                + '<dl class="je-media-tags-card-facts" id="jeMediaTagsCardFacts" aria-live="polite"></dl></div>'
                + '<a class="jea-btn jea-btn-primary je-media-tags-open" href="#/configurationpage?name=Jellyfin%20Enhanced&amp;jeSection=media-tags"><i class="material-icons" aria-hidden="true">sell</i><span>Open Media Tags</span></a>'
                + '<div class="je-media-tags-card-links">'
                + [['layout', 'Layout defaults'], ['groups', 'Groups'], ['rules', 'Rules'], ['colours', 'Colours'], ['badges', 'Status badges'], ['server', 'Tag cache &amp; native posters']]
                    .map(([section, label]) => '<a class="je-media-tags-card-link" href="#/configurationpage?name=Jellyfin%20Enhanced&amp;jeSection=media-tags&amp;tab=' + section + '">' + label + '</a>').join('')
                + '</div></div>' }]
        },

        'spoiler-guard': {
            title: 'Spoiler Guard', icon: 'blur_on',
            items: [
                { type: 'note', html: '<strong>Spoiler Guard</strong> hides episode thumbnails, season posters, movie posters and chapter scenes for unwatched titles each user opts into. It also strips spoiler-bearing metadata: synopses, episode titles, tags, taglines, ratings, air dates, cast on unwatched episodes, chapter names, and TMDB / user reviews on opted-in series.' },
                tog('spoilerBlurEnabled', 'Enable Spoiler Guard', 'Turns the whole feature on. While it\'s off, the per-show toggle button never appears and nothing is ever hidden. Turn it on to let users protect individual shows, movies, and collections from their own detail pages.', { main: true }),
                sel('spoilerBlurMode', 'Image replacement mode', [['hide', 'Show stock cards (hide images entirely, default)'], ['blur', 'Blur images']],
                    'How protected cards look. <strong>Show stock cards</strong> (default) swaps each unwatched image for a safe parent-level placeholder: episodes show their series backdrop, seasons show the series poster, collection-opted movies show the collection art. <strong>Blur images</strong> instead applies a strong blur to the original so silhouettes and dominant colours still hint at "something is here". Pick stock cards for the strictest hide; pick blur if the placeholders feel too aggressive.'),
                { id: 'spoilerBlurIntensity', type: 'number', manual: true, label: 'Blur intensity', min: 5, max: 100, step: 1,
                  desc: 'How strong the blur is. <strong>5</strong> is barely smudged, <strong>40</strong> is the recommended default (characters become unrecognisable but the colours still come through), <strong>100</strong> is almost a solid colour wash. Applies to "Blur images" mode, and to "Show stock cards" mode when an item has no safe parent art to substitute (e.g. a directly-opted-in movie), where the original is blurred as a fallback.' },
                tog('spoilerBlurArtwork', 'Also hide the wide backdrop / fanart', 'By default the protection covers posters, episode thumbs, and screenshots, but leaves the wide cinematic backdrop / fanart on detail pages alone (it\'s usually atmosphere, not plot). Turn this on if you want backdrops hidden too for maximum protection.'),
                tog('spoilerKeepMoviePosters', 'Keep movie posters visible', 'When on, a protected movie\'s poster still shows in full, but the scene thumbnails inside the movie\'s detail page (chapters, screenshots) stay hidden. Useful if you find movie posters are usually marketing art that doesn\'t give plot away, while the chapter scene-thumbs inside the movie do. Doesn\'t affect TV shows.'),
                tog('spoilerBlurTrickplay', 'Hide trickplay seek previews', 'Protects the scrubbing thumbnails the player shows while you seek through an unwatched protected episode or movie. Sheets that end before your saved progress are still shown. Turn this off to always show seek previews. Users can also turn it off for themselves in their Spoiler Guard settings.'),
                tog('spoilerBlurStrictRefresh', 'Strict refresh mode (full page reload after toggle)', 'After a user flips Spoiler Guard on or off, card images update on the page instantly. By default, on-page text (description, episode titles, ratings) only refreshes when they navigate next. Turn this on to also reload the whole page after a toggle so the text updates straight away, at the cost of a brief page flash. Most users prefer it off for the smoother feel.'),
                { type: 'group', title: 'Auto-enable', open: true, items: [
                    tog('spoilerAutoEnableOnFirstPlay', 'Auto-enable Spoiler Guard on first play of a new show', 'When on, Spoiler Guard turns itself on for a series the moment a user starts Season 1 Episode 1 of a show they\'ve never watched. They don\'t have to remember to flip the toggle before pressing play. Rewatches and jumping in at later episodes are ignored; only a fresh first-play counts.'),
                    tog('spoilerAutoEnableOnSeerrRequest', 'Auto-enable Spoiler Guard on Seerr request', 'When on, requesting something through Seerr also pre-arms Spoiler Guard for that title: when the show or movie lands in the library, protection is already on for the user who requested it. Users can also pre-arm titles manually with the "Enable Spoiler Guard" button in the Seerr details popup (always available regardless of this toggle), handy when someone else requested the title first.'),
                    tog('spoilerAutoEnableOnLibraryAdd', 'Auto-enable Spoiler Guard when new titles are added to the library', 'When on, every new show or movie that appears in the library (from a scan, a Seerr download, or a manual copy) is added to the Spoiler Guard list of every user who can see that library, so protection is in place before anyone presses play. Only brand-new titles are affected: a user who later switches Spoiler Guard off for a title isn\'t re-armed by metadata refreshes. Library scans are batched, so a big scan results in one settings write per user rather than one per title.'),
                    { type: 'custom', html: '<div id="spoilerAutoEnableScopeContainer" class="jea-subbox"><div class="jea-subbox-title">Auto-enable applies to</div><div class="fieldDescription">Shared by all three auto-enable options above.</div>'
                        + '<div class="checkboxContainer"><label><input id="spoilerAutoEnableSeries" type="checkbox"/><span>TV shows</span></label></div>'
                        + '<div class="checkboxContainer"><label><input id="spoilerAutoEnableMovies" type="checkbox"/><span>Movies</span></label></div>'
                        + '<div class="fieldDescription">Libraries: leave every library unticked to cover all of them. Doesn\'t apply to Seerr requests (the title isn\'t in a library yet).</div>'
                        + '<div id="spoilerAutoEnableLibraryList"><div class="fieldDescription">Loading libraries…</div></div></div>' },
                    { type: 'custom', html: '<div id="spoilerApplyExistingContainer" class="je-spoiler-apply-existing jea-subbox"><div class="jea-subbox-title">Titles already in the library</div>'
                        + '<div class="fieldDescription">Auto-enable only arms titles as they arrive, and a rescan doesn\'t count (so nobody who switched Spoiler Guard off for a title gets it switched back on). To guard what\'s already there, apply the <em>saved</em> scope above to existing titles, for every user who can see them. Works whether or not "when new titles are added" is on. Titles a user already has, or has fully watched, are skipped. Also available as the "Spoiler Guard: apply to existing titles" scheduled task.</div>'
                        + '<div class="checkboxContainer"><label><input id="spoilerApplyExistingSkipStarted" type="checkbox"/><span>Also skip titles a user has already started watching</span></label></div>'
                        + '<div class="jea-actions"><button id="spoilerApplyExistingBtn" type="button" class="jea-btn"><span>Apply to existing titles now…</span></button></div>'
                        + '<div id="spoilerApplyExistingStatus" class="fieldDescription" aria-live="polite"></div></div>' }
                ] },
                { type: 'group', title: 'Hide metadata on unwatched episodes', items: [
                    { type: 'note', html: 'These options hide spoiler-bearing text on protected TV shows and their unwatched episodes. Hidden centrally so the protection works the same in every Jellyfin client.' },
                    tog('spoilerStripSeriesOverview', 'Hide TV show descriptions', 'Swaps the description on a protected TV show\'s own detail page for the placeholder text below. Independent from episode descriptions, so you can keep the show\'s general premise visible while still hiding episode plots.'),
                    tog('spoilerStripOverview', 'Hide episode descriptions', 'Swaps the per-episode plot summary for the placeholder text below. The single biggest source of leaks, strongly recommended on.'),
                    { id: 'spoilerOverviewPlaceholder', type: 'text', manual: true, label: 'Placeholder text', attrs: { maxlength: '200' },
                      desc: 'Text shown where a protected TV show or episode description would normally appear, so the page doesn\'t have an empty gap. Default: "Spoiler Guard activated".' },
                    tog('spoilerStripTags', 'Hide tags', 'Hides plot-bearing tags (phrases like "Death of a main character") and the genre / quality / language / rating chips Jellyfin Enhanced draws on top of cards. Recommended on.'),
                    tog('spoilerStripChapters', 'Hide chapter names (keep timestamps)', 'Chapter labels like "X dies" or "Y is revealed" can spoil the whole episode. Hides the names but leaves the chapter markers on the seek bar so users can still skip around. Recommended on.'),
                    tog('spoilerStripTaglines', 'Hide taglines', 'Marketing taglines like "Everything changes tonight" basically advertise the twist. Recommended on.'),
                    tog('spoilerStripRatings', 'Hide ratings', 'Hides both the community and critic ratings on unwatched episodes. A standout score like "9.8/10" on a specific episode usually signals a major event. Recommended on.'),
                    tog('spoilerStripPremiereDate', 'Hide air date', 'A long gap before a particular episode can give away "this one\'s the season finale" without even reading the title. Hides the date so the schedule itself stays a surprise.'),
                    tog('spoilerReplaceTitle', 'Replace episode titles', 'Swaps episode names like "The Death of X" for "Season 2, Episode 6". Some clients show the title in navigation tooltips and breadcrumbs where the swap can look a bit clinical; turn off if your users prefer to keep the original titles visible.'),
                    tog('spoilerStripCast', 'Hide cast on unwatched episodes', 'An unexpected guest star, or a regular suddenly missing from the cast list, can give away the whole episode. Hides the cast on unwatched episodes; pick what counts as "cast" below.'),
                    sel('spoilerStripCastMode', 'Cast hiding scope', [['GuestStars', 'Guest stars only (recommended)'], ['All', 'Entire cast (regulars + guest stars)']],
                        '<strong>Guest stars only</strong> keeps the regular cast visible, since they\'re in every episode anyway and don\'t give anything away. <strong>Entire cast</strong> is the strict option for shows where the recurring cast appearing or not appearing in a given episode is itself the spoiler.', { showIf: 'spoilerStripCast' }),
                    tog('spoilerStripReviews', 'Hide reviews on Spoiler Guard series', 'Hides the Reviews panel on the detail pages of shows the user has Spoiler Guard on for. Reviews very often spoil plot points from anywhere in the series. Recommended on.')
                ] },
                { type: 'group', title: 'Advanced per-category reveals', items: [
                    tog('spoilerAdvancedMode', 'Enable advanced per-category reveals', 'Instead of one uniform strip for every unwatched episode, the user\'s <strong>next</strong> unwatched episode and the rest of its season get the reveal settings below. Later seasons, skipped earlier seasons and specials always keep the full strip. A reveal only relaxes a strip that is enabled above; categories whose strip is off show everywhere already. Each user can opt back into the uniform full strip from their settings panel.'),
                    { type: 'note', html: 'Checked = still hidden for that category. Unchecked = revealed. The next-episode title starts revealed; that\'s the point of advanced mode: see <em>what</em> you\'re about to watch, and nothing more.' },
                    tog('spoilerNextEpisodeStripTitle', 'Next episode: keep title hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerNextEpisodeStripOverview', 'Next episode: keep description hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerNextEpisodeStripRatings', 'Next episode: keep ratings hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerNextEpisodeStripImage', 'Next episode: keep image hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerCurrentSeasonStripTitle', 'Current season: keep titles hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerCurrentSeasonStripOverview', 'Current season: keep descriptions hidden', null, { showIf: 'spoilerAdvancedMode' }),
                    tog('spoilerCurrentSeasonStripRatings', 'Current season: keep ratings hidden', '"Current season" is the season containing the next unwatched episode. Card rating overlays and search results stay fully protected regardless of these reveals; only the episode metadata itself (lists and detail pages) is revealed.', { showIf: 'spoilerAdvancedMode' })
                ] }
            ]
        },

        'default-language': {
            title: 'Default Language', icon: 'language',
            items: [sel('DefaultLanguage', 'Default UI Language', [['', 'System Default']], 'Sets the default language for all users. Users can still override this in their own settings.')]
        },

        'mdblist': {
            title: 'MDBList Ratings', iconImg: 'mdblist-static/favicon.ico',
            items: [
                tog('mdblistRatingsEnabled', 'Enable MDBList Ratings', UL('Shows TMDB, Rotten Tomatoes, IMDb, Trakt and other ratings on item-details pages', 'Can fill in Jellyfin\'s own missing Community/Critic Rating fields', 'Requires a free API key from mdblist.com'), { main: true }),
                { type: 'custom', html: '<div class="inputContainer jea-row"><label class="inputLabel" for="mdblistApiKey">MDBList API Key</label>'
                    + '<div class="je-api-row"><input id="mdblistApiKey" type="text" autocomplete="off" class="je-api-input jea-input"/><span id="mdblistStatusIndicator" class="material-icons"></span>'
                    + '<button type="button" id="checkMdblistStatusBtn" class="jea-btn">Check</button></div>'
                    + '<div id="mdblistStatusLine" class="jea-hint">&nbsp;</div></div>'
                    + '<div class="je-setting-description" data-desc-for="mdblistApiKey"><div class="fieldDescription">Your API key from <a class="sectionTitle" href="https://mdblist.com/preferences/#api" target="_blank">mdblist.com</a>.</div></div>' },
                tog('mdblistRatingsShowOnItemDetails', 'Show Ratings Row on Item Details', 'Displays the MDBList ratings row on item-details pages.'),
                tog('mdblistRatingsShowPercentSymbol', 'Show % Symbol', 'Appends "%" after each rating badge\'s number.'),
                { type: 'custom', html: '<details id="mdblistSourcesAdminDetails" class="je-details-section"><summary>Configure ratings shown</summary><div class="je-details-body"><div class="fieldDescription je-field-desc-sm">Pick which ratings appear on the item-details row, and the order they\'re shown in. Use the '
                    + arrow('up') + ' / ' + arrow('down') + ' buttons to reorder. All checked by default.</div><div id="mdblistRatingsSourcesAdmin"></div></div></details>' },
                { type: 'group', title: 'Fetch ratings (scheduled task)', items: [
                    tog('mdblistRatingsFetchEnabled', 'Fetch Ratings from MDBList', 'Enables the <strong>Fetch Ratings from MDBList</strong> scheduled task (Dashboard, Scheduled Tasks):' + UL(
                        'Looks up MDBList data for any movie/series whose cached ratings are missing or stale, and saves it. Doesn\'t touch Jellyfin\'s own rating fields',
                        'A found title stays cached for 7 days (3 days for a confirmed "no match") before being refetched. Already-fresh titles are skipped on a re-run, so it\'s safe to schedule this frequently, even daily',
                        'Stops once today\'s quota drops to the reserve below')),
                    { id: 'mdblistFetchReserve', type: 'number', manual: true, label: 'Fetch Task Reserve', min: 1, max: 100000, showIf: 'mdblistRatingsFetchEnabled',
                      desc: 'The fetch task stops once today\'s live remaining quota drops to this many, reserving that much for people browsing the library (an item-details page fetches live if nothing\'s cached yet).' }
                ] },
                { type: 'group', title: 'Sync ratings into Jellyfin (scheduled task)', items: [
                    tog('mdblistRatingsAutoSyncEnabled', 'Sync Ratings from MDBList to Jellyfin', 'Enables the <strong>Sync Ratings from MDBList to Jellyfin</strong> scheduled task:' + UL(
                        'Sets Community / Critic Ratings (source selectable below, default TMDB / Rotten Tomatoes) from whatever\'s already cached (see Fetch above) into Jellyfin\'s own fields',
                        'Requires the <strong>Fetch Ratings from MDBList</strong> task to be enabled and run first')),
                    sel('mdblistCommunityRatingSource', 'Star Rating Source (Community Rating)', RS, 'The star rating shown by Jellyfin, on a 0-10 scale (e.g. 7.2). Choose which MDBList source fills it. Default TMDB.', { showIf: 'mdblistRatingsAutoSyncEnabled' }),
                    sel('mdblistCommunityRatingFallbackSource', 'Star Rating Fallback Source', RSN, 'Used when the source above has no score for a title. Default none.', { showIf: 'mdblistRatingsAutoSyncEnabled' }),
                    sel('mdblistCriticRatingSource', 'Tomato Rating Source (Critic Rating)', RS, 'The tomato rating shown by Jellyfin, on a 0-100% scale (e.g. 85%). Choose which MDBList source fills it. Default RT Critic.', { showIf: 'mdblistRatingsAutoSyncEnabled' }),
                    sel('mdblistCriticRatingFallbackSource', 'Tomato Rating Fallback Source', RSN, 'Used when the source above has no score for a title. Default none.', { showIf: 'mdblistRatingsAutoSyncEnabled' }),
                    tog('mdblistRatingsOverwriteExisting', 'Overwrite Existing Jellyfin Ratings', UL('<strong>Off</strong> (default): Only fills an empty rating, never revisits an item once both are set', '<strong>On</strong>: Every run re-sets every item\'s rating to MDBList\'s current cached value. This is also the only way ratings stay current over time'), { showIf: 'mdblistRatingsAutoSyncEnabled' })
                ] }
            ]
        }
    });
})();

/* ===== elsewhere ===== */
/* Elsewhere tab sections. See jeAdmin.js for the field spec.
 * TMDB key and region stay hand-wired (html items): the key has a Test button, is mirrored to the Seerr tab's copy,
 * and the region list is filled by populateRegionSelect() in the page script. They sit in their own section, ahead
 * of Elsewhere, because Reviews and Release Dates need them even when Elsewhere is off. */
JEAdmin.define({
    'elsewhere-tmdb': {
        title: 'TMDB', iconImg: 'selfhst/svg/tmdb.svg',
        items: [
            { type: 'custom', html:
                '<div class="inputContainer jea-row"><label class="inputLabel" for="TMDB_API_KEY">TMDB API Key</label>'
                + '<div class="je-api-row"><input id="TMDB_API_KEY" name="TMDB_API_KEY" type="text" autocomplete="off" class="je-api-input jea-input"/>'
                + '<span id="tmdbStatusIndicator" class="material-icons"></span>'
                + '<button type="button" class="testTmdbBtn jea-btn">Test</button></div></div>'
                + '<div class="je-setting-description" data-desc-for="TMDB_API_KEY"><div class="fieldDescription">Your API key from The Movie DB (TMDB). <a class="sectionTitle" href="https://www.themoviedb.org/settings/api" target="_blank">How to?</a> Shared with Seerr Settings. Needed by Elsewhere, TMDB Reviews and Release Dates.</div></div>' },
            { id: 'DEFAULT_REGION', prop: 'DEFAULT_REGION', manual: true, type: 'select', options: [], label: 'Default Region',
                           desc: 'The default region for streaming provider lookup and release dates. Empty defaults to US. <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt" target="_blank">Full List</a>' }
        ]
    },
    'elsewhere': {
        title: 'Elsewhere (Streaming Providers)', icon: 'live_tv',
        items: [
            { id: 'elsewhereEnabled', prop: 'ElsewhereEnabled', type: 'toggle', main: true, label: 'Enable Elsewhere',
              desc: 'Adds an "Elsewhere" panel to item detail pages showing where the title is available on streaming services in the user\'s region (powered by TMDB watch-provider data).' },
            { id: 'DEFAULT_PROVIDERS', prop: 'DEFAULT_PROVIDERS', type: 'text', label: 'Default Providers', placeholder: 'e.g., Netflix,Hulu',
              desc: 'A list of default streaming providers to show. Leave blank to show all. <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt" target="_blank">Full List</a>' },
            { id: 'IGNORE_PROVIDERS', prop: 'IGNORE_PROVIDERS', type: 'text', label: 'Ignore Providers', placeholder: 'e.g., .*with Ads, Hulu',
              desc: 'A list of providers to ignore from the default region (supports regex). <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt" target="_blank">Full List</a>' },
            { id: 'ElsewhereSeasonProviders', prop: 'ElsewhereSeasonProviders', type: 'toggle', default: true, label: 'Per-season providers',
              desc: 'On Series and Season pages, look up streaming providers per season from TMDB. A season is labelled only when seasons differ; seasons TMDB has no data for fall back to the series providers. Only applies when the series uses the default (aired) season order. Users can turn this off for themselves in the Elsewhere search settings.' },
            { type: 'group', title: 'Custom Branding', items: [
                { id: 'ElsewhereCustomBrandingText', prop: 'ElsewhereCustomBrandingText', type: 'text', label: 'Custom Branding Message', placeholder: 'e.g., Only available on My Server',
                  desc: 'Custom message to display when content is not available on any streaming providers. Leave blank to disable custom branding.' },
                { id: 'ElsewhereCustomBrandingImageUrl', prop: 'ElsewhereCustomBrandingImageUrl', type: 'text', label: 'Custom Branding Icon URL', placeholder: '/web/assets/img/icon.png',
                  desc: 'Optional URL for an icon to display next to the custom message. Leave blank for no icon.' }
            ] }
        ]
    },
    'reviews-panel': {
        title: 'Reviews Panel', icon: 'rate_review',
        items: [
            { id: 'reviewsExpandedByDefault', prop: 'ReviewsExpandedByDefault', type: 'toggle', label: 'Expand reviews by default',
              desc: 'When enabled, the reviews section opens expanded by default for all users (unless they override in their session).' }
        ]
    },
    'reviews-tmdb': {
        title: 'TMDB Reviews', icon: 'reviews',
        items: [
            { id: 'showReviews', prop: 'ShowReviews', type: 'toggle', main: true, label: 'Show TMDB Reviews',
              desc: 'Requires TMDB API Key to be set.' }
        ]
    },
    'reviews-anilist': {
        title: 'AniList', iconImg: 'anilist-static/icon.svg',
        items: [
            { id: 'showAnilistReviews', prop: 'ShowAnilistReviews', type: 'toggle', main: true, label: 'Show AniList Reviews',
              desc: 'Shows the top AniList user reviews for anime in the reviews section.<br>Will only work if AniList is a metadata provider, since items are matched by their AniList ID.<br>No API key needed.<br>Spoiler sections of reviews are hidden.' }
        ]
    },
    'reviews-translation': {
        title: 'Review Translation', icon: 'translate',
        items: [
            { id: 'reviewTranslationEnabled', prop: 'ReviewTranslationEnabled', type: 'toggle', main: true, label: 'Enable Review Translation',
              desc: 'Adds a Translate button to English TMDB and AniList reviews, translating them into the user\'s Jellyfin language.<br>Desktop Chrome and Edge translate on the device, with nothing sent anywhere, but only over HTTPS or localhost. Firefox, Safari, mobile browsers and the Jellyfin apps do not have a built-in translator.<br>Everyone else uses your own <a class="sectionTitle" href="https://libretranslate.com" target="_blank">LibreTranslate</a> instance, if you set one below. Only the review text is sent to it.<br>Translations are done live and are not stored. The button only shows for languages the browser or your instance offers.' },
            { id: 'reviewTranslationUrl', prop: 'ReviewTranslationUrl', type: 'text', label: 'LibreTranslate URL (optional)', placeholder: 'http://localhost:5000',
              toConfig: (v) => (v || '').trim(),
              desc: 'Fallback for browsers without a built-in translator. Base address of the instance, without a trailing path.' },
            { id: 'reviewTranslationApiKey', prop: 'ReviewTranslationApiKey', type: 'password', label: 'LibreTranslate API Key (optional)',
              toConfig: (v) => (v || '').trim(),
              desc: 'Only needed when your instance requires a key.' }
        ]
    },
    'reviews-user': {
        title: 'User Reviews', icon: 'rate_review',
        items: [
            { type: 'note', html: 'Completely independent of Elsewhere being enabled and TMDB Reviews being enabled.' },
            { id: 'showUserReviews', prop: 'ShowUserReviews', type: 'toggle', main: true, label: 'Enable User Written Reviews',
              desc: 'Allows users to write reviews and rate items in the library.' },
            { id: 'hideReviewsFromHiddenUsers', prop: 'HideReviewsFromHiddenUsers', type: 'toggle', default: true, label: 'Hide reviews from hidden users',
              desc: 'When enabled, reviews written by Jellyfin users marked as "Hide this user from login screens" are hidden from non-admin viewers. Admins always see all reviews.' },
            { id: 'hideReviewsFromDisabledUsers', prop: 'HideReviewsFromDisabledUsers', type: 'toggle', default: true, label: 'Hide reviews from disabled users',
              desc: 'When enabled, reviews written by Jellyfin users marked as "Disable this user" are hidden from non-admin viewers. Admins always see all reviews.' },
            { id: 'mirrorReviewRatingsToJellyfin', prop: 'MirrorReviewRatingsToJellyfin', type: 'toggle', label: 'Also save review star ratings as the user\'s Jellyfin rating',
              desc: 'When a user rates a movie or series in a review, also write that rating (scaled to Jellyfin\'s 0-10) to their Jellyfin user rating for the item, so scrobblers and rating sync tools that read Jellyfin user data pick it up. Overwrites any rating the user set elsewhere. Deleting a review, or removing its stars, clears the Jellyfin rating only if it still matches the review; a rating changed elsewhere since is left alone. Season/episode reviews are not mirrored.' },
            { type: 'group', title: 'Poster cards', items: [
                { id: 'showUserRatingOnPosters', prop: 'ShowUserRatingOnPosters', type: 'toggle', label: 'Show average user rating on poster cards',
                  desc: 'When Rating Tags are enabled, overlay a <span class="je-msym-rounded" style="font-size:14px;vertical-align:middle;color:#e91e8c;">person_heart</span> chip on poster cards showing the average rating from all user reviews.' },
                { id: 'showUserRatingDash', prop: 'ShowUserRatingDash', type: 'toggle', default: true, label: 'Show a dash on posters for unrated items',
                  desc: 'When Rating Tags are enabled, a <span class="je-msym-rounded" style="font-size:14px;vertical-align:middle;color:#e91e8c;">person_heart</span> chip appears on every poster. Enable this to show a dash for items the user has not rated yet. Disable to hide the chip entirely for unrated items.' }
            ] }
        ]
    },
    'release-dates': {
        title: 'Release Dates', icon: 'event',
        items: [
            { id: 'showReleaseDate', prop: 'ShowReleaseDates', type: 'toggle', main: true, label: 'Show Release/Air Date',
              desc: 'Requires TMDB API Key to be set. Shows a chip on Movie, Series, Season and Episode detail pages with the cinema/digital/physical release date or next/last air date, sourced from TMDB. Uses the Default Region set under TMDB Connection above to pick which country\'s dates to prefer.' }
        ]
    }
});

/* ===== playback ===== */
/* Playback tab sections. See jeAdmin.js for the field spec. */
JEAdmin.define({
    'pb-tabswitch': {
        title: 'Player Behaviour', icon: 'play_circle',
        items: [
            { id: 'autoPauseEnabled', prop: 'AutoPauseEnabled', type: 'toggle', perUser: true, label: 'Auto-pause on tab switch',
              desc: 'Pause playback automatically when you switch to another browser tab.' },
            { id: 'autoResumeEnabled', prop: 'AutoResumeEnabled', type: 'toggle', perUser: true, label: 'Auto-resume on tab switch',
              desc: 'Resume playback automatically when you switch back to the player tab.' },
            { id: 'autoPipEnabled', prop: 'AutoPipEnabled', type: 'toggle', perUser: true, label: 'Auto Picture-in-Picture on tab switch',
              desc: 'Enter the browser\'s Picture-in-Picture mode when switching tabs (browser support required).' },
            { id: 'longPress2xEnabled', prop: 'LongPress2xEnabled', type: 'toggle', perUser: true, label: 'Long press/hold for 2x speed β',
              desc: 'Long-press anywhere on the player to temporarily play at 2x speed; release to return to normal speed. Beta, touch devices only.' },
            { id: 'showPlaybackRatingBadge', prop: 'ShowPlaybackRatingBadge', type: 'toggle', label: 'Show Age Rating When Playback Starts',
              desc: 'Briefly shows the age rating in a corner of the player when a video starts, followed by a line of any content-advisory tags (such as violence or strong language) and a line of its genres.' },
            { id: 'pauseScreenEnabled', prop: 'PauseScreenEnabled', type: 'toggle', perUser: true, label: 'Enable Custom Pause Screen',
              desc: 'Shows an overlay with details about what is playing while playback is paused.' }
        ]
    },
    'pb-autoskip': {
        title: 'Auto-Skip', icon: 'skip_next',
        items: [
            { id: 'autoSkipIntro', prop: 'AutoSkipIntro', type: 'toggle', perUser: true, label: 'Auto-skip Intro',
              desc: 'Automatically skip detected intros. Requires the Intro Skipper plugin.' },
            { id: 'autoSkipOutro', prop: 'AutoSkipOutro', type: 'toggle', perUser: true, label: 'Auto-skip Outro',
              desc: 'Automatically skip detected outros (end credits). Requires the Intro Skipper plugin.' }
        ]
    },
    'pb-subtitles': {
        title: 'Subtitles', icon: 'subtitles',
        items: [
            { id: 'disableCustomSubtitleStyles', prop: 'DisableCustomSubtitleStyles', type: 'toggle', perUser: true, label: 'Disable Custom Subtitle Styles by default',
              desc: 'Globally disables Jellyfin\'s custom subtitle style overrides so the source subtitle styling is shown unmodified.' },
            { type: 'group', title: 'Default appearance for new users', open: true, items: [
                { id: 'DefaultSubtitleStyle', prop: 'DefaultSubtitleStyle', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Style',
                  options: [['0', 'Clean White'], ['1', 'Classic Black Box'], ['2', 'Netflix Style'], ['3', 'Cinema Yellow'], ['4', 'Soft Gray'], ['5', 'High Contrast']],
                  toConfig: (v) => parseInt(v, 10),
                  desc: 'Default subtitle style preset applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleSize', prop: 'DefaultSubtitleSize', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Size',
                  options: [['0', 'Tiny'], ['1', 'Small'], ['2', 'Normal'], ['3', 'Large'], ['4', 'Extra Large'], ['5', 'Gigantic']],
                  toConfig: (v) => parseInt(v, 10),
                  desc: 'Default subtitle size applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleFont', prop: 'DefaultSubtitleFont', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Font',
                  options: [['0', 'Default'], ['1', 'Noto Sans'], ['2', 'Sans Serif'], ['3', 'Typewriter'], ['4', 'Roboto']],
                  toConfig: (v) => parseInt(v, 10),
                  desc: 'Default subtitle font applied to new users; users can override in their personal settings.' },
                { id: 'DefaultSubtitleTextEffect', prop: 'DefaultSubtitleTextEffect', type: 'select', perUser: true, default: 0, label: 'Default Subtitle Text Effect',
                  options: [['0', 'Auto'], ['1', 'None'], ['2', 'Shadow'], ['3', 'Outline'], ['4', 'Outline + Shadow']],
                  toConfig: (v) => parseInt(v, 10),
                  desc: 'Default subtitle text effect (outline / drop shadow) applied to new users; users can override in their personal settings. Auto adds a shadow only when the subtitle background is transparent.' }
            ] }
        ]
    },
    'pb-timing': {
        title: 'Shortcuts Panel & Toast Timing', icon: 'timer',
        items: [
            { id: 'HelpPanelAutocloseDelay', prop: 'HelpPanelAutocloseDelay', type: 'number', default: 15000, min: 0, step: 1, label: 'Shortcuts Panel Autoclose Delay (ms)',
              desc: 'How long the Jellyfin Enhanced shortcuts/settings panel (opened with the <kbd>?</kbd> key) stays open without interaction before auto-closing. Default: 15000 ms (15 seconds).' },
            { type: 'button', id: 'jeTestShortcutsPanel', label: 'Preview autoclose' },
            { id: 'ToastDuration', prop: 'ToastDuration', type: 'number', default: 3000, min: 0, step: 1, label: 'Toast Notification Duration (ms)',
              desc: 'How long pop-up toast messages (e.g. &ldquo;Shuffle enabled&rdquo;, &ldquo;Bookmark saved&rdquo;) stay on-screen before fading out. Default: 3000 ms (3 seconds). Set to <strong>0</strong> to turn toasts off. Use 1000 or more so they can be read; the preview uses the value you typed, before saving.' },
            { type: 'button', id: 'jeTestToast', label: 'Preview toast' }
        ]
    }
});

/* ===== pages ===== */
/* Pages tab sections. See jeAdmin.js for the field spec.
 * Every page feature card has the same shape: intro note, master switch, a "Where it appears" group, then options.
 * The placement checkboxes (native tab, Plugin Pages, Custom Tabs, auto-create) are rendered here as markup but are loaded and
 * saved by configPage.html's hand-written code (Custom Tabs sync, plugin detection, v12 hints), so they are not schema fields. */
(function () {
    'use strict';
    const PP = 'https://github.com/IAmParadox27/jellyfin-plugin-pages';
    const CT = 'https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs';
    const ppLink = `<a class="sectionTitle" href="${PP}" target="_blank">Plugin Pages</a>`;
    const PP_NOTE = '<strong>Note:</strong> Plugin Pages 3.0 or newer applies this without a Jellyfin restart. Older versions need one after enabling this option for the first time.';
    const PP_BADGE = '<span class="je-installed-badge" data-plugin="pluginpages"><i class="material-icons" aria-hidden="true">check_circle</i>Plugin Pages detected</span>';
    const CT_BADGE = '<span class="je-installed-badge" data-plugin="customtabs"><i class="material-icons" aria-hidden="true">check_circle</i>Custom Tabs detected</span>';
    const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    /* o: p id prefix, en master toggle id, name, ppLabel, ppIntro, ctLabel, noun, hint (v12 hint id suffix), cls (embed div class), text (display text) */
    function placement(o) {
        const code = `<div class="${o.cls}"></div>`;
        const gate = `${o.p}UseCustomTabs,${o.en}`;
        const guide = `<details class="jea-howto"><summary>Custom Tabs setup guide ${CT_BADGE}</summary>`
            + `<p class="fieldDescription">Display the ${o.noun} in a Custom Tabs tab instead of the sidebar link.</p>`
            + `<p class="fieldDescription je-needs-customtabs">You need the <a class="sectionTitle" href="${CT}" target="_blank">Custom Tabs</a> plugin.</p>`
            + `<ol class="fieldDescription">`
            + `<li class="je-needs-customtabs">Install the <strong>Custom Tabs</strong> plugin and all its prerequisites.</li>`
            + `<li>Navigate to Dashboard &gt; Plugins &gt; Custom Tabs and add a new tab.</li>`
            + `<li>Add "Display Text" according to your preference (e.g., "${o.text}").</li>`
            + `<li>Copy the code below and paste it into the 'HTML Content' field.</li></ol>`
            + `<div class="je-copy-code-wrapper"><button class="je-copy-html-btn jea-btn" data-copy-text='${escAttr(code)}' type="button">`
            + `<i class="material-icons je-copy-icon">content_copy</i><span class="copy-btn-text je-copy-btn-text">Copy</span></button>`
            + `<pre class="je-code-pre"><code>${escAttr(code)}</code></pre></div>`
            + `<div class="fieldDescription">Already have Custom Tabs installed? <a class="sectionTitle je-custom-tabs-link" href="/web/#/configurationpage?name=Custom%20Tabs">Click here to configure it.</a></div>`
            + `</details>`;
        // Placement toggles are rendered here but loaded and saved by configPage.html (Custom Tabs sync, plugin detection, v12 hints).
        return {
            type: 'group', title: 'Where it appears', open: true, items: [
                { id: `${o.p}UseNativeTab`, type: 'toggle', manual: true, label: `Add ${o.name} as a native Home tab`,
                  desc: `Adds ${o.name} as its own tab on the Home page, no external plugin needed.<br/><strong>Recommended on Jellyfin 12's experimental layout</strong> (the default).` },
                { id: `${o.p}UsePluginPages`, type: 'toggle', manual: true, label: o.ppLabel, desc: `${o.ppIntro}<br/>${PP_NOTE} ${PP_BADGE}` },
                { id: `${o.p}UseCustomTabs`, type: 'toggle', manual: true, label: o.ctLabel, desc: guide },
                { type: 'html', html: `<div class="je-note-banner je-v12-tab-hint-banner" id="je-v12-hint-${o.hint}" style="display:none;"><i class="material-icons je-note-icon">info</i>`
                    + `<div>On Jellyfin 12, <strong>"Add ${o.name} as a native Home tab"</strong> is more reliable than Custom Tabs. The two cannot be enabled together.</div></div>` },
                { id: `${o.p}AutoCreateCustomTab`, type: 'toggle', manual: true, label: 'Add the Custom Tabs entry for me',
                  rowClass: 'je-customtabs-automanage', rowAttrs: { 'data-gated-by': gate }, descAttrs: { 'data-gated-by': gate },
                  desc: `Jellyfin Enhanced will create the matching Custom Tabs entry on save. Turning off "${o.ctLabel}" removes the entry; turning it back on re-creates it. Leave unchecked to manage the Custom Tabs entry yourself.` }
            ]
        };
    }

    const note = (html, icon) => ({ type: 'note', html: icon ? `<i class="material-icons je-info-icon">${icon}</i> ` + html : html });
    const T = (id, prop, label, desc, extra) => Object.assign({ id, prop, type: 'toggle', label, desc }, extra || {});
    const HC_DEFAULT = (id, label, desc, on) => T(id, id.charAt(0).toUpperCase() + id.slice(1), label, desc, on ? { default: true } : {});

    JEAdmin.define({
        'pages-bookmarks': {
            title: 'Bookmarks', icon: 'bookmark',
            items: [
                note('<strong>How to use:</strong> press <kbd class="je-kbd">B</kbd> or click the bookmark icon during playback to save the current time. Bookmarks show as pins on the progress bar (click one to jump there) and track by TMDB/TVDB ids, so they work across file versions of the same content.'),
                T('bookmarksEnabled', 'BookmarksEnabled', 'Enable Bookmarks Feature',
                    'Save custom bookmarks/timestamps while watching videos to quickly jump back to your favorite scenes or moments.', { main: true, default: true }),
                placement({ p: 'bookmarks', en: 'bookmarksEnabled', name: 'Bookmarks', ppLabel: 'Use Plugin Pages for Bookmarks Library',
                    ppIntro: `Adds a "Bookmarks" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs for Bookmarks', noun: 'Bookmarks library',
                    hint: 'bookmarks', cls: 'sections bookmarks', text: 'Bookmarks' })
            ]
        },
        'pages-hidden-content': {
            title: 'Hidden Content', icon: 'visibility_off',
            items: [
                note('<strong>Hidden Content</strong> lets users hide individual items from Home and Library views and browse them from a dedicated Hidden Content page. Per-user state with a server-wide enable/disable kill switch.'),
                T('hiddenContentEnabled', 'HiddenContentEnabled', 'Enable Hidden Content',
                    'Enable or disable the Hidden Content feature server-wide. When disabled, hide buttons, filtering, sidebar navigation, and settings panel options are all removed. User data is preserved and restored when re-enabled.', { main: true }),
                placement({ p: 'hiddenContent', en: 'hiddenContentEnabled', name: 'Hidden Content', ppLabel: 'Use Plugin Pages for Hidden Content',
                    ppIntro: `Replaces the default Hidden Content page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs for Hidden Content',
                    noun: 'Hidden Content page', hint: 'hiddenContent', cls: 'jellyfinenhanced hidden-content', text: 'Hidden Content' }),
                T('hiddenContentAdmin', 'HiddenContentAdmin', 'Let admins view and manage other users\' hidden content',
                    'Adds a "user filter" dropdown on the Hidden Content page so an admin can see what any user has hidden, with an Edit toggle to unhide items or add new ones from the library or Seerr on that user\'s behalf. Turn this off if you don\'t want to edit/manage other users\' hidden content.', { default: true }),
                {
                    type: 'group', title: 'Defaults for new users', items: [
                        note('<strong>Defaults for new users</strong> and the <em>Apply all plugin settings to every user</em> action in Overview &gt; Quick Actions. Existing users keep their current settings until you apply them.'),
                        HC_DEFAULT('hiddenContentDefaultEnabled', 'Hidden Content enabled by default',
                            'When on, Hidden Content starts active for new users, so they can hide things straight away and the filtering takes effect immediately. When off, users have to turn it on themselves first.', true),
                        {
                            type: 'group', title: 'Hide buttons', open: true, items: [
                                HC_DEFAULT('hiddenContentDefaultShowHideButtons', 'Show "Hide" buttons by default',
                                    'When on, the Hide button shows up across the apps so users can hide things they don\'t want to see. When off, no Hide button appears anywhere, but users can still bring back items they\'ve already hidden from the Hidden Content page.', true),
                                HC_DEFAULT('hiddenContentDefaultShowHideConfirmation', 'Show confirmation dialog before hiding',
                                    'When on, clicking Hide asks "are you sure?" first. Turn off for one-click hiding. Items can always be brought back from the Hidden Content page.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonJellyseerr', 'Show "Hide" button on Seerr search results',
                                    'Adds a Hide button to Seerr search and discover results, so users can hide a movie or show even before it\'s been added to their library.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonDetails', 'Show "Hide" button on item details pages',
                                    'Adds a Hide button to the row of action buttons on movie, show, and episode detail pages.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonLibrary', 'Show "Hide" button on library / home cards',
                                    'Adds a small eye icon to every poster on the home and library pages, so users can hide an item without opening it first. Off by default because some people find the icon on every poster busy.', false),
                                HC_DEFAULT('hiddenContentDefaultShowButtonCast', 'Show "Hide" button on cast / actor cards',
                                    'Adds a Hide button to actor cards. Hiding an actor hides every movie or show they appear in until you bring them back.', false)
                            ]
                        },
                        {
                            type: 'group', title: 'Where hidden items are filtered out', open: true, items: [
                                HC_DEFAULT('hiddenContentDefaultFilterLibrary', 'Filter Library & details pages',
                                    'When on, hidden items don\'t appear when users browse a library (Movies, Shows, etc.) or in the suggestion rows on a details page. Turn off if users still want to see hidden items while browsing.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterSearch', 'Filter Search results',
                                    'When on, hidden items don\'t appear in search results. Off by default because most people still want to be able to search for something they hid in order to bring it back.', false),
                                HC_DEFAULT('hiddenContentDefaultFilterContinueWatching', 'Filter Continue Watching',
                                    'When on, hidden items don\'t appear in the Continue Watching row on the home page. Required for the "Remove from Continue Watching" button to actually do anything.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterNextUp', 'Filter Next Up',
                                    'When on, hidden series don\'t appear in the Next Up row on the home page. Recommended on so a show users have hidden doesn\'t keep being suggested as the next thing to watch.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterUpcoming', 'Filter Upcoming episodes',
                                    'When on, hidden series don\'t appear on the Upcoming Episodes page.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterRecommendations', 'Filter Suggestions / recommendations',
                                    'When on, hidden items don\'t appear in the "Because you watched..." and "Suggested for you" rows on the home and details pages.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterDiscovery', 'Filter Discovery',
                                    'When on, hidden items don\'t appear on the Discovery page (genre, similar, and recommended sections).', true),
                                HC_DEFAULT('hiddenContentDefaultFilterCalendar', 'Filter Calendar',
                                    'When on, hidden series don\'t show up on the Calendar page\'s list of upcoming episodes.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterRequests', 'Filter Requests page',
                                    'When on, hidden items don\'t appear on the Requests page (the combined view of Sonarr, Radarr, and Seerr requests).', true)
                            ]
                        },
                        HC_DEFAULT('hiddenContentDefaultExperimentalHideCollections', 'Allow hiding collections, libraries, and playlists (experimental)',
                            '<strong>Warning:</strong> Extremely not recommended for average users. Will break things. Only turn this on if you 100% know what you want to use it for. Lets users hide whole collections, libraries, or playlists in addition to individual movies and shows.', false)
                    ]
                }
            ]
        },
        'pages-requests': {
            title: 'Requests Page', icon: 'download',
            items: [
                note('<strong>Requests Page</strong> shows a Requests button in the sidebar with a dedicated view of active downloads from Sonarr/Radarr and requests from Seerr.'
                    + '<div id="requestsPageRequirementsLine" style="display: none; margin-top: 10px;"><strong>Requirements:</strong> <span id="requestsPageRequirementsList">Configure Sonarr and/or Radarr, plus Seerr, URLs and API keys.</span></div>'),
                T('downloadsPageEnabled', 'DownloadsPageEnabled', 'Enable Requests Page',
                    'Adds a "Requests" link to the navigation showing active downloads and requests.', { main: true, default: true }),
                placement({ p: 'downloads', en: 'downloadsPageEnabled', name: 'Requests', ppLabel: 'Use Plugin Pages for Requests',
                    ppIntro: `Replaces the default Requests page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs for Requests',
                    noun: 'Requests page', hint: 'downloads', cls: 'jellyfinenhanced requests', text: 'Requests' }),
                T('showDownloadsInRequests', 'ShowDownloadsInRequests', 'Show Downloads in Requests Page',
                    'Shows active downloads from Sonarr/Radarr on the Requests page. (Requires *arr links and API keys to be configured)', { default: true }),
                T('downloadsFilterByUserRequests', 'DownloadsFilterByUserRequests', 'Filter Downloads by User Requests',
                    'When enabled, non-admin users only see downloads and requests they made themselves, regardless of their Seerr permissions. When disabled, all authenticated users can see every item in the download queue, and the request list follows each user\'s Seerr permissions.',
                    { default: true, showIf: 'showDownloadsInRequests' }),
                T('downloadsPageShowIssues', 'DownloadsPageShowIssues', 'Show Seerr Issues Section', 'Shows open/resolved Seerr issues beneath Requests.'),
                T('downloadsShowHistory', 'DownloadsShowHistory', 'Show Download History Section',
                    'Shows a bounded history of recently imported (or failed-to-import) Sonarr/Radarr downloads beneath Requests, so items that vanish from the active queue after finishing are still visible.', { default: true }),
                T('downloadsHistoryAdminOnly', 'DownloadsHistoryAdminOnly', 'Restrict Download History to Admins',
                    'When enabled, only Jellyfin administrators see the Download History section. Regular users won\'t see it at all.', { showIf: 'downloadsShowHistory' }),
                T('downloadsPagePollingEnabled', 'DownloadsPagePollingEnabled', 'Enable Auto-Refresh',
                    'Periodically refresh the Requests page so download progress updates without manual reload.', { default: true }),
                { id: 'downloadsPollIntervalSeconds', prop: 'DownloadsPollIntervalSeconds', type: 'number', min: 30, max: 300, default: 30, label: 'Poll Interval (seconds)',
                  desc: 'How often to refresh download status automatically. Minimum is 30 seconds and applies only when auto-refresh is enabled.',
                  showIf: 'downloadsPagePollingEnabled',
                  toConfig: (v) => { const n = Math.floor(Number(v)); return n >= 30 ? n : 30; } }
            ]
        },
        'pages-calendar': {
            title: 'Calendar Page', icon: 'calendar_today',
            items: [
                note('<strong>Calendar Page</strong> adds a Calendar button in the sidebar with a dedicated view of upcoming releases from Sonarr and Radarr.<br/><strong>Requirements:</strong> Configure Sonarr and/or Radarr URLs and API keys.'),
                T('calendarPageEnabled', 'CalendarPageEnabled', 'Enable Calendar Page',
                    'Adds a "Calendar" link to the navigation showing upcoming releases from Sonarr/Radarr.', { main: true, default: true }),
                placement({ p: 'calendar', en: 'calendarPageEnabled', name: 'Calendar', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Replaces the default Calendar page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Calendar page', hint: 'calendar', cls: 'jellyfinenhanced calendar', text: 'Calendar' }),
                { id: 'calendarFirstDayOfWeek', prop: 'CalendarFirstDayOfWeek', type: 'select', default: 'Monday', label: 'First Day of Week',
                  options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => [d, d]),
                  desc: 'Which day appears as the first column of the calendar grid.' },
                { id: 'calendarTimeFormat', prop: 'CalendarTimeFormat', type: 'select', default: '5pm/5:30pm', label: 'Time Format',
                  options: [['5pm/5:30pm', '5pm/5:30pm'], ['17:00/17:30', '17:00/17:30']],
                  desc: 'Whether release times display in 12-hour (5pm) or 24-hour (17:00) format.' },
                T('calendarHighlightFavorites', 'CalendarHighlightFavorites', 'Highlight Favorites/Watchlist', 'Show a golden border on calendar entries for items in your Jellyfin favorites.'),
                T('calendarHighlightWatchedSeries', 'CalendarHighlightWatchedSeries', 'Highlight Watched Series', 'Show a border on calendar entries for series you have watched episodes from.'),
                T('calendarFilterByLibraryAccess', 'CalendarFilterByLibraryAccess', 'Filter by Library Access',
                    'When enabled, the calendar only shows items from libraries the user has access to. Upcoming items not yet in Jellyfin are filtered based on their Sonarr/Radarr root folder.', { default: true }),
                T('calendarShowOnlyRequested', 'CalendarShowOnlyRequested', 'Show Requested Only (Default)',
                    'When enabled, the calendar will load showing only Requested items by default, but users can still change filters.'),
                T('calendarForceOnlyRequested', 'CalendarForceOnlyRequested', 'Force Only Requested Items',
                    'When enabled, the calendar always shows only your requested items and the Requests filter is hidden.')
            ]
        },
        'pages-recommendations': {
            title: 'Seerr Recommendations Page', icon: 'auto_awesome',
            items: [
                note('<strong>Seerr Recommendations Page</strong> adds a dedicated view with Seerr-powered rows: Trending, Popular Movies, Popular TV Shows, Upcoming Movies and Upcoming TV Shows.<br/><strong>Requirements:</strong> Seerr integration must be configured and enabled.'),
                T('recommendationsPageEnabled', 'RecommendationsPageEnabled', 'Enable Recommendations Page',
                    'Adds a "Seerr Recommendations" link to the navigation showing Seerr discover rows.', { main: true }),
                placement({ p: 'recommendations', en: 'recommendationsPageEnabled', name: 'Recommendations', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Replaces the default Recommendations page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Recommendations page', hint: 'recommendations', cls: 'jellyfinenhanced recommendations', text: 'Recommendations' })
            ]
        },
        'pages-activity': {
            title: 'Activity Feed', icon: 'history',
            items: [
                note('<strong>Activity Feed</strong> shows recently watched, favorited, and reviewed titles across the server. Each viewer only sees activity for items they themselves have library access to.'),
                T('activityFeedEnabled', 'ActivityFeedEnabled', 'Enable Activity Feed', 'Turns the feature on. While it\'s off, no activity is recorded or shown.', { main: true }),
                placement({ p: 'activityFeed', en: 'activityFeedEnabled', name: 'Activity', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Adds an "Activity" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Activity page', hint: 'activityFeed', cls: 'jellyfinenhanced activity', text: 'Activity' }),
                {
                    type: 'group', title: 'What to show', open: true, items: [
                        T('activityFeedShowWatched', 'ActivityFeedShowWatched', 'Show recently watched', 'Titles users finished watching.', { default: true }),
                        T('activityFeedShowFavorited', 'ActivityFeedShowFavorited', 'Show recently favorited', 'Titles users added to their favorites.', { default: true }),
                        T('activityFeedShowReviewed', 'ActivityFeedShowReviewed', 'Show recently reviewed', 'Titles users reviewed.', { default: true }),
                        T('activityFeedShowActiveStreams', 'ActivityFeedShowActiveStreams', 'Show Active Streams section',
                            'Adds a live "who\'s watching now" section to this page, independent of whether the Active Streams header widget (Extras tab) is shown. Still requires that feature\'s data collection to be enabled there.', { default: true })
                    ]
                },
                T('activityFeedOwnOnlyForNonAdmins', 'ActivityFeedOwnOnlyForNonAdmins', 'Non-admins only see their own activity',
                    'When enabled, regular users only see their own watched, favorited and reviewed entries. Administrators still see everyone.')
            ]
        },
        'pages-catchup': {
            title: 'Catch Up', icon: 'style',
            items: [
                note('<strong>Catch Up</strong> shows unwatched movies and shows as cards. Swipe right to mark watched, left to dismiss, up to add to your watchlist (the Likes flag) and down to open the title. Handy for finding out what people have already seen.'),
                T('catchUpEnabled', 'CatchUpEnabled', 'Enable Catch Up', 'Turns the feature on. Each user only sees titles they have library access to.', { main: true }),
                placement({ p: 'catchUp', en: 'catchUpEnabled', name: 'Catch Up', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Adds a "Catch Up" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Catch Up page', hint: 'catchUp', cls: 'jellyfinenhanced catchup', text: 'Catch Up' }),
                T('catchUpLogEnabled', 'CatchUpLogEnabled', 'Record Catch Up activity',
                    'Logs who swiped what (user, title, action and time) to <code>catchup-log.jsonl</code> in the plugin\'s configuration folder. Administrators can read it, with a per-user summary, in the Activity panel on the Catch Up page. The log is size-bounded (about 5&nbsp;MB per file, two files kept).', { default: true })
            ]
        }
    });
})();

/* ===== extras ===== */
/* Extras and Keyboard tab sections. See jeAdmin.js for the field spec. */
(function () {
    const shot = (alt, file, small) => '<details class="je-screenshot-details"><summary class="je-screenshot-summary">View Screenshot</summary>'
        + '<a href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/docs/images/' + file + '" target="_blank">'
        + '<img alt="' + alt + '" class="' + (small ? 'je-screenshot-img-sm' : 'je-screenshot-img') + '" data-je-cdn="je-docs-img/' + file + '"/></a></details>';

    JEAdmin.define({
        'extras-ui': {
            title: 'UI Tweaks', icon: 'palette',
            items: [
                { id: 'coloredRatingsEnabled', prop: 'ColoredRatingsEnabled', type: 'toggle', label: 'Colored Ratings Backgrounds',
                  desc: 'Applies color-coded backgrounds to media ratings. If you notice missing or incorrect ratings, please submit a PR to <a class="sectionTitle" href="https://github.com/n00bcodr/Jellyfin-Enhanced/" target="_blank">Jellyfin-Enhanced</a>.' + shot('Colored Ratings Example', 'ratings.png') },
                { id: 'themeSelectorEnabled', prop: 'ThemeSelectorEnabled', type: 'toggle', label: 'Theme Selector (Jellyfish)',
                  desc: 'Adds a theme selector to quickly switch between Jellyfish color themes. Only changes the color theme of Jellyfish when used natively, not through KefinTweaks.' + shot('Theme Selector Example', 'theme-selector.png') },
                { id: 'coloredActivityIconsEnabled', prop: 'ColoredActivityIconsEnabled', type: 'toggle', label: 'Colored Dashboard Icons',
                  desc: 'Replaces Dashboard Activity Icons with Material Design icons and background color.' + shot('Colored Activity Icons Example', 'colored-activity-icons.png') },
                { id: 'loginImageEnabled', prop: 'EnableLoginImage', type: 'toggle', label: 'Profile Picture on Login',
                  desc: 'Displays the user\'s profile picture on the manual login screen instead of the name. When a user is selected, their avatar appears above the password field.' + shot('Login Image Example', 'login-image.png') },
                { id: 'pluginIconsEnabled', prop: 'PluginIconsEnabled', type: 'toggle', label: 'Custom Plugin Menu Icons',
                  desc: 'Replaces default plugin folder icons with custom icons on the Dashboard sidebar. Currently replaces icons for (if installed): Jellyfin Enhanced, JavaScript Injector, Intro Skipper, Reports, JellySleep, Home Screen Sections, File Transformation, Jellyfin Helper, Newsletters, Segment Editor and Moonbase.' + shot('Plugin Icons Example', 'plugin-icons.png', true) }
            ]
        },
        'extras-streams': {
            title: 'Active Streams', icon: 'podcasts',
            items: [
                { id: 'activeStreamsEnabled', prop: 'ActiveStreamsEnabled', type: 'toggle', main: true, label: 'Active Streams Header Widget',
                  desc: 'Adds a live stream counter to the header. Click it to open a panel showing who is currently playing, what they\'re watching, playback state, progress, and transcoding details. By default the widget is only visible to admin accounts.' },
                { id: 'activeStreamsAllUsers', prop: 'ActiveStreamsAllUsers', type: 'toggle', label: 'Show widget to non-admins' }
            ]
        },
        'extras-links': {
            title: 'External Links', icon: 'link',
            items: [
                { id: 'letterboxdEnabled', prop: 'LetterboxdEnabled', type: 'toggle', main: true, label: 'Enable Letterboxd Links',
                  desc: 'Adds Letterboxd links to movie and person details pages.' },
                { id: 'showLetterboxdLinkAsText', prop: 'ShowLetterboxdLinkAsText', type: 'toggle', label: 'Show link as text',
                  desc: 'When enabled, shows "Letterboxd" as text instead of the Letterboxd icon.' }
            ]
        },
        'extras-metadata-icons': {
            title: 'Metadata Icons & Sidebar Links', icon: 'extension',
            items: [
                { id: 'metadataIconsEnabled', prop: 'MetadataIconsEnabled', type: 'toggle', label: 'Enable Metadata Icons (Druidblack)',
                  fromConfig: (v) => !!v,
                  desc: 'Shows metadata icons instead of text. When enabled, links from the plugin will also use icons instead of text (Letterboxd, *arr Links).' },
                { type: 'group', title: 'Sidebar custom links', items: [
                    { id: 'customPluginLinks', prop: 'CustomPluginLinks', type: 'textarea', rows: 3, placeholder: 'Page Name | icon_name', label: 'Sidebar Custom Links',
                      desc: '<strong>Format:</strong> <code>Configuration Page Name | Material Icon Name</code><br/>'
                          + '<strong>Important:</strong> Use the exact name that appears in the configuration page URL (e.g., "Jellyfin%20Tweaks" becomes "Jellyfin Tweaks").<br/>'
                          + '<a class="sectionTitle" href="https://fonts.google.com/icons?icon.set=Material+Icons" target="_blank">Browse Material Icons</a><br/>'
                          + 'Use "Test Links" to preview your links in the sidebar. They appear immediately and disappear on page refresh.' },
                    { type: 'button', id: 'testCustomPluginLinksBtn', label: 'Test Links' }
                ] }
            ]
        },
        'extras-splash': {
            title: 'Splash Screen Override', icon: 'wallpaper',
            items: [
                { id: 'enableCustomSplashScreen', prop: 'EnableCustomSplashScreen', type: 'toggle', main: true, label: 'Enable Splash Screen Override',
                  desc: 'Replace Jellyfin\'s login splash background with a custom image URL specified below.' },
                { id: 'splashScreenImageUrl', prop: 'SplashScreenImageUrl', type: 'text', placeholder: '/web/assets/banner.png', label: 'Splash Screen Image URL',
                  desc: 'URL for the splash screen image. Defaults to Jellyfin banner.' },
                { type: 'note', tone: 'warn', html: 'Might cause strange behaviour if <a class="sectionTitle" href="https://github.com/IAmParadox27/jellyfin-plugin-media-bar" target="_blank">jellyfin-plugin-media-bar</a> is installed. All changes require a page refresh; if old settings persist, force clear the browser cache.' }
            ]
        },
        'extras-branding': {
            title: 'Custom Image Assets', icon: 'image', class: 'je-fieldset-wide',
            items: [
                { type: 'note', html: 'Uploaded icon / favicon / logo images are applied automatically at request time. Changes apply on next page load (a hard refresh may be needed if your browser cached the old image).' },
                { type: 'custom', html: '<div class="je-branding-grid">' + [
                    ['iconTransparent', 'Icon Transparent', 'The icon in the top-left beside the server version', '536×536px &nbsp;·&nbsp; PNG with transparency'],
                    ['favicon', 'Favicon', 'Favicon in the browser tab', '256×256px (.png) &nbsp;·&nbsp; ICO, PNG, or SVG'],
                    ['bannerDark', 'Banner Dark', 'Splash Screen Banner for Light Mode', '1302×378px &nbsp;·&nbsp; PNG, JPG, or WebP'],
                    ['bannerLight', 'Banner Light', 'Splash Screen Banner for Dark Mode', '1302×378px &nbsp;·&nbsp; PNG, JPG, or WebP'],
                    ['touchicon', 'Apple Touch Icon', 'Icon shown when adding to iOS Home Screen', '180×180px &nbsp;·&nbsp; PNG']
                ].map(([k, name, what, size]) => '<div class="je-branding-card">'
                    + '<label class="je-branding-label-bold">' + name + '</label>'
                    + '<label class="je-branding-label">' + what + '</label>'
                    + '<div class="je-branding-size-hint">' + size + '</div>'
                    + '<div class="je-branding-dropzone" id="' + k + 'DropZone">'
                    + '<input type="file" id="' + k + 'Input" accept="image/*" class="je-branding-file-input" />'
                    + '<div id="' + k + 'Placeholder" class="je-branding-placeholder"><i class="material-icons je-branding-placeholder-icon">image</i></div>'
                    + '<img id="' + k + 'Preview" class="je-branding-preview" style="display:none;" />'
                    + '<div id="' + k + 'Dimensions" class="je-branding-dimensions" style="display:none;"></div>'
                    + '<div id="' + k + 'Status" class="je-branding-status"></div>'
                    + '<button type="button" class="je-branding-delete" id="' + k + 'Delete" style="display:none;"><i class="material-icons">delete</i></button>'
                    + '</div></div>').join('') + '</div>' }
            ]
        },
        'keyboard': {
            title: 'Keyboard Shortcuts', icon: 'keyboard',
            items: [
                { id: 'disableAllShortcuts', prop: 'DisableAllShortcuts', type: 'toggle', label: 'Disable Keyboard Shortcuts',
                  desc: 'Disables all keyboard shortcuts, and hides the "Shortcuts" tab in the Enhanced Panel.' },
                { type: 'note', html: '<strong>Users can customize their own settings from the Enhanced Panel:</strong> press <code>?</code> (default shortcut), long-press the profile picture in the top-right corner, use the "Jellyfin Enhanced" link in the sidebar, or open it from the playback controls menu (mobile only).' },
                { type: 'html', html: '<div class="fieldDescription je-sc-help">Click a key, then press the new key combination (for example <kbd>Shift+A</kbd>). <b>Delete</b> disables the shortcut for every user, <b>Backspace</b> restores its default. Users can still change their own keys from their Enhanced Panel.</div>'
                    + '<div id="shortcut-error-comment" style="display: none; color: #ff6b6b; margin-top:5px;"></div>'
                    + '<div id="shortcut-grid"></div>' }
            ]
        }
    });
})();

/* ===== seerr ===== */
/* Seerr tab sections. See jeAdmin.js for the field spec. Fields marked manual are rendered here but still loaded
 * and saved by configPage.html (clamping, URL validation or multi-field logic). Native elements only. */
(function () {
    // Secret/key row: native input, a status icon span and a Test button, all keyed by id/class for the page's handlers.
    const keyRow = (id, name, label, statusId, btn, desc) =>
        '<div class="inputContainer jea-row"><label class="inputLabel" for="' + id + '">' + label + '</label>' +
        '<div class="jea-inline"><input id="' + id + '" name="' + name + '" type="text" class="jea-input" autocomplete="off"/>' +
        '<span id="' + statusId + '" class="material-icons"></span>' + btn + '</div></div>' +
        '<div class="je-setting-description" data-desc-for="' + id + '"><div class="fieldDescription">' + desc + '</div></div>';

JEAdmin.define({
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
            ] },
            { type: 'group', title: 'Filters in the "More" sections', items: [
                { type: 'note', html: 'The <b>Filters</b> button of a "More" section offers these. Turn one off and it is never offered, to anyone.' },
                { id: 'jellyseerrFilterYear', prop: 'JellyseerrFilterYear', type: 'toggle', default: true, label: 'Released',
                  desc: 'A range of years, months or days.' },
                { id: 'jellyseerrFilterScore', prop: 'JellyseerrFilterScore', type: 'toggle', default: true, label: 'Score',
                  desc: 'A range of TMDB user scores, from 0 to 10.' },
                { id: 'jellyseerrFilterVotes', prop: 'JellyseerrFilterVotes', type: 'toggle', default: true, label: 'Votes',
                  desc: 'A range for the number of TMDB user votes.' },
                { id: 'jellyseerrFilterRuntime', prop: 'JellyseerrFilterRuntime', type: 'toggle', default: true, label: 'Runtime',
                  desc: 'A runtime range, in minutes.' },
                { id: 'jellyseerrFilterGenres', prop: 'JellyseerrFilterGenres', type: 'toggle', default: true, label: 'Genres',
                  desc: 'One or more genres.' },
                { id: 'jellyseerrFilterLanguage', prop: 'JellyseerrFilterLanguage', type: 'toggle', default: true, label: 'Original language',
                  desc: 'One or more original languages.' },
                { id: 'jellyseerrFilterContentRating', prop: 'JellyseerrFilterContentRating', type: 'toggle', default: true, label: 'Content rating',
                  desc: 'The ratings used in your Default Region (Elsewhere & Reviews tab). US ratings where TMDB has none for it.' },
                { id: 'jellyseerrFilterStreaming', prop: 'JellyseerrFilterStreaming', type: 'toggle', default: true, label: 'Streaming services',
                  desc: 'The services available in your Default Region (Elsewhere & Reviews tab).' },
                { id: 'jellyseerrFilterKeywords', prop: 'JellyseerrFilterKeywords', type: 'toggle', default: true, label: 'Keywords',
                  desc: 'Keywords a title must have, and keywords it must not have.' },
                { id: 'jellyseerrFilterRole', prop: 'JellyseerrFilterRole', type: 'toggle', default: true, label: 'Role (actor pages)',
                  desc: 'What the person did in a title: acting, or a crew department such as Directing or Writing.' }
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
                  desc: 'When something a user requested arrives in your library, it goes on that user\'s Jellyfin watchlist. Nothing is added when the request is made, and it reaches their Seerr watchlist only through the Jellyfin → Seerr sync below, if that is on. This is independent of the two adding options below. Changing it needs a Jellyfin restart.' },
                { id: 'syncJellyseerrWatchlist', prop: 'SyncJellyseerrWatchlist', type: 'toggle', label: 'Seerr → Jellyfin: add Seerr watchlist items to Jellyfin',
                  desc: 'Items a user adds to their Seerr watchlist are added to their Jellyfin watchlist (only if the item is in your library).<br/>Runs in Scheduled Tasks &gt; "Sync Watchlist from Seerr to Jellyfin".' },
                { id: 'syncJellyfinWatchlistToSeerr', prop: 'SyncJellyfinWatchlistToSeerr', type: 'toggle', label: 'Jellyfin → Seerr: add Jellyfin watchlist items to Seerr',
                  desc: 'Items a user adds to their Jellyfin watchlist are added to their Seerr watchlist.<br/>Runs in Scheduled Tasks &gt; "Sync Watchlist from Jellyfin to Seerr".' },
                { id: 'preventWatchlistReAddition', prop: 'PreventWatchlistReAddition', type: 'toggle', default: true, label: 'Don\'t re-add items a user removed from Jellyfin',
                  desc: 'An item from Seerr is put on a user\'s Jellyfin watchlist only once. If they remove it, the Seerr → Jellyfin sync will not put it back.' },
                // Clamped to 1..3650 on save and shown only while the toggle above is on (handler in configPage.html).
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
})();

/* ===== arr ===== */
/* *arr tab sections. Sonarr/Radarr instance editors are custom items; their JS in configPage.html binds by id.
 * See jeAdmin.js for the field spec. */
JEAdmin.define({
    'arr-sonarr': {
        title: 'Sonarr', iconImg: 'selfhst/svg/sonarr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated TV show collection management and monitoring. Add one instance per Sonarr server.' },
            { type: 'custom', html: '<div id="sonarrInstancesList"></div>'
                + '<div class="je-arr-action-row"><button id="addSonarrInstance" class="jea-btn" type="button">+ Add Sonarr instance</button>'
                + '<button type="button" id="validateSonarrMappingsBtn" class="jea-btn">Validate Mappings</button>'
                + '<button id="importSonarrFromSeerr" class="jea-btn" type="button">Import from Seerr</button></div>'
                + '<div id="sonarrSeerrImportPicker" class="je-arr-seerr-import-picker" style="display:none;"></div>'
                + '<div id="sonarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-radarr': {
        title: 'Radarr', iconImg: 'selfhst/svg/radarr-light-hybrid-light.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated movie collection management and monitoring. Add one instance per Radarr server.' },
            { type: 'custom', html: '<div id="radarrInstancesList"></div>'
                + '<div class="je-arr-action-row"><button id="addRadarrInstance" class="jea-btn" type="button">+ Add Radarr instance</button>'
                + '<button type="button" id="validateRadarrMappingsBtn" class="jea-btn">Validate Mappings</button>'
                + '<button id="importRadarrFromSeerr" class="jea-btn" type="button">Import from Seerr</button></div>'
                + '<div id="radarrSeerrImportPicker" class="je-arr-seerr-import-picker" style="display:none;"></div>'
                + '<div id="radarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-bazarr': {
        title: 'Bazarr', iconImg: 'selfhst/svg/bazarr.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Automated subtitle downloading and management for Sonarr and Radarr. Single instance, no API key, detail-page links only.' },
            { id: 'bazarrUrl', prop: 'BazarrUrl', type: 'text', label: 'Bazarr URL', placeholder: 'e.g., http://192.168.100.100:6767',
              desc: 'This links to the main movies/series page; Bazarr does not support direct item deep-links.<br/>If Bazarr sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. <code>http://bazarr:6767</code>) and use the URL Mappings below to redirect user-facing links to the public URL.' },
            { id: 'bazarrUrlMappings', prop: 'BazarrUrlMappings', type: 'textarea', rows: 3, label: 'Bazarr URL Mappings', placeholder: 'jellyfin_url|bazarr_url',
              desc: 'Map Jellyfin access URLs to Bazarr URLs. Format: <code>jellyfin_url|bazarr_url</code> (one per line).' },
            { type: 'html', html: '<div class="je-arr-action-row"><button type="button" id="validateBazarrMappingsBtn" class="jea-btn">Validate Mappings</button></div><div id="bazarrMappingsValidationResult"></div>' }
        ]
    },
    'arr-shoko': {
        title: 'Shoko', iconImg: 'selfhst/svg/shoko-server.svg', attrs: { 'data-dep-setup': '' },
        items: [
            { type: 'note', html: 'Surfaces upcoming anime episodes from your Shoko Server collection on the Calendar page. Single instance, no admin-assigned name.' },
            { id: 'shokoUrl', prop: 'ShokoUrl', type: 'text', label: 'Shoko URL', placeholder: 'e.g., http://192.168.100.100:8111',
              desc: 'If Shoko sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. <code>http://shoko:8111</code>) and use the URL Mappings below to redirect user-facing links to the public URL.' },
            { id: 'shokoApiKey', prop: 'ShokoApiKey', type: 'text', showIf: 'shokoUrl', label: 'Shoko API Key',
              toConfig: (v) => (v || '').replace(/\s/g, ''),
              desc: 'API key from Shoko\'s web UI (Settings &gt; API Keys &gt; Add API Key).' },
            { type: 'group', showIf: 'shokoUrl', title: 'Episode types to show on Calendar', open: true, items: [
                { id: 'shokoShowEpisodes', prop: 'ShokoShowEpisodes', type: 'toggle', default: true, label: 'Episodes' },
                { id: 'shokoShowSpecials', prop: 'ShokoShowSpecials', type: 'toggle', label: 'Specials' },
                { id: 'shokoShowCredits', prop: 'ShokoShowCredits', type: 'toggle', label: 'Credits (OP/ED)' },
                { id: 'shokoShowTrailers', prop: 'ShokoShowTrailers', type: 'toggle', label: 'Trailers' },
                { id: 'shokoShowParodies', prop: 'ShokoShowParodies', type: 'toggle', label: 'Parodies' },
                { id: 'shokoShowOther', prop: 'ShokoShowOther', type: 'toggle', label: 'Other',
                  desc: 'Which AniDB episode types appear as calendar events. Episodes are on by default; the rest are usually calendar noise.' }
            ] },
            { type: 'group', showIf: 'shokoUrl', title: 'Advanced URL Mappings', items: [
                { id: 'shokoUrlMappings', prop: 'ShokoUrlMappings', type: 'textarea', rows: 3, label: 'Shoko URL Mappings', placeholder: 'jellyfin_url|shoko_url',
                  desc: 'Map Jellyfin access URLs to Shoko URLs. Format: <code>jellyfin_url|shoko_url</code> (one per line).' },
                { type: 'html', html: '<div class="je-arr-action-row"><button type="button" id="validateShokoMappingsBtn" class="jea-btn">Validate Mappings</button></div><div id="shokoMappingsValidationResult"></div>' }
            ] }
        ]
    },
    'arr-links': {
        title: '*arr UI Links', icon: 'link',
        items: [
            { id: 'arrLinksEnabled', prop: 'ArrLinksEnabled', type: 'toggle', main: true, label: 'Enable *arr Links on Detail Pages',
              desc: 'Show Sonarr, Radarr, and Bazarr links of the items on item detail pages for quick access. <strong>Admins only</strong>.<br/>If no URL is configured for a service, links for that service are not shown.' },
            { id: 'showArrLinksAsText', prop: 'ShowArrLinksAsText', type: 'toggle', label: 'Show links as text',
              desc: 'Render the *arr links as plain text labels instead of icon buttons.' },
            { id: 'arrLinksShowStatusSingle', prop: 'ArrLinksShowStatusSingle', type: 'toggle', label: 'Show status badge for single-instance',
              desc: 'When off (default), a single matching Sonarr/Radarr instance renders as a plain icon/text.<br/>When on, it also shows the episode count (e.g. 22/41) and a colored left border indicating download status. Multi-instance dropdowns always show this detail.' }
        ]
    },
    'arr-tags': {
        title: 'Tags Sync', icon: 'label',
        items: [
            { id: 'arrTagsSyncEnabled', prop: 'ArrTagsSyncEnabled', type: 'toggle', main: true, label: 'Enable Tags Sync',
              desc: 'Fetches all tags from Radarr and Sonarr instances defined above and adds them as Jellyfin tags.<br/><strong>Note:</strong> Run the sync task from Dashboard &gt; Scheduled Tasks &gt; "Sync Tags from *arr to Jellyfin" and configure how often it should run.' },
            { id: 'arrTagsPrefix', prop: 'ArrTagsPrefix', type: 'text', default: 'JE Arr Tag: ', label: 'Tag Prefix', placeholder: 'JE Arr Tag: ',
              desc: 'Prefix to add before each tag (e.g., "JE Arr Tag: " will result in "JE Arr Tag: 1 - Jellyfish")' },
            { id: 'arrTagsClearOldTags', prop: 'ArrTagsClearOldTags', type: 'toggle', default: true, label: 'Clear old tags before sync',
              desc: 'When enabled, removes all existing tags starting with the prefix before adding new ones. This keeps tags in sync with your *arr applications.' },
            { id: 'arrTagsShowAsLinks', prop: 'ArrTagsShowAsLinks', type: 'toggle', default: true, label: 'Show synced tags as links',
              desc: 'Displays tags with the configured prefix as clickable links on item detail pages. Helpful if your theme hides tags.' },
            { type: 'group', title: 'Tag Filters', items: [
                { id: 'arrTagsSyncFilter', prop: 'ArrTagsSyncFilter', type: 'textarea', rows: 3, label: 'Sync to Jellyfin Filter', placeholder: 'One per line',
                  desc: 'Only sync specific tags from *arr to Jellyfin. Enter one tag name per line (without the prefix).<br/>Leave empty to sync all tags.<br/><strong>Example:</strong> to only sync "1 - Jellyfish" and "trakt", enter:<br/><code>1 - Jellyfish</code><br/><code>trakt</code>' },
                { id: 'arrTagsLinksFilter', prop: 'ArrTagsLinksFilter', type: 'textarea', rows: 3, label: 'Show as Links Filter', placeholder: 'One per line',
                  desc: 'Only show specific tags as links. Enter one tag name per line (without the prefix).<br/>Leave empty to show all tags with the prefix.<br/><strong>Example:</strong> to only show "JE Arr Tag: 1 - Jellyfish" and "JE Arr Tag: trakt" as links, enter:<br/><code>1 - Jellyfish</code><br/><code>trakt</code>' },
                { id: 'arrTagsLinksHideFilter', prop: 'ArrTagsLinksHideFilter', type: 'textarea', rows: 3, label: 'Hide Specific Links Filter', placeholder: 'One per line',
                  desc: 'Hide specific tags from being displayed as links. Enter one tag name per line (without the prefix).<br/>This filter takes priority over the "Show" filter above.<br/><strong>Example:</strong> to hide "JE Arr Tag: spam_tag" and "JE Arr Tag: test_tag", enter:<br/><code>spam_tag</code><br/><code>test_tag</code>' }
            ] }
        ]
    }
});

/* ===== admin ===== */
/* Admin tab sections. Maintenance Mode and Usage Statistics keep their load/save in configPage.html (manual: true) because of
 * side effects (enable/disable calls, jeTouched, jeLoaded, JSON user list); only their markup is rendered here. */
JEAdmin.define({
    'analytics': {
        title: 'Usage Statistics',
        icon: 'insights',
        class: 'je-fieldset-wide',
        items: [
            { type: 'note', html: 'Fully opt-in and off by default. No URLs, API keys, usernames, filenames, or media titles are ever collected. Turning this on always includes just an anonymous install ID, plugin version, and Jellyfin version/target, enough to answer "how many installs are on the latest version." Untick all three options to share only that. Use the preview below to see exactly what would be sent, or read <a class="sectionTitle" href="https://n00bcodr.github.io/Jellyfin-Enhanced/advanced/community-analytics/" target="_blank" rel="noopener">what each option collects and why</a>.' },
            { id: 'analyticsEnabled', type: 'toggle', main: true, manual: true, label: 'Share Anonymous Usage Statistics',
              desc: 'Periodically sends an anonymous report to the Jellyfin Enhanced community analytics project. Each install gets a random ID that identifies nothing about you or your server.' },
            { type: 'custom', html: '<div id="analyticsSubOptionsContainer"></div>' },
            { id: 'analyticsShareFeatureFlags', type: 'toggle', manual: true, label: 'Feature toggle states (on/off only)' },
            { id: 'analyticsShareUsageCounts', type: 'toggle', manual: true, label: 'Feature usage counts' },
            { id: 'analyticsShareDataSizes', type: 'toggle', manual: true, label: 'Data file sizes (bytes only, never contents)' },
            { id: 'analyticsReportIntervalDays', type: 'number', manual: true, min: 7, max: 30, step: 1, label: 'Reporting interval (days)',
              desc: 'How often a report is sent, between 7 and 30 days.' },
            { type: 'group', title: 'Preview and status', items: [
                { type: 'custom', html:
                    '<div class="jea-actions"><button type="button" id="analyticsPreviewBtn" class="jea-btn">Preview</button></div>'
                    + '<div id="analyticsPreviewContainer" style="display:none"><div class="fieldDescription">This reflects what would be sent based on the selections above.</div>'
                    + '<pre id="analyticsPreviewJson" class="je-json-preview jea-pre"></pre></div>'
                    + '<div id="analyticsLastSent" class="fieldDescription"></div>' }
            ] }
        ]
    },

    'maintenance': {
        title: 'Maintenance Mode',
        icon: 'construction',
        class: 'je-fieldset-wide',
        items: [
            { id: 'maintenanceModeEnabled', type: 'toggle', manual: true, label: 'Enable Maintenance Mode',
              desc: 'When enabled, the selected action is applied to affected users immediately on save. A banner is shown on the Jellyfin login page. Admins are <strong>never</strong> affected. Disabling restores all users automatically.' },
            { id: 'maintenanceModeDurationMinutes', type: 'number', manual: true, showIf: 'maintenanceModeEnabled', min: 0, max: 525600, step: 1, label: 'Duration (minutes)',
              desc: '0 = stays on until you turn it off. Otherwise maintenance ends itself after this many minutes: the banner shows a live countdown and the toggle above switches off automatically. Changing the number restarts the clock; saving other settings does not.' },
            { type: 'group', showIf: 'maintenanceModeEnabled', title: 'Messages', open: true, items: [
                { id: 'maintenanceModeMessage', type: 'textarea', manual: true, rows: 2, label: 'Login Page Banner Message',
                  placeholder: 'This server is currently undergoing maintenance. Please try again later.',
                  desc: 'Shown as a red banner at the top of every page (login + home). Plain text only. Use <code>{countdown}</code> for the time remaining and <code>{ends_at}</code> for the end time; with a duration set and no token, the time remaining is appended automatically.' },
                { id: 'maintenanceModeNotificationMessage', type: 'textarea', manual: true, rows: 2, label: 'Active Session Notification',
                  placeholder: 'Server maintenance is starting. Please finish up and try again later.',
                  desc: 'Sent as a native Jellyfin popup to anyone currently watching; reaches all clients (web, mobile, TV apps). Same <code>{countdown}</code> / <code>{ends_at}</code> tokens as the banner.' },
                { id: 'maintenanceModeRemindOnPlayback', type: 'toggle', manual: true, label: 'Remind on playback start',
                  desc: 'While maintenance is active, re-send the notification above (with the time remaining) to affected non-admin users each time they start playing something, on any client. At most once every 5 minutes per session. Only useful when accounts are <em>not</em> disabled.' }
            ] },
            { type: 'group', showIf: 'maintenanceModeEnabled', title: 'Action', open: true, items: [
                { id: 'mmAction_accounts', type: 'toggle', manual: true, attrs: { checked: 'checked' }, label: 'Disable user accounts',
                  desc: 'Users cannot log in at all until maintenance ends.' },
                { id: 'mmAction_remote', type: 'toggle', manual: true, label: 'Disable remote connections',
                  desc: 'Blocks connections from outside the local network; LAN access still works.' }
            ] },
            { type: 'group', title: 'Affected users', open: true, items: [
                { type: 'custom', html:
                    '<div class="jea-radio-list">'
                    + '<label class="jea-radio"><input type="radio" name="maintenanceModeUsers" id="mmUsers_all" value="all" checked/><span>All non-admin users</span></label>'
                    + '<label class="jea-radio"><input type="radio" name="maintenanceModeUsers" id="mmUsers_select" value="select"/><span>Select specific users</span></label>'
                    + '</div>'
                    + '<div id="je-mm-user-list" class="jea-userlist" style="display:none">'
                    + '<div class="jea-actions"><button type="button" id="je-mm-select-all" class="jea-btn">Select All</button><button type="button" id="je-mm-deselect-all" class="jea-btn">Deselect All</button></div>'
                    + '<div id="je-mm-users-inner"><div id="je-mm-users-loading" class="fieldDescription">Loading users...</div></div>'
                    + '</div>' }
            ] },
            { type: 'group', title: 'Daily schedule', open: true, items: [
            { id: 'maintenanceScheduleEnabled', type: 'toggle', manual: true, label: 'Enable daily maintenance window',
              desc: 'Turns maintenance mode on and off by itself every day between the times below (server local time), with its own message and action, e.g. for nightly library scans. Uses the <strong>Affected users</strong> selection above. The manual toggle takes precedence while it is on; turning the schedule off ends a running window early.' },
            { type: 'custom', showIf: 'maintenanceScheduleEnabled', html:
                '<div class="jea-timepair">'
                + '<div class="inputContainer jea-row"><label class="inputLabel" for="maintenanceScheduleStart">Start time</label><input id="maintenanceScheduleStart" name="maintenanceScheduleStart" type="time" class="jea-input"/></div>'
                + '<div class="inputContainer jea-row"><label class="inputLabel" for="maintenanceScheduleEnd">End time</label><input id="maintenanceScheduleEnd" name="maintenanceScheduleEnd" type="time" class="jea-input"/></div>'
                + '</div>'
                + '<div id="mmScheduleSameTimeWarning" class="fieldDescription jea-warn-text" style="display:none">Start and end time must differ; the schedule is ignored until they do.</div>'
                + '<div id="mmServerTimeHint" class="fieldDescription"></div>' },
            { id: 'maintenanceScheduleMessage', type: 'textarea', manual: true, showIf: 'maintenanceScheduleEnabled', rows: 2, label: 'Scheduled Banner Message',
              placeholder: 'The library is updating; slowdowns are normal. Time remaining: {countdown}',
              desc: 'Banner shown while the window is active. Same <code>{countdown}</code> / <code>{ends_at}</code> tokens.' },
            { id: 'maintenanceScheduleNotificationMessage', type: 'textarea', manual: true, showIf: 'maintenanceScheduleEnabled', rows: 2, label: 'Scheduled Session Notification',
              placeholder: 'The library is updating; slowdowns are normal.',
              desc: 'Popup sent to active sessions when the window starts, and on playback start when reminders are on.' },
            { type: 'group', showIf: 'maintenanceScheduleEnabled', title: 'Scheduled action (leave both off for a banner-only window)', open: true, items: [
                { id: 'mmSchedAction_accounts', type: 'toggle', manual: true, label: 'Disable user accounts' },
                { id: 'mmSchedAction_remote', type: 'toggle', manual: true, label: 'Disable remote connections' }
            ] }
            ] }
        ]
    },

    'developer': {
        title: 'Developer Settings',
        icon: 'code',
        items: [
            { id: 'devMode', prop: 'DevMode', type: 'toggle', label: 'Dev Mode',
              desc: 'Disables JS caching so scripts are always re-fetched from the server. Default: OFF.' },
            { type: 'note', tone: 'warn', html: 'Do not change this if you do not know why you are changing it.' }
        ]
    }
});

/* ===== about ===== */
/* About tab: credits for the projects this plugin's features build on. */
JEAdmin.define({
    'credits': {
        title: 'Credits', icon: 'favorite',
        items: [
            { type: 'note', html: 'Jellyfin Enhanced builds on the work of other Jellyfin community projects. Thank you to their authors.' },
            { type: 'html', html: '<ul class="jea-credits">'
                + '<li><strong>Media Tags</strong><span>Based on <a href="https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/" target="_blank" rel="noopener">Jellyfin-Qualitytags</a> by BobHasNoSoul</span></li>'
                + '<li><strong>Custom pause screen</strong><span>Based on <a href="https://github.com/BobHasNoSoul/Jellyfin-PauseScreen" target="_blank" rel="noopener">Jellyfin-PauseScreen</a> by BobHasNoSoul</span></li>'
                + '<li><strong>MDBList ratings</strong><span>Based on <a href="https://github.com/xroguel1ke/jellyfin_ratings" target="_blank" rel="noopener">jellyfin_ratings</a> by xroguel1ke</span></li>'
                + '<li><strong>Metadata icons</strong><span>Uses <a href="https://github.com/Druidblack/jellyfin-icon-metadata" target="_blank" rel="noopener">jellyfin-icon-metadata</a> by Druidblack</span></li>'
                + '</ul>' }
        ]
    }
});

/* ===== Services: linked copies of cards that live in their feature tabs ===== */
JEAdmin.define({
    // Maintainerr's address and key are fields of the Media Tags tab (Status badges > Leaving soon); this card only explains and links.
    'svc-maintainerr': {
        title: 'Maintainerr', iconImg: 'selfhst/svg/maintainerr.svg',
        items: [
            { type: 'note', html: 'Maintainerr is only used to show <strong>how many days are left</strong> before an item leaves, on the <strong>Leaving soon</strong> media tag. Nothing else in Jellyfin Enhanced talks to it.' },
            { type: 'custom', html: '<a class="jea-btn jea-btn-primary" style="text-decoration:none" href="#/configurationpage?name=Jellyfin%20Enhanced&amp;jeSection=media-tags&amp;tab=badges"><i class="material-icons" aria-hidden="true">new_releases</i><span>Set up Leaving soon</span></a>' }
        ]
    },
    'svc-tmdb': { mirrorOf: 'elsewhere-tmdb' },
    'svc-anilist': { mirrorOf: 'reviews-anilist' },
    'svc-mdblist': { mirrorOf: 'mdblist' },
    'svc-ddd': { mirrorOf: 'content-warnings' }
});
