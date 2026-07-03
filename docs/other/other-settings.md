# Other Settings

Settings for custom branding, icon styles, extras, timeouts, and more — all found under the **Other Settings** tab in the plugin configuration page (**Dashboard** → **Plugins** → **Jellyfin Enhanced** → **Other Settings**).

---

## Custom Branding

Upload your own logos, banners, and favicon to personalize your Jellyfin instance.

!!! info "Requirements"
    On **Jellyfin 10.11**, the [File Transformation plugin](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) must be installed. On **Jellyfin 12**, Enhanced serves branding assets itself — no extra plugin needed.

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
| **Emoji** | Unicode emoji characters — universal, no loading required |
| **Lucide Icons** | Modern, clean icon set |
| **Material UI Icons** | Google Material Design icons |

---

## Active Streams Widget

Adds a live stream counter icon to the Jellyfin header.

| Setting | Default | Description |
|---|---|---|
| **Active Streams Widget** | Off | Enables the stream counter in the header |
| **Show to all users** | Off | When on, non-admin users see a read-only view (no broadcast, no IP addresses) |

See [Other Features — Active Streams Widget](other-features.md#active-streams-widget) for full details.

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

The **Clear All Client Caches** button in the **Enhanced Settings** tab clears tag caches (quality, genre, language, rating, people) across all clients.
