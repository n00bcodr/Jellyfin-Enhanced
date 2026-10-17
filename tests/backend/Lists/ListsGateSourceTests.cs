using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

// Review round 2 (4c1, BY DESIGN (f)): no list write to Jellyfin and no answer with list contents can skip the one list
// access gate (ListGate). Jellyfin's writes take a single-use ListWrite only the gate makes, made right there (so nothing
// can be awaited between the check and the write); views are built only from a ListGrant inside the gate's projection;
// the person's asks, document saves and answers come right after a gate call with no await in between.
// Review round 3 (4c1-r3-security-4): checked by Roslyn over every production type (ListGateWalk), by symbols rather than
// text, with the bypasses the round-3 review planted (a target-typed new, an ungated delegate named write(), a view made
// with new()) and the earlier ones as cases the walk must report.
public class ListsGateSourceTests
{
    private const string Service = "Services/Acquire/Lists/ListService.cs";

    // The swap-in switch's save (SetSwapInAsync).
    private const string SwapInSave = "                    : null;\n                List<string>? canonical = null;\n                if (access.List.Kind == ListKinds.Playlist)\n                {\n                    canonical = Canonical(access, doc);\n                    doc.Order = canonical;\n                }\n\n                var saved = _store.Save(doc);";

    private static readonly Assembly Plugin = typeof(ListService).Assembly;

    // Each case changes text that is there once in a copy of the plugin's source (which must still compile), and the walk
    // must report it.
    private static readonly Dictionary<string, (string File, (string Text, string Planted)[] Changes, string Reported)> Bypasses = new(StringComparer.Ordinal)
    {
        // The round-3 review's three.
        ["grant_made_with_a_target_typed_new"] = (Service, new[] { ("await _host.AddToCollectionAsync(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "ListWrite grant = new(access.List.Id, access.User.Id, ListWriteKind.CollectionAdd); await _host.AddToCollectionAsync(grant, items)") }, "a ListWrite made outside the gate"),
        ["grant_through_an_ungated_delegate_named_write"] = (Service, new[] { ("await _host.AddToCollectionAsync(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "var early = _gate.Write(access, ListWriteKind.CollectionAdd, items); await Task.Yield(); Func<ListWrite> write = () => early; await _host.AddToCollectionAsync(write(), items)") }, "isn't made by the gate right there"),
        ["view_made_with_a_target_typed_new"] = (Service, new[] { ("result.View = view;\n            return ListOutcome.Ok(new CreateListResultDto", "result.View = new();\n            return ListOutcome.Ok(new CreateListResultDto") }, "a ListViewDto made outside ListService.BuildView"),
        // The three together as the review planted them (the old regex tests passed all seven with them): a local named
        // write that makes its grant with new().
        ["grant_from_a_local_write_delegate_made_with_new"] = (Service, new[]
        {
            ("var markedName = CreateName(name, marker);", "var markedName = CreateName(name, marker);\n                Func<ListWrite> write = () => new(Guid.Empty, user.Id, ListWriteKind.Create);"),
            ("_host.CreatePlaylistAsync(_gate.CreateWrite(user, kind), markedName, isPublic)", "_host.CreatePlaylistAsync(write(), markedName, isPublic)"),
        }, "a ListWrite made outside the gate"),
        // A delegate parameter handed a grant made earlier (ListPlaylistPlacement's write).
        ["placement_handed_a_held_grant"] = (Service, new[]
        {
            ("private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _createLocks = new();", "private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _createLocks = new();\n        private ListWrite? _held;"),
            ("(kind, written) => _gate.Write(access, kind, written)", "(kind, written) => _held!"),
        }, "is given an ungated grant"),
        // Grants and views made elsewhere in the plugin, or by reflection.
        ["grant_made_in_the_controller"] = ("Controllers/AcquireListsController.cs", new[] { ("public class AcquireListsController : ControllerBase\n    {\n", "public class AcquireListsController : ControllerBase\n    {\n        internal static ListWrite Forge() => new ListWrite(Guid.Empty, Guid.Empty, ListWriteKind.Create);\n") }, "a ListWrite made outside the gate"),
        ["grant_made_by_reflection"] = ("Controllers/AcquireListsController.cs", new[] { ("public class AcquireListsController : ControllerBase\n    {\n", "public class AcquireListsController : ControllerBase\n    {\n        internal static object Forge() => Activator.CreateInstance(typeof(ListWrite), true)!;\n") }, "ListWrite used by reflection"),
        // The earlier classes: a wait in the write, a grant held across an await, a method group.
        ["await_in_the_grant"] = (Service, new[] { ("_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "_gate.Write(access, ListWriteKind.CollectionAdd, await Task.FromResult(items)), items)") }, "awaits in its arguments"),
        ["await_in_another_argument"] = (Service, new[] { ("_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "_gate.Write(access, ListWriteKind.CollectionAdd, items), await Task.FromResult(items))") }, "awaits in its arguments"),
        ["grant_held_across_an_await"] = (Service, new[] { ("await _host.AddToCollectionAsync(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "var held = _gate.Write(access, ListWriteKind.CollectionAdd, items); await Task.Yield(); await _host.AddToCollectionAsync(held, items)") }, "isn't made by the gate right there"),
        ["write_through_a_method_group"] = (Service, new[] { ("await _host.AddToCollectionAsync(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)", "Func<ListWrite, IReadOnlyList<Guid>, Task> add = _host.AddToCollectionAsync; await add(_gate.Write(access, ListWriteKind.CollectionAdd, items), items)") }, "used as a method group"),
        ["host_write_without_spending"] = ("Services/Acquire/Lists/ListHost.cs", new[] { ("write.Spend(write.ListId, ListWriteKind.CollectionAdd);", "_ = write.ListId;") }, "doesn't spend its grant first"),
        // Views.
        ["view_built_outside_the_projection"] = (Service, new[] { ("var view = await _gate.ProjectAsync(access, current?.Items ?? new List<Placeholder>(), visibility, grant => BuildView(grant, current, canonical), cancellationToken).ConfigureAwait(false);", "var stale = await _gate.GrantAsync(access, current?.Items ?? new List<Placeholder>(), visibility, cancellationToken).ConfigureAwait(false); var view = stale == null ? null : BuildView(stale, current, canonical);") }, "a view built outside the gate's projection"),
        // Asks, saves and CheckedAsync's grant.
        ["save_after_an_await"] = (Service, new[] { (SwapInSave, SwapInSave.Replace("var saved = _store.Save(doc);", "await Task.Yield(); var saved = _store.Save(doc);", StringComparison.Ordinal)) }, "a person save waits after the gate check"),
        ["save_through_a_method_group"] = (Service, new[] { (SwapInSave, SwapInSave.Replace("var saved = _store.Save(doc);", "Func<ListDoc, ListDoc> save = _store.Save; var saved = save(doc);", StringComparison.Ordinal)) }, "a person save used as a method group"),
        ["ask_after_an_await"] = ("Services/Acquire/Lists/ListAcquisition.cs", new[] { ("outcome = await _requests.CreateAsync(", "await Task.Yield(); outcome = await _requests.CreateAsync(") }, "an ask waits after the gate check"),
        ["checked_grant_after_an_await"] = (Service, new[] { ("return new CheckedWrite(null, current, visibility, blocked);", "await Task.Yield(); return new CheckedWrite(null, current, visibility, blocked);") }, "a checked grant waits after the gate check"),
    };

    [Fact]
    public void EveryJellyfinWriteOfTheListHostTakesAGateGrantFirst()
    {
        var write = Required("ListWrite");
        // Every awaited member of the seam is a list write, except where a collection would go (a read; it may make
        // Jellyfin's collections folder first, as Jellyfin's own create does).
        var writes = typeof(IListHost).GetMethods().Where(m => typeof(Task).IsAssignableFrom(m.ReturnType) && m.Name != nameof(IListHost.CollectionDestinationAsync)).ToList();
        Assert.NotEmpty(writes);
        foreach (var method in writes)
        {
            var first = method.GetParameters().FirstOrDefault();
            Assert.True(first?.ParameterType == write, $"IListHost.{method.Name} writes to Jellyfin without a ListWrite first");
        }

        Assert.Contains(writes, m => m.Name == "AddToPlaylistAsync");
        Assert.Contains(writes, m => m.Name == "MoveInPlaylistAsync");
        Assert.Contains(writes, m => m.Name == "AddToCollectionAsync");
        Assert.Contains(writes, m => m.Name == "CreatePlaylistAsync");
        Assert.Contains(writes, m => m.Name == "CreateCollectionAsync");
        Assert.Contains(writes, m => m.Name == "FinishCreateAsync");
        // Who a write runs as comes from the grant, never from a parameter of its own.
        Assert.All(writes, m => Assert.DoesNotContain(m.GetParameters(), p => p.Name is "userId" or "ownerId"));
    }

    [Fact]
    public void OnlyTheGateMakesGrantsAndOnlyAGrantMakesAView()
    {
        foreach (var name in new[] { "ListWrite", "ListGrant" })
        {
            Assert.Empty(Required(name).GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        }

        var grant = Required("ListGrant");
        var builders = typeof(ListService).GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Where(m => m.ReturnType == typeof(ListViewDto))
            .ToList();
        var build = Assert.Single(builders);
        Assert.Equal("BuildView", build.Name);
        Assert.True(build.IsPrivate);
        Assert.Equal(grant, build.GetParameters()[0].ParameterType);

        // The one public view: the gated projection (the raw GetViewAsync is gone).
        var views = typeof(ListService).GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.ReturnType.IsGenericType && m.ReturnType.GetGenericArguments()[0] == typeof(ListViewDto))
            .Select(m => m.Name)
            .ToList();
        Assert.Equal(new[] { "ViewAsync" }, views);
    }

    // The plugin's own source, as it is: every rule of the walk holds.
    [Fact]
    public void ThePluginKeepsEveryGateRule()
    {
        var walk = ListGateWalk.Plugin;
        Clean(walk.Errors());
        Clean(walk.Problems());
    }

    public static IEnumerable<object[]> BypassCases() => Bypasses.Keys.Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(BypassCases))]
    public void TheWalkReportsEveryBypassPlantedInTheSource(string bypass)
    {
        var (file, changes, reported) = Bypasses[bypass];
        var planted = ListGateWalk.Plugin.With(file, source =>
        {
            foreach (var (text, replacement) in changes)
            {
                var at = source.IndexOf(text, StringComparison.Ordinal);
                Assert.True(at >= 0 && source.IndexOf(text, at + 1, StringComparison.Ordinal) < 0, bypass + ": \"" + text + "\" must be there once");
                source = source[..at] + replacement + source[(at + text.Length)..];
            }

            return source;
        });
        Clean(planted.Errors(file));
        var problems = planted.Problems();
        Assert.True(problems.Any(p => p.Contains(reported, StringComparison.Ordinal)), $"{bypass}: \"{reported}\" not reported; the walk said:\n" + string.Join("\n", problems));
    }

    private static Type Required(string name) =>
        Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists." + name) ?? throw new Xunit.Sdk.XunitException(name + " does not exist");

    // None, or every one in the failure message, one per line.
    private static void Clean(List<string> problems)
    {
        if (problems.Count > 0)
        {
            throw new Xunit.Sdk.XunitException(string.Join("\n", problems));
        }
    }
}
