# Jellyfin Enhanced's API

???+ dev "Check version"

    **`/JellyfinEnhanced/version`**

    === "cURL"


        ``` bash title="Bash"
        curl -X GET \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/version"
        ```

    - Jellyfin Server URL (`JELLYFIN_URL`)

<!-- TODO: add more here -->

## Bookmarks API

### Bookmarks Storage Directory

Bookmarks are stored as `bookmarks.json` files:

- `bookmarks.json` are saved in **Jellyfin Server's plugin configurations directory**
- `bookmarks.json` are saved **for each user `userID`**

``` title="bookmarks.json"
/config/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/JELLYFIN_USER_ID/jellyfin-enhanced/bookmarks.json
```

<!-- collapsed -->
??? question "`userID`? `JELLYFIN_USER_ID`?"
    
    > **`userID` (1) is Jellyfin Server's unique ID for each user**
    > { .annotate }
    >    
    > <!-- annotation -->
    > 
    > 1. A.K.A. `X-Jellyfin-User-Id`
    > 
    > `JELLYFIN_USER_ID` is a placeholder for the users' `userID`
    > 
    > <br>
    > 
    > Reference: 
    > 
    > [Jellyfin's API documentation on `/Users`](https://api.jellyfin.org/#tag/User)

    !!! tip 
    
        A simple way to **find which `userID` belongs to which user:**

        - [x] Jellyfin Dashboard: `Users`
        - [x] Click a user's profile
        - [x] The `userID` for that user appears in the URL. For example: `9285e8b54149414941494edb9e464dcd` in the URL `http://localhost:8096/#/dashboard/users/profile?userId=9285e8b54149414941494edb9e464dcd`


``` json title="bookmarks.json: Example Data structure"
{
  "Bookmarks": {
    "unique-bookmark-id": {
      "itemId": "jellyfin-item-id",
      "tmdbId": "12345",
      "tvdbId": "67890",
      "mediaType": "movie" | "tv",
      "name": "Item Name",
      "timestamp": 123.45,
      "label": "Epic scene",
      "createdAt": "2026-01-03T12:00:00.000Z",
      "updatedAt": "2026-01-03T12:00:00.000Z",
      "syncedFrom": "original-item-id"
    }
  }
}
```

### Bookmarks API endpoints

<!-- TODO: these API endpoints do not work? -->
<!--! `404` "No matching view found"        -->

**`/JellyfinEnhanced/user-settings`** (1)
{ .annotate }

<!-- annotation -->

1. Bookmark APIs are under `/user-settings`

<!-- custom admonition `api` for each API endpoint -->
???+ dev "Get Bookmarks"

    **`/JellyfinEnhanced/user-settings?fileName=bookmarks.json`**

    <!-- content tabs for each language/method: code blocks are embedded within -->
    === "cURL"

        ``` bash title="Bash" hl_lines="2-3"
        curl \
            -H 'Authorization: MediaBrowser Token="JELLYFIN_API_KEY"' \
            'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings?fileName=bookmarks.json'
        ```
  
    === "HTTP"

        ``` http
        GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
        Authorization: MediaBrowser Token="JELLYFIN_API_KEY"
        ```

    - Jellyfin Server API key `MediaBrowser Token` (`JELLYFIN_API_KEY`)
    - Jellyfin Server URL `JELLYFIN_SERVER_URL`


???+ dev "Save Bookmarks"

    **`/JellyfinEnhanced/user-settings`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2-10"
            curl -X POST \
                -H 'Content-Type: application/json' \
                -H 'Authorization: MediaBrowser Token="JELLYFIN_API_KEY"' \
                -d '{
                    "fileName": "bookmarks.json",
                    "data": {
                        "Bookmarks": {}
                    }
                }'
                '<JELLYFIN_SERVER_URL>/JellyfinEnhanced/user-settings'
        ```

    === "HTTP"

        <!-- `bash`: provides some syntax highlighting -->

        ``` bash title="HTTP Request"
        POST /JellyfinEnhanced/user-settings
        Authorization: MediaBrowser Token="JELLYFIN_API_KEY"
        Content-Type: application/json

        {
          "fileName": "bookmarks.json",
          "data": { "Bookmarks": {...} }
        }
        ```

    - Jellyfin Server API key (`JELLYFIN_API_KEY`)
    - Jellyfin Server URL `JELLYFIN_SERVER_URL`
    - `bookmarks.json` JSON data

## Seerr Integration API

**`/JellyfinEnhanced/jellyseerr`**

<!-- explain what `JELLYFIN_USER_ID` and `JELLYFIN_API_KEY` are -->
!!! info "Jellyfin Server's API"
    
    These values are from [Jellyfin Server's API:](https://api.jellyfin.org/)

    - `X-Jellyfin-User-Id`:
      - **User Unique ID (UUID)**
      - [Jellyfin's documentation: users](https://jellyfin.org/docs/general/server/users/)
    
    - `X-Emby-Token`: 
      - **API key**

???+ dev "Check Seerr connection"

    **`/JellyfinEnhanced/jellyseerr/status`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2-3"
        curl -X GET \
          -H "X-Emby-Token: JELLYFIN_API_KEY" \
          "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status"
        ```

    - Jellyfin Server API key (`JELLYFIN_API_KEY`)
    - Jellyfin Server User ID (`JELLYFIN_USER_ID`)
    - Jellyfin Server URL (`JELLYFIN_URL`)

    Using [Seerr configuration](../seerr/seerr-settings.md):

    - URL(s)
    - API keys    


???+ dev "Check if user `X-Jellyfin-User-Id` has a successfully linked Seerr account"

    **`/JellyfinEnhanced/jellyseerr/user-status`**

    === "cURL"
    
        ``` bash title="Bash" hl_lines="2-4"
        curl -X GET \
          -H "X-Emby-Token: JELLYFIN_API_KEY" \
          -H "X-Jellyfin-User-Id: JELLYFIN_USER_ID" \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/jellyseerr/user-status"
        ```

    - Jellyfin Server API key `X-Emby-Token` (`JELLYFIN_API_KEY`)
    - Jellyfin Server User ID `X-Jellyfin-User-Id` (`JELLYFIN_USER_ID`)
    - Jellyfin Server URL (`JELLYFIN_URL`)


<!-- TODO: add annotation, on the highlighted line (URL) -->
Example:
``` bash title="Bash" hl_lines="6"
curl -X POST \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request"
```

## Admin Hidden Content API

Admin-only endpoints that let an administrator view and manage what **other** users have hidden. Every endpoint requires a Jellyfin **administrator** token and the **Let admins view and manage other users' hidden content** toggle (**Pages → Hidden Content → Admin Controls**) to be enabled; otherwise it returns `403`. `<USER_ID>` is the 32-character hex (`"N"` format) Jellyfin user id.

### List Users With Hidden Content

Returns each user (except the caller) who has hidden at least one item, with their hidden-item count, used to populate the admin user-filter dropdown.

```bash
curl -X GET \
  -H "X-Emby-Token: <ADMIN_API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content-users"
```

### Get A User's Hidden Content

Returns a single user's hidden content (read-only).

```bash
curl -X GET \
  -H "X-Emby-Token: <ADMIN_API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>"
```

### Unhide Items For A User

Removes one or more items from a user's hidden list. The body is a JSON array of item keys (an `itemId`, or `tmdb-<id>` for items not in the library).

```bash
curl -X POST \
  -H "X-Emby-Token: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '["a1b2c3d4e5f6...", "tmdb-27205"]' \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>/unhide"
```

### Hide Items For A User

Adds one or more items to a user's hidden list (max 200 per call; an item the user hid themselves is never overwritten). The body is a JSON array of hidden-content items.

```bash
curl -X POST \
  -H "X-Emby-Token: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '[{"TmdbId": "27205", "Name": "Inception", "Type": "Movie", "PosterPath": "/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg"}]' \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>/hide"
```