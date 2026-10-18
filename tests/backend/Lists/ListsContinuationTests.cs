using Jellyfin.Data;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Moq;
using static JE.Tests.ListsHarness;

namespace JE.Tests;

// Review round 6 (4c1): the create, recovery, retry and swap paths are one continuation each, checked after EVERY await.
// The harness doesn't pick awaits: a control run records every await the path reaches, at both seams:
// - every completed await of the continuation (ListStore.Awaited, the production seam; absent before round 6);
// - every native point of the fake Jellyfin (before and after each create, insert, move, add and rename).
// Then, for each recorded point in turn, a fresh run makes one change there: revoke view, revoke edit, delete the list,
// delete and re-add it under the same id, delete the person, or a restore. Every run must answer without the list's
// identity, write nothing to Jellyfin after the change, leave no second or orphaned list, and never revive a deleted create.
// The harness uses reflection for the seams so that it also builds (and fails) against the code before round 6.
[Collection("Plugin singleton")]
public class ListsContinuationTests
{
    private static readonly string[] CreatePaths = { "normal", "normal-tv", "with-hook", "marker-recovery", "recorded-retry", "retry-apply", "replay" };
    private static readonly string[] SwapPaths = { "swap", "swap-recovery", "swap-tv", "swap-tv-recovery" };
    private static readonly string[] Changes = { "view", "edit", "delete", "readd", "user", "restore" };

    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    public ListsContinuationTests(Xunit.Abstractions.ITestOutputHelper output)
    {
        _output = output;
    }

    public static IEnumerable<object[]> Rows() =>
        from kind in new[] { ListKinds.Playlist, ListKinds.Collection }
        from path in CreatePaths.Concat(SwapPaths)
        from change in Changes
        select new object[] { kind, path, change };

    [Theory]
    [MemberData(nameof(Rows))]
    public async Task EveryAwaitRechecksTheOperationAndAccess(string kind, string path, string change)
    {
        List<string> trace;
        using (var control = new Rig(kind, path))
        {
            await control.Prepare();
            control.Probe(point => control.Trace.Add(point));
            var answer = await control.Run().WaitAsync(TimeSpan.FromSeconds(20));
            control.Probe(null);
            if (!control.Swap)
            {
                Ok<CreateListResultDto>(answer!);
            }

            trace = control.Trace.ToList();
        }

        var failures = new List<string>();
        if (!trace.Any(p => p.StartsWith("await ", StringComparison.Ordinal)))
        {
            // The continuation's own seam must see the path (it is the guarantee); before round 6 it doesn't exist, and
            // only the native points below are injected.
            failures.Add("no continuation await was seen: the path isn't one checked continuation");
        }

        var skipped = 0;
        for (var index = 0; index < trace.Count; index++)
        {
            using var rig = new Rig(kind, path);
            await rig.Prepare();
            var seen = 0;
            rig.Probe(point =>
            {
                if (seen++ == index)
                {
                    rig.Change(change);
                }
            });
            try
            {
                var answer = await rig.Run().WaitAsync(TimeSpan.FromSeconds(20));
                rig.Probe(null);
                await rig.Cleanup.WaitAsync(TimeSpan.FromSeconds(20));
                if (!rig.Changed)
                {
                    // Nothing to change at this point (no list yet to delete): the run must simply have succeeded.
                    skipped++;
                    if (!rig.Swap)
                    {
                        Ok<CreateListResultDto>(answer!);
                    }

                    continue;
                }

                await rig.Assert(answer);
            }
            catch (Exception ex)
            {
                failures.Add($"{index + 1}/{trace.Count} {trace[index]}: {ex.Message.Split('\n')[0]}");
            }
            finally
            {
                rig.Probe(null);
                try
                {
                    await rig.Cleanup.WaitAsync(TimeSpan.FromSeconds(20));
                }
                catch (Exception ex)
                {
                    failures.Add($"cleanup at {index + 1}: {ex.Message}");
                }
            }
        }

        var awaits = trace.Where(p => p.StartsWith("await ", StringComparison.Ordinal)).ToList();
        _output.WriteLine($"{kind}/{path}/{change}: {trace.Count} injection points ({awaits.Count} continuation awaits at {awaits.Distinct().Count()} sites, {trace.Count - awaits.Count} native points), {skipped} not applicable");
        _output.WriteLine("SITES " + string.Join("|", trace.Distinct().OrderBy(p => p, StringComparer.Ordinal)));
        Xunit.Assert.True(failures.Count == 0, $"{failures.Count} of {trace.Count} injections failed:\n" + string.Join("\n", failures.Take(40)));
    }

    // Defence in depth for the runtime seam above: every await in the files of the create and swap closure goes through
    // ListContinuation (an unwrapped await would be a continuation that is never checked). Named exceptions run outside
    // any continuation (background loops, the detached shared Seerr fetch).
    [Fact]
    public void EveryAwaitOfTheCreateAndSwapClosureIsAContinuationBoundary()
    {
        var exempt = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ListSwapService.StopAsync"] = "stops the worker",
            ["ListSwapService.DrainAsync"] = "worker body: each pass starts its own continuation",
            ["ListSwapService.RunAllAsync"] = "maintenance loop: each pass starts its own continuation",
            ["ListSwapService.WorkerLoopAsync"] = "worker loop",
            ["ListMetadataService.FetchFromSeerrAsync"] = "the detached shared fetch",
            ["ListMetadataService.RunAsync"] = "the detached shared fetch",
            ["ListContinuation.Await"] = "the seam itself",
            ["ListContinuation.AcquireAsync"] = "the seam itself",
        };
        var compilation = ListGateWalk.Load(unwrapContinuations: false);
        var (violations, count, used) = AwaitBoundaries(compilation, exempt);
        _output.WriteLine($"{count} awaits in the create/swap closure, all through ListContinuation; exempt: {string.Join(", ", used)}");
        Assert.Empty(violations);
        Assert.Equal(exempt.Keys.OrderBy(k => k), used.OrderBy(k => k));
    }

    [Fact]
    public void AwaitGuardRejectsACompilingUncheckedHelper()
    {
        const string source = """
            using System.Threading.Tasks;
            namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
            static class ListContinuation
            {
                public static Task Await(Task task) => task;
                public static Task AwaitLock(Task task) => task;
                public static Task AwaitUnchecked(Task task) => task;
            }
            class ListService
            {
                public async Task Run()
                {
                    await ListContinuation.Await(Task.CompletedTask).ConfigureAwait(false);
                    await ListContinuation.AwaitLock(Task.CompletedTask);
                    await ListContinuation.AwaitUnchecked(Task.CompletedTask).ConfigureAwait(false);
                }
            }
            """;
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p));
        var compilation = CSharpCompilation.Create("Planted", new[] { CSharpSyntaxTree.ParseText(source, path: "ListService.cs") }, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.DoesNotContain(compilation.GetDiagnostics(), d => d.Severity == DiagnosticSeverity.Error);
        var (violations, count, _) = AwaitBoundaries(compilation, new Dictionary<string, string>());
        Assert.Equal(3, count);
        Assert.Single(violations);
    }

    private static (List<string> Violations, int Count, HashSet<string> Used) AwaitBoundaries(CSharpCompilation compilation, IReadOnlyDictionary<string, string> exempt)
    {
        var continuation = compilation.GetTypeByMetadataName("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.ListContinuation");
        var allowed = (continuation?.GetMembers().OfType<IMethodSymbol>() ?? Enumerable.Empty<IMethodSymbol>())
            .Where(m => m.Name is "Await" or "AwaitLock").Select(m => m.OriginalDefinition)
            .ToHashSet(SymbolEqualityComparer.Default);
        var violations = new List<string>();
        var count = 0;
        var used = new HashSet<string>(StringComparer.Ordinal);
        var files = new[] { "ListService.cs", "ListSwapService.cs", "ListPlaylistPlacement.cs", "ListGate.cs", "ListHost.cs", "ListAccess.cs", "ListMetadata.cs", "ListContinuation.cs" };
        foreach (var tree in compilation.SyntaxTrees.Where(t => files.Contains(Path.GetFileName(t.FilePath))))
        {
            var file = Path.GetFileName(tree.FilePath);
            var model = compilation.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<AwaitExpressionSyntax>())
            {
                var type = node.Ancestors().OfType<ClassDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText;
                var method = node.Ancestors().OfType<LocalFunctionStatementSyntax>().FirstOrDefault()?.Identifier.ValueText
                    ?? node.Ancestors().OfType<MethodDeclarationSyntax>().FirstOrDefault()?.Identifier.ValueText;
                var key = type + "." + method;
                if (exempt.ContainsKey(key))
                {
                    used.Add(key);
                    continue;
                }

                count++;
                var awaited = node.Expression is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } configured }
                    ? configured.Expression
                    : node.Expression;
                var symbol = awaited is InvocationExpressionSyntax invocation ? model.GetSymbolInfo(invocation).Symbol as IMethodSymbol : null;
                if (symbol == null || !allowed.Contains(symbol.OriginalDefinition))
                {
                    violations.Add($"{file}:{node.GetLocation().GetLineSpan().StartLinePosition.Line + 1}: {key}");
                }
            }
        }

        return (violations, count, used);
    }

    private sealed class Rig : IDisposable
    {
        private readonly string _kind;
        private readonly string _path;
        private readonly ListLifecycle _lifecycle;
        private readonly PropertyInfo? _seam;
        private readonly ExecutionContext? _outside;
        private FakeListHost.FakeList? _removed;

        public Rig(string kind, string path)
        {
            _kind = kind;
            _path = path;
            User = H.NewUser("creator", collections: true, maxRating: 10);
            H.MovieCertifications[900] = "PG";
            H.MovieDetails[900] = "{\"id\":900,\"releases\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"PG\",\"type\":3}]}]}}";
            H.Plugin.Plugin.Configuration.ArrPhase4ListStatusEnabled = true;
            H.TvDetails[800] = "{\"id\":800,\"name\":\"Show\",\"firstAirDate\":\"2000-01-01\",\"status\":\"Returning Series\",\"inProduction\":true,\"lastEpisodeToAir\":{\"seasonNumber\":1,\"episodeNumber\":3,\"airDate\":\"2000-01-03\"},\"seasons\":[{\"seasonNumber\":1,\"episodeCount\":3,\"airDate\":\"2000-01-01\"}],\"contentRatings\":{\"results\":[{\"iso_3166_1\":\"US\",\"rating\":\"PG\"}]}}";
            H.SeasonDetails[(800, 1)] = "{\"id\":8001,\"seasonNumber\":1,\"episodes\":[{\"episodeNumber\":1,\"airDate\":\"2000-01-01\"},{\"episodeNumber\":2,\"airDate\":\"2000-01-02\"},{\"episodeNumber\":3,\"airDate\":\"2000-01-03\"}]}";
            Entries = new[] { new ApplyEntry(0, H.Host.AddItem(), null), new ApplyEntry(1, null, Movie(900, addedBy: User.Id.ToString("N"))) };
            if (path is "normal-tv" or "retry-apply")
            {
                var series = H.Host.AddSeries(tmdb: 800);
                H.Host.AddEpisode(series, 1, 1);
                H.Host.AddEpisode(series, 1, 3);
                var scope = Ph(path == "normal-tv"
                    ? "{\"kind\":\"season\",\"tmdbId\":800,\"seasonNumber\":1,\"title\":\"Show\"}"
                    : "{\"kind\":\"series\",\"tmdbId\":800,\"title\":\"Show\"}", User.Id.ToString("N"));
                Entries = new[] { new ApplyEntry(0, null, scope), new ApplyEntry(1, H.Host.AddItem(), null) };
            }

            H.Host.SupportsPositionalInsert = false; // appends and moves as well as collection adds
            _lifecycle = new ListLifecycle(Mock.Of<ILibraryManager>(), H.Store, H.Host, H.Plugin.Core.Logger, operations: H.Operations, events: H.Events);
            _seam = typeof(ListStore).GetProperty("Awaited", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            // A change stands for another request or a native event: it runs outside the create's flow.
            _outside = ExecutionContext.Capture();
            H.Host.OnWrite = (op, _, _, _) =>
            {
                if (Changed)
                {
                    WritesAfterChange.Add(op);
                }
            };
        }

        public ListsHarness H { get; } = new(seerr: true, status: true);

        public User User { get; }

        public ApplyEntry[] Entries { get; }

        public bool Swap => _path.StartsWith("swap", StringComparison.Ordinal);

        public FakeListHost.FakeList? List => H.Host.Lists.Values.FirstOrDefault() ?? _removed;

        public List<string> Trace { get; } = new();

        public List<string> WritesAfterChange { get; } = new();

        public Task Cleanup { get; private set; } = Task.CompletedTask;

        public bool Changed { get; private set; }

        private string Change_ { get; set; } = string.Empty;

        private int CreatesBefore { get; set; }

        private int Creates => H.Host.Calls.Count(c => c.StartsWith("create-", StringComparison.Ordinal));

        public void Probe(Action<string>? probe)
        {
            _seam?.SetValue(H.Store, probe == null ? null : new Action<string>(point => Outside(() => probe("await " + point))));
            H.Host.OnAwait = probe == null ? null : point => Outside(() => probe("native " + point));
        }

        public async Task Prepare()
        {
            if (_path is "normal" or "normal-tv" or "with-hook")
            {
                return;
            }

            if (_path == "retry-apply")
            {
                // The first attempt made, recorded and named its list, then Jellyfin refused the insert: a failed,
                // retryable operation the retry continues on the same list.
                H.Host.FailAdds = new IOException("insert failed");
                var failed = await H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default);
                Xunit.Assert.True(failed.StatusCode >= 400, "the first attempt should fail: " + failed.StatusCode);
                H.Host.FailAdds = null;
                return;
            }

            if (Swap)
            {
                Ok<CreateListResultDto>(await H.Service.CreateListAsync(User, _kind, "Private list", false, Array.Empty<ApplyEntry>(), K("create"), default));
                var doc = H.Store.LoadForUpdate(List!.Info.Id.ToString("N"), _kind);
                var placeholder = _path.Contains("tv", StringComparison.Ordinal)
                    ? Ph("{\"kind\":\"episodes\",\"tmdbId\":800,\"seasonNumber\":1,\"title\":\"Show\",\"episodes\":[{\"s\":1,\"e\":1},{\"s\":1,\"e\":2},{\"s\":1,\"e\":3}]}", User.Id.ToString("N"))
                    : Movie(900, addedBy: User.Id.ToString("N"));
                doc.Items.Add(placeholder);
                doc.Order.Add(P(placeholder.Id));
                var existing = H.Host.AddItem();
                List.Raw.Add(new RawEntry(existing, true));
                doc.Order.Add(E(existing));
                doc.SwapIn = new ListConsent { ByUserId = User.Id.ToString("N"), At = DateTime.UtcNow.ToString("o") };
                H.Store.Save(doc);
                var item = H.Host.AddMovie(900);
                if (_path.Contains("tv", StringComparison.Ordinal))
                {
                    var series = H.Host.AddSeries(tmdb: 800);
                    item = H.Host.AddEpisode(series, 1, 1);
                    H.Host.AddEpisode(series, 1, 3);
                }

                if (_path.EndsWith("recovery", StringComparison.Ordinal))
                {
                    // A pass died after Jellyfin took the item and before it recorded it.
                    var id = item.ToString("N");
                    doc = H.Store.LoadForUpdate(doc.ListId, _kind);
                    doc.Intents.Add(new SwapIntent { PhId = placeholder.Id, ItemIds = new() { id }, OccurrenceCountsBefore = new() { [id] = 0 }, CreatedAt = DateTime.UtcNow.ToString("o") });
                    List.Raw.Add(new RawEntry(item, true));
                    H.Store.Save(doc);
                }

                return;
            }

            if (_path == "replay")
            {
                Ok<CreateListResultDto>(await H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default));
                return;
            }

            // marker-recovery: died right after Jellyfin's create, before the list was recorded;
            // recorded-retry: the list was recorded, then naming it failed.
            if (_path == "marker-recovery")
            {
                H.Host.AfterCreate = _ => throw new IOException("crash");
            }
            else
            {
                H.Host.FailFinishes = 1;
            }

            await Xunit.Assert.ThrowsAsync<IOException>(() => H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default));
            H.Host.AfterCreate = null;
        }

        public async Task<ListOutcome?> Run()
        {
            if (Swap)
            {
                await H.Swap.RunListPassAsync(List!.Info.Id.ToString("N"), null, MetadataMode.New, default);
                return null;
            }

            return await H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default,
                _path == "with-hook" ? _ => new ApplyHooks { AfterApplyAsync = async (_, _, _) => { await Task.Yield(); return false; } } : null);
        }

        public void Change(string change)
        {
            var list = H.Host.Lists.Values.FirstOrDefault();
            if (change is "delete" or "readd" && list == null)
            {
                return; // no list to delete yet
            }

            Changed = true;
            Change_ = change;
            CreatesBefore = Creates;
            switch (change)
            {
                case "view":
                    if (list == null)
                    {
                        User.SetPermission(PermissionKind.IsDisabled, true);
                    }
                    else
                    {
                        H.Host.ListHiddenFrom[User.Id] = new() { list.Info.Id };
                    }

                    break;
                case "edit":
                    User.SetPermission(PermissionKind.EnableCollectionManagement, false);
                    if (_kind == ListKinds.Playlist)
                    {
                        if (list == null)
                        {
                            User.SetPermission(PermissionKind.IsDisabled, true);
                        }
                        else
                        {
                            list.Info = list.Info with { OwnerId = H.NewUser("other").Id, OpenAccess = true };
                        }
                    }

                    break;
                case "user":
                    H.Users.Setup(u => u.GetUserById(User.Id)).Returns((User?)null);
                    H.Operations.PurgeUser(User.Id);
                    break;
                case "restore":
                    H.Store.InvalidateAll();
                    break;
                default:
                    // Jellyfin removed the list (its ItemRemoved cleanup runs as it does natively, with the marker when it
                    // has one); a re-add brings the folder back under the same item id.
                    _removed = list;
                    H.Host.Lists.Remove(list!.Info.Id);
                    var remove = typeof(ListLifecycle).GetMethod("DeleteForRemovedListAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
                    var marker = MarkerOf(list);
                    Cleanup = (Task)remove.Invoke(_lifecycle, remove.GetParameters().Length == 2 ? new object?[] { list.Info.Id, marker } : new object?[] { list.Info.Id })!;
                    if (change == "readd")
                    {
                        H.Host.Lists[list.Info.Id] = list;
                    }

                    break;
            }
        }

        public async Task Assert(ListOutcome? answer)
        {
            // No identity in the answer.
            if (!Swap)
            {
                Xunit.Assert.True(answer!.StatusCode >= 400, $"{Change_}: answered {answer.StatusCode}");
                var error = Xunit.Assert.IsType<ListErrorDto>(answer.Value);
                Xunit.Assert.Null(error.ListId);
                Xunit.Assert.Null(error.ListKind);
                Xunit.Assert.DoesNotContain("Private list", JsonSerializer.Serialize(answer.Value));
            }

            // No write to Jellyfin after the change.
            Xunit.Assert.True(WritesAfterChange.Count == 0, $"{Change_}: wrote after the change: {string.Join(",", WritesAfterChange)}");

            if (Change_ is "delete" or "readd")
            {
                // No document written back for the deleted list, no revived create, and no other list made instead.
                Xunit.Assert.Null(H.Store.Load(_removed!.Info.Id.ToString("N")));
                if (!Swap)
                {
                    var retry = await H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default);
                    Error(retry, 404, "not_found");
                }

                Xunit.Assert.Equal(CreatesBefore, Creates);
                return;
            }

            if (Swap || Change_ == "user")
            {
                return;
            }

            // Access back (or the restore over): a retry continues with the one list the create made, never a second.
            User.SetPermission(PermissionKind.IsDisabled, false);
            User.SetPermission(PermissionKind.EnableCollectionManagement, true);
            H.Host.ListHiddenFrom.Remove(User.Id);
            var again = await H.Service.CreateListAsync(User, _kind, "Private list", false, Entries, K("create"), default);
            Xunit.Assert.True(Creates <= 1, $"{Change_}: {Creates} lists created");
            Xunit.Assert.True(H.Host.Lists.Count <= 1, $"{Change_}: {H.Host.Lists.Count} lists");
            if (again.Value is ListErrorDto retried && again.StatusCode == 404)
            {
                Xunit.Assert.Null(retried.ListId);
            }
        }

        public void Dispose()
        {
            Probe(null);
            _lifecycle.Dispose();
            H.Dispose();
        }

        private Guid? MarkerOf(FakeListHost.FakeList list)
        {
            if (H.Host.CollectionProviderIds.TryGetValue(list.Info.Id, out var ids) && ids.TryGetValue(JellyfinListHost.CreateMarkerKey, out var value) && Guid.TryParseExact(value, "N", out var marker))
            {
                return marker;
            }

            var match = System.Text.RegularExpressions.Regex.Match(list.Path, @"\(([0-9a-fA-F]{32})\)");
            return match.Success ? Guid.ParseExact(match.Groups[1].Value, "N") : null;
        }

        private void Outside(Action action)
        {
            if (_outside == null)
            {
                action();
                return;
            }

            ExecutionContext.Run(_outside.CreateCopy(), _ => action(), null);
        }
    }
}
