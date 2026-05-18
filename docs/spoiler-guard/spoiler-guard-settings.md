# Spoiler Guard Settings

Admin configuration for the **Spoiler Guard** section of the Jellyfin Enhanced plugin. All toggles here are server-wide policy — users opt into Spoiler Guard for individual shows / movies / collections per-user, but the admin decides what protection looks like once they do.

![Spoiler Guard admin settings](../screenshots/spoiler-blur/web-10-settings.png)

!!! info "Where to find it"

    Jellyfin Dashboard → Plugins → **Jellyfin Enhanced** → scroll to the **Spoiler Guard** section.

---

## Master switch

### Enable Spoiler Guard

**Default: Off.** When off, the per-user opt-in has no effect and no user-facing UI appears anywhere. Turn on once you want users to be able to opt their shows in.

This is the only switch that requires explicit admin opt-in. Everything below it is the default policy that applies when a user enables Spoiler Guard for one of their shows.

---

## Image Replacement Mode

How an unwatched card looks once a user has opted into Spoiler Guard for it.

### Show stock cards (default)

The episode-specific image is replaced with a **parent-level placeholder** picked so the aspect ratio matches the card slot:

| Item type | Replacement |
|---|---|
| Episode thumbnail (16:9) | Series Backdrop |
| Season poster (2:3) | Series Primary |
| Movie via opted-in Collection (2:3) | Collection Primary |
| Movie directly opted in / no safe parent | Flat dark card |

Useful when partial-blur feels like a tease — the user sees a consistent grid of "this show" / "this franchise" art instead of mystery boxes, and there's no chance of recognising the actual scene.

### Blur images

The original image runs through SkiaSharp's `CreateBlur` (a separable Gaussian, native code, ~130 ms on a 1280×720 frame). Silhouettes and dominant colours stay visible — useful for users who prefer a softer "something is there" hint over a clean placeholder.

The **Blur intensity** slider (1-100, default 40) controls the sigma. 5 is mild, 40 hides scene content while keeping silhouettes and dominant colours visible, 100 is a solid blob. The intensity slider is ignored when Show stock cards is selected.

![Heavily blurred episode card](../screenshots/spoiler-blur/web-03-bluey-s2.png)

---

## Also blur Backdrop / Art

**Default: Off.** When off, only **Primary** / **Thumb** / **Screenshot** images get replaced — the wider Backdrop / Art images shown on detail pages and in collections pass through unblurred. Turn on for the strictest mode.

Most spoilers live in the per-episode thumbnails and per-season posters; backdrops are usually less plot-specific (curated cinematography rather than reveal stills), so the default scopes protection to the surfaces with the highest spoiler risk.

This toggle also controls how `ImageBlurHashes` are stripped on the DTO: by default the BlurHashes for Primary / Thumb / Screenshot / Chapter are dropped (matching the image-bytes protection), but Backdrop / Art BlurHashes pass through. Turn this toggle on to also drop Backdrop / Art BlurHashes so the loading-state preview stays consistent with the eventual served bytes.

---

## Show movie posters even when Spoiler Guard is on

**Default: Off.** When on, a Spoiler-Guard-listed movie's **Primary** (poster) and **Thumb** images pass through unblurred. Useful when admins find that movie posters are typically curated marketing art that doesn't reveal plot, while the per-chapter scene-thumbs inside the movie's detail page are the real spoiler vector.

What's still protected when this toggle is on:

- **Chapter** thumbnails — the "Scenes" rail on the movie detail page. Progressive-strip rules still apply (chapters before the user's resume point pass through; chapters at-or-after the resume point are protected).
- **Screenshot** images.
- **Backdrop / Art** — only if "Also blur Backdrop / Art" is also on.

What passes through clear:

- The movie's **Primary** poster — visible on home rails, search results, the movie detail page header, everywhere a Primary is fetched.
- The movie's **Thumb** image (the Primary-variant used in some surfaces).
- BlurHash placeholders for Primary / Thumb (so the loading-state preview stays consistent with the clear bytes that follow).

Series and Episodes are unaffected by this toggle — they have their own per-aspect logic (Episode → Series Backdrop, Season → Series Primary).

---

## Auto-enable on first play of a new show

**Default: Off.** When on, the first time a user plays S1E1 of a series they've never watched before, the plugin automatically adds that series to their Spoiler Guard list. They don't have to remember to toggle it before starting.

Rewatches won't trigger it (Spoiler Guard is checked against per-user watched history, not just the current play). Jumping in at later episodes also won't trigger — only a fresh S1E1 play does.

Applies to all users on the instance.

---

## Auto-enable on Seerr request

**Default: Off.** When on, every successful Seerr request a user submits via JE also registers a pending Spoiler Guard entry. When the content lands in the library, Spoiler Guard is already on for that user.

Users can also manually opt in via the **Enable Spoiler Guard** button in the Seerr More Info modal (always available regardless of this toggle), which is useful when another user has already requested the title.

---

## Strict refresh mode

**Default: Off.** Controls what happens visually on the user's screen after they toggle Spoiler Guard for a series / movie:

| Mode | What runs after a toggle |
|---|---|
| **Off (default)** | In-place image refresh only. Card images flip blur ↔ clear straight away with no page flash. Page-rendered text (Overview, episode titles, ratings) stays as-is until the user's next navigation. |
| **On** | Same in-place image refresh **plus** a full page reload so DOM text re-renders with the new server-side strip state straight away. |

Recommended off for smoother UX (no jarring page-flash); turn on if you'd rather pay the page-flash cost to see everything update at once.

The in-place refresh is also what runs automatically when a user marks an episode watched / unwatched — that path is *always* soft regardless of this setting (a reload mid-playback is too jarring).

---

## Hide metadata on unwatched episodes

A collapsible sub-section of per-field hide toggles. When the master switch is on **all of these default to on** — that's the strict-by-default posture a user opted into when they enabled Spoiler Guard for a show. Admins can relax anything they don't want.

![Full Spoiler Guard settings panel](../screenshots/spoiler-blur/web-11-settings-full.png)

### Hide episode descriptions

**Default: On.** Replaces the episode synopsis with the placeholder text below. The single biggest spoiler vector.

#### Placeholder text

**Default: `Spoiler Guard activated`.** Shown in place of the description so the client doesn't render an empty section header. The text is server-side-sanitized (HTML tags + angle brackets stripped, capped at 200 chars) on save — admins editing the plugin XML directly get the same defense-in-depth.

### Hide tags

**Default: On.** Hides both the TMDB Tags array (phrases like "Death of a main character") AND the Jellyfin Enhanced card overlays (genre, quality, language, rating tags drawn over thumbnails) on cards for unwatched episodes of Spoiler Guard series.

### Hide chapter names (keep timestamps)

**Default: On.** Strips chapter names like "X reveals Y" but keeps the timestamp markers — the seek bar still shows chapter dividers, the user can navigate via timestamp without the spoiler text. Chapter thumbnails are stripped too.

For movies, this is a **progressive strip**: only chapters whose start position is **after** the user's current playback position are hidden. Already-watched chapter names and thumbnails stay visible so a half-finished movie shows scenes up to the user's resume point, then hides everything after.

### Hide taglines

**Default: On.** TMDB taglines like "Everything changes tonight" are pure spoiler bait. Hidden via empty array (not null) to match what Jellyfin returns for an item legitimately without tags.

### Hide community rating

**Default: On.** A 9.8/10 rating on a specific episode implies a major event ("the one where X dies"). Hidden by null so clients don't render "0/10".

### Hide critic rating

**Default: On.** Same rationale as community rating.

### Hide air date

**Default: On.** A multi-month gap before an episode can imply "season finale" or "long-anticipated reveal" via release-date scheduling. Hidden by null.

### Replace episode titles

**Default: On.** Episode names become `Season X, Episode Y` instead of leaking the actual title (e.g. `The Death of Optimus`). Affects every surface where the title appears — list views, Next Up, Continue Watching, search results, the player's "now playing" overlay.

Some clients use the title in navigation tooltips and breadcrumbs where the synthesized title can look jarring. Turn off if that's a deal-breaker for your users.

### Hide cast on unwatched episodes

**Default: On.** Strips the cast list on unwatched episodes of Spoiler Guard series. Has a sub-option:

#### Cast hiding scope

| Mode | What's hidden |
|---|---|
| **Guest stars only (default)** | Only `Type=GuestStar` entries are removed. Regular cast stays — they appear in every episode anyway, so they don't reveal anything new about *this* episode. |
| **All** | Strict mode. Every People entry (regular + guest + crew) is removed. Use for shows where the regular cast appearing or *not* appearing in a given episode is itself a spoiler (e.g. a recurring villain return). |

In both modes the character name (`Role`) is also stripped from any surviving People entries — a role like "Resurrected Optimus" is a major spoiler regardless of cast strip mode.

### Hide reviews on Spoiler Guard series

**Default: On.** Suppresses the JE Reviews panel on series detail pages where the user has Spoiler Guard enabled. TMDB reviews routinely contain plot spoilers from arbitrary points in the show, and user-written reviews share that risk. Recommended on.

---

## Health: spoiler-state corruption recovery

Each user's Spoiler Guard preferences are stored in a per-user `spoilerblur.json` file on the server. If that file gets corrupted (truncated by a power loss mid-write, mangled by a backup tool, etc.), the plugin **backs the corrupt file up to `spoilerblur.json.corrupt-{timestamp}`** and surfaces an admin-visible banner in the JE management UI so the affected user knows to re-enable their items.

This is automatic and doesn't need configuration. The banner is per-user (each user sees their own corruption events; admins see all so they can advise affected users).

---

## What gets logged

For diagnostics, the plugin logs (rate-limited) to `/config/log/JellyfinEnhanced_{date}.log`:

- Spoiler Guard auto-enable events: `SpoilerAutoEnable: enabled Spoiler Guard for series '<name>' (...) on first-play of S1E1 by user <id>`
- Seerr pre-acquisition records: `Spoiler Guard pending recorded tv:<tmdbId> for <user>`
- Promotion events when a pending entry lands as a real library item: `SpoilerSeerrPromoter: promoted tv:<tmdbId> -> series <id> for user <id>`
- Per-(user, scope) cache evictions when watched-state changes
- Any unexpected response shape from a Jellyfin upgrade (rate-limited, one warn per (Controller, Action) per process lifetime)
- Any corruption event with the backup path

Most logs are at INFO; corruption + unexpected shapes log at WARNING.

---

## Defaults summary (for a fresh install)

| Setting | Default |
|---|---|
| Enable Spoiler Guard | Off (admin must opt in) |
| Image Replacement Mode | Show stock cards |
| Blur intensity | 40 |
| Also blur Backdrop / Art | Off |
| Show movie posters even when Spoiler Guard is on | Off |
| Auto-enable on first play | Off |
| Auto-enable on Seerr request | Off |
| Strict refresh mode | Off |
| Hide episode descriptions | On |
| Placeholder text | `Spoiler Guard activated` |
| Hide tags | On |
| Hide chapter names | On |
| Hide taglines | On |
| Hide community rating | On |
| Hide critic rating | On |
| Hide air date | On |
| Replace episode titles | On |
| Hide cast on unwatched episodes | On |
| Cast hiding scope | Guest stars only |
| Hide reviews on Spoiler Guard series | On |

The strict-by-default posture means once an admin flips the master switch and a user opts a show in, every spoiler surface is protected without further configuration. Admins who want a looser setup can untick anything they don't need.
