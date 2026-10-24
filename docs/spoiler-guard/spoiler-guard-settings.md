# Spoiler Guard Settings

Open Dashboard → Plugins → **Jellyfin Enhanced** → **Display** → **Spoiler Guard** to set server-wide policy. Users can relax individual metadata policies and seek previews in [Per-user overrides](#per-user-overrides). See [Spoiler Guard features](spoiler-guard-features.md) for title toggles, supported clients, collection inheritance, and browsing examples.

!!! note "A title must be protected"

    Protection needs a user's direct series/movie entry or applicable collection membership. The relevant item eligibility rules also apply.

## Master switch

Turn on Spoiler Guard to let users protect individual titles. You can also add protection through automatic modes.

**How to use:** Enable **Enable Spoiler Guard**, then save the configuration.
## Titles that have not arrived yet
The same admin caps and per-user preferences apply to request-mode pages, provider feeds and the 10.11 More Info window. Movie posters follow **Keep movie posters**; title backdrops and logos follow the artwork setting. Guest-stars-only cast mode keeps the regular cast. Calendar series posters follow the title artwork settings, independently of episode artwork. Combined provider ratings follow the ratings preference. Missing-episode request rows use the episode title, description and air-date settings. A provider opt-in remains effective across arrival and later library copies.
An episode the library has no numbers for is still protected: it becomes `Season X, Episode` (no episode number), `Episode Y` (no season) or just `Episode`. Its original title, sort title and season name go with it.
A protected item never passes on its own text, even text that looks valid. Every value it keeps is rebuilt: a track's language is written the way Jellyfin's language list writes it (a file tagged with anything else shows the track without a language), codec and channel names are the ones ffmpeg reports, and a rating is written the way Jellyfin's rating tables write it (`PG`, `DE-12`). A rating with any other text in it is left out. Provider ids are kept only for known providers and in their id format. An episode's or season's genres, studios and cast are copied from its series, so guest stars and episode-only names are left out. An extra's name is replaced by what kind of extra it is (`Trailer`, `Featurette`). Stream and subtitle links are rebuilt from Jellyfin's own link formats, so a subtitle file's name never shows in its link, and playback works as before, including external subtitles and streams from a URL. A movie version's label is built from its video stream (`1080p HEVC SDR`, or `Version 2`) instead of the file name, and the names of the movie and the series come from the library. The same applies on every surface, including search results for seasons and extras, the activity log (a guarded title's extra that was played shows as "is playing Featurette"), and Jellyfin Enhanced's own tags and poster tags (extras included). An item gets one decision, whatever shows it: a guarded show's featurettes and trailers have their images protected like their pages, and with the advanced reveals an episode whose title is revealed shows it in item pages, search results, the activity log and its card tags alike. On request-mode pages a later season's name is hidden like an episode title (seasons 0 and 1 stay). When several people share one address and an image request doesn't say who is asking, the image is protected if it is protected for any of them. Turning Spoiler Guard on, hiding something, marking an episode unwatched or a library scan attaching a video to a guarded show (or moving or renumbering an episode) takes effect for the very next answer, even one that was already being prepared (card tags, poster tags, item pages, search, activity, sessions, images): an answer is checked once it is complete, right before any of it is sent, against everything it was decided by (the library's current items, the guard and hiding rules as saved on disk, chapter and scrubbing-preview timing, the server's "specials in seasons" setting and where each special is placed, collection membership, watched state), and prepared again (or not sent) when something it depends on changed meanwhile; nothing is ever cut off halfway; the same goes for changing any Spoiler Guard setting (chapter names, the advanced per-category reveals) and for adding a movie to a guarded collection. A library refresh that leaves an item as it was (a new image, an unrelated episode or collection member, a reordered collection) never costs a permitted image its picture or holds up an answer. A browser's earlier, unprotected copy of a poster is never confirmed as current once the poster is guarded, and a video that keeps playing (its progress is saved every few seconds) never holds up pages that are loading meanwhile. A guarded movie's extras follow the movie when you mark it watched or unwatched without reloading all of the tags.

| Setting | Default | What it does |
|---|---|---|
| **Enable Spoiler Guard** | Off | Enables server protection and JE's Spoiler Guard interface. Stored lists remain when it is off, but do not activate protection. |

??? info "How it works"

    The master gates the other controls. Cast scope depends on cast hiding; advanced category controls depend on advanced mode.

    Metadata controls are under **Hide metadata on unwatched episodes**, although several also affect series, movies, seasons, and extras.

    | Setting | Internal property |
    |---|---|
    | **Enable Spoiler Guard** | `SpoilerBlurEnabled` |

## Image replacement mode

Choose whether protected images use parent artwork or blur. This lets you keep browsing without seeing the original scene.

**How to use:**

1. Set **Image replacement mode** and adjust **Blur intensity**.
2. Choose the artwork, movie-poster, and seek-preview options below, then save.
3. Fetch fresh item metadata in your clients after changing policy.

![Admin Spoiler Guard settings with stock-card mode, image exceptions, automatic scope, and metadata policies](../images/admin/spoiler-policy.webp)

| Setting | Default | What it does |
|---|---|---|
| **Image replacement mode** | **Show stock cards (hide images entirely, default)** | Uses parent artwork, or **Blur images** to blur the original. Missing parent art falls back to blur. |
| **Blur intensity** | 40 | Blur strength; UI range 5–100. Higher values give stronger blur, but do not guarantee that all content becomes unrecognizable. Also controls stock-card fallback blur. |
| **Also hide the wide backdrop / fanart** | Off | Protects wide backdrops and fanart on eligible items. |
| **Keep movie posters visible** | On | Keeps guarded movie posters and thumbnails visible in either replacement mode. |
| **Hide trickplay seek previews** | On | Protects the scrubbing previews of protected unwatched episodes and movies. Sheets ending before saved progress still reveal; users can opt out. |

With **Keep movie posters visible** off, **Also hide the wide backdrop / fanart** on, and **Blur images** selected, both the protected movie's poster and backdrop blur. Its logo remains visible.

![Protected movie with its poster and backdrop blurred while its logo remains clear](movie-poster.webp)

??? info "How it works"

    **Image replacement mode** uses `SpoilerBlurMode="hide"` for **Show stock cards (hide images entirely, default)**, or `"blur"` for **Blur images**. Blur uses a Gaussian transformation on the server.

    | Setting | Internal property |
    |---|---|
    | **Blur intensity** | `SpoilerBlurIntensity` |
    | **Also hide the wide backdrop / fanart** | `SpoilerBlurArtwork` |
    | **Keep movie posters visible** | `SpoilerKeepMoviePosters` |
    | **Hide trickplay seek previews** | `SpoilerBlurTrickplay` |

### Show stock cards

Stock cards replace eligible images with parent artwork. You can still recognize the show or collection without seeing the protected image.

**How to use:** Select **Show stock cards (hide images entirely, default)** in **Image replacement mode** and save.

| Eligible item | Parent artwork |
|---|---|
| Episode | Series Backdrop |
| Season | Series Primary/poster |
| Movie protected only through a collection | Guarded collection Primary/poster |
| Directly protected movie, or item without suitable parent artwork | Blurred original |

??? note "Fallbacks and exceptions"

    A movie with a direct entry uses fallback blur even if it also inherits collection protection. Movie Primary/Thumb replacement only takes effect with **Keep movie posters visible** off.

    Recognized image-processing failures use dark stock/fallback images. Unsupported result shapes, unresolved identity, missing scope, or configured exemptions can still return original content. Stock-card fallback blur can retain silhouettes and colors.

### Blur images

Blur hides detail but leaves some color and shape information visible. Increase **Blur intensity** for stronger blur.

**How to use:** Select **Blur images** in **Image replacement mode**, adjust **Blur intensity**, and save.

### Image eligibility and exceptions

Protection focuses on unwatched content. Series, collection, and early-season artwork stays visible to help you navigate.

??? note "Which images stay protected"

    Primary, Thumb, Screenshot, and Chapter images are covered. Supported trickplay images are covered while **Hide trickplay seek previews** is on and the user has not unchecked **Seek previews**. Backdrop/Art and the title Logo are optional (**Also hide the wide backdrop / fanart**): with it on, a guarded title's backdrops, art and logos are protected everywhere (the show's own, its episodes', its extras', a movie's), the same way request-mode pages treat them. Banner remains outside replacement.

    When seek previews are not protected, previews of protected items are served unchanged with `no-store` caching, so turning protection back on takes effect at the next fetch. Previews of unprotected items are unaffected.

    Series and collection images pass through. Season 0/1 images pass through; later-season images are protected until any episode in that season is played. Played movies and episodes are exempt. Unplayed episodes inside Season 0/1 remain eligible.

    **Keep movie posters visible** leaves movie chapter thumbnails and screenshots eligible, as well as Backdrop/Art when enabled. Movie chapters starting strictly before saved playback progress are revealed; those starting at or after it remain protected. Episodes retain chapter-image protection until played. Whole trickplay sheets can be revealed for either item type when their calculated exclusive end is at or before saved progress. See [saved-progress rules](spoiler-guard-features.md#saved-progress-chapters-and-trickplay).

    Advanced mode can exempt the next episode's Primary/Thumb image. Metadata opt-outs do not directly disable image replacement; opting out of advanced mode does disable that exception.

## Auto-enable options

Automatic modes add titles to users' protection lists, reducing the need to toggle each title yourself. All three default to Off.

**How to use:**

1. Enable the modes you want.
2. Set the content-type/library scope below, then save.

!!! note "Master switch required"

    All automatic modes need **Enable Spoiler Guard**. Users can still remove direct entries afterward. An already-loaded JE web session may need a reload to show automatic additions.

| Setting | Default | What it does |
|---|---|---|
| **Auto-enable Spoiler Guard on first play of a new show** | Off | Protects the session user's series on qualifying S1E1 playback. |
| **Auto-enable Spoiler Guard on Seerr request** | Off | Records pending protection after qualifying successful requests through JE. |
| **Auto-enable Spoiler Guard when new titles are added to the library** | Off | Queues newly created shows and movies for bulk per-user additions. |

??? note "Internal setting names"

    | Setting | Internal property |
    |---|---|
    | **Auto-enable Spoiler Guard on first play of a new show** | `SpoilerAutoEnableOnFirstPlay` |
    | **Auto-enable Spoiler Guard on Seerr request** | `SpoilerAutoEnableOnSeerrRequest` |
    | **Auto-enable Spoiler Guard when new titles are added to the library** | `SpoilerAutoEnableOnLibraryAdd` |

### Auto-enable on first play of a new show

This protects a new show when you start S1E1 and currently have no played episode in that series. Later episodes and movies never trigger it, regardless of **Movies** scope.

**How to use:** Enable **Auto-enable Spoiler Guard on first play of a new show**, save, then start qualifying S1E1 playback.

??? note "First-play eligibility"

    This checks current played flags, not immutable lifetime viewing history. Clearing every played flag can make later S1E1 playback qualify again. A resume point alone does not disqualify S1E1. Type and library scope apply.

### Auto-enable on Seerr request

This records pending protection after qualifying successful requests through JE. Manual pre-arming is also available independently; see [pending protection](spoiler-guard-features.md#pre-arming-for-titles-not-yet-in-your-library).

**How to use:** Enable **Auto-enable Spoiler Guard on Seerr request**, save, then request a title through JE.

!!! warning "Check protection after requesting"

    Automatic protection is best-effort. A successful Seerr request can remain unprotected if the background hook fails. Refresh state to check it.

??? note "Request eligibility and failures"

    The hook covers qualifying 2xx results from JE's Seerr request proxy. Requests submitted directly in Seerr, HTTP 409 conflicts, and other failures do not trigger it. Type scope applies; library scope does not restrict pending intent or its later promotion.

    Cap, storage, or hook failures do not turn the successful request into a failure.

### Auto-enable when new titles are added to the library

This adds newly created shows and movies to users' protection lists. New items are queued from any library source.

**How to use:** Enable **Auto-enable Spoiler Guard when new titles are added to the library**, choose and save scope, then add new titles.

!!! note "Protection can take time"

    Protection becomes active after each user's changes are written successfully. It is not guaranteed while the batch is waiting or processing.

??? note "Batch timing and eligibility"

    Batch processing starts about ten seconds after the first addition and writes each user's changes together.

    - Only newly created titles count. Existing-title rescans and metadata refreshes do not re-arm a title a user removed. Adding a new library can arm its newly created titles. Use [apply-existing](#guarding-titles-already-in-the-library) for older items.
    - The batch rechecks the saved type/library scope. Turning off the master or this mode before processing drops the queued batch.
    - Users with library permissions are included, even disabled accounts. Parental-rating and tag restrictions are not applied by this bulk check. Users created after an addition do not receive its entries retroactively.
    - Played titles are not skipped. Their stored entries can become active if the titles are later marked unplayed. Existing direct entries are preserved. There is no per-user switch to opt out of this automatic mode.

### Auto-enable scope (content type and libraries)

Scope lets you choose which content automatic modes protect. The same saved scope also applies when you protect existing titles.

**How to use:** Under **Auto-enable applies to**, choose types and libraries, then save. Leave every library unchecked to cover all.

| Setting | Default | What it does |
|---|---|---|
| **TV shows** | On | Allows series in automatic modes and apply-existing. |
| **Movies** | On | Allows movies in Seerr-request/library-add modes and apply-existing. First play still only handles shows. |
| **Libraries — leave every library unticked to cover all of them. Doesn't apply to Seerr requests (the title isn't in a library yet).** | All; none checked | Restricts first play, library add, and apply-existing. Does not restrict Seerr pending intent/promotion. |

??? note "Library picker and internal values"

    The picker includes TV, movie, and mixed libraries, with their actual names and type suffixes. Deleted selections are flagged and dropped on save. Until then, an allowlist containing only deleted valid IDs can match nothing. If the picker cannot load, saving preserves the previous selection.

    | Setting | Internal property |
    |---|---|
    | **TV shows** | `SpoilerAutoEnableSeries` |
    | **Movies** | `SpoilerAutoEnableMovies` |
    | **Libraries — leave every library unticked to cover all of them. Doesn't apply to Seerr requests (the title isn't in a library yet).** | `SpoilerAutoEnableLibraryIds`; defaults to an empty string; selected IDs are stored comma-separated. |

## Guarding titles already in the library

Use **Apply to existing titles now…** for a one-time pass over existing shows and movies. It works independently of ongoing library-add auto-enable.

**How to use:**

1. Enable the master, then choose and save scope. Unsaved configuration blocks the preview.
2. Optionally check **Also skip titles a user has already started watching**.
3. Click **Apply to existing titles now…** and inspect the preview counts. A preview with no eligible additions shows **Nothing to apply**.
4. Confirm the run. You can follow progress or cancel it from the dashboard.

| Setting | Default | What it does |
|---|---|---|
| **Also skip titles a user has already started watching** | Off | Per-run option, not a saved plugin setting. Skips resumable movies and series with any played or resumable episode. |
| **Apply to existing titles now…** | Manual action | Previews the saved scope, then starts the scheduled task after confirmation. |

!!! note "Cancellation keeps completed changes"

    Cancellation keeps completed writes. If tracking is lost, check task status and logs before rerunning.

??? note "Eligibility and scheduled-task behavior"

    Both this action and Dashboard → scheduled tasks → **Spoiler Guard: apply to existing titles** use these rules:

    - **Scope and users:** Saved content-type/library scope; users with library permissions, including disabled accounts. The bulk check does not apply parental-rating or tag restrictions.
    - **Already guarded:** Direct Series/Movie entries are skipped. A movie protected only through collection membership can gain a direct entry.
    - **Fully watched:** Played movies are skipped. Series are skipped only when they have at least one on-disk episode and all on-disk episodes, including specials, are played. A series with no episodes is not considered fully watched.
    - **Partially watched:** Included by default. The optional skip-started check uses Jellyfin's `IsResumable` state, plus played episodes for series. Its query parameter defaults to `skipStarted=false`.
    - **Execution:** Preview writes nothing; the actual run recomputes conditions, so counts can change. One actual run proceeds at a time. Each user's additions are written together. Per-user failures are reported; successful writes remain.
    - **Progress:** The task reports progress and can be cancelled from the dashboard.

    The scheduled task has no default triggers. A normal dashboard run includes started titles. Running again can re-arm titles users removed since the earlier pass, unless watched/started skip rules exclude them. There is no removal history. Rescans never do this.

## Strict refresh mode

A detail-page toggle normally refreshes matching item images while text waits for navigation. Turn on strict refresh to reload descriptions, titles, and ratings too, with a brief page flash.

**How to use:** Enable **Strict refresh mode (full page reload after toggle)** and save.

| Setting | Default | What it does |
|---|---|---|
| **Strict refresh mode (full page reload after toggle)** | Off | Adds a full reload to the normal detail-toggle image refresh. |

??? info "How it works"

    The full reload is scheduled after 600 ms. Image refresh covers matching item-image URLs in sources, source sets, and inline backgrounds, not every image or trickplay URL.

    Supported watched-state changes always use an image refresh after about 200 ms, without a full reload. Seerr-modal toggles and personal preference saves do not use the detail-toggle refresh path. See [refresh behavior](spoiler-guard-features.md#after-toggling-what-happens-on-your-screen).

    | Setting | Internal property |
    |---|---|
    | **Strict refresh mode (full page reload after toggle)** | `SpoilerBlurStrictRefresh` |

## Hide metadata on unwatched episodes

Choose which information to hide while you browse protected titles. These admin policies also apply to eligible movies, series, seasons, and extras; see the [item-scope matrix](spoiler-guard-features.md#what-spoiler-guard-protects).

**How to use:** Open **Hide metadata on unwatched episodes**, choose fields to protect, and save.

| Setting | Default | What it does |
|---|---|---|
| **Hide TV show descriptions** | On (effective default) | Independently hides guarded TV show descriptions. |
| **Hide episode descriptions** | On | Replaces nonempty descriptions on eligible episodes, movies, later seasons, and extras. |
| **Placeholder text** | `Spoiler Guard activated` | Replacement for a protected nonempty description. |
| **Hide tags** | On | Removes story tags and JE genre, language, and quality overlays on eligible content. Score overlays use the separate ratings policy. |
| **Hide chapter names (keep timestamps)** | On | Uses `Chapter N` for protected chapter names; keeps timestamps. Image-byte protection is independent. |
| **Hide taglines** | On | Removes eligible taglines. |
| **Hide ratings** | On | Clears community and critic scores and suppresses their JE card overlays. |
| **Hide air date** | On | Clears eligible premiere dates. JE's release-date chip in the details header then doesn't look the date up on TMDB either (unwatched episodes, and seasons after the first with nothing watched). |
| **Replace episode titles** | On | Uses `Season X, Episode Y` for numbered protected episodes, and `Season N` for eligible numbered seasons. |
| **Hide cast on unwatched episodes** | On | Filters eligible cast lists, including applicable non-episode items. |
| **Cast hiding scope** | **Guest stars only (recommended)** | Removes only guest-star entries. **Entire cast (regulars + guest stars)** removes every person entry, including crew. |
| **Hide reviews on Spoiler Guard series** | On | Suppresses JE's web Reviews panel on guarded series and child pages, and directly guarded movies. |

??? note "Internal setting names"

    | Setting | Internal property |
    |---|---|
    | **Hide episode descriptions** | `SpoilerStripOverview` |
    | **Placeholder text** | `SpoilerOverviewPlaceholder` |
    | **Hide tags** | `SpoilerStripTags` |
    | **Hide chapter names (keep timestamps)** | `SpoilerStripChapters` |
    | **Hide taglines** | `SpoilerStripTaglines` |
    | **Hide ratings** | `SpoilerStripRatings` |
    | **Hide air date** | `SpoilerStripPremiereDate` |
    | **Replace episode titles** | `SpoilerReplaceTitle` |
    | **Hide cast on unwatched episodes** | `SpoilerStripCast` |
    | **Hide reviews on Spoiler Guard series** | `SpoilerStripReviews` |
    | **Hide TV show descriptions** | `SpoilerStripSeriesOverview`; raw default `null`, inheriting `SpoilerStripOverview` until explicitly saved. |
    | **Cast hiding scope** | `SpoilerStripCastMode="GuestStars"` removes `GuestStar` entries; `"All"` removes every `People` entry, including crew. |

### Descriptions and placeholder text

Protected nonempty descriptions use your placeholder text. Empty descriptions stay empty.

**How to use:** Set **Placeholder text** and save. Save a separate **Hide TV show descriptions** choice if you want it to differ from episode-description hiding.

??? note "Placeholder cleanup and older settings"

    The nullable series-description property preserves older episode-description choices on upgrade. Its fresh effective default is On because episode-description hiding defaults On. Saving an independent choice separates the policies.

    Before serving the placeholder, the server takes the raw text's first 200 characters, removes HTML tags, then removes angle brackets, quotation marks, apostrophes, backticks, and ampersands. Empty or whitespace-only sanitized text falls back to `Spoiler Guard activated`. Items with an empty original `Overview` do not gain an invented description.

### Chapter names and thumbnails

Chapter names and thumbnail images have separate protection rules. You can keep chapter names visible without revealing protected images.

**How to use:** Turn off **Hide chapter names (keep timestamps)** to retain names, then save.

??? note "Chapter and preview limits"

    Turning off chapter-name hiding does not reveal protected chapter images. Effective title or description protection can also clear chapter image-path metadata.

    Movie chapters starting strictly before saved progress are revealed; the chapter exactly at the resume point stays protected. Episodes use played/unplayed chapter protection. Trickplay follows **Hide trickplay seek previews** and whole-sheet progress rules rather than the chapter-name switch.

### Titles, ratings, and cast

You can replace episode titles, hide scores, and remove guest stars or the whole cast. These choices reduce spoilers in names and cast lists while you browse.

**How to use:** Choose **Replace episode titles**, **Hide ratings**, and **Hide cast on unwatched episodes** as needed. Set **Cast hiding scope**, then save.

??? note "Title, score, and character-role limits"

    Title replacement applies to supported routes/response shapes, including common lists and detail pages. Ordinary episode rewriting requires both season and episode numbers. User overrides, advanced reveals, missing numbering, and unsupported surfaces can alter results. Search hints remain stricter: enabled description hiding can replace a hint's name even when title replacement is off.

    JE community/critic score overlays are suppressed on guarded series and season cards and unwatched episode cards without falling back to the series score. Played episodes keep their scores. Category metadata reveals do not relax card score overlays. Ordinary DTO genres and official age ratings remain; JE age badges can retain series classification.

    The quality overlays controlled by **Hide tags** are derived from stream metadata. Tagline hiding empties eligible tagline arrays.

    Cast filtering does not by itself clear surviving character roles. Roles are cleared when effective title replacement or the item's applicable description hiding applies, even if cast filtering is off or personally opted out.

### Reviews

Spoiler Guard can hide JE's Reviews panel on protected detail pages. This helps you avoid spoilers even after an episode or directly protected movie is played.

**How to use:** Enable **Hide reviews on Spoiler Guard series** and save. Users can opt out with **Reviews** in their personal settings.

!!! note "Reviews must also be enabled"

    Reviews need **Show TMDB Reviews** with TMDB integration, or **Enable User Written Reviews**. Both default Off and live outside Spoiler Guard; see [Enhanced settings](../enhanced/enhanced-settings.md).

??? note "Review scope and API limits"

    Review suppression runs in JE's injected web client. It covers guarded Series/Season/Episode pages, including watched episodes, and directly guarded movies, including played movies. Collection-only movie protection does not suppress the panel. A failed state load can suppress the panel broadly on eligible page types.

    The Reviews API applies author visibility rules but does not suppress responses based on the viewer's Spoiler Guard state.

### Auxiliary metadata

Title and description protection can also remove text from links, paths, and other metadata that might contain spoilers. This can affect clients or tools that require raw paths.

??? note "Fields affected by title and description protection"

    Effective title replacement or applicable description hiding can clear filesystem paths, episode-title/sort fields, custom rating, remote trailers, external links, stream titles/comments, attachment filenames/comments, surviving character roles, and protected chapter image paths.

    Cast and chapter-name opt-outs do not independently restore those fields. Indexed subtitle delivery URLs remain available; raw external subtitle URLs can be cleared. Movie media-source version names are retained.

## Advanced per-category reveals

Reveal selected information for your next unwatched episode and other unwatched episodes in its season. With advanced mode on and otherwise default settings, only the next episode's real title is revealed.

An episode's category reveal is one decision, the same wherever the episode shows: its item pages and episode lists (Next Up included), search results, the activity log, Jellyfin Enhanced's card tags (whether they come from the cached tag download or are asked for card by card) and the tags drawn on posters. A rating you reveal for the next episode shows on its card's rating overlay too; a rating you keep hidden is hidden everywhere. For the next episode only, its own poster image can be revealed as well.

**How to use:**

1. Turn on **Enable advanced per-category reveals**.
2. Uncheck the fields you want revealed. Checked means “keep hidden.”
3. Save the configuration.

| Setting | Default | What it does |
|---|---|---|
| **Enable advanced per-category reveals** | Off | Enables selected reveals for the next episode and its season. |
| **Next episode: keep title hidden** | Off | Permits the next unwatched episode's real title when advanced mode is enabled. |
| **Next episode: keep description hidden** | On | Uncheck to reveal its description. |
| **Next episode: keep ratings hidden** | On | Uncheck to reveal its community/critic metadata scores. |
| **Next episode: keep image hidden** | On | Uncheck to exempt its Primary/Thumb image. Does not reveal chapters or trickplay. |
| **Current season: keep titles hidden** | On | Uncheck to reveal other unwatched episode titles in the selected next episode's season. |
| **Current season: keep descriptions hidden** | On | Uncheck to reveal those descriptions. |
| **Current season: keep ratings hidden** | On | Uncheck to reveal those metadata scores. |

Users can uncheck **Advanced per-category reveals** in personal settings to restore uniform protection, including disabling the next-image exception.

??? info "How it works"

    These masks can only relax an enabled base policy. They do not hide fields whose admin policy or personal opt-out already permits them.

    The boundary is the first unplayed, nonvirtual episode ordered by season, episode, then sort name, excluding Season 0. In-progress episodes remain eligible; the selection need not match Jellyfin's rewatch-aware Next Up. Only the selected ID gets next-episode reveals. Alternate versions sharing numbering can receive the current-season mask instead.

    Classification requires a positive season number and a present episode number. Missing boundary/numbering or lookup failures give no reveal. Other seasons and specials retain normal policy. Search hints and card score overlays retain separate, stricter rules.

    The boundary is recomputed on the next request after a watched-state change, an episode added, removed or updated, or a change to the viewer's library, channel or parental access (however it was made). Only a change Jellyfin doesn't report (an episode edited straight in its database) waits for the five-minute cache lifetime, and meanwhile an episode can get the reveal of its old category.

    | Setting | Internal property |
    |---|---|
    | **Enable advanced per-category reveals** | `SpoilerAdvancedMode` |
    | **Next episode: keep title hidden** | `SpoilerNextEpisodeStripTitle` |
    | **Next episode: keep description hidden** | `SpoilerNextEpisodeStripOverview` |
    | **Next episode: keep ratings hidden** | `SpoilerNextEpisodeStripRatings` |
    | **Next episode: keep image hidden** | `SpoilerNextEpisodeStripImage` |
    | **Current season: keep titles hidden** | `SpoilerCurrentSeasonStripTitle` |
    | **Current season: keep descriptions hidden** | `SpoilerCurrentSeasonStripOverview` |
    | **Current season: keep ratings hidden** | `SpoilerCurrentSeasonStripRatings` |

## Per-user overrides

You can reveal selected information for your own account while keeping the rest protected. Your choices do not change server-wide policy.

**How to use:**

1. Open **Enhanced Panel** from the sidebar, or **Jellyfin Enhanced** from the user menu.
2. Select **Spoiler Guard**.
3. Under **Show me this even with Spoiler Guard on**, uncheck a category to relax it. Checked categories inherit admin protection.

Changes save immediately. Only admin-enabled categories appear; **Advanced per-category reveals** appears only when advanced mode is on. The inherited defaults below appear checked when their rows are available.

![Personal Spoiler Guard preferences with checked metadata categories, seek previews, advanced reveals, and an unchecked disable-confirmation preference](overrides.webp)

| Setting | Default | What it does |
|---|---|---|
| **TV show descriptions** | Inherit | Uncheck to permit guarded TV show descriptions. |
| **Episode descriptions** | Inherit | Uncheck to permit eligible episode, movie, season, and extra descriptions. |
| **Episode titles** | Inherit | Uncheck to disable episode/eligible season title replacement. Description-driven search fallback can still hide a hint name. |
| **Chapter names** | Inherit | Uncheck to retain names. Images and auxiliary image-path clearing remain separate. |
| **Cast list** | Inherit | Uncheck to stop cast-list filtering; title/description protection can still clear roles. |
| **Ratings** | Inherit | Uncheck to permit community/critic scores and their overlays. |
| **Air date** | Inherit | Uncheck to retain eligible premiere dates. |
| **Taglines** | Inherit | Uncheck to retain eligible taglines. |
| **Tags** | Inherit | Uncheck to retain story tags and overlays governed by tags policy. |
| **Reviews** | Inherit | Uncheck to permit the JE Reviews panel when otherwise available. |
| **Seek previews** | Inherit | Uncheck to see trickplay thumbnails while seeking through an unwatched episode or movie. Appears only while **Hide trickplay seek previews** is on. |
| **Advanced per-category reveals** | Inherit | Uncheck to disable category metadata reveals and the next-episode image exception. |
| **Don't ask me to confirm when turning Spoiler Guard off** | Off | Check to skip confirmation permanently for this account. |

!!! note "Refresh existing content"

    Preference saves do not refresh detail-page images or trigger strict reload. Navigate or reload to update existing content.

??? note "Preference storage and limits"

    Users cannot enable a protection category the admin disabled. **Seek previews** is the only image policy with a per-user override; other image replacement follows admin policy. On a shared address where JE cannot tell which signed-in user fetched a preview, the opt-out applies only when every user whose protection covers the item unchecked **Seek previews**; played-state and saved-progress reveals still follow the first such user. If initial state loading fails, preference controls are disabled to avoid overwriting unknown state.

    Checking a category saves `null` (inherit); unchecking saves `false`. The inherited defaults are nullable. **Don't ask me to confirm when turning Spoiler Guard off** defaults to `false`. These preferences live in `UserSpoilerBlur.Prefs` within `spoilerblur.json`.

    The dialog's **Don't ask again for 15 minutes** is a separate per-account, per-browser local-storage snooze. Unchecking the permanent preference restores confirmation subject to any active snooze.

    | Setting | Internal property |
    |---|---|
    | **TV show descriptions** | `HideSeriesDescriptions` |
    | **Episode descriptions** | `HideEpisodeDescriptions` |
    | **Episode titles** | `ReplaceEpisodeTitles` |
    | **Chapter names** | `HideChapterNames` |
    | **Cast list** | `HideCast` |
    | **Ratings** | `HideRatings` |
    | **Air date** | `HideAirDate` |
    | **Taglines** | `HideTaglines` |
    | **Tags** | `HideTags` |
    | **Reviews** | `HideReviews` |
    | **Seek previews** | `HideTrickplay` |
    | **Advanced per-category reveals** | `UseAdvancedCategories` |
    | **Don't ask me to confirm when turning Spoiler Guard off** | `SkipDisableConfirm` |

## Automatic per-user image identity tags

Image tags help the server apply your account's protection behind proxies or shared networks. No separate Spoiler Guard setting is needed.

**How to use:** Keep the master on and fetch fresh authenticated metadata to obtain updated tags. Your client needs to use the returned image tags.

??? info "How it works"

    When the master is on, recognized authenticated-user DTO responses receive per-user image-tag markers. A client echoing those tags lets the server select the user's policy. Userless API-key responses do not automatically receive a user marker.

    Requests without usable identity may pass through. Ambiguous image requests apply the first scope-matching candidate's played/progress state and exemptions; a **Seek previews** opt-out applies only when every scope-matching candidate made it. Markers are not credentials. See [per-user identity and limits](spoiler-guard-features.md#per-user-isolation).

## Health: spoiler-state corruption recovery

Spoiler Guard stores each account's title lists and preferences in a file. Back up the per-user configuration directory so you can restore protection if that file becomes unreadable.

**How to recover:**

1. Check server logs and the authenticated health endpoint described below.
2. Restore a known-good file or reconfigure your title list and preferences.
3. Reload any web session whose state failed to load.

!!! warning "Unreadable state can stop protection"

    Some reads return empty defaults when state is unreadable. An empty health response does not prove every store is readable. There is no in-UI health banner.

??? note "Storage and corruption handling"

    User state is stored at:

    ```text
    <Jellyfin PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/<user-id-N>/spoilerblur.json
    ```

    The user ID uses 32 hexadecimal characters without hyphens. `Series`, `Movies`, and `Collections` are keyed by item ID; `PendingTmdb` uses `tv:<id>` or `movie:<id>` keys. Entries retain IDs/names and enable/request timestamps, and `Prefs` holds personal choices. Fresh lists are empty.

    Strict Spoiler Guard operations can quarantine an unreadable store as `spoilerblur.json.corrupt-<timestamp>-<suffix>` and return an error. Relevant interactive endpoints record corruption and return HTTP 503 asking you to reconfigure. A quarantine move does not immediately write a replacement defaults file. If moving fails, deletion can be attempted instead.

    Image/metadata filtering and the raw inspection GET use lenient reads that can return empty defaults without quarantine or a health event. Bulk operations can log failures without recording health events.

??? note "Inspecting and acknowledging health events"

    Use authenticated `GET /JellyfinEnhanced/spoiler-blur/health` to inspect recorded events. It returns `healthy` and `corruptionEvents`, with each event's `userId`, `userDisplay`, `at`, and `reason`. Viewers see their own events; admins see all.

    Health retains only the latest recorded event per user in process memory. A server restart clears it.

    `DELETE /JellyfinEnhanced/spoiler-blur/health/{targetUserId}` acknowledges your own event, or any user's event as admin. Acknowledgment clears the event, not backups or protection state.

## Inspection and automation endpoints

Use authenticated endpoints to inspect or automate your protection lists and preferences. They also provide admin actions for existing titles and health events.

**How to use:** Choose a route from the reference below and authenticate with the appropriate user or admin account. Back up current state before replacing a whole file.

!!! warning "Full-state replacement"

    A raw `spoilerblur.json` POST replaces the entire document rather than merging. Omitted lists or preferences can be removed or reset. Back up the current state before using this repair or automation route.

??? note "Endpoint reference"

    All paths below have the prefix `/JellyfinEnhanced` and require authentication. Current-user actions use the token's user identity. An identityless admin credential cannot select a user through those URLs.

    Raw file routes allow self/admin access. Apply-existing/health actions perform their additional admin/self checks inside the actions rather than using a named admin authorization policy.

    | Method and path suffix | Access | Purpose and explicit body limit |
    |---|---|---|
    | GET `/spoiler-blur/series` | Current user | Full `Series`, `Movies`, `Collections`, `PendingTmdb`, and `Prefs` state. No body. |
    | GET `/spoiler-blur/user-prefs` | Current user | Reads preferences. No body. |
    | POST `/spoiler-blur/user-prefs` | Current user | Replaces the preferences object from JSON; 8,192 bytes. |
    | POST `/spoiler-blur/series/{seriesId}` | Current user | Adds a direct Series entry after type/access validation. No body parameter or action-specific body limit. |
    | DELETE `/spoiler-blur/series/{seriesId}` | Current user | Removes the direct Series entry. No body parameter or action-specific body limit. |
    | POST `/spoiler-blur/movies/{movieId}` | Current user | Adds a direct Movie entry after type/access validation. Optional JSON `MovieName`; 8,192 bytes. |
    | DELETE `/spoiler-blur/movies/{movieId}` | Current user | Removes the direct Movie entry. No body parameter or action-specific body limit. |
    | POST `/spoiler-blur/collections/{collectionId}` | Current user | Adds a BoxSet entry after type/access validation. Optional JSON `CollectionName`; 8,192 bytes. |
    | DELETE `/spoiler-blur/collections/{collectionId}` | Current user | Removes the collection entry. No body parameter or action-specific body limit. |
    | POST `/spoiler-blur/pending/{mediaType}/{tmdbId}` | Current user; master on | Adds pending protection or immediately promotes an accessible match. Optional query `displayName`; no body parameter or action-specific body limit. |
    | DELETE `/spoiler-blur/pending/{mediaType}/{tmdbId}` | Current user | Removes pending and matching accessible direct Series/Movie state. No body parameter or action-specific body limit. |
    | GET `/user-settings/{userId}/spoilerblur.json` | Self or Administrator role | Lenient full-state inspection. No body. |
    | POST `/user-settings/{userId}/spoilerblur.json` | Self or Administrator role | Full JSON replacement; 2,097,152 bytes (2 MiB), at most 1,000 entries in each dictionary. |
    | GET `/spoiler-blur/apply-existing/preview?skipStarted=false` | Admin; master on | Saved-scope dry run. No body. |
    | POST `/spoiler-blur/apply-existing?skipStarted=false` | Admin; master on | Starts the registered scheduled task; accepted start returns 202. No body parameter or action-specific body limit. |
    | GET `/spoiler-blur/apply-existing/status` | Admin | Task state, progress, and last-run data. No body. |
    | GET `/spoiler-blur/health` | Viewer: own; admin: all | Recorded process-lifetime events. No body. |
    | DELETE `/spoiler-blur/health/{targetUserId}` | Self or admin | Acknowledges an event. No body parameter or action-specific body limit. |

    “No action-specific body limit” does not mean unlimited server acceptance. Supplied movie/collection display names are sanitized and capped at 200 characters. Direct-entry DELETE does not require the same item lookup as POST and can succeed with `removed=false`. Direct-state and preference actions work even with the master off; pending POST returns 503 when it is off, and apply-existing preview/start return 409.

    Pending media types normalize to `tv`/`movie`; TMDB IDs must be positive 32-bit integers. Pending POST returns `{success, promoted, jellyfinId, name}`, where `promoted` is `pending`, `series`, or `movie`. New pending inserts at the normal 500-entry cap return 429 with `code="pending_cap_exceeded"`; existing entries can still be updated or promoted. Pending DELETE reports `removed`, `removedFrom`, and a resolved Jellyfin ID when applicable; no-op success uses `removed=false, removedFrom="none"`.

    The raw file POST's 1,000-entry-per-dictionary cap differs from normal pending insertion. Exceeding it returns 413. Corrupt existing data can return 503; temporary I/O or save failures can return 500.

## What gets logged

JE logs Spoiler Guard activity so you can investigate automatic protection or storage problems.

**How to use:** Open `JellyfinEnhanced_YYYY-MM-DD.log` in Jellyfin's configured log directory and look for the events below.

??? note "Log events and levels"

    Selected diagnostic warnings are rate-limited; ordinary informational events are not all rate-limited.

    Look for first-play events (`SpoilerAutoEnable`), library-add batches (`SpoilerAutoEnableOnLibraryAdd`), apply-existing per-user/summary results (`SpoilerApplyExisting`), Seerr pending records and promotions (`SpoilerSeerrPromoter`), failed cache evictions, unexpected response shapes, and corruption/quarantine paths.

    Informational events normally use INFO; corruption and unexpected-shape diagnostics use WARNING.
