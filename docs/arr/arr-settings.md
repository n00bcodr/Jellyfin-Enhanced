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
refreshed. A queue or history that can't be read again is still shown for a while (10 minutes for the
queue, 30 for the history); after that, "Requests & downloads" treats what that app is downloading as
unknown rather than showing it as current. After a restart the library list starts from a cached copy (in the `arr-state` folder of
the plugin's data folder) and is refreshed in the background. A title you just added in Sonarr or
Radarr can take up to 15 minutes to get its link, and a change to the calendar (a title added or
removed) up to 15 minutes to show.

A busy queue can reorder while it is read page by page (Sonarr and Radarr sort it by time left), so a
row can be missed. The queue is then read once more; if rows still moved, the last complete copy is
kept for up to 2 minutes (it shows its age), and after that the newest read is shown. Neither counts as
the instance being unreachable. A row missing from a queue read over more than one page (more than
500 queue rows; Sonarr lists each episode of a season pack as its own row, so a few season packs can be
enough) only counts as gone when the next complete read lacks it too; even a kept short read that
shows it restarts that count. Until then it keeps its last queue state and first-seen problem clock,
with no time-left estimate. Its old state expires ten minutes after its last published sighting, even if a
newer read missed it. A finished download in such a queue shows as importing one refresh later. No download
counts as finished because a read missed it.

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
| **"Missing" with Search after (hours)** | 24 | When "Looking for it" (nothing grabbed yet) becomes plainly **Missing** with a **Search** button (1-720) |
| **What the family calls you** | (empty: "the admin") | Used in family texts: "Waiting for Dad to OK it" |
| **Requests page** | On | The "Requests" sidebar page (`#/requests`): everyone's own requests (waiting for an OK, on the way, not out yet, said no), Coming soon and Ready. Administrators also get the Downloads and Calendar pages as tabs when those pages are on; with it on, the Downloads page's own sidebar link reads "Downloads" |
| **Manage button for administrators** | On | The Manage panel on details pages, Seerr's more-info window and the Requests page: explanation, Search now, Open in Sonarr/Radarr, versions across instances, timeline, Seerr's requests |
| **Show the status in Seerr's more-info window** | On | The pill and journey for titles not in the library yet (needs "Use the more-info window" on the Seerr tab) |
| **Read Seerr's requests every (minutes)** | 5 | How often Seerr's request list is read in the background (1-60); every 30 seconds while someone has the Requests page open, and about a second after a request is made, approved, declined or removed through Jellyfin Enhanced |

Requests come from Seerr (Seerr tab), matched to Jellyfin users through Seerr's own user import; with Seerr off
the Requests page says requests aren't set up, and statuses still work from Sonarr/Radarr alone. A full read of
Seerr's list is used only when it is complete (requests made or removed while its pages are read make it try again a
minute later; only several such reads in a row show as a problem on the System tab), so a request is never taken for
removed because the list moved. With more than 3000 requests the newest 3000 are read and older ones read since
Jellyfin started keep what was last known of them (up to 9000 more); the System tab says so. Requests that aren't
read are never taken for removed, but ones older than the newest 3000 when Jellyfin started aren't known (no
"ready" alert comes from them); one that dropped out of what is read is not announced as new or declined if Seerr
later shrinks and lists it again. A Seerr (or a proxy in front of it) that serves fewer requests per page than asked is still read to the end.
Another Seerr address or API key counts as another Seerr: its request
list is read afresh. Seerr is read with
its API key in the background only: opening a page never calls Seerr, Sonarr or Radarr. **Search now** asks that
Sonarr/Radarr to search for the movie, series, season or episode the page is about; each one is recorded in the
arr action audit log (who, when, the outcome and how the search ended).

### Tell me, and admin essentials (phase 2)

**Tell me, and admin essentials (phase 2)** sits under the status switch and needs **Requests & downloads (new)** and
"Show where things have got to". Off by default. It switches on the admin tools below and, with **Notifications**,
the alerts.

#### Admin tools

| Setting | Default | What it does |
|---|---|---|
| **Show imports in Jellyfin right away** | On | After an import, refresh only the Jellyfin folder the file landed in (never a TV library's root; a new series folder is left to Jellyfin's library monitor when the library has real-time monitoring on, otherwise to its next library scan or Scan now). Needs path mappings when the apps and Jellyfin see the files under different paths |
| **"In Sonarr/Radarr, not in Jellyfin" after (minutes)** | 10 | When an import Jellyfin still doesn't list goes under Needs attention (1-1440) |
| **Low disk warning below (% free)** | 10 | A root folder whose disk has less free space goes under Needs attention and, with notifications on, administrators are alerted (at most once a day per folder) (1-50). With **Ask for it** on, asks whose download would land on such a disk (JE mode: the title's own folder, or the default root for a new title; Seerr mode: the default root) are paused and say *Paused: storage full*; administrators' Search still runs |
| **Tell me when Seerr's OK reaches no Sonarr/Radarr after (minutes)** | 15 | When administrators are told that a request Seerr OK'd isn't in any Sonarr/Radarr (1-1440). The family sees "Taking longer than usual" only after the "still looking" hours |
| **Copy actions into Jellyfin's activity log** | On | Every audited action (Search now, queue actions, Scan now, webhook set-up) also appears in Dashboard → Activity |

The admin tabs read everything from memory (the apps are read in the background); only the actions call
Sonarr/Radarr, each one once per click, recorded in the audit log with what the app answered. Removing a
download *with* its data is never automatic and needs a one-time confirmation that expires after two minutes.

#### Notifications

**Notifications** sits under the phase 2 switch (on once phase 2 is on).

| Setting | Default | What it does |
|---|---|---|
| **Notifications** | On | Notify me / Following buttons, the bell and inbox, pop-ups, phone and e-mail alerts, admin alerts and Remind |
| **Your household's Jellyfin address** | (empty) | The address people open Jellyfin with on their phones (e.g. `https://jellyfin.example.com`). Phone alerts and e-mails link to the title there, and e-mails' unsubscribe link to the "Requests & alerts" settings. Empty: no links |
| **Gather new episodes for (minutes)** | 10 | Episodes of one series arriving within this time after the first go out as one message (1-60) |
| **Phone alerts (ntfy)** | Off | Your ntfy server (`https://ntfy.sh` or your own; it must be reachable from Jellyfin and from people's phones) and, for servers that need one to publish, an access token (stored like the API keys, only ever shown masked). People choose a topic in "Requests & alerts", or you give someone a random one under **Notification status**. **Send test** publishes one message to a topic with the saved settings |
| **E-mail** | Off | SMTP server, port (587), STARTTLS (servers that only offer TLS on port 465 are not supported), user name and password (stored like the API keys), sender address and name. Alerts only go to addresses people confirmed with a code. **Send test** sends one e-mail with the saved settings |
| **Tell me when an instance hasn't answered for (minutes)** | 10 | Administrators' outage alert (1-1440). The instance is checked with Jellyfin Enhanced's regular background reads, so the alert can come a few minutes after this time |
| **Daily digest: downloads needing attention for at least (hours)** | 6 | Queue entries the app marks as a problem (import blocked, failed, warning) for at least this long (1-168) |
| **Send the digest at (hour, server time)** | 9 | 0-23 |

With phase 3 on, people also hear when a request of theirs is **OK'd** or **declined** in Jellyfin Enhanced (with the
reason), through the bell, pop-ups, phone and e-mail like any alert (their own switches and quiet hours apply; a
"A request of mine was OK'd" switch appears in "Requests & alerts"). Each is told once, even across restarts.

Administrators are also told straight away, once per item, when Needs attention lists a download that needs a manual
import (the app says import blocked) or a request Seerr OK'd that no Sonarr/Radarr has after the grace above. The
low-disk alert uses **Low disk warning below** from the admin tools (at most once a day per root folder), so the alert
and the Overview's disk bars always agree.

**Notification status** lists deliveries in the last 24 hours (sent, failed, waiting for a retry or for someone's
quiet hours), the latest problems with the reason (never a credential), the database, and everyone's phone and
e-mail state, with a button to give someone a random phone topic.

Nobody but the administrator chooses where alerts go: people pick a topic name on your ntfy server and confirm their
own e-mail address, so no one can make Jellyfin contact an address of their choosing. ntfy is called without following
redirects and never at a cloud-metadata or link-local address; the SMTP server is checked the same way.

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
- **Episode monitoring changed in Sonarr itself.** Sonarr reports no change when an episode is monitored or
  unmonitored in its own UI (no live message, no webhook), so Jellyfin Enhanced reads the series' episodes again
  instead: when a page opens the series and they are over a minute old (the page shows them at once and updates
  when the new read is in), and every minute while a page has the series open (its long-poll names it). The change
  reaches the episode status within about a minute of being made, or as soon as the series is opened. Series
  nobody has open are read every 5 minutes while someone looked at them in the last 15; nothing is read for series
  nobody has opened. Monitoring or unmonitoring a whole season in Sonarr is announced live and shows within
  seconds.

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
If an instance's history can't be read, the page says so instead of showing it as empty. History lists
the newest 200 events you may see (with **Filter by user requests**, your own titles first: other
people's newer events never push yours out).

!!! note
    The Requests page for downloads is separate from the Seerr Requests page. Both can be enabled independently. The Seerr Requests page (showing media requests and issues) is configured in the **Seerr Settings** tab.

Direct URL: `/web/index.html#!/jellyfinenhanced/downloads`

### Ask for it (phase 3)

`ArrPhase3Enabled` is off by default; enable the integration and phase 1 switches first. `ArrRequestBackend` accepts
`seerr` (default), `je` (explicit opt in), or `status_only`. In `je` mode approved requests go straight to Sonarr and
Radarr; in `seerr` mode they go to Seerr as the person who asked. How each is sent is described in
[Sending requests](arr-features.md#sending-requests-phase-3). With phase 3 on and a request backend selected, the
request controls appear for people who may ask (see [Requests & downloads](arr-features.md#missing-episodes-get-it-and-search-phase-3):
Get it on season pages, the request sheet, series and collection actions, Approvals, Household and, in JE mode,
Discover). With Seerr's experimental *Open titles that aren't in the library on Jellyfin's own details page* on, the
same controls appear on those pages (see [Titles that aren't in the library](arr-features.md#titles-that-arent-in-the-library-native-details)).

**Add defaults per instance.** With the master switch on, each Sonarr/Radarr card has *When Jellyfin Enhanced adds a
title*: the quality profile, root folder and tags new titles get, plus Radarr's minimum availability or Sonarr's
series type. Open the card of a saved instance to load its own profiles, folders and tags; values the instance no
longer lists are shown as "(not in Radarr now)" rather than swapped for something else. In Jellyfin Enhanced mode a
request for a title the instance doesn't have yet waits for an administrator until both a profile and a folder are
set. Manage › Add to preselects these defaults.

**Move requests from Seerr...** checks and then moves Seerr's pending and in-progress requests into Jellyfin Enhanced
and switches `ArrRequestBackend` to `je` (see [Moving requests from Seerr](arr-features.md#moving-requests-from-seerr)).
Turn off requesting in Seerr first. The page's Request handling field follows the switch, so saving afterwards keeps
it. The administrator routes behind the panel (paths relative to `/JellyfinEnhanced`):

| Method | Route | Purpose |
|---|---|---|
| GET | `acquire/migration/seerr` | Request handling now and the newest moves with their rollback deadline |
| POST | `acquire/migration/seerr/preview` | The check: counts by kind, what is left out, Seerr's requesting state and a digest |
| POST | `acquire/migration/seerr/commit` | `{"digest": "…", "confirmRequestsDisabled": false}`; 409 when Seerr changed or its address was changed during the move (`seerr_changed`), the read was incomplete, requesting is still on or Jellyfin Enhanced's own Seerr writes didn't finish in time (`seerr_writes_in_flight`); 503 `switch_failed` when the switch couldn't be saved (nothing moved) |
| POST | `acquire/migration/seerr/rollback` | `{"batchId": "…"}`; within 14 days; 503 `switch_failed` (nothing rolled back) or `rollback_failed` (switched back; roll back again) |

`ArrRequestPreset` selects `ask_first`, `open_house`, or `approve_everything`. `ArrRequestDefaultRole` defaults to
`Watcher`; accepted household roles are Watcher, Kid, Member and Manager. Administrator status always comes from
Jellyfin, never from the JSON role settings. Kid suggestions are not automatically applied.

The advanced fields are server-owned. Quota and preset settings govern JE mode; Seerr mode uses the person's quota as Seerr reports it (allowance shows as unavailable while Seerr can't be read):

| Setting | Default | Meaning |
|---|---|---|
| `ArrRequest4kMoviesEnabled` / `ArrRequest4kSeriesEnabled` | false | Phase-3 edition switches; work with Seerr disabled in JE mode |
| `ArrRequestQuotaLimit` | 0 | Preset limit: 7 for Ask first, 15 for Open house; negative means unlimited |
| `ArrRequestQuotaWindowDays` | 7 | Rolling window, bounded to 1–365 days |
| `ArrRequestSeriesThreshold` | 4 | Cumulative seasons before a Member needs approval |
| `ArrRequestDeclineCooldownDays` | 7 | Wait before repeating a declined scope |
| `ArrRequestPendingLimit` | 10 | Pending requests per person |
| `ArrRequestQuotaGb` | 0 | Optional estimated GB cap; zero disables it |
| `ArrRequestChargeFutureSeasons` | true | Charge the owner of a "Keep getting new episodes" request once for each new season Sonarr monitors, once it starts (an aired episode or a file); in Seerr mode, once for each new season Jellyfin Enhanced asks Seerr for. Off: new seasons are still followed, without a charge |
| `ArrRequestStaleDays` | 30 | Flag a sent request that hasn't arrived for review; no automatic refund. A request whose part is in Jellyfin is marked fulfilled instead and never turns stale, nor does a 4K request nothing can take any more (it says `no_4k_instance`) |
| `ArrRequestRoles` | `{}` | Optional per-role `QuotaLimit`, `QuotaGb` and `FourKInstances` defaults |
| `ArrRequestUsers` | `{}` | Per-user `Role`, `QuotaLimit`, `QuotaGb` and `FourKInstances` overrides |

For example, the roles JSON can be `{"Manager":{"FourKInstances":["your-4k-instance-id"]}}`; the users JSON is keyed by
Jellyfin user id. A missing per-user quota inherits the role quota, then the global/preset quota. In JE mode the count
holds only a Member's asks for an OK (a Kid's always wait), so a Manager's or an Admin's allowance shows no limit and
their cost lines (request sheet, a collection's "Get the N missing") never show the household's. An empty per-user 4K
instance list removes that user's inherited grant. Phase 3 has its own movie/TV 4K switches under Ask for it; the older Seerr switches remain in use while phase 3 is off. Seerr mode additionally
requires Seerr's edition setting and the user's corresponding permission. Optional GB accounting uses estimates (it
is not the arr's actual file size): from the files on the Radarr/Sonarr a request would go to (the default instance of
its edition) when its library has been read, a movie counts as the median movie file there and an episode as the median
episode file (each from at least three files of 100 MB or more), and a season as its episodes as that Sonarr lists them
for the series (10 when it doesn't hold the series); otherwise the fixed estimates: a movie 8 GB (4K 40), a season
10 GB (4K 40), an episode 1 GB (4K 4). The estimate is fixed when the request is recorded or approved.

#### Discover and search (JE mode)

| Setting | Default | Meaning |
|---|---|---|
| `ArrKidsHideSearch` | false | **Hide free-text search from Kids**: Kids don't get the search page's "Not in your library" row, and the search route refuses them. The Discover tab stays, limited to titles within their parental limits |

Discover and the search row need request handling set to Jellyfin Enhanced and a TMDB API key; see
[Discover and search (JE mode)](arr-features.md#discover-and-search-je-mode). In JE mode the search row replaces
Seerr's (Seerr's **Show search results** setting no longer adds a second row), and Seerr's request buttons open
Jellyfin Enhanced's request sheet.

### Everywhere and gentle automation (phase 4)

`ArrPhase4Enabled` (off) needs the integration and phase 1 switches; each phase-4 feature has its own switch under it.
`ArrPhase4AutomationEnabled` (off) is the automation engine and also needs phase 3. With either off, phase 3 and the
existing automatic requests work as before, and nothing only phase 4 creates (list, import or sync requests, new
recipes) is ever sent. What the settings do is described in
[Automation with phase 4](arr-features.md#automation-with-phase-4-modes-budgets-and-kill-switches).

| Setting | Default | What it does |
|---|---|---|
| Rollout guard: Shadow only (`ArrAutomationShadowOverride`) | off | Every automatic request only records what it would have done (also the existing ones, with phase 4 off); waiting automatic requests are held. Independent of every other switch. |
| Recipes (`ArrAutomationRecipes`) | Shadow | Mode (Off, Shadow, Ask, Auto) and kill switch per recipe. Written once by the first start of this version: new installs Shadow; upgrades map the old Auto Season/Auto Movie switches to Auto (on) or Off (off). |
| Kill switch: stop every automatic request (`ArrAutomationKillAll`) | off | Nothing automatic is asked for or sent. |
| Kill switches per Sonarr/Radarr (`ArrAutomationKilledInstances`) | none | Instance ids, and `seerr` for Jellyfin Enhanced's requests to Seerr. |
| Titles added per 24 hours (`ArrAutomationHouseholdAddsPerDay`) | 20 | Household-wide, Sonarr/Radarr handling. |
| Searches per hour / per 24 hours (`ArrAutomationSearchesPerHour`, `ArrAutomationSearchesPerDay`) | 30 / 300 | Each Sonarr/Radarr instance. |
| Requests sent to Seerr per 24 hours (`ArrAutomationSeerrPostsPerDay`) | 20 | Seerr handling; counts only what Jellyfin Enhanced sends. |
| Linked-list source reads / changes per hour (`ArrAutomationSourceFetchesPerHour`, `ArrAutomationDeltaWorkPerHour`) | 60 / 500 | For linked lists (later in phase 4). |
| Automatic requests are free (`ArrAutomationFree`) | off | Off: an automatic request counts against the allowance of the person it is for. A hard GB limit applies either way. |

Budgets accept 0 to 100000 (0 allows none). `ArrAutomationBackfillPerHour` (10) is reserved for backfill in a later
phase and not used yet. `ArrAutomationMigration` records the one-time setup and is never edited on the page.

Per person (Jellyfin Enhanced panel, *Automatic requests*, shown while the engine is on): the next-season keeper and the
collection completer may each be set to *Household setting* (the default, follows the administrator), *On* or *Off*.

**Show automation status** (with the integration and phase 1 on; administrators only) reads
`GET /JellyfinEnhanced/arr/admin/automation/status`: switches as they apply, each recipe's mode in effect and why, every
budget window with what is used, what is waiting for a read-back and when it has room again, kill switches and breakers
per target (with *Try again now*), automatic requests waiting at send by reason, the request backend's boundary and the
one-time setup with its notice (*Got it* hides it).

#### Lists (phase 4)

All off by default. Lists need phase 4 and *Ask for it*; each switch below also needs *Lists*. See
[Lists](arr-features.md#lists-titles-not-in-the-library-on-playlists-and-collections-phase-4).

| Setting | Default | What it does |
|---|---|---|
| Lists: titles not in the library on playlists and collections (`ArrPhase4ListPlaceholdersEnabled`) | off | Lists themselves. Off: nothing about lists is shown or done (deleted lists are still cleaned up). |
| Adding and editing list entries (`ArrPhase4ListAuthoringEnabled`) | off | People who can edit a list may add, link, reorder and remove entries and create lists. |
| Ask for list entries (`ArrPhase4ListRequestsEnabled`) | off | A Request action on entries, through the usual request rules. |
| Request all missing (`ArrPhase4ListRequestAllEnabled`) | off | Asking for several entries at once, after a preview; at most 20 per confirmation. Needs *Ask for list entries*. |
| Swap in titles that arrive (`ArrPhase4ListSwapInEnabled`) | off | Arrivals take their entry's place, on lists whose editor turned it on and agreed in their own settings. |
| Daily list maintenance (`ArrPhase4ListMaintenanceEnabled`) | off | Daily refresh of release dates and episode lists, and arrivals nobody looked at. |
| Show request status on list entries (`ArrPhase4ListStatusEnabled`) | off | The shared request status on entries. |

Per person (Jellyfin Enhanced panel, *Lists*, shown while lists are on): *Show titles not in the library on lists* and
*Show where each list title's request stands* follow the household (default) or are hidden; *Let titles that arrive take
their place in lists I turned this on for* is *No* until the person chooses *Yes*.

The scheduled task *Requests & downloads: list maintenance* (daily, 04:30) removes the data of deleted lists and old
list records; with *Daily list maintenance* on it also refreshes entries and runs a full pass.

#### Acquisition badges (phase 4)

All off by default; they need phase 4 (not *Ask for it*). See
[Acquisition badges](arr-features.md#acquisition-badges-new-for-you-upgraded-4k-phase-4).

| Setting | Default | What it does |
|---|---|---|
| Poster badges: New for you, Upgraded, 4K (`ArrPhase4AcquisitionBadgesEnabled`) | off | One badge per poster card in the web client, after the download ring. Off: nothing about these badges is shown or recorded. |
| Draw the badges into posters for TV and phone apps (`ArrPhase4NativeStampsEnabled`) | off | The same badge in each person's poster images. Also needs Native Poster Tags. Off: poster addresses and images are exactly as without it. |
| Days a title stays "New for you" (`ArrAcquisitionNewDays`) | 7 | 1–30. A badge also goes as soon as the person watches the title. |
| Days a title stays "Upgraded" (`ArrAcquisitionUpgradedDays`) | 7 | 1–30. Includes the first 4K version added alongside HD; playback after its own arrival clears it for that viewer. |

Per person (Jellyfin Enhanced panel, *Poster badges*, shown while the badges are on): *Badges on poster cards* and
*Badges drawn into posters on TV and phone apps* follow the household (default) or are hidden / off. Hiding web badges
takes effect immediately; showing them refreshes the cards once the choice has saved. Both controls keep your latest
choices while they save. Once saving finishes, the controls and cards match the last successful save, including when
quick web and native changes have mixed save outcomes. Saved notifications follow the settings document that actually commits, including choices carried by a later save after an earlier failure. Closing the panel lets submitted saves finish their session-bound follow-ups; switching users or sessions discards outgoing follow-ups. Reopening the panel while saving keeps those choices and
earlier successful saves. Language and translation-cache reloads wait for queued saves to finish. Full or disabled browser storage cannot turn a successful save into a failure or leave the consent control out of step with the server. A user switch clears pending unsent saves; old responses cannot change the next person’s
settings. Live acquisition badges work independently of the phase-1
poster status switch.

#### Household tab

Admins can edit `ArrRequestPreset`, `ArrRequestDefaultRole`, `ArrRequestQuotaLimit`, the per-role `QuotaLimit` in
`ArrRequestRoles` and each person's `Role` and `QuotaLimit` in `ArrRequestUsers` from the Household tab of the Requests
page instead of the JSON fields. A save changes only those values; 4K grants and GB caps in the same JSON are kept.
Limits offer the inherited value, **No limit** (−1) or a fixed number of requests per window. Jellyfin administrators
are always Admin and have no role picker. People with a Jellyfin parental limit get a hint that Kid may suit them; it is
never applied automatically. Managers can read the tab but not change it. The configuration page keeps these fields (and
*Request handling*, which a move from Seerr switches) as the server has them when it is saved, unless they were changed
on that page: a page left open before a Household edit or a move doesn't put the older values back, even when the edit
lands while the page is saving.

Your list swap-in agreement changes only when you explicitly choose Yes or No in your own settings. Saving display preferences from another browser, administrator edits, and resetting display defaults preserve your current agreement. An older cached web client must reload to use the explicit agreement control.
