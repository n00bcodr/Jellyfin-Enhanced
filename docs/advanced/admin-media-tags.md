# Admin Media Tags page

The Media Tags settings page (`Configuration/mediaTagsPage.html`, `#/configurationpage?name=JellyfinEnhancedMediaTags`) holds every server-wide poster tag setting. It is built from small section modules so that a new setting is a one-line declaration. This page is for contributors; administrators should read [Tags & badges](../enhanced/tags.md).

## How it fits together

- `JellyfinEnhanced.GetPages()` registers the page as a second `PluginPageInfo` with `EnableInMainMenu = false`. The main configuration page's **Media Tags** card, the personal panel's **Server** tab and the docs link to it.
- `mediaTagsPage.html` is a shell. It waits for the JE client bundle (already running on dashboard pages: `JE.t`, `core/tag-layout.js`, the panel's preview), loads `js/enhanced/admintags/admin-tags.css` and `admin-tags.js`, and calls `JE.adminTags.mount(page)`. `admin-tags.js` loads the files in `SECTION_FILES` once per document.
- Only the shown page element is live: Jellyfin keeps earlier views in the document, so opening the page again tears down the previous one (after saving) and builds the new one, keeping control ids unique.
- Every control writes one `PluginConfiguration` field into the page's working copy and saves after a 400 ms pause through `POST /JellyfinEnhanced/admin/configuration`. The server writes only the changed fields on top of the configuration it holds at that moment, inside the same critical section as every configuration save, so another administrator's changes to other fields are kept, including a main-page save that lands while the patch waits, and so are the server's own writes (a maintenance window ending clears its toggle, the translation refresh task sets its signal, analytics records its state), which take the same lock. Each field carries the value the page read before it was edited; if someone else changed that field meanwhile, the server refuses it and the page shows **Changed elsewhere** with **Keep mine** and **Take theirs**. Unsaved edits live in a store shared by every view of the page, so a failed save survives moving between tabs and links. The store belongs to the signed-in administrator on this server: an identity change (`JE.session.onUserChange`, and a check of the `ApiClient` user and server before every save and view) empties it and the live view, and requests started before it are ignored when they answer. Every answer (a save, the settings for a first view or a returning one, the preview's Tag Styles) is checked against the session it was asked in, with the `ApiClient` identity read again first, so a server switch that `JE.session` has not reported yet is caught there too; when someone is signed in by then, the page loads again for them. The main configuration page still saves its own form as a whole.
- The preview column is `internal.createTagPreview` from `settingspanel/ui-panel-tag-preview.js` with a `source` option: it draws a new user's document seeded from the configuration (`JE.adminTags.seedUser`, mirroring `LoadUserSettingsDocument`) and restores the signed-in user's settings afterwards.
- Deep links: `&tab=<id>` opens a tab, `&group=<id>` a Groups panel (or a section marked `data-je-anchor`). Old `&jeSection=` links to the main page's Media Tags controls are redirected to the matching tab.

## Add a section

1. Create `js/enhanced/admintags/sections/<name>.js` (no hyphens in directory names; file names may have them) as a self-contained IIFE:

    ```js
    (function(JE) {
        'use strict';
        const A = JE.adminTags;
        if (!A) return;
        A.registerSection({
            id: 'group-awards',
            tab: 'groups',            // overview, layout, groups, rules, colours, badges, server
            order: 55,                // position within the tab
            title: 'admin_tags_awards_title',
            hint: 'admin_tags_awards_desc',
            group: { id: 'awards', summary: (ctx) => '…', sample: () => [['status', 'Oscar']] }, // Groups tab rows only
            fields: [
                { id: 'awardsTagsEnabled', key: 'AwardsTagsEnabled', type: 'enable', label: 'admin_tags_awards_enabled' },
                { id: 'awardsTagsRefreshHours', key: 'AwardsTagsRefreshHours', type: 'number', min: 1, max: 168, fallback: 24, label: 'admin_tags_awardsTagsRefreshHours' },
            ],
            render(ctx, body) { /* optional custom controls into body */ },
            refresh(ctx, body) { /* optional: redraw after any change */ },
        });
    })(window.JellyfinEnhanced);
    ```

2. Add the file to `SECTION_FILES` in `admin-tags.js` (a frontend test checks the list matches the directory).
3. Add the strings to `js/locales/en.json` only.

## Field declarations

Keep each field on **one line** starting `{ id: '…', key: '…', type: '…'` with a `label: '…'`: `scripts/generate_config_flag_groups.py` and `Services/WhatsNewService.cs` read them lexically, and a frontend test enforces the shape.

| Property | Meaning |
|---|---|
| `id` | The control's DOM id. When a control moves here from `configPage.html`, keep its old id so What's New and the analytics map keep tracking it; a new id appears in What's New as a new setting, listed under **Media Tags** with a link to the section's tab (and group). |
| `key` | The `PluginConfiguration` property it reads and writes (PascalCase). |
| `type` | `switch`, `select`, `number`, `text`, `textarea`, `pills`, `ordered` (a checkbox in a reorderable list; `orderKey`, `defaultOrder`), `enable` (a Groups row switch) or `custom` (drawn by the section's `render`, declared only for tracking). |
| `label`, `desc` | `en.json` keys. |
| `options` | `[[value, labelKey]]` for `select` and `pills`; a label starting `=` is shown as written. |
| `min`, `max`, `fallback`, `unit` | Numbers are clamped and fall back when empty. |
| `secret` | A `text` field drawn as a password input (`autocomplete="new-password"`), for a key the server keeps private (public configuration, logs and exports never carry it). |
| `read(raw, config)`, `write(value, config)` | Convert between the stored value and the control. |
| `onChange(value, config)` | Return more fields to write at the same time. |
| `when(config)`, `visible(config)` | Disable or hide the control unless true. |
| `place: 'section'` | The section draws the control itself with `A.fieldHtml(f, config)`; the page still binds it. |
| `break: true` | Start a new box before this field. |

A section whose own editors write fields that are not declared as above (the layout editor's profiles, order and caps; the Tag Styles document and preset; excluded library ids; the clear-cache signal) names them on one line: `writes: ['TagLayouts', 'TagGroupOrder', 'TagGroupCaps'],`.

These declarations are the page's whole field list. `JE.adminTags.pageFields()` collects them and the page refuses to save anything else; `Helpers/MediaTagsPageFields.cs` reads the same declarations from the embedded modules, and `POST /JellyfinEnhanced/admin/configuration` answers `400` for any other field, so API keys (except the Leaving soon section's own Maintainerr key, a `secret` field) and the rest of the configuration stay with the main page. The server also checks each value against the field's contract (`MediaTagsPageFields.TryNormalize`, built on the normalisers the server already uses for these fields), so a value the page's controls cannot produce is refused with the reason; give a new field a case there when it has a range or a set of values. A set of values goes through `OneOf`, which also requires the canonical value to be in the set: several normalisers answer an empty string for a value they do not know, so without that check an empty value would pass. `tests/fixtures/admin-tags-page-fields.json` is the expected list; a frontend and a backend test compare both sides with it, so a new field means a declaration and a line there.

## Porting a control from the main configuration page

1. Declare the field in the section that owns it, with the old id, and add its key to `tests/fixtures/admin-tags-page-fields.json`.
2. Delete its markup, load/save lines, `PARENT_DEPS` entry and any helper from `configPage.html`. `buildConfigFromForm` starts from the saved configuration, so a field the main page no longer touches keeps its value.
3. Run `python3 scripts/generate_config_flag_groups.py` and `python3 tests/inventory/generate.py`; commit the regenerated files.
4. Add the field's behaviour to `tests/frontend/features/features-admin-tags-page.test.mjs` (the first test exercises every declared field automatically).

## Integrated Tier 2 controls

The old main form contains only the Media Tags summary card. Its legacy section links redirect to the dedicated page. Every moved field keeps its control id and is covered by the independent binding map derived from the form at `058f982b`.

| Section | Ported fields and validation |
|---|---|
| Layout defaults | `TagScale` (smaller/default/larger/largest), `TagGap` (tight/default/roomy), `TagEdgeSpacing` (default/tight/flush), using `TagLayoutRules` |
| Groups → Awards | `AwardsTagsEnabled`, `AwardsTagsPosition`, the five ribbon switches, `AwardsTagsImdbList`, `AwardsTagsLetterboxdList` (numeric id or owner/slug via `AwardTagsService.IsListId`) and `AwardsTagsRefreshHours` (1–168) |
| Groups → Logos | `LogoTagsEnabled`, `LogoTagsPosition`, `LogoTagsMovieMode` (provider/studio/off), `LogoTagsSeriesMode` (network/provider/off), `LogoTagsRegion` (empty follows server, otherwise a valid two-letter code) and `LogoTagsMaxLogos` (1–2), using `LogoTagRules` and `WatchProvidersBatch` |
| Groups → Custom | `CustomTagsEnabled`, `CustomTagsPosition`, `CustomTagRules`: the existing Match/Value/Label/Icon table, existing tag/collection suggestions, 20 rows, reserved-label hints and `CustomTagRuleSet` validation. Incomplete local rows are kept in the editor; complete valid rows auto-save. `CustomTagRuleKey` and `CustomTagRuleSources` are never declared or patchable. |
| Colours | Integrated Poster preset and its worst-case contrast badge, plus Awards/Logos/Custom targets; custom label targets follow table edits |
| Groups → Language | The pre-existing priority string, strict policy and regional merging fields remain here. Personal priority arrays and native date context remain user settings. |
| Status badges | Existing family switches and day windows, plus the TMDB dependency note; no user-only date-context field is added to the patch allowlist. |
| Status badges → families (Tier 3) | `StatusTagsLeaving`, `StatusTagsDirectPlay` (switches, starting values for new users) |
| Status badges → Leaving soon (Tier 3) | `LeavingSoonMaintainerrUrl` (empty or `LeavingSoonService.IsMaintainerrUrl`), `LeavingSoonMaintainerrApiKey` (`secret: true`, a password field; printable ASCII), `LeavingSoonCollections` (`LeavingSoonService.IsCollectionList`: at most 20 names of at most 200 characters), `LeavingSoonRefreshHours` (1–168). The section loads `GET admin/leaving-soon` for its state line and its **Refresh now** button saves pending edits, then calls `POST admin/leaving-soon/refresh`. These are new fields, not ports: no `configPage.html` control or binding existed. |

All nine poster groups share the layout editor and preview. Page-wide Tag Styles, including Poster variables, skip scoped previews. The page seeds size/gap/edge and new-group defaults without changing the signed-in user's document. Cache schema was 18 at Tier 2 integration; Tier 3 Leaving soon adds `Leaving` (see `CurrentCacheSchemaVersion`). Resolver, renderer and pixel versions are unchanged.
