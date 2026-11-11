# Contributing to Jellyfin Enhanced

Thank you for your interest in contributing to Jellyfin Enhanced! This document provides guidelines and information to help you get started.

## 🤝 Ways to Contribute

### 1. Code Contributions

You can contribute code through:
- **Open Pull Requests**: Check the [open PRs](https://github.com/n00bcodr/Jellyfin-Enhanced/pulls) for issues that need help
- **Discussions**: Browse [Discussions](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions) for feature requests and ideas that interest you
- **Bug Fixes**: Fix any bugs you encounter and submit a PR

> [!NOTE]
> Feature requests that are considered niche use cases are often moved to Discussions. Feel free to implement any of these if they interest you!

### 2. Translation Contributions

Help make Jellyfin Enhanced accessible to more users by contributing translations through Weblate:

- https://hosted.weblate.org/projects/jellyfinenhanced/

See the [Contributing Translations](https://n00bcodr.github.io/Jellyfin-Enhanced/faq-support/contributing-translations/) section for details.


## 🚀 Getting Started

This rewrite supports Jellyfin 12.x on .NET 10 only. `-p:JellyfinTarget=jf12` remains accepted for tooling compatibility; `jf10`, other targets, and non-.NET 10 builds fail explicitly. Older and future major hosts are unsupported.


### Project Structure

Before contributing, familiarize yourself with the project structure. See the [Project Structure](https://n00bcodr.github.io/Jellyfin-Enhanced/advanced/project-structure/) documentation page for a detailed breakdown of the codebase and what each file does.

Key directories (the [Where things live](#where-things-live) table below maps each feature to its folders):
- `client/src/` - TypeScript source of every shipped browser script: `features/<feature>/` (one folder per feature), `admin/config/` (the configuration page), and the platform folders `bootstrap/`, `core/`, `host/`, `pages/` and `contracts/` (generated transport types)
- `client/entries/` - Manifests mapping each shipped output under `Jellyfin.Plugin.JellyfinEnhanced/js/` to its source (see [its README](client/entries/README.md))
- `Jellyfin.Plugin.JellyfinEnhanced/js/` - Build output of `npm run client:build` (`.js` and `.js.map`; do not edit), plus `component-scripts.json` (bundle load order), `locales/` (translation files) and `fonts/`
- `Jellyfin.Plugin.JellyfinEnhanced/Features/<Feature>/` - One backend folder per feature: `Je<Feature>Controller.cs` (+ partials), `Services/`, `Models/`, `Events/`, `Tasks/`, `PublicApi/`
- `Jellyfin.Plugin.JellyfinEnhanced/Shared/`, `Infrastructure/`, `Transport/`, `Configuration/` - Code several features use, host plumbing, wire records and plugin configuration
- `tests/frontend/`, `tests/backend/`, `tests/browser/` - Node, .NET and Playwright suites; `tests/frontend/architecture/` and `tests/backend/Architecture/` hold the structure guardrails

Adding a client module:

1. Write the TypeScript under `client/src/features/<feature>/` (or the platform folder that owns it), **following the naming already used in that folder**. A feature reaches another feature only through that feature's `public-api.ts` or its `FeatureContext` (`tests/frontend/architecture/` enforces this).
2. To ship it as its own script, add a mapping to the owning manifest in `client/entries/` (output path under `js/` → source). Output directories must not contain hyphens: embedded-resource names are derived from the path, and a hyphen in a *directory* segment becomes an underscore, which makes the module unreachable at runtime. A module imported by an existing entry needs no mapping; it is bundled into that entry.
3. Register a new output in `js/component-scripts.json` **after** every module whose exports it reads at load time; scripts execute in manifest order. Entries starting with `//` are ordering notes and are skipped. The server concatenates the manifest into `/JellyfinEnhanced/bundle.js`, which plugin.js loads in production (individual files in dev mode and as a fallback). Never rename an existing output key or reorder existing entries: moving a source edits only the right-hand side of its manifest mapping.
4. Run `npm run client:build` and commit the source, the manifest, the generated `.js` and `.js.map` files and `client/generated-manifest.json` together. `npm run client:check` (also run by the plugin build) fails on stale output.
5. No `.csproj` change is needed (`js\**` is embedded by a glob), but the plugin must be rebuilt and redeployed for a new file to be served.
6. `js/fonts/` holds two copies of each Material Symbols face. JE's own icons use the `*-subset.woff2` files, which contain only the icons the client uses and are declared under the private family names `'JE Material Symbols Rounded'` / `'JE Material Symbols Outlined'` — always use those names in JE rules, and give JE's icon elements the matching private classes `je-msym-rounded` / `je-msym-outlined`, never Google's `material-symbols-rounded` / `material-symbols-outlined`, which themes and other plugins style for their own icons. The full fonts stay under the public names (`'Material Symbols Rounded'` / `'Material Symbols Outlined'`) only for themes, plugins and custom CSS that rely on JE providing them (`js/enhanced/ui-styles.js`, built from `client/src/features/settings-panel/ui-styles.ts`, also points Google's classes at them through a zero-specificity `:where()` fallback); a subset under a public name would shadow a theme's own declaration and break its icons. To use a new Material Symbols icon, add its name to `ICONS` in `scripts/material-symbols/subset.py`, re-run the script and commit the regenerated subsets — otherwise the icon renders as its name in plain text. The script also fails if JE code uses the `material-symbols-*` classes.

### Where things live

Client code is TypeScript under `client/src/`. `npm run client:build` type-checks it with tsc-rs and bundles it into the shipped scripts under `Jellyfin.Plugin.JellyfinEnhanced/js/`, using the manifests in `client/entries/` (see [its README](client/entries/README.md)). The backend has one folder per feature under `Jellyfin.Plugin.JellyfinEnhanced/Features/`. `Shared/` and `Infrastructure/` beside it are layers that several features use, not features. Each `client/src/features/<feature>/README.md` lists that feature's entry points, public API and tests.

The canonical list is [`docs/feature-map.json`](docs/feature-map.json). `tests/frontend/architecture/feature-map.test.mjs` keeps this table equal to it, so change the map first and copy the rows it prints.

| Feature | Client (`client/src/`) | Backend (`Jellyfin.Plugin.JellyfinEnhanced/Features/`) | Tests |
|---|---|---|---|
| `activity` | `features/activity/` | `Activity/` | `tests/frontend/pages/`, `tests/backend/Features/Activity/` |
| `bookmarks` | `features/bookmarks/` | `Bookmarks/` | `tests/frontend/features/bookmarks/`, `tests/backend/Features/Bookmarks/` |
| `calendar` | `features/calendar/` | `Calendar/` | `tests/frontend/pages/`, `tests/backend/Features/Calendar/` |
| `catchup` | `features/catchup/` | `Catchup/` | `tests/frontend/pages/` |
| `chrome` | `features/chrome/` | `Chrome/` | `tests/frontend/chrome/`, `tests/backend/Features/Chrome/` |
| `details-providers` | `features/details-providers/` | `DetailsProviders/` | `tests/frontend/features/details-providers/`, `tests/backend/Features/DetailsProviders/` |
| `downloads` | `features/downloads/` | `Downloads/` | `tests/frontend/features/downloads/`, `tests/backend/Features/Downloads/` |
| `hidden-content` | `features/hidden-content/` | `HiddenContent/` | `tests/frontend/features/hidden-content/`, `tests/backend/Features/HiddenContent/` |
| `media-tags` | `features/media-tags/` | `MediaTags/` | `tests/frontend/features/media-tags/`, `tests/backend/Features/MediaTags/` |
| `player` | `features/player/` | none | `tests/frontend/features/player/` |
| `seerr` | `features/seerr/` | `Seerr/` | `tests/frontend/requests/`, `tests/frontend/pages/`, `tests/backend/Features/Seerr/` |
| `settings` | `features/settings/` | `Settings/` | `tests/frontend/bootstrap/`, `tests/backend/Features/Settings/` |
| `settings-panel` | `features/settings-panel/` | none (served by `Settings/`) | `tests/frontend/features/settings-panel/` |
| `spoiler-guard` | `features/spoiler-guard/` | `SpoilerGuard/` | `tests/frontend/features/spoiler-guard/`, `tests/backend/Features/SpoilerGuard/` |
| `shared` | `features/shared/` | none (served by `Platform/`) | `tests/frontend/core/` |
| `admin` (area) | `admin/config/` | `Admin/` | `tests/frontend/admin/`, `tests/backend/Features/Admin/` |
| `platform` (area) | `bootstrap/`, `core/`, `host/`, `pages/`, `features/shared/` | `Platform/` | `tests/frontend/bootstrap/`, `tests/frontend/core/`, `tests/frontend/pages/`, `tests/frontend/contracts/`, `tests/frontend/regressions/`, `tests/backend/Features/Platform/` |

On the backend, each feature folder has one controller, `Je<Feature>Controller`, which can be split into partials named `Je<Feature>Controller.<Area>.cs`. Controller files may have at most 1,200 lines, and other `Features/` and `Shared/` files at most 1,500. A file declares its folder's namespace: `…Features.<Feature>[.*]`, `…Shared.<Area>[.*]` or `…Infrastructure.<Area>[.*]`. Scheduled-task types are the exception and keep their legacy namespace. A feature uses another feature only through that feature's `PublicApi/` or an entry listed in `tests/backend/Architecture/feature-dependencies.json`. A helper that several features need goes to `Shared/<Area>/`. `dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Architecture` enforces all of this, together with this table's backend column; [`tests/backend/README.md`](tests/backend/README.md) explains each check.

## 📝 Code Contribution Guidelines

### Code Style

1. **Comments are Essential**

   - Use JSDoc comments for functions and classes
   - Add inline comments to explain complex logic
   - Document parameters, return values, and side effects

   Example:
   ```javascript
   /**
    * Creates a bookmark at the specified timestamp
    * @param {string} itemId - The Jellyfin item ID
    * @param {number} timestamp - The video timestamp in seconds
    * @param {string} label - User-provided label for the bookmark
    * @returns {Promise<Object>} The created bookmark object
    */
   async function createBookmark(itemId, timestamp, label) {
       // Validate timestamp is within video duration
       if (timestamp > videoDuration) {
           throw new Error('Timestamp exceeds video duration');
       }

       // Create bookmark object with metadata
       const bookmark = {
           id: generateId(),
           itemId,
           timestamp,
           label,
           createdAt: new Date().toISOString()
       };

       return await saveBookmark(bookmark);
   }
   ```

2. **Code Understanding**

   - Ensure you understand what your changes do
   - Be prepared to answer questions about your implementation
   - Test your changes thoroughly

3. **AI-Assisted Code (VibeCoded PRs)**

   - AI-assisted contributions are welcome! However:
     - You must understand what the code does
     - Be able to explain your implementation
     - Respond to code review comments
     - Clearly indicate in your PR description that AI tools were used

   Example PR description:
   ```markdown
   ## Description
   Adds feature X to improve Y

   ## Implementation Notes
   This PR was developed with AI assistance (Claude/GPT/etc.). I have reviewed
   and tested all changes and understand the implementation.

   ## Testing
   - [ ] Tested on Jellyfin 12.x
   - [ ] Verified no basic errors
   ```

### Robustness and security rules

Adapted from Jellyfin Canopy @17c80bc, GPL-3.0 (its `CONTRIBUTING.md` performance and security rules and its `src/test/*-guard.test.ts`). The guard tests in [`tests/frontend/guards/`](tests/frontend/guards/) read the TypeScript AST of `client/src` and run with `npm test`. Each guard is a ratchet: today's violations are recorded in `<guard>-baseline.json`, keyed by file, rule and enclosing function. A **new** violation, or a higher count, fails the test, and a lower count prints a note. After a fix, lower the baseline with `node tests/frontend/guards/record.mjs`. Never add an entry or raise a count. `node tests/frontend/guards/record.mjs --list` prints every recorded finding with its line.

| Rule | What it asks | Enforced by |
|---|---|---|
| **R1** | Injected UI is ready before paint or takes reserved space. No insert-then-move. | review |
| **R2** | Decorations on existing cards (tags, badges) are absolute overlays and never shift layout. | review |
| **R3** | No new body-wide `MutationObserver` (`document.body` with `subtree: true`). Use `JE.helpers.onBodyMutation`, navigation events or a page-scoped observer that is torn down. | `performance-rules-guard` (R3-body-observer) |
| **R4** | Layout reads are cached per navigation. There are none inside observer callbacks, and reads and writes never interleave in loops. | review |
| **R5** | No `setInterval` for DOM detection. Data polls are page-scoped and stop when the page goes away. | `performance-rules-guard` (R5-interval-dom) |
| **R6** | No remote assets at runtime. Scripts, styles, fonts and locales come from the plugin, not `http(s)://`. Content images and links the user clicks are exempt. | `performance-rules-guard` (R6-remote-asset) |
| **R7** | Feature DOM is built off-DOM and inserted once. Late data fades in instead of swapping layout. | review |
| **R8** | Synchronous work per mutation batch stays under about 2 ms. The rest moves to the async path. | review |
| **R9** | Fail open: late beats never. A failed fetch surfaces an error. It is never returned, cached or rendered as an empty answer ("no results"). Readiness waits persist until the anchor mounts or navigation aborts them, and retries are bounded. | `error-as-empty-guard` (R9-fail-empty, R9-fail-cached, R9-fail-renders-empty); `leak-guard` (L5-retry-uncapped) |
| **X1** | Every value interpolated into HTML is escaped with `JE.escapeHtml`/`esc`, coerced to a number, or a plugin-owned constant. This applies to `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and `JE.toast`, in both attribute and text positions. `JE.t()` does **not** escape its params. | `escape-guard` (X1) |
| **X2** | Every config- or user-derived value that enters CSS is validated: style attributes, `cssText`, `addCSS`/`injectCss`, `<style>` text and `insertRule`. `escapeHtml` does not neutralise a CSS payload. Use numbers, constants, `isCssColor(v) ? v : fallback` or `CSS.escape`. | `css-injection-guard` (X2) |

Two more guards come from Canopy's `leak-guard` and `ConfigControlCoverageTests`:

- `leak-guard`: long-lived `Map`/`Set`/array/object caches that only grow (L1). `window`/`document` listeners with no `signal`, `once` or removal (L2). Observers that are never disconnected or tracked (L3). Raw `setInterval`s that are never cleared (L4). Uncapped self-rescheduling retries (L5). Object URLs that are never revoked (L6).
- `config-control-guard` (C1): every settable `PluginConfiguration` property has a control on the admin configuration page.

### Pull Request Process

1. **Fork and Branch**
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/bug-description
   ```

2. **Make Your Changes**

   - Write clean, commented code
   - Follow existing code patterns
   - Test thoroughly

3. **Commit Messages**

   - Use clear, descriptive commit messages
   - Reference issues when applicable

   Example:
   ```
   feat: add bookmark sync across duplicate items

   - Implements automatic bookmark syncing based on TMDB/TVDB IDs
   - Adds UI option to manage sync preferences
   - Fixes #123
   ```

4. **Submit PR**

   - Provide a clear description of changes
   - Include screenshots/videos for UI changes as applicable
   - List any breaking changes
   - Mention if you used AI assistance

5. **Code Review**

   - Be responsive to feedback
   - Be prepared to make requested changes
   - If you want me to make any further changes, let me know

## ✅ CI Checks

Pull requests run automated backend regressions for the Jellyfin 12 target, JavaScript behavioral tests with coverage, and browser tests, alongside the static checks below. See [Regression testing](tests/README.md) for setup, commands, reports, and current coverage gaps.

| Check | What it does | Reproduce locally |
|---|---|---|
| **CodeQL Advanced** | Static analysis for both the C# backend and the JS frontend, looking for common security/correctness bug patterns | Not practical to run locally; check the PR's "Files changed" annotations if it flags something |
| **Dependency Review** | Flags newly-introduced dependencies with known vulnerabilities or incompatible licenses | Only relevant if your PR changes `.csproj` package references |
| **Security Scan** | Scans the diff for accidentally-committed secrets (API keys, tokens, credentials) with TruffleHog | `git diff` your changes yourself before pushing if you're unsure |
| **Translation Checks** | For any locale file you touched under `js/locales/`, verifies it has valid JSON and the same key set as `en.json` (no missing/extra keys) | Diff your changed locale file's keys against `js/locales/en.json` by hand, or just keep the two in sync as you edit |
| **NuGet lock files** | The backend regression jobs restore in locked mode from lock files (`packages.jf12.lock.json`) beside the plugin and test projects, so a changed package reference fails with NU1004 until they are regenerated. Dependabot can't update these files, so its NuGet PRs fail a dedicated check with this fix | For the sole `JellyfinTarget` (`jf12`), run `dotnet restore Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -p:JellyfinTarget=<target> --force-evaluate` and the same for `tests/backend/JE.Tests.csproj`, then commit the two lock files |
| **Production inventory** | Part of the regression workflow: fails when `tests/docs/production-inventory.json` no longer matches the plugin. Ordinary edits and translation updates don't change it. It does change when you add, remove or rename a production file, locale, HTTP route (or its method), configuration property, scheduled task (any class implementing `IScheduledTask`) or storage literal; when a route's following attributes such as `[Authorize]` change; when a configuration property's type, default value or constructor assignment changes; or when a build target's `TargetFramework` or `JellyfinVersion` changes. On a pull request it only warns when the base branch is already stale and the PR adds no drift of its own; after a push to `main` the workflow commits the regenerated file itself | Run `python3 tests/inventory/generate.py` and commit the regenerated file (`--check` only verifies it) |

Two more workflows exist but aren't part of the PR gate: **Check Unused Translation Keys** and **OpenSSF Scorecard** are both maintainer-triggered/scheduled, not run against your PR - a scorecard badge or unused-key report you might see elsewhere in the repo isn't something your PR needs to pass.

## 🧪 Testing

After installing the prerequisites in [Regression testing](tests/README.md), run `python3 tests/run.py fast` for local feedback or `python3 tests/run.py all` for the complete suite. The full run includes disposable real Jellyfin hosts; it never uses your personal server. Automated coverage is recorded in the [coverage matrix](tests/docs/coverage-matrix.md).

For behavior outside automated coverage, also verify:

- [ ] Feature works as expected
- [ ] No console errors
- [ ] Compatible with Jellyfin 12.x
- [ ] Works on different browsers (Chrome, Firefox, Edge)
- [ ] Doesn't break existing functionality
- [ ] Mobile compatibility (if applicable)

If your PR touches the Shoko calendar integration, also verify:

- [ ] Shoko configured alone, and alongside Sonarr/Radarr instances — merged calendar renders anime, TV, and movie entries together without errors
- [ ] An anime whose Jellyfin item was populated via Shokofin — card navigates to the correct series page
- [ ] An anime with no Shokofin-matched Jellyfin item — card renders as an informational, non-clickable placeholder (no broken image, no dead link)
- [ ] Restricted (H) anime is absent from the results
- [ ] Episode type checkboxes in Shoko settings (Episodes, Specials, Credits, Trailers, Parodies, Other) correctly include/exclude matching calendar entries
- [ ] Misconfigured Shoko (bad URL or API key) surfaces an error in the `errors` array without breaking Sonarr/Radarr results in the same response
- [ ] The Anime sidebar toggle hides/shows Shoko-source cards independently of Sonarr/Radarr toggles
- [ ] A title tracked in both Shoko and Sonarr shows as two separate calendar entries (confirms no accidental cross-source dedup)

## 📋 Feature Request Guidelines

When proposing new features:

1. **Check Discussions First**: Your idea might already be there!
2. **Provide Context**: Explain the use case and benefit
3. **Be Specific**: Clear descriptions help implementation
4. **Consider Scope**: Is this a core feature or niche use case?

## 🐛 Bug Reports

When reporting bugs:

1. **Check Existing Issues**: Avoid duplicates
2. **Check FAQs**
3. **Provide Details** as per the Bug report template

## 💬 Getting Help

If you have questions or need help:

- **Discord**: Reach out on the [Jellyfin Community Discord](https://discord.gg/EYNFf7y4CG)
- **Discussions**: Start a discussion on GitHub
- **Issues**: For bug-related questions

## 🎨 UI/UX Contributions

For UI changes:

- Test with different Jellyfin themes
- Provide before/after screenshots

---

**Thank you for contributing to Jellyfin Enhanced! Your efforts help make Jellyfin better for everyone.** 💜