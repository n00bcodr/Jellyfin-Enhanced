using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Seerr request read model (Requests &amp; downloads, phase 1): parsing Seerr's request list,
/// the request facts the status composer gets (pending / OK'd / declined, asked by the viewer or
/// someone else), per-user and per-title lookups, the cheap probe that skips unchanged full reads,
/// announcements on the change feed (title keys and each affected user's request-list key), title
/// details (names, posters, TVDB ids and dates), failures keeping the last good list, the switch-off,
/// and when a refresh is due.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationSeerrReadModelTests
{
    private static readonly DateTime T0 = new(2026, 10, 10, 12, 0, 0, DateTimeKind.Utc);

    private sealed class Rig : IDisposable
    {
        public FakeSeerr Seerr { get; } = new();
        public PluginConfiguration Config { get; } = new()
        {
            ArrIntegrationEnabled = true,
            ArrPhase1Enabled = true,
            JellyseerrEnabled = true,
            JellyseerrUrls = FakeSeerr.Url,
            JellyseerrApiKey = FakeSeerr.Key,
        };
        public ArrChangeFeed Feed { get; }
        public DateTimeOffset Now { get; set; } = new(2026, 10, 12, 12, 0, 0, TimeSpan.Zero);
        public SeerrFacts Model { get; }
        public Guid Emma { get; } = Guid.NewGuid();
        public Guid Sam { get; } = Guid.NewGuid();

        public Rig()
        {
            Feed = new ArrChangeFeed(() => Now);
            Model = new SeerrFacts(Seerr.Transport, Feed, null, () => Config, () => Now);
        }

        public StatusViewer Viewer(Guid id) => new() { UserId = id, PolicyRevision = "p" };

        public void Dispose()
        {
            Model.Dispose();
            Seerr.Dispose();
        }
    }

    [Theory]
    [InlineData(SeerrRequestStatus.Pending)]
    [InlineData(SeerrRequestStatus.Approved)]
    [InlineData(SeerrRequestStatus.Failed)]
    public async Task OwnOutstandingStandardSeasonsReachTheSeriesActionPlan(int status)
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "tv", 745, status, rig.Emma, T0, tvdb: 72658, seasons: [1]));
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "tv", 745, SeerrRequestStatus.Pending, rig.Sam, T0, tvdb: 72658, seasons: [2]));
        rig.Seerr.Requests.Add(FakeSeerr.Request(3, "tv", 745, SeerrRequestStatus.Declined, rig.Emma, T0, tvdb: 72658, seasons: [3]));
        rig.Seerr.Requests.Add(FakeSeerr.Request(4, "tv", 745, SeerrRequestStatus.Completed, rig.Emma, T0, tvdb: 72658, seasons: [4]));
        var fourK = FakeSeerr.Request(5, "tv", 745, SeerrRequestStatus.Pending, rig.Emma, T0, tvdb: 72658, seasons: [5]);
        fourK["is4k"] = true; rig.Seerr.Requests.Add(fourK);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(new[] { 1 }, rig.Model.For(Key("tv:tvdb:72658"), rig.Viewer(rig.Emma))!.ViewerSeasons);
        Assert.Equal(new[] { 2 }, rig.Model.For(Key("tv:tvdb:72658"), rig.Viewer(rig.Sam))!.ViewerSeasons);
    }

    private static TitleKey Key(string key) => TitleKey.Parse(key)!;

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AChangedSecondaryProviderIdInvalidatesTheRevisionEvenWhenThePrimaryKeyIsUnchanged(bool movie)
    {
        using var rig = new Rig();
        var request = FakeSeerr.Request(1, movie ? "movie" : "tv", 83867, 2, rig.Emma, T0, tvdb: movie ? null : 393189);
        request["media"]!["imdbId"] = "tt83867";
        rig.Seerr.Requests.Add(request);
        Assert.True(await rig.Model.RefreshAsync(default));
        var revision = rig.Model.Revision;
        var cursor = rig.Feed.Cursor;
        var primary = rig.Model.All.Single().Key;
        var oldAlias = movie ? "movie:imdb:tt83867" : "tv:tmdb:83867";
        var newAlias = movie ? "movie:imdb:tt83868" : "tv:tmdb:83868";
        // A periodic full read can discover an id correction with unchanged status/timestamps.
        if (movie) request["media"]!["imdbId"] = "tt83868";
        else request["media"]!["tmdbId"] = 83868;
        rig.Now = rig.Now.AddMinutes(31);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(primary, rig.Model.All.Single().Key);
        Assert.Empty(rig.Model.ForTitle(Key(oldAlias)));
        Assert.Single(rig.Model.ForTitle(Key(newAlias)));
        Assert.True(rig.Model.Revision > revision);
        Assert.Contains(rig.Feed.Read(rig.Feed.Epoch, cursor).Changes, c => c.Key == primary!.ToString());
    }

    [Fact]
    public async Task RequestsBecomeFactsForTheirTitleAsTheViewerSeesThem()
    {
        using var rig = new Rig();
        // Emma asked for Dune (pending); Sam asked for Andor (OK'd); Leo's Toy Story request was declined.
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 693134, 1, rig.Emma, T0, userName: "Emma"));
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "tv", 83867, 2, rig.Sam, T0.AddHours(1), T0.AddHours(2), tvdb: 393189, seasons: [1, 2], userName: "Sam"));
        rig.Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 1084244, 3, Guid.NewGuid(), T0.AddHours(3), T0.AddHours(4)));
        // Not a request JE can use: no media / unknown type.
        rig.Seerr.Requests.Add(new JsonObject { ["id"] = 4, ["type"] = "music", ["status"] = 1 });

        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(3, rig.Model.All.Count);

        var dune = rig.Model.For(Key("movie:tmdb:693134"), rig.Viewer(rig.Emma))!;
        Assert.True(dune.Pending);
        Assert.True(dune.AskedByViewer);
        Assert.Equal(T0, dune.AskedAt);
        Assert.Null(dune.ApprovedAt);
        // Someone else's request: the viewer is told "someone in your household" asked.
        var duneForSam = rig.Model.For(Key("movie:tmdb:693134"), rig.Viewer(rig.Sam))!;
        Assert.False(duneForSam.AskedByViewer);

        // A series by TVDB (and by TMDB): OK'd at its last change.
        var andor = rig.Model.For(Key("tv:tvdb:393189"), rig.Viewer(rig.Emma))!;
        Assert.False(andor.Pending);
        Assert.Equal(T0.AddHours(2), andor.ApprovedAt);
        Assert.NotNull(rig.Model.For(Key("tv:tmdb:83867"), rig.Viewer(rig.Emma)));
        Assert.NotNull(rig.Model.For(Key("tv:tvdb:393189:s2:e3"), rig.Viewer(rig.Emma)));

        var toyStory = rig.Model.For(Key("movie:tmdb:1084244"), rig.Viewer(rig.Emma))!;
        Assert.True(toyStory.Declined);
        Assert.Null(rig.Model.For(Key("movie:tmdb:1"), rig.Viewer(rig.Emma)));

        Assert.True(rig.Model.AskedBy(Key("movie:tmdb:693134"), rig.Emma));
        Assert.False(rig.Model.AskedBy(Key("movie:tmdb:693134"), rig.Sam));
        Assert.Equal(new[] { 1 }, rig.Model.ForUser(rig.Emma).Select(r => r.Id));
        Assert.Equal(new[] { 1, 2 }, rig.Model.ForTitle(Key("tv:tvdb:393189")).Single().Seasons);
        Assert.Equal("Sam", rig.Model.ForUser(rig.Sam).Single().RequestedByName);
    }

    [Fact]
    public async Task AnEpisodeGetsTheRequestsForItsSeasonOnly()
    {
        using var rig = new Rig();
        // Sam's seasons 1-2 are OK'd; Emma's season 3 waits for an OK.
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "tv", 83867, 2, rig.Sam, T0.AddHours(1), T0.AddHours(2), tvdb: 393189, seasons: [1, 2], userName: "Sam"));
        rig.Seerr.Requests.Add(FakeSeerr.Request(5, "tv", 83867, 1, rig.Emma, T0.AddHours(3), tvdb: 393189, seasons: [3], userName: "Emma"));
        await rig.Model.RefreshAsync(default);
        var key = Key("tv:tvdb:393189");
        var s2 = rig.Model.ForEpisode(key, 2, 5, rig.Viewer(rig.Emma))!;
        Assert.False(s2.Pending);
        Assert.Equal(T0.AddHours(2), s2.ApprovedAt);
        Assert.False(s2.AskedByViewer);
        var s3 = rig.Model.ForEpisode(key, 3, 1, rig.Viewer(rig.Emma))!;
        Assert.True(s3.Pending);
        Assert.True(s3.AskedByViewer);
        Assert.Null(rig.Model.ForEpisode(key, 4, 1, rig.Viewer(rig.Emma)));
        // A season page: the requests that name the season, as for its episodes.
        Assert.True(rig.Model.ForSeason(key, 3, rig.Viewer(rig.Emma))!.Pending);
        Assert.False(rig.Model.ForSeason(key, 2, rig.Viewer(rig.Emma))!.Pending);
        Assert.Null(rig.Model.ForSeason(key, 4, rig.Viewer(rig.Emma)));
        // The whole title still reads as before (one OK'd beside a pending one: not waiting).
        Assert.False(rig.Model.For(key, rig.Viewer(rig.Emma))!.Pending);
    }

    [Fact]
    public async Task AnOkdRequestBesideAPendingOneIsNotWaitingAndAllDeclinedMeansSaidNo()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5, 1, rig.Emma, T0));
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "movie", 5, 2, rig.Sam, T0.AddHours(1), T0.AddHours(5), is4k: true));
        rig.Seerr.Requests.Add(FakeSeerr.Request(3, "movie", 6, 3, rig.Emma, T0, T0.AddHours(1)));
        rig.Seerr.Requests.Add(FakeSeerr.Request(4, "movie", 6, 3, rig.Sam, T0, T0.AddHours(1)));
        await rig.Model.RefreshAsync(default);

        var five = rig.Model.For(Key("movie:tmdb:5"), rig.Viewer(rig.Emma))!;
        Assert.False(five.Pending);
        Assert.Equal(T0.AddHours(5), five.ApprovedAt);
        Assert.True(five.AskedByViewer);
        Assert.False(five.Declined);
        Assert.True(rig.Model.For(Key("movie:tmdb:6"), rig.Viewer(rig.Sam))!.Declined);
    }

    [Fact]
    public async Task AnUnchangedProbeSkipsTheFullReadAndAChangeIsReadAndAnnounced()
    {
        using var rig = new Rig();
        for (var i = 1; i <= 150; i++) rig.Seerr.Requests.Add(FakeSeerr.Request(i, "movie", 1000 + i, 2, i % 2 == 0 ? rig.Emma : rig.Sam, T0.AddMinutes(i)));
        await rig.Model.RefreshAsync(default);
        Assert.Equal(150, rig.Model.All.Count);
        // Two pages of 100 for the full read, one probe.
        Assert.Equal(2, rig.Seerr.CallCount("sort=added"));
        Assert.Equal(1, rig.Seerr.CallCount("sort=modified"));
        var revision = rig.Model.Revision;
        var cursor = rig.Feed.Cursor;

        rig.Now = rig.Now.AddMinutes(5);
        await rig.Model.RefreshAsync(default);
        Assert.Equal(2, rig.Seerr.CallCount("sort=added"));
        Assert.Equal(revision, rig.Model.Revision);
        Assert.Equal(cursor, rig.Feed.Cursor);

        // Sam's request 3 is declined in Seerr's UI: the probe sees it, the list is read again, its
        // title and Sam's request-list key are announced (Emma's isn't).
        var three = rig.Seerr.Requests.Single(r => (int)r["id"]! == 3);
        three["status"] = 3;
        three["updatedAt"] = T0.AddDays(1).ToString("o");
        rig.Now = rig.Now.AddMinutes(5);
        await rig.Model.RefreshAsync(default);
        Assert.Equal(4, rig.Seerr.CallCount("sort=added"));
        Assert.True(rig.Model.Revision > revision);
        var read = rig.Feed.Read(rig.Feed.Epoch, cursor);
        Assert.Equal(new[] { ArrTitleKey.Movie(1003), ArrTitleKey.UserRequests(rig.Sam) }.OrderBy(k => k), read.Changes.Select(c => c.Key).OrderBy(k => k));
        Assert.True(rig.Model.For(Key("movie:tmdb:1003"), rig.Viewer(rig.Sam))!.Declined);

        // A deleted request is noticed through the total.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 10);
        cursor = rig.Feed.Cursor;
        await rig.Model.RefreshAsync(default);
        Assert.Null(rig.Model.For(Key("movie:tmdb:1010"), rig.Viewer(rig.Emma)));
        Assert.Contains(ArrTitleKey.UserRequests(rig.Emma), rig.Feed.Read(rig.Feed.Epoch, cursor).Changes.Select(c => c.Key));

        // Even with an unchanged probe, the full list is read again after 30 minutes.
        var full = rig.Seerr.CallCount("sort=added");
        rig.Now = rig.Now.AddMinutes(31);
        await rig.Model.RefreshAsync(default);
        Assert.True(rig.Seerr.CallCount("sort=added") > full);
    }

    [Fact]
    public async Task TitleDetailsNameTheRequestsFillMissingTvdbIdsAndAreReadAgainDaily()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "tv", 83867, 2, rig.Emma, T0));   // no TVDB id on the media
        rig.Seerr.Requests.Add(FakeSeerr.Request(2, "movie", 693134, 2, rig.Emma, T0));
        rig.Seerr.Shows[83867] = new JsonObject { ["name"] = "Andor", ["firstAirDate"] = "2022-09-21", ["posterPath"] = "/andor.jpg", ["externalIds"] = new JsonObject { ["tvdbId"] = 393189 }, ["nextEpisodeToAir"] = new JsonObject { ["airDate"] = "2026-10-20" } };
        rig.Seerr.Movies[693134] = new JsonObject { ["title"] = "Dune: Part Two", ["releaseDate"] = "2024-02-27", ["posterPath"] = "../../etc/passwd" };
        await rig.Model.RefreshAsync(default);

        var andor = rig.Model.Meta(false, 83867)!;
        Assert.Equal("Andor", andor.Title);
        Assert.Equal(2022, andor.Year);
        Assert.Equal("/andor.jpg", andor.PosterPath);
        Assert.Equal(new DateTime(2026, 10, 20, 0, 0, 0, DateTimeKind.Utc), andor.NextDate);
        // The series request gets the TVDB id from the details, so its status and feed key line up.
        Assert.NotNull(rig.Model.For(Key("tv:tvdb:393189"), rig.Viewer(rig.Emma)));
        Assert.Equal("tv:tvdb:393189", rig.Model.ForUser(rig.Emma).Single(r => !r.IsMovie).Key!.ToString());
        // A poster path that isn't a plain TMDB path is dropped.
        Assert.Null(rig.Model.Meta(true, 693134)!.PosterPath);

        var calls = rig.Seerr.CallCount("/api/v1/tv/");
        rig.Now = rig.Now.AddHours(2);
        await rig.Model.RefreshAsync(default);
        Assert.Equal(calls, rig.Seerr.CallCount("/api/v1/tv/"));
        rig.Seerr.Shows[83867]!["nextEpisodeToAir"] = new JsonObject { ["airDate"] = "2026-10-27" };
        var cursor = rig.Feed.Cursor;
        rig.Now = rig.Now.AddHours(23);
        await rig.Model.RefreshAsync(default);
        Assert.Equal(calls + 1, rig.Seerr.CallCount("/api/v1/tv/"));
        Assert.Equal(new DateTime(2026, 10, 27, 0, 0, 0, DateTimeKind.Utc), rig.Model.Meta(false, 83867)!.NextDate);
        Assert.Contains(ArrTitleKey.UserRequests(rig.Emma), rig.Feed.Read(rig.Feed.Epoch, cursor).Changes.Select(c => c.Key));
    }

    [Fact]
    public async Task AFailedReadKeepsTheLastGoodListAndTellsTheAdminWhy()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5, 1, rig.Emma, T0));
        await rig.Model.RefreshAsync(default);
        rig.Seerr.FailWith = 401;
        rig.Now = rig.Now.AddMinutes(6);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.NotNull(rig.Model.For(Key("movie:tmdb:5"), rig.Viewer(rig.Emma)));
        Assert.True(rig.Model.Loaded);
        Assert.Contains("API key", rig.Model.State.LastError);
        // A failure is retried after a minute, not the full interval.
        rig.Now = rig.Now.AddSeconds(30);
        Assert.False(rig.Model.Due());
        rig.Now = rig.Now.AddSeconds(31);
        Assert.True(rig.Model.Due());
        rig.Seerr.FailWith = 0;
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.State.LastError);
    }

    [Fact]
    public async Task TheFirstReadAFailureAndTheRecoveryAreAnnouncedToEveryRequestsPage()
    {
        // Nobody has a request, so no user's list key changes: only the shared state key tells the
        // open Requests pages to drop "Loading…" / "couldn't be updated".
        using var rig = new Rig();
        long cursor = rig.Feed.Cursor;
        List<string> Since()
        {
            var keys = rig.Feed.Read(rig.Feed.Epoch, cursor).Changes.Select(c => c.Key).ToList();
            cursor = rig.Feed.Cursor;
            return keys;
        }
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, Since());
        rig.Now = rig.Now.AddMinutes(6);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Empty(Since());
        rig.Seerr.FailWith = 500;
        rig.Now = rig.Now.AddMinutes(6);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, Since());
        rig.Now = rig.Now.AddMinutes(1);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Empty(Since());
        rig.Seerr.FailWith = 0;
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(new[] { ArrTitleKey.RequestsState }, Since());
        Assert.True(ArrTitleKey.IsFeedKey(ArrTitleKey.RequestsState));
    }

    [Fact]
    public async Task RefreshesAreDueByTheIntervalSoonerWhileWatchedOrAskedAndNeverWhileOff()
    {
        using var rig = new Rig();
        rig.Config.ArrSeerrRefreshMinutes = 5;
        Assert.True(rig.Model.Due());          // never read
        await rig.Model.RefreshAsync(default);
        Assert.False(rig.Model.Due());
        rig.Now = rig.Now.AddMinutes(4);
        Assert.False(rig.Model.Due());
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(rig.Model.Due());
        await rig.Model.RefreshAsync(default);

        // Someone has the Requests page open: every 30 s for two minutes.
        rig.Model.Touch();
        rig.Now = rig.Now.AddSeconds(31);
        Assert.True(rig.Model.Due());
        await rig.Model.RefreshAsync(default);
        rig.Now = rig.Now.AddMinutes(3);
        Assert.False(rig.Model.Due());

        // JE sent Seerr a request change: about a second later.
        rig.Model.RequestRefresh();
        Assert.False(rig.Model.Due());
        rig.Now = rig.Now.AddSeconds(1);
        Assert.True(rig.Model.Due());
    }

    [Fact]
    public async Task SwitchingOffForgetsEverythingAndSaysSo()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5, 1, rig.Emma, T0));
        await rig.Model.RefreshAsync(default);
        var revision = rig.Model.Revision;
        var cursor = rig.Feed.Cursor;

        rig.Config.ArrPhase1Enabled = false;
        Assert.False(rig.Model.Due());
        Assert.False(rig.Model.Active);
        Assert.Null(rig.Model.For(Key("movie:tmdb:5"), rig.Viewer(rig.Emma)));
        Assert.Empty(rig.Model.ForUser(rig.Emma));
        Assert.True(rig.Model.Revision > revision);
        Assert.Contains(ArrTitleKey.UserRequests(rig.Emma), rig.Feed.Read(rig.Feed.Epoch, cursor).Changes.Select(c => c.Key));
        var calls = rig.Seerr.Calls.Count;
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Equal(calls, rig.Seerr.Calls.Count);

        // Without Seerr (no key) it never reads either.
        rig.Config.ArrPhase1Enabled = true;
        rig.Config.JellyseerrApiKey = string.Empty;
        Assert.False(rig.Model.Due());
    }

    [Fact]
    public void UserRequestKeysAreFeedKeysOnlyInTheirExactShape()
    {
        var id = Guid.NewGuid();
        var key = ArrTitleKey.UserRequests(id);
        Assert.True(ArrTitleKey.IsFeedKey(key));
        Assert.True(ArrTitleKey.TryParseUserRequests(key, out var parsed));
        Assert.Equal(id, parsed);
        Assert.False(ArrTitleKey.IsValid(key));
        Assert.False(ArrTitleKey.IsFeedKey(key.ToUpperInvariant()));
        Assert.False(ArrTitleKey.IsFeedKey("req:u:" + id.ToString("D")));
        Assert.False(ArrTitleKey.IsFeedKey("req:u:"));
        var feed = new ArrChangeFeed();
        Assert.Equal(1, feed.Bump(new[] { key, "req:u:nope" }));
    }

    [Fact]
    public async Task TheContainerCanDisposeItOncePerRegistrationWithoutThrowing()
    {
        // Jellyfin disposes its host on every shutdown/restart; the read model is registered as
        // itself and as a hosted service, so the container disposes the same instance twice.
        // The authority-selecting facts wrapper does not own the read model. A throw there escaped Program.StartServer (restart = crash).
        using var rig = new Rig();
        var registered = new ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(registered, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>());
        // The registrator's own forwarding registrations, with the read model itself made by the test.
        using var probe = new ServiceCollection().AddSingleton(_ => rig.Model).BuildServiceProvider();
        var forwards = registered.Where(d => d.ServiceType == typeof(IHostedService) && d.ImplementationFactory != null && Forwards(d, probe)).ToList();
        Assert.Single(forwards);
        var facts = registered.Single(d => d.ServiceType == typeof(IArrRequestFacts));
        Assert.Equal(typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.LedgerRequestFacts), facts.ImplementationType);
        // The read model follows the outbox's confirmed sends: every service its one public constructor needs (but
        // Jellyfin's own HTTP client factory) is registered, and the outbox events are one shared singleton.
        var ctor = Assert.Single(typeof(SeerrFacts).GetConstructors());
        Assert.All(ctor.GetParameters().Where(p => p.ParameterType != typeof(System.Net.Http.IHttpClientFactory)),
            p => Assert.Contains(registered, d => d.ServiceType == p.ParameterType && d.Lifetime == ServiceLifetime.Singleton));
        Assert.Contains(ctor.GetParameters(), p => p.ParameterType == typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.RequestOutboxEvents));
        // So does the keep-getting follower (Seerr mode reads Seerr's series and wakes the outbox).
        var follower = Assert.Single(typeof(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests.FutureSeasonCharges).GetConstructors());
        Assert.All(follower.GetParameters(), p => Assert.Contains(registered, d => d.ServiceType == p.ParameterType && d.Lifetime == ServiceLifetime.Singleton));

        IServiceCollection services = new ServiceCollection();
        services.AddSingleton(_ => rig.Model);
        foreach (var d in forwards) services.Add(d);
        var provider = services.BuildServiceProvider();
        var hosted = provider.GetServices<IHostedService>().ToList();
        Assert.Same(rig.Model, Assert.Single(hosted));
        Assert.Same(rig.Model, provider.GetRequiredService<SeerrFacts>());
        foreach (var h in hosted) await h.StartAsync(default);
        foreach (var h in hosted) await h.StopAsync(default);

        var thrown = Record.Exception(() => provider.Dispose());
        Assert.Null(thrown);
        // Twice more by hand, for good measure.
        rig.Model.Dispose();
        rig.Model.Dispose();
    }

    // ------------------------------------------------------------------ complete reads only (C77)

    private static void Many(Rig rig, int from, int to)
    {
        for (var i = from; i <= to; i++) rig.Seerr.Requests.Add(FakeSeerr.Request(i, "movie", 1000 + i, 2, i % 2 == 0 ? rig.Emma : rig.Sam, T0.AddMinutes(i)));
    }

    // Makes the cheap probe see a change, so the next refresh reads the whole list.
    private static void Touch(Rig rig, int id)
    {
        rig.Seerr.Requests.Single(r => (int)r["id"]! == id)["updatedAt"] = rig.Now.UtcDateTime.ToString("o");
        rig.Now = rig.Now.AddMinutes(1);
    }

    [Fact]
    public async Task ARequestAddedWhileThePagesAreReadMakesTheReadIncompleteAndChangesNothingUntilAFullReadIsComplete()
    {
        using var rig = new Rig();
        Many(rig, 1, 150);
        Assert.True(await rig.Model.RefreshAsync(default));
        var revision = rig.Model.Revision;
        var cursor = rig.Feed.Cursor;
        // Request 151 is made and the oldest one (1) removed after the first page was read: Seerr's
        // count stays the same, but the second page starts with a request already read (51).
        rig.Seerr.BeforePage = skip =>
        {
            if (skip != 100 || rig.Seerr.Requests.Any(r => (int)r["id"]! == 151)) return;
            rig.Seerr.Requests.Add(FakeSeerr.Request(151, "movie", 1151, 1, rig.Emma, T0.AddDays(1)));
            rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 1);
        };
        Touch(rig, 3);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Equal(150, rig.Model.All.Count);
        Assert.Equal(revision, rig.Model.Revision);
        Assert.Equal(cursor, rig.Feed.Cursor);
        Assert.Contains("twice", rig.Model.State.IncompleteReason);
        Assert.Null(rig.Model.State.LastError);
        Assert.True(rig.Model.Loaded);
        // Read again a minute later (not the full interval), completely this time.
        Assert.False(rig.Model.Due());
        rig.Now = rig.Now.AddSeconds(61);
        Assert.True(rig.Model.Due());
        rig.Seerr.BeforePage = null;
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(150, rig.Model.All.Count);
        Assert.Contains(rig.Model.All, r => r.Id == 151);
        Assert.DoesNotContain(rig.Model.All, r => r.Id == 1);
        Assert.Null(rig.Model.State.IncompleteReason);
    }

    [Fact]
    public async Task ARequestRemovedWhileThePagesAreReadIsNotTakenForOthersGoneAndAPageThatFailsKeepsTheList()
    {
        using var rig = new Rig();
        Many(rig, 1, 150);
        await rig.Model.RefreshAsync(default);
        var cursor = rig.Feed.Cursor;
        // Request 120 (on the first page) is removed before the second page: Seerr's count changes and
        // request 50 would slide out of view.
        rig.Seerr.BeforePage = skip =>
        {
            if (skip == 100) rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! == 120);
        };
        Touch(rig, 3);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Contains(rig.Model.All, r => r.Id == 50);
        Assert.Contains(rig.Model.All, r => r.Id == 120);
        Assert.Equal(cursor, rig.Feed.Cursor);
        Assert.False(rig.Model.RequestedLately(Key("movie:tmdb:1050")) && !rig.Model.Requested(Key("movie:tmdb:1050")));
        // The second page fails outright: the list stays, and the failure shows at once.
        rig.Seerr.BeforePage = skip =>
        {
            if (skip == 100) rig.Seerr.FailWith = 500;
        };
        Touch(rig, 4);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.NotNull(rig.Model.State.LastError);
        Assert.Equal(150, rig.Model.All.Count);
        rig.Seerr.FailWith = 0;
        rig.Seerr.BeforePage = null;
        Touch(rig, 5);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(149, rig.Model.All.Count);
        Assert.Contains(rig.Model.All, r => r.Id == 50);
        Assert.DoesNotContain(rig.Model.All, r => r.Id == 120);
        Assert.Null(rig.Model.State.LastError);
    }

    [Fact]
    public async Task OnlyIncompleteReadsSeveralTimesInARowShowAsAProblem()
    {
        using var rig = new Rig();
        Many(rig, 1, 150);
        await rig.Model.RefreshAsync(default);
        var next = 151;
        rig.Seerr.BeforePage = skip =>
        {
            if (skip == 100) rig.Seerr.Requests.Add(FakeSeerr.Request(next++, "movie", 5000 + next, 1, rig.Emma, T0.AddDays(1)));
        };
        for (var i = 0; i < 2; i++)
        {
            Touch(rig, 3 + i);
            Assert.False(await rig.Model.RefreshAsync(default));
            Assert.Null(rig.Model.State.LastError);
        }
        Touch(rig, 9);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Contains("kept changing", rig.Model.State.LastError);
        rig.Seerr.BeforePage = null;
        Touch(rig, 10);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.State.LastError);
        Assert.Equal(153, rig.Model.All.Count);
    }

    [Fact]
    public async Task MoreRequestsThanAreReadKeepTheOlderOnesAndSaySo()
    {
        using var rig = new Rig();
        Many(rig, 1, SeerrFacts.MaxRequests - 1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.False(rig.Model.State.Truncated);
        // Six more: Seerr holds more than are read; the newest are read and the oldest are kept as
        // they were (their absence from the window says nothing).
        Many(rig, SeerrFacts.MaxRequests, SeerrFacts.MaxRequests + 5);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(SeerrFacts.MaxRequests + 5, rig.Model.All.Count);
        Assert.Contains(rig.Model.All, r => r.Id == 1);
        Assert.True(rig.Model.State.Truncated);
        Assert.Equal(SeerrFacts.MaxRequests + 5, rig.Model.State.ReportedTotal);
        Assert.Equal(SeerrFacts.MaxRequests, rig.Model.State.ReadLimit);
        Assert.False(rig.Model.RequestedLately(Key("movie:tmdb:1001")) && !rig.Model.Requested(Key("movie:tmdb:1001")));
    }

    [Fact]
    public async Task OlderRequestsNoLongerKeptBelowTheReadWindowAreUnknownNotGone()
    {
        using var rig = new Rig();
        rig.Model.HeldBelowWindow = 10;
        const int max = SeerrFacts.MaxRequests;
        Many(rig, 1, max);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.Current.Floor);
        // Five more: the window is 6..max+5 and 1..5 are kept below it (the list held was complete).
        Many(rig, max + 1, max + 5);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(max + 5, rig.Model.All.Count);
        Assert.Null(rig.Model.Current.Floor);
        // Twenty more: 1..25 are below the window, only the newest 10 of them (16..25) are kept. The
        // ones dropped still exist in Seerr: unknown from now on (below the floor), never taken for gone.
        Many(rig, max + 6, max + 25);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(16, rig.Model.Current.Floor);
        Assert.Equal(max + 10, rig.Model.All.Count);
        Assert.DoesNotContain(rig.Model.All, r => r.Id == 15);
        Assert.Contains(rig.Model.All, r => r.Id == 16);
        for (var id = 1; id <= 15; id++) Assert.False(rig.Model.RequestedLately(Key("movie:tmdb:" + (1000 + id))), "request " + id + " taken for gone");
        // A later read keeps the floor (nothing below it is known).
        Many(rig, max + 26, max + 26);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(17, rig.Model.Current.Floor);
        Assert.False(rig.Model.RequestedLately(Key("movie:tmdb:1016")));
        // Seerr shrinks below the cap: the list is complete again and covers everything.
        rig.Seerr.Requests.RemoveAll(r => (int)r["id"]! > 100);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.Current.Floor);
        Assert.Equal(100, rig.Model.All.Count);
    }

    [Fact]
    public async Task AListServedInSmallerPagesThanAskedStillLoadsWhole()
    {
        // A proxy or fork caps pages at 50 rows: the read advances by the rows each page holds and
        // is not cut off by a page count that assumes full pages.
        using var rig = new Rig();
        rig.Seerr.PageCap = 50;
        Many(rig, 1, 2500);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.State.IncompleteReason);
        Assert.Null(rig.Model.State.LastError);
        Assert.Equal(2500, rig.Model.All.Count);
        Assert.False(rig.Model.State.Truncated);
        Assert.Equal(50, rig.Seerr.CallCount("sort=added"));

        // More than are read, in pages of 50: the newest MaxRequests load and the list says so.
        Many(rig, 2501, SeerrFacts.MaxRequests + 5);
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.State.IncompleteReason);
        Assert.True(rig.Model.State.Truncated);
    }

    [Fact]
    public async Task AFirstReadOfMoreRequestsThanAreReadKnowsOnlyTheWindow()
    {
        // After a restart nothing older is held: what lies below the window is unknown.
        using var rig = new Rig();
        Many(rig, 1, SeerrFacts.MaxRequests + 5);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(SeerrFacts.MaxRequests, rig.Model.All.Count);
        Assert.Equal(6, rig.Model.Current.Floor);
        Assert.True(rig.Model.State.Truncated);
    }

    [Fact]
    public async Task ACompleteEmptyListIsAListWithNothingInIt()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5, 1, rig.Emma, T0));
        await rig.Model.RefreshAsync(default);
        rig.Seerr.Requests.Clear();
        rig.Now = rig.Now.AddMinutes(1);
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Empty(rig.Model.All);
        Assert.Null(rig.Model.State.IncompleteReason);
        Assert.True(rig.Model.RequestedLately(Key("movie:tmdb:5")));
    }

    // ------------------------------------------------------------------ the Seerr's identity (C33)

    [Fact]
    public void TheSameSeerrIsTheSameSourceWhateverTheOrderOrSpellingOfItsAddressesAndNeverCarriesTheKey()
    {
        using var rig = new Rig();
        PluginConfiguration With(string urls, string key) => new()
        {
            ArrIntegrationEnabled = true, ArrPhase1Enabled = true, JellyseerrEnabled = true, JellyseerrUrls = urls, JellyseerrApiKey = key,
        };
        var a = rig.Model.SourceOf(With("http://seerr.lan:5055\nhttp://10.0.0.5:5055", FakeSeerr.Key))!;
        Assert.Equal(16, a.Length);
        Assert.Equal(a, rig.Model.SourceOf(With("HTTP://10.0.0.5:5055/, http://Seerr.LAN:5055/", FakeSeerr.Key)));
        Assert.Equal(a, rig.Model.SourceOf(With("http://seerr.lan:5055\nhttp://10.0.0.5:5055\nhttp://seerr.lan:5055", FakeSeerr.Key)));
        Assert.NotEqual(a, rig.Model.SourceOf(With("http://seerr.lan:5055", FakeSeerr.Key)));
        Assert.NotEqual(a, rig.Model.SourceOf(With("http://seerr.lan:5055\nhttp://10.0.0.5:5055", "ANOTHER-KEY-0123456789")));
        Assert.DoesNotContain(FakeSeerr.Key[..8], a, StringComparison.OrdinalIgnoreCase);
        Assert.Null(rig.Model.SourceOf(With("http://seerr.lan:5055", string.Empty)));
    }

    [Fact]
    public async Task PointingAtAnotherSeerrForgetsTheListAtOnceAndReadsTheNewOne()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(7, "movie", 5, 1, rig.Emma, T0));
        await rig.Model.RefreshAsync(default);
        var a = rig.Model.Source;
        Assert.NotNull(a);
        // Another server: before anything is read from it, A's request 7 is no fact about B's titles.
        rig.Config.JellyseerrUrls = "http://seerr-b.lan:5055";
        rig.Seerr.FailWith = 503;
        Assert.True(rig.Model.Due());
        Assert.Empty(rig.Model.All);
        Assert.Null(rig.Model.Source);
        Assert.False(rig.Model.Loaded);
        Assert.False(await rig.Model.RefreshAsync(default));
        Assert.Null(rig.Model.Source);
        rig.Seerr.FailWith = 0;
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.NotEqual(a, rig.Model.Source);
        Assert.Equal(rig.Model.SourceOf(rig.Config), rig.Model.Source);
        // A new key on the same address is read again once, with the same facts.
        var b = rig.Model.Source;
        var full = rig.Seerr.CallCount("sort=added");
        rig.Config.JellyseerrApiKey = "ROTATED-KEY-0123456789abcdef";
        Assert.True(rig.Model.Due());
        Assert.True(await rig.Model.RefreshAsync(default));
        Assert.Equal(full + 1, rig.Seerr.CallCount("sort=added"));
        Assert.NotEqual(b, rig.Model.Source);
        Assert.True(rig.Model.For(Key("movie:tmdb:5"), rig.Viewer(rig.Emma))!.Pending);
        Assert.False(rig.Model.Due());
    }

    // ------------------------------------------------------------------ stopping (C46)

    [Fact]
    public async Task StoppingWaitsForTheReadInProgress()
    {
        using var rig = new Rig();
        rig.Seerr.Requests.Add(FakeSeerr.Request(1, "movie", 5, 1, rig.Emma, T0));
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        rig.Seerr.Hold = async () =>
        {
            entered.TrySetResult();
            await release.Task;
        };
        await rig.Model.StartAsync(default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var patience = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var stop = rig.Model.StopAsync(patience.Token);
        await Task.Delay(300);
        Assert.False(stop.IsCompleted);
        release.SetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(10));
        rig.Seerr.Hold = null;
        var calls = rig.Seerr.Calls.Count;
        await Task.Delay(1500);
        Assert.Equal(calls, rig.Seerr.Calls.Count);
    }

    private static bool Forwards(ServiceDescriptor descriptor, IServiceProvider probe)
    {
        try
        {
            return descriptor.ImplementationFactory!(probe) is SeerrFacts;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
