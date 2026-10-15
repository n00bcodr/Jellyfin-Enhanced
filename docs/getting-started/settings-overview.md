# Settings overview

Use the admin configuration page for server features, service connections, and starting preferences. Use the personal Enhanced panel for your account's preferences and shortcut overrides.

## The admin configuration page

The admin page controls server features, service connections, and starting preferences for users. Use its tabs to set up the parts of JE you want.

1. Sign in as an administrator and open **Dashboard → Plugins → Jellyfin Enhanced**. On Jellyfin 12, plugin navigation can take you directly to the configuration page. On 10.11, open the installed plugin's configuration.
2. Use **Search settings...** or the section shortcuts within a tab to find a control. Use **Descriptions** to show or hide explanatory text.
3. Check the unsaved indicator, then click **Save Settings**.
4. Refresh affected web clients.

![Enhanced administrator Overview tab](../images/admin/overview.webp)

| Tab | What you'll find | Detailed guide |
| --- | --- | --- |
| **Overview** | **Service Status**, **Optional Dependencies**, **Features**, and **Quick Actions** for connection tests, overwriting personal settings, and clearing client tag caches | [Defaults and resets](#admin-defaults-and-personal-overrides), [compatibility](compatibility.md) |
| **Display** | Watch progress, file information, poster/detail tags and their styles, native poster tags, Spoiler Guard, icons/theme, random-button defaults, language, awards, and MDBList ratings | [Enhanced settings](../enhanced/enhanced-settings.md), [Tags & badges](../enhanced/tags.md), [Spoiler Guard settings](../spoiler-guard/spoiler-guard-settings.md) |
| **Playback** | Tab-switch playback behavior, pause screen, long-press speed, automatic intro/outro skipping, subtitle defaults, and panel/toast timing | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **Pages** | Enablement, content options, and placement for Bookmarks, Hidden Content, Requests, Calendar, Recommendations, Activity, and Catch Up | [JE pages & tabs](pages-and-tabs.md) |
| **Seerr** | Connection and shared TMDB key, URL mappings, search/discovery, automatic requests, recently-added scan, watchlist sync, user import/blocking, permission audit, and response-cache diagnostics | [Seerr settings](../seerr/seerr-settings.md), [permission audit](../seerr/permission-audit.md) |
| **\*arr** | Sonarr/Radarr instances, one URL-only Bazarr endpoint, Shoko Calendar source, browser URL mappings, item links for administrators, and tag synchronization | [*arr settings](../arr/arr-settings.md) |
| **Elsewhere** | Streaming providers, regions, shared TMDB key, provider branding, TMDB reviews, release dates, and user reviews | [Elsewhere settings](../elsewhere/elsewhere-settings.md) |
| **Extras** | UI tweaks, header shortcuts, active streams, plugin icons, Letterboxd links, and **Custom Image Assets** | [Other settings](../other/other-settings.md) |
| **Keyboard** | **Disable Keyboard Shortcuts** and the server's shortcut bindings; click a key to edit it | [Enhanced features](../enhanced/enhanced-features.md#playback-controls) and [personal shortcut controls](#admin-defaults-and-personal-overrides) |
| **Admin** | Optional usage statistics, maintenance mode, tag-cache operations, and **Dev Mode** | [Other settings](../other/other-settings.md), [Community Analytics](../advanced/community-analytics.md), [Tags & badges](../enhanced/tags.md) |
| **Docs** | **Documentation** embedded from the hosted site, with **Open in new tab** | [Quick start](index.md) |

Select a tab to see it on the admin page.

=== "Display"

    ![Display tab and its settings groups](../images/admin/display.webp)

=== "Playback"

    ![Playback administrator settings](../images/admin/playback.webp)

=== "Pages"

    ![Pages tab with page integration controls](../images/admin/pages.webp)

=== "Extras"

    ![Extras tab with UI Tweaks and External Links settings](../images/admin/extras.webp)

=== "Keyboard"

    ![Keyboard configuration with global and player bindings](../images/admin/keyboard.webp)

=== "Admin"

    ![Admin tab with maintenance and diagnostic groups](../images/admin/admin.webp)

In **Overview**, the What's New notice links to the settings groups that contain controls added since the last dismissal. Use the release-notes link for the full changelog.

![Administrator What's New notice with links to settings groups](../images/other/whats-new.webp)

??? info "Admin page details"

    The page uses the same route on both versions: `/web/index.html#/configurationpage?name=Jellyfin%20Enhanced`. Include your Jellyfin base-URL prefix if configured.

    Tabs scroll when they don't fit. Search, section jumps, and links in the What's New notice don't save changes. API fields are masked when unfocused and revealed while editing.

    The **Docs** tab loads the hosted documentation when you first select it. It isn't an offline copy bundled with the plugin; your browser needs access to the hosted site. JE retains the loaded page across tab switches. If it doesn't receive a load event within eight seconds, it replaces the frame with a message and external link. **Open in new tab** is available independently.

## The personal Enhanced panel

You can change your own preferences without administrator access. Open the panel using whichever entry fits your layout:

| Where | How to open it |
| --- | --- |
| Desktop keyboard | Press ++"?"++ outside an input or textarea. |
| Visible desktop or phone drawer | Select **Jellyfin Enhanced → Enhanced Panel**. Jellyfin 12's Modern Layout exposes these drawer links on mobile. |
| Jellyfin 12 Modern Layout avatar menu | Select **Jellyfin Enhanced**. |
| Jellyfin user settings menu, including on phones | Select **Jellyfin Enhanced - User Settings**. |
| Mobile or TV web player | Select the tune button titled **Jellyfin Enhanced** beside the player's settings button when those controls are available; desktop layouts hide it. |

1. Use **Search settings…** to filter the section list by the text inside each pane, or select a section from the navigator. On desktop, the sections and selected pane sit side by side.

    ![Enhanced panel search filters the section list with Subtitle Settings open](../images/getting-started/panel-search.webp)

2. On a phone, select a section to open its pane. Use the back arrow to return to the navigator.

    ![Phone Enhanced panel section list](../images/getting-started/panel-phone.webp)

    <figure class="je-video">
      <video autoplay loop muted playsinline controls preload="metadata" aria-label="Phone settings navigation uses sections and a back arrow">
        <source src="../../images/getting-started/panel-phone-navigation.mp4" type="video/mp4">
      </video>
      <figcaption>Open Jellyfin Enhanced from the avatar menu, then use the back arrow between sections.</figcaption>
    </figure>

3. Change a preference using its control. Personal changes save as you make them; there is no admin-style **Save Settings** button here.

![Enhanced user panel with section navigation and search](../images/getting-started/panel-desktop.webp)

| Section | What you can change | Detailed guide |
| --- | --- | --- |
| **Shortcuts** | View bindings, record a personal key combination, disable a binding, or restore the admin binding | [Enhanced features](../enhanced/enhanced-features.md#playback-controls) |
| **Playback Settings** | Auto-pause, auto-resume, picture-in-picture, long-press speed, and pause screen | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **Auto-Skip Settings** | Personal intro/outro skipping preferences | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **Subtitle Settings** | **Disable Custom Styles**, style/color, size, font, text effect, and position | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **Random Button Settings** | Enablement, unwatched-only selection, item types, and random source | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **UI Settings** | Watch progress, file size, tag categories/order/positions, native poster preference, and other display choices | [Enhanced settings](../enhanced/enhanced-settings.md), [Tags & badges](../enhanced/tags.md) |
| **Hidden Content** | Personal hide controls and surface filters, plus access to the hidden list; present when the server feature is enabled | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **Spoiler Guard** | Personal overrides for admin-enabled categories and **Don't ask me to confirm when turning Spoiler Guard off**; present only when admin **Enable Spoiler Guard** is on | [Spoiler Guard settings](../spoiler-guard/spoiler-guard-settings.md#per-user-overrides) |
| **Language Settings** | **Display Language** and **Clear Translation Cache** | [Enhanced settings](../enhanced/enhanced-settings.md) |
| **About** | Version, release notes, and the repository contribution link | [About](../about.md) |

Open **About** to check your JE version or select **Release Notes** or **Contribute**.

![Enhanced About pane with version and release note links](../images/enhanced/panel-about.webp)

!!! note "Some sections need an enabled feature"

    Controls and sections depend on enabled features. **Disable Keyboard Shortcuts** hides **Shortcuts** and stops ordinary JE shortcut handling. Auto-skip needs supported segments and playback; see [compatibility](compatibility.md#companion-plugins).

??? note "Panel shortcut and device refresh"

    The panel-opening ++"?"++ listener remains available even when ordinary shortcuts are disabled. Saved shortcut overrides don't change it.

    Opening the panel fetches fresh `settings.json`. For a full update of scripts, feature availability, and other user documents on another device, refresh that client.

## Admin defaults and personal overrides

JE saves your starting preferences the first time your account loads JE. Changing admin defaults later doesn't replace those saved preferences, even if you never customize anything. To push new defaults to existing users, use [Apply defaults to existing users](#apply-defaults-to-existing-users).

To set starting preferences for accounts that haven't loaded JE yet, change them on the admin page and click **Save Settings**. To customize your own account, use the personal Enhanced panel.

!!! note "Server features control availability"

    A personal preference can't enable a page or integration that's disabled on the server. If a child control is disabled, turn on or configure its required parent switch, key, or companion plugin first.

| Setting | Default | What it does |
| --- | --- | --- |
| Admin **Default UI Language** | **System Default** | Starting language for a new personal settings document; doesn't force existing users to change language. |
| Personal **Display Language** | Starting value from **Default UI Language**; **Auto** on a fresh server | Overrides JE's display language for your account; changing it saves and reloads. |
| Admin **Disable Keyboard Shortcuts** | Off | Disables ordinary shortcut handling and hides the personal shortcut pane. |
| Personal **Disable Custom Styles** | Starting value from admin **Disable Custom Subtitle Styles by default** (Off on a fresh server) | Uses Jellyfin's default subtitle styles for your account. |

??? info "How starting values are chosen"

    JE creates a missing `settings.json` using current admin defaults. **Hide Tags on Hover** is the exception: it starts Off regardless of the admin value. Settings without admin defaults use built-in defaults.

    Client fallbacks fill in missing values. An ordinary **Save Settings** updates the server configuration. **Default UI Language → System Default** stores an empty value.

### Apply defaults to existing users

Use this action when you want existing users to start over with the current defaults. It replaces saved personal preferences.

!!! warning "Back up before overwriting preferences"

    There is no per-user undo. Restore a backup or have users reapply their choices.

1. Open **Overview → Quick Actions → Overwrite everyone's personal settings**.
2. Confirm the action to save the current form and reset existing users' preferences.
3. Have users refresh their clients.

??? note "What the overwrite action changes"

    | Data | Effect of the overwrite action |
    | --- | --- |
    | `settings.json` | Replaced with current admin defaults, except **Hide Tags on Hover** resets to Off, and watch progress mode/time format reset to **Percentage** / **h:m** regardless of **Watch Progress Default** / **Watch Progress Time Format**. Personal subtitle colors/position and random source selections reset to built-in defaults; audio language and native poster preferences return to inheriting server settings. Internal panel/Calendar view state also resets. |
    | `hidden-content.json` | Personal filter settings reset; hidden items retained. |
    | Existing `spoilerblur.json` | Preference overrides reset to inherit admin policy; protection lists retained. A missing file isn't created just for this reset. |
    | `shortcuts.json` | Personal shortcut overrides retained. |
    | Bookmarks, Elsewhere settings, shared reviews/activity | Not reset by this action. |

    Before resetting preferences, the action synchronizes managed Custom Tabs entries. It resets users with existing canonical JE user directories. A Jellyfin user without a JE directory receives the defaults when JE first creates their settings instead. If an individual reset fails, check the server log. The endpoint reports skipped settings/Hidden Content users; Spoiler Guard preference failures are logged separately. The admin success dialog isn't a per-file audit.

    **Clear all client tag caches** and **Clear Translation Cache** clear caches, not personal preferences.

### Reset a shortcut

You can change a shortcut for your account or return to the administrator's binding.

1. Open **Shortcuts** and click a displayed key.
2. While it is listening, press your new combination. Press ++backspace++ to remove your override and restore the current administrator binding, or ++delete++ to disable the shortcut for your account.

??? note "Shortcut rules and admin bindings"

    Conflicting combinations and reserved browser-player bindings are rejected. These edits save to `shortcuts.json`.

    In admin **Keyboard**, the same keys edit server bindings: ++backspace++ restores the plugin's built-in binding, and ++delete++ disables the server binding. Users with saved personal overrides can still have their own bindings. The personal panel doesn't offer a single button to reset every preference.

## Settings and data on disk

Your server stores JE's configuration and personal data in Jellyfin's configured directories. These paths vary by installation, so don't assume one Docker mount or operating-system path.

Use the file reference below to locate the data you want to back up. Follow [Backup and restore](#backup-and-restore) for the copying steps.

!!! note "Storage must be writable"

    JE needs writable configuration/data and log storage.

??? info "File locations and storage details"

    The admin XML is `<PluginConfigurationsPath>/Jellyfin.Plugin.JellyfinEnhanced.xml` (Jellyfin's `ConfigurationFilePath` for this plugin). The user/shared data root is:

    ```text
    <PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/
    ```

    User directories use the Jellyfin user ID in lowercase with hyphens removed, for example a 32-character GUID, rather than the username.

    | Location | Contents |
    | --- | --- |
    | `<user-id>/settings.json` | Main personal Enhanced preferences, including panel and Calendar view state. |
    | `<user-id>/shortcuts.json` | Personal shortcut overrides. |
    | `<user-id>/bookmark.json` | Saved video bookmarks. |
    | `<user-id>/elsewhere.json` | Personal Elsewhere preferences. |
    | `<user-id>/hidden-content.json` | Hidden items and personal filters. |
    | `<user-id>/spoilerblur.json` | Spoiler Guard lists and preference overrides. |
    | `<user-id>/processed-watchlist-items.json` | Watchlist-monitor processing state. |
    | `reviews.json` | Shared user reviews. |
    | `activity.json` | Shared watched/favorite activity records. |
    | `catchup-log.jsonl`, `catchup-log.1.jsonl` | Catch Up activity log and one rotated copy, when recording is enabled. Rotation occurs after the current file exceeds 5 MiB. |
    | `native-poster-tags.key` | Internal 32-byte secret signing personalized poster URLs. Preserve it for URL-signing continuity. |
    | `cdn-cache/` | Downloaded asset cache; regenerable when upstream assets are reachable. |

    Custom branding uses `<directory containing the plugin XML>/<plugin XML filename without .xml>/custom_branding/`. With the normal XML filename, that is `<PluginConfigurationsPath>/Jellyfin.Plugin.JellyfinEnhanced/custom_branding/`. This is derived from `ConfigurationFilePath`; don't assume it is always the same physical root as the user documents.

    Some browser state remains local, including theme selection, caches, and UI state. A server backup doesn't copy that browser storage. If the poster signing key is missing or has the wrong length, JE recreates it; previously issued personalized URLs can return original artwork until clients refresh. If the key can't be persisted, JE logs a warning and uses a key lasting only for that server process.

## Upgrade migration

At startup, JE updates old uppercase or hyphenated user-directory names to lowercase names without hyphens. Keep its recovery files if you're investigating preferences that changed after an upgrade.

!!! note "Downgrading doesn't restore data"

    Installing a different plugin build doesn't automatically restore an earlier version of your data.

??? info "How migration handles existing files"

    JE skips already canonical names and unrelated directories.

    - If the canonical directory is absent, JE renames the old directory.
    - In the code's case-only rename branch, it renames through `<directory>.case-rename-<suffix>` before assigning the canonical name.
    - When it merges distinct directories, it chooses files individually by modification time; the canonical copy wins a tie. It doesn't merge settings fields or bookmark records within those files.
    - A canonical file replaced by a newer source is preserved as `<file>.pre-case-merge-<suffix>`. After a successful directory merge, the source is preserved as `<directory>.migrated-<suffix>`.

    Stored JSON fields with `null` are skipped during deserialization so model defaults can fill those fields without discarding the rest of the document.

## Backup and restore

A file backup lets you restore preferences and saved data after a move or a reset. JE has no general settings backup/export/import interface or bookmark export/import UI.

1. Stop Jellyfin for a consistent copy.
2. Back up the admin XML and the entire user/shared data root listed above. Include every user directory, shared files, the poster signing key, and any migration recovery files you want to keep.
3. Back up the derived `custom_branding` directory if it is outside that root. The `cdn-cache` directory can be regenerated.
4. If you use Plugin Pages or Custom Tabs, preserve their configuration as part of your Jellyfin backup too. Their entries live outside JE's XML.

To restore:

1. While Jellyfin is stopped, copy the files to the equivalent configured paths. Retain write access for the Jellyfin service account.
2. Install the build matching the restored server, then start Jellyfin.
3. Refresh your clients.

!!! note "Include accounts when moving the server"

    User documents follow Jellyfin user IDs. Restoring JE data alone doesn't recreate accounts or give a new account its old ID. Include Jellyfin's own account/server backup when moving the whole installation.

**Overwrite everyone's personal settings** resets preferences; it doesn't restore a backup.

## Account deletion and retained data

Deleting a Jellyfin user leaves that user's JE directory and shared records in place. Uninstalling JE also leaves user data behind.

For intentional cleanup, back up first. Account for the personal directory and shared stores separately; removing one personal directory doesn't remove shared records.

??? note "What deletion and uninstall do"

    JE's deletion handlers invalidate identity, tag-access, and review-author caches. They don't purge personal documents or the user's shared reviews, activity, or Catch Up log records. Hiding an unresolved review author doesn't erase that author's data.

    JE's uninstall hook removes legacy script injection; it doesn't implement a user-data purge.
