# Spoiler Mode — Design Document

## Data Model

Per user, stored as `spoiler-mode.json`:

```json
{
  "rules": {
    "<itemId>": {
      "itemId": "abc123",
      "itemName": "Breaking Bad",
      "itemType": "Series",
      "enabled": true,
      "preset": "balanced",
      "boundaryOverride": null,
      "enabledAt": "2024-01-01T00:00:00Z"
    }
  },
  "settings": {
    "preset": "balanced",
    "watchedThreshold": "played",
    "boundaryRule": "showOnlyWatched",
    "artworkPolicy": "blur",
    "protectHome": true,
    "protectSearch": true,
    "protectOverlay": true,
    "protectCalendar": true,
    "protectRecentlyAdded": true,
    "hideRuntime": false,
    "hideAirDate": false,
    "hideGuestStars": false,
    "revealDuration": 10,
    "showSeriesOverview": false
  },
  "tagAutoEnable": [],
  "autoEnableOnFirstPlay": false
}
```

## Presets

| Setting | Balanced | Strict |
|---------|----------|--------|
| artworkPolicy | blur | generic |
| protectHome | true | true |
| protectSearch | true | true |
| protectOverlay | true | true |
| protectCalendar | true | true |
| hideRuntime | false | true |
| hideAirDate | false | true |
| hideGuestStars | false | true |
| showSeriesOverview | false | false |

## Boundary Logic

For TV series:
1. Fetch all episodes with UserData for the series
2. Find the last episode where `UserData.Played === true` (or `PlayedPercentage >= threshold`)
3. That episode is the "boundary"
4. Episodes at or before boundary: show normally
5. Episodes after boundary: redact

For movies:
- No boundary (binary: on/off)
- When enabled: hide overview, blur backdrop, redact similar items in strict mode

## Redaction Rules

### Unwatched Episodes
- Title → `S{season}E{episode}` (e.g., "S02E03")
- Thumbnail → CSS blur filter (15px gaussian)
- Overview → "Hidden until watched"
- Runtime → hidden (if strict)
- Air date → hidden (if strict)

### Edge Cases
- Specials with no IndexNumber → "Special 01" (auto-numbered)
- Multi-episode files → "S01E01-E02"
- Season with no episodes watched → blur season artwork, show "Season N"

### Detail Page
- Series title: always visible
- Series overview: hidden by default, tap to reveal
- Cast list: visible by default; guest stars hidden in strict mode
- Backdrop: blurred in strict mode

## Reveal Controls

1. **Tap-to-reveal**: Click/tap on a redacted field → show for 10s → auto-hide
2. **Press-and-hold**: Long-press on a redacted field → reveal while held
3. **Reveal all (30s)**: Button on detail page → reveals all spoilers for 30 seconds

## Surfaces

1. **Episode list** (series/season detail page)
2. **Home sections** (Next Up, Continue Watching, Recently Added, Upcoming)
3. **Search results** (episode title/thumbnail)
4. **Player overlay** (OSD title, chapter names, preview thumbnails)
5. **Calendar** (episode titles)

## Implementation Slices

### Slice 1: Settings + Storage + Per-Item Toggle
- Add `spoiler-mode.json` fetch in `plugin.js`
- Create `spoiler-mode.js` with data model, settings API
- Add toggle button on series/movie detail pages
- Settings panel tab with preset selection

### Slice 2: Boundary + Episode List Redaction
- Boundary computation from Jellyfin UserData API
- Episode list card redaction (title, thumbnail, overview)
- Edge cases (specials, multi-episode)

### Slice 3: Home Sections
- Next Up, Continue Watching redaction
- Recently Added, Upcoming redaction
- Calendar event redaction

### Slice 4: Search
- Search result episode redaction

### Slice 5: Player Overlay + Reveal Controls
- OSD title redaction
- Chapter name redaction
- Reveal controls (tap, hold, 30s button)

### Slice 6: Auto-Enable
- Tag-based auto-enable
- First-play auto-enable

### Slice 7: Polish
- Presets (Balanced/Strict/Custom)
- Per-surface toggles
- UI polish
