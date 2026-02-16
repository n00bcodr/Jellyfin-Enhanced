# Spoiler Mode — Testing Runbook

## Prerequisites

- Jellyfin dev instance running at `http://localhost:8097`
- Admin user with access to at least one TV series with partial watch progress
- Plugin built and deployed (see Build & Deploy below)

## Build & Deploy

```bash
# Build
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj

# Copy DLL to plugin directory
cp Jellyfin.Plugin.JellyfinEnhanced/bin/Debug/net9.0/Jellyfin.Plugin.JellyfinEnhanced.dll \
   "/path/to/jellyfin/config/data/plugins/Jellyfin Enhanced_10.11.0.0/"

# Restart Jellyfin
docker restart jellyfin-dev

# Verify health (wait ~25 seconds for startup)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8097/health
# Expected: 200
```

## Test Matrix

### T1: Per-Item Toggle

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a series detail page | Series page loads normally |
| 2 | Look for the shield toggle button near the title | Button appears with tooltip "Enable Spoiler Mode" |
| 3 | Click the toggle button | Toast: "Spoiler Mode enabled for {series name}" |
| 4 | Verify unwatched episodes are redacted | Titles show "S01E05" format, thumbnails blurred, overviews hidden |
| 5 | Click toggle again | Toast: "Spoiler Mode disabled for {series name}" |
| 6 | Verify episodes return to normal | Original titles, thumbnails, overviews visible |

### T2: Boundary Computation

| Step | Action | Expected |
|------|--------|----------|
| 1 | Watch S01E01-E04 of a series, leave E05+ unwatched | UserData shows Played=true for E01-E04 |
| 2 | Enable Spoiler Mode for the series | Boundary set at S01E04 |
| 3 | Check E01-E04 on episode list | Shown normally (not redacted) |
| 4 | Check E05+ on episode list | Redacted: titles as "S01E05", thumbnails blurred |
| 5 | Mark E05 as watched (via Jellyfin) | After cache TTL (5 min) or page refresh, boundary moves to E05 |
| 6 | Verify E05 now shows normally, E06+ still redacted | Boundary updated correctly |

### T3: Specials (Season 0) Handling

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a series with specials that has Spoiler Mode enabled | Season 0 / Specials section visible |
| 2 | Check an unwatched special | Redacted based on individual Played status (not series boundary) |
| 3 | Check a watched special | Shown normally |
| 4 | Verify specials are excluded from boundary computation | Boundary only considers regular season episodes |

### T4: Settings Panel — Presets

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open JE settings panel (gear icon) | Settings panel opens |
| 2 | Find "Spoiler Mode" section | Accordion section with shield icon |
| 3 | Expand the section | Preset dropdown, surface toggles, auto-enable toggle visible |
| 4 | Select "Strict" preset | Settings saved; thumbnails use generic tiles, runtime/air date hidden |
| 5 | Select "Balanced" preset | Settings saved; thumbnails blurred, runtime/air date visible |

### T5: Per-Surface Toggles

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for a series | Series is protected |
| 2 | Navigate to Home | Protected episodes in Next Up / Continue Watching are redacted |
| 3 | Disable "Protect Home Sections" in settings | Home episodes no longer redacted |
| 4 | Re-enable "Protect Home Sections" | Home episodes redacted again |
| 5 | Repeat for Search, Overlay, Calendar toggles | Each toggle independently controls its surface |

### T6: Home Sections Redaction

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for a series with Next Up items | Next Up section exists on Home |
| 2 | Check Next Up card for the series | Episode card is redacted (title, thumbnail, overview) |
| 3 | Check Continue Watching section | Protected episodes redacted |
| 4 | Check Recently Added section | Protected episodes redacted |
| 5 | Navigate away and back to Home | Redaction persists after re-render |

### T7: Search Results Redaction

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for a series | Series protected |
| 2 | Search for an unwatched episode of that series by name | Episode appears in search results |
| 3 | Verify search result is redacted | Title shows "S01E05" format, thumbnail blurred |
| 4 | Search for a watched episode | Shows normally (not redacted) |

### T8: Player Overlay Redaction

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for a series | Series protected |
| 2 | Play an unwatched episode | Player starts |
| 3 | Hover to show player overlay (OSD) | Episode title in OSD is redacted |
| 4 | Check chapter names (if any) | Chapter names are redacted |
| 5 | Play a watched episode | OSD shows normal title |

### T9: Calendar Redaction

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for a series with upcoming episodes | Calendar shows future episodes |
| 2 | Navigate to Calendar page | Calendar renders |
| 3 | Check protected series' events | Episode titles redacted in calendar cells |
| 4 | Check unprotected series' events | Normal titles shown |

### T10: Reveal Controls

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a protected series' episode list | Redacted episodes visible |
| 2 | Click on a redacted episode title | Title revealed for 10 seconds, then auto-hides |
| 3 | Click on a redacted thumbnail | Thumbnail unblurs for 10 seconds, then re-blurs |
| 4 | Find "Reveal (30s)" button on detail page | Button visible |
| 5 | Click "Reveal (30s)" | All spoilers on page revealed for 30 seconds |
| 6 | Wait 30 seconds | All spoilers re-hidden automatically |

### T11: Auto-Enable on First Play

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable "Auto-Enable on First Play" in settings | Toggle checked |
| 2 | Find a series with NO watch history | Series not in spoiler rules |
| 3 | Start playing S01E01 of that series | Playback starts |
| 4 | Stop playback and check spoiler rules | Series automatically added with Spoiler Mode enabled |
| 5 | Verify toast notification | "Spoiler Mode enabled for {series name}" |

### T12: Tag-Based Auto-Enable

| Step | Action | Expected |
|------|--------|----------|
| 1 | Add a tag (e.g., "spoiler-protect") to a series in Jellyfin | Tag saved on series metadata |
| 2 | Add "spoiler-protect" to `tagAutoEnable` array in spoiler-mode.json | Config saved |
| 3 | Start playing an episode of that series | Playback triggers auto-enable check |
| 4 | Verify Spoiler Mode enabled for the series | Rule created with enabled=true |

### T13: Persistence Across Sessions

| Step | Action | Expected |
|------|--------|----------|
| 1 | Enable Spoiler Mode for 2+ series, change preset to Strict | Settings saved |
| 2 | Hard-refresh the browser (Ctrl+Shift+R) | Page fully reloads |
| 3 | Navigate to a protected series | Episodes still redacted |
| 4 | Open settings panel | Preset shows "Strict", toggles match saved state |
| 5 | Check protected count | Shows correct number of protected items |

### T14: Edge Cases

| Step | Action | Expected |
|------|--------|----------|
| 1 | Series with 0 watched episodes | All episodes redacted (no boundary) |
| 2 | Series with ALL episodes watched | No episodes redacted (everything at or before boundary) |
| 3 | Series with only specials | Specials checked individually, boundary N/A |
| 4 | Movie with Spoiler Mode enabled | Overview hidden, backdrop blurred (no episode-based boundary) |
| 5 | Episode card without data attributes | Falls back to card link URL parsing |
| 6 | Rapid toggle on/off | State consistent, no flickering or stale redaction |

## API Verification

Verify spoiler mode data is persisted correctly:

```bash
# Fetch user's spoiler mode config
curl -s "http://localhost:8097/JellyfinEnhanced/user-settings/{userId}/spoiler-mode.json" \
  -H "X-Emby-Token: {apiKey}" | python3 -m json.tool

# Expected structure:
# {
#   "rules": { ... },
#   "settings": { "preset": "balanced", ... },
#   "tagAutoEnable": [],
#   "autoEnableOnFirstPlay": false
# }
```

## JS Console Verification

Open browser DevTools console and verify:

```javascript
// Check spoiler mode is initialized
JellyfinEnhanced.spoilerMode
// Expected: object with all public methods

// Check protected items
JellyfinEnhanced.spoilerMode.getSpoilerData().rules
// Expected: object with itemId keys

// Check current settings
JellyfinEnhanced.spoilerMode.getSettings()
// Expected: { preset: "balanced", protectHome: true, ... }

// Test boundary computation for a series
JellyfinEnhanced.spoilerMode.computeBoundary("seriesItemId")
// Expected: Promise resolving to { season: N, episode: M, episodeId: "..." }

// Check if specific item is protected
JellyfinEnhanced.spoilerMode.isProtected("itemId")
// Expected: true/false
```

## Known Limitations

1. **Boundary cache TTL**: After marking an episode as watched, redaction updates within 5 minutes (cache expiry)
2. **DOM-based detection**: Cards without `data-id` or `data-itemid` attributes fall back to URL parsing from card links
3. **Player overlay**: Requires OSD to be visible; chapter redaction depends on chapter markers existing in media
4. **Tag auto-enable**: Requires playing an episode to trigger the check; does not scan library proactively
5. **Multi-user**: Each user has independent spoiler-mode.json; no admin override
