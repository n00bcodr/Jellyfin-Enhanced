using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Moq;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

public class IntegrationRequestPolicyTablesTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);
    [Theory]
    [InlineData(7, 2, 5, 1)]
    [InlineData(7, 7, 0, 1)]
    [InlineData(2, 4, 0, 3)]
    [InlineData(1, 4, 0, 4)]
    public void QuotaProjectionWalksExpiriesEvenWhenSlotsRemainOrLimitIsLowered(int limit, int count, int remaining, int days)
    {
        var charges = Enumerable.Range(1, count).Select(i => new QuotaCharge(1, Now.AddDays(i - 7)));
        var result = QuotaProjector.Project(charges, limit, TimeSpan.FromDays(7), Now);
        Assert.Equal(count, result.Used); Assert.Equal(remaining, result.Remaining); Assert.Equal(Now.AddDays(days), result.NextSlotAt);
    }
    [Fact]
    public void StrictWindowUnlimitedAndIncompleteReadsAreExplicit()
    {
        var charges = new[] { new QuotaCharge(4, Now.AddDays(-7)), new QuotaCharge(2, Now.AddDays(-1)), new QuotaCharge(100, Now.AddDays(1)) };
        var unlimited = QuotaProjector.Project(charges, null, TimeSpan.FromDays(7), Now);
        Assert.Equal(2, unlimited.Used); Assert.Null(unlimited.Remaining); Assert.Equal(Now.AddDays(6), unlimited.NextSlotAt);
        Assert.False(QuotaProjector.Project(charges, 7, TimeSpan.FromDays(7), Now, false).Available);
        Assert.Null(QuotaProjector.Project(Array.Empty<QuotaCharge>(), 7, TimeSpan.FromDays(7), Now).NextSlotAt);
        var lowered = QuotaProjector.Project(new[] { new QuotaCharge(5, Now.AddDays(-2)), new QuotaCharge(2, Now.AddDays(-1)) }, 2, TimeSpan.FromDays(7), Now);
        Assert.Equal(Now.AddDays(6), lowered.NextSlotAt);
    }
    [Theory]
    [InlineData("je", true, true, true, false, false, true)]
    [InlineData("je", false, true, true, true, true, false)]
    [InlineData("je", true, false, true, true, true, false)]
    [InlineData("je", true, true, false, true, true, false)]
    [InlineData("seerr", true, true, true, true, true, true)]
    [InlineData("seerr", true, true, true, false, true, false)]
    [InlineData("seerr", true, true, true, true, false, false)]
    [InlineData("status_only", true, true, true, true, true, false)]
    public void One4kCapabilityHasNoJellyfinAdminBypass(string backend, bool jeSwitch, bool capability, bool target4k, bool seerrSetting, bool seerrPermission, bool expected)
    {
        var config = new PluginConfiguration { JellyseerrEnable4KRequests = jeSwitch, JellyseerrEnable4KTvRequests = jeSwitch };
        Assert.Equal(expected, RequestPolicy.Can4k(config, true, backend, capability, target4k, seerrSetting, seerrPermission));
        Assert.Equal(expected, RequestPolicy.Can4k(config, false, backend, capability, target4k, seerrSetting, seerrPermission));
    }
    [Fact]
    public void PhaseThreeEditionSwitchesAreIndependentOfSeerrConfigurationAndStartOff()
    {
        var config = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true,
            ArrRequestBackend = "je", JellyseerrEnabled = false, JellyseerrEnable4KRequests = true, JellyseerrEnable4KTvRequests = true };
        Assert.False(RequestPolicy.Can4k(config, true, "je", true, true, false, false));
        Assert.False(RequestPolicy.Can4k(config, false, "je", true, true, false, false));
        config.ArrRequest4kMoviesEnabled = true;
        Assert.True(RequestPolicy.Can4k(config, true, "je", true, true, false, false));
        Assert.False(RequestPolicy.Can4k(config, false, "je", true, true, false, false));
        config.ArrRequest4kSeriesEnabled = true;
        Assert.True(RequestPolicy.Can4k(config, false, "je", true, true, false, false));
    }

    [Theory]
    [InlineData("Kid", "open_house", "awaiting_approval")]
    [InlineData("Kid", "ask_first", "awaiting_approval")]
    [InlineData("Kid", "approve_everything", "awaiting_approval")]
    [InlineData("Member", "open_house", "queued_outage")]
    [InlineData("Member", "ask_first", "queued_outage")]
    [InlineData("Member", "approve_everything", "awaiting_approval")]
    [InlineData("Manager", "approve_everything", "queued_outage")]
    [InlineData("Admin", "approve_everything", "queued_outage")]
    public async Task PresetsKeepKidsBehindApprovalWhileManagersAndAdminsCanRequest(string role, string preset, string reason)
    {
        using var r = new IntegrationRequestLedgerTests.Rig(); r.Policy.Configuration.ArrRequestPreset = preset;
        Assert.Equal(reason, (await r.Create(r.Add(role))).Reason);
    }
    [Fact]
    public async Task QuotaReservationsSerializeConcurrentTitlesAndGbCapRefuses()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Limit = 1 };
        var outcomes = await Task.WhenAll(Enumerable.Range(1, 12).Select(i => Task.Run(() => r.Create(input: IntegrationRequestLedgerTests.Movie(i)))));
        Assert.Equal(1, r.Service.Quota(r.Member).Used); Assert.Equal(1, outcomes.Count(o => o.Reason == "queued_outage"));
        Assert.Equal(10, outcomes.Count(o => o.Reason == "over_quota")); Assert.Single(outcomes, o => o.HttpStatus == 429);
        var other = r.Add("Member"); r.Policy.People[other] = r.Policy.People[other] with { GbLimit = 1 };
        var refusal = await r.Create(other, IntegrationRequestLedgerTests.Movie(99));
        Assert.Equal("quota_exceeded", refusal.Reason); Assert.Equal(429, refusal.HttpStatus);
    }
}

[Collection("Plugin singleton")]
public class IntegrationRequestParentalTests
{
    // 4f round 7 (missing evidence waits): an absent title whose rating isn't verified yet for a parental limit is "unknown"
    // (evidence to prepare), never the same as a verified refusal; a failed lookup is unknown too; an unrated or refused
    // rating is a definite refusal; a verified allowed one is visible.
    [Theory]
    [InlineData("G", true, false)]
    [InlineData("R", false, false)]
    [InlineData("", false, false)]
    [InlineData("fail", false, true)]
    public async Task AnAbsentTitlesUnverifiedRatingIsUnknownNotARefusal(string rating, bool visible, bool unknownAfter)
    {
        using var arr = new FakeArr();
        arr.Add("movies.invalid", "Radarr"); arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = "Kid";
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var jf = new FakeJellyfinView(); var kid = jf.AddUser(false, parental: true); var user = (User)kid.Handle!; user.MaxParentalRatingScore = 10;
        var users = new Mock<IUserManager>(); users.Setup(u => u.GetUserById(kid.UserId)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        localization.Setup(l => l.GetRatingScore("R", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>(); server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(rating == "fail"
            ? IntegrationTransport.Response("{}", 503)
            : IntegrationTransport.Response(JsonSerializer.Serialize(new
            { releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } }, keywords = new { keywords = Array.Empty<object>() }, genres = Array.Empty<object>() }))));
        var parental = new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, arr.Plugin.Core.Logger);
        using var store = arr.Store(); var libraries = new ArrInstanceLibraries(store, new FakeLibraryAccess()) { Parental = parental };
        var aliases = new TitleAliases(store, null); var policy = new RequestPolicy(jf, store, libraries, aliases, parental, arr.Factory, new UnavailableRequestBackend());
        var input = IntegrationRequestLedgerTests.Movie();
        // Cold: not read yet.
        var cold = policy.Evaluate(kid.UserId, input);
        Assert.False(cold.Visible);
        Assert.True(cold.VisibilityUnknown);
        await policy.PrepareVisibilityAsync(kid.UserId, input, default);
        var after = policy.Evaluate(kid.UserId, input);
        Assert.Equal(visible, after.Visible);
        Assert.Equal(unknownAfter, after.VisibilityUnknown);
        Assert.Equal(unknownAfter ? null : visible, parental.AbsentVerdict("movie", 603, kid.UserId.ToString("N")));
        // A person without limits is never "unknown".
        user.MaxParentalRatingScore = null;
        Assert.False(policy.Evaluate(kid.UserId, input).VisibilityUnknown);
    }

    [Theory]
    [InlineData("G", true)]
    [InlineData("R", false)]
    [InlineData("", false)]
    public async Task ProductionPolicyAndRawApiRequireVerifiedRatingForAbsentTitles(string rating, bool allowed)
    {
        using var arr = new FakeArr();
        var movies = arr.Add("movies.invalid", "Radarr"); arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = "Kid";
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var jf = new FakeJellyfinView(); var kid = jf.AddUser(false, parental: true); var user = (User)kid.Handle!; user.MaxParentalRatingScore = 10;
        var users = new Mock<IUserManager>(); users.Setup(u => u.GetUserById(kid.UserId)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        localization.Setup(l => l.GetRatingScore("R", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>(); server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
        { releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } }, keywords = new { keywords = Array.Empty<object>() }, genres = Array.Empty<object>() }))));
        var parental = new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, arr.Plugin.Core.Logger);
        using var store = arr.Store(); var libraries = new ArrInstanceLibraries(store, new FakeLibraryAccess()) { Parental = parental };
        var aliases = new TitleAliases(store, null); var policy = new RequestPolicy(jf, store, libraries, aliases, parental, arr.Factory, new UnavailableRequestBackend());
        var root = Path.Combine(arr.Plugin.Core.Root, "requests.db"); using var db = new AcquireDatabase(root); var ledger = new RequestLedger(db);
        var service = new RequestService(ledger, policy, jf, new ArrChangeFeed(), aliases);
        var controller = new Jellyfin.Plugin.JellyfinEnhanced.Controllers.AcquireRequestsController(service) { ControllerContext = new() { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(kid.UserId, false);
        var result = Assert.IsType<ObjectResult>(await controller.Create(new("rating", IntegrationRequestLedgerTests.Movie()), default));
        Assert.Equal(allowed ? 201 : 403, result.StatusCode);
        Assert.Equal(allowed, ledger.List(kid.UserId, false).Count == 1);
        if (allowed)
        {
            Assert.Contains("Score", ledger.List(kid.UserId, false).Single().ParentalSignature);
            user.MaxParentalRatingScore = 0;
            Assert.False(policy.Evaluate(kid.UserId, IntegrationRequestLedgerTests.Movie()).Visible);
            Assert.Empty(JsonDocument.Parse(service.List(kid.UserId, false).Json).RootElement.GetProperty("items").EnumerateArray());
            user.MaxParentalRatingScore = 10;
            Assert.Single(JsonDocument.Parse(service.List(kid.UserId, false).Json).RootElement.GetProperty("items").EnumerateArray());
        }
        using var seerrFacts = new SeerrRequestReadModel(transport, new ArrChangeFeed(), null, () => config, () => arr.Now);
        var authority = new LedgerRequestFacts(ledger, seerrFacts, aliases);
        Assert.Equal(allowed, authority.Requested(TitleKey.Parse("movie:tmdb:603")!));
        Assert.Equal(allowed, authority.AskedBy(TitleKey.Parse("movie:tmdb:603")!, kid.UserId));
        Assert.Equal(allowed, authority.For(TitleKey.Parse("movie:tmdb:603")!, kid)?.Pending == true);
        config.ArrRequestRoles = "{\"Kid\":{\"QuotaLimit\":2}}";
        Assert.Equal(2, policy.Evaluate(kid.UserId, IntegrationRequestLedgerTests.Movie()).Limit);
        config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [kid.UserId.ToString("N")] = new { QuotaLimit = 3 } });
        Assert.Equal(3, policy.Evaluate(kid.UserId, IntegrationRequestLedgerTests.Movie()).Limit);
        if (allowed)
        {
            var series = Guid.NewGuid(); var tvKey = TitleKey.Parse("tv:tvdb:42")!;
            jf.AddCopy(tvKey, new JfCopy { ItemId = series, Visible = true });
            jf.AddEpisode(series, new JfEpisode { Season = 1, Episode = 2, EpisodeEnd = 8, Hidden = true });
            var episode = new MutationInput { Key = tvKey.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 7) } };
            Assert.Equal(403, (await service.CreateAsync(kid.UserId, new("hidden-episode", episode), default)).HttpStatus);
            Assert.Equal(403, (await service.CreateAsync(kid.UserId, new("hidden-season", episode with { Scope = "seasons", Episodes = Array.Empty<RequestEpisode>(), Seasons = new[] { 1 } }), default)).HttpStatus);

            // Production policy sees a role change while the native copy prerequisite is blocked.
            config.ArrRequestDefaultRole = "Member"; config.ArrRequestUsers = "{}";
            var race = await service.CreateAsync(kid.UserId, new("native-race", IntegrationRequestLedgerTests.Movie(604)), default);
            Assert.Equal(201, race.HttpStatus);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var release = new ManualResetEventSlim(); var blocked = 0;
            jf.OnCopies = () => { if (Interlocked.Exchange(ref blocked, 1) == 0) { entered.SetResult(); release.Wait(TimeSpan.FromSeconds(10)); } };
            var backend = new IntegrationRequestLedgerTests.Backend();
            var runner = new RequestOutbox(ledger, policy, backend, new RequestTitleLocks(), new ArrChangeFeed(), new ArrAuditLog(Path.Combine(arr.Plugin.Core.Root, "race-audit.jsonl"), 100000, 1));
            var send = Task.Run(() => runner.TickAsync(default));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            config.ArrRequestDefaultRole = "Watcher"; release.Set(); await send;
            Assert.Equal(0, backend.Sends); Assert.Equal("authorization_changed", ledger.ForWant(race.RequestId!).Single().Reason);
            jf.OnCopies = null; config.ArrRequestDefaultRole = "Kid";

            // A change within a synchronous policy read also discards the stale answer.
            config.ArrRequestDefaultRole = "Member";
            jf.OnCopies = () => config.ArrRequestDefaultRole = "Watcher";
            Assert.False(policy.Evaluate(kid.UserId, IntegrationRequestLedgerTests.Movie()).CanCreate);
            jf.OnCopies = null; config.ArrRequestDefaultRole = "Kid";
        }
        // The same verified signature covers the calendar, even when its optional library filter is off.
        config.CalendarPageEnabled = true; config.CalendarFilterByLibraryAccess = false;
        movies.Calendar.Add(FakeArr.Movie(1, 603, "Rated title", hasFile: false, digital: "2026-10-20"));
        var calendarDatabase = new IntegrationCalendarTests.CalendarDatabase();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<MediaBrowser.Controller.Entities.InternalItemsQuery>())).Returns(new List<MediaBrowser.Controller.Entities.BaseItem>());
        var calendar = ApiAssetTests.Controller(arr.Plugin.Core, arr.Transport, store, arr.Factory, parental, users.Object, library.Object,
            new Mock<IUserDataManager>().Object, libraries, aliases, calendarDatabase);
        calendar.HttpContext.User = TestCallers.Principal(kid.UserId, false);
        calendar.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?start=2026-10-12&end=2026-10-31");
        async Task<int> CalendarCount()
        {
            var body = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await calendar.GetCalendarEvents()).Value);
            return body.GetProperty("events").GetArrayLength();
        }
        Assert.Equal(allowed ? 1 : 0, await CalendarCount());
        if (allowed)
        {
            user.MaxParentalRatingScore = 0; Assert.Equal(0, await CalendarCount());
            user.MaxParentalRatingScore = 10; Assert.Equal(1, await CalendarCount());
        }
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "violence" });
        config.JellyseerrEnabled = false;
        Assert.False(await parental.MaySeeAbsentAsync("movie", 603, kid.UserId.ToString("N"), default));
    }
}

/// <summary>
/// Phase 3 combine: the ledger tells the status composer when each part of a title went out (JE mode), so the
/// "still looking" clock of a freshly asked-for episode starts then, not when the arr first listed the series.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationLedgerSentFactsTests
{
    [Fact]
    public async Task TheLedgerSaysWhenEachPartOfATitleWentOut()
    {
        using var arr = new FakeArr();
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je";
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var episode = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } };
        Assert.Equal(201, (await rig.Create(rig.Member, episode)).HttpStatus);
        Assert.Equal(201, (await rig.Create(rig.Kid, IntegrationRequestLedgerTests.Seasons(2))).HttpStatus); // waits for an OK: not out
        rig.Now = rig.Now.AddMinutes(3);
        await rig.Runner().TickAsync(CancellationToken.None);
        using var store = arr.Store();
        using var seerr = new SeerrRequestReadModel(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))), new ArrChangeFeed(), null, () => config, () => arr.Now);
        var facts = new LedgerRequestFacts(rig.Ledger, seerr, new TitleAliases(store, null)).For(TitleKey.Parse("tv:tvdb:78874")!, rig.View.Users[rig.Member])!;
        var sentAt = rig.Ledger.ForTitle("tv:tvdb:78874").Single(w => w.UserId == rig.Member).UpdatedAt.UtcDateTime;
        Assert.Equal(new[] { new RequestSentPart(false, 1, 4, sentAt) }, facts.Sent.ToArray());
        Assert.Equal(sentAt, facts.SentFor(false, 1, 4));
        Assert.Null(facts.SentFor(false, 2, 1));
        // Seerr mode: the Seerr read model answers instead (the ledger's parts aren't Seerr's).
        config.ArrRequestBackend = "seerr";
        Assert.Null(new LedgerRequestFacts(rig.Ledger, seerr, new TitleAliases(store, null)).For(TitleKey.Parse("tv:tvdb:78874")!, rig.View.Users[rig.Member]));
    }

    [Fact]
    public async Task AnEpisodeGetsOnlyTheAsksThatCoverIt()
    {
        using var arr = new FakeArr();
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je";
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var episode = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } };
        Assert.Equal(201, (await rig.Create(rig.Member, episode)).HttpStatus);
        Assert.Equal(201, (await rig.Create(rig.Kid, IntegrationRequestLedgerTests.Seasons(2))).HttpStatus); // waits for an OK
        rig.Now = rig.Now.AddMinutes(3);
        await rig.Runner().TickAsync(CancellationToken.None);
        using var store = arr.Store();
        using var seerr = new SeerrRequestReadModel(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))), new ArrChangeFeed(), null, () => config, () => arr.Now);
        var series = TitleKey.Parse("tv:tvdb:78874")!;
        var member = rig.View.Users[rig.Member];
        var facts = new LedgerRequestFacts(rig.Ledger, seerr, new TitleAliases(store, null));
        // The member's own episode went out: approved, not waiting; the kid's season 2 ask doesn't touch it.
        var e4 = facts.ForEpisode(series, 1, 4, member)!;
        Assert.False(e4.Pending);
        Assert.True(e4.AskedByViewer);
        Assert.NotNull(e4.ApprovedAt);
        // An episode of season 2 waits with the kid's ask (someone else's).
        var s2 = facts.ForEpisode(series, 2, 3, member)!;
        Assert.True(s2.Pending);
        Assert.False(s2.AskedByViewer);
        // Nothing asks for the next episode.
        Assert.Null(facts.ForEpisode(series, 1, 5, member));
        // A season page follows only asks for that whole season: the kid's season 2, never the single
        // episode of season 1 or another season's ask.
        Assert.True(facts.ForSeason(series, 2, member)!.Pending);
        Assert.Null(facts.ForSeason(series, 1, member));
        Assert.Null(facts.ForSeason(series, 3, member));
        // Seerr mode: Seerr's requests answer instead (it has none here), as for the whole title.
        config.ArrRequestBackend = "seerr";
        Assert.Null(facts.ForEpisode(series, 2, 3, member));
        Assert.Null(facts.ForSeason(series, 2, member));
    }

    [Fact]
    public async Task TheClockCountsFromWhatWentOutNotFromJoinsOrFromWhenAMovedRequestWasAskedForInSeerr()
    {
        using var arr = new FakeArr();
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true; config.ArrRequestBackend = "je";
        using var rig = new IntegrationRequestLedgerTests.Rig();
        using var store = arr.Store();
        using var seerr = new SeerrRequestReadModel(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))), new ArrChangeFeed(), null, () => config, () => arr.Now);
        RequestFacts Facts() => new LedgerRequestFacts(rig.Ledger, seerr, new TitleAliases(store, null)).For(TitleKey.Parse("tv:tvdb:78874")!, rig.View.Users[rig.Member])!;
        var sentAt = rig.Now;

        // Monday: the member's season 1 goes out.
        Assert.Equal(201, (await rig.Create(rig.Member, IntegrationRequestLedgerTests.Seasons(1))).HttpStatus);
        await rig.Runner().TickAsync(CancellationToken.None);
        Assert.Equal(sentAt.UtcDateTime, Facts().SentFor(false, 1, 4));

        // Wednesday: someone else asks for the same season. Nothing is sent (they follow), so the clock stays.
        rig.Now = sentAt.AddHours(30);
        var other = rig.Add("Member");
        var joined = await rig.Create(other, IntegrationRequestLedgerTests.Seasons(1));
        Assert.Equal(("merged", "sent"), (joined.Outcome, rig.Ledger.Find(joined.RequestId!)!.Status));
        Assert.Empty(rig.Ledger.Due(rig.Now));
        Assert.Equal(sentAt.UtcDateTime, Facts().SentFor(false, 1, 4));

        // A request moved from Seerr while still waiting there (asked 20 days ago), approved in JE now: it counts from
        // the send JE makes, not from the Seerr ask. One already processing in Seerr counts from when it was asked there.
        var target = RequestLedger.TargetKey(new RequestAuthorization(rig.Admin, null, "request", "seasons", "standard", "je", "r1", "g1", string.Empty));
        var asked = sentAt.AddDays(-20);
        var moved = rig.Ledger.ImportSeerr("src", "digest", new[]
        {
            new ImportCandidate(rig.Member, 41, IntegrationRequestLedgerTests.Seasons(2), true, asked),
            new ImportCandidate(rig.Member, 42, IntegrationRequestLedgerTests.Seasons(3), false, asked),
        }, new Dictionary<string, int>(), rig.Admin, "seerr", _ => target, rig.Now, TimeSpan.FromDays(14));
        Assert.Equal(2, moved.Imported);
        Assert.Null(Facts().SentFor(false, 2, 1));                    // still waiting for an OK: nothing went out
        Assert.Equal(asked.UtcDateTime, Facts().SentFor(false, 3, 1));
        var pending = rig.Ledger.ForTitle("tv:tvdb:78874").Single(w => w.Status == "pending");
        rig.Now = sentAt.AddHours(31);
        Assert.Equal(200, (await rig.Service.ApproveAsync(pending.Id, rig.Admin, null, CancellationToken.None)).HttpStatus);
        await rig.Runner().TickAsync(CancellationToken.None);
        Assert.Equal("sent", rig.Ledger.Find(pending.Id)!.Status);
        Assert.Equal(rig.Now.UtcDateTime, Facts().SentFor(false, 2, 1));
        Assert.Equal(sentAt.UtcDateTime, Facts().SentFor(false, 1, 4));
    }
}
