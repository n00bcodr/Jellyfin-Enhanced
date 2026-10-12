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

The original `SonarrUrl`, `SonarrApiKey`, `RadarrUrl`, and `RadarrApiKey` fields come from before multi-instance support. When the plugin starts and finds them set while no instance in the list has both a URL and an API key, it uses them exactly like the old fallback: the instance at that address gets the legacy key, or a new instance (named `Sonarr` / `Radarr`) is added. The URL fields are still kept in step with the first instance; once an instance holds a key, the legacy API key fields are no longer stored (see [Stored credentials](#stored-credentials) for downgrading).

---

## Stored credentials

Every API key Jellyfin Enhanced stores (Sonarr and Radarr instances, Seerr, TMDB, MDBList, Shoko, and the usage-statistics install secret) is kept in a separate file, `secrets.json`, in the plugin's data folder (`<config>/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/`). The file is readable by the Jellyfin user only and is never served by Jellyfin or by the plugin. The plugin's settings file (`Jellyfin.Plugin.JellyfinEnhanced.xml`) and the dashboard only ever see a placeholder such as `••••••••3f9a` (the last four characters, so you can tell keys apart).

- **On upgrade** the plugin moves existing keys out of the settings file on its first start. Nothing needs re-entering.
- **On the settings page** a saved key shows as that placeholder with **Replace** and **Clear** buttons. Saving without touching it keeps the key. **Test** buttons check the saved key on the server.
- **A saved key stays with its server.** It is only tested against, and only kept for, the address (scheme, host and port) it was saved for. When you change an instance's URL, the Seerr URLs or the Shoko URL to another server, the key field asks for the key again; saving without it removes the old key from that connection.
- **Import from Seerr** reads the Sonarr/Radarr keys on the server; the browser never receives them. An imported key is only saved for the address Seerr reported and only within 30 minutes; otherwise the page tells you after saving which instances need their key entered.
- **Backups:** Jellyfin's own backups don't include plugin data. Use [Backup & restore](#backup-restore): it can include the keys, encrypted with a passphrase. If you copy files by hand instead, keep `secrets.json` together with the settings file; without it, the keys have to be entered again (the plugin logs which ones are missing).
- **If `secrets.json` can't be read** (for example it was edited by hand and is no longer valid JSON), the plugin leaves it exactly as it is, logs an error and treats the stored keys as unavailable; it never removes or overwrites them meanwhile, and reads the file again every 30 seconds. Fix the file (or restore it from a backup) and the keys work again. Keys you type while it is unreadable, or while the folder can't be written, are kept in the settings file as before and move into `secrets.json` on a later start.
- **An unreadable Sonarr/Radarr instance list** (invalid JSON in the settings file) is moved into `secrets.json` as `SonarrInstances.corrupt` / `RadarrInstances.corrupt`, since it may contain keys; the settings page shows it as corrupt and offers a reset.

### Downgrading to a version without the secrets file

Older versions expect the keys in the settings file. Before installing an older version, write them back with this request as an administrator, then install the older version and restart:

```bash
curl -X POST "http://<jellyfin>/JellyfinEnhanced/admin/secrets/rollback" \
  -H 'Authorization: MediaBrowser Token="<API key from Dashboard > API Keys>"' \
  -H "Content-Type: application/json" \
  -d '{"confirm":"write-credentials-to-plugin-config"}'
```

`secrets.json` keeps its copy. If this version starts again instead, it simply moves the keys back out. Without the request, you can also copy the values from `secrets.json` into the settings file by hand while Jellyfin is stopped (`arr:<instance id>` entries belong to the `ApiKey` of the instance with that `Id`).

---

## How Sonarr/Radarr data is read

The Requests page (queue and history), the Calendar, the item-page links and the request cards don't
call Sonarr or Radarr while you browse. Jellyfin Enhanced keeps a copy of what they need in memory and
refreshes it in the background while a page uses it:

| Data | Refreshed | Used by |
|---|---|---|
| Download queue (every row, read page by page) | At the Requests page's **Poll Interval** while the page is open or something is downloading, otherwise every 5 minutes | Requests page |
| Recent history (the newest 1000 records, then only what's new; read in full again every hour) | Same as the queue | Requests page history |
| Calendar (from the start of last month to about three months ahead) | Every 15 minutes | Calendar page; other months are read when you open them and kept for 15 minutes |
| Library (every movie or series with its ids and tags) | Every 15 minutes | Item-page links, request-card links, "not in Sonarr/Radarr" on requests, tag sync |

Nothing is read until a page asks for it, and data nobody has looked at for a while stops being
refreshed. After a restart the library list starts from a cached copy (in the `arr-state` folder of
the plugin's data folder) and is refreshed in the background. A title you just added in Sonarr or
Radarr can take up to 15 minutes to get its link, and a change to the calendar (a title added or
removed) up to 15 minutes to show.

Every read checks that the address really is Sonarr or Radarr (a Sonarr address in a Radarr box shows
"wrong app at this URL" instead of odd results) and never follows a redirect, the same as the **Test**
button. An instance that can't be read shows a short reason on the page; administrators also see the
details. The **arr/admin/state** API shows what's held and how old it is (see [API](../advanced/api.md)).

---

## Backup & restore

Jellyfin's own backups don't include plugin data. The plugin's **Admin** tab has a **Backup & Restore**
section:

- **Download a backup** saves one zip with the plugin settings, every user's Jellyfin Enhanced settings
  (shortcuts, hidden content, bookmarks, reviews, …), custom branding and the plugin's other stores.
  Caches are left out. API keys and passwords are either left out (enter them again after restoring
  on a new server) or included, encrypted with a passphrase of at least 12 characters.
- **Restore** checks the file first (its checksums, and the passphrase if it has keys), saves a copy
  of the current data (and of `secrets.json`) to `backups` in the plugin's data folder, whatever backup
  folder you chose, then puts the backup's files and settings in place. Files the backup doesn't have
  are kept, and so is this server's arr action audit log. Restart Jellyfin afterwards so every part
  reads the restored data. The usage-statistics settings of the server you restore on are kept.
- A key saved on this server is only kept for the address it was saved for: when a backup without keys
  points Seerr, Shoko or an arr instance at another address than this server uses now, that key is
  left out and the restore lists it to enter again.
- **Scheduled backups**: the task **Back up Jellyfin Enhanced data** (Dashboard → Scheduled Tasks, no
  trigger until you add one) writes a backup to the chosen folder (default: `backups` in the plugin's
  data folder; pick another disk to survive a disk failure) and keeps the newest copies. To include
  the keys, tick the option and save a passphrase; the task fails rather than quietly leaving them out
  when no passphrase is saved.

To restore by hand instead: stop Jellyfin, unzip `config/Jellyfin.Plugin.JellyfinEnhanced.xml` to
`<config>/plugins/configurations/` and the `data/` folder's contents to
`<config>/plugins/configurations/Jellyfin.Plugin.JellyfinEnhanced/`, then start Jellyfin. Keys in an
encrypted backup can only be restored through the page.

---

## Requests & downloads (new)

**Experimental, off by default.** A reworked Sonarr/Radarr integration that is being delivered in stages. With it off, everything on the *arr tab works exactly as described above.

Turning it on currently adds:

- **Per-instance settings** in each Sonarr/Radarr box:

    | Field | Description |
    |---|---|
    | **Role** | Standard, 4K (UHD), Anime or Other. Later stages use it to pick the instance for each request: the default instance of the matching role. A 4K request is never sent to a standard instance; anime falls back to the standard instance when there is no anime one. |
    | **Default for this role** | Which instance to use when several share a role. |
    | **Linked libraries** | The Jellyfin libraries whose files this instance manages. |
    | **Path mappings** | Only when the arr and Jellyfin see the same folders under different paths: one `arr_path|jellyfin_path` per line. |

- **Check connections**: tests every saved instance. It confirms the URL really is Sonarr or Radarr (a Radarr address in a Sonarr box fails), that the key works and the version is supported (Sonarr v4+, Radarr v4+), and lists the instance's own health warnings.

Each instance also gets a permanent id the first time the plugin starts with this version, whether or not the switch is on.

### Requests page, Manage and Seerr's window (phase 1)

Under **Show where things have got to (status on pages)**:

| Setting | Default | What it does |
|---|---|---|
| **Show status badges on posters** | On | Corner badge on poster cards while something downloads, is almost ready or takes longer than usual |
| **"Still looking" after (hours)** | 24 | When "Looking for it" becomes "Still looking, we'll keep trying" (1-720) |
| **What the family calls you** | (empty: "the admin") | Used in family texts: "Waiting for Dad to OK it" |
| **Requests page** | On | The "Requests" sidebar page (`#/requests`): everyone's own requests (waiting for an OK, on the way, not out yet, said no), Coming soon and Ready. Administrators also get the Downloads and Calendar pages as tabs when those pages are on; with it on, the Downloads page's own sidebar link reads "Downloads" |
| **Manage button for administrators** | On | The Manage panel on details pages, Seerr's more-info window and the Requests page: explanation, Search now, Open in Sonarr/Radarr, versions across instances, timeline, Seerr's requests |
| **Show the status in Seerr's more-info window** | On | The pill and journey for titles not in the library yet (needs "Use the more-info window" on the Seerr tab) |
| **Read Seerr's requests every (minutes)** | 5 | How often Seerr's request list is read in the background (1-60); every 30 seconds while someone has the Requests page open, and about a second after a request is made, approved, declined or removed through Jellyfin Enhanced |

Requests come from Seerr (Seerr tab), matched to Jellyfin users through Seerr's own user import; with Seerr off
the Requests page says requests aren't set up, and statuses still work from Sonarr/Radarr alone. Seerr is read with
its API key in the background only: opening a page never calls Seerr, Sonarr or Radarr. **Search now** asks that
Sonarr/Radarr to search for the movie, series, season or episode the page is about; each one is recorded in the
arr action audit log (who, when, the outcome and how the search ended).

### Live updates (phase 1)

**Show where things have got to (status on pages)**, under the master switch, shows each title's status
(details-page pill and journey, poster badges, episode chips) and keeps it current within seconds, without a
page reload. Off by default; it needs **Requests & downloads (new)**.

- **Live connection (nothing to set up).** Jellyfin Enhanced keeps one connection open to each enabled
  Sonarr/Radarr, the same kind of connection their own web pages use, and reads the queue, history or a
  single title again whenever one reports a change. The API key travels in a request header only. The
  connection reconnects by itself (waiting 2 seconds, then longer, up to 2 minutes), and after every
  reconnect it reads the queue, history and library again (the library at most once a minute per
  instance; a quicker reconnect gets its library read when the minute is up), because the arrs don't
  replay what was missed. Each instance box has **Live updates from this Sonarr/Radarr** to turn
  it off for one instance; status then refreshes every 30 seconds while someone is looking.
- **Webhooks (optional, instant).** A second path for downloads, imports, deletions and health events.
  **Live updates status** lists each instance with its connection and webhook, and offers:
    - **Set up instant updates** / **Repair webhook**: after you agree, adds (or updates) a webhook named
      "Jellyfin Enhanced" in that app (Settings → Connect) pointing at
      `<Jellyfin's address>/JellyfinEnhanced/arr/hook/<instance id>`, with a secret header and every
      event the app offers switched on. The app sends a test event when it saves, so a success also
      proves it can reach Jellyfin. Doing it again updates the same webhook (never a second copy) and
      keeps the secret. Every change is recorded in the arr action audit log.
    - **Copy-paste set-up**: the address, header and triggers to enter by hand instead. This is the only
      place the secret is shown (also recorded in the audit log).
    - **Remove webhook**: deletes Jellyfin Enhanced's webhook from the app and forgets the secret, so
      anything still sending with it is refused. **Live updates status** and removal stay available with
      phase 1 off (only the master switch is needed), so webhooks can be cleaned up after turning it off.

    Set **Jellyfin's address as Sonarr/Radarr see it** first (often the container name or LAN address,
    for example `http://jellyfin:8096`). A webhook is only ever a hint: Jellyfin Enhanced reads the
    app again before showing anything, never acts on what the webhook says, refuses calls without the
    right secret (compared in constant time), limits how often an instance can call and how often an
    address can fail (a failing address never blocks the app's own correctly signed calls), and
    ignores bodies over 1 MiB. The status line warns when a set-up webhook has been silent
    for a day although the app imported something.
- **In the browser.** Pages showing download status long-poll Jellyfin Enhanced (never Sonarr or
  Radarr) while the tab is visible and update the pill, badges and chips in place when a title they show
  changes, and only hear about titles the person may open in Jellyfin (an
  episode or season Jellyfin hides from them stays hidden even when its series is visible). A title
  that isn't in Jellyfin yet is announced only to people with no content limit (parental rating,
  blocked or allowed tags, unrated items, blocked folders), and only when they can open one of the
  libraries the instance holding it is linked to (if it is linked to any).

---

## Shoko

Adds upcoming anime episodes from your Shoko Server collection to the [Calendar page](#calendar-page-settings), alongside Sonarr/Radarr releases. Single instance — one Shoko server per household, the same shape as [Seerr](../seerr/seerr-settings.md).

### Instance Fields

| Field | Required | Description |
|---|---|---|
| **Shoko URL** | Yes | Base URL of your Shoko Server (e.g., `http://192.168.1.100:8111`) |
| **Shoko API Key** | Yes | API key generated in Shoko's own web UI |
| **Shoko URL Mappings** | No | Reverse-proxy URL remapping, same format as the other *arr URL mappings |

### Generating a Shoko API Key

1. In Shoko's web UI, go to **Settings** → **API Keys**
2. Click **Add API Key** and give it a name (e.g. `Jellyfin Enhanced`)
3. Copy the generated key into the **Shoko API Key** field on the plugin's ***arr Settings** tab

### Setup

1. Open plugin settings → ***arr Settings** tab
2. Fill in **Shoko URL** and **Shoko API Key**
3. Optionally add **Shoko URL Mappings** if Shoko sits behind a reverse proxy — see [URL Mappings (per-instance)](#url-mappings-per-instance) above for the format
4. Click **Save**
5. Enable the [Calendar page](#calendar-page-settings) if you haven't already — anime episodes appear there automatically once Shoko is configured

!!! note
    Anime cards are matched to your Jellyfin library via [Shokofin](https://github.com/ShokoAnime/Shokofin)'s provider IDs. Anime not yet imported into Jellyfin still appears on the calendar, but the card isn't clickable until Shokofin brings it into your library. See [anime calendar events](../arr/arr-features.md#anime-calendar-events-shoko) for full scope details.

---

## Calendar Page Settings

Found in the ***arr Settings** tab under "Calendar Page".

| Setting | Description |
|---|---|
| **Enable Calendar Page** | Enables the calendar view for upcoming Sonarr/Radarr releases |
| **Use Plugin Pages** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages); Jellyfin 12: user profile menu instead) |
| **Use Custom Tabs** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **First Day of Week** | Monday or Sunday |
| **Time Format** | 12-hour (`5pm/5:30pm`) or 24-hour (`17:00/17:30`) |
| **Highlight Favorites** | Highlights favorite shows/movies based on Jellyfin favorites |
| **Highlight Watched Series** | Highlights series you are currently watching |

After enabling with Plugin Pages, restart Jellyfin for the sidebar link to appear. While the page is
off, its data route answers `403` too.

Direct URL: `/web/index.html#!/jellyfinenhanced/calendar`

---

## Requests Page Settings

Found in the ***arr Settings** tab under "Requests Page (Downloads)".

| Setting | Description |
|---|---|
| **Enable Requests Page** | Enables a dedicated page showing active downloads from Sonarr/Radarr |
| **Use Plugin Pages** | Adds a sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages); Jellyfin 12: user profile menu instead) |
| **Use Custom Tabs** | Adds a custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs)) |
| **Enable Auto-Refresh** | Automatically refreshes download status |
| **Poll Interval** | How often to refresh, in seconds (30–300, default: 30) |

While the page is off (or **Show Downloads in Requests Page** is off) its queue and history routes return nothing as well.
If an instance's history can't be read, the page says so instead of showing it as empty.

!!! note
    The Requests page for downloads is separate from the Seerr Requests page. Both can be enabled independently. The Seerr Requests page (showing media requests and issues) is configured in the **Seerr Settings** tab.

Direct URL: `/web/index.html#!/jellyfinenhanced/downloads`
