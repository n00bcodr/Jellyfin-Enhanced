# Settings panel slice

Status: strict TypeScript replacement of the user settings panel (the "settings-panel" group in
`artifacts/rewrite-next-wave-scopes.json`). It does not establish whole-rewrite completion,
real-host parity or release readiness.

## Scope and outputs

`client/entries/settings-panel.json` maps the group's 15 production files to TypeScript entries
under `client/src/features/settings-panel/`. Output paths, file names and the server load order in
`js/component-scripts.json` are unchanged; each entry is the bundle for its legacy module.

| Output (`js/…`) | Entry |
| --- | --- |
| `enhanced/ui-styles.js` | `ui-styles.ts` (`JE.injectGlobalStyles`) |
| `enhanced/settingspanel/ui-entry-points.js` | `ui-entry-points.ts` (sidebar, OSD, avatar-menu and preferences links; `isVideoPage`/`isDetailsPage`) |
| `…/ui-release-notes.js` | `ui-release-notes.ts` |
| `…/ui-panel-template.js` | `ui-panel-template.ts` |
| `…/ui-panel-shortcut-editor.js` | `ui-panel-shortcut-editor.ts` |
| `…/ui-panel-settings.js` | `ui-panel-settings.ts` |
| `…/ui-panel-tag-editor.js` | `ui-panel-tag-editor.ts` |
| `…/ui-panel-hidden-content.js` | `ui-panel-hidden-content.ts` |
| `…/ui-panel-language.js` | `ui-panel-language.ts` |
| `…/ui-panel-tag-looks.js` | `ui-panel-tag-looks.ts` |
| `…/ui-panel-tag-preview.js` | `ui-panel-tag-preview.ts` |
| `…/ui-panel-tag-portable.js` | `ui-panel-tag-portable.ts` |
| `…/ui-panel-media-tags.js` | `ui-panel-media-tags.ts` |
| `…/ui-panel-resize.js` | `ui-panel-resize.ts` |
| `…/ui-panel.js` | `ui-panel.ts` (`JE.showEnhancedPanel`, the dialog host) |

## Structure

- `client/src/features/settings-panel/host.ts` is the only adapter to globals. `PanelBridge` lists the
  facade members the panel reads or provides; every module narrows it with `Pick` to what it uses.
  Server and configuration values stay JSON-typed or `unknown` until a reader narrows them. The
  layout, look, media-language, rating and poster-colour services are typed with the tag-rules
  slice's own exported types (`Pick<TagLayout, …>` etc.); legacy tag modules (awards, logos, genre,
  custom, scopes, renderer) have narrow interfaces for exactly the calls the previews make.
- `registry.ts` types `JE.internals.enhancedUi`, the registry the split modules share and that the
  admin Media Tags page (`admin-tags.js`, `admintags/sections/layout.js`, `…/portable.js`),
  `tags/tag-item-editor.js` and `configPage.html` read. Every member they use is kept:
  `createTagPreview`, `bindTagPreviewInteraction`, `tagPreviewData`, `tagGroupEditorData`,
  `tagPortable` (dialogs, preview list, file and clipboard helpers), `mediaTagsHub`, etc.
- `context.ts` is the dialog contract (`ctx`): focus/inert boundary, `onClose` teardowns,
  `registerSearch`, `openPane`, theme colours. Sections still call optional members through `?.`
  so partial mounts (admin page, tests) keep working.
- Pure, DOM-free rules: `panel-size.ts` (stored size parsing, clamping), `release-markdown.ts`
  (escaped markdown, release decoding), `language-options.ts` (locale/culture decoding and
  labels), `shortcut-rules.ts` (reserved player keys, conflicts, plugin defaults decoding),
  `tag-caps.ts`, `panel-refresh.ts`, `subtitle-format.ts`, `settings-values.ts` (JSON readers that
  reproduce the legacy coercions), `portable-model.ts` (import/export/preset answers).
- `dom.ts` narrows elements by runtime checks; no type assertions are used anywhere in the slice
  (only `as const` literals), and there is no `any` or suppression comment.

## Behaviour kept

Every pane, control id, data attribute, class and template string is the same, so the settings
wiring, the hub, the admin page, the browser guards and the translation checks see the same markup:
shortcuts (rebind, conflict shake, reserved player keys, Delete/Backspace), playback, auto-skip,
subtitles (presets, colours, position grid, warnings), random button (types, scope, playlists),
UI, Media Tags hub (layout, shapes, groups editor, badges, rules and locks, colours, server
pointers, presets, import/export with Undo), Hidden Content, Spoiler Guard's injected section,
language, about, release notes; keyboard shortcuts (Escape and `?`, Tab trapped, roving tabs and
position pickers, grip arrows); per-user panel size with presets, drag and keyboard resize; the
lazy preview (built on first intersection, disposed on close); the settings search; the phone
layer layout. Translations are read through `JE.t`; missing new recovery text uses an English fallback. Inheritance metadata of the loaded settings object is never cloned: controls call
`setSettingInherited`/`isSettingInherited` on `JE.currentSettings`, and an import writes nulls
through the inheritance API so a save never pins an inherited administrator default.

## Fixed defects

| ID | Classification | Defect | Evidence |
| --- | --- | --- | --- |
| SETTINGS-PANEL-01 | introduced (rewrite branch CAS integration) | Opening the panel replaced `userConfig.settings` from the unrevisioned `GET settings.json` but kept the old `settingsRevision`, so after another tab or device saved, the panel showed the new document and every panel save was refused as a conflict ("Reload before trying again"). The refresh also applied unvalidated content. | The panel now reads `GET settings-document`, validates it with the generated contract (`window.__JE_BOOTSTRAP_CONTRACT__.parseSettingsDocument`, caller authority from the host's user policy), and replaces content and revision together only when the server's revision differs from the one at request time and no local save advanced it meanwhile. `tests/frontend/features/settings-panel/settings-panel-rewrite.test.mjs` (SETTINGS-PANEL-01 cases, fail on the legacy file), `tests/browser/settings-panel-rewrite.spec.cjs`. |
| SETTINGS-PANEL-02 | baseline | Each panel open added four document listeners (subtitle grid `mousemove`/`mouseup`/`touchmove`/`touchend`) that were never removed, keeping every closed panel's DOM alive and running handlers on every page-wide pointer move. | Listeners are released through `ctx.onClose`; a drag held at close is saved once. Frontend SETTINGS-PANEL-02 cases; browser journey (post-close drag changes nothing). |
| SETTINGS-PANEL-03 | baseline | A stored subtitle size/font index the presets lack (e.g. 99, -1) made every style/size/font/effect preset click throw before saving (`JE.fontSizePresets[i].size` of undefined), while the template showed Normal. | Preset clicks fall back to Normal / the first font like the template. Frontend SETTINGS-PANEL-03 cases. |
| SETTINGS-PANEL-04 | baseline | Rebinding or disabling a shortcut the plugin defaults do not list stored an override without `Name` (`{ Key }`), which the editor and key listener can never match again. | Overrides always carry the action name. Frontend shortcut case. |
| SETTINGS-PANEL-05 | baseline (hardening) | The release-notes link interpolated the GitHub API's `html_url` into `href` after HTML escaping only, so a non-http(s) URL (e.g. `javascript:`) would be clickable. | Only http(s) links are kept; otherwise the repository's latest-release page. Frontend release-notes case. |

## Intentional protocol and fixture changes

- The panel's opening refresh moved from `GET user-settings/{id}/settings.json` to
  `GET …/settings-document` (SETTINGS-PANEL-01). `tests/frontend/bootstrap/bootstrap-panel-resize.test.mjs`
  ("opening settings response is published only to its original identity") now loads the contract
  bundle and resolves a contract-valid `RevisionedSettingsResponse`; its assertions are unchanged.
- `tests/frontend/features/media-tags/features-media-tags-docs-links.test.mjs` reads the hub's tab list from the
  TypeScript source (the generated bundle is reformatted by esbuild); its regular expressions and
  assertions are unchanged.
- `tests/frontend/features/media-tags/features-media-tags-strings.test.mjs` scans only `.js` files (the new
  source maps embed TypeScript type syntax) and accepts either quote in the fixed parts of three
  patterns (esbuild writes double quotes). On the generated files the check matches as many sinks
  as on the legacy files (12) and finds nothing.

## Validation

Recorded under `artifacts/rewrite-settings-panel/` with file hashes. Focused regressions (every
frontend test that loads or reads these files, plus bootstrap/manifest suites), the full frontend
suite, the panel-related browser specs (Chromium, Firefox, mobile Chromium) and the new frontend
and browser tests were run against the generated bundles.

## Known limitations

- The real-host (Jellyfin 12 server) journey, visual review and the combined gate are not part of
  this slice's evidence.
- Policy recovery uses the authenticated `/Users/Me` route when neither the host's current-user
  method nor a validated loaded document supplies authority. If policy or the initial document
  cannot be obtained, opening stops with a retry message; it does not open an unsavable panel.
- Revisions are opaque: a refreshed document replaces the loaded one whenever its revision differs
  from the one seen at request time, which assumes the store returns its current revision (it does;
  `?_=` defeats HTTP caches).
- The legacy `/settings.json` GET and POST routes stay as compatibility endpoints owned by the
  settings slice; this slice no longer uses them.

## Review remediation

The opening refresh also coordinates with the shared writer's per-document pending count and
mutation version (`getSettingsSaveState`). It keeps the loaded object during queued or in-flight
saves, and rejects adoption if the object, its contents or save generation changed during the
GET. This preserves inheritance metadata and prevents a later panel save from erasing a
successful queued edit. Revisions remain opaque; no timestamp ordering is inferred.

Opening subscribes to navigation before the GET. Navigation, page hide or a second toggle
cancels that opening and releases its subscription immediately, even if the request remains
pending. Identity checks include client instance, server root, account, token and session epoch.

Language choices render as soon as bundled locales arrive. Culture names and GitHub discovery
enrich them independently, preserving the selected value and ignoring disposed or stale-account
responses. A language save requests explicit failure propagation and rolls back on rejection.
An acknowledged write may reconcile its same-account preference after the panel closes; only
a still-visible originating panel may show the success toast or reload. Account changes discard
old completions. Optional GitHub work and reload timers are disposed with the panel.

Permanent adversarial checks are in `tests/frontend/features/settings-panel/settings-panel-boundaries.test.mjs`.
Root remediation evidence, before-source controls, fixture differences, and validation limits are
under `artifacts/reviews/parent-remediation/settings-panel-r1/`. Independent re-review remains
required before closing the new findings.

### Save and lookup ownership follow-up

Identical settings saves are skipped only for the same loaded object, account, origin configuration and acknowledged revision. A refreshed revision or document requires a new guarded write; a missing revision fails before deduplication. Failure reconciliation can finish for a closed panel's document, while notifications use a separate view predicate and recheck identity after asynchronous callbacks.

Locked-item title batches capture the originating client, user, server, token and session epoch. Every batch and response checks that origin plus the panel lifetime. Closing or disconnecting the panel stops remaining batches; old responses never populate the title map. A live panel retains successful title caching.
