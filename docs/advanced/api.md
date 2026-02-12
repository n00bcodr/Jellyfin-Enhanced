# Bookmark API Access

External apps can access bookmark data via Jellyfin API:

**Get Bookmarks:**
```http
GET /JellyfinEnhanced/user-settings?fileName=bookmarks.json
Authorization: MediaBrowser Token="{your-api-key}"
```

**Save Bookmarks:**
```http
POST /JellyfinEnhanced/user-settings
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json

{
  "fileName": "bookmarks.json",
  "data": { "Bookmarks": {...} }
}
```

**Storage Location:**
```
/config/data/users/{userId}/jellyfin-enhanced/bookmarks.json
```


# Jellyseerr API Endpoints

Plugin exposes proxy endpoints for Jellyseerr:

**Check Connection:**
```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status"
```

**Search:**
```bash
curl -X GET \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception"
```

**Request Media:**
```bash
curl -X POST \
  -H "X-Emby-Token: <API_KEY>" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request"
```
