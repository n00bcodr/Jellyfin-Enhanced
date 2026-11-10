# Backend tests

`JE.Tests.csproj` is the single xUnit project for both Jellyfin compatibility targets. Feature directories organize cases; the SDK automatically includes nested C# files, so adding a test does not require editing a file list.

```sh
python3 tests/run.py backend
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~JE.Tests.Features.SpoilerGuard
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Architecture
```

Run from the repository root with the runtimes described in the [setup guide](../docs/README.md). Use distinct `--artifacts-path` values when building targets concurrently.

The layout mirrors the plugin's `Features/` folders, as listed in [`docs/feature-map.json`](../docs/feature-map.json):

- `Features/<Feature>/` holds one feature's tests, in namespace `JE.Tests.Features.<Feature>`, so `--filter FullyQualifiedName~JE.Tests.Features.<Feature>` runs them. For example, most of the former `Privacy/` tests (identity, policy and content isolation) are in `Features/SpoilerGuard/`, and the poster-tag rendering and tag-cache tests are in `Features/MediaTags/` and `Features/MediaTags/PosterTags/`.
- `Shared/` covers the `Shared/` layer: URL policy, host compatibility, Seerr request outcomes and watch providers.
- `Architecture/` holds the restructure gates; see below.
- Cross-cutting folders that are not one feature's: `Api/` (controller construction and routing helpers shared by every feature, configuration endpoints), `Core/` (configuration, persistence and shared stores), `Integrations/` (HTTP and lifecycle tests using synthetic transports), `Persistence/` (revisioned documents), `PosterTags/` (plural forms) and `ScheduledTasks/` (metadata, visibility and regressions across every JE scheduled task).

Reuse fixtures in `Support/` for disposable storage, the plugin singleton and controlled HTTP. Tests changing the singleton must use `[Collection("Plugin singleton")]`. Keep single-feature fakes with their tests. Assert public responses, persistence and observable side effects; do not turn a production implementation into its own expected-value oracle.

## Architecture gates

`Architecture/` keeps the backend's shape fixed. Every test in it fails the build when it fails. None of them is report-only.

- **Snapshots.** `RouteAuthSnapshotTests`, `AuthHelperCallSnapshotTests` and `ServiceRegistrationSnapshotTests` compare against the committed `*.snapshot.json` files. `AuthReadClosureSnapshotTests` and `ServiceFactorySnapshotTests` compare against `*.base.json` files anchored to `restructure-base`. Snapshots change only in a reviewed contract change. `JE_UPDATE_SNAPSHOTS=1` rewrites the `*.snapshot.json` files and is never set by a gate.
- **`FeatureBoundaryTests`.** Types are attributed by the **folder** of their source file (`SourceFolders.cs`), not by namespace, so the scheduled-task types in `Features/<F>/Tasks/` and `StartupService` count as their folder's feature, and every file under `Shared/` or `Infrastructure/` is in the ratchet whatever its namespace; `SourceFoldersPlaceEveryPluginType` fails if the scan cannot place a type. A type under `Features/<A>/` may reference `Features/<B>/` only through an `allow` edge in `feature-dependencies.json`, an `allowType` entry for that one type (`<folder>/<type>`), or `Features/<B>/PublicApi/`. A controller references only its own feature, plus `Shared`, `Infrastructure`, `Configuration`, `Transport` and `Logger`. References from `Shared/`/`Infrastructure/` into `Features/` may not grow beyond `shared-feature-references.baseline.json` (keyed `<folder>/<type> -> <folder>/<type>`, so a namespace rename does not re-key it); shrink that file when an edge disappears. A helper that several features need moves to `Shared/<Area>/` (backend.md §7.7).
- **`FileSizeTests`.** `Features/**` and `Shared/**` files may have at most 1,500 lines. `Je*Controller*.cs` files may have at most 1,200: split a controller into partials `Je<Feature>Controller.<Area>.cs`. The allow-list in the test only shrinks.
- **`FolderNamespaceTests`.** A file under `Features/<F>/` declares `…Features.<F>[.*]`; a file under `Shared/<Area>/` or `Infrastructure/<Area>/` declares `…Shared.<Area>[.*]` or `…Infrastructure.<Area>[.*]` (`LayerExemptions`, empty). The only exception is scheduled-task types: they keep `…ScheduledTasks`, and `StartupService` keeps `…Services`, because Jellyfin keys a task's saved schedule and history by its type's full name. No file may be added to the retired folders (`Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/`, `Controllers/`, `Extensions/`).
- **`FeatureMapParityTests`.** `docs/feature-map.json` names exactly the folders under `Features/`, each feature's single controller `Je<Feature>Controller`, and the `tests/backend/Features/*` folders. `tests/frontend/architecture/feature-map.test.mjs` checks the client side of the same map.
- **Also:** `ServicesDoNotReadUserTests` and `ControllerActivationTests`.

Real Jellyfin installations belong to `../host/`, not this project. History replay manifests select these same tests rather than maintaining duplicate implementations.
