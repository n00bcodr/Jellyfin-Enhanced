# Enhanced Features

Core Jellyfin Enhanced features including playback controls, UI enhancements, visual tags, and bookmarks.

![Enhanced Panel](images/panel_jellyfish.gif)

## Table of Contents

- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Playback Settings](#playback-settings)
- [Auto-Skip Settings](#auto-skip-settings)
- [Subtitle Settings](#subtitle-settings)
- [Random Button](#random-button)
- [UI Settings](#ui-settings)
- [Visual Tags](#visual-tags)
- [Bookmarks](#bookmarks)
- [Custom Styling](#custom-styling)
- [Admin Configuration](#admin-configuration)

---

## Keyboard Shortcuts

Comprehensive keyboard shortcuts for navigation, playback control, and more.

![Shortcuts](images/shortcuts.png)

### Default Shortcuts

**Global Shortcuts:**
- `/` - Open Search
- `Shift+H` - Go to Home
- `D` - Go to Dashboard
- `Q` - Quick Connect
- `R` - Play Random Item

**Player Shortcuts:**
- `A` - Cycle Aspect Ratio
- `I` - Show Playback Info
- `S` - Subtitle Menu
- `C` - Cycle Subtitle Tracks
- `V` - Cycle Audio Tracks
- `+` - Increase Playback Speed
- `-` - Decrease Playback Speed
- `R` - Reset Playback Speed (in player context)
- `B` - Bookmark Current Time
- `P` - Open Episode Preview
- `O` - Skip Intro/Outro

### Customizing Shortcuts

1. Open Enhanced panel (press `?` or click sidebar menu)
2. Go to **Shortcuts** tab
3. Click on any key to set a custom shortcut
4. Use modifier keys: `Shift+`, `Ctrl+`, `Alt+`
5. Changes save automatically

**Examples:**
- `Shift+A` - Shift + A key
- `Ctrl+S` - Control + S key
- `Alt+P` - Alt + P key

### Admin: Server-Wide Shortcut Overrides

Administrators can set server-wide default shortcut mappings.

**Configure:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Enhanced Settings** tab
3. Find **Shortcut Overrides** section
4. Select a shortcut from dropdown
5. Enter new key combination
6. Click **Add Override**
7. Click **Save**

**Features:**
- Override default shortcut keys server-wide
- Users can still customize individually
- Prevents conflicts by validating keys
- Remove overrides anytime

### Disabling Shortcuts

To disable all keyboard shortcuts:

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Check "Disable Keyboard Shortcuts"
3. Click **Save**

---

## Playback Settings

Smart playback features for better viewing experience.

### Auto-Pause on Tab Switch

Automatically pause video when switching browser tabs.

**Enable:**
- Open Enhanced panel → Settings
- Check "Auto-pause on tab switch"

**Use Case:** Prevents video from playing in background when you switch tabs.

### Auto-Resume on Tab Switch

Automatically resume video when returning to Jellyfin tab.

**Enable:**
- Open Enhanced panel → Settings
- Check "Auto-resume on tab switch"

**Use Case:** Seamlessly continue watching when you return.

### Auto Picture-in-Picture

Automatically enter Picture-in-Picture mode when switching tabs.

**Enable:**
- Open Enhanced panel → Settings
- Check "Auto Picture-in-Picture on tab switch"

**Use Case:** Keep watching while browsing other tabs.

### Long Press for 2x Speed

Hold down to play at 2x speed, release to return to normal.

**Enable:**
- Open Enhanced panel → Settings
- Check "Long press/hold for 2x speed"

**Use Case:** Quickly skip through slow scenes.

### Custom Pause Screen

Beautiful overlay with media info when you pause.

![Pause Screen](images/pausescreen.png)

**Note:** This is a modified version of [BobHasNoSoul's Pause Screen](https://github.com/BobHasNoSoul/Jellyfin-PauseScreen).

**Features:**
- Media title and logo
- Year, rating, runtime
- Plot/description
- Current progress with time remaining
- Spinning disc animation
- Blurred backdrop

**Enable:**
- Open Enhanced panel → Settings
- Check "Enable Custom Pause Screen"

**Customization:**
See [Custom Styling](#pause-screen-css) section below.

---

## Auto-Skip Settings

Automatically skip intros and outros for seamless binge-watching.

**Requirements:**
- [Intro Skipper plugin](https://github.com/intro-skipper/intro-skipper) installed
- Intro/outro segments detected for your media

### Auto-Skip Intro

Automatically skip intro sequences.

**Enable:**
- Open Enhanced panel → Settings
- Check "Auto-skip Intro"

### Auto-Skip Outro

Automatically skip outro/credits.

**Enable:**
- Open Enhanced panel → Settings
- Check "Auto-skip Outro"

---

## Subtitle Settings

Customize subtitle appearance with presets.

### Subtitle Styles

Choose from predefined subtitle styles:

- **Clean White** - Simple white text
- **Classic Black Box** - Black background box
- **Netflix Style** - Netflix-inspired styling
- **Cinema Yellow** - Yellow text for cinema feel
- **Soft Gray** - Subtle gray text
- **High Contrast** - Maximum readability

### Subtitle Sizes

- Tiny
- Small
- Normal (default)
- Large
- Extra Large
- Gigantic

### Subtitle Fonts

- Default
- Noto Sans
- Sans Serif
- Typewriter
- Roboto

### Configuration

1. Open Enhanced panel → Settings
2. Find Subtitle Settings section
3. Select your preferred style, size, and font
4. Changes apply immediately during playback

### Disable Custom Styles

To use Jellyfin's default subtitle styling:

1. Open Enhanced panel → Settings
2. Check "Disable Custom Subtitle Styles by default"

---

## Random Button

Discover content in your library with a single click.

### Features

- Random item selection from your library
- Filter by movies, shows, or both
- Unwatched only option
- Quick access button

### Configuration

**Enable Random Button:**
1. Open Enhanced panel → Settings
2. Check "Enable Random Button"

**Filter Options:**
- **Include movies** - Include movies in random selection
- **Include shows** - Include TV shows in random selection
- **Unwatched only** - Only show unwatched content

---

## UI Settings

Visual enhancements and information display options.

### Watch Progress

Display watch progress on media cards.

**Enable:**
- Open Enhanced panel → Settings
- Check "Show watch progress"

**Display Modes:**
- **Percentage** - Show as percentage (e.g., "45%")
- **Time** - Show as time remaining

**Time Formats:**
- **h:m** - Hours and minutes (e.g., "2h 30m")
- **y:mo:d:h:m** - Full format with years, months, days

**Admin: Server-Wide Defaults**

Administrators can configure default watch progress settings for all users.

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Enhanced Settings** tab
3. Find **UI Settings** section
4. Configure:
   - **Watch Progress Default Mode** (Percentage or Time)
   - **Watch Progress Time Format** (h:m or y:mo:d:h:m)
5. Click **Save**

Users can override these defaults in their Enhanced panel.

### File Sizes

Display total file size on item detail pages.

**Enable:**
- Open Enhanced panel → Settings
- Check "Show file sizes"

### Audio Languages

Show available audio languages with country flags on item detail pages.

**Enable:**
- Open Enhanced panel → Settings
- Check "Show available audio languages on item detail page"

### Remove from Continue Watching

Add button to remove items from Continue Watching section.

**Enable:**
- Open Enhanced panel → Settings
- Check "Enable 'Remove from Continue Watching'"

**Warning:** This resets playback progress to zero and cannot be undone.

---

## Visual Tags

Display quality, genre, language, rating, and people information directly on posters and detail pages.

### Quality Tags

Display media quality information (4K, HDR, Atmos) on posters.

![Quality Tags Example](images/panel.gif)

**Supported Tags:**
- **Resolution:** 8K, 4K, 1080p, 720p, 480p, LOW-RES
- **Video Format:** AV1, HEVC, H265, VP9, H264
- **Video Features:** HDR, Dolby Vision, HDR10+, 3D
- **Audio:** ATMOS, DTS-X, TRUEHD, DTS, Dolby Digital+, 7.1, 5.1

**Enable:**
1. Open Enhanced panel → Settings
2. Check "Enable Quality Tags"
3. Select position (top-left, top-right, bottom-left, bottom-right)

**Note:** This is a modified version of [BobHasNoSoul's Quality Tags](https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/).

### Genre Tags

Identify genres with themed icons on posters.

**Features:**
- Material Design icons for each genre
- Circular badges that expand on hover
- Show up to 3 genres per item

**Enable:**
1. Open Enhanced panel → Settings
2. Check "Enable Genre Tags"
3. Select position

### Language Tags

Display available audio languages as country flags on posters.

**Features:**
- Country flag icons from flagcdn.com
- Show up to 3 unique languages
- Also displays on item detail pages

**Enable:**
1. Open Enhanced panel → Settings
2. Check "Enable Language Tags"
3. Select position

### Rating Tags

Show TMDB and Rotten Tomatoes ratings on posters.

![Ratings](images/ratings.png)

**Features:**
- TMDB star ratings
- Rotten Tomatoes critic scores (fresh/rotten icons)
- Stacked vertically on posters
- Optional OSD display during playback

**Enable:**
1. Open Enhanced panel → Settings
2. Check "Enable Rating Tags"
3. Select position
4. Optional: Check "Show Rating in Video Player"

### People Tags

Display age and birthplace information for cast members.

**Features:**
- Current age or age at death
- Age at item release
- Birthplace with country flag
- Deceased indicator (grayscale + cross)

**Enable:**
1. Open Enhanced panel → Settings
2. Check "Enable People Tags"

### Tag Cache Settings

**Cache Duration:**
- Default: 30 days
- Range: 1-365 days
- Applies to all tag types

**Clear Cache:**
- Click "Clear All Client Caches" button
- Forces all clients to re-fetch tag data
- May cause slowness on first load after clearing

### Disable Tags on Search Page

Prevent tags from showing on search results (recommended for Gelato plugin compatibility).

**Enable:**
- Open Enhanced panel → Settings
- Check "Disable Tags on Search Page"

---

## Bookmarks

Save custom timestamps while watching videos to quickly jump back to favorite scenes.

### Features

- Create bookmarks during playback with `B` key
- Visual markers on video timeline
- Add custom labels to bookmarks
- Sync bookmarks across duplicate items (same TMDB/TVDB ID)
- Manage all bookmarks from dedicated interface
- Export/import bookmark data

### Creating Bookmarks

**During Playback:**
1. Press `B` at any moment
2. Add an optional label (e.g., "Epic scene")
3. Bookmark appears as marker on timeline
4. Click marker to jump to that timestamp

### Bookmark Management

Access via [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) or [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) (requires respective plugins).

**Features:**
- View all bookmarks across library
- Clean up orphaned bookmarks
- Detect and merge duplicates
- Adjust time offsets for synced bookmarks
- Filter by movies or TV shows
- Search bookmarks

### Configuration

**Enable Bookmarks:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Check "Enable Bookmarks Feature"
3. Click **Save**

**Use Plugin Pages:**
1. Install [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)
2. Check "Use Plugin Pages for Bookmarks Library"
3. Restart Jellyfin server
4. "Bookmarks" link appears in sidebar

---

## Admin Configuration

### applying Default Settings to All Users

Administrators can apply default settings to all users at once.

**How to Use:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Configure all desired default settings (playback, UI, tags, etc.)
3. Click **"Apply Above Settings to All Users"** button
4. Confirm the action

**What This Does:**
- Overrides all user settings with configured defaults
- Applies to playback settings, UI preferences, tags, bookmarks enabled/disabled
- Users can still change settings individually afterward
- Useful for resetting all users to a known configuration

**What's NOT Affected:**
- Individual user bookmarks
- User shortcut customizations (unless cleared separately)
- Hidden content items

**Use Cases:**
- Initial server setup with desired defaults
- Fixing issues by resetting all users
- Standardizing experience across accounts