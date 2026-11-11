# Agent guide

Guidance for AI coding agents working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Where things live

- **Feature map:** [`docs/feature-map.json`](docs/feature-map.json) is the canonical list of features. For each one it gives the client folder, the backend folder, the controller and the test folders. CONTRIBUTING's ["Where things live"](CONTRIBUTING.md#where-things-live) table is rendered from it. To add or rename a feature, change the map first.
- **Client:** TypeScript in `client/src/`. Features are in `features/<feature>/`, the admin page in `admin/config/`, and the platform in `bootstrap/`, `core/`, `host/`, `pages/` and `contracts/`. Each feature's `README.md` lists its entry outputs, public API and tests. `client/entries/*.json` maps every shipped script under `Jellyfin.Plugin.JellyfinEnhanced/js/` to its source; [its README](client/entries/README.md) explains why manifest names don't always match folders.
- **Backend:** `Jellyfin.Plugin.JellyfinEnhanced/`.
  - `Features/<Feature>/` holds `Je<Feature>Controller.cs` (+ partials `Je<Feature>Controller.<Area>.cs`), `Services/`, `Models/`, `Events/`, `Tasks/` and `PublicApi/`.
  - `Shared/<Area>/` holds code that several features use.
  - `Infrastructure/`, `Transport/` and `Configuration/` are the other layers.
  - The pre-restructure folders `Controllers/`, `Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/` and `Extensions/` are retired and must stay empty.
- **Tests:** `tests/frontend/` (node), `tests/backend/` (xUnit, `JE.Tests.csproj`), `tests/browser/` (Playwright). Each runner's README describes its layout; [`docs/advanced/project-structure.md`](docs/advanced/project-structure.md) has the detailed file index.

## Invariants

- **Shipped outputs.** Never rename a `client/entries` output key, and never edit `Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json` (it pins the bundle's load order). The gates compare both with `restructure-base`. Moving a source edits only the right-hand side of its manifest mapping.
- **Generated files.** Never hand-edit `js/**` outputs and maps, `client/generated-manifest.json`, `docs/rewrite/migration-inventory.json`, `client/src/contracts/*.ts` or `tests/docs/production-inventory.json`. Regenerate them:
  - `npm run client:build && npm run inventory:rewrite`;
  - `npm run contracts:generate`;
  - `python3 tests/inventory/generate.py` after moving or editing a controller file.

  The build's outputs are exactly the `outputs` keys of `client/generated-manifest.json` (the `.js`/`.js.map` files under `js/` and `min/js/`, and `Configuration/admin/*.js`). The rest of `js/` is hand-written: `locales/`, `fonts/`, `tags/*.json` and `component-scripts.json`. Commit regenerated outputs in the same commit as their source. A merge or rebase conflict in a generated file is never merged by hand: take either side, regenerate, then `git add` it.
- **Snapshots and baselines.** Never update a snapshot or baseline to make a gate pass, and never set `JE_UPDATE_SNAPSHOTS`. This covers:
  - the route/auth, auth-helper, registration and `*.base.json` snapshots in `tests/backend/Architecture/`;
  - `artifacts/restructure-plan/baselines/*`;
  - `shared-feature-references.baseline.json`, the `FileSizeTests` allow-list and `tests/frontend/architecture/size-baseline.json`;
  - the guard baselines `tests/frontend/guards/*-baseline.json`.

  Failure lists and ratchets only shrink. When a change removes a recorded violation, lower its guard baseline with `node tests/frontend/guards/record.mjs` (it never raises one) in the same commit; when a gate notes that a listed failure now passes, delete that line. If a gate fails, fix the code or stop and report.
- **Frontend feature boundaries** (`tests/frontend/architecture/feature-boundaries.test.mjs`, strict):
  - A file in `features/<A>/` imports only `features/<A>/**`, `core/**`, `contracts/**`, `features/shared/**`, `host/context.ts`, and another feature's `public-api.ts` with `import type`.
  - Runtime access to another feature goes through the `FeatureContext` (`ctx.own`/`ctx.peer`, `host/context.ts`).
  - `host/**` never imports `features/**`.
  - `JE.internals.<slot>` is read only by the slot's owner (`internals-owners.json`).
  - Raw `window.JellyfinEnhanced` is allowed only in host files, `bootstrap/**` and `core/lifecycle-entry.ts`.
- **Backend feature boundaries** (backend.md §7.7, `FeatureBoundaryTests`):
  - A controller references only its own feature plus `Shared`, `Infrastructure`, `Configuration`, `Transport` and `Logger`.
  - Another feature is reached only through its `Features.<B>.PublicApi` static forwarders or an entry in `tests/backend/Architecture/feature-dependencies.json` (`allow` per feature, `allowType` per type). Don't add entries. Types count by their source folder, so `Features/<F>/Tasks/` and `StartupService` are scanned as feature `F` whatever their namespace.
  - A stateless helper or a cross-cutting policy or infrastructure service that several features need moves to `Shared/<Area>/` as a pure rename.
  - References from `Shared/`/`Infrastructure/` into `Features/` must not grow (folder-keyed M2 ratchet, `shared-feature-references.baseline.json`). It sees IL references only: a `const` (inlined) or a generic argument such as `AddSingleton<T>` is invisible to it, so don't rely on the gate for those.
- **Folder = namespace.** A file under `Features/<F>/` declares `…Features.<F>[.*]`; a file under `Shared/<Area>/` or `Infrastructure/<Area>/` declares `…Shared.<Area>[.*]` or `…Infrastructure.<Area>[.*]` (no exemptions there). A new `Shared/` file in a legacy namespace such as `…Helpers` fails `FolderNamespaceTests`. Scheduled-task types are the only exception: they keep `Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks`, and `StartupService` keeps `…Services`, wherever their files live. Jellyfin keys a task's saved triggers and history by the type's full name, so renaming one resets admins' schedules.
- **Sizes.** Controller files (`Je*Controller*.cs`) have at most **1,200** lines; split a controller into partials. Other `Features/**` and `Shared/**` files have at most 1,500. The one exception is `Features/MediaTags/Services/TagCache/TagCacheService.cs`, allow-listed at its current size (4,088 lines) in `FileSizeTests`: it predates the cap, and splitting it is its own refactor. The entry only shrinks, so don't grow the file; lower the entry when it gets smaller. Each feature has one controller type, `Je<Feature>Controller`.
- **Routes and auth.** Routes stay under `[Route("JellyfinEnhanced")]`. A route, verb or authorization change is a contract change. It shows up in the route/auth snapshot and needs the maintainer, not a regenerated snapshot. Until there is a sanctioned procedure, a task that needs a new route leaves the Architecture snapshot tests (the failure message lists the `+`/`-` lines) and the INV route list failing: check that the diff adds only your route, and report it for review.
- **Cached output.** Some constants version stored or cached results. Bump the one whose comment covers your change, in the same commit: `PosterTagSettings.ResolverVersion` (`Shared/MediaTags/PosterTags/PosterTagSettings.cs`, tags produced for the same settings and data), `PosterTagComposer.CompositionVersion` (composite pixels) and `TagCacheService.CurrentCacheSchemaVersion` (what a tag-cache entry holds). Find the others with `git grep -n -iE '(Schema|Resolver|Renderer|Composition)Version'`.

- **No AI attribution in commits.** No `Co-Authored-By` or `Generated with` line naming an AI tool; the `tool` gate fails on one in any commit since the base. Turn your tool's own attribution off in your personal settings, not in this repository.

## How to verify

Use Node 26.2.0 for `h` and for anything that regenerates poster language tables.

```bash
npm run verify:restructure                  # = restructure-gates.sh all && restructure-gates.sh browser (every gate except HOST)
scripts/restructure-gates.sh all            # the merge gate: be's lanes plus fe's regeneration, each check once
scripts/restructure-gates.sh browser        # Playwright (chromium, mobile-chromium, firefox), ratcheted against baselines/browser-failures.txt
scripts/restructure-gates.sh be             # backend: build warnings, Architecture tests, dotnet + npm suites, INV, TOOL (lanes)
scripts/restructure-gates.sh fe             # frontend gate G (client build/check, typecheck, npm test, output keys), INV, TOOL
scripts/restructure-gates.sh inv            # production inventory is current; route list unchanged
scripts/restructure-gates.sh tool           # runner tests, no AI attribution, the type checker's self-test, mutation/history paths
scripts/restructure-gates.sh h              # poster harness builds + ResolutionData.g.cs check
scripts/restructure-gates.sh r '<pattern>'  # no stale reference outside artifacts/
scripts/restructure-gates.sh quick [feat…]  # the inner loop, not a merge gate (below)
npm run verify:rewrite                      # the rewrite's CI gate
```

**Inner loop: `quick`.** The typecheck and build, inventory, then the node tests of the features the diff touches plus architecture and guards, and their dotnet tests when a `.cs` file changed: 30 s to 2 min. With an affected map it also runs the node test files and chromium specs whose traced inputs the change touches; record one on a clean base with `scripts/restructure-gates.sh affected record` (needs `strace`, ~5 min). `affected` alone is an alias of `quick`.

**Merge gates.** `all` runs four lanes at once (dotnet, the frontend suite, contracts, checks) and keeps ~8.5 of 10 cores busy; a `FAILURE seen after N s in lane X` line appears as soon as any lane writes a failure (`JE_GATE_FAIL_FAST=1` stops the others). `all` takes about 2 min and `browser` about 2 min on the Lenovo (10 cores, quiet); on the second worker (16 threads, but 4 performance and 8 efficiency cores, power-limited, usually shared) about 5½ and 4½ min. Run them in the background. **Never side by side:** on this 10-core, 15 GB machine `all` and `browser` started together fail on timeouts, so heavy gates (`be`, `fe`, `all`, `browser`) take turns on a machine: one started while another runs waits for it. Callers still run one gate at a time per machine under `JE12_GATE_LOCK`. `scripts/gate-timing.py` times any gate per step, file and class.

**Type checker:** tsc-rs (exactly pinned) runs every type check; nothing runs `tsc`, and TypeScript 6 is only a parser. A tsc-rs bump changes `scripts/typecheck-tool.mjs` and `package.json` together and lands only after `node scripts/typecheck-selftest.mjs` passes (`docs/rewrite/frontend-build.md`). Gate details are in `artifacts/restructure-plan/PLAN.md` ("Gates"). **Load-sensitive tests:** a test that fails under load and passes alone has a real cause in the test or the product (the ones listed here before were fixed at theirs: `artifacts/restructure-plan/test-speed/RESULTS.md` §3). Reproduce it with `scripts/test-under-load.py --starve` (blocks a Node test's event loop at random moments) or `--hog 30`, fix the cause, never loosen the assertion. **Flake protocol:** a failure counts as a flake only if an isolated rerun passes and then a clean full rerun passes; record both in the step log. Never add a flaky test to a baseline.

**HOST (real Jellyfin 12.4).** Run this before claiming that something works in Jellyfin:
1. `scripts/restructure-gates.sh image` checks that the pinned image digest is unchanged.
2. Start a disposable server with the maintainers' `je` lab tool: `je up <name> <port> --image jellyfin/jellyfin:12.4`. Always pass `--image`. `je` is not on `PATH`: it is `~/.claude/skills/jellyfin-enhanced/scripts/je` (the `jellyfin-enhanced` skill; lab scripts in `/home/jake/je-lab/`).
3. Before the plugin's first start, point every Sonarr, Radarr and Seerr setting in the lab configuration away from real hosts: the golden copy names the live host for Sonarr and Radarr, and its Seerr is a shared container that forwards requests to that Sonarr. Editing after the server starts races the plugin's startup.
4. `je up` builds and installs this tree. Since round 13 its build snapshot gets `npm ci`, and it tolerates exactly the warnings in `baselines/build-warnings.txt`. If it fails, install by hand: build with `dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release -p:JellyfinTarget=jf12 -o <dir>`, then stop the container, copy the DLL and a `meta.json` into `config/plugins/JellyfinEnhanced_<version>/` and start it again. The repository has no `meta.json`; use the `META` constant in `je` (`targetAbi` `12.0.0.0`), which `je` writes to `JellyfinEnhanced_12.8.0.0/`.
5. Check that the plugin loads without JE errors, that the admin page, Media Tags hub and a tagged poster render, that the JE scheduled tasks are listed under their original names, and that `/api-docs/openapi.json` returns 200. Also compare `GET /JellyfinEnhanced/bundle.js` with `scripts/restructure-gates.sh bundle <file>` (`bundle-hash`).
6. Remove the container and its data afterwards (`je rm <name>`).

**Guardrail tests:**
- `tests/frontend/architecture/`: `feature-boundaries`, `file-size`, `generated-markers`, `feature-map`, `feature-readme`.
- `tests/backend/Architecture/`: `FeatureBoundaryTests`, `FileSizeTests`, `FolderNamespaceTests`, `FeatureMapParityTests`, `ControllerActivationTests`, `ServicesDoNotReadUserTests`, and the route/auth, auth-helper, auth-read, registration and service-factory snapshot tests.
- To run only the backend guardrails: `dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Architecture`.

[`tests/backend/README.md`](tests/backend/README.md) explains each backend check and its exemptions.

---

Structure informed by Jellyfin Canopy's agent guidance (GPL-3.0).
