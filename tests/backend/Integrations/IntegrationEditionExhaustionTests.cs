using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Moq;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;

namespace JE.Tests;

/// <summary>
/// Edition round 8 (D53). A copy lookup is complete only when it read every query to its end: every other stop (the
/// twenty-copy budget included) leaves rows unread and is incomplete with the copies it saw. Which arr copy owns a
/// Jellyfin copy is judged from what was seen and is nobody when that can't tell; a copy's own page or card never falls
/// back to the primary Sonarr.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionExhaustionTests
{
    private static readonly TitleKey Matrix = TitleKey.Parse("movie:tmdb:603")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;

    // ------------------------------------------------------------------ the lookup: every limit and its cut-off

    private static IntegrationEditionOrphanTests.MovieFile Live(IntegrationEditionOrphanTests.Library l, int n)
    {
        var row = new IntegrationEditionOrphanTests.MovieFile { Id = Guid.NewGuid(), Name = $"C live {n:D3}", Path = $"/media/Movies/{n}.mkv" };
        l.Items[row.Id] = row; l.Parents[row.Id] = new() { l.HdRoot };
        return row;
    }

    /// <summary>Serves the rows of each provider query (TMDB 603, then the alias 604), paged like Jellyfin.</summary>
    private static void Serve(IntegrationEditionOrphanTests.Library l, List<BaseItem> first, List<BaseItem>? alias = null)
        => l.Manager.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            (q.HasAnyProviderId?.GetValueOrDefault("Tmdb") switch { "603" => first, "604" => alias ?? new List<BaseItem>(), _ => new List<BaseItem>() })
                .Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToList());

    [Theory]
    [InlineData("exactly20", true)]           // control: the twentieth copy is the last row of the last query
    [InlineData("20ThenRetained", true)]      // control: read on past the budget to the end, nothing but retained rows
    [InlineData("20ThenDuplicates", true)]    // control: the alias query lists the same twenty again
    [InlineData("21stOnTheSamePage", false)]  // the old code returned Found and never read the 21st
    [InlineData("21stOnALaterPage", false)]
    [InlineData("21stInTheAliasQuery", false)]
    public void TheCopyBudgetIsCompleteOnlyWhenEveryQueryWasReadToItsEnd(string shape, bool complete)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        var first = new List<BaseItem>();
        var alias = new List<BaseItem>();
        var twenty = Enumerable.Range(0, 20).Select(n => (BaseItem)Live(l, n)).ToList();
        first.AddRange(twenty);
        switch (shape)
        {
            case "20ThenRetained": first.AddRange(IntegrationEditionOrphanTests.PagedRows(l, 150, false, live: false)); break;
            case "20ThenDuplicates": alias.AddRange(twenty); break;
            case "21stOnTheSamePage": first.Add(Live(l, 20)); break;
            case "21stOnALaterPage": first.AddRange(IntegrationEditionOrphanTests.PagedRows(l, 150, false, live: false)); first.Add(Live(l, 20)); break;
            case "21stInTheAliasQuery": alias.Add(Live(l, 20)); break;
        }
        Serve(l, first, alias);
        var lookup = l.View.Copies(Matrix, StatusViewer.Library, new[] { TitleKey.Parse("movie:tmdb:604")! });
        Assert.Equal(complete ? CopyLookupOutcome.Found : CopyLookupOutcome.Incomplete, lookup.Outcome);
        // Either way, what was seen is the first twenty, once each.
        Assert.Equal(twenty.Select(t => t.Id), lookup.Seen.Select(c => c.ItemId));
        Assert.Equal(complete ? 20 : 0, lookup.Display.Count);
    }

    [Fact]
    public void ABudgetStopIsNeverCachedAndIsLoggedLikeTheOtherStops()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        var first = Enumerable.Range(0, 21).Select(n => (BaseItem)Live(l, n)).ToList();
        Serve(l, first);
        using var watch = CopyLookupBound.Track();
        Assert.False(l.View.Copies(Matrix, StatusViewer.Library).IsComplete);
        Assert.True(CopyLookupBound.Reached);
    }

    [Fact]
    public void AViewerTheViewCannotCheckIsNeverProvenAbsent()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var watch = CopyLookupBound.Track();
        var lookup = l.View.Copies(Matrix, new StatusViewer { UserId = Guid.NewGuid() });
        Assert.Equal(CopyLookupOutcome.Incomplete, lookup.Outcome);
        Assert.False(lookup.IsProvenAbsent);
        Assert.Empty(lookup.Seen);
        Assert.True(CopyLookupBound.Reached);
    }

    // ------------------------------------------------------------------ the 21st copy: alerts and the fulfilled 4K request

    [Theory]
    [InlineData(20, 0, 1)] // the reviewers' case: twenty copies she can't open first; never suppressed for good
    [InlineData(19, 1, 0)] // control: the open copy is the twentieth, a finished lookup that saw it: sent
    public async Task AReadyAlertWhoseOpenCopyIsTheTwentyFirstWaitsInsteadOfBeingDropped(int hidden, int sent, int pending)
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Emma);
        const string key = "movie:tmdb:693134";
        IntegrationEditionBoundTests.Rows(l, 0, hidden: hidden, id: "693134");
        rig.View.CopiesFrom = (k, viewer, aliases) => k.Title.ToString() == key ? l.View.Copies(k, viewer, aliases) : null;
        rig.NotifyStore.Add(rig.Emma.UserId, "ready|" + key, NotifyKind.Ready, key, null, new Dictionary<string, string> { ["title"] = "Dune: Part Two" },
            new[] { (NotifyChannel.Ntfy, rig.Arr.Now) }, rig.Arr.Now);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Equal(sent, rig.Pushes.Count);
        Assert.Equal(pending, rig.NotifyStore.DeliveryStats(rig.Arr.Now).Pending);
    }

    [Fact]
    public async Task AFulfilled4kRequestWhoseCopyIsTheTwentyFirstIsNeverSinceRemoved()
    {
        using var l = new IntegrationEditionOrphanTests.Library();
        using var lab = new IntegrationRequestArrivalsTests.Lab(fourK: true, jellyfin: l.View);
        var emma = l.Person(lab.Emma); l.Person(lab.Admin); l.Person(lab.Kid);
        var rows = IntegrationEditionBoundTests.Rows(l, 0, live: false);
        await lab.Warm();
        lab.Policy.Adjust = (_, _, policy) => policy with { Can4k = true };
        var request = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix.ToString(), Variant = "4k" });
        await lab.Outbox.TickAsync(default);
        rows.Add(l.Uhd);
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix.ToString() }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
        // Radarr lets go of it (the files stay); twenty copies in a library she can't open now sort ahead of hers.
        foreach (var host in new[] { "radarr.lan", "radarr4k.lan" }) { lab.Arr.Hosts[host].Movies.Clear(); lab.Arr.Hosts[host].Queue.Clear(); }
        foreach (var name in new[] { "RadarrZ", "Radarr4kZ" })
        {
            Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Arr.Instance(name), default)).Ok);
            lab.Store.RequestRefresh(lab.Arr.Instance(name).Id, ArrSnapshotKind.Queue);
        }
        lab.Arr.Now += TimeSpan.FromHours(1);
        await lab.Warm();
        IntegrationEditionBoundTests.Rows(l, 0, hidden: 20);
        lab.Status.Cache.Clear();
        var row = (await lab.Page(emma))[Matrix.ToString()];
        Assert.NotEqual(HubGroup.Removed, row.GetProperty("group").GetString());
        Assert.NotEqual(StatusReasonCode.Removed, row.GetProperty("status").GetProperty("reason").GetProperty("code").GetString());
        var scoped = (await lab.Status.ComposeForAsync(emma, new[] { Matrix }, null, default)).Single().Status;
        Assert.NotEqual(StatusReasonCode.Removed, scoped.Reason.Code);
        Assert.Equal(0, lab.Status.Cache.Count);
        Assert.Equal("fulfilled", lab.Ledger.Find(request)!.Status);
        // Control: nineteen ahead of it, a finished lookup that sees her 4K copy: Ready.
        IntegrationEditionBoundTests.Rows(l, 0, hidden: 19);
        lab.Status.Cache.Clear();
        row = (await lab.Page(emma))[Matrix.ToString()];
        Assert.Equal(StatusStage.Ready, row.GetProperty("status").GetProperty("stage").GetString());
    }

    // ------------------------------------------------------------------ ownership: a pinned 4K series over an unfinished lookup

    /// <summary>
    /// TV and TV 4K (the rig's mapping, /data is /media): the standard Sonarr has S1E3's file (neither Jellyfin copy has
    /// it), is upgrading S1E2 and downloading S1E4; the 4K Sonarr has neither file and nothing queued.
    /// </summary>
    private static Rig SeriesRig()
    {
        var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: false);
        rig.Sonarr.Episodes.Add(SonarrEpisode(103, 3, hasFile: true));
        rig.Sonarr.Episodes.Add(SonarrEpisode(104, 4, hasFile: false));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(102, "dl102", 1, 2, "Firefly", 78874));
        rig.Sonarr.Queue.Add(FakeArr.SonarrQueueRow(104, "dl104", 1, 4, "Firefly", 78874));
        rig.Sonarr4k!.Episodes.Add(SonarrEpisode(103, 3, hasFile: false));
        rig.Sonarr4k.Episodes.Add(SonarrEpisode(104, 4, hasFile: false));
        return rig;
    }

    private static JsonObject SonarrEpisode(int id, int number, bool hasFile)
        => new() { ["id"] = id, ["seriesId"] = 1, ["seasonNumber"] = 1, ["episodeNumber"] = number, ["airDateUtc"] = "2002-09-23T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = true };

    private sealed record Pages(Guid Series, Guid Season, Guid Episode2, Guid Missing3);

    private static Pages PagesOf(Rig rig, Guid series)
    {
        var season = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = season, Kind = "season", Key = Firefly.WithSeason(1), SeriesId = series, Season = 1 });
        var missing = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = missing, Kind = "episode", Key = Firefly.WithEpisode(1, 3), SeriesId = series, Season = 1, Episode = 3, Virtual = true });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = missing, Season = 1, Episode = 3, Virtual = true });
        rig.View.Rev++;
        var episode2 = rig.View.Episodes(series, 1, rig.Admin, includeVirtual: false).Single(e => e.Episode == 2).ItemId;
        return new Pages(series, season, episode2, missing);
    }

    private static JfCopy CopyOf(Rig rig, Guid id)
        => id == rig.UhdCopy
            ? new JfCopy { ItemId = id, Visible = true, Path = "/media/tv4k/Firefly", LibraryId = "TV 4K", LibraryName = "TV 4K" }
            : new JfCopy { ItemId = id, Visible = true, Path = "/media/tv/Firefly", LibraryId = "TV", LibraryName = "TV" };

    private static async Task<JsonElement> Item(Rig rig, StatusViewer viewer, Guid id)
        => Assert.Single(Items(await rig.Service.ForItemAsync(viewer, id, default)));

    private static List<JsonElement> Items(StatusBody body)
    {
        using var doc = JsonDocument.Parse(body.Json);
        return doc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToList();
    }

    private static string? FirstInstance(JsonElement status)
        => status.TryGetProperty("admin", out var admin) && admin.TryGetProperty("variants", out var variants) && variants.GetArrayLength() > 0
            ? variants[0].GetProperty("instance").GetString()
            : null;

    private static int Summary(JsonElement status, string field)
        => status.TryGetProperty("summary", out var summary) && summary.TryGetProperty(field, out var n) ? n.GetInt32() : 0;

    [Theory]
    [InlineData("both")]    // the lookup saw both copies before it stopped: each pin is its own folder's Sonarr
    [InlineData("hdOnly")]  // it saw only the standard copy: the 4K copy is still its own exact folder's (round 9)
    [InlineData("nothing")] // it saw nothing: each page's own series is still its exact folder's (round 9)
    [InlineData("complete")] // control: a finished lookup
    public async Task ACopysPagesAndCardOverAnUnfinishedLookupReadOnlyTheSonarrThatOwnsIt(string seen)
    {
        using var rig = SeriesRig();
        var uhd = PagesOf(rig, rig.UhdCopy);
        var hd = PagesOf(rig, rig.HdCopy);
        // Warm the arr reads (episode lists and queues) with a finished lookup, then switch.
        foreach (var pages in new[] { uhd, hd })
        {
            await rig.Service.ForItemAsync(rig.Admin, pages.Series, default);
            await rig.Service.ForBatchAsync(rig.Member, new[] { pages.Series }, Array.Empty<TitleKey>(), default);
        }
        await Task.Delay(20);
        var shown = seen switch
        {
            "both" => new[] { CopyOf(rig, rig.UhdCopy), CopyOf(rig, rig.HdCopy) },
            "hdOnly" => new[] { CopyOf(rig, rig.HdCopy) },
            _ => Array.Empty<JfCopy>(),
        };
        if (seen != "complete") rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == Firefly.ToString() ? CopyLookup.Incomplete(shown) : null;
        rig.Service.Cache.Clear();

        foreach (var (pages, sonarr) in new[] { (uhd, "Sonarr4kZ"), (hd, "SonarrZ") })
        {
            // Round 9: the page's own series (the viewer opens it now) sits exactly in its Sonarr's mapped folder, so its
            // owner is known whatever the lookup saw. Round 8 expected none for a copy the lookup didn't see.
            var owner = sonarr;
            var standard = owner == "SonarrZ";
            var card = Assert.Single(Items(await rig.Service.ForBatchAsync(rig.Member, new[] { pages.Series }, Array.Empty<TitleKey>(), default)));
            Assert.Equal(standard, card.GetProperty("stage").GetString() == StatusStage.Downloading);
            var series = await Item(rig, rig.Admin, pages.Series);
            Assert.Equal(owner, FirstInstance(series));
            Assert.Equal(standard, Summary(series, "downloading") > 0);
            Assert.Equal(standard, Summary(series, "almostReady") > 0);
            var memberSeries = await Item(rig, rig.Member, pages.Series);
            Assert.Equal(standard, Summary(memberSeries, "downloading") > 0);
            var season = await Item(rig, rig.Admin, pages.Season);
            Assert.Equal(owner, FirstInstance(season));
            Assert.Equal(standard, Summary(season, "almostReady") > 0);
            var missing = await Item(rig, rig.Admin, pages.Missing3);
            Assert.Equal(owner, FirstInstance(missing));
            Assert.Equal(standard, missing.GetProperty("stage").GetString() == StatusStage.AlmostReady);
            var episode = await Item(rig, rig.Member, pages.Episode2);
            Assert.Equal(standard, episode.GetProperty("reason").GetProperty("code").GetString() == StatusReasonCode.Upgrading);
        }
    }

    // ------------------------------------------------------------------ round 9: the page's own series is an ownership fact

    /// <summary>Twenty eligible copies of the title in other folders (a library she can't open), none of them the rig's.</summary>
    private static JfCopy[] TwentyOthers()
        => Enumerable.Range(1, 20).Select(n => new JfCopy { ItemId = Guid.NewGuid(), Visible = false, Path = $"/media/locked/Firefly {n:D2}", LibraryId = "Locked", LibraryName = "Locked" }).ToArray();

    [Theory]
    [InlineData("exact")]        // the finding: each pin is its own exactly-mapped folder's Sonarr, past twenty other copies
    [InlineData("notExact")]     // control: neither page's folder is exactly a Sonarr's mapped folder: no owner
    [InlineData("inaccessible")] // control: the member can't open the pinned series now: none on her season/episode pages
    public async Task TwentyCopiesBeforeAnExactlyMappedPinnedSeriesLeaveItsPagesAndCardTheirSonarr(string shape)
    {
        using var rig = SeriesRig();
        var uhd = PagesOf(rig, rig.UhdCopy);
        var hd = PagesOf(rig, rig.HdCopy);
        foreach (var pages in new[] { uhd, hd })
        {
            await rig.Service.ForItemAsync(rig.Admin, pages.Series, default);
            await rig.Service.ForBatchAsync(rig.Member, new[] { pages.Series }, Array.Empty<TitleKey>(), default);
        }
        await Task.Delay(20);
        foreach (var (id, path) in new[] { (rig.HdCopy, "/media/tv/Firefly"), (rig.UhdCopy, "/media/tv4k/Firefly") })
        {
            if (shape == "notExact") rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "series", Key = Firefly, Path = path + " (2002)" });
            if (shape == "inaccessible") rig.View.AddItem(new JfItemRef { ItemId = id, Kind = "series", Key = Firefly, Path = path }, rig.Admin.UserId);
        }
        rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == Firefly.ToString() ? CopyLookup.Incomplete(TwentyOthers()) : null;
        rig.Service.Cache.Clear();

        foreach (var (pages, sonarr) in new[] { (uhd, "Sonarr4kZ"), (hd, "SonarrZ") })
        {
            var adminOwner = shape is "exact" or "inaccessible" ? sonarr : null;
            var memberStandard = shape == "exact" && sonarr == "SonarrZ";
            var adminStandard = adminOwner == "SonarrZ";
            if (shape != "inaccessible")
            {
                var card = Assert.Single(Items(await rig.Service.ForBatchAsync(rig.Member, new[] { pages.Series }, Array.Empty<TitleKey>(), default)));
                Assert.Equal(memberStandard, card.GetProperty("stage").GetString() == StatusStage.Downloading);
                var memberSeries = await Item(rig, rig.Member, pages.Series);
                Assert.Equal(memberStandard, Summary(memberSeries, "downloading") > 0);
            }
            var series = await Item(rig, rig.Admin, pages.Series);
            Assert.Equal(adminOwner, FirstInstance(series));
            Assert.Equal(adminStandard, Summary(series, "downloading") > 0);
            Assert.Equal(adminStandard, Summary(series, "almostReady") > 0);
            var season = await Item(rig, rig.Admin, pages.Season);
            Assert.Equal(adminOwner, FirstInstance(season));
            Assert.Equal(adminStandard, Summary(season, "almostReady") > 0);
            var missing = await Item(rig, rig.Admin, pages.Missing3);
            Assert.Equal(adminOwner, FirstInstance(missing));
            Assert.Equal(adminStandard, missing.GetProperty("stage").GetString() == StatusStage.AlmostReady);
            var memberSeason = await Item(rig, rig.Member, pages.Season);
            Assert.Equal(memberStandard, Summary(memberSeason, "almostReady") > 0);
            var episode = await Item(rig, rig.Member, pages.Episode2);
            Assert.Equal(memberStandard, episode.GetProperty("reason").GetProperty("code").GetString() == StatusReasonCode.Upgrading);
        }
    }

    [Theory]
    [InlineData(true)]  // the movie twin: the page's own movie file sits in its Radarr's exactly-mapped folder
    [InlineData(false)] // control: its folder isn't exactly any Radarr's mapped folder: no Radarr claims it
    public async Task TwentyCopiesBeforeAnExactlyMappedMovieLeaveItsPageItsRadarr(bool exact)
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Both, movie: true);
        var sintel = TitleKey.Parse("movie:tmdb:45745")!;
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel")); // the standard Radarr is upgrading its file
        foreach (var id in new[] { rig.HdCopy, rig.UhdCopy }) await rig.Service.ForItemAsync(rig.Admin, id, default);
        await Task.Delay(20);
        if (!exact) rig.View.AddItem(new JfItemRef { ItemId = rig.HdCopy, Kind = "movie", Key = sintel, Path = "/media/movies/Sintel/Sintel (2010) - 1080p.mkv", LibraryId = "Movies", LibraryName = "Movies", DateCreated = rig.Now.AddDays(-1), Versions = 1 });
        rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == sintel.ToString() ? CopyLookup.Incomplete(TwentyOthers()) : null;
        rig.Service.Cache.Clear();

        var member = await Item(rig, rig.Member, rig.HdCopy);
        Assert.Equal(exact, member.GetProperty("reason").GetProperty("code").GetString() == StatusReasonCode.Upgrading);
        var admin = await Item(rig, rig.Admin, rig.HdCopy);
        string? LibraryOf(JsonElement status, string instance) => status.GetProperty("admin").GetProperty("variants").EnumerateArray().Single(v => v.GetProperty("instance").GetString() == instance) is var v && v.TryGetProperty("library", out var lib) && lib.ValueKind == JsonValueKind.String ? lib.GetString() : null;
        Assert.Equal(exact ? "Movies" : null, LibraryOf(admin, "RadarrZ"));
        Assert.Null(LibraryOf(admin, "Radarr4kZ"));
        // The 4K page's own file is the 4K Radarr's folder's, never the standard Radarr's upgrade.
        var uhd = await Item(rig, rig.Admin, rig.UhdCopy);
        Assert.Equal("Movies 4K", LibraryOf(uhd, "Radarr4kZ"));
        Assert.Null(LibraryOf(uhd, "RadarrZ"));
        Assert.NotEqual(StatusReasonCode.Upgrading, uhd.GetProperty("reason").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData(false)] // the lookup saw only the copy she can't open, then stopped
    [InlineData(true)]  // control: a finished lookup with only that copy
    public async Task ASeriesByKeyWhoseOnlySeenCopyIsHiddenNeverReadsThatCopysSonarr(bool complete)
    {
        using var rig = SeriesRig();
        await rig.Service.ForKeyDetailAsync(rig.Admin, Firefly, default);
        await rig.Service.ForBatchAsync(rig.Member, new[] { rig.HdCopy }, Array.Empty<TitleKey>(), default);
        await Task.Delay(20);
        var hd = CopyOf(rig, rig.HdCopy);
        var hidden = new[] { new JfCopy { ItemId = hd.ItemId, Visible = false, Path = hd.Path, LibraryId = hd.LibraryId, LibraryName = hd.LibraryName } };
        rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == Firefly.ToString() ? (complete ? CopyLookup.Complete(hidden) : CopyLookup.Incomplete(hidden)) : null;
        rig.Service.Cache.Clear();
        var items = Items(await rig.Service.ForKeyDetailAsync(rig.Member, Firefly, default));
        // Asked by key (allowed or not), never the standard Sonarr's download of the copy hidden from her.
        Assert.All(items, s => Assert.NotEqual(StatusStage.Downloading, s.GetProperty("stage").GetString()));
        Assert.All(items, s => Assert.False(s.TryGetProperty("progress", out _)));
    }

    [Fact]
    public async Task TheManageDrawerOfASeasonReadsTheEpisodesOfTheCopyThePrimarySonarrOwns()
    {
        using var rig = SeriesRig();
        // The standard copy also has S1E3; the 4K copy doesn't. The lookup lists the 4K copy first.
        rig.View.AddEpisodeFile(rig.HdCopy, Firefly, 1, 3, 1920, 1080, rig.Now.AddDays(-1));
        rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == Firefly.ToString() ? CopyLookup.Complete(new[] { CopyOf(rig, rig.UhdCopy), CopyOf(rig, rig.HdCopy) }) : null;
        await rig.Service.ForScopeKeyAsync(rig.Admin, Firefly.WithSeason(1), default);
        await Task.Delay(20);
        rig.Service.Cache.Clear();
        var season = Assert.Single(Items(await rig.Service.ForScopeKeyAsync(rig.Admin, Firefly.WithSeason(1), default)));
        var e3 = season.GetProperty("episodes").EnumerateArray().Single(e => e.GetProperty("episode").GetInt32() == 3);
        // The standard Sonarr's file of S1E3 is in the standard copy: Ready, never "almost ready" against the 4K copy.
        Assert.Equal(StatusStage.Ready, e3.GetProperty("stage").GetString());
    }

    [Fact]
    public async Task AnAdminLineIsNeverPairedWithACopyItsSonarrDoesNotOwn()
    {
        using var rig = SeriesRig();
        // Jellyfin has only the 4K copy; the standard Sonarr (the primary) holds the series too.
        rig.View.CopiesFrom = (key, _, _) => key.Title.ToString() == Firefly.ToString() ? CopyLookup.Complete(new[] { CopyOf(rig, rig.UhdCopy) }) : null;
        await rig.Service.ForKeyDetailAsync(rig.Admin, Firefly, default);
        await Task.Delay(20);
        rig.Service.Cache.Clear();
        var status = Assert.Single(Items(await rig.Service.ForKeyDetailAsync(rig.Admin, Firefly, default)));
        var variants = status.GetProperty("admin").GetProperty("variants").EnumerateArray().ToList();
        string? LibraryOf(string instance) => variants.Single(v => v.GetProperty("instance").GetString() == instance) is var v && v.TryGetProperty("library", out var lib) && lib.ValueKind == JsonValueKind.String ? lib.GetString() : null;
        Assert.Null(LibraryOf("SonarrZ"));
        Assert.Equal("TV 4K", LibraryOf("Sonarr4kZ"));
    }
}
