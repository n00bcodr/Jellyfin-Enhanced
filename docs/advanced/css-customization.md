# CSS Custom Styling

Use Custom CSS to change the appearance of Jellyfin Enhanced's web overlays, tags, settings panel, and notifications.

These recipes target elements created by JE's injected web client. The feature must be enabled and its metadata available before CSS can style it.

For feature setup and client requirements, see [Compatibility](../getting-started/compatibility.md), [Tags & Badges](../enhanced/tags.md), and [Enhanced Settings](../enhanced/enhanced-settings.md).

## Applying Custom CSS

As a Jellyfin administrator:

1. Open **Dashboard** → **Branding**.
2. Paste the recipes you want into **Custom CSS Code**, alongside your existing CSS.
3. Click **Save**.
4. Reload the web client. Use ++ctrl+f5++ for a hard refresh in browsers that support it.

This applies CSS server-wide to web clients that load Jellyfin's Custom CSS. Test the result on desktop and phone layouts.

To undo a recipe, remove its rules, save, and reload.

### When a rule has no effect

Inspect the element in your browser's developer tools and check its actual classes, attributes, and computed styles. A disabled feature, absent metadata, or a native poster image can leave nothing for the selector to match.

The examples use `!important` where needed to beat built-in colors, inline styles, or responsive rules. Scope changes to a JE container and keep hover, selected, disabled, and focus states usable.

??? info "How CSS rules compete"

    JE uses ordinary stylesheets, ordinary inline styles, and `!important` declarations:

    - An ordinary inline style beats ordinary stylesheet rules.
    - An important stylesheet rule can override an ordinary inline style.
    - Among competing important rules in these stylesheets, higher specificity wins. Equal specificity falls back to document order.

    JE appends shared styles, pause-screen styles, and Tag Styles overrides to the document head. On Jellyfin 12 web, Custom CSS is rendered in the body, after those head styles. Equal-specificity rules can therefore win even if JE injected its style later in time.

    The panel also embeds its own style element in the body. Inspect the winning declaration instead of assuming all styles have the same order, especially on Jellyfin 10.11.

## Pause Screen

The pause screen shows artwork, item details, plot, and a progress snapshot while playback is paused. Enable it in your personal **Playback Settings**, pause a video, and leave the player idle to preview your CSS.

The administrator sets the default; viewers can override it in the Enhanced panel.

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Custom Pause Screen** (admin) / **Custom Pause Screen** (viewer) | On | `PauseScreenEnabled`: enables the pause overlay. |
| **Delay before showing (seconds):** (viewer) | `5` | `PauseScreenDelaySeconds`: delay during paused inactivity; the panel accepts 1–60 seconds. |

Clicks, touches, key presses, scrolling, and mouse movement beyond the movement threshold reset the inactivity timer.

Missing logo or disc artwork stays hidden. Artwork lookup considers the item and applicable parent/series artwork.

### Elements and visibility

Use these selectors to style or hide individual parts of the pause screen.

| Element | CSS selector | What it contains |
| --- | --- | --- |
| Dialog | `#pause-screen-overlay` | Outer overlay; visible when `aria-hidden="false"`. |
| Content | `#pause-screen-content` | Backdrop, logo, details, plot, progress, and close button. |
| Logo | `#pause-screen-logo` | Item logo image. |
| Details | `#pause-screen-details` | Item metadata. |
| Plot | `#pause-screen-plot` | Scrollable synopsis. |
| Progress wrapper | `#pause-screen-progress-wrap` | Bar and labels. |
| Progress track | `#pause-screen-progress-bar` | Track behind the fill. |
| Progress fill | `#pause-screen-progress-bar > span` | Playback snapshot; width is written inline. |
| Progress labels | `#pause-screen-progress-meta` | `.progress-time`, `.progress-percentage`, `.progress-ends-at`. |
| Spinning disc | `#pause-screen-disc` | Disc image; a direct child of the overlay. |
| Backdrop | `#pause-screen-backdrop` | Background artwork layer. |
| Close button | `#pause-screen-close-btn` | Dismisses the overlay for this pause without resuming. |

Hide any optional region using its ID. For example:

```css
#pause-screen-logo,
#pause-screen-details,
#pause-screen-plot,
#pause-screen-progress-wrap,
#pause-screen-disc,
#pause-screen-backdrop {
    display: none !important;
}
```

Keep only the selectors for regions you want to hide. You can style the remaining regions independently:

```css
#pause-screen-progress-bar > span {
    background: gold !important;
}

#pause-screen-progress-meta .progress-ends-at {
    display: none !important;
}

#pause-screen-overlay #pause-screen-progress-meta .progress-percentage {
    color: gold !important;
    font-weight: bold !important;
}

#pause-screen-plot {
    height: 30vh !important;
    overflow-y: auto !important;
}

#pause-screen-disc {
    animation: none !important;
}

#pause-screen-backdrop {
    opacity: 0.15 !important;
}
```

The progress fill is not a seek control. Press ++space++ or ++enter++ to resume. Clicking or touching an empty overlay/content surface schedules resume after 500 ms.

!!! note

    Hide individual regions rather than the dialog itself. While active, JE adds `.pause-screen-active` to the HTML root and suppresses parts of the player's controls. Hiding the whole dialog with CSS leaves that state active.

    Keep the close button and the focus helpers (`#pause-screen-focus-start`, `#pause-screen-focus-end`) usable, or turn off **Custom Pause Screen** to remove the feature.

### CSS variables

These are CSS custom properties, separate from plugin settings. Assign them to `#pause-screen-overlay` so its children inherit your values instead of the responsive root defaults.

| Custom property | Base default | What it changes |
| --- | --- | --- |
| `--pause-screen-overlay-bg` | `rgba(0,0,0,.78)` | Overlay background. |
| `--pause-screen-blur` | `50px` | Content backdrop blur. |
| `--pause-screen-logo-max-w` | `45vw` | Logo maximum width. |
| `--pause-screen-logo-max-h` | `20vh` | Logo maximum height. |
| `--pause-screen-logo-top` | `20vh` | Logo top position. |
| `--pause-screen-logo-left` | `8vw` | Logo left position. |
| `--pause-screen-details-top` | `45vh` | Details top position. |
| `--pause-screen-details-left` | `8vw` | Details and progress wrapper left position. |
| `--pause-screen-details-gap` | `2rem` | Space between detail items. |
| `--pause-screen-text-size` | `1.2rem` | Details font size. |
| `--pause-screen-plot-top` | `55vh` | Plot top position. |
| `--pause-screen-plot-left` | `8vw` | Plot left position. |
| `--pause-screen-plot-max-w` | `50vw` | Plot maximum width. |
| `--pause-screen-plot-font` | `1.25rem` | Plot font size. |
| `--pause-screen-progress-top` | `85vh` | Progress wrapper top position. |
| `--pause-screen-progress-width` | `48vw` | Progress wrapper width. |
| `--pause-screen-progress-height` | `6px` | Progress track height. |
| `--pause-screen-progress-radius` | `999px` | Progress track corner radius. |
| `--pause-screen-disc-w` | `26vw` | Disc width; also determines its vertical centering. |
| `--pause-screen-disc-right` | `5vw` | Disc distance from the right edge. |
| `--pause-screen-disc-rot-sec` | `60s` | Duration of one disc rotation. |

```css
#pause-screen-overlay {
    --pause-screen-blur: 20px;
    --pause-screen-logo-max-w: 35vw;
    --pause-screen-plot-max-w: 60vw;
    --pause-screen-progress-height: 10px;
}
```

??? note "Responsive layouts and disc animation"

    Built-in layouts adjust root defaults at widths of 1400px and 768px, and in landscape at heights of 500px or less.

    Some phone positions, font sizes, and plot dimensions are set directly on elements, so variables do not control every dimension. Narrow layouts hide the disc; the later landscape rule can show it again. Reduced-motion preferences stop its rotation.

## Tags

Poster tags use separate containers for quality, genre, language, rating, and age-rating badges. People tags decorate cast portraits on detail pages. Enable the relevant personal setting in **UI Settings** before trying a recipe.

### Prerequisites and placement

The administrator's **Display** → **Media Tags** settings provide defaults. All six tag features start off at factory defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Quality Tags** (admin) / **Show Quality Tags** (viewer) | Off | `QualityTagsEnabled`: resolution, source, format, and sound badges. |
| **Enable Genre Tags** (admin) / **Show Genre Tags** (viewer) | Off | `GenreTagsEnabled`: genre icons and hover labels. |
| **Enable Language Tags** (admin) / **Show Language Tags** (viewer) | Off | `LanguageTagsEnabled`: audio-language flags. |
| **Enable Rating Tags** (admin) / **Show Rating Tags** (viewer) | Off | `RatingTagsEnabled`: community and critic scores. |
| **Enable Age Rating Tags** (admin) / **Show Age Rating Tags** (viewer) | Off | `AgeRatingTagsEnabled`: official age/content certification. |
| **Enable People Tags** (admin) / **Show People Tags** (viewer) | Off | `PeopleTagsEnabled`: cast ages, birthplace, and deceased status. |
| **Hide Tags on Hover** (admin and viewer) | Off | `TagsHideOnHover`: adds `body.je-tags-hide-on-hover`; an important hover rule hides the poster tag host. |

New user settings for the six tag features are seeded from the plugin configuration. Existing non-null user values take precedence over admin defaults. Changing a default does not replace a saved personal choice. See [Settings Overview](../getting-started/settings-overview.md) for default management.

Server and saved user properties use PascalCase. Resolved client settings use camelCase, such as `qualityTagsEnabled`.

**Hide Tags on Hover** is an exception: new user settings store `TagsHideOnHover=false` even when the admin default is on. That stored value takes precedence. To hide tags on hover, turn on **Hide Tags on Hover** in your personal **UI Settings**.

If tag data is stale or missing, also check the server's cache configuration under **Display** → **Media Tags**:

| Setting (admin) | Default | What it does |
| --- | --- | --- |
| **Exclude libraries from the tag cache** | Off | `TagCacheExcludeLibraries`: enables library exclusions. |
| **Libraries to exclude** | Empty | `TagCacheExcludedLibraryIds`: selected libraries to skip; an empty selection excludes nothing. |

Exclusion changes affect the next cache rebuild. Click **Save Settings**, then open **Admin** → **Tag Cache** and click **Rebuild Server Tag Cache**. Confirm the full rebuild. See [Tags & Badges](../enhanced/tags.md) for cache operation; CSS only styles the resulting elements.

Use the position grids in **UI Settings** to move tag containers between corners.

The normal poster structure places `.je-tag-host` inside `.cardScalable`, before `.cardOverlayContainer`. Fallback targets are used when that structure is unavailable.

| Tag container | Position property | Factory corner |
| --- | --- | --- |
| `.quality-overlay-container` | `QualityTagsPosition` | `top-left` |
| `.genre-overlay-container` | `GenreTagsPosition` | `top-right` |
| `.language-overlay-container` | `LanguageTagsPosition` | `bottom-left` |
| `.rating-overlay-container` | `RatingTagsPosition` | `bottom-right` |
| `.age-rating-overlay-container` | `AgeRatingTagsPosition` | `bottom-right` |

Containers carry `data-je-corner` with one of those four corner values. JE stacks containers sharing a corner with inline transforms and a 4px gap, and offsets top-right tags around card indicators. Custom transforms can disrupt that stacking.

Poster tags generally ignore pointer input. Container-query sizing adapts badges to card width, with separate mobile rules. Fixed sizes can crowd small posters.

Processing markers such as `data-je-quality-tagged`, `data-je-genre-tagged`, `data-je-language-tagged`, `data-je-rating-tagged`, and `data-je-age-rating-tagged` record processing. They do not guarantee a visible badge.

### Tag Styles and native posters

Use the built-in [Tag Styles editor](../enhanced/tags.md#tag-styles-and-css) for supported colors; that guide covers presets, tabs, scope, opacity, and bulk controls. See [Native Poster Tags](../enhanced/tags.md#native-poster-tags-experimental) for native-client setup and refresh requirements. CSS remains useful for web shape, sizing, visibility, and other surfaces.

Web overrides use important selectors. Their specificity is `(0,4,0)` for quality, `(0,3,0)` for age and rating chips, and `(0,2,0)` for genre. These beat simple color recipes; more specific important Custom CSS can override them.

Critic styles also match user-review chips because those share `.rating-tag-critic`.

??? info "Checking Tag Styles through the API"

    For troubleshooting, authenticated `GET /JellyfinEnhanced/tag-styles` returns effective web overrides only when enabled and targeting `web` or `both`. Otherwise it returns empty styles. Unavailable configuration returns HTTP 503.

    `GET /JellyfinEnhanced/tag-styles/catalog` additionally requires an administrator. See the [API reference](api.md).

CSS selectors cannot individually restyle pixels drawn into a poster image. Use Tag Styles targeting poster images for supported color changes; native output requires Native Poster Tags.

### Quality Tags

Quality badges use `.quality-overlay-label` and a normalized `data-quality` value. Inspect the attribute rather than matching the displayed text: a badge reading `ATMOS 7.1` has `data-quality="ATMOS"`.

| Category | Recognized `data-quality` values | Additional class |
| --- | --- | --- |
| Resolution | `8K`, `4K`, `1440p`, `1080p`, `720p`, `576p`, `480p`, `LOW-RES`, `SD` | `.resolution` |
| Source | `BluRay`, `HD DVD`, `DVD`, `VHS`, `HDTV`, `Physical` | `.other-quality` |
| Dynamic range | `Dolby Vision`, `HDR10+`, `HDR10`, `HDR` | `.video-codec` |
| Special format | `IMAX`, `3D` | `.video-codec` |
| Video codec | `AV1`, `HEVC`, `H265`, `VP9`, `H264`, `VP8`, `XVID`, `DIVX`, `WMV`, `MPEG2`, `MPEG4`, `MJPEG`, `THEORA` | `.video-format` |
| Sound | `ATMOS`, `DTS-X`, `TRUEHD`, `DTS`, `Dolby Digital+`, `7.1`, `5.1` | `.audio-codec` |

The codec class names are historical: `.video-format` means video codec, while `.video-codec` means HDR or special format. Unknown labels use `.other-quality`.

??? note "Which quality values can appear"

    - `SD` is recognized for sorting/styling, but the current resolution detector emits the other eight resolution values. Unknown or stale cached values can also pass through.
    - Only the best resolution is retained.
    - Source detection requires a `.disc` media stub and selects one source badge.
    - Standalone channel fallback produces `7.1` or `5.1`. `2.0` can be appended to a codec label but is not a standalone fallback.

Use the [Quality Tags category controls](../enhanced/tags.md#quality-tags) before CSS hiding; that guide covers administrator defaults, personal overrides, and category order.

**Resize all quality badges:**

```css
.quality-overlay-label {
    font-size: 0.8rem !important;
    padding: 3px 10px !important;
}
```

**Change a color while allowing admin Tag Styles to take precedence:**

```css
div.quality-overlay-container .quality-overlay-label[data-quality="4K"] {
    background: purple !important;
    color: #fff !important;
}
```

This selector beats the built-in `(0,3,0)` color rule, but loses to the editor's `(0,4,0)` override. To deliberately override the editor too, use:

```css
.quality-overlay-container.quality-overlay-container
.quality-overlay-label.quality-overlay-label[data-quality="4K"] {
    background: purple !important;
    color: #fff !important;
}
```

**Hide unwanted values:**

```css
.quality-overlay-label[data-quality="H264"],
.quality-overlay-label[data-quality="Physical"] {
    display: none !important;
}
```

**Customize media-stub source colors:**

```css
div.quality-overlay-container .quality-overlay-label[data-quality="BluRay"] {
    background: rgba(0, 150, 255, 0.95) !important;
    color: #fff !important;
}

div.quality-overlay-container .quality-overlay-label[data-quality="HD DVD"] {
    background: rgba(200, 0, 50, 0.95) !important;
    color: #fff !important;
}

div.quality-overlay-container .quality-overlay-label[data-quality="DVD"] {
    background: rgba(200, 100, 0, 0.95) !important;
    color: #fff !important;
}

div.quality-overlay-container .quality-overlay-label[data-quality="VHS"] {
    background: rgba(160, 82, 45, 0.95) !important;
    color: #fff !important;
}

div.quality-overlay-container .quality-overlay-label[data-quality="HDTV"] {
    background: rgba(100, 100, 100, 0.95) !important;
    color: #fff !important;
}
```

#### Sound-tag language selection

Audio preferences can change which sound badge appears for the same item across viewers.

| Setting | Default | What it does |
| --- | --- | --- |
| **Preferred Audio Language for Sound Tags** (admin) | **No preference (best track overall)** (`""`) | `QualityTagsPreferredAudioLanguage`: server language preference. |
| **Use Each User's Jellyfin Audio Language** (admin) | Off | `QualityTagsAudioLanguageFromUser`: uses each viewer's Jellyfin audio preference as server policy. |
| **Preferred audio language for the sound tag** (viewer) | **Server default** (`""`) | Overrides server policy with **My Jellyfin audio language** (`auto`), **No preference (best track overall)** (`none`), or a language code. |

Matching tries regional language matches, then base-language matches, then all tracks. Inspect the resolved badge before targeting an audio `data-quality` value.

### Genre Tags CSS

Use these hooks to style genre icons and their hover labels. Up to three genres appear.

- Icons use `.genre-tag > .je-msym-outlined`.
- Text uses `.genre-text` inside `.genre-overlay-container`.
- Target a particular genre through its original title, such as `.genre-tag[title="Drama"]`. JE does not emit `data-genre`.

By default, text appears on hover and floats inward from the selected corner. To keep labels visible inside wider chips:

1. Turn off **Hide Tags on Hover**.
2. Reload so existing chips include text spans.
3. Apply the following CSS:

```css
.genre-tag {
    width: auto !important;
    border-radius: 14px !important;
    gap: 4px;
    padding: 0 6px;
}

.genre-tag .genre-text {
    position: static !important;
    transform: none !important;
    opacity: 1 !important;
}
```

Changing `display` alone does not reveal text hidden by opacity. CSS cannot restore a span omitted when hover hiding was enabled. Long labels can cover more of the poster.

### Language Tags CSS

Use `.language-overlay-container` and `.language-flag` to style language flags.

- `data-lang` is a lowercase flag-country code: `jp` targets the Japanese flag, while Japanese's language code is `ja`.
- `data-lang-name` contains represented language names.
- Partial flags also have `.language-flag-partial` and `data-partial="true"`.

| Setting (admin) | Default | What it does |
| --- | --- | --- |
| **Priority Languages** | Empty | `LanguageTagsPriority`: prioritizes language flags. |
| **Only Show Priority Languages** | Off | `LanguageTagsPriorityStrict`: restricts output to the priority list. |

Flags are deduplicated by country and limited to three. Full flags normally precede partial flags, but priority ordering takes precedence.

When different languages share a flag, it is partial only if all represented languages are partial. Hiding a flag with CSS does not cause a fourth flag to render.

**Resize flags or hide a specific flag:**

```css
.language-flag {
    width: 30px !important;
    height: auto !important;
}

.language-flag[data-lang="jp"] {
    display: none !important;
}
```

**Restyle flags for audio that does not cover every episode of a series/season:**

```css
.language-flag-partial {
    opacity: 1 !important;
    filter: none !important;
    outline: 2px solid gold !important;
    /* To hide partial flags instead: display: none !important; */
}
```

Partial flags normally use opacity `0.55`, saturation `0.5`, a dashed outline, and a dark shadow ring.

This recipe keeps the existing ring and outline offset. Add `box-shadow: none !important` or `outline-offset: 0 !important` if desired.

### Rating Tags CSS

Use `.rating-overlay-container`, `.rating-tag`, and `.rating-text` to style poster scores. Community and critic chips have separate hooks:

- `.rating-tag-tmdb` displays Jellyfin's `CommunityRating`; the class name does not guarantee TMDB supplied the metadata. Its star is `.rating-star-icon`.
- Critic chips use `.rating-tag-critic` and `.rating-tomato-icon.fresh` or `.rating-tomato-icon.rotten`. Scores below 60 are rotten, and scores of 60 or more are fresh.

Use the [Rating Tags scope controls](../enhanced/tags.md#rating-tags) to choose item types and home rows; that guide covers administrator defaults and personal overrides.

**Change the community-score background:**

```css
.rating-tag-tmdb {
    background: rgba(0, 0, 0, 0.9) !important;
}
```

This beats ordinary defaults; enabled admin community Tag Styles take precedence.

**Hide critic chips while keeping user-review chips:**

```css
.rating-tag-critic:not(.je-userreview-tag) {
    display: none !important;
}
```

Using `.rating-tag-critic` without the exclusion also hides user-review chips.

#### User-review poster chips

These chips show the aggregate 1–5 review average converted to a /10 score.

They require a resolvable TMDB item key, personal **Show Rating Tags**, and the following admin settings under **Elsewhere** → **User Reviews**:

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable User Written Reviews** | Off | `ShowUserReviews`: enables user reviews. |
| **Show average user rating on poster cards** | Off | `ShowUserRatingOnPosters`: adds the review-average chip. |
| **Show "—" on posters for unrated items** | On | `ShowUserRatingDash`: a null average shows a dash; off removes the chip when no average is available. |

The chip has `.rating-tag.rating-tag-critic.je-userreview-tag`, with `.je-userreview-icon` and `.rating-text` children. The associated container carries `data-je-review-key` for updates.

Built-in chip and icon text colors are important pink declarations. Override both when recoloring:

```css
.rating-overlay-container .rating-tag.rating-tag-critic.je-userreview-tag,
.rating-overlay-container .je-userreview-tag .je-userreview-icon {
    color: gold !important;
}
```

See [User Reviews](../elsewhere/elsewhere-features.md#user-reviews) for writing and managing reviews.

### Age Rating Tags CSS

Use `.age-rating-overlay-container` and `.age-rating-tag[rating="…"]` to style poster certifications.

The attribute holds a normalized rating, not necessarily the raw metadata spelling. For example, `DE-12` and `FSK 12` become `FSK-12`, and supported unrated names become `NR`. Inspect it before writing a selector.

**Resize and recolor the poster badge:**

```css
.age-rating-tag {
    border-radius: 999px !important;
    font-size: 12px !important;
}

.age-rating-tag[rating="TV-MA"] {
    background-color: #000 !important;
}
```

Poster badges independently reuse rating-specific colors from the Colored Ratings stylesheet, stripping its important flags. The TV-MA rule beats those shipped colors but loses to a more specific important admin age Tag Style. The fallback is blue-grey.

Detail/player certifications use `.mediaInfoOfficialRating`, a separate surface. The administrator controls their colors under **Extras** → **UI Tweaks**.

| Setting | Default | What it does |
| --- | --- | --- |
| **Colored Ratings Backgrounds** | Off | `ColoredRatingsEnabled`: loads the full stylesheet for official age/content certifications, including supported international boards, US TV descriptors, and ESRB labels. |

To override a shipped detail/player color:

```css
.mediaInfoOfficialRating.mediaInfoOfficialRating[rating="TV-MA"] {
    background-color: #000 !important;
}
```

### People Tags CSS

People tags appear on cast and guest-cast portraits on item detail pages. Use the hooks below to style age chips and birthplace banners.

Birth/death and item-release metadata determine current age, age at death, and age at release. Birthplace text needs birthplace metadata; flags also need a recognized country.

| Hook | What it styles |
| --- | --- |
| `.je-people-age-container` | Age-chip stack. |
| `.je-people-age-chip` | Shared chip shape. |
| `.je-people-age-current` | Current age; green by default. |
| `.je-people-age-deceased` | Age at death; red by default. |
| `.je-people-age-release` | Age at item release; blue by default. |
| `.je-people-age-icon`, `.je-people-age-text` | Chip icon and `<number>y` text. |
| `.je-people-place-banner` | Birthplace banner. |
| `.je-people-flag`, `.je-people-place-icon`, `.je-people-place-text` | Flag, location icon, and birthplace text. |
| `.je-people-round` | Portrait wrapper when JE detects a circular theme layout. |
| `.je-deceased-poster` | Portrait wrapper with deceased styling. |

Chip/banner styles are normally inline. Circular portraits receive additional important rules, so use the detail-page ID to override both layouts:

```css
#itemDetailPage .je-people-age-chip {
    padding: 6px 12px !important;
    font-size: 13px !important;
}

#itemDetailPage .je-people-place-banner {
    display: none !important;
}
```

Larger chips can overlap portraits.

The emitted birthplace class is `.je-people-place-banner`. `.je-people-tag-banner` appears in internal CSS but is not the rendered banner hook.

Deceased image treatment and the cross can be styled separately:

```css
#itemDetailPage .je-deceased-poster .cardImageContainer {
    filter: grayscale(50%) opacity(0.9) !important;
}

#itemDetailPage .je-deceased-poster .cardScalable::after {
    color: gold !important;
}
```

### *arr Tag Links

Enable **Show synced tags as links** under the admin **\*arr** → **Tags Sync** section. Matching tags already present on an item become links in `.itemExternalLinks` on its detail page. Importing tags is a separate operation; see [*arr Features](../arr/arr-features.md).

| Setting (admin) | Default | What it does |
| --- | --- | --- |
| **Show synced tags as links** | On | `ArrTagsShowAsLinks`: creates links for matching item tags. |
| **Tag Prefix** | `JE Arr Tag: ` | `ArrTagsPrefix`: case-sensitive prefix used to identify tags. |
| **Show as Links Filter** | Empty | `ArrTagsLinksFilter`: optional allow list of unprefixed names, one per line. |
| **Hide Specific Links Filter** | Empty | `ArrTagsLinksHideFilter`: hides matching names, one per line; takes precedence over the allow list. |

Filter comparisons ignore case after reconstructing each full prefixed name. Initial prefix matching is case-sensitive.

The factory prefix includes a trailing space. If the admin prefix field is empty on load or save, the admin UI substitutes `Requested by: `. Inspect the actual configured prefix.

The following admin settings under **Tags Sync** control tag imports:

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Tags Sync** | Off | `ArrTagsSyncEnabled`: allows the sync task to import tags from configured Radarr and Sonarr instances. |
| **Clear old tags before sync** | On | `ArrTagsClearOldTags`: removes existing tags with the configured prefix before adding the imported tags. |
| **Sync to Jellyfin Filter** | Empty | `ArrTagsSyncFilter`: restricts which tags are imported; empty syncs all tags. |

The **Sync Tags from *arr to Jellyfin** task has no default triggers; run it manually or configure a schedule.

#### Link structure and attributes

This illustrative link uses the factory prefix. Replace the item/server placeholders with actual values when inspecting your page:

```html
<a is="emby-linkbutton"
   class="button-link emby-button arr-tag-link"
   href="#!/list.html?type=tag&amp;tag=JE%20Arr%20Tag%3A%20in-netflix&amp;serverId=SERVER_ID"
   title="View all items with tag: JE Arr Tag: in-netflix"
   data-item-id="ITEM_ID"
   data-id="in-netflix"
   data-tag="JE Arr Tag: in-netflix"
   data-tag-name="in-netflix"
   data-tag-prefix="JE Arr Tag: ">
  <span class="arr-tag-link-icon" aria-hidden="true" style="margin-right: 5px;">
    <!-- JE icon markup; depends on Use Icons in UI and Icon Style -->
  </span>
  <span class="arr-tag-link-text"
        data-id="in-netflix"
        data-tag="JE Arr Tag: in-netflix"
        data-tag-name="in-netflix"
        data-tag-prefix="JE Arr Tag: ">JE Arr Tag: in-netflix</span>
</a>
```

| Hook | Meaning |
| --- | --- |
| `.arr-tag-link` | Link anchor. |
| `.arr-tag-link-icon` | Icon wrapper. |
| `.arr-tag-link-text` | Visible label wrapper. |
| `data-id` | Normalized slug of the trimmed name after removing the prefix; on anchor and label. |
| `data-tag` | Full original tag, including prefix; on anchor and label. |
| `data-tag-name` | Trimmed name without prefix; on anchor and label. |
| `data-tag-prefix` | Configured prefix; on anchor and label. |
| `data-item-id` | Current item ID; anchor only. |

Different names can share a slug. Use exact `data-tag-name` or `data-tag` when needed.

??? info "How tag slugs are generated"

    Slug generation follows these steps:

    1. Decompose Unicode and remove combining accents.
    2. Lowercase and trim.
    3. Replace whitespace and unsupported characters with hyphens.
    4. Collapse repeated hyphens and remove edge hyphens.

    ASCII letters, digits, hyphens, and underscores survive. For example, `1 - n00bcodr` becomes `1-n00bcodr`.

Links navigate to `#!/list.html?type=tag&tag=<encoded full tag>&serverId=<server>`. JE uses `Dashboard.navigate` when available and the equivalent hash otherwise.

#### Common recipes

Use these recipes to change link labels, visibility, icons, or colors.

**Rename a visible label:**

```css
.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"] .arr-tag-link-text {
    display: none !important;
}

.itemExternalLinks a.arr-tag-link[data-tag-name="1 - n00bcodr"]::after {
    content: " N00bCodr";
}
```

This changes visible text only. The tooltip, stored tag, and navigation still use the original full tag.

**Hide a link:**

```css
.itemExternalLinks a.arr-tag-link[data-id="in-netflix"] {
    display: none !important;
}
```

You can alternatively match `[data-tag-name="in-netflix"]`.

To hide it globally through settings, use **Tags Sync** → **Tag Filters** → **Hide Specific Links Filter**. Enter the name without its prefix, one per line.

**Replace the icon, or remove it by using only the first rule:**

```css
.itemExternalLinks a.arr-tag-link .arr-tag-link-icon {
    display: none !important;
}

.itemExternalLinks a.arr-tag-link::before {
    content: "🔖";
    margin-right: 0.25rem;
}
```

**Make links into pills:**

```css
.itemExternalLinks a.arr-tag-link {
    padding: 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.5);
    border: 2px solid rgba(255, 255, 255, 0.8);
}
```

**Give specific names different colors using their normalized slugs:**

```css
.itemExternalLinks a.arr-tag-link[data-id="1-n00bcodr"] {
    background: #d81f26;
    color: #fff;
}

.itemExternalLinks a.arr-tag-link[data-id="2-jellyfish"] {
    background: #00a8e1;
    color: #fff;
}

.itemExternalLinks a.arr-tag-link[data-id="3-admin"] {
    background: #0c1a38;
    color: #8dd0ff;
}
```

#### Configurable icons

These admin settings control configurable JE icons:

| Setting | Default | What it does |
| --- | --- | --- |
| **Use Icons in UI** | On | `UseIcons`: shows configurable JE icons; turning it off leaves the *arr icon wrapper empty. |
| **Icon Style** | **Emoji** (`emoji`) | `IconStyle`: selects **Emoji**, **Lucide Icons** (`lucide`), or **Material UI Icons** (`mui`). |

The markup depends on the icon style:

- Emoji markup uses `.je-emoji`.
- Lucide icons can use a wrapper containing an SVG.
- Material UI icons use Material icon spans.

Renderers can fall back to wrapped emoji.

Examples of the contents inside `.arr-tag-link-icon` (Lucide geometry is abbreviated):

```html
<!-- Emoji -->
<span class="je-emoji">🏷️</span>
<!-- Lucide -->
<span style="display:inline-flex;vertical-align:middle;">
  <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em"
       viewBox="0 0 24 24" fill="none" stroke="currentColor"><!-- paths --></svg>
</span>
<!-- Material UI -->
<span class="material-icons" style="font-size:1em;vertical-align:middle;">label</span>
```

Target the outer `.arr-tag-link-icon` to handle all renderers. A CSS `::before` replacement stays visible even with configurable icons off.

Genre and people tags emit their own Material Symbols hooks and are not governed by this configurable icon switch.

## Enhanced Panel

Open **Enhanced Panel** from the sidebar to preview panel styling.

Other entry points use **Jellyfin Enhanced** or **Jellyfin Enhanced - User Settings**, depending on the surface. See [Settings Overview](../getting-started/settings-overview.md) for access and personal settings.

### Automatic theme detection

Check these variables when customizing how the panel uses your theme's colors and effects.

JE checks identifying root CSS variables for Jellyfish, ElegantFin, and Zesty, in that order. The first nonempty identifier other than `none` wins. Other themes receive Default styling. These variables are supplied by themes, not defined by JE.

| Theme | Detection variable | Variables consumed by JE |
| --- | --- | --- |
| Jellyfish | `--theme-updated-on` | `--primary-background-transparent`, `--secondary-background-transparent`, `--primary-accent-color`, `--text-color`, `--alt-accent-color`, `--blur`, `--logo` |
| ElegantFin | `--elegantFinFooterText` | `--headerColor`, `--drawerColor`, `--activeColor`, `--textColor`, `--selectorBackgroundColor`, `--blurDefault` |
| Zesty | `--honey-yellow` | `--darkest`, `--dark`, `--accent`, `--white`, `--dark-highlight`, `--rounding` |

Reopen the panel after changing theme values. Reload to redetect a different theme.

??? note "Theme fallbacks and cached detection"

    Missing values have fallbacks. Detection is cached, but JE reads the selected theme's values again when constructing a panel and inserts them as literal styles.

    Zesty's `--rounding` feeds JE's blur input. Some surfaces, including the panel root and phone content background, also have fixed defaults.

### Shell and navigation hooks

Use these hooks to style the panel's layout and section navigation. Scope these classes to `#jellyfin-enhanced-panel`.

| Hook | What it styles |
| --- | --- |
| `#jellyfin-enhanced-panel` | Panel root. |
| `.panel-header`, `#closeSettingsPanel` | Header and close button. |
| `.je-panel-body` | Navigation/content wrapper; gains `.je-pane-open` when a section is open. |
| `.je-panel-nav`, `.je-panel-nav-items` | Navigation column and its button list. |
| `.je-panel-search`, `#jePanelSearch` | Section search field. |
| `.tab-button[data-tab="…"]`, `.tab-button.active` | Navigation entry and selected entry. |
| `.je-panel-main` | Content area. |
| `.je-pane[data-pane="…"]`, `.je-pane.active` | Section pane and selected pane. |
| `.je-pane-title` | Section heading. |
| `.je-pane-back`, `#jePanelBack` | Phone back button. |
| `.panel-footer`, `.close-helptext` | Closing-help bar. |
| `#releaseNotesBtn`, `[data-pane="about"] a`, `.footer-logo` | **Release Notes**, **Contribute**, and optional theme logo in **About**. |

Pane values always include `playback`, `auto-skip`, `subtitles`, `random-button`, `ui`, `language`, and `about`. Other panes depend on their features:

- `shortcuts` appears when shortcuts are enabled.
- `hidden-content` requires its module.
- `spoiler-guard` requires admin enablement and its pane builder.

The layout changes with screen size:

- Desktop uses a 230px navigation column and restores `LastOpenedTab`.
- At widths of 760px or less, the panel fills the screen and starts with the section list.

Search matches pane text and filters navigation entries; Back returns to the list. Preserve `.active`, inactive-pane visibility, `.je-pane-open`, and the phone layers' `inert` focus restrictions.

Entry-point hooks outside the panel are `.jellyfinEnhancedSection`, `#jellyfinEnhancedSettingsLink`, `#jellyfinEnhancedUserMenuLink`, `#jellyfinEnhancedUserPrefsLink`, and `#enhancedSettingsBtn`. The player entry is hidden under `.layout-desktop`.

### Panel surfaces and header

Changing the root background alone leaves backgrounds on the body, navigation, and phone content area intact. This recipe changes those surfaces together:

```css
#jellyfin-enhanced-panel {
    background: rgba(25, 35, 45, 0.85) !important;
    border: 1px solid rgba(125, 150, 175, 0.3) !important;
    backdrop-filter: blur(20px) !important;
    color: #e6e6e6 !important;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5) !important;
}

#jellyfin-enhanced-panel .je-panel-body {
    background: rgba(25, 35, 45, 0.85) !important;
}

#jellyfin-enhanced-panel .je-panel-nav {
    background: rgba(10, 20, 30, 0.6) !important;
}

#jellyfin-enhanced-panel .je-panel-main {
    background: transparent !important;
}

#jellyfin-enhanced-panel > .panel-header {
    background: rgba(0, 0, 0, 0.25) !important;
    border-bottom: 1px solid rgba(125, 150, 175, 0.3) !important;
}

#jellyfin-enhanced-panel > .panel-header > div:first-child {
    background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
    -webkit-background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
}

#jellyfin-enhanced-panel .panel-footer {
    background: rgba(0, 0, 0, 0.25) !important;
    border-top: 1px solid rgba(125, 150, 175, 0.3) !important;
}
```

The panel's first element is an embedded style element, so select `.panel-header` directly. The title is the header's first child.

On phones, transparent content can reveal the navigation layer beneath. Use an opaque `.je-panel-main` background if that is distracting.

### Navigation and headings

This recipe changes navigation-button colors, the selected-entry marker, and section headings.

```css
#jellyfin-enhanced-panel .tab-button {
    background: rgba(0, 0, 0, 0.2) !important;
    color: rgba(255, 255, 255, 0.7) !important;
}

#jellyfin-enhanced-panel .tab-button:hover {
    background: rgba(0, 0, 0, 0.4) !important;
    color: #fff !important;
}

#jellyfin-enhanced-panel .tab-button.active {
    background: rgba(0, 0, 0, 0.3) !important;
    color: #fff !important;
}

#jellyfin-enhanced-panel .tab-button.active::before {
    background: #00a4dc !important;
}

#jellyfin-enhanced-panel .je-pane-title {
    color: #00a4dc !important;
}
```

Current sections use panes and navigation buttons. Settings-section `details`/`summary` recipes from older panel versions do not match this structure.

### Controls and previews

Use these hooks for targeted styling. Prefix each selector with `#jellyfin-enhanced-panel`.

Conditional controls appear only when their feature is available.

| Group | Hooks |
| --- | --- |
| Playback | `#autoPauseToggle`, `#autoResumeToggle`, `#autoPipToggle`, `#longPress2xEnabled`, `#pauseScreenToggle`, `.je-pause-delay-row`, `#pauseScreenDelayInput` |
| Auto-skip | `#autoSkipIntroToggle`, `#autoSkipOutroToggle` |
| Subtitle presets | `.preset-box`, `.style-preset`, `.font-size-preset`, `.font-family-preset`, `.text-effect-preset`, `[data-preset-index]`; `#subtitle-style-presets-container`, `#font-size-presets-container`, `#font-family-presets-container`, `#text-effect-presets-container` |
| Subtitle colors | `.je-subtitle-color-layout`, `.je-subtitle-color-controls`, `.je-subtitle-color-control-row`, `#customSubtitleTextColorPicker`, `#customSubtitleTextAlpha`, `#customSubtitleBgColorPicker`, `#customSubtitleBgAlpha`, `#subtitleColorPreview` |
| Subtitle position and status | `#subtitlePositionGrid`, `#subtitlePositionPreview`, `#subtitlePositionReset`, `#disableCustomSubtitleStyles`, `#je-subtitle-format-warning`, `#je-subtitle-position-note` |
| Random selection | `#randomButtonToggle`, `#randomUnwatchedOnly`, `#randomIncludeMovies`, `#randomIncludeShows`, `#randomScopeCurrentContainer`, `#randomSourceSelect` |
| Detail display | `#showWatchProgressToggle`, `#watchProgressModeSelect`, `#watchProgressTimeFormatSelect`, `#showFileSizesToggle`, `#showAudioLanguagesToggle` |
| Tags and removal | Conditional `#nativePosterTagsToggle`; `#qualityTagsToggle`, `#genreTagsToggle`, `#languageTagsToggle`, `#ratingTagsToggle`, `#ageRatingTagsToggle`, `#peopleTagsToggle`, `#tagsHideOnHoverToggle`, `#removeContinueWatchingToggle` |
| Category layout | `.je-quality-cat-wrap`, `.je-quality-cat-expander`, `.je-cat-chevron`, `.je-quality-cat-list`, `.je-quality-cat-row`, `.je-quality-cat-label-wrap`, `.je-quality-cat-label`, `.je-cat-btn`, `.je-cat-up`, `.je-cat-down`, `.je-quality-audio-lang` |
| Quality category controls | `#qualityTagsSubWrap`, `#qualityTagsSubToggleExpander`, `#qualityTagsSubToggles`, `#qualityTagsAudioLanguageSelect`, `#showResolutionTagToggle`, `#showSourceTagToggle`, `#showDynamicRangeTagToggle`, `#showSpecialFormatTagToggle`, `#showVideoCodecTagToggle`, `#showAudioInfoTagToggle` |
| Rating scopes | `#ratingTagsSubWrap`, `#ratingTagsSubToggleExpander`, `#ratingTagsSubToggles`, `#ratingTagsOnMoviesToggle`, `#ratingTagsOnSeriesToggle`, `#ratingTagsOnSeasonsToggle`, `#ratingTagsOnEpisodesToggle`, `#ratingTagsOnContinueWatchingToggle`, `#ratingTagsOnNextUpToggle` |
| Corner grids | `.position-selector[data-setting="qualityTagsPosition"]` (also `genreTagsPosition`, `languageTagsPosition`, `ratingTagsPosition`, `ageRatingTagsPosition`); child `div[data-pos="top-left"]` (also the other three corners) |
| Language and About | `#displayLanguageSelect`, `#clearTranslationCacheButton`, `#releaseNotesBtn`, conditional `.footer-logo` |

Category rows use `data-cat-key`, and quality rows also have `data-order-key` and `data-default-order`.

Expanders use `aria-expanded`; arrow buttons have disabled states. Preserve those states when styling.

The conditional Hidden Content pane exposes:

| Group | Hooks |
| --- | --- |
| Main controls | `#hiddenContentEnabledToggle`, `#hiddenShowHideButtons`, `#hiddenShowConfirmation`, `#manageHiddenContentBtn` |
| Hide-button placement | `#hiddenShowButtonJellyseerr`, `#hiddenShowButtonLibrary`, `#hiddenShowButtonDetails`, `#hiddenShowButtonCast` |
| Filtering surfaces | `#hiddenContentSurfaceToggles`, `#hiddenFilterLibrary`, `#hiddenFilterDiscovery`, `#hiddenFilterSearch`, `#hiddenFilterCalendar`, `#hiddenFilterUpcoming`, `#hiddenFilterRecommendations`, `#hiddenFilterRequests`, `#hiddenFilterNextUp`, `#hiddenFilterContinueWatching`, `#hiddenExperimentalCollections` |

Many selection and hover colors are written inline. Preserve selected, disabled, hidden, warning, and focus states; avoid forcing every preview or control visible.

For a simple checkbox accent change:

```css
#jellyfin-enhanced-panel input[type="checkbox"] {
    accent-color: #aa5cc3 !important;
}
```

### Shortcut keys and About actions

Use the following recipe to style shortcut keys while keeping editing feedback visible.

Shortcut hooks include `.shortcuts-container`, `#shortcuts-content`, `.shortcut-key[data-action="…"]`, `.shortcut-toggle`, `.modified-indicator`, and `.shake-error`.

Readonly chips have `data-readonly="1"` and are excluded from editing. Editable chips listen while focused; keep their focus, listening, and error feedback visible.

```css
#jellyfin-enhanced-panel kbd:not(.shake-error):not(:focus),
#jellyfin-enhanced-panel .shortcut-key:not(.shake-error):not(:focus) {
    background: #34495e !important;
}

#jellyfin-enhanced-panel kbd,
#jellyfin-enhanced-panel .shortcut-key {
    color: #ecf0f1 !important;
    box-shadow: 0 2px 0 #2c3e50;
}

#jellyfin-enhanced-panel .shortcut-key:focus-visible {
    outline: 2px solid gold;
    outline-offset: 2px;
}
```

The background rule excludes focused keys and `.shake-error` so the editor's inline feedback remains visible.

While listening, the editor changes the key's text, border color, and width. Conflicting or reserved bindings set a red background and trigger the shake animation.

**Release Notes** and **Contribute** are in **About**. The footer contains closing instructions, not an action-button wrapper.

```css
#jellyfin-enhanced-panel #releaseNotesBtn,
#jellyfin-enhanced-panel [data-pane="about"] a {
    background: rgba(255, 255, 255, 0.08) !important;
    transition: background-color 0.2s ease;
}

#jellyfin-enhanced-panel #releaseNotesBtn:hover,
#jellyfin-enhanced-panel [data-pane="about"] a:hover {
    background: rgba(255, 255, 255, 0.15) !important;
}
```

## Notifications

Use these recipes to change toast and release-note styling. Both are separate body-level elements, so panel-scoped rules do not reach them.

- Toasts use `.jellyfin-enhanced-toast` with ordinary inline styles and transform animation.
- **Release Notes** fetches the latest GitHub release and opens `#jellyfin-release-notes-notification`.

```css
.jellyfin-enhanced-toast {
    background: linear-gradient(135deg, #00a4dc, #aa5cc3) !important;
    color: white !important;
    border: none !important;
    backdrop-filter: blur(10px) !important;
}

#jellyfin-release-notes-notification {
    background: rgba(25, 35, 45, 0.95) !important;
}
```

| Setting (admin, Playback) | Default | What it does |
| --- | --- | --- |
| **Toast Notification Duration (ms)** | `1500` | `ToastDuration`: configured toast lifetime; individual calls can specify another duration. |
| **Shortcuts Panel Autoclose Delay (ms)** | `15000` | `HelpPanelAutocloseDelay`: Enhanced panel idle-close delay. |

Release notes uses a separate 20-second idle-close timer. CSS transitions do not change JavaScript removal timers.

Keep transform animation intact when changing notification styling.

## Player rating surfaces

Player ratings have different hooks from poster badges. Enable the relevant admin setting, start playback, and inspect the player controls or startup card.

| Setting (admin) | Default | What it does |
| --- | --- | --- |
| **Show Rating in Video Player** | On | `ShowRatingInPlayer`: community/critic chips in the player's on-screen controls. |
| **Show Age Rating When Playback Starts** | Off | `ShowPlaybackRatingBadge`: startup certification card. |

The control chips are inside `#je-osd-rating-container[data-item-id]`. Scope `.je-chip.tmdb`, `.je-chip.critic`, `.je-star`, `.je-text`, `.je-tomato.fresh`, and `.je-tomato.rotten` to that container.

The startup card uses `#je-playback-rating-badge`, the visibility class `.je-visible`, and children `.je-age-rating`, `.je-age-why`, and `.je-age-genres`.

- It displays for five seconds with a 400ms fade.
- Advisory and genre lines are limited to three entries each.
- Its accent reads `--theme-primary-color`, then `--primary-accent-color`, then falls back to `#00a4dc`.
- The age element also has `.mediaInfoOfficialRating`, so Colored Ratings can affect it.

```css
#je-osd-rating-container .je-chip {
    border-radius: 999px !important;
}

#je-playback-rating-badge {
    border-left-color: gold !important;
}
```

Keep `.je-visible` and the timed visibility behavior intact. See [Enhanced Features](../enhanced/enhanced-features.md#playback-controls) for playback features.

## Other styling hooks

These surfaces appear outside the Enhanced panel. Follow the linked feature guides for setup, then inspect the actual elements before applying styles.

Turn on the relevant per-user setting in **Random Button Settings** or **UI Settings**.

The table shows factory plugin/client defaults. New user settings are seeded from the administrator's defaults.

| Setting | Default | What it does |
| --- | --- | --- |
| **Enable Random Button** | On | `RandomButtonEnabled`: shows the random button in the header. |
| **Show Watch Progress** | Off | `ShowWatchProgress`: displays watch progress on item detail pages. |
| **Show File Sizes** | Off | `ShowFileSizes`: displays total file size on item detail pages. |
| **Show Audio Languages** | On | `ShowAudioLanguages`: displays available audio languages on detail pages. |
| **Add Remove from Continue Watching & Next Up Buttons** | Off | `RemoveContinueWatchingEnabled`: adds removal actions for Continue Watching and Next Up items. |

| Surface | Hooks | Prerequisites and guide |
| --- | --- | --- |
| Random header button | `#randomItemButton`, `.je-dice-spin`, `.je-dice-face`, `.loading` | [Enhanced Features](../enhanced/enhanced-features.md). |
| Detail watch progress | `.mediaInfoItem-watchProgress`, `.mediaInfoItem-watchProgress-value` | [Enhanced Settings](../enhanced/enhanced-settings.md). |
| Detail file size | `.mediaInfoItem-fileSize` | [Enhanced Settings](../enhanced/enhanced-settings.md). |
| Detail audio languages | `.mediaInfoItem-audioLanguage` | [Enhanced Settings](../enhanced/enhanced-settings.md). |
| Continue Watching/Next Up actions | `.actionSheetMenuItem[data-id="remove-continue-watching"]`, `.actionSheetMenuItem[data-id="je-multiselect-remove"]`, `:disabled` | [content management](../enhanced/enhanced-features.md#content-management). |
| Seerr issue form | `.jellyseerr-issue-radio-group`, `.jellyseerr-radio-label`, `.jellyseerr-radio-input`, `.jellyseerr-radio-option`, `.jellyseerr-issue-textarea` | Configured Seerr issue reporting; [Seerr Features](../seerr/seerr-features.md). |
| JE symbol fonts | `.je-msym-rounded`, `.je-msym-outlined` | Private Material Symbols classes used by JE; distinct from public `.material-symbols-*` classes. |

```css
#randomItemButton .je-dice-spin {
    animation: none !important;
}

#itemDetailPage .mediaInfoItem-fileSize {
    color: gold !important;
}

.jellyseerr-radio-input:checked + .jellyseerr-radio-option {
    border-color: gold !important;
}
```

The animation override stops both random-button hover and loading animation. Keep loading and disabled actions identifiable.

In the Seerr form, the radio input must remain immediately before its option span. Checked/focus styles use that sibling relationship and consume `--primary-accent-color` with a fallback.
