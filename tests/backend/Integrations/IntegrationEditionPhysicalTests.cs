using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition round 13 (D53: physical reads only). A Sonarr copy's binding reads exactly ONE physical series folder, the one it
/// owns: its episodes, its seasons and what Jellyfin hides from the viewer there, in one read per answer, never the folders
/// Jellyfin's automatic series grouping presents with it. Every Sonarr fact a viewer hears passes that binding's own hidden
/// mask: a requested single episode, an absent title's series, season and episode pages, the family Search. Controls: separate
/// (ungrouped) copies, and viewers with nothing hidden.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionPhysicalTests
{
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    private static List<JsonElement> Items(StatusBody body)
    {
        using var doc = JsonDocument.Parse(body.Json);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }

    /// <summary>Asked twice, so the arr reads the first one started have landed.</summary>
    private static async Task<StatusBody> Twice(Func<Task<StatusBody>> ask)
    {
        await ask();
        await Task.Delay(20);
        return await ask();
    }

    private static async Task<JsonElement> ByKey(Rig rig, StatusViewer viewer)
        => Assert.Single(Items(await Twice(() => rig.Service.ForBatchAsync(viewer, Array.Empty<Guid>(), new[] { Firefly }, default))));

    private static async Task<JsonElement> Card(Rig rig, StatusViewer viewer, Guid id)
        => Assert.Single(Items(await Twice(() => rig.Service.ForBatchAsync(viewer, new[] { id }, Array.Empty<TitleKey>(), default))));

    private static async Task<JsonElement> Page(Rig rig, StatusViewer viewer, Guid id)
        => Assert.Single(Items(await Twice(() => rig.Service.ForItemAsync(viewer, id, default))));

    private static string Stage(JsonElement status) => status.GetProperty("stage").GetString()!;

    private static int Summary(JsonElement status, string field)
        => status.TryGetProperty("summary", out var summary) && summary.TryGetProperty(field, out var n) ? n.GetInt32() : 0;

    private static JsonElement? Line(JsonElement status, string instance)
    {
        if (!status.TryGetProperty("admin", out var admin) || !admin.TryGetProperty("variants", out var variants)) return null;
        foreach (var v in variants.EnumerateArray())
        {
            if (v.GetProperty("instance").GetString() == instance && !v.TryGetProperty("scope", out _)) return v;
        }
        return null;
    }

    private static string? LineStage(JsonElement status, string instance) => Line(status, instance)?.GetProperty("stage").GetString();

    /// <summary>A Sonarr knows S1E3 (aired, monitored, no file) and is downloading the episodes in <paramref name="queued"/>.</summary>
    private static void KnowsE3(FakeArr.Host sonarr, string tag, params int[] queued)
    {
        sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        foreach (var e in queued) sonarr.Queue.Add(FakeArr.SonarrQueueRow(100 + e, tag + (100 + e), 1, e, "Firefly", 78874));
    }

    /// <summary>Jellyfin hides <paramref name="copy"/>'s own episode <paramref name="number"/> of season 1 from everyone but the administrator.</summary>
    private static Guid HideEpisode(Rig rig, Guid copy, int number)
    {
        var list = rig.View.EpisodesBySeries[copy];
        var e = list.Single(x => x.Episode.Episode == number && x.Episode.Season == 1);
        list.Remove(e);
        list.Add((e.Episode, new HashSet<Guid> { rig.Admin.UserId }));
        if (rig.View.Items.TryGetValue(e.Episode.ItemId, out var item)) rig.View.Items[e.Episode.ItemId] = new FakeJellyfinView.Item(item.Ref, new HashSet<Guid> { rig.Admin.UserId });
        rig.View.Rev++;
        return e.Episode.ItemId;
    }

    /// <summary>Jellyfin lists the title's 4K copy first (the order a library query may give).</summary>
    private static void FourKFirst(Rig rig) => rig.View.CopiesByKey[Firefly.ToString()].Reverse();

    /// <summary>
    /// One library holds both folders and both Sonarrs are linked to it; with <paramref name="grouped"/> Jellyfin's automatic
    /// series grouping shows them as one show (its grouped lists of either hold both folders' children). The 4K copy has only S1E1.
    /// </summary>
    private static Rig OneLibrary(bool grouped, bool fourKFirst)
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
        if (fourKFirst) FourKFirst(rig);
        return rig;
    }

    // ------------------------------------------------------------------ ED-R13-1: a requested single passes the bound copy's mask

    [Theory]
    [InlineData(true)]  // the finding: S1E1 asked for on its own, then hidden from the kid in the standard copy, downloading there
    [InlineData(false)] // control: a single the kid may see (S1E3, missing) shows its download
    public async Task ARequestedSingleHiddenInTheBoundCopyNeverReadsAsADownload(bool hidden)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var kid = rig.View.AddUser(admin: false, parental: true);
        KnowsE3(rig.Sonarr, "single", 1, 3);
        if (hidden) HideEpisode(rig, rig.HdCopy, 1);
        var picked = hidden ? (1, 1) : (1, 3);
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(Array.Empty<int>(), false, null, Episodes: new[] { picked }) };
        await rig.Service.ComposeForAsync(kid, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        var status = Assert.Single(await rig.Service.ComposeForAsync(kid, new[] { Firefly }, scopes, default, loadEpisodes: true)).Status;
        if (hidden)
        {
            Assert.True(status.Stage != StatusStage.Downloading && status.Progress == null && (status.Summary?.Downloading ?? 0) == 0,
                $"requested hidden single: {status.Stage} {status.Progress?.Percent}% downloading {status.Summary?.Downloading}");
            Assert.NotEqual(StatusStage.Ready, status.Stage);
        }
        else
        {
            Assert.Equal(StatusStage.Downloading, status.Stage);
        }
    }

    [Theory]
    [InlineData(true)]  // season 2 is hidden from the kid as a whole in the standard copy (its season item; no episodes there yet)
    [InlineData(false)] // control: an adult follows its download
    public async Task ARequestedSeasonHiddenInTheBoundCopyNeverReadsAsADownload(bool kid)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        rig.View.AddSeason(rig.HdCopy, new JfSeason { ItemId = Guid.NewGuid(), Season = 2 }, rig.Admin.UserId);
        rig.Sonarr.Series[0]["seasons"]!.AsArray().Add(new JsonObject { ["seasonNumber"] = 2, ["monitored"] = true });
        rig.Sonarr.Episodes.Add(new JsonObject { ["id"] = 201, ["seriesId"] = 1, ["seasonNumber"] = 2, ["episodeNumber"] = 1, ["airDateUtc"] = "2003-09-20T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(201, "s2", 2, 1, "Firefly", 78874));
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(new[] { 2 }, false, null) };
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        var status = Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true)).Status;
        Assert.True((status.Stage == StatusStage.Downloading) == !kid, $"kid {kid}: requested season 2 {status.Stage} {status.Progress?.Percent}%");
    }

    // ------------------------------------------------------------------ ED-R13-2: an absent page passes the bound copy's own mask

    /// <summary>
    /// An absent (synthetic) page of the series, its season 1 or S1E1, with what the library hides from the viewer TITLE-WIDE: as
    /// the native details facade builds it, a number some copy they can open plays is not hidden there.
    /// </summary>
    private static AbsentTitle AbsentPage(string kind)
    {
        var episodes = new[] { 1, 2 }.Select(n => new AbsentEpisode(1, n, new DateTime(2002, 9, 20 + n, 0, 0, 0, DateTimeKind.Utc), Guid.NewGuid())).ToArray();
        return kind switch
        {
            "series" => new AbsentTitle { PageId = Guid.NewGuid(), Kind = "series", Title = Firefly, TmdbId = 1437, Seasons = new[] { new AbsentSeason(1, 2, 2, null, Guid.NewGuid()) } },
            "season" => new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = Firefly, TmdbId = 1437, Season = 1, Rows = true, Episodes = episodes },
            _ => new AbsentTitle { PageId = Guid.NewGuid(), Kind = "episode", Title = Firefly, TmdbId = 1437, Season = 1, Episode = 1 },
        };
    }

    private static async Task<JsonElement> Absent(Rig rig, StatusViewer viewer, AbsentTitle page)
        => Assert.Single(Items(await Twice(() => rig.Service.ForAbsentAsync(viewer, page, default))));

    [Theory]
    [InlineData("series", true)]   // the finding: the standard copy's S1E1 is hidden from the kid, the 4K copy's plays for them
    [InlineData("season", true)]
    [InlineData("episode", true)]
    [InlineData("series", false)]  // control: someone with nothing hidden follows the standard Sonarr's download of S1E1
    [InlineData("season", false)]
    [InlineData("episode", false)]
    public async Task AnAbsentPageReadsItsSonarrThroughItsOwnCopysHiddenParts(string kind, bool kid)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        HideEpisode(rig, rig.HdCopy, 1);
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(101, "hiddenHD", 1, 1, "Firefly", 78874));
        var status = await Absent(rig, viewer, AbsentPage(kind));
        var downloading = Stage(status) == StatusStage.Downloading || Summary(status, "downloading") > 0 || status.TryGetProperty("progress", out _);
        Assert.True(downloading == !kid, $"{kind} page, kid {kid}: {Stage(status)} downloading {Summary(status, "downloading")}");
    }

    // ------------------------------------------------------------------ ED-R13-3: a binding reads exactly one physical folder

    [Theory]
    [InlineData(true, false)]  // the finding: grouped folders; Sonarr 4K downloads S1E2, which only the standard folder has
    [InlineData(true, true)]
    [InlineData(false, false)] // control: the same folders, not grouped (r12's case)
    public async Task UnderSeriesGroupingEachSonarrReadsOnlyItsOwnFolder(bool grouped, bool fourKFirst)
    {
        using var rig = OneLibrary(grouped, fourKFirst);
        rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "e2", 1, 2, "Firefly", 78874));
        var where = $"grouped {grouped}, 4K first {fourKFirst}";

        var key = await ByKey(rig, rig.Admin);
        Assert.True(LineStage(key, "Sonarr4kZ") == StatusStage.Downloading, $"{where}: by key Sonarr 4K line {LineStage(key, "Sonarr4kZ")}");
        Assert.True(LineStage(key, "SonarrZ") == StatusStage.Ready, $"{where}: by key Sonarr line {LineStage(key, "SonarrZ")}");
        var hdPage = await Page(rig, rig.Admin, rig.HdCopy);
        var uhdPage = await Page(rig, rig.Admin, rig.UhdCopy);
        Assert.True(LineStage(hdPage, "Sonarr4kZ") == StatusStage.Downloading, $"{where}: HD page Sonarr 4K line {LineStage(hdPage, "Sonarr4kZ")}");
        Assert.Equal(1, Summary(uhdPage, "downloading"));
        Assert.Equal(0, Summary(hdPage, "downloading"));
        Assert.Equal(1, Summary(await Card(rig, rig.Member, rig.UhdCopy), "downloading"));
    }

    [Theory]
    [InlineData(true)]  // the finding: only the 4K folder (grouped with the standard one) has S1E3
    [InlineData(false)] // control: not grouped
    public async Task UnderSeriesGroupingAFamilySearchJudgesTheStandardSonarrByItsOwnFolder(bool grouped)
    {
        using var rig = OneLibrary(grouped, fourKFirst: false);
        KnowsE3(rig.Sonarr, "none");
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly, 5, null, default);
        await Task.Delay(20);
        var searched = await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly, 5, null, default);
        Assert.True(searched.Count == 1 && searched[0].Episodes.Select(e => e.Episode).SequenceEqual(new[] { 3 }), $"grouped {grouped}: {string.Join(";", searched.Select(s => s.InstanceId + ":" + string.Join(",", s.Episodes.Select(e => e.Episode))))}");
        Assert.NotNull((await rig.Service.SearchableInstanceAsync(rig.Member, Firefly.WithEpisode(1, 3), null, default)).InstanceId);
    }

    [Theory]
    [InlineData(true)]  // S1E3 is hidden from the kid in the standard copy (a missing episode above their limit); the 4K copy plays it
    [InlineData(false)] // control: nothing hidden, so the standard copy's missing S1E3 is searched
    public async Task AFamilySearchNeverSearchesAPartHiddenInTheBindingsOwnCopy(bool hidden)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        KnowsE3(rig.Sonarr, "none");
        var kid = rig.View.AddUser(admin: false, parental: true);
        rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 3, 3840, 2160, rig.Now.AddDays(-1));
        if (hidden) rig.View.AddEpisode(rig.HdCopy, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, Virtual = true }, rig.Admin.UserId);
        await rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default);
        await Task.Delay(20);
        var searched = (await rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default)).SelectMany(s => s.Episodes).Select(e => e.Episode).ToList();
        Assert.True(searched.Contains(3) == !hidden, $"hidden {hidden}: searched {string.Join(",", searched)}");
        Assert.True((await rig.Service.SearchableInstanceAsync(kid, Firefly.WithEpisode(1, 3), null, default)).InstanceId == null == hidden);
    }

    [Theory]
    [InlineData(true, true)]   // the finding: the standard copy's S1E1 is hidden from the kid; the grouped 4K folder's S1E1 plays
    [InlineData(true, false)]  // grouped, nothing hidden: the page still names its own folder's season
    [InlineData(false, true)]  // control: not grouped
    public async Task UnderSeriesGroupingAPageNeverPairsItsHiddenEpisodeWithTheOtherFoldersFile(bool grouped, bool kid)
    {
        using var rig = new Rig(grouped ? Layout.GroupedFolders : Layout.SeparateLibraries, Has.Both, movie: false);
        var viewer = kid ? rig.View.AddUser(admin: false, parental: true) : rig.View.AddUser(admin: false, policy: "same");
        if (kid) HideEpisode(rig, rig.HdCopy, 1);
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(101, "e1", 1, 1, "Firefly", 78874));
        var hdSeason = rig.View.SeasonsBySeries[rig.HdCopy].Single().Season.ItemId;
        rig.View.AddItem(new JfItemRef { ItemId = hdSeason, Kind = "season", Key = Firefly.WithSeason(1), SeriesId = rig.HdCopy, Season = 1 });
        var otherFolder = rig.View.EpisodesBySeries[rig.UhdCopy].Select(e => e.Episode.ItemId.ToString("N"))
            .Concat(rig.View.SeasonsBySeries[rig.UhdCopy].Select(s => s.Season.ItemId.ToString("N"))).ToList();
        var where = $"grouped {grouped}, kid {kid}";

        // The standard series page names its own season, never the grouped folder's.
        var series = await Page(rig, viewer, rig.HdCopy);
        Assert.Equal(hdSeason.ToString("N"), series.GetProperty("seasons")[0].GetProperty("itemId").GetString());
        var season = await Page(rig, viewer, hdSeason);
        var rows = season.GetProperty("episodes").EnumerateArray().ToList();
        Assert.DoesNotContain(rows, r => r.TryGetProperty("itemId", out var id) && otherFolder.Contains(id.GetString()!));
        // Hidden from the kid in the standard folder: no row and no count; the queue of it is not theirs (never an upgrade of
        // the other folder's file).
        Assert.True(rows.Any(r => r.GetProperty("episode").GetInt32() == 1) == !kid, $"{where}: S1E1 row {rows.Count}");
        Assert.True(Summary(series, "aired") == (kid ? 1 : 2), $"{where}: aired {Summary(series, "aired")}");
    }

    // ------------------------------------------------------------------ ED-R13-4 and rule 3: one read per binding per answer

    [Theory]
    [InlineData(true)]  // the finding: an administrator's page of a folder two Sonarrs share
    [InlineData(false)] // a kid's (parental limits: their hidden parts come from the same read)
    public async Task AFolderTwoSonarrsShareIsReadOncePerAnswer(bool admin)
    {
        using var rig = new Rig(Layout.SharedFolder4kArr, Has.Both, movie: false);
        rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "e2", 1, 2, "Firefly", 78874));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(101, "e1", 1, 1, "Firefly", 78874));
        var viewer = admin ? rig.Admin : rig.View.AddUser(admin: false, parental: true);
        await Page(rig, viewer, rig.HdCopy);
        rig.Service.Cache.Clear();
        rig.View.ReadsOf.Clear();
        Assert.Single(Items(await rig.Service.ForItemAsync(viewer, rig.HdCopy, default)));
        Assert.Equal(1, rig.View.ReadsOf.GetValueOrDefault(rig.HdCopy));
    }

    [Fact]
    public async Task EachGroupedFolderIsReadOncePerAnswer()
    {
        using var rig = OneLibrary(grouped: true, fourKFirst: false);
        rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "e2", 1, 2, "Firefly", 78874));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(101, "e1", 1, 1, "Firefly", 78874));
        KnowsE3(rig.Sonarr, "none");
        var kid = rig.View.AddUser(admin: false, parental: true);
        await Card(rig, kid, rig.HdCopy);
        await ByKey(rig, kid);
        await rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default);
        await Task.Delay(20);

        async Task Once(string what, Func<Task> answer)
        {
            rig.Service.Cache.Clear();
            rig.View.ReadsOf.Clear();
            await answer();
            Assert.True(rig.View.ReadsOf.Values.All(n => n == 1), $"{what}: {string.Join(", ", rig.View.ReadsOf.Select(r => (r.Key == rig.HdCopy ? "HD" : r.Key == rig.UhdCopy ? "4K" : "?") + "=" + r.Value))}");
        }

        await Once("cards and key", () => rig.Service.ForBatchAsync(kid, new[] { rig.HdCopy, rig.UhdCopy }, new[] { Firefly }, default));
        await Once("standard page", () => rig.Service.ForItemAsync(kid, rig.HdCopy, default));
        await Once("4K page", () => rig.Service.ForItemAsync(kid, rig.UhdCopy, default));
        await Once("family Search", () => rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default));
    }

    // ------------------------------------------------------------------ rule 1: the folder read is physical

    private static string Root([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }

    private static string Body(string source, string signature)
    {
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, signature);
        var open = source.IndexOf('{', start);
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}' && --depth == 0) return source[open..(i + 1)];
        }
        throw new InvalidOperationException("unbalanced " + signature);
    }

    [Fact]
    public void TheFolderReadQueriesTheSeriesItemsOwnAncestry()
    {
        // Who may read Jellyfin's grouped lists is judged by symbol (IntegrationEditionMaskedTests, edition round 14); the folder
        // read itself queries the series item's own ancestry, never its presentation key.
        var view = Body(File.ReadAllText(Path.Combine(Root(), "Services", "Acquire", "ArrJellyfinView.cs")), "public JfSeriesFolder SeriesFolder(");
        Assert.Contains("AncestorIds", view, StringComparison.Ordinal);
        foreach (var banned in new[] { "GetEpisodes(", "GetSeasons(", "PresentationUniqueKey", "VisibleEpisodeIds(" })
            Assert.DoesNotContain(banned, view, StringComparison.Ordinal);
    }
}
