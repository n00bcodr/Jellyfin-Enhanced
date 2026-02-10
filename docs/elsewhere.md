# Elsewhere Integration

Discover where your media is available to stream across multiple regions and platforms.

![Elsewhere](../images/elsewhere.png)

## Overview

Jellyfin Elsewhere helps you find where movies and TV shows are available to stream, rent, or buy across different streaming services and regions. Powered by TMDB data, it provides comprehensive availability information directly on item detail pages.

## Features

- **Multi-region Support** - Check availability across different countries
- **Buy, Rent, Stream** - See all options in one place
- **Provider Logos** - Visual icons for each streaming service
- **Direct Links** - Click to open provider pages
- **TMDB Integration** - Powered by The Movie Database

## Setup

### Prerequisites

- TMDB API Key (free from [TMDB](https://www.themoviedb.org/settings/api))
- Jellyfin Enhanced plugin installed

### Configuration

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Elsewhere Settings** tab
3. Check "Enable Elsewhere"
4. Enter your **TMDB API Key**
5. Select your **Default Region** (e.g., US, GB, DE)
6. Optional: Configure default and ignored providers
7. Click **Save**

### Getting a TMDB API Key

1. Create a free account at [TMDB](https://www.themoviedb.org/)
2. Go to [Settings → API](https://www.themoviedb.org/settings/api)
3. Request an API key (choose "Developer" option)
4. Copy the API Key (v3 auth)
5. Paste into plugin settings

## Configuration Options

### Default Region

Select the primary region for streaming availability checks.

**Supported Regions:**
- US - United States
- GB - United Kingdom
- DE - Germany
- FR - France
- ES - Spain
- IT - Italy
- And many more...

### Default Providers

Comma-separated list of provider IDs to show by default.

**Example:**
```
8,9,337,384
```

**Common Provider IDs:**
- 8 - Netflix
- 9 - Amazon Prime Video
- 337 - Disney+
- 384 - HBO Max
- 15 - Hulu
- 283 - Crunchyroll

### Ignore Providers

Comma-separated list of provider IDs to hide from results.

**Example:**
```
10,11,12
```

**Use Case:** Hide providers you don't have access to or aren't interested in.

### Custom Branding

**Custom Branding Text:**
- Replace "Jellyfin Elsewhere" with your own text
- Leave empty to use default

**Custom Branding Image URL:**
- Replace the Elsewhere logo with your own image
- Provide full URL to image file
- Leave empty to use default logo

## Usage

### On Item Detail Pages

1. Open any movie or TV show detail page
2. Scroll to the "Jellyfin Elsewhere" section
3. View available streaming options
4. Click provider logos to open their pages

### Information Displayed

**For Each Provider:**
- Provider logo and name
- Availability type (Stream, Rent, Buy)
- Direct link to provider page

**Availability Types:**
- **Stream** - Available with subscription
- **Rent** - Available to rent
- **Buy** - Available to purchase

## Troubleshooting

### Elsewhere Not Showing

**Check Configuration:**
1. Verify TMDB API key is correct
2. Ensure "Enable Elsewhere" is checked
3. Confirm item has TMDB metadata
4. Check browser console for errors

**TMDB API Access:**
- TMDB API may be blocked in some regions
- Use VPN if needed
- Check [Jellyseerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx) for TMDB access issues

### No Providers Showing

**Possible Causes:**
- Item not available in selected region
- All providers in ignore list
- TMDB data not available for item
- API rate limit reached

**Solutions:**
- Try different region
- Check ignore providers list
- Verify item has TMDB ID
- Wait and try again later

### Provider Links Not Working

**Check:**
- Provider still operates in your region
- Link format hasn't changed
- Provider requires account/subscription

## Integration with Jellyseerr

Elsewhere can be displayed on Jellyseerr discovery pages.

**Enable:**
1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Jellyseerr Settings** tab
3. Check "Show Elsewhere on Jellyseerr"
4. Click **Save**

**Features:**
- Shows streaming availability on Jellyseerr cards
- Same provider information as item pages
- Helps decide what to request

## Privacy & Data

**What Data is Sent:**
- TMDB ID of the item
- Selected region code
- API key (securely transmitted)

**What Data is NOT Sent:**
- Your Jellyfin library contents
- Personal information
- Viewing history

**Data Source:**
- All provider data comes from TMDB
- Updated regularly by TMDB community
- Accuracy depends on TMDB data quality

## Limitations

- Availability data depends on TMDB accuracy
- Some regions have limited provider data
- Provider availability changes frequently
- Links may become outdated
- Requires internet connection

## Related Features

- [Jellyseerr Integration](jellyseerr.md) - Request media not in your library
- [Enhanced Features](enhanced.md) - Core plugin features
- [FAQ](faq.md) - Common questions and troubleshooting

## Support

If you encounter issues:

1. Check [FAQ](faq.md) for common solutions
2. Verify TMDB API key is valid
3. Check browser console for errors
4. Report issues on [GitHub](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)

---

**Note:** Jellyfin Elsewhere is also available as a [standalone JavaScript](https://github.com/n00bcodr/Jellyfin-Elsewhere) for use without the full plugin.
