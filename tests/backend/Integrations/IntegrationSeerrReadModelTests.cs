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
        public SeerrRequestReadModel Model { get; }
        public Guid Emma { get; } = Guid.NewGuid();
        public Guid Sam { get; } = Guid.NewGuid();

        public Rig()
        {
            Feed = new ArrChangeFeed(() => Now);
            Model = new SeerrRequestReadModel(Seerr.Transport, Feed, null, () => Config, () => Now);
        }

        public StatusViewer Viewer(Guid id) => new() { UserId = id, PolicyRevision = "p" };

        public void Dispose()
        {
            Model.Dispose();
            Seerr.Dispose();
        }
    }

    private static TitleKey Key(string key) => TitleKey.Parse(key)!;

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
        // itself, as a hosted service and as the request facts, so the container disposes the one
        // instance up to three times. A throw there escaped Program.StartServer (restart = crash).
        using var rig = new Rig();
        var registered = new ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(registered, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>());
        // The registrator's own forwarding registrations, with the read model itself made by the test.
        using var probe = new ServiceCollection().AddSingleton(_ => rig.Model).BuildServiceProvider();
        var forwards = registered.Where(d => d.ServiceType == typeof(IHostedService) && d.ImplementationFactory != null && Forwards(d, probe)).ToList();
        Assert.Single(forwards);
        var facts = registered.Single(d => d.ServiceType == typeof(IArrRequestFacts));
        Assert.Same(rig.Model, facts.ImplementationFactory!(probe));

        IServiceCollection services = new ServiceCollection();
        services.AddSingleton(_ => rig.Model);
        foreach (var d in forwards) services.Add(d);
        services.Add(facts);
        var provider = services.BuildServiceProvider();
        var hosted = provider.GetServices<IHostedService>().ToList();
        Assert.Same(rig.Model, Assert.Single(hosted));
        Assert.Same(rig.Model, provider.GetRequiredService<IArrRequestFacts>());
        Assert.Same(rig.Model, provider.GetRequiredService<SeerrRequestReadModel>());
        foreach (var h in hosted) await h.StartAsync(default);
        foreach (var h in hosted) await h.StopAsync(default);

        var thrown = Record.Exception(() => provider.Dispose());
        Assert.Null(thrown);
        // Twice more by hand, for good measure.
        rig.Model.Dispose();
        rig.Model.Dispose();
    }

    private static bool Forwards(ServiceDescriptor descriptor, IServiceProvider probe)
    {
        try
        {
            return descriptor.ImplementationFactory!(probe) is SeerrRequestReadModel;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
