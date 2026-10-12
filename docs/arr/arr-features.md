# ARR Integration

Quick access to Sonarr, Radarr, and Bazarr from Jellyfin, plus calendar and download monitoring.

!!! success "Note"

    ***arr links are only visible to admin users**

    **Other features are visible to all users.**


!!! warning


    **Security Considerations:**

    - **API Keys** are stored securely on server
    - **Network Access** - Ensure *arr instances are secure
    - **HTTPS** - Use HTTPS for remote access

## Features

The ARR integration provides convenient links to your Sonarr, Radarr, and Bazarr instances directly from Jellyfin item pages. Additionally, it can display *arr tags as clickable links and provide calendar and download monitoring pages.

- **Quick Links** - Jump to Sonarr, Radarr, Bazarr pages for any item
- **Tag Links** - Display *arr tags as clickable links with filtering
- **Calendar View** - Upcoming releases from Sonarr/Radarr
- **Requests Page** - Monitor download queue and status
- **Admin Only** - Links only visible to administrators
- **Requests & downloads (new, experimental)** - Where every title has got to, on its own page, kept current live; see [below](#requests-downloads-new)

## Requests & downloads (new)

**Experimental and off by default** (*arr Settings tab → Requests & downloads (new) → Show where things have got
to). Seerr stays in charge of requests: Jellyfin Enhanced reads Seerr's request list and Sonarr/Radarr, and shows
everyone where the things they care about have got to, in plain words. Settings: [*arr Settings](arr-settings.md#requests-downloads-new).

**One status language.** *Waiting for Dad to OK it → OK'd! Getting started → Not out yet → Looking for it →
Downloading · 42% · about 12 min → Almost ready → Ready to watch*. "Ready" means a Jellyfin item *you* can open.
Family members see these sentences only; administrators also see which Sonarr/Radarr holds each copy, the app's
own message ("Manual Import required") and what would fix it.

**Where it shows**

- **Details pages**: a pill under the title (tap it for the journey: asked, OK'd, downloading, … with dates);
  series and season pages get a summary ("Season 1 ready · 1 downloading"); seasons get episode chips and a
  "Missing: E5, E6" line. Episodes whose downloads can't be checked count as "taking longer than usual"
  in the series or season summary.
- **Posters**: a small badge while something downloads, is almost ready or takes longer than usual.
- **Seerr's more-info window**: the same pill and journey for titles that aren't in the library yet, e.g.
  "Downloading · 42%" with "Asked by someone in your household → OK'd → Downloading".
- **Requests page** (`#/requests`, "Requests" in the sidebar): your own requests, grouped into *Waiting for an
  OK*, *On the way*, *Not out yet* and *Said no*; **Coming soon** (dates in the next two months, by day) and
  **Ready** (what arrived in the last two weeks, with Play). Each request follows what it asked for: a request
  for Season 3 of a show you already have waits for Season 3, and a 4K request for the 4K copy (with no 4K
  Sonarr/Radarr set up in Jellyfin Enhanced, for Seerr to say the 4K copy is available); **Play** on a 4K
  request only ever opens the 4K copy, never the standard one (a copy counts as the 4K one only when the 4K
  Sonarr/Radarr's linked libraries, path mappings or folder name say so, or Seerr names it). Nobody sees anyone else's requests here, and
  someone else's request for the same title doesn't change how yours shows. Titles you hid with
  **Hidden Content** (when it filters requests) don't show here either. Release dates are calendar days: a
  movie out "on the 20th" (or an episode with an air day but no time) is on the 20th wherever you are, and
  stays in Coming soon through that day, even after midnight UTC. Open
  requests always show; with more than 200 titles the page lists your open ones and the newest and says so.
  Administrators also get the **Downloads** and **Calendar** pages as tabs (when those pages are on); the old
  pages stay where they are.

Everything updates on open pages within seconds, without a reload: Jellyfin Enhanced keeps a live connection to
each Sonarr/Radarr and reads Seerr's request list in the background; browsers only ever ask Jellyfin. When a
Sonarr/Radarr stops answering, what it was downloading is no longer shown as if it were live: after 10 minutes
(30 for its history) its titles read "Taking longer than usual" (administrators: "Can't be read") until it answers
again (a series whose missing episodes all depend on it too), and the Requests page says download details can't
be checked right now. A failed read that isn't that old yet drops the time left at once. When a page can't refresh, it
keeps what it showed with "Couldn't refresh · showing what we had at 14:05 · Retry" and tries again on its own.

Copies are matched to Sonarr/Radarr by every id the title is known by (a series Jellyfin knows only by its TMDB
id, a movie only by its IMDb id). Status and notifications share the same ids, following links between the
arr libraries and the last complete Seerr request list. Copies are matched to the right instance by its linked
libraries, its path mappings (the longest that applies) or its folder names; two instances whose folders end the same way (both rooted at
/movies on different hosts) are never guessed between, so a 4K copy is never mistaken for the standard one.

**Manage (administrators).** A **Manage** button on details pages, in Seerr's more-info window and on the Requests
page opens a panel (on the right on a computer, from the bottom on a phone) with:

- *Where it has got to*: the status with every copy's reason and fix;
- **Search now** (per Sonarr/Radarr; recorded in the arr action audit log) and **Open in Sonarr/Radarr**;
- *Versions across instances*: the title in each Sonarr/Radarr of its kind (e.g. Radarr and Radarr 4K), with
  monitoring, profile, size and its Jellyfin library, or "Not in Radarr 4K" with an **Add in Radarr 4K** link to
  that app's add page;
- a *timeline* per instance: added, grabbed, imported, failed, searches run from Jellyfin Enhanced, the download in
  progress and when Jellyfin got it (when that app's queue is out of date it says "queue as of 14:05"; when it
  can't be read at all, "queue can't be read; last read 14:05" and no download or download action is offered);
- *Requests in Seerr*: who asked, when, and the answer;
- with **admin tools (phase 2)** on, the title's downloads with **Retry import**, **Search again** and
  **Remove…** (keeps the download's data; the same "blocklist / search again" questions and season-pack warning
  as the Activity tab). Removing the data as well stays on the Activity tab.

**Admin tools (phase 2).** With **Tell me, and admin essentials (phase 2)** on, administrators get four more tabs on
the Requests page (everyone else never receives them):

- **Overview**: a card per Sonarr/Radarr (live or not, downloads in the queue, health, a disk bar per root
  folder); **Needs attention**, built only from what the apps and Jellyfin report themselves, each row with a fix:

    | Row | Fix offered |
    |---|---|
    | Import blocked (the app says it needs a manual import) | **Open in Sonarr/Radarr** (its queue), **Remove & search again** |
    | Waiting to import, with the app's warning ("Sample") | **Retry import** (the app's own "check finished downloads" command), Open in…, Remove & search again |
    | Download warning ("no peers") / stalled (the download client reports no time left with data still missing) | **Remove & search again** (keeps the partial download; "delete it too?" asks separately) |
    | Download client unavailable (the app can't reach it; no progress is known) | **Open System**, Open in… |
    | Download failed and nothing new since | **Search now** |
    | Low disk / root folder missing / the app's health checks | **Open System**, Open in… |
    | In Sonarr/Radarr, not in Jellyfin (an import Jellyfin still doesn't list after 10 minutes) | **Scan now**, or the path doctor when Jellyfin can't see the file |
    | OK'd in Seerr, but none of the Sonarr/Radarr Jellyfin Enhanced watches has it (a 4K request: none of the 4K ones; tagged [4K]) | **Open Seerr's settings** (usually Seerr's own Sonarr/Radarr settings) |
    | An app that can't be read, a live connection down for 10 minutes, a webhook silent for a day | **Open System** |

  plus the next 24 hours (episodes airing, movies coming out) and two weeks of grabs and imports. A
  download's "for 3 h" counts from when Jellyfin Enhanced first saw the problem (not from the grab), so a
  restart may make it read late, never early (a stalled download too: from when it stalled); the daily digest
  lists what has been stuck that long. A finished
  download the app can't import is "Waiting to import", never "downloading". When an app's queue is out of
  date, its card and the Activity tab say "queue as of 14:05"; when it can't be read at all, "queue can't be
  read; last read 14:05", and the downloads last read are listed without any action (a click on one already
  open is refused and nothing is sent to the app).
- **Activity**: every download (a season pack is one download), with the app's own words, progress and
  **Remove…** (keeps the download client's data; optionally blocklist the release and search for another
  copy), **Search again**, **Retry import** (where the app retries imports itself) and **Remove and delete
  data…**, which shows what it covers ("This download covers S02E01–E08; removing it affects all 8 episodes")
  and needs the word DELETE typed and a one-time confirmation from the server. Below, the newest 100 history
  events of all the apps together.
  Sonarr and Radarr have no way to change a download's priority, so neither does this tab.
- **System**: per app its version, health checks, disks, scheduled tasks, live connection and webhook; Seerr's
  request list; and the **Jellyfin bridge**: recent imports Jellyfin doesn't list yet (with why: not scanned
  yet, Jellyfin can't see the file there, outside every library), titles with files Jellyfin doesn't list at
  all, and the **path doctor**, which shows each app's root folders as Jellyfin sees them, compares a few titles
  both sides have and suggests the path mapping that would fix a mismatch ("/data/media → /media").
- **Audit**: every action taken from Jellyfin Enhanced (who, what, where, the outcome and what the app
  answered), including refusals, and attempts by someone who isn't an administrator to use these actions
  ("denied", at most once a minute per person and action). Each one is also copied into Jellyfin's own
  activity log (Dashboard → Activity) unless that setting is off.

The tabs update when something changes (an app was read again, an action was recorded), with a fallback
re-read every minute.

With phase 2 the Downloads tab folds into Activity (the old Downloads page itself stays).

**Imports show up in Jellyfin right away.** When Sonarr/Radarr import a file, Jellyfin Enhanced refreshes only
the folder it landed in (the season; the series and then the new season folder for a new season; or the movie
library's folder for a new movie), looking only at the new files, so the episode or movie appears within seconds
and open pages switch to "Ready" without a library scan. A whole TV library is never refreshed this way: a
brand-new series folder is handed to Jellyfin's own library monitor when that library has real-time monitoring
on, and otherwise waits for Jellyfin's next library scan (it is listed under "In Sonarr/Radarr, not in
Jellyfin" with **Scan now** meanwhile). It uses each app's path mappings (see the path doctor) and
waits while Jellyfin's own library scan runs. A folder is never refreshed twice at once: imports that arrive while
it runs are gathered into the next refresh of that folder, and a file whose refresh is still waiting its turn
is carried the rest of the way once that refresh has run (unless the setting was switched off meanwhile).
Imports of the last 30 minutes are looked at again when Jellyfin starts, so one made while it was restarting
still shows up. On Windows, folders that differ only in upper/lower case are the same folder.

**OK'd in Seerr, but nothing happens.** When Seerr has OK'd a request and, after 15 minutes, no Sonarr/Radarr
has the title, administrators see "OK'd in Seerr 20 min ago, but none of the Sonarr/Radarr Jellyfin Enhanced
watches has it" on the title and under Needs attention. The family keeps seeing "OK'd! Getting started" until the
"still looking" hours, then "Taking longer than usual". Each quality is judged on its own instances: a 4K request
on the 4K Radarr or Sonarr alone ("4K request OK'd in Seerr … but none of the 4K Radarr Jellyfin Enhanced watches
has it", even when the standard Radarr has the movie; likewise for series and the 4K Sonarr), a standard request
on the others, so a finished standard request never hides a stuck 4K one. A request Seerr counts as done
(completed, or its media available) is never flagged, even when no Sonarr/Radarr holds the title any more.
Nothing is flagged for a kind of title no Sonarr/Radarr is set up for in Jellyfin Enhanced, nor for a 4K request
with no 4K instance set up (Seerr may send it to an app Jellyfin Enhanced doesn't know).

Privacy: family members only ever hear about titles they can open in Jellyfin (library access, parental rating and
tags) or that they asked for themselves while Jellyfin doesn't have them yet (once Jellyfin has a title and their
limits hide it, their own request no longer shows it); nothing they receive names a server, path, download client,
release or another person.

### Notifications (phase 2)

**Off by default** (*arr Settings tab → Requests & downloads (new) → Tell me, and admin essentials → Notifications).
Settings: [*arr Settings](arr-settings.md#notifications-phase-2).

- **Notify me.** A bell button in the action row of movie, series and season pages ("Notify me about new
  episodes" on a series), a **Notify me** button in Seerr's more-info window (titles that aren't in the library yet
  too) and a **Following** button on each Requests page row. Your own requests are followed automatically (turn it
  off per title with the same button, or for all in your settings).
- **What you hear about:** a title you asked for or follow is **ready to watch** (for you: a 4K request waits for
  the 4K copy, and a title in a library you can't open never counts); **new episodes** of series you follow or
  asked for, gathered per series for 10 minutes from the first one ("Severance: 3 new episodes ready"; a whole season
  at once reads "Season 2 is ready" when Sonarr says that is all of it; only numbers, never an episode's name, so
  nothing is spoiled; a 4K request hears about the 4K copy's episodes only, and with no 4K Sonarr set up in
  Jellyfin Enhanced only about the copy Seerr matched it to, never the standard copy); a request of yours **declined**. Following
  something that is already there tells you nothing; each thing is told once (once per Jellyfin item, whichever id it
  is known by), even across restarts, and told again if you ask for it again after it was removed; a title you can
  no longer open by the time a batch goes out is left out (a series followed under two ids, even for different
  seasons, is still one batch).
  Phone alerts and e-mails held back by quiet hours or retries are checked again as they go out (nothing about a
  title you can no longer open, nothing of a kind you switched off meanwhile, nothing on a channel switched off
  meanwhile; the bell then shows such an entry without its title), and a disabled account is told nothing. When a
  Jellyfin user is deleted, their follows, settings and inbox go with them.
- **Where:** the **bell** in the header (unread count; the inbox with posters, "5 min ago", **Play** for what is
  ready, Mark all read, older items on demand); a **pop-up** on open pages within a couple of seconds (never while a
  video plays: you get one "N more notifications arrived" when it ends); and, if the administrator sets them up,
  **phone alerts** through [ntfy](https://ntfy.sh) and **e-mail**, both with a link straight to the title.
- **Requests & alerts** (Jellyfin Enhanced panel, per person): what to hear about, pop-ups on or off, follow what I
  request, phone alerts (make up a private topic, or type your own, then subscribe to it in the ntfy app), e-mail
  (confirmed with a 6-digit code sent to the address), **quiet hours** (phone and e-mail wait until they end, in your
  device's time zone; the bell still fills), "hide titles on the lock screen" (no title in any phone or e-mail
  text, administrators' alerts included) and **Send me a test**. Every e-mail's
  unsubscribe link opens this section.
- **Administrators** also hear about a new request waiting for an OK, and straight away about what the admin tools'
  **Needs attention** list shows that needs someone: a download Sonarr/Radarr can't import without a manual import,
  a request Seerr OK'd that no Sonarr/Radarr has after the grace, an instance that stops answering for a while (and
  when it is back) and a root folder low on disk space (at the same threshold as the Overview, once a day per
  folder); each once, linked to the Overview or System tab (rows already listed when the alerts are switched on,
  or switched back on, stay on the Overview only, so turning them on doesn't send one alert per old row; a row
  that started while Jellyfin was restarting is still told). A daily list gathers the downloads Needs attention has
  shown for hours. And **reminders**: family members get **Remind Dad** next to a status that is taking longer than usual
  (at most once a day per title, whichever episode or season page it is sent from). These alerts stay with
  administrators: someone who is no longer one, or who switched administrators' alerts off, doesn't get them on
  the phone (and someone who is no longer one doesn't see them in the bell).

Notifications are driven by the same live updates as the status (Sonarr/Radarr, Seerr's request list and Jellyfin's
library), never by extra calls to the arrs. With **Show imports in Jellyfin right away** (the admin tools' targeted
refresh) "ready to watch" goes out within seconds of the import: the moment the refresh finds the file, the title is
looked at again, without waiting for a library scan or for Jellyfin to finish reading its metadata. Follows, the inbox and delivery state are kept in a small database
(`acquire.db`) in Jellyfin Enhanced's data folder, included in JE backups. Failed phone or e-mail deliveries are
retried (30 s, 2 min, 10 min, 30 min, 2 h, 6 h) and then shown to administrators under **Notification status**; an
e-mail server that doesn't answer is given up on after 30 seconds for that try, so other alerts aren't held up.
Switching notifications off holds what is queued until they are back on; switching phone alerts or e-mail off (or a
person switching theirs off) drops what was queued for that channel. Pointing Jellyfin Enhanced at another Seerr
server starts its request list afresh: the requests already on it are not announced as new, approved or declined.

## ARR Links

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable *arr Links"**
4. Add one or more Sonarr and/or Radarr instances (see [Multi-Instance Support](#multi-instance-support) below)
5. Optionally add a **Bazarr URL** for subtitle management links
6. Optional: Check **"Show *arr Links as Text"** for text links instead of icons
7. Click **Save**

### Multi-Instance Support

You can configure multiple Sonarr instances and multiple Radarr instances — useful for separate libraries (e.g., TV vs Anime, HD vs 4K).

**Each instance has:**

| Field | Description |
|---|---|
| **Name** | Display name shown in dropdowns (e.g., "TV Shows", "Anime", "4K Movies") |
| **URL** | Base URL of the instance (e.g., `http://192.168.1.100:8989`) |
| **API Key** | API key for authenticating with the instance |
| **URL Mappings** | Optional per-instance URL remapping (see below) |
| **Enabled** | Toggle to disable an instance without deleting it |

**Adding instances:**

1. Open plugin settings → ***arr Settings** tab
2. Click **"Add Sonarr Instance"** or **"Add Radarr Instance"**
3. Fill in Name, URL, and API Key
4. Click **Save**

**Disabling an instance:**

Toggle the **Enabled** switch off to temporarily disable an instance (e.g., during maintenance). The instance remains in config with its URL and API key intact — re-enable it at any time without re-entering credentials.

**How links behave with multiple instances:**

- **Single matching instance** — renders as a plain icon link (no badge clutter). Enable **"Show status badge for single-instance links"** to always show the status border and episode/file count.
- **Multiple matching instances** — the link becomes a dropdown button. Click it to see each instance with:
    - A colour-coded status dot (green = complete, amber = partial, grey = missing)
    - Episode count or download status
    - File size on disk

**Calendar and Requests pages** fan out across all enabled instances automatically.

### URL Mappings

Map internal and external URLs for different network contexts. Mappings can be set globally (legacy fields) or per-instance.

**Format:**
```text
internal_url|external_url
```

**Example:**
```text
http://sonarr:8989|https://sonarr.example.com
http://radarr:7878|https://radarr.example.com
```

**Use Case:** Different URLs for local network vs remote access.

### Legacy Single-Instance Fields

The original `SonarrUrl`, `SonarrApiKey`, `RadarrUrl`, and `RadarrApiKey` fields are preserved for downgrade safety. If no instances are configured in the new multi-instance list, the plugin automatically falls back to these legacy fields so existing setups continue working without any migration step.

!!! note
    After adding instances via the new UI, the legacy fields are no longer used for arr links. They remain in config and are not deleted, so downgrading to an older plugin version restores the previous single-instance behaviour.

### Usage

**On Item Detail Pages:**

1. Open any movie or TV show
2. Look for *arr link icons in the external links section
3. Click to open the item in the respective *arr application, or click the dropdown to choose an instance

**Visibility:**

- Only visible to administrators
- Automatically detects item type (movie/TV)
- Shows relevant links only (Sonarr for TV, Radarr for movies)

## ARR Tags

Display synced *arr tags as clickable links on item detail pages.

### Setup

**Prerequisites:**

- Sonarr and/or Radarr configured
- API keys for Sonarr and Radarr

**Configuration:**

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable *arr Tags Sync"**
4. Enter **Sonarr API Key**
5. Enter **Radarr API Key**
6. Configure tag settings (see below)
7. Click **Save**

### Tag Settings

**Tag Prefix:**

- Default: `JE Arr Tag: `
- Prefix added to synced tags
- Helps identify plugin-managed tags

**Clear Old Tags:**

- Remove old plugin-managed tags before syncing
- Keeps tags clean and up-to-date
- Recommended: Enabled

**Show Tags as Links:**

- Display tags as clickable links on item pages
- Click to view all items with that tag
- Recommended: Enabled

### Tag Filtering

**Links Filter (Show Only):**

- Comma-separated list of tag names to show
- Only matching tags displayed as links
- Leave empty to show all tags

**Example:**

```text
in-netflix,in-disney,4k-upgrade
```

**Links Hide Filter:**

- Comma-separated list of tag names to hide
- Matching tags not displayed as links
- Overrides show filter

**Example:**
```text
internal-tag,do-not-show
```

**Sync Filter:**

- Comma-separated list of tag names to sync
- Only matching tags synced from *arr
- Leave empty to sync all tags

**How titles are matched:** movies by their TMDB id; series by TVDB, TMDB or IMDb id (whichever the Jellyfin series has). If a Sonarr or Radarr instance can't be read during a run, **Clear Old Tags** skips the titles of that kind for that run, so a temporary outage never strips their tags.

### Custom Styling

Customize tag link appearance with CSS.

**Example - Rename Tag:**
```css
/* Hide original label */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
  display: none !important;
}

/* Add custom label */
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
  content: " N00bCodr";
}
```

**Example - Hide Specific Tag:**
```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  display: none !important;
}
```

**Example - Service Colors:**
```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
  background: #d81f26;
  color: #fff;
}
```

See README for more CSS examples.

## Calendar Page

![Calendar page showing upcoming Sonarr and Radarr releases](../images/readme/calendar.webp)

View upcoming releases from Sonarr and Radarr in a calendar interface.

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable Calendar Page"**
4. Choose integration method:
   - **Use Plugin Pages** - Adds sidebar link (requires [Plugin Pages](https://github.com/IAmParadox27/jellyfin-plugin-pages) plugin; Jellyfin 12: user profile menu instead)
   - **Use Custom Tabs** - Adds custom tab (requires [Custom Tabs](https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs) plugin)
5. Configure calendar settings (see below)
6. Click **Save**
7. Restart Jellyfin if using Plugin Pages

### Calendar Settings

**First Day of Week:**

- Monday (default)
- Sunday

**Time Format:**

- `5pm/5:30pm` - 12-hour format
- `17:00/17:30` - 24-hour format

**Highlight Favorites:**

- Highlight favorite shows/movies in calendar
- Requires favorites set in Jellyfin

**Highlight Watched Series:**

- Highlight series you're currently watching
- Based on watch history

**Requests Filter:**

- Filter calendar to show only requested items
- Helps track upcoming releases you've requested
- Toggle on/off as needed

**Filter by Library Access:**

- Users who aren't administrators see an episode or movie Jellyfin already has only if they can open it
  (an episode Jellyfin hides from them, by its own rating or tags, stays hidden even when they can open its series).
  A title in two libraries (say "TV" and "TV 4K") shows when they can open either copy
- An upcoming title that isn't in Jellyfin yet shows only to users who can open the library it will land in:
  the libraries its Sonarr/Radarr instance is linked to, or else the library whose folder holds the title's
  folder (through the instance's path mappings; a mapping for a folder inside a root folder counts too)
- When that can't be told (no Jellyfin library holds the folder; two instances have the same root folder
  and neither maps it; or, with no mapping for the title, an instance's root folders can't be read yet)
  the title is hidden from everyone but administrators; the path doctor on the
  Requests page's System tab points out such roots while the Calendar and this setting are on. Set a path mapping or link the instance's libraries to fix it
  (the setting's own description says so too, for installs without the System tab)
- The calendar never waits for root folders: when a title needs them and they haven't been read yet (or were
  read over an hour ago), it answers with what it knows and reads them in the background for the next load
- If the calendar can't be loaded, it says so with a **Try again** button instead of showing "No upcoming releases"

### Usage

**Access Calendar:**

- Click "Calendar" in sidebar (Plugin Pages; Jellyfin 12: user profile menu instead)
- Navigate to custom tab (Custom Tabs)
- Direct URL: `/web/index.html#!/jellyfinenhanced/calendar`

**Features:**

- Month, week, and agenda views
- Color-coded by series/movie
- Click event to view details
- Filter by Sonarr/Radarr
- Search functionality

### Anime Calendar Events (Shoko)

When [Shoko is configured](arr-settings.md#shoko), upcoming anime episodes from your Shoko collection appear on the Calendar page alongside Sonarr/Radarr releases, with their own pink **Anime** legend entry to show/hide them independently.

**Scope:**

- Only anime already in your Shoko collection — Shoko's calendar isn't a discovery feed for anime you don't track
- Restricted/H content is never fetched or shown
- Only AniDB `Episode` and `Special` types are shown; `Credits`/`Trailer`/`Parody`/`Other` are dropped as calendar noise
- No time-of-day — AniDB only has date-level granularity, so anime cards have no time pill and sort after same-day timed events
- Subtitles use AniDB-style numbering (`Episode 12`, `Special 3`), not Sonarr's season/episode grid

**Matching and click-through:**

- Anime cards become clickable, taking you to the series page, once [Shokofin](https://github.com/ShokoAnime/Shokofin) has matched that anime into your Jellyfin library
- Anime not yet in your Jellyfin library still renders as a card, but isn't clickable — same as any other unmatched calendar item

**Dedup:**

Shoko events are never deduped against Sonarr/Radarr events, even for the same anime — a title tracked in both shows up twice. Sonarr/Radarr dedup keys on TVDB/TMDB ids, which Shoko doesn't carry; Shoko identifies anime by its own AniDB/Shoko-internal ids instead. Matching across the two by title alone would risk merging unrelated entries, so the two sources are kept deliberately separate rather than guessed at.

---

## Downloads Page

![Downloads page showing active Sonarr/Radarr queue](../images/downloads-page.png)

Monitor active downloads from Sonarr and Radarr in a dedicated page.

### Features

- Active download queue with progress bars and ETA
- Quality and file size information
- Auto-refresh with configurable poll interval
- Filter and search

### Setup

1. Go to **Dashboard** → **Plugins** → **Jellyfin Enhanced**
2. Navigate to ***arr Settings** tab
3. Check **"Enable Requests Page"** (under "Requests Page (Downloads)")
4. Choose integration method (Plugin Pages or Custom Tabs; Jellyfin 12: Plugin Pages links show in the user profile menu instead of the sidebar)
5. Click **Save** and restart Jellyfin if using Plugin Pages

Direct URL: `/web/index.html#!/jellyfinenhanced/downloads`

!!! note
    This page shows only *arr download queue entries. Seerr media requests and issues are shown on a separate Requests page configured in the **Seerr Settings** tab.

**Who sees which downloads:** administrators see the whole queue and history. Everyone else sees a
download only for a title they could open in Jellyfin (their library access and parental limits apply,
down to single episodes of a season pack). A title that isn't in Jellyfin yet shows when they can open a
library its Sonarr/Radarr instance is linked to (an instance without linked libraries counts as open), or,
for users with parental limits, only when they asked for it in Seerr (this also works with "Requests &
downloads (new)" off: their Seerr requests are then read only when such a title is in the queue or
history, at most about twice a minute, and a slow Seerr never holds up the page; saving the Seerr settings
drops what was read). With **Filter Downloads by User Requests** on, they additionally see only what they
requested in Seerr.