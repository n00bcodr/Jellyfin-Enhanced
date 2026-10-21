using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Http;
using Xunit.Abstractions;
using Rig = JE.Tests.IntegrationEditionAvailabilityTests.Rig;
using Layout = JE.Tests.IntegrationEditionAvailabilityTests.Layout;
using Has = JE.Tests.IntegrationEditionAvailabilityTests.Has;
using M = JE.Tests.IntegrationEditionMaskedTests;
using N = JE.Tests.IntegrationNotificationsTests;

namespace JE.Tests;

/// <summary>
/// Edition round 19, part B (D53: one availability definition). Every decision that credits a title, a copy or an episode
/// as there (Ready, a copy's readiness for an administrator, the whole-series branch, what a family Search counts as held,
/// arrivals and their marks and batches, a delivery held for quiet hours, the automatic requests, and "open in library")
/// reads ONE predicate: an accessible, playable source qualifying for the edition asked for. A stub such as a ".disc"
/// file is listed but plays nothing; a file's own dimensions decide its edition, never the arr folder it sits in; a
/// ".strm" shortcut plays its remote source as its own item. The path table runs the same stub against every consumer.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationEditionPlayableTests(ITestOutputHelper output)
{
    private static readonly TitleKey Sintel = TitleKey.Parse("movie:tmdb:45745")!;
    private static readonly TitleKey Firefly = TitleKey.Parse("tv:tvdb:78874")!;
    private static readonly TitleKey Severance = TitleKey.Parse("tv:tvdb:371980")!;
    private const string Dune = "movie:tmdb:693134";

    private static string StageOf(JsonElement status) => status.GetProperty("stage").GetString()!;

    private static JsonElement VariantOf(JsonElement status, string role)
        => status.GetProperty("admin").GetProperty("variants").EnumerateArray().First(v => v.GetProperty("role").GetString() == role);

    /// <summary>A movie whose only copy is a ".disc" stub (Radarr has the file; Jellyfin lists only the stub).</summary>
    private static Rig StubMovie()
    {
        var rig = new Rig(Layout.OneItem, Has.Hd, movie: true);
        rig.View.Placeholders.Add(rig.HdCopy);
        rig.View.Rev++;
        return rig;
    }

    /// <summary>A series whose only copy lists every episode as a stub.</summary>
    private static Rig StubSeries()
    {
        var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        foreach (var e in rig.View.EpisodesBySeries[rig.HdCopy]) rig.View.Placeholders.Add(e.Episode.ItemId);
        rig.View.Rev++;
        return rig;
    }

    private static async Task<IReadOnlyList<ArrStatusService.KeyedStatus>> Keyed(Rig rig, StatusViewer viewer, TitleKey key, ArrStatusService.RequestScope? scope = null)
    {
        var scopes = scope == null ? null : new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = scope };
        await rig.Service.ComposeForAsync(viewer, new[] { key }, scopes, default, loadEpisodes: true);
        await Task.Delay(20);
        return await rig.Service.ComposeForAsync(viewer, new[] { key }, scopes, default, loadEpisodes: true);
    }

    private static async Task<JsonElement> CardByKey(Rig rig, StatusViewer viewer, TitleKey key)
    {
        await rig.Service.ForBatchAsync(viewer, Array.Empty<Guid>(), new[] { key }, default);
        await Task.Delay(20);
        return Assert.Single(M.Items(await rig.Service.ForBatchAsync(viewer, Array.Empty<Guid>(), new[] { key }, default)));
    }

    private static async Task<JsonElement> Absent(Rig rig, StatusViewer viewer, AbsentTitle page)
    {
        await rig.Service.ForAbsentAsync(viewer, page, default);
        await Task.Delay(20);
        return Assert.Single(M.Items(await rig.Service.ForAbsentAsync(viewer, page, default)));
    }

    // ------------------------------------------------------------------ the path table: one stub, every consumer

    /// <summary>Every consumer of "the viewer has it" (the report's path table), each fed the same kind of stub.</summary>
    public static TheoryData<string> Consumers() => new()
    {
        "movie page: another copy's readiness (administrator)",
        "movie by title key (Requests page, Seerr modal)",
        "movie card by title key",
        "movie by title key: another copy's readiness (administrator)",
        "movie arrival hand-off",
        "movie open in library (absent page)",
        "series card by title key",
        "series page: another Sonarr copy's readiness (administrator)",
        "series open in library (absent page)",
        "family Search of a movie",
        "automatic movie request: already in the library",
        "collection gaps: what the viewer has",
        "Discover card: in the library",
    };

    [Theory]
    [MemberData(nameof(Consumers))]
    public async Task EveryConsumerCreditsOnlyAnAccessiblePlayableSource(string consumer)
    {
        switch (consumer)
        {
            case "movie page: another copy's readiness (administrator)":
            {
                // ED-R17-8: the HD item's own page; the 4K Radarr's copy is only a ".disc" stub.
                using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: true);
                rig.MovieCopy(rig.UhdCopy, "/media/movies4k/Sintel (2010)/Sintel (2010).disc", "Movies 4K");
                rig.View.Placeholders.Add(rig.UhdCopy);
                rig.View.Rev++;
                var page = await M.Page(rig, rig.Admin, rig.HdCopy);
                Assert.Equal(StatusStage.Ready, StageOf(page));
                Assert.NotEqual(StatusStage.Ready, StageOf(VariantOf(page, "4k")));
                break;
            }
            case "movie by title key (Requests page, Seerr modal)":
            {
                // The key path judges the movie by its copies; the only one plays nothing.
                using var rig = StubMovie();
                var keyed = Assert.Single(await Keyed(rig, rig.Member, Sintel));
                Assert.NotEqual(StatusStage.Ready, keyed.Status.Stage);
                Assert.Null(keyed.Visible);
                break;
            }
            case "movie card by title key":
            {
                using var rig = StubMovie();
                Assert.NotEqual(StatusStage.Ready, StageOf(await CardByKey(rig, rig.Member, Sintel)));
                break;
            }
            case "movie by title key: another copy's readiness (administrator)":
            {
                using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: true);
                rig.MovieCopy(rig.UhdCopy, "/media/movies4k/Sintel (2010)/Sintel (2010).disc", "Movies 4K");
                rig.View.Placeholders.Add(rig.UhdCopy);
                rig.View.Rev++;
                var card = await CardByKey(rig, rig.Admin, Sintel);
                Assert.Equal(StatusStage.Ready, StageOf(card));
                Assert.NotEqual(StatusStage.Ready, StageOf(VariantOf(card, "4k")));
                break;
            }
            case "movie arrival hand-off":
            {
                // ED-R17-8: the arrival route named the stub movie's id.
                using var rig = StubMovie();
                Assert.Null(rig.Service.ArrivedItem(rig.Member, Sintel, null));
                Assert.Null(rig.Service.ArrivedItem(rig.Member, Sintel, Guid.NewGuid()));
                break;
            }
            case "movie open in library (absent page)":
            {
                using var rig = StubMovie();
                var page = await Absent(rig, rig.Member, new AbsentTitle { PageId = Guid.NewGuid(), Kind = "movie", Title = Sintel, TmdbId = 45745 });
                Assert.False(page.TryGetProperty("openItemId", out _), page.ToString());
                Assert.NotEqual(StatusStage.Ready, StageOf(page));
                break;
            }
            case "series card by title key":
            {
                using var rig = StubSeries();
                Assert.NotEqual(StatusStage.Ready, StageOf(await CardByKey(rig, rig.Member, Firefly)));
                break;
            }
            case "series page: another Sonarr copy's readiness (administrator)":
            {
                // The 4K Sonarr's folder lists only a stub: that Sonarr's line is not "in the library, Ready".
                using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
                var stub = rig.View.AddEpisodeFile(rig.UhdCopy, Firefly, 1, 1, null, null, rig.Now.AddDays(-1));
                rig.View.Placeholders.Add(stub);
                rig.View.Rev++;
                var page = await M.Page(rig, rig.Admin, rig.HdCopy);
                Assert.Equal(StatusStage.Ready, StageOf(page));
                Assert.NotEqual(StatusStage.Ready, StageOf(VariantOf(page, "4k")));
                break;
            }
            case "series open in library (absent page)":
            {
                using var rig = StubSeries();
                var page = await Absent(rig, rig.Member, new AbsentTitle { PageId = Guid.NewGuid(), Kind = "series", Title = Firefly, TmdbId = 1437 });
                Assert.False(page.TryGetProperty("openItemId", out _), page.ToString());
                break;
            }
            case "family Search of a movie":
            {
                // The only copy is a stub and Radarr has no file: it is missing, so a family Search searches it.
                using var rig = StubMovie();
                rig.Radarr.Movies[0]["hasFile"] = false;
                rig.Radarr.Movies[0]["added"] = "2020-01-01T00:00:00Z";
                var keyed = Assert.Single(await Keyed(rig, rig.Member, Sintel));
                Assert.Equal(StatusReasonCode.NoReleaseYet, keyed.Status.Reason.Code);
                var found = await rig.Service.SearchableInstanceAsync(rig.Member, Sintel, null, default);
                Assert.NotNull(found.InstanceId);
                break;
            }
            case "automatic movie request: already in the library":
            {
                using var rig = StubMovie();
                var recorder = new AutoRequestRecorder(null!, rig.View, null, () => rig.Arr.Now);
                Assert.False(recorder.InLibrary(Sintel, rig.Member.UserId));
                break;
            }
            case "collection gaps: what the viewer has":
            {
                // The collection's movie is in a library the viewer opens, as a stub only: missing, not "have".
                using var l = new IntegrationEditionOrphanTests.Library();
                var viewer = l.Person(new FakeJellyfinView().AddUser(false));
                IntegrationEditionIncompleteTests.Shape(l, "visible");
                l.Hd.IsPlaceHolder = true;
                var box = Guid.NewGuid();
                const string body = "{\"id\":10,\"parts\":[{\"id\":603,\"title\":\"The Matrix\",\"release_date\":\"1999-03-31\"}]}";
                var gaps = new CollectionGapsService(l.View, (_, id) => id == box ? new BoxSetRef(id, 10) : null, null, null,
                    (_, _, _) => Task.FromResult<string?>(body), (_, _, _) => Task.FromResult(true), () => new DateTimeOffset(2026, 10, 19, 0, 0, 0, TimeSpan.Zero));
                var result = (await gaps.ForCollectionAsync(viewer, box, null, default)).Gaps!;
                Assert.Equal((0, 1), (result.Have, result.Missing.Count));
                l.Hd.IsPlaceHolder = false;
                result = (await gaps.ForCollectionAsync(viewer, box, null, default)).Gaps!;
                Assert.Equal((1, 0), (result.Have, result.Missing.Count));
                break;
            }
            case "Discover card: in the library":
            {
                using var r = new IntegrationRequestLedgerTests.Rig();
                var copy = Guid.NewGuid();
                var key = TitleKey.Parse("movie:tmdb:1")!;
                r.View.AddCopy(key, new JfCopy { ItemId = copy, Path = "/media/movies/Film (2024)/Film.disc", LibraryName = "Movies" });
                r.View.AddItem(new JfItemRef { ItemId = copy, Kind = "movie", Key = key, Path = "/media/movies/Film (2024)/Film.disc" });
                r.View.Placeholders.Add(copy);
                async Task<JsonElement> Card()
                {
                    var service = new DiscoverService(r.Service, null, (_, _, _, _) => Task.FromResult(true),
                        (_, _, _) => Task.FromResult<string?>(IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(1, "Film"))),
                        (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => r.Now);
                    var controller = new AcquireDiscoverController(service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
                    controller.HttpContext.User = TestCallers.Principal(r.Member, false);
                    var result = IntegrationRequestDiscoverTests.Read(await controller.Discover("trending", "movie", 1, null, default), controller);
                    Assert.Equal(200, result.Status);
                    return Assert.Single(result.Body.GetProperty("answer").GetProperty("results").EnumerateArray().ToList());
                }
                var card = await Card();
                Assert.False(card.GetProperty("inLibrary").GetBoolean(), card.ToString());
                r.View.Placeholders.Remove(copy);
                r.View.Rev++;
                Assert.True((await Card()).GetProperty("inLibrary").GetBoolean());
                break;
            }
            default:
                throw new InvalidOperationException("No scenario for " + consumer);
        }
    }

    // ------------------------------------------------------------------ the whole-series branch (ED-AX-11)

    [Fact]
    public async Task AWholeSeriesRequestIsNeverReadyOnPlaceholdersAlone()
    {
        using var rig = StubSeries();
        Assert.Empty(rig.Service.Editions.Scope(rig.Member, Firefly, Edition.Standard));
        var whole = new ArrStatusService.RequestScope(Array.Empty<int>(), false, null);
        var result = Assert.Single(await Keyed(rig, rig.Member, Firefly, whole));
        output.WriteLine($"whole-series request stage={result.Status.Stage}, arrived={result.ArrivedAt}");
        Assert.NotEqual(StatusStage.Ready, result.Status.Stage);
        Assert.Null(result.ArrivedAt);
        // Control: one playable episode and it is there.
        rig.View.Placeholders.Remove(rig.View.EpisodesBySeries[rig.HdCopy][0].Episode.ItemId);
        rig.View.Rev++;
        Assert.Equal(StatusStage.Ready, Assert.Single(await Keyed(rig, rig.Member, Firefly, whole)).Status.Stage);
    }

    // ------------------------------------------------------------------ family Search coverage (ED-AX-12)

    [Fact]
    public async Task AFamilySearchSearchesAStubbedEpisode()
    {
        using var rig = new Rig(Layout.SeparateLibraries, Has.Hd, movie: false);
        var id = rig.View.EpisodesBySeries[rig.HdCopy].Single(e => e.Episode.Episode == 1).Episode.ItemId;
        rig.View.Placeholders.Add(id);
        rig.View.Rev++;
        rig.Sonarr.Episodes.Single(e => (int)e["id"]! == 101)["hasFile"] = false;
        var page = await M.Page(rig, rig.Member, id);
        Assert.Equal("no_release_yet", page.GetProperty("reason").GetProperty("code").GetString());
        var single = await rig.Service.SearchableInstanceAsync(rig.Member, Firefly.WithEpisode(1, 1), null, default);
        var many = await rig.Service.SearchableEpisodesAsync(rig.Member, Firefly.WithSeason(1), 50, null, default);
        Assert.NotNull(single.InstanceId);
        Assert.Equal(new[] { (1, 1) }, Assert.Single(many).Episodes.Select(e => (e.Season, e.Episode)).ToArray());
        // Control: E2 plays, so it is never searched.
        Assert.Null((await rig.Service.SearchableInstanceAsync(rig.Member, Firefly.WithEpisode(1, 2), null, default)).InstanceId);
    }

    // ------------------------------------------------------------------ remote shortcuts (ED-AX-10)

    [Fact]
    public void AStrmShortcutPlaysItsRemoteSourceAsItsOwnItemAndKeepsItsEdition()
    {
        using var rig = new Rig(Layout.OneItem, Has.Hd, true);
        using var l = new IntegrationEditionOrphanTests.Library();
        var viewer = l.Person(rig.Member);
        // Jellyfin resolves a ".strm" file as a shortcut item: its media source is the remote address (HTTP), probed 2160p.
        l.Uhd.Path = "/media/Movies 4K/The Matrix.strm";
        l.Uhd.IsShortcut = true;
        l.Uhd.ShortcutPath = "https://stream.invalid/movie.mkv";
        var source = l.Uhd.Files.Single();
        source.Path = "https://stream.invalid/movie.mkv";
        source.Protocol = MediaProtocol.Http;
        Assert.True(l.View.Resolve(l.Uhd.Id, viewer)!.Playable);
        var sources = l.View.Sources(l.Uhd.Id, viewer);
        var only = Assert.Single(sources);
        Assert.Equal((l.Uhd.Id, 3840), (only.BackingItemId, only.Width ?? 0));
        var editions = new EditionAvailability(l.View, () => rig.Arr.Plugin.Plugin.Configuration, (k, v) => l.View.Copies(k, v).Display);
        Assert.NotEmpty(editions.Scope(viewer, TitleKey.Parse("movie:tmdb:603")!, Edition.FourK));
        // A remote source of an item that is not a shortcut is not bound to anything.
        l.Uhd.IsShortcut = false;
        l.Uhd.Path = "/media/Movies 4K/The Matrix.mkv";
        Assert.Empty(l.View.Sources(l.Uhd.Id, viewer));
        // A shortcut in a library the viewer can't open plays nothing for them.
        l.Uhd.IsShortcut = true;
        l.Uhd.Path = "/media/Movies 4K/The Matrix.strm";
        l.Change("denied");
        Assert.Empty(l.View.Sources(l.Uhd.Id, viewer));
    }

    // ------------------------------------------------------------------ arrivals: the source decides the edition (ED-AX-8)

    private static void SeriesRequest(N.Rig r, bool fourK)
    {
        if (fourK) N.FourKSonarr(r);
        r.Request(30, 95396, r.Emma, type: "tv", tvdb: 371980, seasons: new[] { 2 }, is4k: fourK);
    }

    private static Guid SeriesCopy(N.Rig rig, string path, string library)
    {
        var copy = Guid.NewGuid();
        rig.View.AddCopy(Severance, new JfCopy { ItemId = copy, Path = path, LibraryName = library, DateCreated = rig.Arr.Now.UtcDateTime });
        return copy;
    }

    private static async Task Arrivals(N.Rig rig)
    {
        await rig.Step(Severance.ToString());
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.Step();
    }

    [Fact]
    public async Task AnHdFileInTheFourKFolderIsNoFourKArrivalAndLeavesTheFourKMarkForTheRealOne()
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        var copy = SeriesCopy(rig, "/media/tv4k/Severance", "Shows 4K");
        rig.View.AddEpisodeFile(copy, Severance, 2, 1, 1920, 1080, rig.Arr.Now.UtcDateTime);
        Assert.Empty(rig.Status.Editions.Scope(rig.Emma, Severance.WithSeason(2), Edition.FourK));
        await Arrivals(rig);
        Assert.Empty(rig.Inbox(rig.Emma));
        // The real 4K file of that episode arrives: that is the 4K arrival (the HD file consumed no mark).
        var real = rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime);
        rig.View.Rev++;
        await Arrivals(rig);
        var notice = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Contains("\"variant\":\"4k\"", notice.Payload);
        Assert.Equal(real.ToString("N"), notice.ItemId);
    }

    [Theory]
    [InlineData(true)]  // a real 4K file in the standard Sonarr's folder is the 4K request's arrival
    [InlineData(false)] // with "Standard requests need a non-4K copy", a 4K-only file is no standard arrival
    public async Task AnArrivalsEditionIsTheFilesNotTheFoldersOwner(bool fourKRequest)
    {
        using var rig = await N.Started(r =>
        {
            SeriesRequest(r, fourKRequest);
            r.Config.ArrStandardNeedsNonFourK = !fourKRequest;
        });
        var copy = SeriesCopy(rig, "/media/tv/Severance", "Shows");
        rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime);
        var wanted = fourKRequest ? Edition.FourK : Edition.Standard;
        Assert.Equal(fourKRequest, rig.Status.Editions.Scope(rig.Emma, Severance.WithSeason(2), wanted).Count > 0);
        await Arrivals(rig);
        if (fourKRequest) Assert.Contains("\"variant\":\"4k\"", Assert.Single(rig.Inbox(rig.Emma)).Payload);
        else Assert.Empty(rig.Inbox(rig.Emma));
    }

    // ------------------------------------------------------------------ delayed delivery and batches (ED-AX-9)

    [Theory]
    [InlineData(false)] // the 4K file was replaced by an HD one during quiet hours
    [InlineData(true)]  // it became a stub
    public async Task ADeliveryHeldForQuietHoursIsSentOnlyIfTheEditionIsStillThere(bool becomesStub)
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        rig.Phones(rig.Emma);
        rig.Prefs(rig.Emma, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var copy = SeriesCopy(rig, "/media/tv4k/Severance", "Shows 4K");
        var episode = rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime);
        await Arrivals(rig);
        Assert.Single(rig.Inbox(rig.Emma));
        Assert.Empty(rig.Pushes);
        if (becomesStub) rig.View.Placeholders.Add(episode);
        else { rig.View.SourcesByItem[episode].Clear(); rig.View.AddSource(episode, 1920, 1080); }
        rig.View.Rev++;
        Assert.NotNull(rig.View.Resolve(episode, rig.Emma));
        rig.Prefs(rig.Emma, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
    }

    [Fact]
    public async Task AHeldMovieDeliveryIsSentOnlyIfItsEditionIsStillThere()
    {
        using var rig = await N.Started(r => r.Request(41, 693134, r.Emma, is4k: true));
        rig.Phones(rig.Emma);
        rig.Prefs(rig.Emma, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var item = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(Dune)!, new JfCopy { ItemId = item, Path = "/media/movies4k/Dune Part Two/Dune.mkv", LibraryName = "Movies 4K", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddSource(item, 3840, 2160, "/media/movies4k/Dune Part Two/Dune.mkv", rig.Arr.Now.UtcDateTime);
        await rig.Step(Dune);
        Assert.Equal("ready", Assert.Single(rig.Inbox(rig.Emma)).Kind);
        Assert.Empty(rig.Pushes);
        // Replaced by an HD file before the quiet hours end: no 4K "ready" goes out.
        rig.View.SourcesByItem[item].Clear();
        rig.View.AddSource(item, 1920, 1080, "/media/movies4k/Dune Part Two/Dune.mkv", rig.Arr.Now.UtcDateTime);
        rig.View.Rev++;
        rig.Prefs(rig.Emma, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await rig.Dispatcher.RunOnceAsync(default);
        Assert.Empty(rig.Pushes);
    }

    [Fact]
    public async Task ABatchIsFlushedOnlyWithEpisodesThatStillHaveTheEdition()
    {
        using var rig = await N.Started(r => SeriesRequest(r, fourK: true));
        var copy = SeriesCopy(rig, "/media/tv4k/Severance", "Shows 4K");
        var first = rig.View.AddEpisodeFile(copy, Severance, 2, 1, 3840, 2160, rig.Arr.Now.UtcDateTime);
        rig.View.AddEpisodeFile(copy, Severance, 2, 2, 3840, 2160, rig.Arr.Now.UtcDateTime);
        await rig.Step(Severance.ToString());
        Assert.Empty(rig.Inbox(rig.Emma));
        // Within the batch window E1's 4K file is replaced by an HD one: only E2 is announced.
        rig.View.SourcesByItem[first].Clear();
        rig.View.AddSource(first, 1920, 1080);
        rig.View.Rev++;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        rig.Service.FlushBatches(rig.Arr.Now);
        var notice = Assert.Single(rig.Inbox(rig.Emma));
        var p = JsonSerializer.Deserialize<Dictionary<string, string>>(notice.Payload)!;
        Assert.Equal("1", p["count"]);
        Assert.Equal(("single", "2"), (p["mode"], p["episode"]));
    }

    // ------------------------------------------------------------------ a follow hears of a stub? (arrival detection)

    [Fact]
    public async Task AFollowedMovieIsNotAnnouncedForAStubOnlyWhenItPlays()
    {
        using var rig = await N.Started();
        Assert.Equal("ok", await rig.Service.SetFollowAsync(rig.Sam, TitleKey.Parse(Dune)!, true, default));
        await rig.Step(Dune);
        var stub = rig.Arrive(Dune);
        rig.View.Placeholders.Add(stub);
        rig.View.Rev++;
        await rig.Step(Dune);
        Assert.Empty(rig.Inbox(rig.Sam));
        rig.View.Placeholders.Remove(stub);
        rig.View.Rev++;
        await rig.Step(Dune);
        Assert.Equal(("ready", stub.ToString("N")), (Assert.Single(rig.Inbox(rig.Sam)).Kind, Assert.Single(rig.Inbox(rig.Sam)).ItemId));
    }

    // ------------------------------------------------------------------ the enumerating guard

    private static string Root([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services"))) root = root.Parent;
        Assert.NotNull(root);
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }

    /// <summary>
    /// The raw facts availability is made of, and the only places that may read them: the predicate's owner (and the view
    /// that produces them), and named reads that are access or presentation decisions, never "the viewer has it".
    /// </summary>
    private static readonly (string Pattern, string[] Allowed)[] Primitives =
    {
        // An item's or episode's own "plays a file" flag: only EditionAvailability.Plays reads it.
        (@"\.Playable\b", new[] { "Services/Acquire/EditionAvailability.cs",
            "Services/Acquire/Lists/ListEditionAvailability.cs:AddSources", // lists' own source adapter (4c), until it is replaced by EditionAvailability
            "Services/Acquire/Lists/ListHost.cs:IsFourK" }), // the same adapter's host (lists' Jellyfin facts)
        // A media source list: the view produces it, EditionAvailability judges it. (ListImportFlags.Sources is 4c2's list
        // sources switch, a configuration flag: not a media source list.)
        (@"(?<!\bListImportFlags)\.(Sources|EpisodeSources)\(", new[] { "Services/Acquire/EditionAvailability.cs" }),
        // "A copy they can open was seen": access only (may they ask about it, see it, a parental filter), never "they have it".
        (@"\bSeenOpenable\b", new[]
        {
            "Services/Acquire/JellyfinFacts.cs",                 // its definition
            "Services/Acquire/ArrStatusService.cs:MayAskByKey",  // may the viewer ask about a title by key (access)
            "Services/Acquire/ArrStatusService.cs:AccessOf",     // the request policy's copy access (access)
            "Services/Acquire/Requests/DiscoverService.cs:Card", // the parental filter of a Discover card (access)
            "Services/Acquire/Requests/CollectionGapsService.cs:ForCollectionAsync", // a copy they open is theirs to see (access; "have" is the predicate)
            "Services/Acquire/Requests/CollectionGapsService.cs:Missing", // the same rule in the gated preparation (access; "have" is the predicate)
            "Controllers/TitleActionsController.cs:ActualCopy", // which copy they can open a title action navigates to (access)
        }),
    };

    [Fact]
    public void EveryAvailabilityReadGoesThroughTheOnePredicate()
    {
        var root = Root();
        var found = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (relative.StartsWith("obj/", StringComparison.Ordinal) || relative.StartsWith("bin/", StringComparison.Ordinal)) continue;
            string? method = null;
            foreach (var raw in File.ReadLines(file))
            {
                var line = raw.Trim();
                if (line.StartsWith("//", StringComparison.Ordinal)) continue;
                var declared = Regex.Match(line, @"^(?:(?:public|private|internal|protected|static|async|override|sealed)\s+)+[\w<>\[\],.?() ]+?\s(\w+)\s*[(<]");
                if (declared.Success) method = declared.Groups[1].Value;
                foreach (var (pattern, allowed) in Primitives)
                {
                    if (!Regex.IsMatch(line, pattern)) continue;
                    if (allowed.Contains(relative) || (method != null && allowed.Contains(relative + ":" + method))) continue;
                    found.Add($"{relative}:{method} reads {pattern}: {line}");
                }
            }
        }
        Assert.True(found.Count == 0, "availability read outside the predicate:\n" + string.Join("\n", found));
    }
}
