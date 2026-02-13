## Project Structure

The plugin architecture uses a single entry point (`plugin.js`) that dynamically loads all other feature components.

### File Structure

All client-side scripts are now located in the `Jellyfin.Plugin.JellyfinEnhanced/js/` directory.

```

Jellyfin.Plugin.JellyfinEnhanced/
└── js/
    ├── locales/
    │   ├── da.json
    │   ├── de.json
    │   ├── en.json
    │   ├── es.json
    │   ├── fr.json
    │   ├── hu.json
    │   ├── it.json
    │   ├── pr.json
    │   ├── pt.json
    │   ├── ru.json
    │   ├── sv.json
    │   └── tr.json
    ├── enhanced/
    │   ├── bookmarks.js
    │   ├── bookmarks-library.js
    │   ├── config.js
    │   ├── events.js
    │   ├── features.js
    │   ├── helpers.js
    │   ├── icons.js
    │   ├── osd-rating.js
    │   ├── playback.js
    │   ├── subtitles.js
    │   ├── themer.js
    │   └── ui.js
    ├── extras/
    │   ├── colored-activity-icons.js
    │   ├── colored-ratings.js
    │   ├── login-image.js
    │   ├── plugin-icons.js
    │   └── theme-selector.js
    ├── jellyseerr/
    │   ├── api.js
    │   ├── discovery-filter-utils.js
    │   ├── genre-discovery.js
    │   ├── issue-reporter.js
    │   ├── item-details.js
    │   ├── jellyseerr.js
    │   ├── modal.js
    │   ├── more-info-modal.js
    │   ├── network-discovery.js
    │   ├── person-discovery.js
    │   ├── request-manager.js
    │   ├── seamless-scroll.js
    │   ├── tag-discovery.js
    │   └── ui.js
    ├── arr/
    │   ├── arr-links.js
    │   ├── arr-tag-links.js
    │   ├── calendar-page.js
    │   ├── calendar-custom-tab.js
    │   ├── requests-page.js
    │   └── requests-custom-tab.js
    ├── elsewhere/
    │   ├── elsewhere.js
    │   └── reviews.js
    ├── enhanced/
    │   ├── bookmarks.js
    │   ├── bookmarks-library.js
    │   ├── config.js
    │   ├── events.js
    │   ├── features.js
    │   ├── helpers.js
    │   ├── icons.js
    │   ├── osd-rating.js
    │   ├── pausescreen.js
    │   ├── playback.js
    │   ├── subtitles.js
    │   ├── themer.js
    │   └── ui.js
    ├── extras/
    │   ├── colored-activity-icons.js
    │   ├── colored-ratings.js
    │   ├── login-image.js
    │   ├── plugin-icons.js
    │   └── theme-selector.js
    ├── others/
    │   ├── letterboxd-links.js
    │   └── splashscreen.js
    ├── tags/
    │   ├── genretags.js
    │   ├── languagetags.js
    │   ├── peopletags.js
    │   ├── qualitytags.js
    │   └── ratingtags.js
    └── plugin.js
```


### Component Breakdown

* **`plugin.js`**: The main entry point. It loads the plugin configuration and translations, then dynamically injects all other component scripts.

* **`/enhanced/`**: Contains the core components of the "Jellyfin Enhanced" feature set.
    * **`bookmarks.js`**: Manages video bookmarks/timestamps during playback. Handles bookmark creation (via `B` key), displays visual markers on the video timeline, and provides quick navigation to saved timestamps.
    * **`bookmarks-library.js`**: Provides a comprehensive bookmark management interface accessible via Custom Tabs. Allows users to view all bookmarks across movies and TV shows, cleanup orphaned bookmarks, detect duplicates, and adjust time offsets for synced bookmarks.
    * **`config.js`**: Manages all settings, both from the plugin backend and the user's local storage. It initializes and holds shared variables and configurations that other components access.
    * **`events.js`**: The active hub of the plugin. It listens for user input (keyboard/mouse), browser events (tab switching), and DOM changes to trigger the appropriate functions from other components.
    * **`features.js`**: Contains the logic for non-playback enhancements like the random item button, file size display, audio language display, and "Remove from Continue Watching".
    * **`helpers.js`**: Provides utility functions and helper methods used across the enhanced components for common tasks like DOM manipulation and data processing.
    * **`icons.js`**: Manages icon selection and rendering logic, allowing users to choose between emoji and Lucide icons throughout the interface.
    * **`osd-rating.js`**: Displays TMDB and Rotten Tomatoes ratings in the video player OSD controls next to the time display.
    * **`pausescreen.js`**: Displays a custom, informative overlay when a video is paused.
    * **`playback.js`**: Centralizes all functions that directly control the video player, such as changing speed, seeking, cycling through tracks, and auto-skip logic.
    * **`subtitles.js`**: Isolates all logic related to subtitle styling, including presets and the function that applies styles to the video player.
    * **`themer.js`**: Handles theme detection and applies appropriate styling to the Enhanced Panel based on the active Jellyfin theme.
    * **`ui.js`**: Responsible for creating, injecting, and managing all visual elements like the main settings panel, toast notifications, and various buttons.

* **`/elsewhere/`**: Contains scripts for discovering media on other streaming services and reviews.
    * **`elsewhere.js`**: Powers the "Jellyfin Elsewhere" feature for finding media on other streaming services.
    * **`reviews.js`**: Adds a section for TMDB user reviews on item detail pages.

* **`/extras/`**: Contains optional personal scripts that extend functionality with additional features.
    * **`colored-activity-icons.js`**: Replaces default activity icons with Material Design icons and applies custom colors for better visual distinction.
    * **`colored-ratings.js`**: Applies color-coded backgrounds to media ratings on item detail pages based on rating type and value.
    * **`login-image.js`**: Displays user profile images instead of text on manual login page
    * **`plugin-icons.js`**: Replaces default plugin icons with custom Material Design icons on the dashboard for improved aesthetics and also adds the ability to add custom plugin config page links
    * **`theme-selector.js`**: Provides options to quickly choose form Jellyfish color Pallete and an option to load random theme everyday.

* **`/jellyseerr/`**: This directory contains all components related to the Jellyseerr integration.
    * **`api.js`**: Handles all direct communication with the Jellyseerr proxy endpoints on the Jellyfin server.
    * **`discovery-filter-utils.js`**: Provides shared utility functions for all discovery modules, including content type filtering (TV/Movies/All), pagination management, card creation with deduplication, and infinite scroll handling. Manages filter state persistence via localStorage.
    * **`genre-discovery.js`**: Provides genre-based media discovery with TV/Movies/All content type filtering, allowing users to browse and request content filtered by specific genres from Jellyseerr with separate pagination tracking per content type.
    * **`issue-reporter.js`**: Provides the issue reporting interface for Jellyseerr, allowing users to report problems with media items directly from Jellyfin.
    * **`item-details.js`**: Manages Jellyseerr-specific details displayed on item detail pages, including request status, availability information, similar and recommended content with library/rejected item exclusion options.
    * **`jellyseerr.js`**: The main controller for the integration, orchestrating the other components and managing state.
    * **`modal.js`**: A dedicated component for creating and managing the advanced request modals.
    * **`more-info-modal.js`**: Displays detailed information about media items from Jellyseerr, including cast, crew, and extended metadata.
    * **`network-discovery.js`**: Enables network-based discovery with TV/Movies/All filtering, allowing users to browse content from specific TV networks or streaming services available in Jellyseerr with separate pagination per content type.
    * **`person-discovery.js`**: Facilitates person-based discovery with TV/Movies/All filtering, letting users explore media featuring specific actors, directors, or crew members from Jellyseerr with independent pagination tracking.
    * **`request-manager.js`**: Provides centralized request management with concurrency control (max 6 concurrent requests), automatic retry logic (3 attempts with exponential backoff), response caching (5-minute TTL), request deduplication, and AbortController support for cancellation.
    * **`seamless-scroll.js`**: Implements enhanced infinite scroll with prefetch (~2 viewport heights), deduplication, exponential backoff retry logic, and scroll event fallback. Provides reusable utilities for all discovery modules.
    * **`tag-discovery.js`**: Implements tag-based content discovery with TV/Movies/All filtering, enabling users to find and request media based on custom tags and categories in Jellyseerr with separate page tracking per content type.
    * **`ui.js`**: Manages all visual elements of the integration, like result cards, request buttons, and status icons.

* **`/arr/`**: Contains components for Sonarr and Radarr integration.
    * **`arr-links.js`**: Adds convenient links to Sonarr, Radarr, and Bazarr on item detail pages only for administrators.
    * **`arr-tag-links.js`**: Displays synced *arr tags as clickable links on item detail pages, with advanced filtering options to show only specific tags or hide unwanted ones.
    * **`calendar-page.js`**: Adds a calendar button in the sidebar which opens a view that shows the calendar of upcoming items from Radarr and Sonarr
    * **`calendar-custom-tab.js`**: Creates `<div class="jellyfinenhanced calendar"></div>` for CustomTabs plugin
    * **`requests-page.js`**: Adds a Requests button in the sidebar which opens a view that shows requests and download status from the arrs and Jellyseerr
    * **`requests-custom-tab.js`**: Creates `<div class="jellyfinenhanced requests"></div>` for CustomTabs plugin

* **`/tags/`**: Contains components for displaying various tag information directly on media posters.
    * **`genretags.js`**: Manages the display of media genre information as tags directly on the posters.
    * **`languagetags.js`**: Manages the display of audio language information as flag icons directly on the posters.
    * **`peopletags.js`**: Displays age and birthplace information for cast members with country flags, deceased indicators, and caching. Works with both regular cast and guest cast sections.
    * **`qualitytags.js`**: Manages the display of media quality information (like 4K, HDR, and Atmos) as tags directly on the posters.
    * **`ratingtags.js`**: Manages the display of TMDB and Rotten Tomatoes ratings as badges directly on the posters.

* **`/others/`**: Contains miscellaneous utility scripts.
    * **`letterboxd-links.js`**: Adds Letterboxd external links to movie item detail pages.
    * **`splashscreen.js`**: Manages the custom splash screen that appears when the application is loading.

