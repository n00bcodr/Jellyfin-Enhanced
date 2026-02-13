## Jellyfin Enhanced API

### Get Plugin Version
```bash
curl -X GET \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/version"
```

## Bookmark API + Info

External apps can access bookmark data via Jellyfin API:

### Get Bookmarks
```http
GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
Authorization: MediaBrowser Token="{your-api-key}"
```

### Save Bookmarks
```http
POST /JellyfinEnhanced/user-settings
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json

{
  "fileName": "bookmarks.json",
  "data": { "Bookmarks": {...} }
}
```

### Bookmark Storage Directory
```
/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json
```


# Jellyseerr API

Plugin exposes proxy endpoints for Jellyseerr:

### Check Connection Status
```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status"
```

### Check User Status
```bash
curl -X GET \
  -H "X-Emby-Token: <JELLYFIN_API_KEY>" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/jellyseerr/user-status"
```

### Perform Search
```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception"
```

### Request Media
```bash
curl -X POST \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request"
```