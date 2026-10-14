using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Phase 3c: the season page's request rows (GET acquire/requests/season/{itemId}) and the caller's own
/// request capabilities (GET acquire/requests/me).
/// </summary>
public class IntegrationRequestSeasonRowsTests
{
    private const string SeasonJson = """
        {"episodes":[
          {"episode_number":1,"name":"Pilot","overview":"First.","runtime":45,"air_date":"2014-06-01","still_path":"/a1.jpg"},
          {"episode_number":2,"name":"Two","overview":"Second.","runtime":44,"air_date":"2014-06-08","still_path":"/b2.jpg"},
          {"episode_number":3,"name":"Three","overview":"Third.","runtime":43,"air_date":"2014-06-15","still_path":"https://evil.example/x.jpg"},
          {"episode_number":4,"name":"Four","overview":"Fourth.","runtime":0,"air_date":"not a date","still_path":"/d4.jpg"},
          {"episode_number":"5","name":"Bad number"}
        ]}
        """;

    private sealed class Setup : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public Guid SeriesId { get; } = Guid.NewGuid();
        public Guid SeasonId { get; } = Guid.NewGuid();
        public List<(int Id, int Season, string? Language)> TmdbCalls { get; } = new();
        public string? Json { get; set; } = SeasonJson;
        public SeasonRowsService Rows { get; }
        public TitleKey Series { get; } = TitleKey.Parse("tv:tvdb:78874")!;

        public Setup(int? tmdbId = 1437, params Guid[] visibleTo)
        {
            R.View.AddItem(new JfItemRef { ItemId = SeasonId, Kind = "season", Key = Series.WithSeason(1), SeriesId = SeriesId, Season = 1, TmdbId = tmdbId }, visibleTo);
            R.View.AddEpisode(SeriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1 });
            R.View.AddEpisode(SeriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, Virtual = true });
            Rows = new SeasonRowsService(R.View, R.Ledger, R.Policy, null, (id, season, language, ct) =>
            {
                TmdbCalls.Add((id, season, language));
                return Task.FromResult<string?>(Json);
            }, () => R.Now);
        }

        public StatusViewer Viewer(Guid id) => R.View.Users[id];

        public AcquireRequestsController Controller(Guid user, System.Security.Claims.ClaimsPrincipal? principal = null)
        {
            var controller = new AcquireRequestsController(R.Service, Rows) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal ?? TestCallers.Principal(user, user == R.Admin);
            return controller;
        }

        public void Dispose() => R.Dispose();
    }

    private static MutationInput Episodes(params int[] numbers)
        => new() { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = numbers.Select(n => new RequestEpisode(1, n)).ToArray() };

    [Fact]
    public async Task MetadataIsSentOnlyForEpisodesWithoutAFileAndOnlySafeStillPaths()
    {
        using var s = new Setup();
        var rows = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "de", CancellationToken.None);

        Assert.NotNull(rows);
        Assert.Equal("tv:tvdb:78874:s1", rows!.Key);
        Assert.Equal("tv:tvdb:78874", rows.Series);
        Assert.Equal(s.SeriesId.ToString("N"), rows.SeriesId);
        Assert.Equal(new[] { 1, 2, 3, 4 }, rows.Episodes.Select(e => e.Episode));
        var one = rows.Episodes[0];
        Assert.Null(one.Title);                       // E1 has a file: Jellyfin's own row says it all
        Assert.Null(one.Still);
        var two = rows.Episodes[1];                   // E2 is Jellyfin's virtual row: metadata for it
        Assert.Equal("Two", two.Title);
        Assert.Equal(44, two.Runtime);
        Assert.Equal("2014-06-08", two.AirDate);
        Assert.Equal("/b2.jpg", two.Still);
        var three = rows.Episodes[2];
        Assert.Null(three.Still);                     // never a foreign URL
        var four = rows.Episodes[3];
        Assert.Null(four.Runtime);
        Assert.Null(four.AirDate);                    // invalid date dropped
        Assert.Equal((1437, 1, "de"), s.TmdbCalls.Single());
        Assert.True(rows.CanRequest);
        Assert.False(rows.DisplayMissing);
    }

    [Fact]
    public async Task AnInvalidLanguageIsNotPassedUpstreamAndNoTmdbIdMeansNoMetadata()
    {
        using var s = new Setup();
        await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "de&api_key=x", CancellationToken.None);
        Assert.Null(s.TmdbCalls.Single().Language);

        using var without = new Setup(tmdbId: null);
        var rows = await without.Rows.ForSeasonAsync(without.Viewer(without.R.Member), without.SeasonId, null, CancellationToken.None);
        Assert.Empty(without.TmdbCalls);
        Assert.Equal(new[] { 1, 2 }, rows!.Episodes.Select(e => e.Episode));
        Assert.All(rows.Episodes, e => Assert.Null(e.Title));
    }

    [Fact]
    public async Task RequestStatesAreTheViewersOwnFirstAndOtherPeopleOnlyAsHousehold()
    {
        using var s = new Setup();
        var r = s.R;
        Assert.Equal(201, (await r.Create(r.Kid, Episodes(2))).HttpStatus);              // pending: waiting
        Assert.Equal(201, (await r.Create(r.Member, Episodes(3))).HttpStatus);            // queued: asked
        var declined = await r.Create(r.Kid, Episodes(4));
        Assert.Equal(200, r.Service.Close(declined.RequestId!, r.Admin, "Not for kids").HttpStatus);

        var kid = await s.Rows.ForSeasonAsync(s.Viewer(r.Kid), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("waiting", kid!.Episodes.Single(e => e.Episode == 2).Request);
        Assert.Equal("household", kid.Episodes.Single(e => e.Episode == 3).Request);
        Assert.Equal("declined", kid.Episodes.Single(e => e.Episode == 4).Request);
        Assert.Null(kid.Episodes.Single(e => e.Episode == 1).Request);

        var member = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("household", member!.Episodes.Single(e => e.Episode == 2).Request);
        Assert.Equal("asked", member.Episodes.Single(e => e.Episode == 3).Request);
        Assert.Null(member.Episodes.Single(e => e.Episode == 4).Request);                 // someone else's "no" stays theirs

        // The body names nobody and carries no request ids.
        var json = JsonSerializer.Serialize(member);
        Assert.DoesNotContain(r.Kid.ToString("N"), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(r.Kid.ToString(), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(declined.RequestId!, json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A4kAskLeavesTheStandardControlsAlone()
    {
        using var s = new Setup();
        var r = s.R;
        Assert.Equal(201, (await r.Create(r.Admin, Episodes(3) with { Variant = "4k" })).HttpStatus);
        Assert.Equal(201, (await r.Create(r.Admin, new MutationInput { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 1 }, Variant = "4k" })).HttpStatus);
        var member = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Null(member!.Episodes.Single(e => e.Episode == 3).Request);   // nobody asked for the standard copy
        Assert.Null(member.SeasonRequest);
        var admin = await s.Rows.ForSeasonAsync(s.Viewer(r.Admin), s.SeasonId, null, CancellationToken.None);
        Assert.Null(admin!.Episodes.Single(e => e.Episode == 3).Request);
        Assert.Equal(201, (await r.Create(r.Kid, Episodes(3))).HttpStatus);
        member = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("household", member!.Episodes.Single(e => e.Episode == 3).Request);
    }

    [Fact]
    public async Task AnOwnDeclineShowsOnlyWhileItStillBlocksAskingAgain()
    {
        using var s = new Setup();
        var r = s.R;
        var declined = await r.Create(r.Kid, Episodes(4));
        Assert.Equal(200, r.Service.Close(declined.RequestId!, r.Admin, "Not for kids").HttpStatus);
        var kid = await s.Rows.ForSeasonAsync(s.Viewer(r.Kid), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("declined", kid!.Episodes.Single(e => e.Episode == 4).Request);
        Assert.Equal("decline_cooldown", (await r.Create(r.Kid, Episodes(4))).Reason);

        r.Now = r.Now.AddDays(7);                                                  // the cooldown is over
        kid = await s.Rows.ForSeasonAsync(s.Viewer(r.Kid), s.SeasonId, null, CancellationToken.None);
        Assert.Null(kid!.Episodes.Single(e => e.Episode == 4).Request);           // Get it again
        Assert.Equal(201, (await r.Create(r.Kid, Episodes(4))).HttpStatus);       // and the ledger agrees

        r.Policy.Configuration.ArrRequestDeclineCooldownDays = 30;
        Assert.Equal("declined", SeasonRowsService.StateOf(r.Ledger.Find(declined.RequestId!)!, r.Kid, r.Now, 30));
    }

    [Fact]
    public async Task TheSeriesAllowanceSaysHowManySingleEpisodesAreChargedThisWindow()
    {
        using var s = new Setup();
        var r = s.R;
        Assert.Equal(0, r.Service.Quota(r.Member, movie: false).Episodes);
        Assert.Equal(201, (await r.Create(r.Member, Episodes(1, 2, 3, 4, 5))).HttpStatus);   // the free ones
        var quota = r.Service.Quota(r.Member, movie: false);
        Assert.Equal(5, quota.Episodes);
        Assert.Equal(0, quota.Used);
        Assert.Equal(201, (await r.Create(r.Member, Episodes(6))).HttpStatus);              // one more costs a request
        Assert.Equal((6, 1), (r.Service.Quota(r.Member, movie: false).Episodes, r.Service.Quota(r.Member, movie: false).Used));
        Assert.Null(r.Service.Quota(r.Member).Episodes);                                     // movies: not part of the answer
        Assert.DoesNotContain("episodes", JsonSerializer.Serialize(r.Service.Quota(r.Member)), StringComparison.Ordinal);
        r.Now = r.Now.AddDays(8);                                                            // out of the window
        Assert.Equal(0, r.Service.Quota(r.Member, movie: false).Episodes);
    }

    [Fact]
    public async Task AWholeSeasonAskIsTheSeasonsStateAndAnotherSeasonIsIgnored()
    {
        using var s = new Setup();
        var r = s.R;
        await r.Create(r.Member, new MutationInput { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 1 } });
        await r.Create(r.Kid, new MutationInput { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 2 } });
        var member = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("asked", member!.SeasonRequest);
        var kid = await s.Rows.ForSeasonAsync(s.Viewer(r.Kid), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("household", kid!.SeasonRequest);
    }

    [Theory]
    [InlineData("asked", "waiting", "asked")]
    [InlineData("waiting", "asked", "asked")]
    [InlineData("household", "declined", "declined")]
    [InlineData(null, "household", "household")]
    public void TheViewersOwnStateWins(string? current, string next, string expected)
        => Assert.Equal(expected, SeasonRowsService.Stronger(current, next));

    [Fact]
    public async Task EpisodesJellyfinHidesFromTheViewerAreLeftOut()
    {
        using var s = new Setup();
        var kid = s.R.View.AddUser(false, parental: true);
        s.R.Policy.People[kid.UserId] = s.R.Policy.People[s.R.Kid] with { UserId = kid.UserId };
        s.R.View.AddEpisode(s.SeriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, Virtual = true }, s.R.Admin);
        var rows = await s.Rows.ForSeasonAsync(kid, s.SeasonId, null, CancellationToken.None);
        Assert.DoesNotContain(rows!.Episodes, e => e.Episode == 3);
        var admin = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Admin), s.SeasonId, null, CancellationToken.None);
        Assert.Contains(admin!.Episodes, e => e.Episode == 3 && e.Title == "Three");
    }

    [Fact]
    public async Task OnlyAVisibleSeasonAnswersAndWatchersCannotAsk()
    {
        using var s = new Setup(1437, Guid.Empty);                                          // visible to nobody
        Assert.Null(await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, null, CancellationToken.None));
        Assert.Null(await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), Guid.NewGuid(), null, CancellationToken.None));

        using var open = new Setup();
        var watcher = open.R.Add("Watcher");
        var rows = await open.Rows.ForSeasonAsync(open.Viewer(watcher), open.SeasonId, null, CancellationToken.None);
        Assert.False(rows!.CanRequest);
        open.R.Policy.Configuration.ArrRequestBackend = "status_only";
        var statusOnly = await open.Rows.ForSeasonAsync(open.Viewer(open.R.Member), open.SeasonId, null, CancellationToken.None);
        Assert.False(statusOnly!.CanRequest);
    }

    [Fact]
    public async Task TheSeasonRouteRefusesNonPeopleBadIdsAndInvisibleItems()
    {
        using var s = new Setup();
        var key = await s.Controller(s.R.Member, TestCallers.ApiKey()).Season(s.SeasonId.ToString("N"));
        Assert.Equal(403, Assert.IsType<ObjectResult>(key).StatusCode);
        var bad = await s.Controller(s.R.Member).Season("not-a-guid");
        Assert.Equal(400, Assert.IsType<ObjectResult>(bad).StatusCode);
        var missing = await s.Controller(s.R.Member).Season(Guid.NewGuid().ToString("N"));
        Assert.Equal(404, Assert.IsType<ObjectResult>(missing).StatusCode);

        var controller = s.Controller(s.R.Member);
        var ok = Assert.IsType<FileContentResult>(await controller.Season(s.SeasonId.ToString()));
        using var doc = JsonDocument.Parse(ok.FileContents);
        Assert.Equal("accepted", doc.RootElement.GetProperty("outcome").GetString());
        Assert.Equal(4, doc.RootElement.GetProperty("rows").GetProperty("episodes").GetArrayLength());
        Assert.Equal("private, no-cache", controller.Response.Headers["Cache-Control"].ToString());
        var etag = controller.Response.Headers["ETag"].ToString();
        Assert.False(string.IsNullOrEmpty(etag));

        var again = s.Controller(s.R.Member);
        again.HttpContext.Request.Headers["If-None-Match"] = etag;
        Assert.Equal(304, Assert.IsType<StatusCodeResult>(await again.Season(s.SeasonId.ToString("N"))).StatusCode);

        s.R.Policy.Configuration.ArrPhase3Enabled = false;
        var off = await s.Controller(s.R.Member).Season(s.SeasonId.ToString("N"));
        Assert.Equal(403, Assert.IsType<ObjectResult>(off).StatusCode);
    }

    [Fact]
    public async Task MeTellsTheCallerTheirOwnRoleAndCapabilitiesOnly()
    {
        using var s = new Setup();
        var r = s.R;
        r.Policy.Configuration.ArrHouseholdContactName = "  Dad ";

        RequestCapabilities Me(Guid user)
        {
            var result = Assert.IsType<OkObjectResult>(s.Controller(user).Me().GetAwaiter().GetResult());
            var json = JsonSerializer.Serialize(result.Value);
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Deserialize<RequestCapabilities>(doc.RootElement.GetProperty("me").GetRawText())!;
        }

        var kid = Me(r.Kid);
        Assert.Equal("kid", kid.Role);
        Assert.True(kid.CanRequest);
        Assert.True(kid.AsksFirst);
        Assert.False(kid.CanApprove);
        Assert.False(kid.Can4kMovies);
        Assert.Equal("Dad", kid.Contact);
        Assert.Equal("je", kid.Backend);

        var member = Me(r.Member);
        Assert.False(member.AsksFirst);
        r.Policy.Configuration.ArrRequestPreset = "approve_everything";
        Assert.True(Me(r.Member).AsksFirst);

        Assert.True(Me(r.Manager).CanApprove);
        var admin = Me(r.Admin);
        Assert.Equal("admin", admin.Role);
        Assert.True(admin.Can4kMovies);

        var watcher = r.Add("Watcher");
        var w = Assert.IsType<OkObjectResult>(await s.Controller(watcher).Me());
        Assert.Contains("\"canRequest\":false", JsonSerializer.Serialize(w.Value), StringComparison.Ordinal);

        var apiKey = await s.Controller(r.Member, TestCallers.ApiKey()).Me();
        Assert.Equal(403, Assert.IsType<ObjectResult>(apiKey).StatusCode);
        r.Policy.Configuration.ArrRequestBackend = "status_only";
        Assert.False(Me(r.Member).CanRequest);
    }

    [Fact]
    public void TmdbSeasonParsingIgnoresJunk()
    {
        Assert.Empty(SeasonRowsService.ParseSeason(null));
        Assert.Empty(SeasonRowsService.ParseSeason("{not json"));
        Assert.Empty(SeasonRowsService.ParseSeason("[]"));
        Assert.Empty(SeasonRowsService.ParseSeason("{\"episodes\":5}"));
        var longText = new string('x', 2000);
        var parsed = SeasonRowsService.ParseSeason("{\"episodes\":[{\"episode_number\":7,\"overview\":\"" + longText + "\"}]}").Single();
        Assert.Equal(7, parsed.Episode);
        Assert.True(parsed.Overview!.Length <= SeasonRowsService.MaxOverview);
        Assert.Null(parsed.Title);
    }
}
