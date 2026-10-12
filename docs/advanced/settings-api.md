# Settings API (experimental)

Other Jellyfin clients (Moonfin, Streamyfin, a custom app) can read and change a user's [Jellyfin Enhanced panel](../enhanced/enhanced-settings.md) settings over plain HTTP, and see which values come from the server default, which the user chose, and which an administrator has locked. Administrators can also read the policy and run **Apply defaults to users** from a script.

!!! warning "Experimental"

    These routes are not versioned and their shapes may still change. Check `Capabilities` in the [bootstrap](#check-what-the-server-supports) before using them, and fall back to the [whole-document save](#whole-document-save-older-clients) when they are missing.

Every path below is under `/JellyfinEnhanced`. Authenticate exactly as for the rest of the [Jellyfin Enhanced API](api.md): send `Authorization: MediaBrowser Token="..."` with a user's access token or an administrator's API key (on Jellyfin 12 the `X-Emby-*` headers are rejected by default).

## Who can call what

| Routes | Allowed callers |
|---|---|
| `user-settings/{userId}/…` | The user themselves, or an administrator for any user. `{userId}` is accepted with or without dashes. Anyone else gets `403`; a malformed id gets `400` |
| `admin/user-settings/…`, `reset-all-users-settings` | Administrators only (`403` otherwise) |
| All of them | A signed-in caller (`401` without a token) |

A value an administrator sets for another user is recorded as **Set by your administrator · you can change it** in that user's panel, not as the user's own choice.

## Check what the server supports

`GET /JellyfinEnhanced/bootstrap` returns everything the web client needs at start for the signed-in user. The settings-related fields:

```json
{
  "Capabilities": ["settingsPatch", "settingsRevision"],
  "UserSettings": {
    "Settings": { "AutoPauseEnabled": true, "...": "...", "IsAdmin": false },
    "SettingsMeta": { "Schema": 2, "Revision": "3b1d8e8bc15e", "...": "..." },
    "SettingsStatus": "ok"
  }
}
```

- `settingsPatch`: the [patch route](#change-settings) and `Meta` are available.
- `settingsRevision`: the [revision route](#check-for-changes) is available.
- A server without `Capabilities` only has the whole-document save.
- `SettingsStatus` is `unavailable` (and `Settings` is null) when the stored settings could not be read. Show them read-only and retry later; never save defaults over them.

## Read settings

`GET user-settings/{userId}/settings.json`

Returns the values the user actually gets (locks applied, followed defaults resolved), plus `IsAdmin` for the caller. This shape has not changed, so older clients keep working. The first read for a user without settings creates them from the administrator's defaults. When the stored file cannot be read the answer is `503` with `{ "success": false, "status": "unavailable", "message": "…" }`.

Add `?meta=true` to get `{ "Settings": { … }, "Meta": { … } }`. `Meta` describes each setting:

| Field | Meaning |
|---|---|
| `Schema` | Always `2` for now |
| `Revision` | First 12 hex digits of the SHA-256 of the stored file. Changes whenever the stored file changes; a save that changes nothing keeps it |
| `ConfigEpoch` | Changes whenever an administrator saves the plugin settings (and on server start) |
| `Following` | Keys that use the server default and change when the administrator changes it |
| `Chosen` | Keys the user set themselves |
| `ChangedByAdmin` | `Chosen` keys an administrator set for the user |
| `Locked` | Keys the administrator locked. The value served is the administrator's, and writes are rejected |
| `Saved` | For each locked key, the user's own stored value, which comes back when the key is unlocked |
| `Defaults` | The server default of every key that has one |
| `Differs` | Keys that are not following or locked and would show something else if they followed the server default: the value differs, or, for the subtitle style (`SelectedStylePresetIndex`), the saved colours are not that style's colours and custom colours are off |
| `Reach` | Keys that reach further than the web client: `Both` also changes poster images in native apps (only while **Native Poster Tags** is on, `Web` otherwise), `Server` is applied by the server itself |
| `Unavailable` | Key → the administrator switch that is off, so the setting currently does nothing |

A key in neither `Following` nor `Chosen` holds a value saved before these states existed. It is kept exactly as it is.

```json
{
  "Settings": { "AutoPauseEnabled": false, "LongPress2xEnabled": false, "...": "...", "IsAdmin": false },
  "Meta": {
    "Schema": 2, "Revision": "3b1d8e8bc15e", "ConfigEpoch": "1d229d27",
    "Following": ["AutoPipEnabled"], "Chosen": ["AutoPauseEnabled", "LongPress2xEnabled"], "ChangedByAdmin": [],
    "Locked": ["LongPress2xEnabled"], "Saved": { "LongPress2xEnabled": true },
    "Defaults": { "AutoPauseEnabled": true, "AutoPipEnabled": false, "...": "..." },
    "Differs": ["AutoPauseEnabled"],
    "Reach": { "QualityTagsEnabled": "Web", "UseNativePosterTags": "Server", "...": "..." },
    "Unavailable": { "UseNativePosterTags": "NativePosterTagsEnabled" }
  }
}
```

The signed-in `GET public-config` also carries `UserSettingDefaults`: the server defaults of the on/off, number and fixed-choice settings, by `settings.json` key. Free-form text settings such as the display language and the preferred audio language are left out, and so is a default outside a setting's fixed choices. Clients that need every default read `Meta.Defaults` from `GET settings.json?meta=true`. Anonymous callers do not get it.

## Change settings

`POST user-settings/{userId}/settings.json/patch`

```json
{ "Set": { "AutoPipEnabled": true }, "Follow": ["WatchProgressMode"], "IfRevision": "3b1d8e8bc15e" }
```

All three fields are optional and their names are matched ignoring case. Only the keys you send change.

- **`Set`**: key → value. The value is converted to the setting's type (`"true"` and `"5"` are accepted) and checked against its range, allowed values or pattern (strings are at most 64 characters). It becomes the user's choice. One exception: setting `WatchProgressMode` or `ReviewsExpandedByDefault` to the current server default makes it follow the default again, because the web client writes those two while browsing.
- **`Follow`**: keys that should use the server default from now on. Only keys that have a server default can follow.
- A key in both ends up following.
- **`IfRevision`**: apply only if the stored `Revision` still matches. Without it, each key is last-writer-wins.

The answer is `200` even when some keys are refused:

```json
{
  "success": true,
  "Revision": "a41b07c9e210",
  "Applied": ["AutoPipEnabled", "WatchProgressMode"],
  "Rejected": [{ "Key": "LongPress2xEnabled", "Reason": "locked" }],
  "Settings": { "...": "the values in effect" },
  "Meta": { "...": "as above" }
}
```

| `Reason` | Why |
|---|---|
| `unknown` | Not a per-user setting |
| `invalid` | The value fails the setting's rules, or `Follow` names a key without a server default |
| `locked` | The administrator locked it |

Other answers: `409` when `IfRevision` is stale (with the current `Revision`, `Settings` and `Meta`; nothing changed), `400` for a malformed body (not an object, `Set` not an object, `Follow` not an array of strings, `IfRevision` not a string; a `null` for any of them counts as malformed, so `"IfRevision": null` is refused, not taken as "no check"), `413` for a body over 64 KB, `503` when the stored file cannot be read.

=== "cURL"

    ``` bash title="Bash"
    curl -X POST \
      -H 'Content-Type: application/json' \
      -H 'Authorization: MediaBrowser Token="JELLYFIN_TOKEN"' \
      -d '{"Set": {"AutoPipEnabled": true}, "Follow": ["WatchProgressMode"]}' \
      'JELLYFIN_SERVER_URL/JellyfinEnhanced/user-settings/JELLYFIN_USER_ID/settings.json/patch'
    ```

## Check for changes

`GET user-settings/{userId}/revision` returns about 50 bytes:

```json
{ "Settings": "3b1d8e8bc15e", "Config": "1d229d27" }
```

`Settings` is the file's `Revision` (empty when the user has no settings yet) and `Config` is the `ConfigEpoch`. When either differs from what you last saw, read the settings (or the bootstrap) again. Nothing is created or changed by this call. The web client asks when a tab becomes visible or gets focus, at most once a minute, and never polls.

## Whole-document save (older clients)

`POST user-settings/{userId}/settings.json` with a settings object. Kept so that older clients and cached pages keep working; new clients should use the patch route.

- Only setting keys present in the body count (matched ignoring case). Absent keys stay as they are. `IsAdmin` and unknown keys are ignored.
- A value equal to the current one changes nothing, so posting back what you read is harmless.
- Refused keys are listed in `Rejected`: `locked`; `following` (a following key only changes through the patch route, so an old page cannot pin today's default); `stale` (a value a lock on the key enforced since the server started, posted after the administrator unlocked it by a page loaded while it was locked, so the user's own choice survives; such a value can then only be chosen through the patch route until the server restarts); `invalid`.
- Any other value is stored as the user's choice.

The answer is `{ "success": true, "file": "settings.json", "Rejected": [ … ] }`. `400` for a body that is not an object, `413` over 64 KB, `503` when the stored file cannot be read.

## Admin routes

Locks are part of the plugin configuration: `LockedUserSettings` is an array of setting keys, saved like every other plugin setting (**Save** on the plugin page, or Jellyfin's own `POST /Plugins/{pluginId}/Configuration`). A locked key is served as the administrator's value everywhere (including native poster images) and refused on every write. Each user's own value is kept for when it is unlocked. `NewUsersFollowDefaults` (boolean) makes new users follow the defaults.

### Registry

`GET admin/user-settings/registry` lists every per-user setting that has a server default. It reads no user files.

```json
[
  { "Key": "AutoPipEnabled", "AdminKey": "AutoPipEnabled", "AdminValue": false, "Reach": "Web", "EffectiveReach": "Web", "Lockable": true, "Locked": false, "ControlId": "autoPipEnabled" },
  { "Key": "ResolutionTagOrder", "AdminKey": "ResolutionTagOrder", "AdminValue": 1, "Reach": "Both", "EffectiveReach": "Web", "Lockable": true, "Locked": false, "RowKey": "ResolutionTagOrder" }
]
```

`ControlId` or `RowKey` points at the setting's control on the plugin page. A setting without one (`PauseScreenDelaySeconds`) is not lockable.

### Overview

`GET admin/user-settings/overview` reads every user's `settings.json` without changing, moving or repairing anything, and skips files over 256 KB.

| Field | Content |
|---|---|
| `ConfigEpoch` | The configuration the counts were taken with |
| `Users` | `Total`, `WithSettings`, `WithoutSettings` (users who have not used Jellyfin Enhanced yet), `Orphans` (settings folders with no Jellyfin user), `LiveListed`, `DirectoriesListed` |
| `Adoptable` | `Users` and `Keys` that **Follow my defaults where nothing changes today** would adopt |
| `Settings` | Per key: `Following`, `Kept` (a copy of the default), `Changed` (something else), and the split of the rest into `Existing`, `ExistingSameAsDefault` and `Chosen` |
| `Corrupt`, `Oversized`, `Unavailable` | Users (`Id`, `Name`) whose file could not be read. They are not counted |
| `UserList` | `Id`, `Name`, `Live`, `Orphan`, `Settings`: `settings`, `none`, `corrupt`, `oversized` or `unavailable` |

`GET admin/user-settings/overview/{key}` lists one setting across users: `Key`, `Default`, `Locked` and `Users`. Each user has `UserId`, `Name`, `Live`, `Orphan`, `Value` (the stored value; for a following user, the current default they get), `State` (`Following`, `Existing`, `Chosen`, `ChangedByAdmin`, `NoSettings`, `Corrupt`, `Oversized` or `Unavailable`), `SameAsDefault`, and `Invalid: true` when a stored text value breaks the setting's rules (its value is then left out). `404` for a key without a server default.

### Apply defaults to users

`POST admin/user-settings/apply`

```json
{ "Keys": ["AutoPipEnabled", "WatchProgressMode"], "UserIds": null, "Mode": "FollowIfUnchanged", "DryRun": true }
```

| Field | Meaning |
|---|---|
| `Keys` | Required. Setting keys; in the two follow modes each must have a server default (`400` otherwise) |
| `UserIds` | `null` or absent for everyone (Jellyfin users and existing settings folders), or up to 10,000 ids. Ids that are neither are skipped as `unknown` and never created |
| `Mode` | Required. `FollowIfUnchanged`: a setting starts following the default only where it is still an untouched copy of it, so nobody sees a change (the subtitle style also needs the colours of that style, or custom colours, since a followed style shows its own colours). `FollowAll`: every selected setting follows, so values change for users who picked something else. `Overwrite`: the old reset; writes your current values (users stop following) and also resets the selected users' hidden-content settings and Spoiler Guard preferences. Hidden items, spoiler lists and bookmarks are never touched |
| `DryRun` | Default `true`: a preview that changes nothing on disk |
| `ConfigEpoch` | Required for a real run: the `ConfigEpoch` the preview returned. `409` if the plugin settings were saved since |

The answer is the same for a preview and a real run: `DryRun`, `ConfigEpoch`, `Mode`, `Keys`, `Users`, `Updated`, `Unchanged`, `KeysChanged`, `VisibleChanges`, `KeptChoices` (users who keep their own value for some settings), `Skipped` (`Id`, `Name`, `Reason`: `unknown`, `no-settings`, `corrupt` or `oversized`; their `settings.json` is left untouched; in `Overwrite` mode the hidden-content settings and Spoiler Guard preferences of a skipped user who has a settings folder are still reset, reported in `PerUser.Documents` or `Failed`), `Failed` (`Id`, `Name`, `Document`: `Settings`, `HiddenContent` or `SpoilerGuard`, `Reason`), `PerKey` (`Changed`, `Visible`, `Kept`), `PerUser` (`Changed`, `Visible`, `Kept`, `Documents`) and, for a run that changed something, `UndoId`. `UndoUnavailable: true` means the changes were made but the undo record could not be saved. `413` for a body over 64 KB.

=== "cURL"

    ``` bash title="Bash"
    # 1. Preview, and note the ConfigEpoch in the answer
    curl -X POST -H 'Content-Type: application/json' -H 'Authorization: MediaBrowser Token="ADMIN_API_KEY"' \
      -d '{"Keys": ["AutoPipEnabled"], "Mode": "FollowIfUnchanged"}' \
      'JELLYFIN_SERVER_URL/JellyfinEnhanced/admin/user-settings/apply'
    # 2. Apply what was previewed
    curl -X POST -H 'Content-Type: application/json' -H 'Authorization: MediaBrowser Token="ADMIN_API_KEY"' \
      -d '{"Keys": ["AutoPipEnabled"], "Mode": "FollowIfUnchanged", "DryRun": false, "ConfigEpoch": "CONFIG_EPOCH"}' \
      'JELLYFIN_SERVER_URL/JellyfinEnhanced/admin/user-settings/apply'
    ```

### Undo

`POST admin/user-settings/undo/{undoId}` undoes a run of the apply route or of `reset-all-users-settings`. Each setting, and each replaced hidden-content or Spoiler Guard section, is restored only if it still holds what the run wrote; anything changed since is kept and reported. The answer has `Restored` and `Kept` (counts), `FailedUsers`, `Pending` (some files could not be read or written; send the same undo again to retry them) and `PerUser` (`Id`, `Name`, `Restored`, `Kept`, `Failed`). `400` for a malformed id, `404` for an unknown one (the last 20 runs are kept), `409` when it was already undone.

### Upgrade card

`GET admin/user-settings/upgrade-card` answers `{ "Dismissed": false, "Adoptable": { "Users": 2, "Keys": 105 } }`, or `{ "Dismissed": true }` once an administrator dismissed it with `POST admin/user-settings/upgrade-card/dismiss`. The count is cached until a settings file or the plugin settings are saved, or 10 minutes pass.

### Reset all users

`POST reset-all-users-settings` is the older reset, kept for scripts: the same as `apply` with `Overwrite` for every setting and every user folder, without a preview. Its answer is described in the [endpoint index](api.md#misc); it now also reports each user's outcome and returns an `UndoId`.
