# Jellyfin Enhanced's API

``` bash title="Check version of the plugin"
curl -X GET \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/version"
```

## Bookmarks

### Storage Directory

Bookmarks are stored as `bookmarks.json` the server's user data directory

<!-- Bash: so that annotations work (comments) -->
``` bash title="bookmarks.json"
/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json # (1)!
```

1. `userId` is from Jellyfin's API. Example: ``

``` json title="Data structure (Example)"
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

### API Access

Bookmarks can be accessed via API endpoints

!!! info
    
    **API keys are required**

<!-- content tabs for each language/method: each has the content + code blocks embedded within -->
=== "HTTP Request"

    <!-- NOTE: using `bash`, because comments are required for Annotations in code blocks -->
    ``` txt title="Get Bookmarks"
    GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
    Authorization: MediaBrowser Token="{your-api-key}" # (1)!
    ```
    
    <!-- code block annotation -->
    1. Pass your **API key** here

    ``` http title="Save Bookmarks"
    POST /JellyfinEnhanced/user-settings
    Authorization: MediaBrowser Token="{your-api-key}"
    Content-Type: application/json

    {
      "fileName": "bookmarks.json",
      "data": { "Bookmarks": {...} }
    }
    ```

=== "Bash"

    ``` bash title="Get Bookmarks"
    curl \
        -H 'Authorization: MediaBrowser Token="YOUR_API_KEY"' \ # (1)!
        'https://your-jellyfin-server.com/JellyfinEnhanced/user-settings?fileName=bookmarks.json'
    ```

    1. Pass your **API key** here

    ``` http title="Save Bookmarks"
    POST /JellyfinEnhanced/user-settings
    Authorization: MediaBrowser Token="{your-api-key}"
    Content-Type: application/json

    {
      "fileName": "bookmarks.json",
      "data": { "Bookmarks": {...} }
    }
    ```

## Seerr Integration API

Plugin exposes proxy endpoints for Seerr:

### Check Connection Status

Checks if the plugin can connect to any of the configured Seerr URLs using the provided API key.

``` bash title="Bash" hl_lines="2 3"
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status" #(1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096/JellyfinEnhanced/jellyseerr/status`

### Check User Status

Verifies that the currently logged-in Jellyfin user is successfully linked to a Seerr user account.

``` bash title="Bash" hl_lines="4"
curl -X GET \
  -H "X-Emby-Token: <JELLYFIN_API_KEY>" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/jellyseerr/user-status" # (1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096/JellyfinEnhanced/jellyseerr/user-status`

### Perform A Seerr Search

Executes a search query through the Seerr instance for the specified user.

``` bash title="Bash" hl_lines="4"
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception" # (1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096/JellyfinEnhanced/jellyseerr/search?query=Inception`

### Make a Request on Seerr

Submits a media request to Seerr on behalf of the specified user.

- `mediaType` can be `tv` or `movie`
- `mediaId` is the **TMDB ID** of the item

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