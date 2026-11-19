# What's collected

JE can share installation statistics to help you see how the community uses the plugin. Reporting is **opt-in and off by default**; an administrator must enable **Share Anonymous Usage Statistics** and save.

Turn reporting on or off, preview a report and set the interval in [Settings](community-analytics-settings.md). Browse the aggregate results in the [Live Dashboard](community-analytics-dashboard.md).

Every enabled report includes installation and version information. The three optional categories add settings, counts or branding-directory size.

## Always included

Every enabled report includes these fields, even if you uncheck all three categories:

- A persistent installation ID assigned by the reporting service.
- The plugin version, Jellyfin server version and build target.
- The start date of the counting period.
- The installation secret used to authenticate the report, and the build-proof field.

??? info "How it works"

    This rewrite reports build target `jf12` only. Historical analytics may still contain `jf10` records. During registration, the service returns the installation ID and secret. JE stores them in its plugin configuration.

## Feature toggle states

This category shows which features participating servers use. It shares on/off settings, whether TMDB and MDBList keys are configured, and a selected set of text settings.

Select **Feature toggle states (on/off only)** before saving to include this category.

??? info "How it works"

    Boolean settings are included except properties beginning with `Analytics` and properties marked `[AnalyticsExclude]`. `TmdbEnabled` and `MdblistEnabled` indicate whether keys are configured; the keys themselves are not sent.

    The selected text settings are:

    | Choice | Reported property and filtering |
    | --- | --- |
    | Icon style | `IconStyle` |
    | Maintenance actions and affected users | `MaintenanceModeAction`, `MaintenanceScheduleAction` and `MaintenanceModeAffectedUsers`. The user scope is reduced to `all` or `selected`, without selected user IDs. |
    | Tag positions | `QualityTagsPosition`, `GenreTagsPosition`, `LanguageTagsPosition`, `RatingTagsPosition`, `AgeRatingTagsPosition`, `StatusTagsPosition` |
    | Tag layout defaults | `TagLayout`, `TagLabelDensity` |
    | Tag styling | `TagStyleTarget`, `TagStylePreset`, `TagStylesAllowUserPreset`, `TagStyleApplyScope` (retired, always its last saved value) |
    | Language priority | `LanguageTagsPriority`, filtered to tokens shaped like language codes and converted to lowercase |
    | Additional Native Poster Tags client exclusions | `NativePosterTagsWebClientNames`, filtered to short app-name-shaped entries, deduplicated and limited to 20. Built-in web clients are omitted. |

    Nonempty strings marked `[AnalyticsInclude]` are included as stored. Other strings are excluded unless the reporting code explicitly derives and filters them. Checking the shape of language/client strings does not guarantee what the entered text means.

    The report does not include configured service URLs, media-service API keys, branding text or image contents.

## Feature usage counts

This category shares counts of Seerr requests and qualifying home-row removal events, plus totals of stored entries. It sends counts rather than titles, review contents or user records.

Select **Feature usage counts** before saving to include this category.

Current totals cover:

- Bookmarks across user files.
- Hidden-content entries, including home-row suppression entries.
- Direct Spoiler Guard series, movie and collection entries; pending protection intents are excluded.
- Reviews in the shared review store.

These totals count entries. The same title can contribute entries for several users, so the totals do not count unique titles or users.

??? info "How it works"

    Action counters record:

    | Counter | Meaning |
    | --- | --- |
    | `seerr.request_submitted` | Submitted Seerr requests recorded by the client. |
    | `continue_watching.auto_removed` | Playback-start events that clear or demote qualifying home-row removals while the Remove Continue Watching feature is enabled. Counts events, not individual entries removed. |

    Actions count only while reporting **and** the usage-count category are enabled. JE does not reconstruct earlier activity. Each off-to-on reporting transition clears counters at the point you enable reporting.

    Every successful report advances the counting period and subtracts the captured counter snapshot. This also happens when **Feature usage counts** is unchecked and those earlier counts were omitted from the report. Increments during transmission carry forward. Failed attempts do not subtract the captured counts.

## Data file sizes

This category shares the total size of your custom branding directory, without file names or contents. It does not include other plugin data-file sizes.

Select **Data file sizes (bytes only, never contents)** before saving to include this category.

??? info "How it works"

    The report uses the key `custom_branding`. It sends the total bytes in the branding directory, or zero if the directory is absent, empty or unreadable.
