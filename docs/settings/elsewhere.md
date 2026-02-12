<!-- use a custom title  -->
!!! info "Prerequisites"
    
    **Prerequisites:**
    
    - TMDB API Key 
        - [Free from TMDB](https://www.themoviedb.org/settings/api)
    - Jellyfin Enhanced plugin installed


## Getting a TMDB API Key

1. Create a free account at [TMDB](https://www.themoviedb.org/)
2. Go to [Settings → API](https://www.themoviedb.org/settings/api)
3. Request an API key (choose "Developer" option)
4. Copy the API Key (v3 auth)
5. Paste into plugin settings

# Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Elsewhere Settings** tab
3. Check "Enable Elsewhere"
4. Enter your **TMDB API Key**
5. Select your **Default Region** (e.g., US, GB, DE)
6. Optional: Configure default and ignored providers
7. Click **Save**



# Configuration Options

## Default Region

Select the primary region for streaming availability checks. Empty defaults to US.

**View full list:** [Available Regions](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt)

**Examples:**
- `US` - United States
- `GB` - United Kingdom
- `DE` - Germany
- `FR` - France
- `ES` - Spain
- `IT` - Italy

## Default Providers

Comma-separated list of streaming provider names to show by default. Leave blank to show all.

**View full list:** [Available Providers](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt)

**Example:**
```
Netflix,Hulu,Disney Plus
```

**Common Provider Names:**
- Netflix
- Amazon Prime Video
- Disney Plus
- HBO Max
- Hulu
- Crunchyroll

## Ignore Providers

Comma-separated list of provider names to hide from results. **Supports regex patterns** for advanced filtering.

**View full list:** [Available Providers](https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt)

**Examples:**

Basic (exact names):
```
Apple TV,Google Play Movies
```

With regex (hide all "with Ads" providers):
```
.*with Ads
```

Multiple patterns:
```
.*with Ads,.*Free,Vudu
```

**Use Cases:**
- Hide providers you don't have access to / or have access to
- Filter out ad-supported tiers
- Remove free streaming options
- Exclude rental/purchase-only services

## Custom Branding

**Custom Branding Text:**
- Replace "Jellyfin Elsewhere" with your own text
- Leave empty to use default

**Custom Branding Image URL:**
- Replace the Elsewhere logo with your own image
- Provide full URL to image file
- Leave empty to use default logo

## Usage

## On Item Detail Pages

1. Open any movie or TV show detail page
2. Scroll to the "Jellyfin Elsewhere" section
3. View available streaming options

## Information Displayed

- **Provider icons** - Visual logos of streaming services where content is available
- **Provider names** - Name of each streaming service
- **Multi-region support** - Shows availability across your selected regions

# Troubleshooting

## Elsewhere Not Showing

**Check Configuration:**
1. Verify TMDB API key is correct
2. Ensure "Enable Elsewhere" is checked
3. Confirm item has TMDB metadata
4. Check browser console for errors

**TMDB API Access:**
- TMDB API may be blocked in some regions
- Use VPN if needed
- Check [Jellyseerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx) for TMDB access issues

## No Providers Showing

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

# Integration with Jellyseerr

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

# Privacy & Data

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

# Limitations

- Availability data depends on TMDB accuracy
- Some regions have limited provider data
- Provider availability changes frequently
- Requires internet connection

# Support

If you encounter issues:

1. Check [FAQ](faq-support/faq.md) for common solutions
2. Verify TMDB API key is valid
3. Check browser console for errors
4. Report issues on [GitHub](https://github.com/n00bcodr/Jellyfin-Enhanced/issues)

---