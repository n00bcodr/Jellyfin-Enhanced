# *arr Troubleshooting

Start with the symptom you see, then work through the checks. See [*arr settings](arr-settings.md) for controls and [*arr features](arr-features.md) for expected behavior.

## Troubleshooting

### Links Not Appearing

Service links let you open a title in Sonarr, Radarr, or Bazarr. Check your account, connection, and detail page if they are missing.

1. Sign in as a Jellyfin administrator. Sonarr/Radarr/Bazarr links and request-card service icons are administrator-only.
2. Under **Jellyfin Enhanced** → **\*arr** → **\*arr UI Links**, turn on **Enable \*arr Links on Detail Pages** and click **Save Settings**.
3. Check that the relevant Sonarr/Radarr card is enabled and has both **URL** and **API Key**. Use **Test** to check the current connection.
4. Open a movie or series detail page with a visible TMDB external link. Season and episode pages do not get these service links.
5. Confirm the title exists in that upstream instance. Instances without a matching title are omitted.
6. Hard-reload the web client after changing connection settings.

??? note "Matching, browser addresses, and badges"
    Sonarr needs a TVDB provider ID; Radarr uses the movie's TMDB ID. Detail-link lookups are cached for the session.

    Bazarr needs **Bazarr URL** and the same detail-page prerequisites, but no API key. Its links open a movie/series overview. Shoko's **Open in Shoko** link appears on anime Calendar events, rather than item detail pages.

    If a link appears but opens the wrong address, check **URL Mappings (optional)**, **Bazarr URL Mappings**, or **Shoko URL Mappings**. The left side must be the Jellyfin server address used by the client, including any base path. The right side is the browser-facing service address. A successful API test does not establish browser reachability; mappings do not change the server's API destination.

    If the single-instance status badge is missing, enable **Show status badge for single-instance** and **Show links as text**. If Sonarr reports no statistics, the badge reads `0/0` with gray status. **Enable Metadata Icons (Druidblack)** under **Extras** forces icon mode, where visible badges are omitted and details remain in tooltips.

### Connection errors and instance recovery

Check each connection before investigating individual features. **Test** helps you find which server needs attention.

1. Open the affected Sonarr/Radarr card.
2. Click **Test** to check the current **URL** and **API Key**.
3. Use the result to choose a check below.

| Symptom | What to check |
|---|---|
| Authentication failure | Confirm the service API key. Check whether a reverse proxy is rejecting the request before it reaches the service. |
| Timeout or network error | Check DNS, port, scheme, TLS, and reachability from the Jellyfin server/container. A working browser URL does not establish server connectivity. |
| Invalid response | Inspect upstream/proxy logs. A public URL may return an HTML login or Cloudflare page instead of JSON, even after an HTTP-success test. |
| URL rejected | Use an absolute HTTP(S) service URL. Check the URL limits in the details below. |
| One source missing, others working | Inspect the named instance error and that card's enable checkbox, URL, and key. Healthy instances can still supply results. |

??? info "Connection testing, URL limits, and error reporting"
    **Test** checks the unsaved URL/key against `/api/v3/system/status` without saving. **Validate Mappings** checks syntax only. Authentication failures can return 401/403.

    For services behind interactive login proxies, use an internal API address in **URL**, **Shoko URL**, or the relevant connection field, and put the public address in browser mappings. Loopback addresses are allowed, but `localhost` refers to the Jellyfin server/container, not your browser's machine. LAN addresses are not generally prohibited.

    The URL guard rejects specified cloud-metadata hosts/IPs, unspecified addresses such as `0.0.0.0`, and IPv4 `169.254.0.0/16`. The container aliases `host.containers.internal` and `host.docker.internal` have limited exceptions for host mappings in that range; metadata ranges remain blocked. Use the alias rather than a literal link-local IP where your container runtime provides it.

    Queue, Calendar, and title-lookup errors identify the affected instance. The same error notification will not keep repeating until the connection recovers, so check the browser console and server logs even if you see no new notification. History errors appear in server logs rather than the named instance errors shown for the queue.

If settings show an unreadable Sonarr/Radarr instance list, ordinary **Save Settings** preserves its stored value. Corrupt lists do not trigger legacy fallback. Recover from a backup where possible.

!!! warning "Reset replaces the unreadable configuration"
    **Reset Sonarr instances (clears stored value)** or **Reset Radarr instances (clears stored value)** asks for confirmation. Saving afterward clears the unreadable entries. Recreate the cards and save only when you are ready to replace that configuration.

### Tags Not Syncing

Tag sync copies source tags into Jellyfin metadata. Check the task first, then distinguish missing metadata from missing tag links.

1. Under **\*arr** → **Tags Sync**, turn on **Enable Tags Sync**, configure complete enabled Sonarr/Radarr instances, then click **Save Settings**.
2. Run **Sync Tags from \*arr to Jellyfin** from **Scheduled Tasks**. Saving alone does not run it, and the task has no default triggers. Add your own trigger for recurring runs.
3. Check that source tags exist.
4. If **Sync to Jellyfin Filter** is set, use comma- or semicolon-separated source names without the prefix. Putting each name on a new line does not work for sync, even though the form suggests it.
5. Inspect the Jellyfin item's metadata tags. **Tag Prefix** is added during sync; source tags do not need to contain it.
6. Check task/server logs for a failed or disabled instance and review cleanup before running again.

!!! warning "Preserve tags while investigating"
    **Clear old tags before sync** removes tags starting with the current prefix even on unmatched items or empty/failed source results. Turn it off if you need to preserve existing tags. Changing the prefix does not remove tags bearing the old prefix.

If tags are present in metadata but missing as links:

1. Check **Show synced tags as links**, the exact prefix spelling/case, and **Tag Filters**.
2. Use one unprefixed name per line for **Show as Links Filter** and **Hide Specific Links Filter**. The hide filter wins.
3. Reload the web client after updating metadata or filters.

Seeing existing tag links does not require administrator status or **Enable Tags Sync**.

??? info "Tag matching and prefix behavior"
    Movie sync matches TMDB IDs (or a unique IMDb ID); series sync matches TVDB, TMDB, or IMDb IDs, whichever the item has. See [How titles are matched](arr-features.md#tag-filtering). Sync updates movies and series in your library, excluding virtual placeholders.

    A blank **Tag Prefix** is saved, synced, and linked as `JE Arr Tag: `. See [tag settings and examples](arr-features.md#arr-tags).

### Calendar Not Loading

A blank Calendar page and a Calendar with no events need different checks. Start by confirming the page is enabled and opens from the right place.

1. Under **Pages** → **Calendar Page**, turn on **Enable Calendar Page**, click **Save Settings**, and reload the web client.
2. Verify at least one source: a complete enabled Sonarr/Radarr instance, or both **Shoko URL** and **Shoko API Key**. A Shoko-only Calendar needs neither Sonarr nor Radarr. **Enable \*arr Links on Detail Pages** is not required.
3. Check how you are opening it: standalone, Plugin Pages, native Home tab, or Custom Tabs. Use the matching entry point; see [page placement](arr-settings.md#page-placement).
4. Distinguish a blank/unready page from **No upcoming releases**. The former points to client injection or placement; the latter can be successful loading with no visible events.

??? info "Page entry points and loading diagnostics"
    For standalone mode, use `/web/index.html#/calendar`, including the deployment's Jellyfin base path. When a detected Plugin Pages integration is selected, open its registered Calendar entry instead. Plugin Pages 3.0+ supports live registration; restart for older versions or if logs say live registration failed.

    Plugin Pages loads an authenticated Calendar fragment from `/JellyfinEnhanced/calendarPage`, registered as `Jellyfin.Plugin.JellyfinEnhanced.CalendarPage`. Requests uses `/JellyfinEnhanced/downloadsPage`, registered as `Jellyfin.Plugin.JellyfinEnhanced.DownloadsPage`. These fragments are not replacements for the standalone hashes. They wait up to five seconds for the JE module before showing **Jellyfin Enhanced not ready.** Check script injection, failed asset loads, and browser-console errors separately from service credentials.

    For Custom Tabs, use your browser's developer tools to check the active Home tab for `.jellyfinenhanced.calendar` or `.jellyfinenhanced.requests`. A missing marker means the tab needs its Calendar or Requests HTML; a present but empty marker means JE has not loaded or displayed the page. If automatic creation failed, use **Retry** on the plugin detection banner or reload and save again. A saved JE configuration does not guarantee that the companion tab was created.

    Native tabs use generated Home links containing a current `tab` index and stable `jeTab=calendar` or `jeTab=requests`. Do not reuse a fixed tab index. Jellyfin 12's experimental layout can hide the tab-strip button; use header access. Companion-plugin navigation depends on layout and viewport; Modern Layout sidebar access is mobile-only.

#### Empty or incomplete Calendar results

Filters can hide events even when a source loads successfully. Check the visible controls first, then access and source settings.

1. Return to **Today**, change the view, and clear selected chips and **NOT**. **AND** between mutually exclusive release categories can show nothing.
2. Turn on **Unmonitored** if the missing upstream event is unmonitored; it is excluded by default.
3. Check **Filter by Library Access** and your Jellyfin library permissions. A title not in Jellyfin yet shows only to people who can open its destination library; when that can't be told, only administrators see it, and the Requests page's System tab path doctor flags the root. Unmatched Shoko events can remain visible.
4. Review **Show Requested Only (Default)** and **Force Only Requested Items**. These need request data for your linked Seerr account; they exclude Shoko events. Forced mode hides the **Requests** chip.
5. For Shoko, verify the six episode-type switches; only **Episodes** defaults on. Enter both **Shoko URL** and **Shoko API Key**. A URL without a key, or a key without a URL, produces an error. Check Shoko API v3 access and server logs.
6. Check [Hidden Content filtering](#hidden-content-filtering) and named source failures.

??? info "Highlighting, matching, and event times"
    Watchlist highlighting uses Jellyfin's like (Likes) flag, not the favorite (heart) flag. Under **Seerr**, **Add requested media to Watchlist** and **Sync Seerr Watchlist → Jellyfin** set this flag for matching library items; see [Seerr settings](../seerr/seerr-settings.md). Watched markers reflect whether you have played or started the matched episode or movie; watching other episodes does not mark an upcoming episode.

    If an available event does nothing when clicked, confirm Jellyfin has scanned and matched it. The **Available** arrow opens details rather than starting playback. A Shoko event is **Available** when Shoko reports an episode file. Shoko matching needs `Shoko Series`/`Shoko Episode` provider IDs. Unmatched anime may still offer an administrator's **Open in Shoko** link. Event dates use your browser's local time. Shoko air dates are also converted to your browser's local time, so depending on your timezone an event can show a time or appear on the previous day.

#### Blank screen / Cannot find module error

If Calendar or Requests is blank and the console shows `Cannot find module './'`, Cloudflare Rocket Loader may be interfering with JavaScript module loading. This symptom alone does not prove the cause.

1. In the Cloudflare dashboard, select your domain.
2. Open **Speed** → **Settings** → **Content Optimization** and turn **Rocket Loader** off. Use a configuration rule for your Jellyfin hostname if you need to limit the change.
3. Reload and compare the result.

See [Cloudflare's Rocket Loader instructions](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/enable/) and [issue #570](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/570).

### Requests Page Issues

The shared **Requests** page combines **Downloads**, Seerr **Requests**, optional **Issues**, and **History**. For request-list permissions, approval/decline, issues, or **Coming Soon**/**Orphaned** states, see [Seerr features](../seerr/seerr-features.md).

There is no independently enabled second Seerr Requests page.

#### Downloads Not Showing

Check the queue source and your access rules if Downloads is empty. Administrators and viewers can get different results.

1. Under **Pages** → **Requests Page**, enable **Enable Requests Page** and **Show Downloads in Requests Page**, then save and reload.
2. Verify complete enabled Sonarr/Radarr cards and use **Test**. Confirm the upstream queue contains records.
3. Compare administrator and viewer results. Administrators bypass filtering. Viewers only see titles they could open in Jellyfin; with **Filter Downloads by User Requests** on they also need enabled/configured Seerr, a linked account, and requested titles.
4. Clear download search/status selections and check Hidden Content filtering.
5. Inspect named queue errors and server logs. Healthy instances can return data despite another source failing.

Auto-refresh is not required for the initial load. Neither queue nor History requires **Enable \*arr Links on Detail Pages**.

!!! warning "Turning off ownership filtering shares download titles"
    Turning off **Filter Downloads by User Requests** shows authenticated viewers other users' queue/history titles they could open in Jellyfin, subject to the independent History administrator restriction.

??? info "Queue limits and ownership matching"
    JE reads every queue row, page by page. Viewer requests match by TMDB ID and media type. No linkage/requests or missing upstream TMDB IDs can produce empty results.

#### Status Not Updating

Requests can refresh itself while you follow a download. If its status looks stale, check refresh settings and the upstream service.

1. Check **Enable Auto-Refresh** and **Poll Interval (seconds)**.
2. Use the refresh icon beside **Downloads** to reload enabled sections.
3. If the upstream queue is stale too, investigate the downloader or upstream import.

| Setting | Default | What it does |
|---|---|---|
| **Enable Auto-Refresh** | On | Refreshes enabled sections. |
| **Poll Interval (seconds)** | 30 | Sets the refresh interval; form range 30–300 seconds. |

??? info "Polling and server caching"
    Polling stops when you leave the standalone page or switch away from its native Home or Custom Tabs tab. With Plugin Pages, it can keep refreshing after you navigate away, until you reload or close the browser page. Hidden browser tabs are always skipped.

    Queue and History have separate shared server caches with a lifetime tied to the interval, clamped to 5–300 seconds internally. A manual refresh may still return cached data.

**Completed** describes transfer completion; **Importing**, **Warning**, and **Failed** come from upstream tracking. Check Sonarr/Radarr's import errors and Jellyfin scanning when 100% progress does not become library availability. Seerr availability updates are separate; see [Seerr settings](../seerr/seerr-settings.md) for its library-sync controls.

#### History missing or shorter than expected

History shows recent import results, rather than a full archive. Check section and access settings if it is missing.

1. Keep **Show Downloads in Requests Page** and **Show Download History Section** on.
2. Check **Restrict Download History to Admins**. It hides History from ordinary viewers and is enforced server-side.
3. Check ownership filtering; it also applies to History.

??? info "History record limits"
    JE reads the latest 200 history records per instance, retains import/failure events, groups Sonarr records by download ID, and keeps at most 200 merged cards before viewer filtering and pagination. **Imported**, **Import Failed**, and mixed **Partially Imported** groups are shown; grabs, renames, and deletions are omitted. This is a recent window, not a full archive. Check server logs for History errors; these do not appear as the named instance errors shown for the queue.

### Hidden Content filtering

Hidden Content filters remove matching hidden items from selected parts of Calendar and Requests. You can change your personal filters.

1. Check that the server's **Enable Hidden Content** and your personal **Enable Content Hiding** are both on.
2. Open your personal **Hidden Content** settings and review **Filter Calendar** and **Filter Requests**.
3. Reload the relevant page after changing these options.

| Setting | Default | What it does |
|---|---|---|
| **Filter Calendar** | On | Admin starting value; you can override it with personal **Filter Calendar**. |
| **Filter Requests page** | On | Admin starting value; you can override it with personal **Filter Requests**. |

**Filter Calendar** hides matching items in **Month**, **Week**, and **Agenda**; hidden items remain visible in **Day**. **Filter Requests** hides matching items in **Downloads** and **Requests**, while **History** and **Issues** remain unchanged. See [Hidden Content](../enhanced/enhanced-features.md#content-management).

### Diagnostic endpoints

Use the signed-in web client's network panel to inspect responses when the checks above do not explain the problem. The routes and limits below help identify where a request fails.

??? info "Authenticated routes and response limits"
    These routes use the `/JellyfinEnhanced` prefix and Jellyfin authentication. Inspect responses from the signed-in web client's network panel; use [the API reference](../advanced/api.md) for broader API details.

    | Endpoint | Access / diagnostic use |
    |---|---|
    | `GET arr/validate/sonarr?url=…`, `GET arr/validate/radarr?url=…` | Administrator; the **Test** action sends the service key in `X-Arr-ApiKey`, not the URL. |
    | `GET arr/identify-url?url=…` | Administrator; probes a supplied URL to identify its service, not an owning instance. |
    | `GET arr/series-slug?tvdbId=…` | Administrator; one title against the first enabled Sonarr instance. |
    | `GET arr/series-slugs?tvdbId=…` | Administrator; one title across enabled Sonarr instances, with matches/errors. |
    | `GET arr/movie-instances?tmdbId=…` | Administrator; one movie across enabled Radarr instances, with matches/errors. |
    | `GET arr/links?tmdbIds=…&tvdbIds=…` | Administrator; batches comma-separated positive IDs, ignoring malformed/duplicate entries; requires at least one and permits at most 100 distinct parsed IDs combined. |
    | `GET arr/queue` | Signed-in viewer; applies request-ownership filtering. |
    | `GET arr/history?take=…&skip=…` | Signed-in viewer; applies History enablement, administrator restriction, and ownership gates. `take` defaults 20, capped at 50; `skip` defaults 0 and cannot be negative. |
    | `GET arr/requests?take=…&skip=…&filter=…&userOnly=…` | Signed-in linked viewer with configured Seerr for data; `take` defaults 20, capped at 200, `skip` defaults 0/nonnegative, `userOnly` defaults false. See Seerr features for visibility permissions. |
    | `POST arr/requests/{requestId}/approve`, `POST arr/requests/{requestId}/decline` | Linked Jellyfin administrator or Seerr user with `ADMIN`/`MANAGE_REQUESTS`; missing identity/link/permission can fail separately. |
    | `GET arr/calendar?start=…&end=…` | Signed-in viewer; library filtering applies. Defaults to today UTC through 90 days; invalid dates keep defaults, reversed ranges swap, and ranges over 365 days are capped. |
    | `POST arr/calendar/user-data` | Signed-in viewer; reads caller-specific watchlist/watched flags for supplied events, without saving preferences. |

    Enabling or disabling a page controls its display and navigation; it does not turn off every data-reading API. Batch links return per-ID `matches`/`errors`; absent instances yield empty results, while all-disabled or corrupt configuration can report errors. Bazarr has no dedicated integration endpoint; Shoko data is available through Calendar.

## Support

Check the [FAQ](../faq-support/faq.md) and [issue-reporting guide](../faq-support/report-issues.md). You can report issues on [GitHub](https://github.com/n00bcodr/Jellyfin-Enhanced/issues).

Include:

- Plugin and Jellyfin versions.
- Layout and page-placement mode.
- Affected service and instance.
- Differences between administrator and viewer results.
- Relevant browser, server, and upstream errors.

!!! warning "Remove credentials before sharing"
    Remove API keys and authentication tokens from logs or screenshots.


### Incomplete JE Discover/search verification

When a restricted person's list loads but some title evidence cannot be checked,
`/JellyfinEnhanced/acquire/discover` and `/JellyfinEnhanced/acquire/search` return HTTP 200 with
`outcome: "partial"`, `reason: "evidence_unavailable"` and `certainty: "Unknown"`. The `answer` keeps
only safe cards, with `complete: false`, `verification: "partial"` and `retryAfterSeconds: 5`.
The response is `private, no-store`, has `Retry-After: 5`, and never answers 304. An empty partial
answer does not mean there are no matches. Completed pages retain HTTP 200/ETag behavior and
`complete: true`, `verification: "complete"`, `retryAfterSeconds: null`.

The UI must retain a retry/unavailable state for partial answers, including a partial answer containing
safe cards. HTTP 503 is reserved for a failed TMDB list read (`discover_unavailable`). Failed or incomplete
evidence is retried after the gate's five-minute failure cache expires; in-flight reads may recover
earlier by completing in the background. Avoid rapid retries. The initial list read has its own
transport timeout; the two-second budget applies to title evidence preparation, including slot waits
and repeated preparation after settings change.
