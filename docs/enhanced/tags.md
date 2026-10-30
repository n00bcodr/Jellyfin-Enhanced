# Tags & Badges

See quality, genres, audio languages, scores, age classifications, and what is new or trending while browsing your library. You can choose which badges appear, pick a layout for them (corners, bands, a caption below the poster, a summary pill or a minimal set), set their order and limits, and change their colors. People Tags add age and birthplace information to cast cards.

![Library posters with quality, genre, language and rating tags](../images/tags/library-tags.webp)
*The optional tag groups are enabled for this example; all eight groups start off.*

## Set up your tags

You can choose tags for your own account. If you administer the server, you can also set the starting values for users.

**How to use — personal preferences:**

1. Open the **Jellyfin Enhanced** panel from the user profile menu on Jellyfin 12 or the sidebar on 10.11. You can also press ++question++.
2. Select **Media Tags** and choose your tags on its tabs (see [The Media Tags section](#the-media-tags-section)). Changes save automatically to your Jellyfin account on the server.
3. Refresh another open client to load changes you made elsewhere.

**How to use — admin defaults:**

1. Open **Dashboard** → **Plugins** → **Jellyfin Enhanced** → **Display** → **Media Tags**.
2. Choose your settings and click **Save Settings**.
3. Refresh affected web clients to load the changes.

![Media Tags defaults and category controls](../images/admin/media-tags.webp)

Tables below show factory defaults. Rows marked “Admin / personal” give both exact labels for the same preference. Most admin defaults become the starting values for new personal settings. Saved personal values take precedence, so changing a server default does not overwrite a user's choice.

!!! note "Hover hiding starts off"
    **Hide Tags on Hover** follows the admin value for new users, and overwriting personal settings applies it too.

### The Media Tags section

Every personal poster tag setting lives in one section of the panel, **Media Tags**, between **UI Settings** and **Hidden Content**. Its tabs each do one job, and a live preview beside them shows the result as you change things.

![The Media Tags section on its Layout tab: layout tiles, label density and quick switches, with the live preview on the right](../images/tags/media-tags-hub.webp)

| Tab | What you set there |
|---|---|
| **Layout** | Your default look: one tile per [layout](#layouts) with a line describing the selected one, **Label Density** (**Full** / **Compact**), per-shape looks for **Episode thumbnails** and **List rows**, and the quick switches **Hide Tags on Hover**, **Show Tags in Native Clients (Experimental)** (only while the administrator has [Native Poster Tags](#native-poster-tags-experimental) on), **Show People Tags** and **Show Audio Languages**. |
| **Groups** | The [tag groups](#tag-groups-order-position-limits) in priority order: move buttons, the on/off switch, and per group its position, **Show up to** and **Include** choices, plus **Reset to defaults**. The Status row's **Badges** button opens the next tab. |
| **Status badges** | Which [status badges](#status-tags) the Status group may show: **Just Added**, **New releases**, **Trending**, **Schedule**, **Milestones** and **Series status**, each with a sample badge. The two time windows the administrator chose are shown beside Just Added and New releases. **Status position and limit in Groups** goes back to the Status row. |
| **Rules & locks** | Your [rules and locked items](#rules-and-locked-items) on the left, the **Add a rule** form on the right. |
| **Colours** | Your [Tag Colours](#tag-styles-and-css) preset, one tile per preset with three sample chips in its real colours. Only shown while the administrator lets users pick a preset. |
| **Server** | Administrators only: shortcuts to **Server defaults for new users**, the **Tag colours editor**, the **Tag cache** and **Native poster tags** on the plugin configuration page. Other users never get this tab. |

**The live preview** draws four sample cards with the same layout code and tag styles as your library: a movie poster, a series poster, an episode still and a 92px list row. Each says where its look comes from (**Default**, **🔒 Locked**, **Rule N** or a shape look), decided the same way as for real cards: the series stands in for your most recently locked item and the episode for the first enabled rule, so a lock or rule change shows at once. **Resting** / **Hover** switches to what Summary and Minimal reveal on hover. While you edit a group, its chips are outlined and the others dimmed. Overflowing chips show as `+N`, as on real cards.

On a phone the section fills the screen: the tabs use short names (**Badges**, **Rules**), and the preview folds into a one-line strip under them. The strip names the sample that your current edit affects (the episode on **Rules & locks**, the series for schedule badges) and lists its chips, the edited group's first; tap **Preview** to unfold the full preview.

![Media Tags on a phone: the Layout tab with the preview strip, the unfolded preview, and Rules & locks](../images/tags/media-tags-hub-phone.webp)

![Switching tabs and changing settings: the preview follows every change](../images/tags/media-tags-tabs.gif)

The panel's **Search settings…** box finds every Media Tags control by its label (for example *Trending*, *Show up to* or *Move Language up*); pick a match to open its tab, and its group if needed, with the control focused. Everything in the section works from the keyboard: arrow keys move between tabs and between tiles, and focus stays on the control you used after a move, a delete or an unlock. **UI Settings** keeps a short **Media Tags moved to its own section** note with an **Open** button.

!!! warning "Replacing everyone's preferences"
    **Overview** → **Quick Actions** → **Overwrite everyone's personal settings** replaces saved personal preferences with the current admin values. It also replaces other Enhanced display/playback preferences, so each user would need to reapply their customizations. Read [Settings Overview](../getting-started/settings-overview.md) before using it.

### Where tags appear

You'll see poster badges in library grids, home rows, Jellyfin search results, and supported rows on detail pages. People Tags appear on cast cards instead.

| Feature | What you see | Where it appears |
|---|---|---|
| [Quality Tags](#quality-tags) | Resolution, source, HDR, special format, video codec, sound, edition | Supported library cards; series/season quality follows your aggregation policy |
| [Genre Tags](#genre-tags) | Genre icons (three by default), with names on hover | Supported library cards with genre metadata |
| [Language Tags](#language-tags) | Distinct flags (three by default) or a no-dialogue symbol | Supported library cards; cached series/season flags cover their episodes, collection flags cover linked movies |
| [Rating Tags](#rating-tags) | Community star score and critic percentage | Supported library cards, subject to item-type and row scopes |
| [User-review chips](#user-review-chips) | Average visible review rating, or an optional dash | Movie, series, season, and episode cards with a usable review identity |
| [Age Rating Tags](#age-rating-tags) | Official parental/content classification | Supported library cards with classification metadata |
| [Status Tags](#status-tags) | One badge: trending, release, schedule, milestone or series status | Supported library cards; web only |
| [People Tags](#people-tags) | Age, age at release, birthplace, deceased styling | Cast and guest-cast cards on web item detail pages |
| [Audio language links](#audio-language-links) | Named audio languages linking to Jellyfin tag lists | Movie, series, season, and episode detail pages |
| [Player badges](#player-badges) | Scores in the controls; optional age/advisory badge at playback start | Jellyfin web video player |

[Native Poster Tags](#native-poster-tags-experimental) draw supported poster groups into images for eligible native clients. Their page and row limits differ from web overlays.

!!! note "Tags need metadata"
    Each badge needs suitable metadata. A supported card does not guarantee every tag will appear.

??? info "Supported cards and locations"
    Web poster overlays apply to supported movie, series, season, episode, collection (`BoxSet`), and video cards, including videos in Home Videos/Photos libraries. Detail-page rows include season/episode cards and the series **Next Up** shelf. Large episode list images can also carry overlays.

    The web overlays skip the large artwork in the detail page's information area, cast cards, chapter/scene cards, **My Media**, modal dialogs, small list images, and plugin/catalog/device/library administration cards. Seerr search and discovery cards do not receive these library tags.

### Layouts

A layout decides where the poster groups appear and how much of each you see. Pick one for your account; each layout keeps its own arrangement, so you can switch back and forth without losing it.

**How to use — personal preferences:**

1. In **Media Tags**, on the **Layout** tab, pick a layout tile and a **Label Density**. The live preview shows your layout as you change it.
2. On the **Groups** tab, open a group to choose where it goes in that layout and how many tags it shows. Use the arrow buttons to change the priority order.

**How to use — admin defaults:** under **Display** → **Media Tags**, open **Tag layout defaults**, set the starting layout, density, order, positions and limits, and click **Save Settings**.

| Layout | Where tags go | Default arrangement |
|---|---|---|
| **Corners** (default) | Nine anchors: four corners, top/bottom centre, left/right centre and centre; groups sharing an anchor keep their priority order | Quality top left, genre and status top right, language bottom left, rating and age rating bottom right |
| **Bands** | A gradient band along the top (first group left, the others right) and one along the bottom that wraps; the middle of the poster stays clear | Status and age rating on top; quality, rating and language at the bottom; genre hidden |
| **Caption** | A strip below the poster, between the image and the title, plus a small stack at the poster's top left | Status on the poster; quality, rating, age rating and language in the caption; genre hidden |
| **Summary** | One pill at the bottom of the poster with up to three short facts (for example `Just Added · 4K DV · ★ 8.1`); every group's full chips appear over a dark scrim on hover or keyboard focus | Status, quality and rating in the pill; genre, language and age rating on hover |
| **Minimal** | Status at the top left, one coloured dot per quality chip (resolution blue, dynamic range orange, audio green, codec grey), the rating in the bottom-right corner; full chips on hover or focus | As listed; genre, language and age rating on hover |

=== "Corners"

    ![Movie posters with quality, genre, language, rating and age rating tags in the four corners](../images/tags/tag-layout-corners.webp)

=== "Centre anchors"

    ![Movie posters with quality at top centre, language at left centre, genres in the centre and ratings at bottom centre](../images/tags/tag-layout-centres.webp)

=== "Bands"

    ![Movie posters with age rating along a top band and quality, ratings and flags in a bottom band](../images/tags/tag-layout-bands.webp)

=== "Caption"

    ![Movie posters with quality and rating chips in a strip below each poster](../images/tags/tag-layout-caption.webp)

=== "Summary"

    ![Movie posters with a short fact pill each; the hovered poster shows every tag](../images/tags/tag-layout-summary.webp)

=== "Minimal"

    ![Movie posters with quality dots and a corner score; the hovered poster shows every tag](../images/tags/tag-layout-minimal.webp)

#### Episode thumbnails and list rows

On **Layout**, turn on **Use a different look** under **Episode thumbnails** or **List rows**. Each shape has its own layout, label density, group positions and chip limits. **Use recommended** restores these starting arrangements:

| Shape | Recommended look |
|---|---|
| Episode thumbnails and backdrop cards | **Bands**, **Compact**: status and age rating on top, quality and rating below, language and genre hidden |
| Large list images | **Corners**, **Compact**: quality top left, status top right, rating bottom right, each limited to two chips; the other groups hidden |

Both switches start off. Switching one off uses your default look again. Portrait posters and square cards (including music and people) use the default look. Jellyfin's card classes determine the shape first; otherwise the image's rendered aspect ratio does (wider than 1.2:1 is landscape; square cards count as portrait).

The choice for each card is **item lock → first matching rule → shape override → default**. A rule or lock takes precedence over the general shape settings. Stored rules and locks may also contain their own shape looks through the API; the rule editor continues to edit layout and density only.

The episode and list samples in the live preview follow their own shape settings. **Caption** on list rows still puts caption chips on the image; choose another layout to avoid this fallback. **Native Poster Tags** draw on poster images only and ignore shape overrides.

Shape chip limits run from **1** to **10**, then **All**. From **All**, press **−** to return to **10**; at **1**, **−** is disabled.

Administrators can choose **Same look as posters** or the recommended look for each shape under **Card shape defaults**. This seeds new users and applies when overwriting personal settings. Existing version-0 documents keep their old look until an explicit edit; merely loading or saving unrelated preferences does not enable overrides.

![The episode thumbnail layout editor and its live samples](../images/tags/tag-shape-settings.webp)

![Episode thumbnail before and after enabling the recommended landscape look](../images/tags/tag-shape-thumbnails.webp)

![Large episode list image before and after enabling the recommended list look](../images/tags/tag-shape-list.webp)

#### Tag groups: order, position, limits

Each group has a row on the **Groups** tab, highest priority first. Groups higher in the list win when space is short: they stack nearest the edge of a shared corner, come first in a band or the caption, and take the summary pill's three places first. The row shows where the group goes in the selected layout and how many tags it shows (for example **Bottom row · up to 3**); the switch on the right turns the group on or off.

Open a row to change it:

- **Position:** the places the selected layout offers, plus **Hidden**. Corners offers a 3×3 grid: top left, top centre, top right; left centre, centre, right centre; bottom left, bottom centre, bottom right. Changing the layout re-labels every row. **Dots** is offered to quality only.
- **Show up to:** how many tags the group shows, from 1 to 10. Quality and rating also offer **All**. Age rating and status always show one.
- **Include:** the quality categories with their stack order, or the rating group's **Community score** and **Critic score**. Other groups have nothing to choose here.

The limit applies after each group's own filtering (quality categories, language grouping and priority, rating scopes). **Reset to defaults** restores the administrator's layout, density, positions, order and limits; your group switches and include choices stay.

![The Groups tab with quality open: nine Position pills in a 3×3 grid, Hidden, the Show up to stepper and a live preview with centre anchors](../images/tags/tag-group-editor.webp)

| Setting | Default | What it does |
|---|---|---|
| Personal: **Tag Layout** / admin: **Default Tag Layout** | **Corners** | Chooses one of the layouts above |
| Personal: **Label Density** / admin: **Default Label Density** | **Full** | **Compact** shortens quality labels (`Dolby Vision` → `DV`, `HDR10+` → `HDR+`, `ATMOS 7.1` → `ATMOS`, `Dolby Digital+ 5.1` → `5.1`) and hides the critic score when a community score is shown |
| **Tag Groups** order | Status, quality, rating, age rating, language, genre, custom | Priority order of the groups |
| **Show up to** | Genre 3, language 3, age rating 1, status 1, custom 3, quality and rating all | The same limits as before layouts existed |
| **Position** — Quality / Genre / Language / Rating / Age Rating / Status / Custom Tags | Corners: **Top Left** / **Top Right** / **Bottom Left** / **Bottom Right** / **Bottom Right** / **Top Right** / **Top Left** | Any of the nine anchors in the Corners layout; the admin **Position** selects set these defaults |
| Admin / personal: **Hide Tags on Hover** | Off | Fades web poster tags when you hover over a card, making its buttons easier to see; new and overwritten personal settings take the admin value |
| Admin: **Disable Tags on Search Page** | Off | Suppresses the poster tags on Jellyfin web search results, including age-rating and review chips; useful for compatibility with Gelato |

The four default corners keep their original appearance. Top and bottom centre wrap chips into centred rows (up to two); left and right centre stack chips vertically. Centre rows reserve the width occupied by corner groups; side columns reserve the height of their neighbouring corner stacks. Chips that are too wide or tall are hidden whole and counted in a **+N** chip, which names the hidden tags on hover or focus. Group limits apply before fitting.

Top-right groups move below Jellyfin's watched or unplayed-count indicator. Top centre reserves space for side indicators and moves below any top-centre Jellyfin indicator; bottom centre clears a card's progress bar when present. People Tags have their own cast-card layout and no position.

At the left and right centre anchors, genre names appear toward the inside of the card on hover.

With **Hide Tags on Hover** off, genre names expand beside their icons on hover. Turn it on to fade poster tags instead.

<figure class="je-video">
  <video autoplay loop muted playsinline controls preload="metadata" aria-label="Genre labels expand and poster tags fade on hover">
    <source src="../../images/tags/tag-hover.mp4" type="video/mp4">
  </video>
  <figcaption>Genre names expand with Hide Tags on Hover off; turning it on fades the tags instead.</figcaption>
</figure>

#### Admin defaults

**Tag layout defaults** sets what new users start with: the layout, density, group order, each group's position per layout and the limits, in the same compact editor. Corner positions are the **Position** selects of each group; switch **Default Tag Layout** to set another layout's positions. A group's row is greyed out while its **Enable** switch is off, like its Position select. The order and limits are only stored once you change them.

![Tag layout defaults on the configuration page: default layout and density, then one row per group with move buttons, a limit stepper and position pills](../images/tags/tag-layout-admin-defaults.webp)

??? info "Upgrades, defaults, and limits"
    - Settings saved before layouts existed keep the **Corners** layout, your corner choices, full labels, the original stacking order and limits. Your first change in the layout editor changes only what you changed; everything else carries over. Administrators' new layout defaults never change an existing user's view.
    - The editor shows such settings in the default order; the order is saved the first time you move a group.
    - New users, and **Apply defaults to all users**, start from the administrator's layout defaults. A group hidden in the Corners layout on the configuration page reaches users the same way; the Position selects apply to everyone who has not picked a corner.
    - **Caption** needs a title block below the image. List rows and other cards without one show the caption groups in the poster's top-left stack instead. The caption strip has room for two rows of chips; lower-priority chips that do not fit are left out whole and counted in a `+N` chip; hovering or focusing the card shows their names at the top of the poster, and screen readers hear them as part of the card's description. Space for it is reserved as soon as a card appears so titles do not jump when the chips arrive.
    - The **Bands** bottom band keeps to two rows (then `+N`), and on cards narrower than 160px both bands use compact labels.
    - The **Summary** pill drops its lowest-priority facts when the card is too narrow for all of them; its tooltip keeps every fact. The hover reveal of **Summary** and **Minimal** always uses compact labels and keeps to two rows at the bottom of the poster (then `+N`), clear of the play button; on short cards such as episode thumbnails it shows only the rows that fit in the bottom 40% of the image. Jellyfin's card buttons stay on top and clickable.
    - **Hide Tags on Hover** hides tags on the poster in Corners, Bands and Caption; the caption strip stays visible. In Summary and Minimal it hides the pill, dots and corner, and the full chips still appear.
    - [Native Poster Tags](#native-poster-tags-experimental) always draw corners, whatever web layout you choose. They follow the Corners positions, hidden groups, order and limits, and keep full labels.

### Rules and locked items

Rules give some cards a different look (a layout and a label density) than your default: for example, a caption strip in the Movies library and compact bands on episodes. A lock keeps one item's look as it is, whatever you change later.

**How to use:**

1. In **Media Tags**, open **Rules & locks**. The **Add a rule** form is always open beside the list (below it on a phone).
2. Pick one or more conditions (all of them must hold, up to five; every condition needs a value) and the look, which starts at **Caption** and **Compact**. Click **Add rule**: the rule goes to the end of the list.
3. Use the arrows to order the rules, **On**/**Off** to pause one, **Edit** to load it into the form (**Save rule** keeps its place and its On/Off state) or **Delete** to remove it.
4. To lock an item, open its page and click the padlock (**Lock tag look**). Click it again, or use **Unlock** in **Locked items**, to release it. **Unlock all** asks for a second click. On a phone, **Show** unfolds the locked items and **Unlock all**.

![Rules & locks: a rule, the Otherwise row and two locked series on the left, the Add a rule form on the right; the preview shows the locked series and the rule's episode](../images/tags/tag-look-rules.webp)

Each card gets its look from the first of these that applies:

1. **A lock** on the item. A locked series also locks its seasons and episodes, unless one of them has its own lock.
2. **The first enabled rule** whose conditions all hold, from the top of the list.
3. **The shape override**, if enabled for an episode thumbnail or list row.
4. **Your default** Tag Layout and Label Density (the **Otherwise** row).

| Condition | Matches | Notes |
|---|---|---|
| **Library** | The library the item is in | Seasons and episodes use their series' library. An item in two libraries that share a folder uses the first one Jellyfin reports |
| **Type** | Movie, Series, Season, Episode, Collection or Video | The card's own type: an episode card showing its series' poster still counts as an episode |
| **Genre** | One of the item's genres | Not case-sensitive. Seasons and episodes use the genres the tag cache gives them |
| **Age rating** | The item's age rating | Compared as the age rating tags show it (`DE-12` and `FSK-12` match), not case-sensitive. Seasons and episodes fall back to their series' rating |

![A locked movie keeps its caption look in a library ruled to Minimal](../images/tags/tag-look-locked-grid.webp)

| Setting | Default | What it does |
|---|---|---|
| Personal: **Rules & locks** | No rules | Ordered rules: when every condition holds, the card uses that rule's layout and density |
| Personal: **Locked items** | None | Items that keep the look they had when locked; **Unlock all** asks for a second click |
| Admin: **Default tag look rules** | Empty | Rules (as JSON) that new users and **Apply defaults to all users** start with |

??? info "Limits and details"
    - Up to 50 rules, each with up to 5 conditions, and up to 500 locked items; past 500 the oldest lock is released. The server drops an invalid rule or lock (an unknown layout, a malformed id) on its own and keeps the rest.
    - A lock stores the layout, the density and where every group sits in that layout at that moment, so later changes to your arrangement do not move a locked item. Group order and per-group limits still follow your settings.
    - A rule uses your arrangement for its layout. Group order and limits are yours for every look.
    - Rules on library, genre and age rating, and a series lock on its seasons and episodes, read the item's data: its entry in the server tag cache, or the batch lookup when the cache is off or does not have the item yet. The browser remembers what the lookup said about each item (type, series, library, genres, age rating), so cards drawn from the per-tag fallback cache match every rule as well; an item it knows nothing about is looked up once.
    - While a card's data is on its way and a rule or lock could change its look, its chips wait for the data instead of appearing in your default look and then moving. Type-only rules never make a card wait. Space for the caption strip follows your default in the meantime, so when a rule gives a card Caption (or takes it away) the strip appears (or goes) once the data arrives, the first time this browser sees that item. A card whose data does not come shows its tags in your default look once the lookup ends, or after 8 seconds at most.
    - Locking from an item's page looks the item up first when its data is not loaded yet (the padlock shows an hourglass meanwhile), so the lock keeps the look its cards really have. If a rule or lock change cannot be saved, it is undone on screen and a message says so.
    - Mixing Caption with other looks on one row is allowed; caption cards are taller than their neighbours.
    - Settings saved before layouts existed never pick up the administrator's default rules; rules you add yourself apply.
    - Changing a rule or a lock updates the cards on screen at once, without reloading their tags.
    - Locked cards carry `data-je-locked="1"` on their tag host for [custom CSS](../advanced/css-customization.md). Nothing else marks them by default.

## Quality Tags

Quality badges help you identify a file's picture and sound format before opening it. They read Jellyfin's media metadata and naming signals.

**How to use:**

1. Turn on the **Quality** group on the **Groups** tab of **Media Tags**.
2. Open the row and select categories under **Include**.
3. Use **Move up** / **Move down** to change their stacking order.

Administrators configure the same defaults under **Categories and sound language** in **Media Tags**.

![Resolution, codec and sound tags on movie posters, with quality-category controls](../images/tags/quality-tags.webp)

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Quality Tags** / personal: **Quality** switch | Off | Enables the quality group |
| Admin: **Show resolution (4K, 1080p, ...)** / personal: **Resolution (4K, 1080p, ...)** | On; first | Shows resolution from the first video stream |
| **Source (REMUX, BluRay, WEB, HDTV, DVD, …)** | On; second | Shows the source inferred server-side from release naming, or the source of a physical-media stub |
| Admin: **Show HDR (HDR10+, Dolby Vision)** / personal: **HDR (HDR10+, Dolby Vision)** | On; third | Shows detected dynamic-range labels |
| Admin: **Show special format (IMAX, 3D)** / personal: **Special format (IMAX, 3D)** | On; fourth | Shows detected IMAX/3D labels |
| Admin: **Show video format (HEVC, H264, AV1, ...)** / personal: **Video format (HEVC, H264, AV1, ...)** | On; fifth | Shows video codec labels |
| Admin: **Show sound (Atmos, DTS, 5.1, 7.1, ...)** / personal: **Sound (Atmos, DTS, 5.1, 7.1, ...)** | On; sixth | Shows recognized audio format/channel information |
| **Edition (Director’s Cut, Extended, …)** | On; seventh, after sound | Shows the edition from file/folder naming; its order is configurable |
| **Include low-quality sources (CAM, TS, TC, SCR)** | Off | Allows those source labels when the Source category is on |
| Admin: **Preferred Audio Language for Sound Tags** | **No preference (best track overall)** | Chooses a fixed language whose audio tracks determine the sound tag |
| Admin: **Use Each User's Jellyfin Audio Language** | Off | Uses each user's Jellyfin preferred audio language; users without one retain the fixed admin language |
| Personal: **Preferred audio language for the sound tag** | **Server default** | Inherits server policy, uses **My Jellyfin audio language**, selects **No preference (best track overall)**, or chooses a specific language |

??? info "Badge examples"

    | Category | Examples the detector can produce |
    |---|---|
    | Resolution | `8K`, `4K`, `1440p`, `1080p`, `720p`, `576p`, `480p`, `LOW-RES` |
    | Source | `REMUX`, `BluRay`, `WEB`, `HDTV`, `DVD`; physical stubs also support `HD DVD`, `VHS`, `Physical`; optional `CAM`, `TS`, `TC`, `SCR` |
    | Dynamic range | `Dolby Vision`, `HDR10+`, `HDR10`, `HDR` |
    | Special format | `IMAX`, `3D` |
    | Video codec | `AV1`, `HEVC`, `H265`, `VP9`, `H264`, `VP8`, `XVID`, `DIVX`, `WMV`, `MPEG2`, `MPEG4`, `MJPEG`, `THEORA` |
    | Edition | `Director's Cut`, `Extended`, `Unrated`, `Theatrical`, `IMAX`, `Remastered`, `Criterion`, `Uncut`, `Final Cut`, `Special Edition`, or a custom `{edition-…}` label |
    | Sound | `ATMOS`, `DTS-X`, `TRUEHD`, `DTS`, `Dolby Digital+`, `7.1`, `5.1`; codec labels can include channels, such as `ATMOS 7.1` |

![File and folder naming source and edition tags in the jetest movie grid](../images/tags/source-edition-desktop.webp)

??? info "Compact phone labels and the Quality controls"

    ![Compact source and edition labels on a 420px phone grid](../images/tags/source-edition-mobile.webp)

    ![Edition category in the Quality group's Include controls](../images/tags/source-edition-settings.webp)

### Detection limits

Series and seasons share the **Series and seasons show:** setting in **Media Tags** → **Groups** → **Quality**. The administrator sets its starting default under **Display** → **Media Tags** → **Quality Tags**. Each user can choose:

| Policy | What appears |
|---|---|
| **Representative episode** (default) | Today's behavior: the first non-virtual episode with usable streams, preferring regular episodes over specials |
| **Latest episode** | Quality of the non-virtual episode with the newest known air date at or before now; future and undated episodes cannot win |
| **Best quality** | The best resolution, dynamic range, video codec and audio found independently across episodes; these facts can come from different episodes |
| **Only what every episode has** | A category appears only when every episode has the same value; mixed 1080p/4K episodes therefore show no resolution chip |
| **Best, marked when mixed** | Best quality plus a **Mixed** chip when an enabled category differs; compact density uses **±** |

The policy covers each series' episodes or each season's own episodes, including specials and all available media versions. Source and special-format chips retain the representative episode for best/shared/mixed; latest takes those chips from its own episode. The codec and dynamic-range rankings follow the quality category orders below. Aggregated audio ranks recognized codecs first (Atmos, DTS-X, TrueHD, DTS, DD+, channel-only), then richer channels, among the preferred language's tracks; an unavailable language falls back to the available tracks.

Missing streams count as unknown: a known/unknown difference suppresses that category in shared mode and marks mixed mode. Empty containers show no mixed marker. Collections keep their existing behavior and normally have no quality badges. Older cache entries without a summary fall back to representative streams until rebuilt.

The server stores policy-independent summaries, so changing the policy does not need another episode fetch. Access-restricted users receive summaries recomputed from the episodes they can see, using the existing access/filter revision. The batch fallback and Native Poster Tags honor the same policy. Quality category switches, ordering, layout limits, label density and Tag Styles still apply; **Mixed** is an editable quality label in Tag Styles.

![Quality settings with the series and season aggregation selector](../images/tags/quality-aggregation-hub.webp)

=== "Shared values"

    ![Shows with differing quality categories omitted by the shared policy](../images/tags/quality-aggregation-shared.webp)

=== "Best with Mixed"

    ![Shows with their best quality and Mixed chips where episode qualities differ](../images/tags/quality-aggregation-mixed.webp)


??? info "Detection and sound-language details"

    **Resolution:** JE first checks recognized video display-title hints, then dimensions. It rejects a misleading `4K`/`2160p` hint when the known height is below 1250 pixels.

    Dimension fallback recognizes 8K at height ≥3000 or width ≥7000, and 4K at height ≥1550 or width ≥3500. A 3840×1600 ultrawide file can therefore show `4K`. PAL-sized video can show `576p`. Sorting and styling support `SD`, but the current web resolution detector does not produce it.

    **Source:** A `.disc` physical-media stub wins first. Otherwise JE checks the selected version's file name, then its immediate parent folder. Matching ignores case and uses separators such as dots, spaces, underscores, hyphens and brackets; `Blue Ruin` does not match BluRay. `BDRip`/`BRRip` become **BluRay**, `WEB-DL`/`WEBDL`/`WEBRip` become **WEB**, and `DVDRip` becomes **DVD**. Bare `WEB` requires a following resolution or codec token, such as `WEB.1080p` or `WEB.x265`; `Web of Lies (2016)` produces no source. A `.ts` file extension does not itself mean a telesync release.

    Multi-version source selection uses the quality resolution buckets, highest first. Equal-resolution versions prefer REMUX, BluRay, WEB, HDTV, DVD, SCR, TC, TS, then CAM, with stable server order for equal ranks. Edition follows that same selected version. For series and seasons, **Latest episode** uses that episode’s source and edition. **Representative episode**, **Best quality**, **Only what every episode has** and **Best, marked when mixed** keep the representative episode’s naming labels. This does not select the version used for playback.

    **Edition:** Explicit `{edition-…}` markers in the file name, then the parent folder, take precedence over known edition words in those names. For example, `Movie (2020) {edition-Director's Cut}/Movie.1080p.WEB-DL.mkv` shows **WEB** and **Director's Cut**. Custom explicit edition labels are plain text, limited to 64 characters, and cannot include path separators. Directory paths stay on the server; clients receive labels and the existing basename-only legacy signals.

    Full density keeps full edition labels. Compact density uses **BD**, **DC**, **Ext**, **Unr**, **Rem**, **CC**, and **Special** for BluRay, Director's Cut, Extended, Unrated, Remastered, Criterion, and Special Edition. If both the special-format and edition categories would show IMAX, the special-format chip wins; disabling that category leaves the edition chip eligible. Native Poster Tags apply the same detection, category toggles/order and low-quality gate, with their existing full-label corner presentation.

    Source colours are deep blue for REMUX, blue for BluRay, teal for WEB, grey-blue for HDTV, grey for DVD and red for low-quality sources. Editions use purple. The known source and edition labels are available in **Tag Styles**; custom editions inherit the quality group's style.

    **Special format:** IMAX detection uses title/name/path signals and excludes `NON-IMAX`. 3D requires a path containing `3d` and a recognized format signal such as `hsbs`, `fsbs`, `htab`, `ftab`, or `mvc`.

    **Sound:** JE takes the first recognized candidate display title, then checks technical metadata if no title matched. It detects channels separately. It does not rank every track by richness, despite the **No preference (best track overall)** option wording. Standalone channel fallback produces `5.1` or `7.1`; `2.0` can be appended to a recognized codec.

    A sound-language preference tries language plus region, then the base language, then all tracks if no match exists. For example, selecting a German AC3 5.1 dub can replace an English Atmos badge with `5.1`; the detector does not emit `AC3` as a codec label. These choices change the badge, not the audio selected for playback.

## Genre Tags

Genre Tags show up to three genres (the genre limit of your [layout](#layouts)) as compact Material Design icons, so you can recognize them while browsing. You can hover to see names beside the icons.

![Genre icons and expanded genre names on posters](../images/tags/genre-tags.webp)

**How to use:**

1. Turn on the **Genre** group on the **Groups** tab of **Media Tags** and choose its position.
2. Leave **Hide Tags on Hover** off to see expanded names.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Genre Tags** / personal: **Genre** switch | Off | Shows genre icons on supported cards (three by default; see [Layouts](#layouts)) |

??? info "Genre sources and hover behavior"
    Genres come from Jellyfin metadata. Unfamiliar names use a generic icon.

    With **Server-Side Tag Cache** on, series and season cards keep their own genres when present and use episode or parent-series genres only when their own are missing. In batch fallback, season cards prefer the parent series' genres whenever available, even if the season has its own. Series cards without genres use the first episode.

    With **Hide Tags on Hover** on, names do not expand on the poster and the overlays fade out instead; the Summary and Minimal hover reveal still lists each genre by name, and a caption strip still shows names on hover. There is no genre-name expansion in a static native poster image.

## Language Tags

Language Tags show audio and subtitle languages as flags or short uppercase codes. Subtitle chips carry a small **CC** prefix. Hover a chip for the full language name. A language fact assigned to the Summary pill keeps the CC prefix and full-name tooltip. Language chips follow the poster link, including Ctrl/Command-click and middle-click to open a new tab. An optional **Dual** (two audio languages) or **Multi** (three or more) badge helps you find multilingual titles. Audio with no linguistic content uses a crossed-out speech-bubble symbol labeled **No dialogue**.

![Subtitle language chips with CC markers on library posters](../images/tags/language-subtitles.webp)

![Language codes and Multi audio badges](../images/tags/language-codes-multi.webp)

![Language includes and presentation controls](../images/tags/language-controls.webp)

**How to use:**

1. Turn on the **Language** group on the **Groups** tab of **Media Tags**.
2. Expand **Language**. Under **Include**, choose **Audio**, **Subtitles**, or both. Choose **Flags** or **Codes** under **Style** and optionally enable the **Audio count badge**.
3. Set **Show up to** for the combined list. A badge takes one place, followed by audio chips, then subtitle chips. For a separate list on the detail page, enable **Show Audio Languages**.

Administrators can favor particular languages under **Priority languages**.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Language Tags** / personal: **Language** switch | Off | Shows distinct flags/symbols on supported cards (three by default; see [Layouts](#layouts)) |
| **Include: Audio / Subtitles** | Audio on, subtitles off | Choose either or both track types; repeated forced/SDH tracks count once per language |
| **Style: Flags / Codes** | Flags | Codes use uppercase ISO 639-1 where available, otherwise the three-letter code (for example `TL`, `NB`, `NN`, `FIL`); audio equivalence still governs deduplication and counting. Both styles have full-name tooltips |
| **Audio count badge** | Off | **Badge only** replaces audio chips when two or more audio languages qualify; **Badge and flags** keeps them (or codes with Codes style). Selected subtitles remain. Counts distinct canonical audio languages after priority filtering and before the cap; regional versions and no-dialogue tracks do not increase the count |
| Admin: **Priority Languages** | Empty | Comma-separated language names or codes; use names such as `English, Japanese` to avoid differences between two- and three-letter codes. Matching flags appear first in list order |
| Admin: **Only Show Priority Languages** | Off | With a nonempty priority list, removes flags that do not match; an item can show fewer flags than its limit, or none |
| Admin: **Merge Regional Variants** | Off | Regional and script variants such as `en-GB`, `pt-BR` or `zh-Hant` share their base language's flag, so tracks Jellyfin lists as one language show one flag |

### Grouping, regions, and partial dubs

With **Server-Side Tag Cache** enabled, series and season cards show audio languages across their episodes. A dub missing from some episodes has a dimmed flag or code with a dashed outline and “not on all episodes” in its title/alt text.

![Language priorities and series coverage indicators](../images/tags/language-coverage.webp)

??? info "Flag grouping, coverage, and regions"
    Flags come through Jellyfin Enhanced's asset service. Tracks marked `zxx` (no linguistic content) use the **No dialogue** symbol.

    Languages sharing a flag are grouped before the three-flag limit. Their names are stored in the flag's title/alt text. Hover a flag or code to read those names. Tags remain visible on hover unless **Hide Tags on Hover** is enabled.

    Priority filtering also operates on grouped flags: a matching flag can represent additional languages sharing it. An empty priority list leaves flags unchanged even with strict filtering on. Language priorities are server policy, with no personal priority-list setting.

    Priority matching uses the flag's language code, its base code, or its displayed language names. It does not equate two- and three-letter codes: `ja` does not match `jpn`, but `Japanese` matches the displayed name.

    Cached audio and subtitle languages use the union across episodes. Subtitle tracks use the same access and Spoiler Guard stripping paths as audio. With the server cache off, container cards use their representative episode instead of the full union. Forced and SDH subtitle variants share one language chip.

    The cached audio flags use the union of audio languages across episodes. Full-coverage flags normally come first, but administrator priorities can put a partial flag ahead of them. A grouped flag is partial only when all its represented languages are partial.

    Specials do not count against a series' full-coverage languages. Tracks with no usable language tag are ignored. Equivalent tags such as `eng`/`en` or `fre`/`fr-FR` can count as the same dub. Regional variants that coexist in one episode, such as `es-419` and `es-ES`, are assessed separately.

    In batch fallback mode, series/season poster flags reflect a representative episode and do not show partial coverage.

    Cached collection flags combine languages from linked movie members. A collection containing an English movie and a Japanese movie can therefore show both flags; it does not mean every member has both languages.

    Regional flags require explicit regional metadata. For example, `pt-BR` shows Brazil, `pt`/`pt-PT` show Portugal, `es-419`/`es-MX` show Mexico, and `zh-Hant` shows Taiwan. A base language such as `pt`, `es`, or `zh` keeps its default flag; JE does not guess a region.

!!! note "Tagging matters"
    Region detection depends on the language metadata in the media file. Poster Language Tags and the detail-page audio-language row have separate switches; enabling one does not enable the other.

## Audio language links

The detail-page audio-language row shows language names and flags. You can also sync languages to Jellyfin metadata tags, so clicking a matching language opens a list of items with that tag.

**How to use:**

1. Keep **Show Audio Languages** on (**Media Tags** → **Layout**, under the quick switches) to display the row.
2. As an administrator, open **Display** → **Audio Language Tags** and turn on **Enable Audio Language Tags Sync** and **Link audio languages to their tag page**. Click **Save Settings**.
3. Run **Sync Audio Language Tags to Jellyfin** under **Dashboard** → **Scheduled Tasks** → **Jellyfin Enhanced** to tag existing movies and series.

![Clickable audio-language tags on a detail page and the resulting library list](../images/tags/audio-language-links.webp)

Admin settings below are under **Display**; the row's default is in **UI Preferences**, and synchronization controls are in **Audio Language Tags**.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Show available audio languages on item detail page** / personal: **Show Audio Languages** | On | Displays the audio-language row on movie, series, season, and episode detail pages |
| Admin: **Enable Audio Language Tags Sync** | Off | Writes audio languages as Jellyfin tags on movies and series |
| Admin: **Tag Prefix** | `JE Language: ` (trailing space) | Prefixes synchronized language tags |
| Admin: **Link audio languages to their tag page** | On | Turns a displayed language into a link when a matching synchronized tag exists on the item |

!!! note "Schedule language synchronization"
    **Sync Audio Language Tags to Jellyfin** has **no default schedule**. Add a trigger or run it manually, especially with the server cache off.

??? info "Language matching and synchronization"
    A regional track gets a base tag, such as `JE Language: English`, and a regional tag, such as `JE Language: English (United States)`. A regional chip tries the matching regional tag first, then its base tag. Without a match it remains plain text.

    The synchronized series tags combine languages across episodes. The detail-page row itself uses a representative episode for series/seasons. It can therefore show fewer languages than cached poster flags or synchronized series tags.

    For playable items, changing the selected media version can change the row. More than three languages can scroll horizontally; missing usable data shows a dash.

    Synchronization directly tags movies and series, not seasons or episodes. With the server cache on, cache updates can sync new or changed items after library changes. Cache-excluded items skip that update path but can still be processed by the standalone task.

    Updates remove stale tags only under the current prefix. Changing the prefix leaves old-prefix tags behind. Disabling synchronization does not delete existing tags.

## Rating Tags

Rating Tags show an ordered selection of Community, Critic, IMDb, TMDb, Rotten Tomatoes critic and audience, Metacritic, Letterboxd and Trakt scores. Each named source has a bundled logo. Choose which item types and home rows show them.

![Numeric community, critic and average user rating chips](../images/tags/rating-tags.webp)

**How to use:**

1. Turn on the **Rating** group on the **Groups** tab of **Media Tags**.
2. Under **Include**, tick sources and move them up or down. Set **Minimum score** and **Colour by score** if desired.
3. Keep or change the item types and home rows under **Choose where to show**.

Administrators set defaults under the same heading in **Media Tags**.

![Ordered rating source controls and the live preview](../images/tags/rating-sources-hub.png)

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Rating Tags** / personal: **Rating** switch | Off | Enables poster score chips and, when configured, user-review chips |
| Admin: **Show on movies** / personal: **Movies** | On | Allows rating and review chips on movie cards |
| Admin: **Show on series** / personal: **Series** | On | Allows rating and review chips on series cards |
| Admin: **Show on seasons** / personal: **Seasons** | On | Allows rating and review chips on season cards |
| Admin: **Show on episodes** / personal: **Episodes** | On | Allows rating and review chips on episode cards |
| Admin: **Show in the Continue Watching row** / personal: **Continue Watching row** | On | Allows rating and review chips in that row |
| Admin: **Show in the Next Up row** / personal: **Next Up row** | On | Allows rating and review chips in home **Next Up** and the series-page shelf |
| **Rating sources** | Community, Critic | Ordered enabled source list; an empty list hides source scores while review chips remain independent |
| **Minimum score** | Off | Off, 5, 6, 7 or 8; compares each source on a scale of ten before applying the group limit |
| **Colour by score** | Off | Red below 5, amber through green at 7.5; explicit Tag Styles colours take precedence |

Your item-type and row choices both apply. Turn off **Episodes** to hide these chips on every episode card, including **Next Up** and **Continue Watching**. Turn off a row to hide them only in that row. These choices do not hide quality, genre, language, or age-rating badges.

??? info "Score sources and fallback"
    Collections and videos are not governed by the four type switches. Critic scores below 60% use the rotten icon; 60% and above use the fresh icon. Compact density shows named-source values beside a tiny source-coloured dot. Native posters use the same source order, formats, minimum, cap and colours.

    Community and Critic come from Jellyfin's `CommunityRating` and `CriticRating`. Their sources depend on your metadata providers or synchronization, including [MDBList settings](../other/other-settings.md#mdblist-ratings). The overlays do not fetch TMDB or Rotten Tomatoes scores directly. A community score displayed as `0.0` becomes a dash; absent scores do not produce their respective chips.

    Season/episode score fallback differs by data path. The server cache substitutes both series scores when the child's community score is null. Batch fallback and player scores use the series only when neither child score is truthy. A child with only a critic score can therefore display differently between the cache and fallback paths.

Named sources use the server's existing MDBList service when its API key is configured. Full tag-cache builds warm bounded batches, and reconciliation refreshes expired ratings even when library metadata has not changed. Found titles have a seven-day TTL; confirmed misses and failures keep the existing MDBList retry policy. Batch mode also shares this cache. The API key stays on the server. Without a key or a returned score, that source produces no chip. Seasons and episodes use their series' source ratings.

| Source | Example | Native scale |
|---|---|---|
| IMDb | 8.1 | /10 |
| TMDb | 81% | /100 |
| RT critic / RT audience | 92% / 88% | /100 |
| Metacritic | 74 | /100 |
| Letterboxd | 4.1 | /5 |
| Trakt | 85% | /100 |

Existing users retain their old Community/Critic include choices and order until they edit sources. New users take the administrator's defaults. Named sources have individual labels in **Tag Styles** and `data-je-rating-source` hooks for custom CSS.

![The Rating colour editor with separate source labels](../images/tags/rating-source-styles.png)

!!! note "Spoiler Guard and scores"
    [Spoiler Guard](../spoiler-guard/spoiler-guard-settings.md) can suppress score data on protected items. Age classifications have a separate policy, described below.

### User-review chips

A pink person-with-heart chip shows the average star rating from reviews visible to you. It converts the 1–5 average to a /10 display: a four-star average appears as `8`.

**How to use:**

1. As an administrator, open **Elsewhere & Reviews** → **User Reviews**.
2. Turn on **Enable User Written Reviews** and **Show average user rating on poster cards**, then click **Save Settings**.
3. Each viewer must also turn on the **Rating** group. There is no separate personal review-chip switch.

To contribute, open an eligible detail page and click **Write a Review**. Choose stars, enter review text, or both.

| Setting | Default | What it does |
|---|---|---|
| **Enable User Written Reviews** | Off | Enables JE's stored user reviews; independent of Elsewhere and TMDB Reviews being enabled |
| **Show average user rating on poster cards** | Off | Adds the average-review chip to eligible cards with Rating Tags enabled |
| **Show "—" on posters for unrated items** | On | Shows a dash when no visible aggregate star rating exists; off removes that chip |
| **Hide reviews from hidden users** | On | Hides those authors' reviews from other non-admin viewers; self-view and admin exceptions apply |
| **Hide reviews from disabled users** | On | Applies the same visibility rule to disabled accounts |
| **Also save review star ratings as the user's Jellyfin rating** | Off | Mirrors movie/series review stars to Jellyfin's personal /10 rating, independently of the displayed average |

The optional dash means there is no visible average star rating, even if you have written a text-only review.

!!! warning "Mirroring replaces your Jellyfin rating"
    **Also save review star ratings as the user's Jellyfin rating** overwrites an existing personal Jellyfin rating.

??? info "Review identities, limits, and mirrored ratings"
    Movies and series require a TMDB ID. Seasons and episodes require the parent series' TMDB ID and their season/episode numbers.

    Matching identities share reviews across duplicate library items. Collections and generic videos do not have these review chips. The chips follow the same corner and scope exclusions as Rating Tags and respect applicable Spoiler Guard review restrictions.

    Stars range from 1–5 in half-star increments. Review text is limited to 2,000 characters, and a review needs stars or nonblank text. Only reviews with stars contribute to the poster average.

    Deleting a review or removing its stars clears the mirrored rating only if it still matches. A rating changed elsewhere is preserved. Season/episode reviews are not mirrored. Writing and moderating reviews is covered in [User Reviews](../elsewhere/elsewhere-features.md#user-reviews).

## Age Rating Tags

Age Rating Tags show the official parental/content classification Jellyfin already has, such as `PG-13`, `R`, `TV-MA`, `FSK 12`, or `BBFC 15`. Supported rating-board labels receive predefined colors, with a fallback for other labels.

![Color-coded age classifications on movie and series posters](../images/tags/age-rating-tags.webp)

**How to use:** Turn on the **Age Rating** group on the **Groups** tab of **Media Tags** and choose its position.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Age Rating Tags** / personal: **Age Rating** switch | Off | Shows the item's official classification on supported cards |
| Admin: **Colored Ratings Backgrounds** | Off | Under **Extras** → **UI Tweaks**, colors official classification boxes on detail pages and applicable player elements |

The default bottom-right position stacks with Rating Tags. Seasons and episodes normally show their own nonblank classification, or their series' classification if they have none.

Poster age badges use classification colors independently of **Colored Ratings Backgrounds**. That separate switch controls detail/player classification boxes.

??? info "Classification labels and colors"
    Equivalent labels share colors. For example, `DE-12` and `FSK 12` become `FSK-12`, and supported unrated labels become `NR`. Color support includes international boards, US TV descriptors, and ESRB classifications. These are classification colors, not gradients for community/critic scores.

!!! note "Spoiler Guard and classifications"
    Age classifications remain visible. When score stripping protects unwatched episodes or unstarted seasons, the badge can deliberately use the series classification instead of the child's own rating, avoiding a hint from an unusually high episode classification.

## Status Tags

Status Tags show one translucent badge per card: what is new, trending, airing next, or reaching a season milestone. They use the existing poster artwork and the selected [tag layout](#layouts).

![Status badges on library cards](../images/tags/status-tags.webp)

**How to use:** Turn on the **Status** group on the **Groups** tab of **Media Tags** and choose its position. Pick the badge families on the **Status badges** tab (the Status row's **Badges** button opens it). Administrators set starting defaults under **Display** → **Media Tags**; each user can override the six group switches.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Status Tags** / personal: **Status** switch | Off | Shows one badge per supported card. The admin switch also allows server trending and series schedule lookups |
| **Trending rank** | On | Shows the title's trending rank. Admin **Show Trending rank** off stops the shared list for everyone |
| **New Movie / New Series / New Episode** | On | Shows release and episode-arrival badges |
| **Just Added** | On | Shows recently added library items |
| **Airing Today / Airs / Returns / Coming Soon** | On | Shows schedule badges; Coming Soon works without TMDB |
| **New Season / Premiere / Finale / Complete Season** | On | Shows season and series milestones |
| **Returning / Ended / Cancelled** | Off | Shows a series' status when no higher-priority badge applies |
| Admin: **New release window (days)** | 30 | Premiere dates, new seasons, season premieres and recent TMDB finales; range 1–365 |
| Admin: **Just added window (days)** | 7 | Item/episode added dates, an episode's own air date and season binge drops; range 1–365 |

### Badges and priority

First match wins, with one badge per card:

| Card | Badge order |
|---|---|
| Movie | Trending → Coming Soon → New Movie → Just Added |
| Series | Trending → Airing Today → Series Finale → New Season → Airs {date} → Returns {date} → New Episode → Coming Soon → New Series → Just Added → Returning / Ended / Cancelled |
| Season | Complete Season → Season Premiere → Season Finale → New Episode → Just Added |
| Episode | Season Premiere → Series Finale / Season Finale → New Episode → Just Added |
| Collection, video | Just Added |

| Badge | Cards | Data and conditions |
|---|---|---|
| **#N Today / #N This Week** | Movie, series | TMDB daily trending rank, or Seerr weekly trending fallback; requires the item's TMDB ID |
| **Coming Soon** | Movie, series | Jellyfin `PremiereDate` is in the future, including virtual items returned through fallback |
| **New Movie / New Series** | Movie / series | Jellyfin premiere date falls within the new-release window and has passed |
| **New Episode** | Series, season, episode | A container's latest non-virtual episode was added within the just-added window and the container predates that window. An episode itself aired or was added within that window |
| **Just Added** | All supported types | Jellyfin `DateCreated`, the date used by **Date Added** sorting, falls within the just-added window |
| **New Season** | Series | The newest regular season's episode 1 aired within the new-release window; season number must exceed 1 |
| **Season Premiere** | Season, episode | The season's episode 1 aired within the new-release window; an episode card must itself be episode 1 of a regular season and have aired within the just-added window |
| **Season Finale** | Season, episode | The latest aired TMDB episode matches the library episode and is within the new-release window. TMDB `episode_type=finale` confirms it; if absent, the local episode must be last in its season and TMDB must have no next episode, or one in a later season |
| **Series Finale** | Series, episode | TMDB status is Ended or Canceled, and the last aired regular episode matches the visible library episode and falls within the new-release window. Both cache and batch paths resolve the same regular episode: caller-filtered library series aggregate, regular TMDB latest episode, TMDB season enrichment, then a fetched local aggregate, each with its own air date; season 0 never supplies a series finale |
| **Complete Season** | Season | Every non-virtual episode available in the library has an added date within the just-added window. This describes the available episodes; it does not certify acquisition of missing TMDB episodes |
| **Airing Today** | Series | TMDB's next episode air date is today in the user's local calendar |
| **Airs {date}** | Series | TMDB's next episode airs in the next seven days |
| **Returns {date}** | Series | TMDB's next episode airs within 30 days, more than 14 days after the last aired episode. Airs takes priority inside seven days |
| **Returning / Ended / Cancelled** | Series | Jellyfin Continuing/Ended first. TMDB may refine Ended to Cancelled, or supply a missing Jellyfin status |

Dates read **Tomorrow**, then a localized weekday for two to five days ahead, then a localized short date such as **Nov 6**. The user's Jellyfin display language is preferred, followed by the JE language and browser locale.

With **Compact** density, Season Premiere becomes **Premiere**; Season Finale and Series Finale become **Finale**; Complete Season becomes **Complete**; Airing Today becomes **Today**; Coming Soon becomes **Soon**; Just Added becomes **Added**; New Episode becomes **New Ep**. Other labels retain their full text.

### TMDB and trending

A TMDB API key is required for Airing Today, Airs, Returns, Season Finale and Series Finale. Without one, Jellyfin supplies added/release badges, New Season, Season Premiere, Complete Season and Returning/Ended. Cancelled requires TMDB. No Seerr schedule fallback is used.

Trending reads **#N Today** from TMDB's daily list when a key is configured. Without a key, or when TMDB fails or returns no rankable titles, it reads **#N This Week** from Seerr. With neither source, no rank appears. Only movies and series with TMDB IDs receive ranks.

The server shares up to 60 movie/series ranks for 30 minutes, with a five-minute retry after an empty answer. The list contains only public TMDB IDs and ranks. Changed ranks re-badge cards already on the page.

For series cards on screen, and parent series of season/episode cards, the browser batches up to 50 accessible IDs through `GET /JellyfinEnhanced/status-tags/series`. It retains schedules for an hour and retries failures after five minutes. The server shares TMDB responses for six hours, with at most four lookups in flight and 35 upstream requests per ten-second window. If the series response omits `episode_type`, its latest aired season supplies it. For an ended series whose latest episode is a special, the newest aired regular season also supplies a separate last regular episode. Parent aggregates fetched through `/tag-data` are shared by series and episode cards, expire after ten minutes, and are discarded on user or filter changes. No schedule is stored per user or in the tag cache. One shared viewport observer gates schedule requests; offscreen, detached and recycled cards do not dispatch lookups. Targets are released on removal, identity reuse, renderer cleanup and user change. A single timer re-evaluates labels at the next local midnight, and visibility/focus events refresh active cards after a suspended tab returns. User changes, renderer cleanup and `pagehide` cancel midnight, batch and retry timers; initialisation and `pageshow` resume them.

!!! note "Web only"
    [Native Poster Tags](#native-poster-tags-experimental) do not draw Status Tags into poster images.

??? info "Cache, access filtering and styling"
    Tag cache schema 17 includes named-source `Ratings`, `LibraryId` (library rules), `Status`, `LatestEpisodeAired`, `LatestEpisodeIndex` (`Season`, `Episode`, `IsLast`), `SeasonPremiere` (`Season`, `Aired`), `SeasonAddedSpan` (`First`, `Last`, `Count`) and `EpisodeIndex` (`Season`, `Episode`, nullable `IsLast`). Dates are Unix milliseconds UTC. Movie, series and episode entries can have `PremiereDate`. The persisted browser copy is replaced when its entry schema differs.

    All derived episode facts follow the existing access-filtering and `filterRevision` path. When any contributing episode is inaccessible, related aggregates are omitted conservatively; the shared entry is unchanged. The server-only `StatusEpisodeIds`, `LatestEpisodeId` and `NextEpisodePremiere` never enter client responses. `NextEpisodePremiere` records the next relevant future air date; reconciliation and snapshot load recompute elapsed boundaries without requiring a metadata save. Compatible snapshots without the optional field seed the boundary from their cached episode dates. Episode changes refresh sibling indexes and contributor lists together. With server cache off, `tag-data?latestEpisode=true` computes through the target user's access.

    Spoiler Guard preserves added-date badges and movie/series trending ranks. Guarded season/episode entries omit air dates and milestone indexes, suppressing premiere/finale badges. Complete Season still describes their visible added-date span.

    Style `.status-tag` or its `--trending`, `--new`, `--added`, `--schedule`, `--milestone`, `--status` modifiers. Each chip has `data-je-status`: existing styles keep `added`, `newMovie`, `newSeries`, `newEpisode` and `trending`; new badges use keys such as `new_season`; the number inside a trending chip is `.status-tag-rank`.

## Custom Tags

Custom Tags turn your own Jellyfin metadata into poster chips. The administrator writes rules: items that carry a Jellyfin tag (for example `4K Remaster`) or belong to a collection (for example `Criterion`) get a chip with the rule's label and, optionally, an icon. Tags are the ones in each item's metadata (**Edit metadata** → **Tags**, or imported keywords).

![Custom chips under the quality tags: Comic (with an icon) for movies tagged "based on comic", Criterion for a collection, each in its Tag Styles colour](../images/custom-tags-posters.png)

**How to use — administrators:**

1. Open **Display** → **Media Tags** → **Custom tag rules**.
2. Click **Add rule**. Choose **Tag** or **Collection**, then type the name: suggestions list the library's tags or collections. Enter the chip's **Label** and pick an **Icon** if you want one.
3. Click **Save Settings**. Colour each label under **Tag Styles** → **Custom**.
4. **Enable Custom Tags** and its **Position** set the starting values for users, like the other groups.

![The Custom tag rules table: match type, tag or collection name, label, icon and a remove button per rule](../images/custom-tags-rules.png)

**How to use — personal preferences:** turn on the **Custom** group on the **Groups** tab of **Media Tags** and choose its position and limit, like any other group.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Custom Tags** / personal: **Custom** switch | Off | Shows a chip for each rule an item matches |
| Admin: **Custom tag rules** | None | Up to 20 rules: **Match** (**Tag** or **Collection**), the tag or collection name, a **Label** of up to 24 characters and an optional **Icon** from the genre icon set |
| **Show up to** | 3 | Chips beyond the limit are left out, as for other groups |

Names match exactly but ignore case and extra spaces. Chips follow the rule order in the table, and reordering the rules takes effect at once; a rule whose name matches nothing simply shows no chip. Seasons and episodes take their series' tags and collections as well as their own. A collection chip only shows for users who can open that collection: if library access or parental controls hide the collection from someone, its chip is hidden on its items too, even on items they can see. Hovering a chip shows its label; administrators also see the tag or collection it came from. Other users never receive the tag or collection names a rule uses. Spoiler Guard treats custom chips like genres: when it hides tags (**Hide tags**, unless the user's own override keeps them), guarded items show no custom chips, since a tag or collection can give away the plot. The server checks the rules when you save: it drops incomplete rows and unknown match types, trims names and labels, shortens long labels and merges rows that name the same tag or collection.

??? info "When chips update"
    The [server tag cache](#server-side-tag-cache) records which rules each item matches. Editing an item's tags, adding items to or removing them from a collection, renaming or deleting a collection, or changing a series' tags updates its chips (and its seasons' and episodes') within seconds. Saving rules that match something new re-checks the whole cache in the background, without reading media files; changing only a label, icon or colour takes effect at once. The nightly reconcile and a full rebuild catch anything else.

    With the server tag cache off, chips come from each card's batched tag data and match **tags only**: collection membership needs the cache. Browsers remember an item's chips only while the rules stay the same.

## People Tags

People Tags add age and birthplace facts to cast and guest-cast cards on item detail pages. They support rectangular and round portraits.

![Cast portraits with age and birthplace tags](../images/tags/people-tags.webp)

**How to use:**

1. Turn on **Show People Tags** in **Media Tags** → **Layout**.
2. Open a title's detail page and view its cast.

Administrators can set the starting value in **Media Tags**.

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable People Tags** / personal: **Show People Tags** | Off | Adds age chips, birthplace information, and deceased styling to cast cards |
| Admin: **Tags Cache Duration (days)** | 30 | Sets the lifetime of cached person facts in the browser; allowed range 1–365 |

You'll see green current-age chips, red age-at-death chips, and blue age-at-release chips near the top of a rectangular portrait. Birthplace appears along the bottom, with a country flag when the place can be resolved. Deceased people receive a cross and grayscale styling; round portraits use an adjusted layout.

![Toy Story cast portraits with two deceased actors shown in grayscale](../images/tags/people-tags-deceased.webp)

!!! note "Optional TMDB enrichment"
    To add facts from TMDB, the person needs a TMDB ID and your administrator must set **TMDB API Key** under **Elsewhere & Reviews**.

??? info "Person metadata and caching"
    Facts come from Jellyfin person metadata. Failed or unavailable TMDB enrichment keeps usable Jellyfin facts. Missing birth/death dates or birthplace omit the corresponding details. Age at release also needs the viewed item's visible premiere date; hidden or stripped dates cannot supply it.

    Age at release is calculated from birth to premiere without a death-date limit. For a posthumous release, that chip can show an age the person never reached.

    Birthplace flags require the last comma-separated part of the place to match a recognized country name. A place ending in `England UK` can therefore show its text without a flag.

    The separate browser facts cache holds at most 3,000 people. Ages are calculated from cached dates for the current visit rather than kept as stale age numbers. People Tags are web cast overlays and are not drawn by Native Poster Tags. Spoiler Guard can remove protected guest-cast/cast cards before these overlays appear.

## Player badges

You can show scores in the web video player's controls and an age-classification badge when playback starts. These are independent server settings; neither has a personal control in the panel.

![Classification badge and numeric ratings in the player](../images/enhanced/player-rating.webp)

**How to use:**

1. Configure score chips under **Display** → **Media Tags**.
2. Configure the playback-start classification badge under **Playback** → **Playback & Tab Switch**.
3. Click **Save Settings**, then refresh the web client.

| Setting | Default | What it does |
|---|---|---|
| **Show Rating in Video Player** | On | Shows community and critic score chips near the time information in the on-screen controls, before **Ends at** |
| **Show Age Rating When Playback Starts** | Off | When an official classification is available, shows it with up to three recognized advisory tags and up to three genres when playback starts |

Neither setting requires poster Rating Tags or Age Rating Tags. Poster scope switches do not control player score chips.

??? info "Player score and classification behavior"
    Player score chips use Jellyfin's rating fields and can fall back to series scores when a season/episode has neither score.

    The playback-start badge needs an official classification. It uses the series' classification when an episode has none. It displays for five seconds, followed by a 400 ms fade.

    Advisories are selected from matching Jellyfin metadata tags. Episodes also use series genres when their own are missing and incorporate series tags. Missing advisories or genres omit only their respective lines. **Colored Ratings Backgrounds** can color its classification box.

## Server-Side Tag Cache

The server cache prepares tags for supported items in included libraries, so each page avoids repeating metadata requests. You receive only data allowed by your library access and Spoiler Guard policy. Each entry also records the item's library (a season's or episode's is its series'), which [tag look rules](#rules-and-locked-items) match on.

**How to use:**

1. Leave **Server-Side Tag Cache** on under **Display** → **Media Tags**. Choose library exclusions if needed.
2. After changing exclusions, or after a plugin update that changes tag computation, click **Save Settings** and open **Admin** → **Tag Cache**.
3. Click **Rebuild Server Tag Cache** and confirm the full rebuild.
4. Check server logs for progress and completion. The existing cache keeps serving while the new one builds in the background.

![Server tag cache duration and library exclusions](../images/admin/tag-cache.webp)
*Browser fallback controls appear only with **Server-Side Tag Cache** off.*

| Setting | Default | What it does |
|---|---|---|
| **Server-Side Tag Cache** | On | Loads, builds, and maintains the server cache; off uses per-page batch fallback |
| **Exclude libraries from the tag cache** | Off | Reveals library selection for omitting libraries from precomputation |
| **Libraries to exclude** | Empty | Selects libraries to skip on the next full rebuild; an empty selection excludes nothing |
| **Tags Cache Duration (days)** | 30 | Lifetime of browser fallback entries and People Tags facts, not the server cache's refresh schedule; range 1–365 |
| **Persist Tag Fallback Cache in Browser Storage** | Off in configuration | Visible only with **Server-Side Tag Cache** off; saving in that mode forces it on. See Browser storage and fallback below |
| **Clear All Client Caches** | Action | Visible here only with **Server-Side Tag Cache** off; signals clients to invalidate JE caches on their next load. Does not rebuild the server snapshot or reset server-stored personal preferences |

### Builds, refreshes, and exclusions

The retained cache grows with the number of included items. Exclude large libraries or disable server mode if its memory cost is unsuitable.

??? info "Cache lifecycle and excluded libraries"
    When poster review chips are enabled, visible review averages travel with the filtered cache data.

    At startup, JE restores `tag-cache.json` from `<PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/`. If no usable cache is available, it queues **Refresh Tag Cache** to build one. Library item additions, updates, and removals keep entries current. The scheduled task normally reconciles changes rather than recomputing every item. Its default daily trigger is 03:00.

    Excluded libraries do not lose access or forcibly lose their web tags. Cards without a server entry can use per-page batch fallback. Exclusions also bypass the normal cache-update audio-language synchronization path; the standalone language-sync task can still process those items.

    Builds load item data in small pages to reduce peak memory.

    Audio languages that JE reads from Matroska track headers (for regional tags such as `pt-BR`) are kept in `matroska-languages.json` next to the tag cache, keyed by file path, size and modification time. Later rebuilds, reconciles and tag-data requests do not open an unchanged file again, which matters on network and cloud mounts where each open can download a large read-ahead.

    Turning server mode off releases the in-memory cache and stops loading, building, monitoring, and scheduled refresh work. The saved snapshot remains on disk. Clients pick up the switch on their next load.

    Re-enabling from the dashboard restores the snapshot and catches up on missed changes in the background, without a restart.

    If you edit the configuration file by hand instead, restart Jellyfin and run **Refresh Tag Cache** to catch up.

### Browser storage and fallback

Turn off **Server-Side Tag Cache** to reveal **Persist Tag Fallback Cache in Browser Storage** and **Clear All Client Caches** in **Media Tags**.

![Tag cache settings with the server-side cache turned off](../images/admin/tag-cache-legacy.webp)

??? info "Browser storage and fallback details"
    The first web load downloads the server payload and saves an IndexedDB copy scoped to that server and user. Later loads restore that copy and request changes since the saved cursor. Tags wait for confirmation that the stored version and access/Spoiler Guard revision still match. A rebuild or changed filtering replaces the copy, including changes made from another device. Navigation also checks for updates, with requests spaced during rapid browsing.

    A copy written before the entry format last changed (version 11 added the library) is not restored; the browser downloads the cache again.

    The stored copy is invalidated when server mode is switched off, by **Clear All Client Caches**, or when another account signs in in the same browser. Each copy contains that user's filtered, spoiler-safe data.

    Without usable IndexedDB, including some private modes or storage failures, the client downloads the payload again on each page load and uses memory only.

    Saving with the server cache off forces **Persist Tag Fallback Cache in Browser Storage** on. The client enables localStorage fallback whenever server mode is off.

    Batch fallback fetches the items needed for the current page and keeps frequently used entries in memory. With server mode off, it also persists fallback entries in localStorage, using **Tags Cache Duration (days)**. This is separate from the full server-payload copy in IndexedDB. Browser storage failures leave tags able to fetch data again. Average-review lookups in fallback mode are batched separately.

    For [rules and locked items](#rules-and-locked-items), the batch lookup's type, series, library, genres and age rating of each item are remembered beside those entries (`JE_tagLookFacts`, at most 3,000 items, newest kept). Like the per-tag entries, they belong to the signed-in user and are dropped when another account signs in or by **Clear All Client Caches**.

### Related routes

??? info "Diagnostic routes"
    These routes are useful when diagnosing a cache problem; routine setup uses the dashboard controls above. All require authentication. See the [API reference](../advanced/api.md) for broader API use.

    | Route | Access and behavior |
    |---|---|
    | `GET /JellyfinEnhanced/tag-cache/{userId}` | Own account or administrator; filtered cache payload. Returns 404 when server mode is off. Optional `since` is a Unix-millisecond cursor; use the returned generation `timestamp`, not `servedAt` |
    | `POST /JellyfinEnhanced/tag-data/{userId}` | Own account or administrator; per-page fallback for accessible items. Body is a nonempty array of at most 200 item-ID strings; optional `mediaSourceId` selects a media version; optional `latestEpisode=true` adds the newest episode's added date to series and seasons |
    | `GET /JellyfinEnhanced/status-tags/series?ids=…` | Signed-in caller; up to 50 accessible series IDs, returning TMDB status and last/next aired facts |
    | `GET /JellyfinEnhanced/status-tags/trending` | Any signed-in user; the shared trending list for Status Tags. Empty while the admin has Status Tags or the trending rank off |
    | `POST /JellyfinEnhanced/tag-cache/rebuild` | Administrator only; starts a full background rebuild. Returns 400 with server mode off, or 409 if a rebuild is already running |
    | `GET /JellyfinEnhanced/audio-language-tags?codes=…` | Returns base/regional synchronized tag names for the supplied comma-separated language codes; empty mapping when sync is off |

## Native Poster Tags (Experimental)

Native Poster Tags add your enabled poster groups to images shown in eligible native apps, without changing the original artwork files. The feature is built into JE, so you need no companion plugin or client modification.

![Server-rendered poster preview with embedded tags](../images/tags/native-poster-preview.webp)
*Server preview; this is not a native-app screenshot.*

**How to use:**

1. Enable suitable tag groups and ensure the items have the required metadata.
2. Under **Display** → **Media Tags**, turn on **Enable Native Poster Tags (Experimental)** and click **Save Settings**.
3. Each user can opt out with **Show Tags in Native Clients (Experimental)** in **Media Tags** → **Layout**.
4. Reopen the native app's library or restart the app to pick up changed poster addresses.

![Native poster tag master switch and client exclusions](../images/admin/native-tags.webp)

| Setting | Default | What it does |
|---|---|---|
| Admin: **Enable Native Poster Tags (Experimental)** | Off | Server-wide master switch; off serves original posters and stops native tag composition |
| Admin: **Additional Excluded Clients** | Empty | Adds web-wrapper client names that should retain original posters; newline- or comma-separated |
| Personal: **Show Tags in Native Clients (Experimental)** | On while allowed | Shows tags in native clients; hidden while the master switch is off, retaining the saved choice |

??? info "Stored native preferences"
    The admin configuration uses `NativePosterTagsEnabled` and `NativePosterTagsWebClientNames` for the master switch and additional client exclusions. The personal `UseNativePosterTags` value permits native tags when null or true; false opts out while retaining the preference when the master switch is off.

!!! note "Enable the tag groups too"
    The master switch alone does not produce visible tags: each user's applicable groups start off.

??? info "Supported groups and preferences"
    JE draws tags into Primary images for movies, series, seasons, episodes, collections, and videos. Supported groups are quality, genre, language, community/critic rating, user-review, age-classification and custom tags (text chips with their icon). People Tags are not a native group.

    It uses personal tag switches, audio/subtitle includes, Flags/Codes style and Dual/Multi badge mode, quality categories/order, sound-language preference, rating item-type scopes and score includes, together with the administrator's language-priority policy. Native posters always draw the Corners layout, whatever web layout the user picked: the Corners positions, groups hidden there, the group order (an order you set; otherwise the original stacking order) and the **Show up to** limits apply. All nine Corners anchors are supported, including centred rows and side columns. Labels stay full; compact density is web only. Status Tags are web only.

    **Centre-anchor differences:** native posters omit whole chips that do not fit, without the web's **+N** tooltip. Very wide chips in side columns are omitted rather than squeezed. The image request cannot reproduce the web card's progress bar, Jellyfin indicators or custom overlays, rules or per-item locks; native placement uses the saved Corners profile. The four default corner positions are unchanged.

### Eligible clients and requests

Examples of native clients include Jellyfin for Android TV, Tizen, Swiftfin, Findroid, and Streamyfin.

The built-in exclusions are Jellyfin Web, Jellyfin Media Player, Jellium Desktop, Jellyfin Desktop, Jellyfin for WebOS, and Jellyfin for Android (the phone app). These load web overlays and retain original poster images. Jellyfin for Android TV is a different client name and is eligible.

If a custom web wrapper shows tags twice, add its name as shown under **Dashboard** → **Devices** to **Additional Excluded Clients**.

??? info "Client matching and image requests"
    Native tags depend on the app retaining Jellyfin's personalized image tag in its poster request. Requests that omit it, or ask Jellyfin to draw its own watched/progress/unplayed-count indicators into the image, retain original artwork.

    Exclusion matching trims whitespace and compares exact names without case sensitivity. Unidentified clients are excluded.

### Limits and caching

??? info "Layout, Spoiler Guard, and image caching"

    - **Static layout:** genre hover names and **Hide Tags on Hover** do not apply. Size follows the image width rather than the app's final display size; landscape episode images use an adjusted layout.
    - **No page or row context:** **Disable Tags on Search Page** and the **Continue Watching row** / **Next Up row** rating scopes do not apply. Item-type scopes still apply. Tags can appear anywhere the app reuses that Primary image, including search and detail pages. If an episode card uses a series poster, its tags describe that image's owner.
    - **Spoiler-safe data:** native composition applies the user's Spoiler Guard stripping policy. Artwork follows the configured stock-card/blur policy, rather than always using blur. Spoiler-scoped responses use `no-store` so an old poster is not retained under a changed policy.
    - **First-view cost:** the server draws a poster the first time a particular variant/size is requested. Rendered images are cached with a 128 MiB memory budget and approximately 1 GiB disk budget under Jellyfin's cache directory, `jellyfin-enhanced/poster-tags`.
    - **Refreshes:** settings changes can change poster addresses. With the server tag cache on, tag-data changes also change addresses for cached items. Apps can need a library refresh or restart to use them. With the cache off, tag-data changes keep the same URL; apps can show the old composite for up to an hour before revalidating that URL.
    - **Fallback:** unsupported identity/token requests, missing renderable tags, decode/render failures, sources over 32 MiB, or decoded image sides outside 32–4096 pixels can yield original artwork. These are implementation limits, not adjustable settings.

??? note "Signing key and backups"
    JE stores a 32-byte signing secret in `<PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/native-poster-tags.key`, separately from rendered-image caches. Preserve it in backups to retain personalized URL-signing continuity. JE recreates a missing or invalid key. Older URLs can then serve original artwork until clients refresh.

    If the key cannot be persisted, JE logs a warning and uses a process-lifetime key that changes after restart.

    On Unix, new keys use owner-only read/write permissions. There is no setting for this internal key.

??? info "Administrator preview route"
    Administrators can diagnose composition with `GET /JellyfinEnhanced/native-poster-tags/preview/{itemId}`. It requires an accessible supported item, an existing target user, and a local Primary image.

    Optional `userId` defaults to the caller. `width` defaults to 360, and width/optional height are clamped to 32–2048. Optional `topRightOffset` controls indicator clearance.

    The JPEG response uses `no-store` and includes `X-JE-Poster-Tags-*` diagnostics.

    The preview attempts composition even with the master/personal native switch off. It strips tag data for Spoiler Guard but uses original, unblurred artwork. It therefore does not preview image protection.

## Tag Styles and CSS

Use Tag Styles to recolour poster tags without writing CSS. You pick a preset, then adjust a whole group of tags or a single tag. The same colours reach the web overlays and the posters drawn for native apps.

**How to use:**

1. Open **Display** → **Media Tags** and turn on **Enable Tag Styles**.
2. Under **Apply to**, choose **Web**, **Native posters** or **Both**.
3. Pick a **Preset**. It applies straight away and keeps any group or tag colours you set.
4. Choose a group tab (**Quality**, **Age**, **Rating**, **Genre**, **Status**, **Language**, **Custom**), then **Whole group** or one tag.
5. Set **Background**, **Border** and **Text** with a swatch or any colour, and an opacity of 40–100%. Watch the contrast badge and the preview.
6. Click **Save Settings**. Refresh web clients to see the change; native posters redraw the next time they load.

![Picking a preset, colouring the Quality group and checking contrast in the Tag Styles editor](../images/admin/tag-styles.gif)

| Setting | Default | What it does |
|---|---|---|
| **Enable Tag Styles** | Off | Turns the colours on. Turning it off keeps your edits |
| **Apply to** | **Both** | **Web** recolours the overlays in Jellyfin Web; **Native posters** recolours the tags drawn into posters for apps such as Android TV (needs **Enable Native Poster Tags (Experimental)**) |
| **Preset** | **Default** | The colours every tag starts from (see below) |
| **Let users pick their own preset** | Off | Adds the **Colours** tab to each user's **Media Tags** section. Your group and tag colours stay on top of the preset a user picks |
| **Reset all colours** | | Clears every group and tag colour and returns to the **Default** preset (saved when you click **Save Settings**) |

### Presets

Each preset sets a background, border and text colour for every kind of tag. Each preset tile previews a 4K, a rating and a PG-13 tag in its colours.

| Preset | Look |
|---|---|
| **Default** | The built-in colours. Nothing changes and custom CSS keeps working as before |
| **Glass** | Light translucent chips with a soft white border; white text, gold community scores and trending ranks, red critic scores |
| **Outline** | Dark translucent chips; the border and text take each tag's tint: blue resolution, orange dynamic range and IMAX/3D, green audio, grey codec and source, gold community score, red critic score, the board colour for age ratings. Genre, status and language get a white border |
| **Dark** | Near-black chips without a border; white text with gold and red scores |
| **Light** | Near-white chips without a border; dark text, darker gold and red scores, age ratings in their board colour |
| **Mono** | Neutral dark grey chips with light grey text and a faint border |

### Groups and single tags

The editor shows every tag of the selected group in its current colours, so you can see the result before changing anything. A dot marks a group or tag you changed.

| Tab | Tags you can edit one by one | Notes |
|---|---|---|
| **Quality** | Every quality label (4K, HDR10, ATMOS, HEVC…) | Combined labels such as ATMOS 7.1 follow their base label |
| **Age** | One chip per age rating colour board, shown with a sample rating | Hover a chip to see every rating it covers |
| **Rating** | **Community**, **Critic**, **User review** | Rating chips have no border of their own: a border colour draws a thin inner ring |
| **Genre** | **Genre** | **Text** colours the genre icon |
| **Status** | **Just Added**, **New Movie**, **New Series**, **New Episode**, **Trending** | Web only: native posters do not show Status Tags. A Trending text colour also recolours the rank |
| **Language** | **Flag / code**, **Subtitles**, **Dual / Multi** | Each label can change its border ring. Partial dubs keep their dashed outline |
| **Custom** | Each label of the **Custom tag rules** | The labels follow the rules table as you edit it; rules that share a label share its colours. The icon takes the text colour |

A tag's colours are worked out field by field: its own colour if you set one, else the group colour, else the preset. **Default** on a row removes that one colour from what you are editing, so it falls back to the group or the preset.

### Contrast check

The badge under the colour rows rates the text against the background, both shown over a dark poster:

| Badge | Contrast | Meaning |
|---|---|---|
| **AA** (green) | 4.5:1 or more | Easy to read |
| **AA large only** (amber) | 3:1 to 4.5:1 | Readable for large or bold text only |
| **Low contrast** (red) | under 3:1 | Hard to read |

With **Whole group** selected, the badge shows the tag that reads worst. Translucent presets also depend on the artwork behind them, so check the preview.

### User presets

With **Let users pick their own preset** on, users choose **Tag Colours** on the **Colours** tab of **Media Tags** (see [The Media Tags section](#the-media-tags-section)). **Server default** follows your preset; any other choice replaces only the preset, never your group or tag colours. The web applies it right away, and native posters for that user follow the next time they load.

Styles change colours, not size, shape, position or visibility. For web layout, sizing, hiding and more detailed styling, see [CSS Customization](../advanced/css-customization.md).

!!! note "Style requirements"
    Native colours need **Enable Native Poster Tags (Experimental)**. Enable the tag feature and supply metadata first: CSS cannot create missing tags or restyle pixels already drawn into an image.

??? info "Stored style configuration"
    The saved fields are `TagStylesEnabled`, `TagStyleTarget` (`both`, `web` or `native`), `TagStylePreset` (`default`, `glass`, `outline`, `dark`, `light` or `mono`), `TagStylesAllowUserPreset`, and `TagStyleOverrides`: an empty string, or a version 2 document `{"v":2,"preset":…,"groups":{…},"labels":{…}}` holding only the colours you set. Settings saved before this editor (version 1, with colours per quality label, age board, rating chip and genre) still load and look exactly as before: each tag you had changed keeps the colours it was drawn with, and the preset becomes **Default**, because the old presets were already baked into those colours. They are converted to version 2 on the next save. `TagStyleApplyScope` is no longer used. Each user's choice is `TagStylePreset` in their settings (`null` follows the admin). Saving checks the document, in either version: anything that is not a colour, an unknown group, tag or field, or a document over 32 KB keeps the current styles. See the [API reference](../advanced/api.md#style-and-native-preview-contracts) for the full format.

??? info "Web CSS behavior"
    Saved Tag Styles use stronger important colour rules than simple CSS recipes, but sufficiently specific important custom CSS can override them. Status chips carry `data-je-status` (`added`, `newMovie`, `newSeries`, `newEpisode`, `trending`) if you want to target one kind yourself. Prefer the corner controls to transforms that can disrupt shared-corner stacking. Genre-name styling requires **Hide Tags on Hover** off. Hiding a displayed flag with CSS does not make a fourth flag appear.

??? info "Style API routes"
    The effective web colours are available through authenticated `GET /JellyfinEnhanced/tag-styles` (empty when disabled or targeting native posters only; optional `preset` for a user's own preset). The shipped defaults and preset palettes are administrator-only `GET /JellyfinEnhanced/tag-styles/catalog`.

Other integrations have separate badge systems: see [Seerr](../seerr/seerr-features.md) for request/availability/provider badges and [*arr](../arr/arr-features.md) for service status and synchronized tag links. Those are configured independently of these poster groups.
