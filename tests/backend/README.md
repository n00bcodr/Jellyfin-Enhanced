# Backend tests

`JE.Tests.csproj` is the single xUnit project for both Jellyfin compatibility targets. Feature directories organize cases; the SDK automatically includes nested C# files, so adding a test does not require editing a file list.

```sh
python3 tests/run.py backend
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Privacy
```

Run from the repository root with the runtimes described in the [setup guide](../docs/README.md). Use distinct `--artifacts-path` values when building targets concurrently.

`Api/` covers controller and request-pipeline contracts; `Core/` covers configuration, persistence and core services; `Integrations/` covers external providers using synthetic transports; `PosterTags/` covers native rendering and tag caches; `Privacy/` covers identity, policy and content isolation; `ScheduledTasks/` covers background jobs.

Every cache the plugin keeps (a dictionary, set, list, queue, MemoryCache, ConditionalWeakTable, Lazy memo or held user, found in the plugin's source by `Users/UserCacheScan.cs`) is listed in `tests/fixtures/user-caches/user-caches.tsv`: `stamped` (declared as `Helpers/UserAccessCache.cs`, which follows the user as each request reads them and their Jellyfin user version, and never serves what a computation running across an invalidation produced), `keyed` (its key holds the viewer's access as the asking request read it; the row names the key builder and what it must contain) or `independent` with the reason it doesn't depend on a user's access. `UserCacheRegistryTests` fails on a cache nobody listed, a `stamped` row that isn't the helper, a key builder that no longer keys by the access, and a row whose cache is gone. A new cache that depends on what a user may see is declared as `UserAccessCache`.

Reuse fixtures in `Support/` for disposable storage, the plugin singleton and controlled HTTP. Tests changing the singleton must use `[Collection("Plugin singleton")]`. Keep single-feature fakes with their tests. Assert public responses, persistence and observable side effects; do not turn a production implementation into its own expected-value oracle.

Real Jellyfin installations belong to `../host/`, not this project. History replay manifests select these same tests rather than maintaining duplicate implementations.
