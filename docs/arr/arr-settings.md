# .arr Links Integration

Quick access to Sonarr, Radarr, and Bazarr (admin only).

## Setup

1. Open plugin settings → **`*arr Settings`** tab
2. Add one or more Sonarr and/or Radarr instances
3. Enable `Show *arr Links on Item Pages`
4. Optional: Enable "Show *arr Tags as Links"
5. Configure tag filters (show/hide specific tags)

### CSS Customization
See [ARR Tag Links CSS](../advanced/css-customization.md/#arr-tag-links) for styling options.

---

## Multi-Instance Configuration

### Instance Fields

Each Sonarr or Radarr instance has the following fields:

| Field | Required | Description |
|---|---|---|
| **Name** | Yes | Display name shown in dropdowns (e.g., `TV Shows`, `Anime`, `4K Movies`) |
| **URL** | Yes | Base URL of the instance (e.g., `http://192.168.1.100:8989`) |
| **API Key** | Yes | API key from the instance's Settings → General page |
| **URL Mappings** | No | Per-instance URL remapping for reverse-proxy setups |
| **Enabled** | — | Toggle to disable without deleting; defaults to on |

### Adding an Instance

1. Open plugin settings → ***arr Settings** tab
2. Click **"Add Sonarr Instance"** or **"Add Radarr Instance"**
3. Fill in Name, URL, and API Key
4. Optionally add URL Mappings
5. Click **Save**

### Disabling an Instance

Toggle the **Enabled** switch off to skip an instance in all fan-out paths (arr links, calendar, queue monitoring, tag sync) without removing its configuration. Re-enable it at any time.

!!! tip
    Use the Enabled toggle during maintenance windows or when temporarily replacing an instance. Your URL and API key are preserved.

### URL Mappings (per-instance)

Per-instance URL mappings override the global mapping for that instance. Format is the same as the global field:

```text
internal_url|external_url
```

**Example:**
```text
http://sonarr-anime:8989|https://anime.example.com
```

---

## Link Behaviour

### Single Instance

When only one instance matches an item, the link renders as a plain icon (no badge). To always show the status colour border and episode/file count on single-instance links, enable:

> **"Show status badge for single-instance links"**

### Multiple Instances (Dropdown)

When more than one instance contains the item, the link becomes a dropdown. Each entry shows:

- A colour-coded status dot
- Instance name
- Episode count (Sonarr) or download status (Radarr)
- File size on disk

**Status colours:**

| Colour | Meaning |
|---|---|
| Green | Complete — all episodes/file present |
| Amber | Partial — some episodes missing |
| Grey | Missing — not in this instance |

---

## Legacy Single-Instance Fields

The original `SonarrUrl`, `SonarrApiKey`, `RadarrUrl`, and `RadarrApiKey` fields are preserved for downgrade safety. If the multi-instance list is empty, the plugin falls back to these fields automatically.

!!! note
    Once you add instances via the new UI, the legacy fields are no longer used for arr links. They are not deleted, so downgrading to an older plugin version restores single-instance behaviour.

---

## Calendar Page Settings

Found in the ***arr Settings** tab under "Calendar Page".

| Setting | Description |
|---|---|
| **Enable Calendar Page** | Enables the calendar view for upcoming Sonarr/Radarr releases |
| **Use Plugin Pages** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)) |
| **Use Custom Tabs** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **First Day of Week** | Monday or Sunday |
| **Time Format** | 12-hour (`5pm/5:30pm`) or 24-hour (`17:00/17:30`) |
| **Highlight Favorites** | Highlights favorite shows/movies based on Jellyfin favorites |
| **Highlight Watched Series** | Highlights series you are currently watching |

After enabling with Plugin Pages, restart Jellyfin for the sidebar link to appear.

Direct URL: `/web/index.html#!/jellyfinenhanced/calendar`

---

## Requests Page Settings

Found in the ***arr Settings** tab under "Requests Page (Downloads)".

| Setting | Description |
|---|---|
| **Enable Requests Page** | Enables a dedicated page showing active downloads from Sonarr/Radarr |
| **Use Plugin Pages** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages)) |
| **Use Custom Tabs** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **Enable Auto-Refresh** | Automatically refreshes download status |
| **Poll Interval** | How often to refresh, in seconds (30–300, default: 30) |

!!! note
    The Requests page for downloads is separate from the Seerr Requests page. Both can be enabled independently. The Seerr Requests page (showing media requests and issues) is configured in the **Seerr Settings** tab.

Direct URL: `/web/index.html#!/jellyfinenhanced/downloads`
