using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition round 12 (D53: one copy binding per viewer, title and instance). A Sonarr copy is read, for one viewer, only
/// through the Jellyfin copy it owns (its exact mapped folder, or the other ownership rules of the pages) that the
/// viewer can open now: its files, the episodes Jellyfin hides from them and its queue all come from that copy. A Sonarr
/// whose copy the viewer can't open says nothing to them, on the cards of titles, the Requests page, the alerts' watch,
/// an absent title's page and the series cards alike; never another copy's files or hidden parts in its place, whichever
/// copy Jellyfin lists first. Each bound copy's episodes are read once per composition.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionBindingTests
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

    private static async Task<JsonElement> Detail(Rig rig, StatusViewer viewer)
        => Assert.Single(Items(await Twice(() => rig.Service.ForKeyDetailAsync(viewer, Firefly, default))));

    private static async Task<JsonElement?> Absent(Rig rig, StatusViewer viewer)
    {
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "series", Title = Firefly, TmdbId = 1437 };
        var items = Items(await Twice(() => rig.Service.ForAbsentAsync(viewer, page, default)));
        return items.Count == 0 ? null : items[0];
    }

    /// <summary>The Requests page and the alerts' watch: the whole series, and season 1 asked for.</summary>
    private static async Task<(TitleStatus Whole, TitleStatus Season)> Requested(Rig rig, StatusViewer viewer)
    {
        var scopes = new Dictionary<TitleKey, ArrStatusService.RequestScope> { [Firefly] = new(new[] { 1 }, false, null) };
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, null, default);
        await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        var whole = Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, null, default));
        var season = Assert.Single(await rig.Service.ComposeForAsync(viewer, new[] { Firefly }, scopes, default, loadEpisodes: true));
        return (whole.Status, season.Status);
    }

    private static string Stage(JsonElement status) => status.GetProperty("stage").GetString()!;

    private static int Summary(JsonElement status, string field)
        => status.TryGetProperty("summary", out var summary) && summary.TryGetProperty(field, out var n) ? n.GetInt32() : 0;

    /// <summary>The admin line of an instance (not a problem line), if the status has one.</summary>
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
    private static void Downloading(FakeArr.Host sonarr, string tag, params int[] queued)
    {
        sonarr.Episodes.Add(new JsonObject { ["id"] = 103, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = 3, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = false, ["monitored"] = true });
        foreach (var e in queued) sonarr.Queue.Add(FakeArr.SonarrQueueRow(100 + e, tag + (100 + e), 1, e, "Firefly", 78874));
    }

    /// <summary>Jellyfin lists the title's 4K copy first (the order a library query may give).</summary>
    private static void FourKFirst(Rig rig) => rig.View.CopiesByKey[Firefly.ToString()].Reverse();

    // ------------------------------------------------------------------ ED-R12-1: a copy the viewer can't open

    [Theory]
    [InlineData(true, false)]  // the finding: Sonarr 4K (the only Sonarr holding it) downloads S1E3 into the 4K copy
    [InlineData(false, false)] // nothing queued: its missing S1E3 is the 4K copy's fact all the same
    [InlineData(true, true)]   // its statistics count no file yet: it still owns the 4K copy
    public async Task ASonarrWhoseOnlyCopyTheViewerCantOpenTellsThemNothing(bool queued, bool countsNoFiles)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        rig.Sonarr.Series.Clear();
        rig.Sonarr.Episodes.Clear();
        if (countsNoFiles) rig.Sonarr4k!.Series[0]["statistics"]!["episodeFileCount"] = 0;
        Downloading(rig.Sonarr4k!, "private4k", queued ? new[] { 3 } : Array.Empty<int>());
        var member = rig.View.Revoke(rig.Member, hide: new[] { rig.UhdCopy });
        var opener = rig.View.AddUser(admin: false, policy: "same");
        Assert.False(rig.View.Copies(Firefly, member).Seen.Single(x => x.ItemId == rig.UhdCopy).Visible);
        Assert.True(rig.View.Copies(Firefly, member).Seen.Single(x => x.ItemId == rig.HdCopy).Visible);

        // The member plays the HD copy, which no Sonarr holds: from the 4K Sonarr they hear nothing, anywhere.
        var key = await ByKey(rig, member);
        Assert.True(Stage(key) == StatusStage.Ready, $"by key: {Stage(key)}");
        Assert.False(key.TryGetProperty("progress", out _));
        Assert.Equal(StatusStage.Ready, Stage(await Detail(rig, member)));
        var (whole, season) = await Requested(rig, member);
        Assert.True(whole.Stage == StatusStage.Ready && whole.Progress == null, $"Requests page: {whole.Stage}");
        Assert.True(season.Stage == StatusStage.Ready && (season.Summary?.Downloading ?? 0) == 0, $"requested season: {season.Stage}/{season.Summary?.Downloading}");
        var card = await Card(rig, member, rig.HdCopy);
        Assert.Equal((StatusStage.Ready, 0), (Stage(card), Summary(card, "downloading")));
        var absent = await Absent(rig, member);
        Assert.NotNull(absent);
        Assert.True(Summary(absent!.Value, "downloading") == 0 && Stage(absent.Value) != StatusStage.Downloading, $"absent page: {Stage(absent.Value)}");

        // Controls: someone who can open the 4K copy, and an administrator, follow its download.
        var expected = queued ? StatusStage.Downloading : StatusStage.Ready;
        Assert.Equal(expected, Stage(await ByKey(rig, opener)));
        Assert.Equal(expected, Stage(await ByKey(rig, rig.Admin)));
        Assert.Equal(queued ? 1 : 0, Summary(await Card(rig, opener, rig.UhdCopy), "downloading"));
    }

    // ------------------------------------------------------------------ ED-R12-2: the hidden parts are the bound copy's

    [Theory]
    [InlineData(true)]  // the finding: the 4K copy (no S1E1 at all) is listed first
    [InlineData(false)] // the standard copy first
    public async Task AnEpisodeHiddenInTheSonarrsOwnCopyNeverReadsAsADownloadWhicheverCopyComesFirst(bool fourKFirst)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        var kid = rig.View.AddUser(admin: false, parental: true);
        // The 4K copy has no S1E1; the standard copy's S1E1 is hidden from the kid (its rating).
        var uhdE1 = rig.View.EpisodesBySeries[rig.UhdCopy].Single(x => x.Episode.Episode == 1).Episode.ItemId;
        rig.View.EpisodesBySeries[rig.UhdCopy].RemoveAll(x => x.Episode.Episode == 1);
        rig.View.Items.Remove(uhdE1);
        var list = rig.View.EpisodesBySeries[rig.HdCopy];
        var e1 = list.Single(x => x.Episode.Episode == 1);
        list.Remove(e1);
        list.Add((e1.Episode, new HashSet<Guid> { rig.Admin.UserId }));
        rig.View.Items[e1.Episode.ItemId] = new FakeJellyfinView.Item(rig.View.Items[e1.Episode.ItemId].Ref, new HashSet<Guid> { rig.Admin.UserId });
        if (fourKFirst) FourKFirst(rig);
        // The standard Sonarr is downloading S1E1 (a better copy of the hidden episode).
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(101, "hiddenHD", 1, 1, "Firefly", 78874));
        Assert.Null(rig.View.Resolve(e1.Episode.ItemId, kid));

        var key = await ByKey(rig, kid);
        Assert.True(Stage(key) == StatusStage.Ready, $"by key: {Stage(key)}");
        Assert.False(key.TryGetProperty("progress", out _));
        var (whole, season) = await Requested(rig, kid);
        Assert.True(whole.Stage == StatusStage.Ready && whole.Progress == null, $"Requests page: {whole.Stage}");
        Assert.True((season.Summary?.Downloading ?? 0) == 0 && season.Stage != StatusStage.Downloading, $"requested season: {season.Stage}/{season.Summary?.Downloading}");
        // The standard copy's own card and page agree (their hidden parts were always their own).
        Assert.Equal(0, Summary(await Card(rig, kid, rig.HdCopy), "downloading"));
        Assert.Equal(0, Summary(await Page(rig, kid, rig.HdCopy), "downloading"));

        // Control: for someone who plays S1E1 it is an upgrade (Ready), never hidden.
        Assert.Equal(StatusStage.Ready, Stage(await ByKey(rig, rig.Admin)));
    }

    // ------------------------------------------------------------------ family Search: each Sonarr through its own binding

    [Fact]
    public async Task AFamilySearchNeverSearchesASonarrWhoseCopyTheViewerCantOpen()
    {
        // The standard Sonarr's copy is in the HD library, which the member can't open; they play the 4K copy.
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        Downloading(rig.Sonarr, "none");
        var member = rig.View.Revoke(rig.Member, hide: new[] { rig.HdCopy });
        await rig.Service.SearchableEpisodesAsync(member, Firefly, 5, null, default);
        await Task.Delay(20);
        Assert.Empty(await rig.Service.SearchableEpisodesAsync(member, Firefly, 5, null, default));
        Assert.Null((await rig.Service.SearchableInstanceAsync(member, Firefly.WithEpisode(1, 3), null, default)).InstanceId);
        // Control: someone who can open the HD copy has its long-missing S1E3 searched.
        var opener = rig.View.AddUser(admin: false, policy: "same");
        Assert.Equal(new[] { 3 }, Assert.Single(await rig.Service.SearchableEpisodesAsync(opener, Firefly, 5, null, default)).Episodes.Select(e => e.Episode).ToArray());
        Assert.NotNull((await rig.Service.SearchableInstanceAsync(opener, Firefly.WithEpisode(1, 3), null, default)).InstanceId);
    }

    [Theory]
    [InlineData(true)]  // the 4K copy (which has no S1E3 at all) is listed first
    [InlineData(false)]
    public async Task AFamilySearchNeverSearchesAPartHiddenInACopyTheViewerOpensWhicheverComesFirst(bool fourKFirst)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        Downloading(rig.Sonarr, "none");
        var kid = rig.View.AddUser(admin: false, parental: true);
        // The standard copy lists S1E3 as a missing episode Jellyfin hides from the kid (its rating).
        rig.View.AddEpisode(rig.HdCopy, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, Virtual = true }, rig.Admin.UserId);
        if (fourKFirst) FourKFirst(rig);
        await rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default);
        await Task.Delay(20);
        Assert.Empty(await rig.Service.SearchableEpisodesAsync(kid, Firefly, 5, null, default));
        Assert.Null((await rig.Service.SearchableInstanceAsync(kid, Firefly.WithEpisode(1, 3), null, default)).InstanceId);
        // Control: without parental limits nothing is hidden from them, so S1E3 is searched.
        var adult = rig.View.AddUser(admin: false, policy: "same");
        Assert.NotEmpty(await rig.Service.SearchableEpisodesAsync(adult, Firefly, 5, null, default));
    }

    // ------------------------------------------------------------------ ED-R12-3: each Sonarr reads its own folder's files

    /// <summary>One library holds both folders, and both Sonarrs are linked to it; the 4K copy has only S1E1.</summary>
    private static Rig SharedLibrary(bool fourKFirst)
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
        if (fourKFirst) FourKFirst(rig);
        return rig;
    }

    [Theory]
    [InlineData(true, false)]  // the finding: Sonarr 4K downloads S1E2, which only the standard folder has
    [InlineData(true, true)]
    [InlineData(false, false)] // the standard Sonarr upgrades S1E2, which the 4K folder doesn't have
    [InlineData(false, true)]
    public async Task TwoSonarrsLinkedToOneLibraryEachReadTheirOwnFoldersFiles(bool fourKDownloads, bool fourKFirst)
    {
        using var rig = SharedLibrary(fourKFirst);
        (fourKDownloads ? rig.Sonarr4k! : rig.Sonarr).Queue.Add(FakeArr.SonarrQueueRow(102, "e2", 1, 2, "Firefly", 78874));
        var where = $"4K downloads {fourKDownloads}, 4K first {fourKFirst}";

        // By key, the administrator's line of each Sonarr: a download of S1E2 for the 4K folder, an upgrade for the standard one.
        var key = await ByKey(rig, rig.Admin);
        Assert.True((LineStage(key, "Sonarr4kZ") == StatusStage.Downloading) == fourKDownloads, $"{where}: by key Sonarr 4K line {LineStage(key, "Sonarr4kZ")}");
        Assert.True(LineStage(key, "SonarrZ") == StatusStage.Ready, $"{where}: by key Sonarr line {LineStage(key, "SonarrZ")}");

        // Each copy's page: its own Sonarr on the headline, the other one's line by that one's own folder.
        var hdPage = await Page(rig, rig.Admin, rig.HdCopy);
        var uhdPage = await Page(rig, rig.Admin, rig.UhdCopy);
        Assert.Equal(0, Summary(hdPage, "downloading"));
        Assert.Equal(fourKDownloads ? 1 : 0, Summary(uhdPage, "downloading"));
        Assert.True((LineStage(hdPage, "Sonarr4kZ") == StatusStage.Downloading) == fourKDownloads, $"{where}: HD page Sonarr 4K line {LineStage(hdPage, "Sonarr4kZ")}");
        Assert.True(LineStage(uhdPage, "SonarrZ") == StatusStage.Ready, $"{where}: 4K page Sonarr line {LineStage(uhdPage, "SonarrZ")}");

        // The member: the standard copy is theirs to read first; its S1E2 is an upgrade.
        Assert.Equal(StatusStage.Ready, Stage(await ByKey(rig, rig.Member)));
        Assert.Equal(fourKDownloads ? 1 : 0, Summary(await Card(rig, rig.Member, rig.UhdCopy), "downloading"));
        Assert.Equal(0, Summary(await Card(rig, rig.Member, rig.HdCopy), "downloading"));
    }

    [Fact]
    public async Task ASonarrSharingTheStandardFolderReadsThatCopysFiles()
    {
        // The 4K Sonarr holds the standard Sonarr's very folder (the page reads the standard one): it is upgrading S1E2,
        // which that folder's copy plays, so its line is Ready, never a download, by key and on the page.
        using var rig = new Rig(Layout.SharedFolder4kArr, Has.Both, movie: false);
        rig.Sonarr4k!.Queue.Add(FakeArr.SonarrQueueRow(102, "e2", 1, 2, "Firefly", 78874));
        var key = await ByKey(rig, rig.Admin);
        Assert.True(LineStage(key, "Sonarr4kZ") == StatusStage.Ready, $"by key Sonarr 4K line {LineStage(key, "Sonarr4kZ")}");
        Assert.Equal(rig.HdCopy.ToString("N"), Line(key, "Sonarr4kZ")?.GetProperty("itemId").GetString());
        var page = await Page(rig, rig.Admin, rig.HdCopy);
        Assert.True(LineStage(page, "Sonarr4kZ") == StatusStage.Ready, $"page Sonarr 4K line {LineStage(page, "Sonarr4kZ")}");
        Assert.Equal(StatusStage.Ready, Stage(await ByKey(rig, rig.Member)));
    }

    // ------------------------------------------------------------------ ED-R12-4: one Episodes read per bound copy

    [Fact]
    public async Task ABoundCopysEpisodesAreReadOncePerComposition()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        Downloading(rig.Sonarr, "dl", 3);
        var kid = rig.View.AddUser(admin: false, parental: true);
        await Card(rig, kid, rig.HdCopy);
        await ByKey(rig, kid);

        async Task<int> Reads(Guid[] ids, TitleKey[] keys)
        {
            rig.Service.Cache.Clear();
            var before = rig.View.EpisodeCalls;
            var items = Items(await rig.Service.ForBatchAsync(kid, ids, keys, default));
            Assert.All(items, s => Assert.Equal(StatusStage.Downloading, Stage(s)));
            return rig.View.EpisodeCalls - before;
        }

        Assert.Equal(1, await Reads(new[] { rig.HdCopy }, Array.Empty<TitleKey>()));
        Assert.Equal(1, await Reads(Array.Empty<Guid>(), new[] { Firefly }));
        Assert.Equal(1, await Reads(new[] { rig.HdCopy }, new[] { Firefly }));
    }
}
