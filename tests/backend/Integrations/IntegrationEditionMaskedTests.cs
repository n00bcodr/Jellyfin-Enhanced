using System.Linq.Expressions;
using System.Reflection;
using System.Reflection.Emit;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition round 14 (D53: masked facts by construction). Every Sonarr fact (episodes, seasons, season statistics, files,
/// queue, history) reaches a status reader only through a per-binding read that has already applied that binding's hidden
/// mask; the raw facts are not reachable from status code. A gap a Sonarr reports for its own folder is that copy's gap when
/// another copy the viewer can open plays the episode. Jellyfin's grouped season and episode lists are read only by named
/// presentation methods, judged by the symbols the built assembly calls, whatever the receiver.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionMaskedTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    internal static List<JsonElement> Items(StatusBody body)
    {
        using var doc = JsonDocument.Parse(body.Json);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }

    internal static async Task<JsonElement> Page(Rig rig, StatusViewer viewer, Guid id)
    {
        await rig.Service.ForItemAsync(viewer, id, default);
        await Task.Delay(20);
        return Assert.Single(Items(await rig.Service.ForItemAsync(viewer, id, default)));
    }

    // ------------------------------------------------------------------ ED-R14-1: season statistics pass the binding's mask

    [Theory]
    [InlineData(true)]  // the finding: season 2 (asked for) is hidden from the kid as a whole; no episode list in memory, Sonarr's statistics say a file is there
    [InlineData(false)] // control: an adult hears that the file is on its way into the library
    public async Task ARequestedSeasonHiddenInTheBoundCopyNeverReadsFromItsStatistics(bool kid)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        rig.View.AddSeason(rig.HdCopy, new JfSeason { ItemId = Guid.NewGuid(), Season = 2 }, rig.Admin.UserId);
        rig.Sonarr.Series[0]["seasons"]!.AsArray().Add(new JsonObject
        {
            ["seasonNumber"] = 2, ["monitored"] = true,
            ["statistics"] = new JsonObject { ["episodeFileCount"] = 1, ["episodeCount"] = 1, ["totalEpisodeCount"] = 1 },
        });
        var request = new RequestFacts { Pending = true, AskedAt = rig.Now.AddDays(-2), AskedByViewer = true };
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(new[] { 2 }, false, request) };
        // Sonarr's episode list is never read here: the season is judged from its statistics.
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default);
        await Task.Delay(20);
        var status = Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default)).Status;
        var where = $"kid {kid}: requested season 2 {status.Stage}/{status.Reason.Code}, almost ready {status.Summary?.AlmostReady}, aired {status.Summary?.Aired}";
        if (kid)
        {
            // The request keeps its own state; no count of the hidden season.
            Assert.True(status.Stage == StatusStage.Asked && (status.Summary?.AlmostReady ?? 0) == 0 && (status.Summary?.Aired ?? 0) == 0, where);
        }
        else
        {
            Assert.True(status.Stage == StatusStage.AlmostReady && status.Summary?.AlmostReady == 1, where);
        }
    }

    [Theory]
    [InlineData(true)]  // S1E1 asked for on its own, then hidden from the kid in the standard copy; Sonarr has no file and nothing queued
    [InlineData(false)] // control: an adult hears that it is missing
    public async Task ARequestedSingleHiddenInTheBoundCopyKeepsTheRequestsOwnState(bool kid)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        // The standard copy's E1 (hidden from the kid) is a missing episode there; Sonarr lost its file long ago.
        var list = rig.View.EpisodesBySeries[rig.HdCopy];
        var e1 = list.Single(x => x.Episode.Episode == 1);
        list.Remove(e1);
        list.Add((new JfEpisode { ItemId = e1.Episode.ItemId, Season = 1, Episode = 1, Virtual = true }, new HashSet<Guid> { rig.Admin.UserId, viewer.UserId }));
        rig.View.Items.Remove(e1.Episode.ItemId);
        if (kid) list[^1] = (list[^1].Episode, new HashSet<Guid> { rig.Admin.UserId });
        rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 101)["hasFile"] = false;
        rig.View.Rev++;
        var request = new RequestFacts { Pending = true, AskedAt = rig.Now.AddDays(-2), AskedByViewer = true };
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(Array.Empty<int>(), false, request, Episodes: new[] { (1, 1) }) };
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        var status = Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true)).Status;
        Assert.True(kid ? status.Stage == StatusStage.Asked : status.Stage == StatusStage.Looking, $"kid {kid}: requested S1E1 {status.Stage}/{status.Reason.Code}");
    }

    // ------------------------------------------------------------------ shape 1: raw Sonarr facts are unreachable

    [Fact]
    public void RawSonarrFactsAreReachableOnlyThroughAMaskedRead()
    {
        // The raw facts can be given (init) but never read back outside the facts type itself.
        foreach (var name in new[] { "Series", "Episodes", "Queue", "History" })
        {
            var property = typeof(ArrCopyFacts).GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(property);
            var getter = property!.GetGetMethod(nonPublic: true);
            Assert.True(getter == null || getter.IsPrivate, $"ArrCopyFacts.{name} can be read outside its own type");
        }
        // The one read of a Sonarr copy takes its mask; the masked read exposes the facts.
        var through = typeof(ArrCopyFacts).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(m => m.Name == "Through").ToList();
        Assert.NotEmpty(through);
        Assert.All(through, m => Assert.True(m.GetParameters().Length == 1, m.ToString()));
        var read = through[0].ReturnType;
        foreach (var name in new[] { "Series", "Episodes", "Queue", "History", "Mask" })
            Assert.True(read.GetProperty(name)?.GetGetMethod() != null, $"{read.Name}.{name}");
    }

    // ------------------------------------------------------------------ ED-R14-2: a copy's own gap is that copy's gap

    /// <summary>One library holds both folders, both Sonarrs linked to it (the 4K folder has S1E1 only), optionally grouped.</summary>
    internal static Rig OneLibrary(bool grouped)
    {
        var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        var library = Guid.NewGuid().ToString("N");
        var copies = rig.View.CopiesByKey[Firefly.ToString()];
        for (var i = 0; i < copies.Count; i++)
        {
            var c = copies[i].Copy;
            copies[i] = (new JfCopy { ItemId = c.ItemId, Path = c.Path, LibraryId = library, LibraryName = "TV", DateCreated = c.DateCreated }, copies[i].VisibleTo);
        }
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var rows = JsonNode.Parse(config.SonarrInstances)!.AsArray();
        foreach (var row in rows) row!["LinkedLibraryIds"] = new JsonArray(library);
        config.SonarrInstances = rows.ToJsonString();
        var uhdE2 = rig.View.EpisodesBySeries[rig.UhdCopy].Single(x => x.Episode.Episode == 2).Episode.ItemId;
        rig.View.EpisodesBySeries[rig.UhdCopy].RemoveAll(x => x.Episode.Episode == 2);
        rig.View.Items.Remove(uhdE2);
        rig.Sonarr4k!.Episodes.Single(e => (int)e["id"]! == 102)["hasFile"] = false;
        if (grouped) rig.View.GroupSeries(rig.HdCopy, rig.UhdCopy);
        return rig;
    }

    internal static JsonObject Aired(int id, int number)
        => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = number, ["airDateUtc"] = $"2002-10-0{number}T00:00:00Z", ["hasFile"] = false, ["monitored"] = true };

    /// <summary>The season page item of a series copy's own season 1.</summary>
    internal static Guid SeasonPage(Rig rig, Guid copy)
    {
        var id = rig.View.SeasonsBySeries[copy].Single().Season.ItemId;
        rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "season", Key = Firefly.WithSeason(1), SeriesId = copy, Season = 1 });
        return id;
    }

    internal static JsonElement EpisodeOf(JsonElement season, int number)
        => season.GetProperty("episodes").EnumerateArray().Single(e => e.GetProperty("episode").GetInt32() == number);

    internal static string? GapOf(JsonElement episode) => episode.TryGetProperty("copyGap", out var gap) ? gap.GetString() : null;

    [Theory]
    [InlineData(true)]  // the finding: one grouped show; the 4K folder's E3 plays beside the standard copy's rows
    [InlineData(false)] // the same folders, not grouped: another copy the viewer opens plays it all the same
    public async Task AGapAnotherCopyPlaysIsShownAsThatCopysGap(bool grouped)
    {
        using var rig = OneLibrary(grouped);
        // Both Sonarrs know E3 and E4 (aired long ago, monitored, no file); only the 4K folder plays E3, nobody E4; only the
        // standard folder plays E2.
        rig.Sonarr.Episodes.Add(Aired(103, 3));
        rig.Sonarr.Episodes.Add(Aired(104, 4));
        rig.Sonarr4k!.Episodes.Add(Aired(103, 3));
        rig.Sonarr4k.Episodes.Add(Aired(104, 4));
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        rig.Sonarr4k.Episodes.Single(e => (int)e["id"]! == 103)["hasFile"] = true;
        var where = $"grouped {grouped}";

        var standard = await Page(rig, rig.Member, SeasonPage(rig, rig.HdCopy));
        var e3 = EpisodeOf(standard, 3);
        var e4 = EpisodeOf(standard, 4);
        Assert.True(GapOf(e3) == "standard" && e3.GetProperty("stage").GetString() == StatusStage.Looking, $"{where}: standard E3 {e3}");
        // Control: no copy they open has E4, so it stays plainly missing.
        Assert.True(GapOf(e4) == null && e4.GetProperty("stage").GetString() == StatusStage.Looking, $"{where}: standard E4 {e4}");

        var fourK = await Page(rig, rig.Member, SeasonPage(rig, rig.UhdCopy));
        Assert.True(GapOf(EpisodeOf(fourK, 2)) == "4k", $"{where}: 4K E2 {EpisodeOf(fourK, 2)}");
        Assert.Null(GapOf(EpisodeOf(fourK, 4)));
        Assert.Null(GapOf(EpisodeOf(fourK, 1)));
    }

    [Fact]
    public async Task AGapIsNeverQualifiedByACopyTheViewerCannotOpenOrPlay()
    {
        using var rig = OneLibrary(grouped: true);
        rig.Sonarr.Episodes.Add(Aired(103, 3));
        var e3 = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        // The 4K folder's E3 is above the kid's parental limit: for them E3 is missing, not another copy's.
        var kid = rig.View.AddUser(admin: false, parental: true);
        var list = rig.View.EpisodesBySeries[rig.UhdCopy];
        var entry = list.Single(x => x.Episode.ItemId == e3);
        list.Remove(entry);
        list.Add((entry.Episode, new HashSet<Guid> { rig.Admin.UserId, rig.Member.UserId }));
        if (rig.View.Items.TryGetValue(e3, out var item)) rig.View.Items[e3] = new FakeJellyfinView.Item(item.Ref, new HashSet<Guid> { rig.Admin.UserId, rig.Member.UserId });
        rig.View.Rev++;
        var page = SeasonPage(rig, rig.HdCopy);
        Assert.Null(GapOf(EpisodeOf(await Page(rig, kid, page), 3)));
        Assert.Equal("standard", GapOf(EpisodeOf(await Page(rig, rig.Member, page), 3)));
        // Someone who can't open the 4K copy at all: E3 is missing for them, whatever that copy plays (its E3 itself unrestricted).
        var standardOnly = rig.View.AddUser(admin: false, policy: "standard-only");
        var unrestricted = list.FindIndex(x => x.Episode.ItemId == e3);
        list[unrestricted] = (list[unrestricted].Episode, null);
        var copies = rig.View.CopiesByKey[Firefly.ToString()];
        var uhd = copies.FindIndex(x => x.Copy.ItemId == rig.UhdCopy);
        copies[uhd] = (copies[uhd].Copy, new HashSet<Guid> { rig.Admin.UserId, rig.Member.UserId, kid.UserId });
        rig.View.Rev++;
        Assert.Null(GapOf(EpisodeOf(await Page(rig, standardOnly, page), 3)));
    }

    // ------------------------------------------------------------------ ED-R14-3: the grouped-list guard, by symbol

    /// <summary>
    /// Every method (and constructor) of an assembly with the methods its IL calls, takes a delegate to (ldftn/ldvirtftn) or
    /// loads as a token (ldtoken: an expression tree's method, a reflection handle; D53, edition round 15: token operands).
    /// </summary>
    internal static IEnumerable<(MethodBase Caller, MethodBase Callee)> Calls(Assembly assembly)
    {
        var codes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static).Select(f => (OpCode)f.GetValue(null)!).ToDictionary(o => o.Value);
        Type[] types;
        try { types = assembly.GetTypes(); }
        catch (ReflectionTypeLoadException e) { types = e.Types.OfType<Type>().ToArray(); }
        const BindingFlags all = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        foreach (var type in types)
        {
            foreach (var method in type.GetMethods(all).Cast<MethodBase>().Concat(type.GetConstructors(all)))
            {
                byte[]? il;
                try { il = method.GetMethodBody()?.GetILAsByteArray(); }
                catch (Exception) { il = null; }
                if (il == null) continue;
                for (var i = 0; i < il.Length;)
                {
                    var op = il[i] == 0xFE ? codes[unchecked((short)(0xFE00 | il[i + 1]))] : codes[il[i]];
                    i += op.Size;
                    if (op.OperandType is OperandType.InlineMethod or OperandType.InlineTok)
                    {
                        MethodBase? callee = null;
                        try
                        {
                            // ldtoken names a type, field or method: only a method is a symbol judged here.
                            callee = method.Module.ResolveMember(BitConverter.ToInt32(il, i), type.IsGenericType ? type.GetGenericArguments() : null, method.IsGenericMethod ? method.GetGenericArguments() : null) as MethodBase;
                        }
                        catch (Exception)
                        {
                            // A token into an assembly the test host doesn't load: not one of the symbols judged here.
                        }
                        if (callee != null) yield return (method, callee);
                    }
                    i += op.OperandType switch
                    {
                        OperandType.InlineNone => 0,
                        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                        OperandType.InlineVar => 2,
                        OperandType.InlineI8 or OperandType.InlineR => 8,
                        OperandType.InlineSwitch => 4 + (4 * BitConverter.ToInt32(il, i)),
                        _ => 4,
                    };
                }
            }
        }
    }

    /// <summary>The source-level method a compiled method belongs to (lambdas, local functions and async state machines included): "Type.Method".</summary>
    internal static string Owner(MethodBase method)
    {
        var type = method.DeclaringType!;
        var name = method.Name;
        if (name.StartsWith('<')) name = name[1..name.IndexOf('>')];
        while (type.Name.StartsWith('<') && type.DeclaringType != null)
        {
            // An async or iterator state machine is named for its method; a closure class (<>c...) isn't.
            if (!type.Name.StartsWith("<>", StringComparison.Ordinal) && (name == "MoveNext" || name.Length == 0)) name = type.Name[1..type.Name.IndexOf('>')];
            type = type.DeclaringType;
        }
        return type.Name + "." + name;
    }

    /// <summary>True for a call to Jellyfin's grouped lists: IArrJellyfinView.Episodes/Seasons (on any implementation) or native Series/Season episode and season lists.</summary>
    internal static bool GroupedList(MethodBase callee)
    {
        var declaring = callee.DeclaringType;
        if (declaring == null) return false;
        if (declaring.Namespace == "MediaBrowser.Controller.Entities.TV" && declaring.Name is "Series" or "Season"
            && callee.Name.StartsWith("Get", StringComparison.Ordinal) && (callee.Name.Contains("Episodes", StringComparison.Ordinal) || callee.Name.Contains("Seasons", StringComparison.Ordinal)))
            return true;
        if (declaring == typeof(IArrJellyfinView)) return callee.Name is "Episodes" or "Seasons";
        if (!typeof(IArrJellyfinView).IsAssignableFrom(declaring) || declaring.IsInterface || callee is not MethodInfo info) return false;
        var map = declaring.GetInterfaceMap(typeof(IArrJellyfinView));
        var at = Array.IndexOf(map.TargetMethods, info);
        return at >= 0 && map.InterfaceMethods[at].Name is "Episodes" or "Seasons";
    }

    /// <summary>The source-level methods of an assembly that call Jellyfin's grouped lists, with what they call.</summary>
    internal static SortedSet<string> GroupedListReaders(Assembly assembly)
        => new(Calls(assembly).Where(c => GroupedList(c.Callee)).Select(c => Owner(c.Caller)), StringComparer.Ordinal);

    /// <summary>Planted bypasses (never called): each reads a grouped list another way than the old literal "_view." guard saw.</summary>
    private static class Planted
    {
        public static int OtherReceiver(ArrStatusService service, Guid id, StatusViewer viewer) => service.View.Episodes(id, null, viewer, false).Count;

        public static int ThroughAHelper(IArrJellyfinView view, Guid id, StatusViewer viewer) => Helper(view, id, viewer);

        private static int Helper(IArrJellyfinView view, Guid id, StatusViewer viewer) => view.Seasons(id, viewer).Count;

        public static int InALambda(IArrJellyfinView view, IEnumerable<Guid> ids, StatusViewer viewer) => ids.Sum(id => view.Episodes(id, 1, viewer, true).Count);

        public static Func<Guid, StatusViewer, IReadOnlyList<JfSeason>> AsADelegate(IArrJellyfinView view) => view.Seasons;

        public static async Task<int> InAnAsyncMethod(IArrJellyfinView view, Guid id, StatusViewer viewer)
        {
            await Task.Yield();
            return view.Seasons(id, viewer).Count;
        }

        public static int OnTheConcreteType(ArrJellyfinView view, Guid id, StatusViewer viewer) => view.Episodes(id, null, viewer, false).Count;

        public static int Native(MediaBrowser.Controller.Entities.TV.Series series, Jellyfin.Database.Implementations.Entities.User user)
            => series.GetSeasons(user, new MediaBrowser.Controller.Dto.DtoOptions(false)).Count;

        // ED-R15-3: an expression tree names its method by token (ldtoken), never by a call.
        public static int InAnExpression(IArrJellyfinView view, Guid id, StatusViewer viewer)
        {
            Expression<Func<int>> read = () => view.Episodes(id, null, viewer, false).Count;
            return read.Compile()();
        }

        public static Expression<Func<IArrJellyfinView, Guid, StatusViewer, IReadOnlyList<JfSeason>>> AnExpressionReturned()
            => (view, id, viewer) => view.Seasons(id, viewer);

        // The masked-read guard's own plants: a read of a Sonarr copy made outside its binding, by token and by delegate.
        public static ArrCopyRead ThroughInAnExpression(ArrCopyFacts facts)
        {
            Expression<Func<ArrCopyRead>> read = () => facts.Through(HiddenParts.None);
            return read.Compile()();
        }

        public static Func<HiddenParts, ArrCopyRead> ThroughAsADelegate(ArrCopyFacts facts) => facts.Through;
    }

    [Fact]
    public void TheSymbolGuardCatchesEveryPlantedBypass()
    {
        var found = GroupedListReaders(typeof(IntegrationEditionMaskedTests).Assembly);
        foreach (var planted in new[] { "OtherReceiver", "Helper", "InALambda", "AsADelegate", "InAnAsyncMethod", "OnTheConcreteType", "Native", "InAnExpression", "AnExpressionReturned" })
            Assert.True(found.Contains("Planted." + planted), $"Planted.{planted} not seen: {string.Join(", ", found.Where(f => f.StartsWith("Planted.", StringComparison.Ordinal)))}");
        Assert.DoesNotContain("Planted.ThroughAHelper", found);
    }

    /// <summary>
    /// The only production methods that may read Jellyfin's grouped lists, each for a reason no Sonarr fact passes through:
    /// the lists themselves, the native season page's rows, the hidden-part request gate, and features outside Requests &amp;
    /// downloads that present Jellyfin's own season (item stats, Spoiler Guard). The auto-request presence count reads the
    /// availability predicate since edition round 19 part B (its grouped rows counted one episode's versions twice).
    /// </summary>
    private static readonly string[] GroupedListExceptions =
    {
        "ArrJellyfinView.Episodes",           // the presented list itself (IArrJellyfinView.Episodes)
        "ArrJellyfinView.Seasons",            // the presented list itself (IArrJellyfinView.Seasons)
        "ArrJellyfinView.VisibleEpisodeIds",  // the presented list's own hidden markers (part of Episodes)
        "ItemStatsService.Collect",           // item stats of Jellyfin's own season (no arr fact)
        "RequestPolicy.NativeScopeAllowed",   // the hidden-part request gate (a part a copy they open plays is theirs)
        "SeasonRowsService.ForSeasonAsync",   // the native season page's rows (presentation)
        "SpoilerBlurImageFilter.HasWatchedAnyEpisodeInSeason",            // Spoiler Guard: what the viewer watched in Jellyfin's own season
        "SpoilerFieldStripFilter.HasWatchedAnyEpisodeInSeasonServerSide", // (no arr fact in any of them)
        "SpoilerTagDataStripper.HasWatchedAnyEpisode",
        "SpoilerTagDataStripper.StripTagCache",
    };

    [Fact]
    public void GroupedListsAreReadOnlyByNamedPresentationMethods()
    {
        var found = GroupedListReaders(typeof(ArrStatusService).Assembly);
        Assert.True(GroupedListExceptions.OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(found), "grouped-list readers: " + string.Join(", ", found));
    }

    /// <summary>The source-level methods of an assembly that create a masked read of a Sonarr copy (any IL operand naming Through).</summary>
    internal static SortedSet<string> MaskedReadCreators(Assembly assembly)
    {
        var through = typeof(ArrCopyFacts).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(m => m.Name == "Through").Cast<MethodBase>().ToHashSet();
        Assert.NotEmpty(through);
        return new SortedSet<string>(Calls(assembly).Where(c => through.Contains(c.Callee)).Select(c => Owner(c.Caller)), StringComparer.Ordinal);
    }

    [Fact]
    public void TheMaskedReadGuardCatchesEveryPlantedBypass()
    {
        var found = MaskedReadCreators(typeof(IntegrationEditionMaskedTests).Assembly);
        foreach (var planted in new[] { "ThroughInAnExpression", "ThroughAsADelegate" })
            Assert.True(found.Contains("Planted." + planted), $"Planted.{planted} not seen: {string.Join(", ", found)}");
    }

    /// <summary>The production methods that create a masked read of a Sonarr copy: the bindings and the pages' own copy.</summary>
    [Fact]
    public void ASonarrCopyIsMaskedOnlyWhereItIsBound()
    {
        var callers = MaskedReadCreators(typeof(ArrStatusService).Assembly);
        // (ArrCopyFacts.Through: its eager overload calls the lazy one.)
        Assert.True(new[] { "ArrCopyFacts.Through", "SeriesBinding.Read", "StatusComposer.PageRead", "StatusComposer.RequestedSeasons", "StatusComposer.SeriesCard" }.SequenceEqual(callers), "masked-read creators: " + string.Join(", ", callers));
    }
}
