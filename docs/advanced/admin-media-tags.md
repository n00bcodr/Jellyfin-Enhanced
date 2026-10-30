# Admin Media Tags page

The Media Tags settings page (`Configuration/mediaTagsPage.html`, `#/configurationpage?name=JellyfinEnhancedMediaTags`) holds every server-wide poster tag setting. It is built from small section modules so that a new setting is a one-line declaration. This page is for contributors; administrators should read [Tags & badges](../enhanced/tags.md).

## How it fits together

- `JellyfinEnhanced.GetPages()` registers the page as a second `PluginPageInfo` with `EnableInMainMenu = false`. The main configuration page's **Media Tags** card, the personal panel's **Server** tab and the docs link to it.
- `mediaTagsPage.html` is a shell. It waits for the JE client bundle (already running on dashboard pages: `JE.t`, `core/tag-layout.js`, the panel's preview), loads `js/enhanced/admintags/admin-tags.css` and `admin-tags.js`, and calls `JE.adminTags.mount(page)`. `admin-tags.js` loads the files in `SECTION_FILES` once per document.
- Only the shown page element is live: Jellyfin keeps earlier views in the document, so opening the page again tears down the previous one (after saving) and builds the new one, keeping control ids unique.
- Every control writes one `PluginConfiguration` field into the page's working copy and saves after a 400 ms pause through `POST /JellyfinEnhanced/admin/configuration`. The server writes only the changed fields on top of the configuration it holds at that moment, inside the same critical section as every configuration save, so another administrator's changes to other fields are kept, including a main-page save that lands while the patch waits. Each field carries the value the page read before it was edited; if someone else changed that field meanwhile, the server refuses it and the page shows **Changed elsewhere** with **Keep mine** and **Take theirs**. Unsaved edits live in a store shared by every view of the page, so a failed save survives moving between tabs and links. The main configuration page still saves its own form as a whole.
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
                { id: 'awardsTagsMinYear', key: 'AwardsTagsMinYear', type: 'number', min: 1900, max: 2100, fallback: 1990, label: 'admin_tags_awards_min_year', desc: 'admin_tags_awards_min_year_desc' },
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
| `read(raw, config)`, `write(value, config)` | Convert between the stored value and the control. |
| `onChange(value, config)` | Return more fields to write at the same time. |
| `when(config)`, `visible(config)` | Disable or hide the control unless true. |
| `place: 'section'` | The section draws the control itself with `A.fieldHtml(f, config)`; the page still binds it. |
| `break: true` | Start a new box before this field. |

A section whose own editors write fields that are not declared as above (the layout editor's profiles, order and caps; the Tag Styles document and preset; excluded library ids; the clear-cache signal) names them on one line: `writes: ['TagLayouts', 'TagGroupOrder', 'TagGroupCaps'],`.

These declarations are the page's whole field list. `JE.adminTags.pageFields()` collects them and the page refuses to save anything else; `Helpers/MediaTagsPageFields.cs` reads the same declarations from the embedded modules, and `POST /JellyfinEnhanced/admin/configuration` answers `400` for any other field, so API keys and the rest of the configuration stay with the main page. `tests/fixtures/admin-tags-page-fields.json` is the expected list; a frontend and a backend test compare both sides with it, so a new field means a declaration and a line there.

## Porting a control from the main configuration page

1. Declare the field in the section that owns it, with the old id, and add its key to `tests/fixtures/admin-tags-page-fields.json`.
2. Delete its markup, load/save lines, `PARENT_DEPS` entry and any helper from `configPage.html`. `buildConfigFromForm` starts from the saved configuration, so a field the main page no longer touches keeps its value.
3. Run `python3 scripts/generate_config_flag_groups.py` and `python3 tests/inventory/generate.py`; commit the regenerated files.
4. Add the field's behaviour to `tests/frontend/features/features-admin-tags-page.test.mjs` (the first test exercises every declared field automatically).
