# Spoiler Mode — Discovery & Architecture Mapping

## Project Architecture

Jellyfin Enhanced (JE) is a **C# Jellyfin plugin** with a **JavaScript frontend** that injects into the Jellyfin Web UI.

- **Backend**: C# (.NET 9.0) — `Jellyfin.Plugin.JellyfinEnhanced/`
- **Frontend**: JavaScript modules — `Jellyfin.Plugin.JellyfinEnhanced/js/`
- **Build**: `dotnet build` → DLL with embedded JS resources
- **Deploy**: Copy DLL to `{JF_PLUGINS_PATH}` → Restart Jellyfin

## Key Directories

| Path | Purpose |
|------|---------|
| `js/enhanced/` | Core features (config, events, playback, UI, hidden-content) |
| `js/jellyseerr/` | Jellyseerr/Seerr integration |
| `js/arr/` | Calendar, requests (*arr integration) |
| `js/tags/` | Quality/genre/language/rating/people tag overlays |
| `js/locales/` | Translation JSON files |
| `Configuration/` | C# models + plugin config page HTML |
| `Controllers/` | Single controller: `JellyfinEnhancedController.cs` |
| `Services/` | Background services (watchlist, auto-request) |

## JS Module Pattern

All modules follow the IIFE pattern:
```javascript
(function(JE) {
    'use strict';
    // Module code...
    JE.initializeModuleName = function() { ... };
})(window.JellyfinEnhanced);
```

**Bootstrap flow** (`plugin.js`):
1. Wait for `ApiClient` and user auth
2. Load plugin config + translations
3. Fetch per-user settings files (settings.json, shortcuts.json, bookmark.json, elsewhere.json, hidden-content.json)
4. Load ALL component scripts via `loadScripts()`
5. Initialize core settings via `JE.loadSettings()`
6. Initialize feature modules conditionally

## Per-User Settings Persistence

- **Server-side**: JSON files per user at `{pluginsPath}/configurations/Jellyfin.Plugin.JellyfinEnhanced/{userId}/{filename}.json`
- **Load**: `GET /JellyfinEnhanced/user-settings/{userId}/{filename}`
- **Save**: `POST /JellyfinEnhanced/user-settings/{userId}/{filename}` (via `JE.saveUserSettings()`)
- **Models**: `Configuration/UserConfiguration.cs` defines C# types
- **Manager**: `Configuration/UserConfigurationManager.cs` handles file I/O
- **The controller already supports arbitrary JSON files** — no backend changes needed for new settings files

## Closest Pattern: Hidden Content (`hidden-content.js`)

The Hidden Content feature is architecturally identical to what Spoiler Mode needs:
- Per-user, per-item data with settings
- Surface filtering (library, discovery, search, calendar, next up, continue watching)
- MutationObserver-based card filtering
- CSS injection via `JE.helpers.addCSS()`
- Debounced save to server
- Public API on `JE.hiddenContent`

**Key difference**: Hidden Content uses `display: none` to completely hide items. Spoiler Mode needs to **show items but redact content** (blur images, replace titles, hide descriptions).

## Hook Points for Spoiler Mode

### 1. Item Detail Page (Series/Season)
- **File**: `features.js:918` — `handleItemDetails()` debounced observer
- **Hook**: Add spoiler toggle button alongside hidden-content button
- **Pattern**: Similar to `addHideContentButton()` at line 730

### 2. Episode List Cards
- **File**: `features.js:976` — MutationObserver on `document.body`
- **Hook**: Intercept card rendering, modify title text, apply blur CSS to thumbnails
- **Selectors**: `.card[data-id]`, `.listItem[data-id]`

### 3. Home Sections (Next Up, Continue Watching, etc.)
- **File**: `hidden-content.js:1163` — `getCardSurface()` detects section type
- **Hook**: Same card-level redaction as episode list, applied in home section context
- **Surface detection**: Check section title text for "Next Up", "Continue Watching", "Recently Added"

### 4. Search Results
- **File**: `hidden-content.js:1223` — `getCurrentNativeSurface()` detects search page
- **Hook**: Filter/redact episode results in search

### 5. Player Overlay (OSD)
- **File**: `playback.js` — video player controls
- **Hook**: Intercept OSD title display, chapter list rendering
- **Selectors**: `.videoOsdBottom`, `.osdTitle`, chapter markers

### 6. Jellyseerr Discovery
- **File**: `hidden-content.js:1952` — `filterJellyseerrResults()` pattern
- **Hook**: Could apply similar redaction to Jellyseerr results (lower priority)

### 7. Calendar
- **File**: `hidden-content.js:1967` — `filterCalendarEvents()` pattern
- **Hook**: Redact episode titles in calendar events

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| DOM mutations from Jellyfin core break selectors | Use generic selectors, data attributes; test across pages |
| Race condition: cards render before spoiler data loads | Use MutationObserver pattern; re-scan on data load |
| Performance: too many API calls for boundary computation | Cache UserData aggressively; batch API calls |
| Stale boundary data after watching | Listen for playback events; invalidate cache |
| Spoiler leak during initial page load | Apply CSS blur immediately; refine after data loads |

## Build & Deploy

```bash
# Build
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj

# Deploy (copy DLL to plugins)
cp Jellyfin.Plugin.JellyfinEnhanced/bin/Debug/net9.0/Jellyfin.Plugin.JellyfinEnhanced.dll \
   "$JF_PLUGINS_PATH/Jellyfin.Plugin.JellyfinEnhanced/"

# Restart
docker restart "$JF_DOCKER_CONTAINER"
```
