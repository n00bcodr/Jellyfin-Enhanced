# Media Tags admin tab slice

Status: strict TypeScript replacement of the configuration page's Media Tags tab (the "admin-tags"
group in `artifacts/rewrite-final-frontend-wave-scopes.json`). It does not establish whole-rewrite
completion, real-host parity or release readiness.

## Scope and outputs

`client/entries/admin-tags.json` maps the group's 20 production files to TypeScript entries under
`client/src/features/media-tags/admin/` (formerly `client/src/features/admin-tags/`). Output paths and file names are unchanged. They are not in
`js/component-scripts.json`: the configuration page loads `admin-tags.js`, and `mountTab` loads the
other 19 lazily, one after another, in `SECTION_FILES` order (two editors, then the sections).

| Output (`js/enhanced/admintags/…`) | Entry |
| --- | --- |
| `admin-tags.js` | `admin-tags.ts` (the `JE.adminTags` facade; `page.ts`, `save-store.ts`, `mount.ts`, `fields.ts`) |
| `tag-styles-editor.js` | `tag-styles-editor.ts` (`EDITOR_HTML`, `createTagStylesEditor`, `tagStyleContrast`) |
| `custom-rules-editor.js` | `custom-rules-editor.ts` (`CUSTOM_HTML`, `createCustomTagRules`) |
| `sections/<name>.js` (17) | `sections/<name>.ts` |

## Structure

- `client/src/features/media-tags/admin/host.ts` is the only adapter to globals: the JE facade members the tab
  reads (narrowed with `Pick` from the tag-rules, tag-runtime and settings-panel slices' exported
  types: `TagLayout`, `TagLook`, `TagScopes`, `TagStyles`, `RatingSources`, `PosterColours`,
  `ItemEditorOptions`, `EnhancedUi`), Jellyfin's `ApiClient` and `Dashboard`, and the page's
  `jeCdnUrl`. Everything is read when used, as the legacy scripts read their globals.
- `types.ts` is the contract between the core, the section modules and the configuration page:
  `FieldDef`, `SectionDef`, `PageContext` and the facade (`AdminTagsCore` plus the members the
  editors and sections publish). Each section module is its own script, so they share state only
  through the facade (`installSection` runs a module only once the core installed it).
- `values.ts` holds the configuration as JSON (`Config`). `configOf` validates every configuration
  document at the boundary (the initial read, reloads, the import preview's re-read, a save's
  `values`, a 409's `conflicts`); a malformed answer is never taken for the stored settings.
- `save-store.ts` is the document-wide store of edits not on the server yet: the field patch
  (`Changes` + `Expected`), conflicts (Keep mine / Take theirs), failed saves and Retry, the
  server-wide item look intents (`TagLookItemOverrides` per-entry Set/Remove/Expected), the
  configuration page's own Save (`holdSaves`), and session ownership (server, administrator, client, credential and root continuity) that
  drops another session's late answers. Whole-document actions are queued before their initial flush; each rechecks ownership before running. An old session's queue does not block new-session actions. Successful field saves must acknowledge every submitted field. Conflict maps may only name fields from that request; malformed acknowledgements preserve edits for explicit recovery.
- Pure helpers: `format.ts` (the page's English text and word tables), `fields.ts` (field values and
  markup), `custom-rules-model.ts`, `tag-style-contrast.ts`, `tag-styles-model.ts` (the catalog
  decoder).

## Text the server reads from the section modules

`Shared/MediaTags/MediaTagsPageFields.cs` (the field patch's allowlist), `Features/Admin/Services/WhatsNewService.cs` and
`scripts/generate_config_flag_groups.py` read the section modules as text: one-line
`{ id: '…', key: '…', … label: '…' }` declarations, `writes: […]`, `tab:`, `group: { id:` and
`title:` lines. Bundled output prints double quotes and its own layout, which those patterns no
longer match: the allowlist would be empty and every save refused. Each section entry therefore
starts with a `/*! Lexical index … */` comment (esbuild keeps `/*!` comments verbatim) holding those
lines in the baseline module's order. It was extracted from the baseline JavaScript, not written by
hand, and `tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs` holds it to two oracles:

- the three readers (ported verbatim in `tests/frontend/helpers/admin-tags-declarations.mjs`) read
  exactly what they read from the baseline modules (`admin-tags-rewrite.declarations.json`: 123
  allowlist fields, 104 setting ids, their tab locations and docs labels);
- the index names exactly the sections, fields, titles, groups and writes the module registers.

A changed declaration must change both the code and the index; the tests say which. A typed
declaration manifest the server reads instead would remove the duplication (parent integration
item, not done here: it changes C#).

## Behaviour fixed

See `artifacts/rewrite-admin-tags/bugs.json` for triggers, evidence and status.

- ADMIN-TAGS-01: the Leaving soon state chip was always `warn` (its keys had become English text but
  the state still tested `_ok`/`_off` suffixes). Up to date is `on`, No source set `off`.
- ADMIN-TAGS-02: the "Where to show" change listener on the kept tab root had no page lifetime, so
  each rebuilt view added another.
- ADMIN-TAGS-03: a configuration answer that was not an object (null, an array) or a rejection
  without a reason built a page over an empty configuration; a malformed reload threw over the live
  page. Both now show the load error, or keep the page.
- ADMIN-TAGS-04: a 409 whose `conflicts` was not an object re-sent the same patch without end.

## Validation

Focused suite (the files listed in `artifacts/rewrite-admin-tags/focused-tests.txt`, which load the
generated scripts) plus the new `admin-tags-rewrite.test.mjs`. Source-reading tests that read the
hand-written files now read the TypeScript (`features-awards-tags`, `features-media-tags-docs-links`)
or the facade (`features-tag-styles-editor`'s contrast helpers); `features-admin-tags-page-server`'s
one-line declaration check reads each module's lexical index.

Not exercised: a real Jellyfin 12 host and browser, the C# readers themselves against the generated
files (proved through the ported patterns), and visual layout.

## Review remediation evidence

The permanent admin-tags-review tests cover malformed success/409 responses, identity replacement, overlapping held actions and queue recovery. The parent fixed four independently reproduced classes, preserving valid partial conflicts and field-level Retry. Real configuration-page, backend-reader and host checks remain integration gates. Evidence and before controls: artifacts/reviews/parent-remediation/admin-tags-r1/.

The holdSaves callback receives a HeldSaveScope with isCurrent() and throwIfStale(). The scope expires on session replacement or callback completion. Asynchronous callers must check it after confirmation/read awaits and before each mutation or notification; a pre-start check cannot cancel a callback that has already started. Configuration-page integration of this scope is tracked as ATB-R2-001 and remains open until the callers and their generated journeys are independently verified.
