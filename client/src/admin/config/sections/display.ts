import type { DefineSections, SelectField, ToggleField } from '../engine/schema';

export function defineDisplay(define: DefineSections): void {
/* Display tab sections. See jeAdmin.js for the field spec. */
define({
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
                  toConfig: (v) => String(v || '').trim(), fromConfig: (v) => (typeof v === 'string' ? v : ''),
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
    const UL = (...li: string[]): string => '<ul class="je-desc-list">' + li.map((x) => '<li>' + x + '</li>').join('') + '</ul>';
    const tog = (id: string, label: string, desc: string | null, extra?: Partial<ToggleField>): ToggleField => ({ id, type: 'toggle', manual: true, label, desc, ...extra });
    const sel = (id: string, label: string, options: SelectField['options'], desc: string, extra?: Partial<SelectField>): SelectField => ({ id, type: 'select', manual: true, label, options, desc, ...extra });
    const RS: ReadonlyArray<readonly [string, string]> = [['tmdb', 'TMDB'], ['tomatoes', 'RT Critic'], ['popcorn', 'RT Audience'], ['imdb', 'IMDb'], ['trakt', 'Trakt'],
        ['metacritic', 'Metascore'], ['metacriticuser', 'Metacritic User'], ['letterboxd', 'Letterboxd'], ['myanimelist', 'MAL'], ['anilist', 'AniList'], ['master', 'Master']];
    const RSN: ReadonlyArray<readonly [string, string]> = [['', 'None'], ...RS];
    const arrow = (d: string): string => '<i class="material-icons je-cat-arrow-icon" aria-hidden="true">arrow_' + d + 'ward</i>';

    define({
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
}
