# Spoiler Mode — Field-Stripping Plan

## What you asked for

When a user has Spoiler Mode enabled for a series, the plugin should ALSO
hide selected metadata fields on UNWATCHED episodes — not just the
thumbnail. Same per-show scoping as the image blur. All server-side, no
DOM manipulation, no impact on performance for users not using the
feature.

## Fields to strip (proposal)

For each field below, expose a per-admin toggle in the plugin config
page (`Spoiler Blur` fieldset already exists — add these under it).
Defaults are listed but configurable.

| Field | Default | Spoiler risk | Notes |
|---|---|---|---|
| `Overview` (episode description / synopsis) | **strip** | ★★★★★ | Single biggest spoiler — explicitly says what happens. |
| `Name` (episode title) | **leave alone** | ★★ | Often itself a spoiler (e.g. "The Death of X"), but stripping breaks UI everywhere — use a generic replacement like `Episode N` instead of empty string. Default OFF; opt-in. |
| `People` cast/crew with `Type=GuestStar` | **strip** | ★★★★ | "Guest star: Y" reveals an unexpected actor. Stripping ONLY guest stars keeps regulars visible (regulars never spoil). |
| `People` cast/crew with `Type=Actor` (regular cast) | leave alone | ★ | Regular cast appears every episode → no spoiler. |
| `Tags` (e.g. content tags from TMDB) | **strip** | ★★★ | Includes things like "Death of a main character", "Wedding", "Reunion". |
| `CommunityRating` (TMDB user rating) | strip (opt-in) | ★ | "9.8/10" implies a major event happens. |
| `CriticRating` | strip (opt-in) | ★ | Same rationale as Community. |
| `OfficialRating` (e.g. TV-MA) | leave alone | ☆ | Not a spoiler. |
| `RunTimeTicks` (duration) | leave alone | ☆ | Not a spoiler. |
| `Studios` (e.g. HBO) | leave alone | ☆ | Not a spoiler. |
| `Genres` | leave alone | ☆ | Series-level, not episode-level. |
| `IndexNumber` / `ParentIndexNumber` (S/E numbers) | leave alone | ☆ | Required for navigation. |
| `PremiereDate` / `DateCreated` | leave alone (opt-in to strip) | ★ | Air date can imply "season finale" if it's far apart from previous. |
| `Chapters` (timestamp markers) | **strip** | ★★★★ | Chapter NAMES often spell out the plot ("X dies", "Y revealed"). |
| `Trickplay` / `LocalTrailers` | leave alone | ☆ | Bytes, not metadata. |
| `RemoteTrailers` (TMDB trailer URLs) | leave alone | ☆ | Not a spoiler typically. |
| `MediaStreams` (subtitle preview text in some apps) | leave alone | ☆ | Subtitle TEXT could spoil but that's the playback path, not metadata. |
| `Taglines` (e.g. "the moment everything changes") | **strip** | ★★★ | Often pure spoiler bait. |

Things you mentioned and I'd suggest leaving alone:
- I'd default `Name` (episode title) to LEAVE ALONE because most clients
  break visually without a title and Jellyfin's UI uses the title in
  navigation tooltips, search, "currently playing" overlays, etc.
  Better: opt-in to title-replacement that substitutes
  `Episode {IndexNumber}` rather than empty string.

Things to consider that you didn't list:
- `Chapters` (markers — strip the names, keep the timestamps so playback
  scrubbing still works).
- `Taglines` (TMDB tagline like "Everything changes tonight").
- For movies (not in scope right now but adjacent): `RemoteTrailers`
  could spoil if their thumbnails are visible.

## Architecture (zero-overhead-when-disabled)

A second action filter — `SpoilerFieldStripFilter` — runs on item-listing
endpoints. Fast-path bail order:

```
1. Plugin master switch SpoilerBlurEnabled? → if no, return next() sync
2. ANY field-strip toggle on?                → if no, return next() sync
3. Action is on a /Users/{id}/Items/, /Items/{id}, /Shows/{id}/Episodes,
   /Shows/NextUp, /Items?, or /Search/Hints surface?
                                              → if no, return next() sync
4. Caller is an authenticated user with at least one series in spoiler
   list?                                      → if no, return next() sync
5. Inspect post-action result: ObjectResult containing BaseItemDto[] or
   QueryResult<BaseItemDto>; for each item, if Type=Episode and SeriesId
   is in user's list and UserData.Played != true: strip configured
   fields IN PLACE.
```

The first three checks together cost ~3 string compares + 1 dict lookup —
indistinguishable from filter overhead measured today (~0 ms p50 for
non-image MVC actions). The user-state load is already cached
per-HttpContext for the image filter; share the cache.

The expensive step (per-item field strip) runs only on items that MATCH
the conditions — typical home-page render touches no Episode items, so
the cost is zero on home pages even when the feature is on. On a series
page where you're specifically loading the episode list, the strip is
O(episodes-in-season) which is small (typically 10-25) and operates on
already-decoded DTOs in memory.

## Configuration UI

Add to `configPage.html` `Spoiler Blur` fieldset, gated by
`spoilerBlurEnabled`:

```
<details>
  <summary>Hide metadata on unwatched episodes</summary>
  <input id="spoilerStripOverview"      type="checkbox"> Hide episode descriptions
  <input id="spoilerStripGuestStars"    type="checkbox"> Hide guest stars
  <input id="spoilerStripTags"          type="checkbox"> Hide tags
  <input id="spoilerStripChapters"      type="checkbox"> Hide chapter names (keep timestamps)
  <input id="spoilerStripTaglines"      type="checkbox"> Hide taglines
  <input id="spoilerStripCommunityRating" type="checkbox"> Hide community rating
  <input id="spoilerStripCriticRating"  type="checkbox"> Hide critic rating
  <input id="spoilerReplaceTitle"       type="checkbox"> Replace episode titles with "Episode N"
  <input id="spoilerStripPremiereDate"  type="checkbox"> Hide air date
</details>
```

Each maps 1:1 to a new `bool` in `PluginConfiguration.cs`.

## Implementation order

1. Add the 9 new admin toggles to `PluginConfiguration.cs` + constructor
   defaults + `configPage.html` UI + load/save JS. Add to
   `GetPublicConfig` so the JS frontend knows what's stripped (so the
   frontend can hide the corresponding labels — e.g. "Description"
   header — when the field comes back empty from a stripped response;
   otherwise users see an awkward "Description" header followed by
   blank space).

2. Create `Services/SpoilerFieldStripFilter.cs` — `IAsyncActionFilter`
   targeting:
   - `Items / GetItems` + legacy
   - `Items / GetItem` (single-item fetch)
   - `UserLibrary / GetItemsByUserId` + legacy  
   - `TvShows / GetEpisodes`, `GetNextUp`, `GetUpcomingEpisodes`,
     `GetSeasons`
   - `Suggestions / GetSuggestions` + legacy
   - `Search / GetSearchHints`
   Mirror the existing route table pattern from `HiddenContentResponseFilter`.

3. Per-item strip logic — pure function over `BaseItemDto`:
   ```csharp
   void StripIfApplicable(BaseItemDto item, UserSpoilerBlur userState,
                          User user, PluginConfiguration cfg)
   ```
   Walk a switch on `item.Type` and apply only Episode handling. For
   each enabled toggle, null-out / replace the corresponding property.

4. Register in `PluginServiceRegistrator`, after the existing
   `HiddenContentResponseFilter`. Filter ordering matters: HC drops
   items entirely, ours edits them — HC must run first so we don't waste
   work on items HC will drop.

5. Add 9 translation keys for the configPage labels (admin page is
   English-only per project rule, so no per-locale propagation needed
   for these specific keys — but keep the toast strings the user-facing
   JS already has).

## Performance budget

Round-2 measurements: filter overhead on non-matching MVC actions is
~0 ms (the sync fast-path returns `next()` directly). The new filter
adds ONE more sync fast-path with three short-circuit checks before
deciding to inspect a response. Expected per-action overhead when the
feature is off (or when no Episode items are in the response):
**measurably zero** (within bench noise).

When the feature is on AND response contains Episodes: O(N) walk of
the result list, each item costing a dict lookup + a few null-outs.
For a series page returning 25 episodes, total added cost is in the
low microseconds — invisible against ASP.NET's serialize-to-JSON cost
for the same response.

NO database queries are added. We rely on the already-loaded
`UserData.Played` flag inside the DTO Jellyfin serializes back. If
Jellyfin omits `UserData` from a particular endpoint's response (rare),
we treat it as "played" and skip stripping — fail-safe, not fail-open.

## Out of scope for this branch

- Stripping fields on the player's now-playing OSD (different code path,
  different filter target — could be added later).
- Subtitle/audio track names (some shows label tracks with episode
  context — out of metadata scope).
- Stripping in the calendar / upcoming-episodes view (similar approach,
  but that endpoint already shows unaired episodes by design).

## Decision points before I start

1. **Default toggles:** I propose Overview + GuestStars + Tags +
   Chapters + Taglines ON by default; ratings + premiere date + title
   replacement OFF (opt-in). OK to ship those defaults?
2. **Title replacement:** opt-in only. Replace with `Episode {n}` or
   `S{p}E{n}` or just `?`?
3. **Guest stars only, or all `People`?** I'd ship guest-stars only
   default; opt-in for stripping all cast.
4. **Description: total strip or replace with placeholder text?** I'd
   leave it null/empty so the client's existing "no description
   available" UI handles it gracefully. Some clients show "—" instead.
