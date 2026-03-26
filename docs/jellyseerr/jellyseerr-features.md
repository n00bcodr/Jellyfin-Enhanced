# Jellyseerr Integration

Search, request, and discover media directly from Jellyfin using your Jellyseerr instance.

<!-- relative directory  -->
![Jellyseerr](../images/jellyseerr.png)

<!-- use a custom title -->
!!! info "Note"

    **This plugin is NOT affiliated with Jellyseerr/Seerr.** Jellyseerr is an independent project. This plugin simply integrates with it to enhance the Jellyfin experience.

    **Please report any issues with this plugin to the Jellyfin Enhanced repository, not to the Jellyseerr/Seerr team.**

## Features

- **Search + Request** - Search + request from Jellyseerr, directly from Jellyfin search results
    - **Advanced requests** *(requires configuration)*
    - **4K Requests**
    - **4K TV Requests**
    - **Season selection**
- **Requests Tab**
    - **View request status** - pending, approved, available
- **Recommendations + Discovery** - Recommendations and similar items on detail pages
- **Issue Reporting** - Report problems directly to Jellyseerr
- **Watchlist Sync** - Auto-add requested media to Jellyfin watchlist *([requires the KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks)*)


<!-- use a custom title -->
!!! tip "How it works"

    To ensure security and prevent CORS errors, the plugin uses the Jellyfin server as a proxy. This keeps your Jellyseerr API key safe and avoids browser security issues.


### Search Integration

#### Requesting:

1. Type search query in Jellyfin search bar
2. Results from both Jellyfin and Jellyseerr appear
3. Jellyseerr results show request status
4. Click to request or view details

#### 4K TV Requesting:

1. Enable **4K TV Requests** in plugin settings.
2. For TV results, use the request split-button dropdown and choose **Request in 4K**.
3. The season selection modal opens in 4K mode.
4. The modal header shows **Request Series - 4K** and the primary button shows **Request in 4K**.

!!! tip

    In More Info modal, TV actions use **Request More** as the primary action, with **Request in 4K** in the dropdown when 4K is requestable.

#### Request Status Indicators:

- **Available** - Already in your library
- **Pending** - Request submitted, awaiting approval
- **Approved** - Request approved, downloading
- **Not Requested** - Click to request

### Item Details

View Jellyseerr recommendations and similar items on detail pages.

- Recommended items section
- Similar items section
- Request directly from recommendations
- Exclude items already in library
- Real-time request status

#### Configure
1. Check **"Show Jellyseerr Recommendations and Similar items"**
2. Optional: Enable **"Exclude already in library items"**
3. Optional: Enable **"Exclude rejected items"**

### Discovery Pages

Browse and discover content by various criteria.

#### Available Discovery Types

- **Genre Discovery** - Browse by genre (Action, Comedy, etc.)
- **Network Discovery** - Browse by network (Netflix, HBO, etc.)
- **Person Discovery** - Browse by actor, director, crew
- **Tag Discovery** - Browse by custom tags

#### Features

- Filter by TV/Movies/All
- Infinite scroll with pagination
- Request directly from discovery
- Library awareness (hide owned items)

#### Configure

1. Check respective discovery options in settings
2. Access via custom navigation or direct URLs

### Issue Reporting

Report problems with media directly to Jellyseerr.

#### Issue Types

- Video (quality, corruption, wrong file)
- Audio (sync, missing tracks, quality)
- Subtitles (sync, missing, incorrect)
- Other (metadata, artwork, etc.)

#### How to Report

1. Open movie or TV show detail page
2. Click report icon in action buttons
3. Select issue type
4. For TV: Select season and episode (optional)
5. Enter description
6. Submit report

!!! note

    Issue reporting button will be hidden, if these are true:

    * Jellyseerr is not reachable
    * User is not linked

## Requests Page

Monitor active downloads from Sonarr/Radarr and manage Jellyseerr requests and issues in one dedicated page.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Seerr Settings** tab
3. Check **"Enable Requests Page"**
4. Optionally check **"Show Downloads in Requests Page"** to display active *arr downloads (enabled by default)
5. Optionally check **"Show Seerr Issues Section"** to display Jellyseerr issues
6. Choose integration method:
   - **Use Plugin Pages** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin)
   - **Use Custom Tabs** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
7. Configure polling settings (see below)
8. Click **Save**
9. Restart Jellyfin if using Plugin Pages

### Polling Settings

#### Enable Polling

- Auto-refresh download status
- Recommended: Enabled

#### Poll Interval:

- Default: 30 seconds
- Range: 30-300 seconds
- Lower = more frequent updates, higher server load

### Usage

#### Access Requests Page

- Click "Requests" in sidebar (Plugin Pages)
- Navigate to custom tab (Custom Tabs)
- Direct URL: `/web/index.html#!/jellyfinenhanced/requests`

#### Features

- View active downloads (if enabled)
- View Jellyseerr requests with status
- View reported issues (if enabled)
- Progress bars and ETA for downloads
- Quality and size information
- Filter by status
- Search functionality

### Issues on Downloads Page

View and manage Jellyseerr issues directly from the Requests page.

#### Features

- View all reported issues
- Filter issues by status
- Pagination support
- TMDB detail lookup with caching
- Issue card rendering with styling
- Open issue reporter modal from issues list

#### Configuration

1. Go to plugin settings → Seerr Settings tab
2. Check **"Enable Requests Page"**
3. Check **"Show Seerr Issues Section"**
4. Click **Save**

#### How to use

- Navigate to Requests page
- Issues appear in dedicated section
- Click issue to view details
- Use Jellyseerr reporter modal for management

### Watchlist Sync

Automatically sync requested media to Jellyfin watchlist.

!!! note

    [Requires the KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks) to provide watchlist functionality

#### Features:

- Add requested items to watchlist when available
- Sync Jellyseerr watchlist to Jellyfin
- Prevent re-addition of removed items
- Configurable memory retention

#### Configuration:

- **Add Requested Media to Watchlist** - Auto-add when available
- **Sync Jellyseerr Watchlist** - Sync watchlist items
- **Prevent Watchlist Re-Addition** - Remember removed items
- **Memory Retention Days** - How long to remember (default: 365)


### Icon States

When on the search page, a Jellyseerr icon indicates connection status.

| **Icon** | **State** | **Description** |
| :---: | :--- | :--- |
|<img width="32" alt="active" src="https://github.com/user-attachments/assets/36e9dbab-3fbe-4b5b-b767-a961597ccb96" /> | **Active** | Jellyseerr is successfully connected, and the current Jellyfin user is correctly linked to a Jellyseerr user. <br> Results from Jellyseerr will load along with Jellyfin and requests can be made. |
| <img width="32" alt="noaccess" src="https://github.com/user-attachments/assets/09a3df03-97bf-499f-91a2-3b03e371ac02" /> | **User Not Found** | Jellyseerr is successfully connected, but the current Jellyfin user is not linked to a Jellyseerr account. <br>If plugin auto import is enabled, linking will be attempted automatically. If disabled, import users manually in Jellyseerr. Results will not load until linked. |
| <img width="32" alt="offline" src="https://github.com/user-attachments/assets/bd4ea4cb-94ec-450f-ab1a-13e72960ecec" /> | **Offline** | The plugin could not connect to any of the configured Jellyseerr URLs. <br> Check your plugin settings and ensure Jellyseerr is running and accessible. Results will not load. |


## Troubleshooting

### Connection Issues

**Icon Shows Offline:**

1. Verify Jellyseerr URL is correct and accessible
2. Check Jellyseerr is running
3. Test connection in plugin settings
4. Check server logs for errors

**Icon Shows User Not Found:**

1. Verify "Enable Jellyfin Sign-In" is enabled in Jellyseerr
2. If plugin auto import is enabled, run **Import Users Now** from Jellyfin plugin settings
3. If plugin auto import is disabled, import Jellyfin user manually in Jellyseerr
4. Ensure the user is not selected in the **Blocked users** list
5. Ensure same username in both systems

### Search Not Working

**No Results Appearing:**

1. Check icon status (must be green/active)
2. Verify API key is correct
3. Check browser console for errors
4. Test API endpoints manually

**Results Slow to Load:**

1. Use internal Jellyseerr URL
2. Check network latency
3. Verify Jellyseerr performance
4. Check server resources

### Request Issues

**Cannot Make Requests:**

1. Verify user has request permissions in Jellyseerr
2. Check request limits not exceeded
3. Ensure item not already requested
4. Check Jellyseerr logs

**Requests Not Appearing:**

1. Refresh Jellyseerr page
2. Check request was successful (no errors)
3. Verify user permissions
4. Check Jellyseerr request queue

### TMDB API Issues

If reviews, elsewhere, or Jellyseerr icons not working:

- TMDB API may be blocked in your region
- Check [Jellyseerr troubleshooting](https://docs.seerr.dev/troubleshooting#tmdb-failed-to-retrievefetch-xxx)
- Use VPN or proxy if needed
- Contact ISP about API access

## Advanced Configuration

### URL Mappings

Jellyfin and Seerr URLs can be mapped. This changes the Seerr URLs displayed to users, depending on which URL that access Jellyfin

Useful for mapping Seerr URLs to Jellyfin URls, for **local access** (LAN) and **remote access**

```text title="Formatting"
jellyfin_url|seerr_url
```

!!! example "Examples"

    === "Remote access"

        ```text
        https://jellyfin.mydomain.com|https://jellyseerr.mydomain.com
        ```

    === "Local access"

        ```text
        http://192.168.1.10:8096|http://192.168.1.10:5055
        ```

    === "Remote access + Local access"

        ```text
        https://jellyfin.mydomain.com|https://jellyseerr.mydomain.com
        http://192.168.1.10:8096|http://192.168.1.10:5055
        ```

    === "Using base URLs + paths"

        ```text
        https://example.com/jellyfin|https://example.com/jellyseerr
        ```

### Auto-Request Settings

Automatically request media based on viewing behavior.

#### Auto Season Request:

- Trigger when X episodes remaining in season
- Require all episodes watched (optional)
- Configurable threshold

#### Auto Movie Request:

- Trigger on playback start
- Trigger after X minutes watched
- Check release date (only request if released)
