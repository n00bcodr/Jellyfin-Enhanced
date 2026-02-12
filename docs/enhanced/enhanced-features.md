# Features Guide

Jellyfin Enhanced bundles dozens of features into one convenient plugin. This guide covers all available features and how to use them.

![Enhanced Panel](/docs/images/panel.gif)

## Table of Contents

- [Playback & Controls](#playback-controls)
- [Discovery & Integration](#discovery-integration)
- [Visual Enhancements](#visual-enhancements)
- [Personal Scripts](#personal-scripts)
- [Customization](#customization)

---

## Playback & Controls

### ⌨️ Advanced Keyboard Shortcuts

Comprehensive hotkeys for navigation, playback control, and more.

![Shortcuts](images/shortcuts.png)

**Default Shortcuts:**
- `Space` - Play/Pause
- `F` - Toggle fullscreen
- `M` - Mute/Unmute
- `←/→` - Seek backward/forward
- `↑/↓` - Volume up/down
- `B` - Create bookmark at current timestamp
- `?` - Open settings panel
- And many more...

**Customization:**
1. Press `?` to open the Enhanced panel
2. Go to **Shortcuts** tab
3. Click on any key to set a custom shortcut
4. Changes save automatically

### 📝 Smart Bookmarks

Save timestamps and jump to specific moments with visual timeline markers.

**Features:**
- Create bookmarks during playback with `B` key
- Visual markers on video timeline
- Add custom labels to bookmarks
- Sync bookmarks across duplicate items (same TMDB/TVDB ID)
- Manage all bookmarks from Custom Tabs interface
- Export/import bookmark data

**Usage:**
1. While watching, press `B` at any moment
2. Add an optional label (e.g., "Epic scene")
3. Bookmark appears as marker on timeline
4. Click marker to jump to that timestamp

**Bookmark Management:**
- Access via Custom Tabs plugin
- View all bookmarks across library
- Clean up orphaned bookmarks
- Detect and merge duplicates
- Adjust time offsets for synced bookmarks

### 🎬 Custom Pause Screen

Beautiful overlay with media info when you pause a video.

![Pause Screen](images/pausescreen.png)

**Displays:**
- Media title and logo
- Year, rating, runtime
- Plot/description
- Current progress with time remaining
- Spinning disc animation
- Blurred backdrop

**Customization:**
See [Custom Styling](#custom-styling) section for CSS customization options.

### ⏯️ Smart Playback

Intelligent playback features for better viewing experience.

**Features:**
- **Auto-pause** - Pause when switching browser tabs
- **Auto-resume** - Resume when returning to tab
- **Auto-skip intros/outros** - Seamless binge-watching (requires Intro Skipper plugin)
- **Playback speed control** - Adjust speed with keyboard shortcuts
- **Auto Picture-in-Picture** - Enter PiP mode when switching tabs

**Configuration:**
Enable/disable in Enhanced panel → Settings tab

### 📝 Customizable Subtitles

Fine-tune subtitle appearance with presets for style, size, and font.

**Presets:**
- Multiple font families
- Size options (small, medium, large, extra large)
- Background opacity
- Text shadow options
- Position adjustments

**Usage:**
1. Open Enhanced panel → Settings
2. Find Subtitle Presets section
3. Select your preferred options
4. Changes apply immediately

---

## Discovery & Integration

### 🪼 Jellyseerr Search Integration

Search, request, and discover media directly from Jellyfin's search interface.

![Jellyseerr](images/jellyseerr.png)

**Features:**
- Search Jellyseerr from Jellyfin search bar
- Request movies and TV shows
- View request status (pending, approved, available)
- Auto-add requested media to watchlist
- Sync Jellyseerr watchlist to Jellyfin

**Setup:**
1. Open plugin settings → **Jellyseerr** tab
2. Check "Show Jellyseerr Results in Search"
3. Enter Jellyseerr URL(s) (one per line)
4. Enter Jellyseerr API Key (from Jellyseerr Settings → General)
5. Click "Test Connection"
6. Enable optional features:
   - Add Requested Media to Watchlist
   - Sync Jellyseerr Watchlist to Jellyfin
7. Click **Save**

**Requirements:**
- Jellyseerr instance with API access
- "Enable Jellyfin Sign-In" enabled in Jellyseerr
- Jellyfin users imported into Jellyseerr

![Jellyfin Sign-In](images/jellyfin-signin.png)

**Icon States:**

| **Icon** | **State** | **Description** |
| :---: | :--- | :--- |
|<img width="32" alt="active" src="https://github.com/user-attachments/assets/36e9dbab-3fbe-4b5b-b767-a961597ccb96" /> | **Active** | Jellyseerr is successfully connected, and the current Jellyfin user is correctly linked to a Jellyseerr user. <br> Results from Jellyseerr will load along with Jellyfin and requests can be made. |
| <img width="32" alt="noaccess" src="https://github.com/user-attachments/assets/09a3df03-97bf-499f-91a2-3b03e371ac02" /> | **User Not Found** | Jellyseerr is successfully connected, but the current Jellyfin user is not linked to a Jellyseerr account. <br>Ensure the user has been imported into Jellyseerr from Jellyfin. Results will not load. |
| <img width="32" alt="offline" src="https://github.com/user-attachments/assets/bd4ea4cb-94ec-450f-ab1a-13e72960ecec" /> | **Offline** | The plugin could not connect to any of the configured Jellyseerr URLs. <br> Check your plugin settings and ensure Jellyseerr is running and accessible. Results will not load. |

### 🎬 Jellyseerr Item Details

View recommendations and similar items on detail pages.

**Features:**
- Recommended items section
- Similar items section
- Request directly from recommendations
- Exclude items already in library
- Real-time request status indicators
- Support for 4K requests
- TV season selection

**Setup:**
1. Configure Jellyseerr integration (see above)
2. Check "Show Jellyseerr Recommendations and Similar items"
3. Optional: Enable "Exclude already in library items"
4. Click **Save**

**Discovery Pages:**
- Genre-based discovery
- Network-based discovery
- Person-based discovery (actors, directors)
- Tag-based discovery
- All with TV/Movies/All filtering

### 🔗 .arr Links Integration

Quick access to Sonarr, Radarr, and Bazarr (admin only).

**Features:**
- Direct links to item pages in Sonarr/Radarr
- Bazarr subtitle management links
- Display *arr tags as clickable links
- Filter and customize tag display

**Setup:**
1. Open plugin settings → **ARR Settings** tab
2. Enter your Sonarr/Radarr/Bazarr URLs
3. Enable "Show *arr Links on Item Pages"
4. Optional: Enable "Show *arr Tags as Links"
5. Configure tag filters (show/hide specific tags)

**Tag Customization:**
See [ARR Tag Links CSS](#arr-tag-links-css) for styling options.

### 🔍 Streaming Provider Lookup

See where else your media is available to stream.

![Elsewhere](images/elsewhere.png)

**Features:**
- Multi-region support
- Buy, rent, and stream options
- Provider logos and links
- Powered by TMDB data

**Usage:**
1. Enable in Enhanced panel → Settings
2. Select your region
3. View providers on item detail pages

### ✒️ TMDB Reviews

Display user reviews from TMDB on item pages.

**Features:**
- Full review text
- Author information
- Rating scores
- Review dates
- Expandable/collapsible reviews

**Setup:**
Enable "Show TMDB Reviews" in Enhanced panel → Settings

---

## Visual Enhancements

### 🏷️ Quality Tags

Display quality information (4K, HDR, Atmos) directly on posters.

**Supported Tags:**
- **Resolution:** 8K, 4K, 1080p, 720p, 480p, LOW-RES
- **Video Format:** AV1, HEVC, H265, VP9, H264
- **Video Features:** HDR, Dolby Vision, HDR10+, 3D
- **Audio:** ATMOS, DTS-X, TRUEHD, DTS, Dolby Digital+, 7.1, 5.1

**Configuration:**
1. Open Enhanced panel → Settings
2. Enable "Quality Tags"
3. Adjust position (top-left, top-right, etc.)
4. Customize via CSS (see below)

**CSS Customization:**
```css
/* Change all tag styles */
.quality-overlay-label {
    font-size: 0.8rem !important;
    padding: 3px 10px !important;
}

/* Target specific tags */
.quality-overlay-label[data-quality="4K"] {
    background-color: purple !important;
}

/* Hide unwanted tags */
.quality-overlay-label[data-quality="H264"] {
    display: none !important;
}
```

### 🎭 Genre Tags

Identify genres with themed icons on posters.

**Features:**
- Material Design icons for each genre
- Circular badges that expand on hover
- Show up to 3 genres per item
- Customizable position

**Configuration:**
Enable in Enhanced panel → Settings → Genre Tags

**CSS Customization:**
```css
/* Always show text (no hover) */
.genre-tag {
    width: auto !important;
    border-radius: 14px !important;
}
.genre-tag .genre-text {
    display: inline !important;
}

/* Change background color */
.genre-tag {
    background-color: rgba(100, 100, 255, 0.8) !important;
}
```

### 🌐 Language Tags

Display available audio languages as country flags on posters.

**Features:**
- Country flag icons from flagcdn.com
- Show up to 3 unique languages
- Positioned bottom-left by default
- Also displays on item detail pages

**Configuration:**
Enable in Enhanced panel → Settings → Language Tags

**CSS Customization:**
```css
/* Change flag size */
.language-flag {
    width: 30px !important;
    height: auto !important;
}

/* Add border to flags */
.language-flag {
    border: 1px solid rgba(255, 255, 255, 0.3) !important;
}

/* Hide specific language */
.language-flag[data-lang="jp"] {
    display: none !important;
}
```

### ⭐ Rating Tags

Show TMDB and Rotten Tomatoes ratings on posters and in player.

![Ratings](images/ratings.png)

**Features:**
- TMDB star ratings
- Rotten Tomatoes critic scores (fresh/rotten icons)
- Stacked vertically on posters
- Optional OSD display during playback
- Color-coded by rating value

**Configuration:**
1. Enable in Enhanced panel → Settings
2. Choose "Rating Tags on Posters"
3. Optional: Enable "OSD Rating in Player"

**CSS Customization:**
```css
/* Customize TMDB rating */
.rating-tag-tmdb {
    background: rgba(0, 0, 0, 0.9) !important;
}

/* Customize critic rating */
.rating-tag-critic {
    background: rgba(220, 53, 69, 0.95) !important;
}

/* Hide specific rating */
.rating-tag-tmdb {
    display: none !important;
}
```

### 👤 People Tags

Display age and birthplace information for cast members.

**Features:**
- Current age or age at death
- Age at item release
- Birthplace with country flag
- Deceased indicator (grayscale + cross)
- Caching for performance

**Configuration:**
Enable in Enhanced panel → Settings → People Tags

**Displays:**
- Age chips (top-left of cast cards)
- Birthplace banner (bottom of cast cards)
- Deceased styling (grayscale filter)

**CSS Customization:**
```css
/* Customize age chips */
.je-people-age-chip {
    padding: 6px 12px !important;
    font-size: 13px !important;
}

/* Customize birthplace banner */
.je-people-place-banner {
    background: rgba(0, 0, 0, 0.95) !important;
    padding: 16px !important;
}

/* Hide age chips */
.je-people-age-container {
    display: none !important;
}
```

---

## Personal Scripts

These are optional scripts from the developer's personal collection.

### 🎨 Colored Activity Icons

Replace default activity icons with Material Design icons.

![Colored Activity Icons](images/colored-activity-icons.png)

**Features:**
- Custom colors for each activity type
- Material Design icon set
- Better visual distinction

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🎪 Colored Ratings

Color-coded backgrounds for ratings on detail pages.

![Colored Ratings](images/ratings.png)

**Features:**
- Different colors per rating type
- Value-based color gradients
- Supports TMDB, IMDb, Rotten Tomatoes

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🖼️ Login Image Display

Show user profile images on manual login page.

![Login Image](images/login-image.png)

**Features:**
- Display user avatars
- Cleaner login interface
- Automatic fallback to text

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🧩 Plugin Icons

Replace default plugin icons with Material Design icons.

![Plugin Icons](images/plugin-icons.png)

**Features:**
- Custom icons for popular plugins
- Add custom config page links
- Improved dashboard aesthetics

**Configuration:**
Enable in Enhanced panel → Settings → Extras

### 🎭 Theme Selector

Choose from multiple Jellyfin theme color variants.

![Theme Selector](images/theme-selector.png)

**Features:**
- Multiple color palettes (Aurora, Jellyblue, Ocean, etc.)
- Randomize theme daily option
- Quick theme switching

**Configuration:**
1. Enable in Enhanced panel → Settings → Extras
2. Select theme from dropdown
3. Optional: Enable "Randomize Daily"

---

## Customization

### 🎨 Custom Styling

Extensive CSS customization options for all features.

**Available Customizations:**
- [Pause Screen CSS](#pause-screen-css)
- [Quality Tags CSS](#quality-tags-css)
- [Genre Tags CSS](#genre-tags-css)
- [Language Tags CSS](#language-tags-css)
- [Rating Tags CSS](#rating-tags-css)
- [Rating Tag OSD CSS](#rating-tag-osd-css)
- [People Tags CSS](#people-tags-css)
- [ARR Tag Links CSS](#arr-tag-links-css)
- [Enhanced Panel CSS](#panel-css)

**How to Apply Custom CSS:**
1. Go to **Dashboard** → **General** → **Custom CSS**
2. Add your custom styles
3. Click **Save**
4. Refresh browser (Ctrl+F5)

**Example - Hide Pause Screen Logo:**
```css
#pause-screen-logo {
    display: none !important;
}
```

**Example - Customize Quality Tags:**
```css
.quality-overlay-label {
    font-size: 0.9rem !important;
    border-radius: 6px !important;
}

.quality-overlay-label[data-quality="4K"] {
    background: linear-gradient(45deg, #c0392b, #e74c3c) !important;
}
```

### 🖼️ Custom Branding

Upload your own logos, banners, and favicon.

**Features:**
- Custom Jellyfin logo (header)
- Custom splash banners (light/dark themes)
- Custom favicon (browser tab icon)
- Files stored in plugin config folder
- Survives Jellyfin updates

**Setup:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Find **Custom Branding** section
4. Upload your custom images:
   - Icon Transparent (header logo)
   - Banner Light (dark theme splash)
   - Banner Dark (light theme splash)
   - Favicon (browser icon)
5. Click **Save**
6. Force refresh browser (Ctrl+F5)

**Requirements:**
- Requires [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- Recommended image formats: PNG, SVG
- Files stored in: `/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/custom_branding/`

### 🌍 Internationalization

Multi-language support with community translations.

**Supported Languages:**
- Danish (da)
- German (de)
- English (en)
- Spanish (es)
- French (fr)
- Hungarian (hu)
- Italian (it)
- Norwegian (no)
- Polish (pl)
- Portuguese (pt)
- Russian (ru)
- Swedish (sv)
- Turkish (tr)
- Chinese (zh-HK)

**How It Works:**
- Automatically detects Jellyfin user profile language
- Fetches latest translations from GitHub on first load
- Caches translations for 24 hours
- Falls back to bundled translations if offline

**Contributing Translations:**
1. Copy `en.json` from `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Rename to your language code (e.g., `es.json`)
3. Translate the English text
4. Submit a pull request
5. Translations available immediately after merge!

---

## Compatibility

### Supported Platforms

| Platform | Support | Notes |
|----------|---------|-------|
| Jellyfin Web UI | ✅ Full | All features available |
| Android App | ✅ Full | Official app with embedded web UI |
| iOS App | ✅ Full | Official app with embedded web UI |
| Desktop Apps | ✅ Full | JMP, Jellyfin Desktop v2.0.0+ |
| Android TV | ❌ Not Supported | Native app, no web UI |
| Third-party Apps | ❌ Not Supported | Depends on embedded web UI |

### Requirements

- Jellyfin 10.11.x
- Modern web browser
- JavaScript enabled
- Clients using embedded Jellyfin web UI

### Known Issues

- JMP v1.12.0 has compatibility issues (use Jellyfin Desktop v2.0.0 instead)
- Some features require additional plugins (Intro Skipper, Custom Tabs)
- TMDB API may be blocked in some regions

---

## Feature Configuration

### Enhanced Panel

Access all settings via the Enhanced panel:

**Open Panel:**
- Click **Jellyfin Enhanced** in sidebar
- Press `?` keyboard shortcut

**Tabs:**
- **Shortcuts** - Customize keyboard shortcuts
- **Settings** - Enable/disable features, adjust positions
- **Jellyseerr** - Configure Jellyseerr integration
- **ARR** - Configure Sonarr/Radarr integration
- **About** - Plugin information and links

**Settings Persistence:**
- Settings saved to browser localStorage
- Per-user configuration
- Sync across devices (same browser profile)

### Feature Toggles

Most features can be enabled/disabled individually:

1. Open Enhanced panel
2. Go to Settings tab
3. Toggle features on/off
4. Changes apply immediately (no restart needed)

**Toggleable Features:**
- Quality Tags
- Genre Tags
- Language Tags
- Rating Tags
- People Tags
- Pause Screen
- Auto-skip Intros
- Auto Picture-in-Picture
- Jellyseerr Integration
- ARR Links
- Elsewhere Lookup
- TMDB Reviews
- And more...