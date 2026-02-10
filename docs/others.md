# Other Features

Additional features including custom branding, extras, icons, and more.

## Table of Contents

- [Custom Branding](#custom-branding)
- [Icon Settings](#icon-settings)
- [Extras](#extras)
- [Letterboxd Integration](#letterboxd-integration)
- [Hidden Content](#hidden-content)
- [Splash Screen](#splash-screen)
- [Internationalization](#internationalization)

---

## Custom Branding

Upload your own logos, banners, and favicon to personalize your Jellyfin instance.

### Features

- Custom Jellyfin logo (header)
- Custom splash banners (light/dark themes)
- Custom favicon (browser tab icon)
- Files stored in plugin config folder
- Survives Jellyfin updates

### Setup

**Prerequisites:**
- [file-transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) installed

**Configuration:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Find **Custom Branding** section
4. Upload your custom images:
   - **Icon Transparent** - Header logo (PNG/SVG recommended)
   - **Banner Light** - Dark theme splash image
   - **Banner Dark** - Light theme splash image
   - **Favicon** - Browser tab icon
5. Click **Save**
6. Force refresh browser (Ctrl+F5)

### Image Requirements

- **Formats:** PNG, SVG recommended
- **Transparent backgrounds** for logos
- **Appropriate dimensions** for each type
- **File size:** Keep reasonable for performance

### Storage Location

Files stored in:
```
/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/custom_branding/
```

This location survives Jellyfin server and web updates.

---

## Icon Settings

Configure icon display throughout the plugin interface.

### Use Icons

Enable or disable icons in toasts, settings panel, and other UI elements.

**Enable:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Check **"Use Icons"**
4. Click **Save**

### Icon Style

Choose between different icon sets.

**Available Styles:**
- **Emoji** - Unicode emoji characters (default)
- **Lucide Icons** - Modern, clean icon set
- **Material UI Icons** - Google Material Design icons

**Configuration:**
1. Select icon style from dropdown
2. Click **Save**
3. Refresh browser to see changes

**Considerations:**
- Emoji - Universal, no loading required
- Lucide - Clean, modern aesthetic
- Material UI - Familiar Google design

---

## Extras

Personal scripts from the developer's collection.

### Colored Activity Icons

Replace default activity icons with Material Design icons with custom colors.

![Colored Activity Icons](../images/colored-activity-icons.png)

**Features:**
- Custom colors for each activity type
- Material Design icon set
- Better visual distinction

**Enable:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Check **"Enable Colored Activity Icons"**
4. Click **Save**

### Colored Ratings

Color-coded backgrounds for ratings on detail pages.

![Colored Ratings](../images/ratings.png)

**Features:**
- Different colors per rating type
- Value-based color gradients
- Supports TMDB, IMDb, Rotten Tomatoes

**Enable:**
1. Navigate to **Other Settings** tab
2. Check **"Enable Colored Ratings"**
3. Click **Save**

### Login Image Display

Show user profile images on manual login page.

![Login Image](../images/login-image.png)

**Features:**
- Display user avatars
- Cleaner login interface
- Automatic fallback to text

**Enable:**
1. Navigate to **Other Settings** tab
2. Check **"Enable Login Image"**
3. Click **Save**

### Plugin Icons

Replace default plugin icons with Material Design icons.

![Plugin Icons](../images/plugin-icons.png)

**Features:**
- Custom icons for popular plugins
- Add custom config page links
- Improved dashboard aesthetics

**Enable:**
1. Navigate to **Other Settings** tab
2. Check **"Enable Plugin Icons"**
3. Click **Save**

**Custom Plugin Links:**
Add custom links to plugin config pages.

**Format:**
```
PluginName|URL
```

**Example:**
```
Jellyfin Enhanced|/web/configurationpage?name=JellyfinEnhanced
Custom Plugin|https://example.com/config
```

### Theme Selector

Choose from multiple Jellyfin theme color variants.

![Theme Selector](../images/theme-selector.png)

**Features:**
- Multiple color palettes (Aurora, Jellyblue, Ocean, etc.)
- Randomize theme daily option
- Quick theme switching

**Enable:**
1. Navigate to **Other Settings** tab
2. Check **"Enable Theme Selector"**
3. Click **Save**

**Usage:**
1. Open Enhanced panel
2. Go to Settings tab
3. Find Theme Selector section
4. Select theme from dropdown
5. Optional: Enable "Randomize Daily"

**Available Themes:**
- Aurora
- Jellyblue
- Ocean
- Sunset
- Forest
- And more...

---

## Letterboxd Integration

Add Letterboxd external links to movie item detail pages.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Check **"Enable Letterboxd Links"**
4. Optional: Check **"Show Letterboxd Link as Text"** for text instead of icon
5. Click **Save**

### Usage

**On Movie Detail Pages:**
1. Open any movie
2. Look for Letterboxd link in external links section
3. Click to open movie on Letterboxd

**Features:**
- Automatic TMDB ID to Letterboxd mapping
- Direct links to movie pages
- Icon or text display option

---

## Hidden Content

Hide specific items from your Jellyfin library without deleting them.

### Features

- Hide movies, shows, or episodes
- Hidden items don't appear in library
- Easily unhide items later
- Per-user hidden content
- Manage via Enhanced panel

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Check **"Enable Hidden Content"**
4. Click **Save**

### Usage

**Hide Item:**
1. Open item detail page
2. Click hide button (if available)
3. Item removed from library view

**Manage Hidden Items:**
1. Open Enhanced panel
2. Go to Hidden Content section
3. View all hidden items
4. Click to unhide

**Note:** Hidden items are per-user and don't affect other users.

---

## Splash Screen

Custom splash screen that appears while Jellyfin is loading.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Other Settings** tab
3. Check **"Enable Custom Splash Screen"**
4. Enter **Splash Screen Image URL**
   - Use full URL or relative path
   - Default: `/web/assets/img/banner-light.png`
5. Click **Save**

### Image Requirements

- **Format:** PNG, JPG, SVG
- **Size:** Appropriate for full-screen display
- **Location:** Accessible from web root
- **Responsive:** Should work on various screen sizes

### Custom Image

**Upload Custom Image:**
1. Place image in Jellyfin web directory
2. Note the path (e.g., `/web/custom/splash.png`)
3. Enter path in plugin settings
4. Save and refresh

---

## Internationalization

Multi-language support with community translations.

### Supported Languages

- Danish (da)
- German (de)
- English (en)
- Spanish (es)
- French (fr)
- Hungarian (hu)
- Italian (it)
- Norwegian (no)
- Polish (pl)
- Portuguese (pt, pr)
- Russian (ru)
- Swedish (sv)
- Turkish (tr)
- Chinese (zh-HK)

### How It Works

- Automatically detects Jellyfin user profile language
- Fetches latest translations from GitHub on first load
- Caches translations for 24 hours
- Falls back to bundled translations if offline
- Clears outdated caches on plugin update

### Default Language Override

Set a default language for all users.

**Configuration:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Find **Default UI Language** setting
3. Select language from dropdown
4. Leave empty for system default
5. Click **Save**

### Contributing Translations

Help translate Jellyfin Enhanced for the community!

**Steps:**
1. Go to `Jellyfin.Plugin.JellyfinEnhanced/js/locales/`
2. Copy `en.json`
3. Rename to your language code (e.g., `es.json`)
4. Translate all English text
5. Submit pull request

**Translation Updates:**
- Fetched from GitHub on first load
- Available immediately after merge
- No plugin update needed
- Cached per plugin version

---

## Cache Management

Clear various caches to force refresh of data.

### Clear Local Storage

Force all clients to clear their localStorage.

**Use Case:**
- Reset all client-side settings
- Fix corrupted data
- Force fresh start

**How:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Find **Clear Local Storage** button
3. Click to set timestamp
4. All clients clear storage on next load

### Clear Translation Cache

Force all clients to re-fetch translations.

**Use Case:**
- Update to latest translations
- Fix translation issues
- Force language refresh

**How:**
1. Find **Clear Translation Cache** button
2. Click to set timestamp
3. Clients re-fetch on next load

### Clear Tags Cache

Force all clients to clear tag caches.

**Use Case:**
- Update quality/genre/language/rating tags
- Fix cached tag data
- Force tag refresh

**How:**
1. Go to Enhanced Settings tab
2. Find **Clear All Client Caches** button
3. Click to clear
4. Clients re-fetch tag data on next load

**Note:** May cause slowness on first load after clearing.

---

## Related Features

- [Enhanced Features](enhanced.md) - Core plugin features
- [Elsewhere Integration](elsewhere.md) - Streaming provider lookup
- [Jellyseerr Integration](jellyseerr.md) - Request media
- [ARR Integration](arr.md) - Sonarr, Radarr integration
- [FAQ](faq.md) - Common questions

## Support

If you encounter issues:

1. Check [FAQ](faq.md) for common solutions
2. Verify settings are correct
3. Check browser console for errors
4. Report issues on [GitHub](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)

---

**Made with 💜 for Jellyfin and the community**
