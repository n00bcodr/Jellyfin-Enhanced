# Other Settings

Settings for custom branding, icon styles, extras, timeouts, and more - all found under the **Other Settings** tab in the plugin configuration page (**Dashboard** → **Plugins** → **Jellyfin Enhanced** → **Other Settings**).

---

## Custom Branding

Upload your own logos, banners, and favicon to personalize your Jellyfin instance.

!!! info "Requirements"
    The [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) must be installed.

| Setting | Description |
|---|---|
| **Icon Transparent** | Header logo shown in the Jellyfin top bar (PNG or SVG, transparent background recommended) |
| **Banner Light** | Splash image shown on the dark-theme login screen |
| **Banner Dark** | Splash image shown on the light-theme login screen |
| **Favicon** | Browser tab icon |

Files are stored in:
```text
/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/custom_branding/
```

After saving, do a hard refresh (++ctrl+f5++) to see changes.

---

## Icon Settings

### Use Icons

Enable or disable icons in toasts, settings panel, and other UI elements.

### Icon Style

Choose the icon set used throughout the plugin UI.

| Style | Description |
|---|---|
| **Emoji** | Unicode emoji characters - universal, no loading required |
| **Lucide Icons** | Modern, clean icon set |
| **Material UI Icons** | Google Material Design icons |

---

## Active Streams Widget

Adds a live stream counter icon to the Jellyfin header.

| Setting | Default | Description |
|---|---|---|
| **Active Streams Widget** | Off | Enables the stream counter in the header |
| **Show to all users** | Off | When on, non-admin users see a read-only view (no broadcast, no IP addresses) |

See [Other Features - Active Streams Widget](other-features.md#active-streams-widget) for full details.

---

## Timeout Settings

Controls how long certain UI elements stay visible before auto-closing.

| Setting | Default | Range | Description |
|---|---|---|---|
| **Help Panel Autoclose Delay** | 8000 ms | 0–30000 ms | How long the Enhanced panel stays open before closing automatically. Set to 0 to disable auto-close. |
| **Toast Duration** | 3000 ms | 1000–10000 ms | How long toast notifications are displayed. |

---

## Letterboxd Integration

Adds a Letterboxd external link to movie detail pages.

| Setting | Description |
|---|---|
| **Enable Letterboxd Links** | Shows a Letterboxd icon/link on movie pages |
| **Show as Text** | Displays the link as text instead of an icon |

---

## MDBList Ratings

Shows TMDB/Rotten Tomatoes/IMDb/etc. ratings on item-details pages and can fill Jellyfin's own rating fields. Based on [xroguel1ke](https://github.com/xroguel1ke/jellyfin_ratings)'s original script.

| Setting | Default | Description |
|---|---|---|
| **Enable MDBList Ratings** | Off | Master switch for the feature |
| **MDBList API Key** | *(empty)* | Free key from [mdblist.com/preferences](https://mdblist.com/preferences/#api). Server-side only. Use **Check Status** to verify it (works before saving) and see live quota/reset time |
| **Show Ratings Row on Item Details** | On | Displays the ratings row on movie/series pages |
| **Fetch Ratings from MDBList** | Off | Enables the **Fetch Ratings from MDBList** scheduled task (see below) - the only one of the two that calls MDBList's API |
| **Fetch Task Reserve** | 400 | The fetch task stops once today's live remaining MDBList quota drops to this many requests |
| **Sync Ratings from MDBList to Jellyfin** | Off | Enables the **Sync Ratings from MDBList to Jellyfin** scheduled task (see below), which writes into Jellyfin's own Community/Critic Rating from whatever the fetch task has already cached |
| **Overwrite Existing Ratings** | Off | Off: only fill an empty rating, never revisit an item once set. On: every run re-sets every item's rating to MDBList's current cached value |
| **Ratings Shown** | *(empty = all)* | Checkbox list (with logos) of which sources show and in what order - reorder with the up/down arrows: `tmdb`, `tomatoes` (RT Critic), `popcorn` (RT Audience), `imdb`, `trakt`, `metacritic`, `metacriticuser`, `letterboxd`, `rogerebert`, `myanimelist`, `anilist`, `master`. Each badge links out to that rating's own page when MDBList has enough information to build one |
| **Show % Symbol** | Off | Appends `%` after each badge's number |

**Scheduled tasks** (Dashboard → Scheduled Tasks, once their respective toggle above is enabled):

| Task | Default trigger | Behavior |
|---|---|---|
| Fetch Ratings from MDBList | None (configure your own) | Calls MDBList's API; stops once live remaining quota hits the Fetch Task Reserve. Safe to schedule frequently - already-fresh titles are skipped |
| Sync Ratings from MDBList to Jellyfin | None (configure your own) | No API calls - purely local, writes from the cache the fetch task already built. Safe to run as often as you like |

See [Other Features - MDBList Ratings](other-features.md#mdblist-ratings) for how the caching/refresh, batching, and quota tracking actually work.

---

## Splash Screen

Shows a custom image while Jellyfin is loading.

| Setting | Description |
|---|---|
| **Enable Custom Splash Screen** | Enables the custom splash screen |
| **Splash Screen Image URL** | Full URL or relative path to the image. Defaults to `/web/assets/img/banner-light.png` |

---

## Default UI Language

Override the language used by the plugin for all users.

- Leave empty to use each user's Jellyfin profile language.
- Accepts a language code (e.g. `en`, `de`, `fr`).

---

## Cache Management

| Button | Effect |
|---|---|
| **Clear Local Storage** | Forces all connected clients to clear their localStorage on next page load. Use to reset client-side settings or fix corrupted state. |
| **Clear Translation Cache** | Forces all clients to re-fetch the latest translations. Useful after a translation update. |

The **Clear All Client Caches** button in the **Enhanced Settings** tab clears tag caches (quality, genre, language, rating, people) across all clients. See [Enhanced Settings - Server-Side Tag Cache](../enhanced/enhanced-settings.md#server-side-tag-cache) for how the underlying tag cache itself is built and kept up to date.

---

## Maintenance Mode

Found under the **Admin** tab. See [Other Features - Maintenance Mode](other-features.md#maintenance-mode) for what each option actually does before enabling.

| Setting | Default | Description |
|---|---|---|
| **Enable Maintenance Mode** | Off | Applies the selected action to affected users immediately on save. Disabling restores everyone automatically |
| **Login Page Banner Message** | *(empty)* | Plain-text banner shown on the login and home pages |
| **Active Session Notification** | *(empty)* | Popup sent to anyone currently watching, reaching all client types |
| **Disable user accounts** | On | Affected users cannot log in until maintenance ends |
| **Disable remote connections** | Off | Blocks affected users from outside the local network; LAN access still works |
| **Affected Users** | All non-admin users | Or select specific users from the list |

!!! note
    Administrators are never affected by either action, regardless of the Affected Users selection.
