## Jellyfin Enhanced API

### Get Plugin Version

Checks the installed version of the Jellyfin Enhanced plugin:

```bash
curl -X GET \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/version"
```

## Bookmark API + Info

### Storage Directory
Bookmarks are stored in the server's user data directory at:
``` title="bookmarks.json path" hl_lines="1"
/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json
```

The data structure is:
``` json title="bookmarks.json data structure"
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

External applications can read and write bookmarks using the Jellyfin Enhanced API endpoints

#### Get Bookmarks

<!-- TODO: change to `curl` ? -->
``` http
GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
Authorization: MediaBrowser Token="{your-api-key}"
```

#### Save Bookmarks

<!-- TODO: change to `curl` ? -->
``` http
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

``` bash title="Bash" hl_lines="3"
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status" #(1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096:JellyfinEnhanced/jellyseerr/status`

### Check User Status

Verifies that the currently logged-in Jellyfin user is successfully linked to a Seerr user account.

``` bash title="Bash" hl_lines="4"
curl -X GET \
  -H "X-Emby-Token: <JELLYFIN_API_KEY>" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/jellyseerr/user-status" # (1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096:JellyfinEnhanced/jellyseerr/user-status`

### Perform A Seerr Search

Executes a search query through the Seerr instance for the specified user.

``` bash title="Bash" hl_lines="4"
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception" # (1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096:JellyfinEnhanced/jellyseerr/search?query=Inception`

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
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request" # (1)!
```

<!-- code block annotation -->
1. Example: `http://localhost:8096:JellyfinEnhanced/jellyseerr/request`