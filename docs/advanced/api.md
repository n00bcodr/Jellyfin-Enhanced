# Jellyfin Enhanced's API

Jellyfin Enhanced adds features like **Bookmarks** and **User Reviews/Ratings** that live entirely in this plugin, not in Jellyfin Server itself. A user of any other Jellyfin client (Wholphin, Streamyfin, Afinity, a custom app, etc.) only gets these features if that client talks to the endpoints on this page directly, over plain HTTP with a Jellyfin token or API key. No client-side plugin, SDK, or Jellyfin Enhanced code is required, just an HTTP client and the request shapes documented below.

Requirements before any of this works:

- The Jellyfin Enhanced plugin must be installed and enabled on the target server
- Your app needs a Jellyfin auth token (per-user, from that user logging in) or a server API key, exactly as it would for any other Jellyfin Server request. See [Quick Start](#quick-start-normal-user-vs-admin) below for how to get one and which calls need which
- Bookmarks and Reviews both use **TMDB IDs**, not Jellyfin item IDs, to key data server-side (bookmarks also take an `itemId` when adding one, see [Bookmarks API endpoints](#bookmarks-api-endpoints))

What this lets a client build, using only these HTTP endpoints:

- A "bookmark this moment" button on the video player, and a bookmarks list/library screen (see [Bookmarks API](#bookmarks-api))
- Star ratings and written reviews on a movie/show/season/episode details page, shared across every user on the server (see [Reviews API](#reviews-api))

**`/JellyfinEnhanced`**

???+ dev "Check version"

    **`/JellyfinEnhanced/version`**

    === "cURL"


        ``` bash title="Bash" hl_lines="2"
        curl -X GET \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/version"
        ```

    - Jellyfin Server URL (`JELLYFIN_URL`)

<!-- TODO: add more here -->

## Quick Start: Normal User vs Admin

There are two distinct ways to call the Bookmarks and Reviews endpoints below, depending on who is calling and whose data they are touching.

### As a normal user, your own data only

Log in as that user to get a per-user access token, then use that token in `Authorization: MediaBrowser Token="..."` for every call. With this token you can only read or write your own bookmarks and your own review, never another user's.

??? question "How do I get `JELLYFIN_USER_ACCESS_TOKEN`?"

    Call Jellyfin's own `POST /Users/AuthenticateByName` with that user's username and password. This is not a Jellyfin Enhanced endpoint, it is part of Jellyfin Server's own API.

    === "cURL"

        ``` bash title="Bash" hl_lines="2-4"
        curl -X POST \
          -H 'Content-Type: application/json' \
          -H 'X-Emby-Authorization: MediaBrowser Client="MyApp", Device="MyApp", DeviceId="my-app-1", Version="1.0.0"' \
          -d '{"Username": "JELLYFIN_USERNAME", "Pw": "JELLYFIN_PASSWORD"}' \
          'JELLYFIN_SERVER_URL/Users/AuthenticateByName'
        ```

    The `X-Emby-Authorization` header is required, Jellyfin rejects the request without it even though no token exists yet at this point. `Client`, `Device`, `DeviceId`, and `Version` can be any values that identify your app.

    The response body includes an `AccessToken` field, that is `JELLYFIN_USER_ACCESS_TOKEN`. It does not expire on its own, it stays valid until the user signs out or an admin revokes it from the Jellyfin Dashboard.

    Alternatively, [Quick Connect](https://jellyfin.org/docs/general/clients/quick-connect/) gets a token without the app ever handling the user's password.

- Post your own review: `POST /JellyfinEnhanced/reviews/{mediaType}/{tmdbId}`
- Delete your own review: `DELETE /JellyfinEnhanced/reviews/{mediaType}/{tmdbId}`
- Add a bookmark for yourself: `POST /JellyfinEnhanced/user-settings/{yourUserId}/bookmark.json/add`
- Remove a bookmark for yourself: `DELETE /JellyfinEnhanced/user-settings/{yourUserId}/bookmark.json/{bookmarkId}`

### As an admin, any user's data

Generate a server API key from the Jellyfin Dashboard (Settings > API Keys), created by an Administrator account. Use that key in `X-Emby-Token` (Reviews) or `Authorization: MediaBrowser Token="..."` (Bookmarks), and put the target user's ID directly in the URL. This is the pattern a 3rd-party app should use to manage bookmarks and reviews for every user with a single credential, with no per-user login required.

- Post a review as a specific user: `POST /JellyfinEnhanced/reviews/admin/{userIdN}/{mediaType}/{tmdbId}`
- Delete a specific user's review: `DELETE /JellyfinEnhanced/reviews/admin/{userIdN}/{mediaType}/{tmdbId}`
- Add a bookmark for a specific user: `POST /JellyfinEnhanced/user-settings/{userId}/bookmark.json/add`
- Remove a bookmark for a specific user: `DELETE /JellyfinEnhanced/user-settings/{userId}/bookmark.json/{bookmarkId}`

A non-admin token used against another user's `{userId}` is rejected. Full request and response details for every endpoint are below.

!!! tip "Ratings vs. text reviews"

    `{tmdbId}` in every Reviews endpoint above also accepts `{tmdbId}:s{season}` or `{tmdbId}:s{season}:e{episode}`, so a TV show can carry its own review plus separate ones per season/episode. A review's `rating` (1-5) and `content` are independent: send `rating` alone for a star-rating-only UI, `content` alone for text-only, or both. See [Rating and content rules](#rating-and-content-rules) in the Reviews API section.

## Bookmarks API

!!! info "New in v11.13.0.0"

    The additive `bookmark.json/add` and `bookmark.json/{bookmarkId}` endpoints below, and admin access to any user's bookmarks via a server API key, are new in v11.13.0.0. Earlier versions only support reading or replacing the whole file with a per-user access token.

### Bookmarks Storage Directory

Bookmarks are stored as `bookmark.json` (singular), inside a folder named after the user's ID, under the plugin's own configuration directory:

``` title="bookmark.json"
{JELLYFIN_DATA_DIR}/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/JELLYFIN_USER_ID/bookmark.json
```

`JELLYFIN_USER_ID` here is the user's GUID with hyphens stripped and lowercased (e.g. `9285e8b541494149...`), regardless of the casing or format used in the URL.

??? question "`userID`? `JELLYFIN_USER_ID`?"

    > **`userID` is Jellyfin Server's unique ID for each user**
    > { .annotate }
    >
    > <!-- annotation -->
    >
    > `JELLYFIN_USER_ID` is a placeholder for the user's `userID`
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

``` json title="bookmark.json: Example Data structure"
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

### Authentication: two ways to call these

- **As the user themselves**: pass a per-user access token (obtained by that user logging in) in `Authorization: MediaBrowser Token="..."`. Works for the user's own `JELLYFIN_USER_ID` only.
- **As an admin, for any user**: pass a server **Administrator** API key. The plugin will let an Administrator key act on any `JELLYFIN_USER_ID`, which is what lets a 3rd-party app manage bookmarks for every user with a single credential.

A non-admin user calling with someone else's `JELLYFIN_USER_ID` is rejected.

### Bookmarks API endpoints

`bookmark.json` is one of several per-user settings files served under `/user-settings/{userId}/{file}` (the same pattern covers `settings.json`, `shortcuts.json`, `elsewhere.json`, and `hidden-content.json`).

???+ dev "Get Bookmarks"

    **`/JellyfinEnhanced/user-settings/{userId}/bookmark.json`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2-3"
        curl -X GET \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_TOKEN"' \
          'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json'
        ```

    === "HTTP"

        ``` http
        GET /JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json
        Authorization: MediaBrowser Token="JELLYFIN_TOKEN"
        ```

    - `JELLYFIN_TOKEN`: a per-user access token for `JELLYFIN_USER_ID`, or an Administrator API key
    - Jellyfin Server URL `JELLYFIN_SERVER_URL`

    Returns the `bookmark.json` contents directly, not wrapped. An empty `{"Bookmarks": {}}` if the user has none yet.

???+ dev "Replace all Bookmarks"

    **`/JellyfinEnhanced/user-settings/{userId}/bookmark.json`**

    Overwrites the whole file. Use the additive endpoint below instead if you only want to add or remove one bookmark.

    === "cURL"

        ``` bash title="Bash" hl_lines="2-6"
        curl -X POST \
          -H 'Content-Type: application/json' \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_TOKEN"' \
          -d '{
                "Bookmarks": {}
              }' \
          'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json'
        ```

    === "HTTP"

        ``` http
        POST /JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json
        Authorization: MediaBrowser Token="JELLYFIN_TOKEN"
        Content-Type: application/json

        { "Bookmarks": { ... } }
        ```

    - `JELLYFIN_TOKEN`: a per-user access token for `JELLYFIN_USER_ID`, or an Administrator API key
    - Jellyfin Server URL `JELLYFIN_SERVER_URL`
    - The request body is the raw bookmarks object itself, not wrapped in `{ "fileName": ..., "data": ... }`.

???+ dev "Add one Bookmark"

    **`/JellyfinEnhanced/user-settings/{userId}/bookmark.json/add`**

    Adds a single bookmark without touching the rest of the file. The server generates the bookmark ID and timestamps and returns the new ID.

    === "cURL"

        ``` bash title="Bash" hl_lines="2-4"
        curl -X POST \
          -H 'Content-Type: application/json' \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_TOKEN"' \
          -d '{
                "itemId": "jellyfin-item-id",
                "tmdbId": "1949",
                "mediaType": "movie",
                "name": "Zodiac",
                "timestamp": 1234.5,
                "label": "Great scene"
              }' \
          'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json/add'
        ```

    - `JELLYFIN_TOKEN`: a per-user access token for `JELLYFIN_USER_ID`, or an Administrator API key
    - `itemId` is required. `tmdbId`, `tvdbId`, `mediaType`, `name`, `timestamp`, `label`, and `syncedFrom` are all optional.

    Response: `{"success": true, "id": "Bm_1234567890_abc123xyz"}`

???+ dev "Remove one Bookmark"

    **`/JellyfinEnhanced/user-settings/{userId}/bookmark.json/{bookmarkId}`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2"
        curl -X DELETE \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_TOKEN"' \
          'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/bookmark.json/BOOKMARK_ID'
        ```

    - `BOOKMARK_ID` is the ID returned by the add endpoint, or a key from the `Bookmarks` object returned by the get endpoint
    - Returns `404` with `{"success": false, "removed": false}` if no bookmark with that ID exists

## Reviews API

!!! info "New in v11.13.0.0"

    Admin access to any user's reviews via a server API key is new in v11.13.0.0. Earlier versions only support reading reviews or writing your own review with a per-user access token.

User reviews and ratings, shared across all users on the server. Each review is a `content` string and an optional 1-5 star `rating`, keyed by author + item, and reviews for one item are stored together in a single shared `reviews.json` (not a per-user file). This is the API to use if you want to build star ratings, review lists, or an average-rating badge for a client.

### Rating and content rules

Every write endpoint below (self or admin) validates the same `ReviewPayload` body:

- `content` (string, optional): trimmed server-side; rejected with `400` if longer than 2000 characters
- `rating` (integer, optional): must be `1`-`5` inclusive, or omitted; `0`, `6`, or a non-integer value is rejected with `400`
- At least one of `content` or `rating` must be present, an empty payload (`{}`) is rejected with `400 {"success": false, "message": "A rating or review text is required."}`
- This means a **ratings-only** review (`{"rating": 4}`, no text) and a **text-only** review (`{"content": "..."}`, no rating) are both valid

### Reviewing a season or episode of a TV show

`{tmdbId}` in the URL is not just the bare TMDB ID, it also accepts two extended forms so a single `mediaType: tv` item can carry separate reviews per season or per episode:

- `{tmdbId}` — the show as a whole, e.g. `1399`
- `{tmdbId}:s{season}` — a specific season, e.g. `1399:s1`
- `{tmdbId}:s{season}:e{episode}` — a specific episode, e.g. `1399:s1:e1`

Any other shape (letters, missing digits, extra segments) is rejected with `400 {"message": "Invalid TmdbId."}`. `mediaType` must always be `movie` or `tv`, both `movie:s1` and any `mediaType` other than `movie`/`tv` are rejected the same way. URL-encode the colons (`%3A`) if your HTTP client doesn't do it for you.

???+ dev "Get reviews for an item"

    **`/JellyfinEnhanced/reviews/{mediaType}/{tmdbId}`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2"
        curl -X GET \
          -H "X-Emby-Token: JELLYFIN_API_KEY" \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/reviews/movie/TMDB_ID"
        ```

    - Jellyfin Server API key (`JELLYFIN_API_KEY`)
    - `mediaType`: `movie` or `tv`
    - `TMDB_ID`: the item's TMDB ID, or one of the season/episode forms above

    A plain API key is enough to read reviews, there is no per-user identity involved here. Any authenticated caller (per-user token or API key) sees every non-hidden reviewer's review; an admin caller always sees every review, including ones from hidden or disabled authors, for moderation.

    Response:

    ``` json title="200 OK"
    {
      "reviews": [
        {
          "userId": "9285e8b541494149...",
          "userName": "alice",
          "tmdbId": "TMDB_ID",
          "mediaType": "movie",
          "content": "Great movie!",
          "rating": 5,
          "createdAt": "2026-01-03T12:00:00.000Z",
          "updatedAt": "2026-01-03T12:00:00.000Z"
        }
      ]
    }
    ```

    - `reviews` is `[]`, never missing, when nobody has reviewed the item yet
    - `rating` is `null` for a text-only review
    - Average rating and review count are not pre-computed by the server, a client wanting those should reduce over the `rating` field of the returned array itself

???+ dev "Add or edit your own review"

    **`/JellyfinEnhanced/reviews/{mediaType}/{tmdbId}`**

    Creates your review if you don't have one for this item yet, or updates it (both `content` and `rating` are replaced, not merged) if you do.

    === "cURL"

        ``` bash title="Bash" hl_lines="2-3"
        curl -X POST \
          -H "Content-Type: application/json" \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_USER_ACCESS_TOKEN"' \
          -d '{"content": "Great movie!", "rating": 5}' \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/reviews/movie/TMDB_ID"
        ```

    - A per-user access token (`JELLYFIN_USER_ACCESS_TOKEN`), this writes the review under whichever user the token belongs to
    - `rating` is optional, omit it to leave a text-only review; see [Rating and content rules](#rating-and-content-rules) above for the accepted values
    - Response: `{"success": true}`. A `400` with `{"success": false, "message": "..."}` explains which validation rule failed

???+ dev "Delete your own review"

    **`/JellyfinEnhanced/reviews/{mediaType}/{tmdbId}`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2"
        curl -X DELETE \
          -H 'Authorization: MediaBrowser Token="JELLYFIN_USER_ACCESS_TOKEN"' \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/reviews/movie/TMDB_ID"
        ```

    - Response: `{"success": true}` whether or not a review existed, this endpoint does not report `404` for a no-op delete (unlike the bookmark and admin-review delete endpoints below)

???+ dev "Add or edit a review as a specific user (admin)"

    **`/JellyfinEnhanced/reviews/admin/{userIdN}/{mediaType}/{tmdbId}`**

    Lets an Administrator API key create or update a review for any user, identified by an explicit `userIdN`. This is what a 3rd-party app should use to manage reviews for multiple users with one credential. Creates the review if none exists yet for that user and item, or updates it otherwise.

    === "cURL"

        ``` bash title="Bash" hl_lines="2-3"
        curl -X POST \
          -H "Content-Type: application/json" \
          -H "X-Emby-Token: JELLYFIN_API_KEY" \
          -d '{"content": "Great movie!", "rating": 5}' \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/reviews/admin/JELLYFIN_USER_ID/movie/TMDB_ID"
        ```

    - Jellyfin Server **Administrator** API key (`JELLYFIN_API_KEY`)
    - `JELLYFIN_USER_ID` here is the 32-character hex form with no dashes (the same format returned by the get-bookmarks endpoint, not the dashed form shown in the Jellyfin dashboard URL)
    - Same [rating and content rules](#rating-and-content-rules) as the self-review endpoint above; `rating` still only allows `1`-`5` or omitted, an admin key does not bypass validation
    - Response: `{"success": true}`. A non-admin key gets `403 Forbidden`, a malformed `userIdN` gets `400`

???+ dev "Delete a specific user's review (admin)"

    **`/JellyfinEnhanced/reviews/admin/{userIdN}/{mediaType}/{tmdbId}`**

    === "cURL"

        ``` bash title="Bash" hl_lines="2"
        curl -X DELETE \
          -H "X-Emby-Token: JELLYFIN_API_KEY" \
          "JELLYFIN_SERVER_URL/JellyfinEnhanced/reviews/admin/JELLYFIN_USER_ID/movie/TMDB_ID"
        ```

    Returns `404` with `{"success": false, "removed": false}` if no review exists for that user and item.

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