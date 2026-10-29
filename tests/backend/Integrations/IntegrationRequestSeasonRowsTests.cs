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
        /// <summary>The request target's Sonarr season; by default it doesn't hold the series (TMDB's numbering, as before UX-3).</summary>
        public Func<string, IReadOnlyList<TitleKey>, int, DestinationSeason>? Destination { get; set; }
        public List<(string Instance, IReadOnlyList<TitleKey> Titles, int Season)> DestinationCalls { get; } = new();
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
            }, () => R.Now, destination: (instance, titles, season, ct) =>
            {
                DestinationCalls.Add((instance, titles, season));
                return Task.FromResult(Destination == null ? DestinationSeason.NotHeld : Destination(instance, titles, season));
            });
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
    public async Task ASeasonOfATitleThatIsntInTheLibraryListsEveryEpisodeFromMetadata()
    {
        using var s = new Setup();
        var seriesPage = Guid.NewGuid();
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = TitleKey.Parse("tv:tvdb:393189")!, TmdbId = 83867, Season = 1, SeriesPageId = seriesPage };
        var rows = await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), page, "en", CancellationToken.None);
        Assert.NotNull(rows);
        Assert.Equal(("tv:tvdb:393189:s1", "tv:tvdb:393189", seriesPage.ToString("N")), (rows!.Key, rows.Series, rows.SeriesId));
        // No file anywhere: every episode gets its metadata (Jellyfin's rows of E1/E2 belong to another series here).
        Assert.Equal(new[] { 1, 2, 3, 4 }, rows.Episodes.Select(e => e.Episode));
        Assert.Equal(("Pilot", "/a1.jpg"), (rows.Episodes[0].Title, rows.Episodes[0].Still));
        Assert.Equal((83867, 1, "en"), s.TmdbCalls.Single());
        Assert.True(rows.CanRequest);
        // Episodes the library has but hides from this viewer get no row (no title, overview or still).
        var hiding = await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = page.Title, TmdbId = 83867, Season = 1, SeriesPageId = seriesPage, HiddenEpisodes = new[] { 2 } }, "en", CancellationToken.None);
        Assert.Equal(new[] { 1, 3, 4 }, hiding!.Episodes.Select(e => e.Episode));
        // Spoiler Guard on the title: no title, overview or still (the air date as its switch says), the rows themselves stay.
        var guarded = await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = page.Title, TmdbId = 83867, Season = 1, SeriesPageId = seriesPage, Spoilers = new AbsentRowSpoilers(true, true, false) }, "en", CancellationToken.None);
        Assert.Equal(new[] { 1, 2, 3, 4 }, guarded!.Episodes.Select(e => e.Episode));
        Assert.All(guarded.Episodes, e => Assert.True(e.Title == null && e.Overview == null && e.Still == null));
        Assert.Equal(rows.Episodes[0].AirDate, guarded.Episodes[0].AirDate);
        // Only season pages with their series page have rows.
        Assert.Null(await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), new AbsentTitle { PageId = Guid.NewGuid(), Kind = "episode", Title = page.Title, Season = 1, SeriesPageId = seriesPage }, null, CancellationToken.None));
        Assert.Null(await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = page.Title, Season = 1 }, null, CancellationToken.None));
    }

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

    private static DestinationSeason Sonarr(params (int Episode, string? Title, string? Day)[] episodes)
        => new(true, true, episodes.Select(e => new DestinationEpisode(e.Episode, e.Title, e.Day == null ? null : DateTime.Parse(e.Day + "T04:00:00Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal))).ToList());

    [Fact]
    public async Task UX3_WhenTheTargetsSonarrHoldsTheSeriesTheRowsCarryOnlyItsNumbersTitlesAndDays()
    {
        using var s = new Setup();
        // TMDB lists E1–E4 (E3 with a foreign title); Sonarr lists E1, E2, E3 under its own titles, and E5 TMDB doesn't.
        s.Destination = (_, _, _) => Sonarr((1, "Sonarr Pilot", "2014-06-01"), (2, "Sonarr Two", "2014-06-08"), (3, "Sonarr Three", "2014-06-15"), (5, "Sonarr Five", "2099-01-01"));
        var rows = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "en", CancellationToken.None);
        Assert.Equal("destination", rows!.Source);
        Assert.Equal(new[] { 1, 2, 3, 5 }, rows.Episodes.Select(e => e.Episode));          // TMDB's E4 isn't Sonarr's: not offered
        var two = rows.Episodes.Single(e => e.Episode == 2);
        Assert.Equal(("Sonarr Two", "2014-06-08", true), (two.Title, two.AirDate, two.Aired));
        Assert.Null(two.Overview); Assert.Null(two.Still); Assert.Null(two.Runtime);         // nothing of TMDB's
        Assert.DoesNotContain(rows.Episodes, e => e.Title is "Pilot" or "Two" or "Three" or "Four");
        Assert.Null(rows.Episodes.Single(e => e.Episode == 1).Title);                        // E1 has a file: Jellyfin's row says it
        Assert.True(rows.Episodes.Single(e => e.Episode == 1).Aired);
        Assert.False(rows.Episodes.Single(e => e.Episode == 5).Aired);                       // not aired yet
        Assert.Equal(("r1", 1), (s.DestinationCalls.Single().Instance, s.DestinationCalls.Single().Season));
        Assert.Contains(s.DestinationCalls.Single().Titles, k => k.ToString() == "tv:tvdb:78874");

        // Absent page: hidden episodes stay out, and Spoiler Guard strips Sonarr's titles and days like TMDB's.
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = TitleKey.Parse("tv:tvdb:78874")!, TmdbId = 1437, Season = 1, SeriesPageId = Guid.NewGuid(), HiddenEpisodes = new[] { 3 },
            Spoilers = new AbsentRowSpoilers(true, true, true) };
        var absent = await s.Rows.ForAbsentSeasonAsync(s.Viewer(s.R.Member), page, "en", CancellationToken.None);
        Assert.Equal(new[] { 1, 2, 5 }, absent!.Episodes.Select(e => e.Episode));
        Assert.All(absent.Episodes, e => { Assert.Null(e.Title); Assert.Null(e.AirDate); });
        Assert.True(absent.Episodes.Single(e => e.Episode == 2).Aired, "Pick episodes still knows what aired");
    }

    [Fact]
    public async Task UX3_WithNoRequestableSonarrHoldingTheSeriesTheRowsCarryTmdbsNumbersAndFacts()
    {
        using var s = new Setup();
        var rows = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "en", CancellationToken.None);
        Assert.Equal("provider", rows!.Source);
        Assert.Equal(new[] { 1, 2, 3, 4 }, rows.Episodes.Select(e => e.Episode));
        Assert.Equal("Two", rows.Episodes.Single(e => e.Episode == 2).Title);
        // Seerr takes requests: TMDB's numbering is what it is sent; Sonarr isn't read.
        s.R.Policy.Configuration.ArrRequestBackend = "seerr";
        var before = s.DestinationCalls.Count;
        Assert.Equal("provider", (await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "en", CancellationToken.None))!.Source);
        Assert.Equal(before, s.DestinationCalls.Count);
    }

    [Fact]
    public async Task UX3_AnUnreadTargetOrOneTheViewerMayNotUsePublishesNoSonarrFacts()
    {
        using var s = new Setup();
        foreach (var unread in new Func<string, IReadOnlyList<TitleKey>, int, DestinationSeason>[] { (_, _, _) => DestinationSeason.Unread, (_, _, _) => throw new InvalidOperationException("Sonarr down") })
        {
            s.Destination = unread;
            var rows = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "en", CancellationToken.None);
            Assert.Equal("unknown", rows!.Source);
            Assert.All(rows.Episodes, e => { Assert.Null(e.Title); Assert.False(e.Aired); });   // no TMDB facts on Sonarr's numbers either
        }
        // A target the viewer may not use is never read, and the rows say nothing about it.
        s.Destination = (_, _, _) => Sonarr((1, "Private", "2014-06-01"), (9, "Private Extra", "2014-06-01"));
        s.R.Policy.Adjust = (_, _, facts) => facts with { Visible = false };
        var calls = s.DestinationCalls.Count;
        var hidden = await s.Rows.ForSeasonAsync(s.Viewer(s.R.Member), s.SeasonId, "en", CancellationToken.None);
        Assert.Equal("unchecked", hidden!.Source);
        Assert.Equal(calls, s.DestinationCalls.Count);
        Assert.DoesNotContain(hidden.Episodes, e => e.Episode == 9 || e.Title is "Private" or "Private Extra");
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
    public async Task F83_AnAskStillInTmdbsNumberingNeverMarksARowOfTheTargetsOwnNumbering()
    {
        using var s = new Setup();
        var r = s.R;
        // Asked while no Sonarr held the series: TMDB's E2 (noted by the server), and a Sonarr-numbered E3 asked since.
        r.Service.Numbering = (_, _, _) => Task.FromResult((true, true));
        Assert.Equal(201, (await r.Create(r.Member, Episodes(2))).HttpStatus);
        r.Service.Numbering = (_, _, _) => Task.FromResult((true, false));
        Assert.Equal(201, (await r.Create(r.Member, Episodes(3))).HttpStatus);
        // TMDB's numbering on the rows: its E2 is the ask.
        var tmdbRows = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal(("provider", "asked"), (tmdbRows!.Source, tmdbRows.Episodes.Single(e => e.Episode == 2).Request));
        // Sonarr holds the series now: its E2 may be another episode, so the TMDB-numbered ask shows on no row; E3 still does.
        s.Destination = (_, _, _) => Sonarr((1, "One", "2014-06-01"), (2, "Two", "2014-06-08"), (3, "Three", "2014-06-15"));
        var rows = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("destination", rows!.Source);
        Assert.Null(rows.Episodes.Single(e => e.Episode == 2).Request);
        Assert.Equal("asked", rows.Episodes.Single(e => e.Episode == 3).Request);
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
    public void AnAskSentToSeerrThatWaitsForAnOkThereStillReadsWaiting()
    {
        // Seen live in Seerr mode: Get Season 1 went to Seerr, which holds it for an OK; the rows said "asked", so the
        // episode Sonarr doesn't fetch yet offered Get Season 1 again.
        var viewer = Guid.NewGuid();
        var want = new RequestWant("w1", "q", viewer, "c1", "f", new MutationInput { Key = "tv:tvdb:76924", Scope = "seasons", Seasons = new[] { 1 } }, "sent", "awaiting_approval", 0, "null", DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
        Assert.Equal("waiting", SeasonRowsService.StateOf(want, viewer, DateTimeOffset.UtcNow, 7));
        Assert.Equal("asked", SeasonRowsService.StateOf(want with { Reason = "looking" }, viewer, DateTimeOffset.UtcNow, 7));
        Assert.Equal("household", SeasonRowsService.StateOf(want, Guid.NewGuid(), DateTimeOffset.UtcNow, 7));
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

        // Seerr mode: Seerr's request permissions are per kind (REQUEST_TV without REQUEST or REQUEST_MOVIE).
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        r.Policy.Adjust = (_, input, facts) => TitleKey.Parse(input.Key)!.IsMovie ? facts with { CanCreate = false } : facts;
        var tvOnly = Me(r.Member);
        Assert.Equal((true, false, true), (tvOnly.CanRequest, tvOnly.CanRequestMovies, tvOnly.CanRequestSeries));
        r.Policy.Adjust = (_, input, facts) => facts with { CanCreate = TitleKey.Parse(input.Key)!.IsMovie };
        var moviesOnly = Me(r.Member);
        Assert.Equal((true, true, false), (moviesOnly.CanRequest, moviesOnly.CanRequestMovies, moviesOnly.CanRequestSeries));
        r.Policy.Adjust = (_, _, facts) => facts with { CanCreate = false };
        Assert.Equal((false, false, false), (Me(r.Member).CanRequest, Me(r.Member).CanRequestMovies, Me(r.Member).CanRequestSeries));
    }

    [Fact]
    public async Task AfterAMoveFromSeerrTheRowsShowTheRequestWaitingHereNotTheAskLeftOnSeerr()
    {
        // Seerr mode: the member's season 1 went out to Seerr, where it still waits for an OK.
        using var s = new Setup();
        var r = s.R;
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        r.Policy.Adjust = (_, _, facts) => facts.Backend == "seerr" ? facts with { SeerrSource = "seerr-src", SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) } : facts;
        Assert.Equal(201, (await r.Create(r.Member, IntegrationRequestLedgerTests.Seasons(1))).HttpStatus);
        await r.Runner().TickAsync(CancellationToken.None);
        Assert.Equal("sent", r.Ledger.ForTitle("tv:tvdb:78874").Single().Status);
        Assert.Equal("asked", (await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None))!.SeasonRequest);

        // The move to Jellyfin Enhanced brings that Seerr request in, waiting for an OK on the JE target.
        r.Policy.Configuration.ArrRequestBackend = "je";
        var target = RequestLedger.TargetKey(r.Policy.Evaluate(r.Member, IntegrationRequestLedgerTests.Seasons(1)));
        Assert.Equal(1, r.Ledger.ImportSeerr("src", "digest", new[] { new ImportCandidate(r.Member, 11, IntegrationRequestLedgerTests.Seasons(1), true, r.Now.AddDays(-2)) },
            new Dictionary<string, int>(), r.Admin, "seerr", _ => target, r.Now, TimeSpan.FromDays(14)).Imported);
        Assert.Equal(new[] { "pending", "sent" }, r.Ledger.ForTitle("tv:tvdb:78874").Select(w => w.Status).OrderBy(x => x));

        // Nothing goes out until someone OKs it here: the rows say so (the ask left on Seerr doesn't hide it).
        var rows = await s.Rows.ForSeasonAsync(s.Viewer(r.Member), s.SeasonId, null, CancellationToken.None);
        Assert.Equal("waiting", rows!.SeasonRequest);
        // A household member's view: one household ask, not two.
        Assert.Equal("household", (await s.Rows.ForSeasonAsync(s.Viewer(r.Manager), s.SeasonId, null, CancellationToken.None))!.SeasonRequest);
        // An episode ask left on Seerr shows only where nothing here covers that episode.
        var (episodes, season) = SeasonRowsService.RequestStates(new[]
        {
            new RequestWant("a", "q", r.Member, "c1", "f", Episodes(3, 4), "sent", "looking", 0, "null", r.Now, r.Now, TargetKey: "[\"seerr\"]"),
            new RequestWant("b", "q", r.Member, "c2", "f", Episodes(4), "pending", "awaiting_approval", 0, "null", r.Now, r.Now, TargetKey: target),
        }, r.Member, 1, r.Now, 7, target);
        Assert.Null(season);
        Assert.Equal(("asked", "waiting"), (episodes[3], episodes[4]));
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
