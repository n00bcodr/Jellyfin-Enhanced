# ARR Integration

Quick access to Sonarr, Radarr, and Bazarr from Jellyfin, plus calendar and download monitoring.

!!! success "Note"

    ***arr links are only visible to admin users**

    **Other features are visible to all users.**


!!! warning


    **Security Considerations:**

    - **API Keys** are stored securely on server
    - **Network Access** - Ensure *arr instances are secure
    - **HTTPS** - Use HTTPS for remote access

## Features

The ARR integration provides convenient links to your Sonarr, Radarr, and Bazarr instances directly from Jellyfin item pages. Additionally, it can display *arr tags as clickable links and provide calendar and download monitoring pages.

- **Quick Links** - Jump to Sonarr, Radarr, Bazarr pages for any item
- **Tag Links** - Display *arr tags as clickable links with filtering
- **Calendar View** - Upcoming releases from Sonarr/Radarr
- **Requests Page** - Monitor download queue and status
- **Admin Only** - Links only visible to administrators

## ARR Links

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable *arr Links"**
4. Enter your URLs:
   - **Sonarr URL** - Your Sonarr instance URL
   - **Radarr URL** - Your Radarr instance URL
   - **Bazarr URL** - Your Bazarr instance URL (optional)
5. Optional: Check **"Show *arr Links as Text"** for text links instead of icons
6. Click **Save**

### URL Mappings

Map internal and external URLs for different network contexts.

**Format:**
```
internal_url|external_url
```

**Example:**
```
http://sonarr:8989|https://sonarr.example.com
http://radarr:7878|https://radarr.example.com
```

**Use Case:** Different URLs for local network vs remote access.

### Usage

**On Item Detail Pages:**
1. Open any movie or TV show
2. Look for *arr link icons in external links section
3. Click to open item in respective *arr application

**Visibility:**
- Only visible to administrators
- Automatically detects item type (movie/TV)
- Shows relevant links only (Sonarr for TV, Radarr for movies)

## ARR Tags

Display synced *arr tags as clickable links on item detail pages.

### Setup

**Prerequisites:**
- Sonarr and/or Radarr configured
- API keys for Sonarr and Radarr

**Configuration:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable *arr Tags Sync"**
4. Enter **Sonarr API Key**
5. Enter **Radarr API Key**
6. Configure tag settings (see below)
7. Click **Save**

### Tag Settings

**Tag Prefix:**
- Default: `JE Arr Tag: `
- Prefix added to synced tags
- Helps identify plugin-managed tags

**Clear Old Tags:**
- Remove old plugin-managed tags before syncing
- Keeps tags clean and up-to-date
- Recommended: Enabled

**Show Tags as Links:**
- Display tags as clickable links on item pages
- Click to view all items with that tag
- Recommended: Enabled

### Tag Filtering

**Links Filter (Show Only):**
- Comma-separated list of tag names to show
- Only matching tags displayed as links
- Leave empty to show all tags

**Example:**
```
in-netflix,in-disney,4k-upgrade
```

**Links Hide Filter:**
- Comma-separated list of tag names to hide
- Matching tags not displayed as links
- Overrides show filter

**Example:**
```
internal-tag,do-not-show
```

**Sync Filter:**
- Comma-separated list of tag names to sync
- Only matching tags synced from *arr
- Leave empty to sync all tags

### Custom Styling

Customize tag link appearance with CSS.

**Example - Rename Tag:**
```css
/* Hide original label */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
  display: none !important;
}

/* Add custom label */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
  content: " N00bCodr";
}
```

**Example - Hide Specific Tag:**
```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  display: none !important;
}
```

**Example - Service Colors:**
```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  background: #d81f26;
  color: #fff;
}
```

See README for more CSS examples.

## Calendar Page

View upcoming releases from Sonarr and Radarr in a calendar interface.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable Calendar Page"**
4. Choose integration method:
   - **Use Plugin Pages** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin)
   - **Use Custom Tabs** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
5. Configure calendar settings (see below)
6. Click **Save**
7. Restart Jellyfin if using Plugin Pages

### Calendar Settings

**First Day of Week:**
- Monday (default)
- Sunday

**Time Format:**
- `5pm/5:30pm` - 12-hour format
- `17:00/17:30` - 24-hour format

**Highlight Favorites:**
- Highlight favorite shows/movies in calendar
- Requires favorites set in Jellyfin

**Highlight Watched Series:**
- Highlight series you're currently watching
- Based on watch history

### Usage

**Access Calendar:**
- Click "Calendar" in sidebar (Plugin Pages)
- Navigate to custom tab (Custom Tabs)
- Direct URL: `/web/index.html#!/jellyfinenhanced/calendar`

**Features:**
- Month, week, and agenda views
- Color-coded by series/movie
- Click event to view details
- Filter by Sonarr/Radarr
- Search functionality

## Requests Page

Monitor download queue and status from Sonarr and Radarr.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable Requests Page"**
4. Choose integration method:
   - **Use Plugin Pages** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin)
   - **Use Custom Tabs** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
5. Configure polling settings (see below)
6. Click **Save**
7. Restart Jellyfin if using Plugin Pages

### Polling Settings

**Enable Polling:**
- Auto-refresh download status
- Recommended: Enabled

**Poll Interval:**
- Default: 30 seconds
- Range: 10-300 seconds
- Lower = more frequent updates, higher server load

### Usage

**Access Requests Page:**
- Click "Requests" in sidebar (Plugin Pages)
- Navigate to custom tab (Custom Tabs)
- Direct URL: `/web/index.html#!/jellyfinenhanced/requests`

**Features:**
- View active downloads
- Progress bars and ETA
- Quality and size information
- Filter by Sonarr/Radarr
- Pause/resume downloads (if supported)
- Remove from queue

**Status Indicators:**
- **Downloading** - Currently downloading
- **Queued** - Waiting to download
- **Paused** - Download paused
- **Completed** - Download finished
- **Failed** - Download failed