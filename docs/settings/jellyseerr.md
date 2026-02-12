<!-- GitHub-style title -->
!!! info "Important"
    ### Prerequisites:
    - Jellyseerr instance:
      - API key
      - Jellyfin users **imported to Jellyseerr**

### Step 1: Enable Jellyfin Sign-In in Jellyseerr

1. In Jellyseerr, go to **Settings** → **Users**
2. Enable **"Enable Jellyfin Sign-In"**
3. Save settings

![Jellyfin Sign-In](images/jellyfin-signin.png)

### Step 2: Import Jellyfin Users

1. In Jellyseerr, go to **Users** page
2. Click **"Import Jellyfin Users"**
3. Select users to import
4. Save changes

**User Access:**
- Users WITH access: ![Users with access](images/users-with-access.png)
- Users WITHOUT access: ![Users without access](images/users-no-access.png)

### Step 3: Configure Plugin

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to **Jellyseerr Settings** tab
3. Check **"Show Jellyseerr Results in Search"**
4. Enter your **Jellyseerr URL(s)** (one per line)
   - Use internal URL for best performance
   - Can provide multiple URLs (first successful connection used)
5. Enter your **Jellyseerr API Key**
   - Found in Jellyseerr: **Settings** → **General** → **API Key**
6. Click **"Test Connection"** to verify
7. Enable optional features (see below)
8. Click **Save**

# Optional Features

## Add Requested Media to Watchlist
!!! note "Important"
    
    Requirements:
    - The **[KefinTweaks plugin](https://github.com/ranaldsgift/KefinTweaks) plugin**

- Automatically add items to Jellyfin watchlist when they become available

## Sync Jellyseerr Watchlist to Jellyfin
- Sync your Jellyseerr watchlist items to Jellyfin watchlist
- Items added when they become available in library

## Show 'Report Issue' Button
- Display issue reporting button on item detail pages
- Report video, audio, subtitle, or other problems

## Enable 4K Requests
!!! note "Important"

    Requirements:
    - Jellyseerr instance with **4K configuration**

- Allow users to request 4K quality

## Show Advanced Request Options
- Display advanced options in request modal
- Season selection, quality options, etc.