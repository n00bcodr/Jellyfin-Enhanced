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
```
/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json
```

The data structure is:
```json
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
```http
GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
Authorization: MediaBrowser Token="{your-api-key}"
```

#### Save Bookmarks
```http
POST /JellyfinEnhanced/user-settings
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json

{
  "fileName": "bookmarks.json",
  "data": { "Bookmarks": {...} }
}
```

## Jellyseerr Integration API

Plugin exposes proxy endpoints for Jellyseerr:

### Check Connection Status

Checks if the plugin can connect to any of the configured Jellyseerr URLs using the provided API key.

```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status"
```

### Check User Status

Verifies that the currently logged-in Jellyfin user is successfully linked to a Jellyseerr user account.

```bash
curl -X GET \
  -H "X-Emby-Token: <JELLYFIN_API_KEY>" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/jellyseerr/user-status"
```

### Perform A Jellyseerr Search

Executes a search query through the Jellyseerr instance for the specified user.

```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception"
```

### Make a Request on Jellyseerr

Submits a media request to Jellyseerr on behalf of the specified user.

- `mediaType` can be `tv` or `movie`\
- `mediaId` is the **TMDB ID** of the item

```bash
curl -X POST \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request"
```