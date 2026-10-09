# Backend tests

`JE.Tests.csproj` is the single xUnit project for both Jellyfin compatibility targets. Feature directories organize cases; the SDK automatically includes nested C# files, so adding a test does not require editing a file list.

```sh
python3 tests/run.py backend
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Privacy
```

Run from the repository root with the runtimes described in the [setup guide](../docs/README.md). Use distinct `--artifacts-path` values when building targets concurrently.

`Api/` covers controller and request-pipeline contracts; `Core/` covers configuration, persistence and core services; `Integrations/` covers external providers using synthetic transports; `PosterTags/` covers native rendering and tag caches; `Privacy/` covers identity, policy and content isolation; `ScheduledTasks/` covers background jobs.

Reuse fixtures in `Support/` for disposable storage, the plugin singleton and controlled HTTP. Tests changing the singleton must use `[Collection("Plugin singleton")]`. Keep single-feature fakes with their tests. Assert public responses, persistence and observable side effects; do not turn a production implementation into its own expected-value oracle.

Real Jellyfin installations belong to `../host/`, not this project. History replay manifests select these same tests rather than maintaining duplicate implementations.
