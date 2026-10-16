using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// Phase 3 combined review: the request tracks joined end to end with the production pieces (request policy,
/// backend router, the Seerr and Sonarr executors, the outbox, the move from Seerr, the ledger's request facts,
/// the status service and the season rows) against a synthetic Seerr and Sonarr. An ask goes to Seerr, moves to
/// Jellyfin Enhanced while Seerr still waits for an OK, is approved here and sent to Sonarr: the season rows and
/// the serialized status say what really happened at each step.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestJoinedTests
{
    [Fact]
    public async Task AnAskSentToSeerrThenMovedApprovedAndSentHereReadsAsItReallyIs()
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var config = lab.Config;
        var now = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        var asked = now.AddDays(-20);
        var clock = asked;
        void At(DateTimeOffset at)
        {
            clock = at;
            lab.Now = at;
            lab.Arr.Arr.Now = at;
        }
        At(asked);

        // Jellyfin: Firefly's season 1, with E1 here and E4 missing.
        var view = new FakeJellyfinView();
        var emma = view.AddUser(false);
        var admin = view.AddUser(true);
        var seriesId = Guid.NewGuid();
        var seasonId = Guid.NewGuid();
        var firefly = TitleKey.Parse("tv:tvdb:78874")!;
        view.AddItem(new JfItemRef { ItemId = seriesId, Kind = "series", Key = firefly, TmdbId = 1437 });
        view.AddItem(new JfItemRef { ItemId = seasonId, Kind = "season", Key = firefly.WithSeason(1), SeriesId = seriesId, Season = 1, TmdbId = 1437 });
        view.AddCopy(firefly, new JfCopy { ItemId = seriesId, Visible = true, Path = "/media/tv/Firefly", LibraryName = "Shows" });
        view.AddSeason(seriesId, new JfSeason { ItemId = seasonId, Season = 1 });
        view.AddEpisode(seriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1 });
        view.AddEpisode(seriesId, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 4, Virtual = true });
        config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [emma.UserId.ToString("N")] = new { Role = "Member" } });

        // Sonarr has had Firefly for a year with season 1 unmonitored; Seerr links Emma's account and holds asks for an OK.
        var sonarr = lab.Arr.Sonarr;
        sonarr.Series.Add(new JsonObject
        {
            ["id"] = 31, ["tvdbId"] = 78874, ["tmdbId"] = 1437, ["title"] = "Firefly", ["titleSlug"] = "firefly", ["monitored"] = true, ["monitorNewItems"] = "none",
            ["qualityProfileId"] = 4, ["path"] = "/data/tv/Firefly", ["added"] = now.AddDays(-400).ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = false }),
        });
        for (var e = 1; e <= 4; e++)
            sonarr.Episodes.Add(new JsonObject { ["id"] = 3100 + e, ["seriesId"] = 31, ["seasonNumber"] = 1, ["episodeNumber"] = e, ["airDateUtc"] = $"2002-10-0{e}T01:00:00Z", ["hasFile"] = e == 1, ["monitored"] = false });
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 10, ["jellyfinUserId"] = emma.UserId.ToString("N"), ["permissions"] = 32, ["displayName"] = "Emma" });
        lab.Seerr.Shows[1437] = new JsonObject
        {
            ["id"] = 1437,
            ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 0 }, new JsonObject { ["seasonNumber"] = 1 }),
            ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["seasons"] = new JsonArray(), ["requests"] = new JsonArray() },
        };

        var store = lab.Arr.Store;
        Assert.True((await store.RefreshLibraryNowAsync(lab.Arr.Instance("Sonarr"), default)).Ok);
        var aliases = new TitleAliases(store, null);
        using var db = new AcquireDatabase(Path.Combine(lab.Arr.Arr.Plugin.Core.Root, "joined.db"));
        var ledger = new RequestLedger(db);
        var router = new RequestBackendRouter(lab.Arr.Direct, new SeerrBackend(lab.Seerr.Transport, lab.Model, aliases, () => config, () => clock, ledger.BindSeerrSend), () => config);
        var policy = new RequestPolicy(view, store, new ArrInstanceLibraries(store, new FakeLibraryAccess()), aliases, null!, lab.Arr.Arr.Factory, router);
        var feed = new ArrChangeFeed();
        var audit = new ArrAuditLog(Path.Combine(lab.Arr.Arr.Plugin.Core.Root, "joined-audit.jsonl"), 100000, 1);
        var requests = new RequestService(ledger, policy, view, feed, () => clock, aliases);
        var outbox = new RequestOutbox(ledger, policy, router, new RequestTitleLocks(), feed, audit, () => clock);
        var rows = new SeasonRowsService(view, ledger, policy, aliases, (_, _, _, _) => Task.FromResult<string?>(null), () => clock);
        var status = new ArrStatusService(store, view, new LedgerRequestFacts(ledger, lab.Model, aliases), () => config, () => clock, feed);
        var key = aliases.Canonical(firefly).ToString();
        async Task<string?> Row() => (await rows.ForSeasonAsync(emma, seasonId, null, default))!.SeasonRequest;
        async Task<string> Episode4()
        {
            var body = await status.ForScopeKeyAsync(emma, TitleKey.Parse(key + ":s1:e4")!, default);
            using var doc = JsonDocument.Parse(body.Json);
            return doc.RootElement.GetProperty("items")[0].GetProperty("reason").GetProperty("code").GetString()!;
        }

        // Seerr mode, 20 days ago: Emma asks for season 1. It goes to Seerr as her account and waits for an OK there.
        var ask = await requests.CreateAsync(emma.UserId, new("emma-s1", new MutationInput { Key = key, Scope = "seasons", Seasons = new[] { 1 } }), default);
        Assert.Equal(201, ask.HttpStatus);
        await outbox.TickAsync(default);
        Assert.Equal(("sent", "awaiting_approval"), (ledger.Find(ask.RequestId!)!.Status, ledger.Find(ask.RequestId!)!.Reason));
        var created = lab.Seerr.Shows[1437]["mediaInfo"]!["requests"]!.AsArray().Single()!;
        Assert.Equal(10, (int)created["requestedBy"]!["id"]!);
        Assert.Equal("waiting", await Row());

        // Two hours ago: requesting is turned off in Seerr and the requests move to Jellyfin Enhanced. Seerr still holds
        // Emma's for an OK, so it waits in Approvals here.
        lab.Seerr.Requests.Add(FakeSeerr.Request((int)created["id"]!, "tv", 1437, 1, emma.UserId, asked.UtcDateTime, tvdb: 78874, seasons: new[] { 1 }, mediaStatus: 2));
        foreach (var user in lab.Seerr.Users) user["permissions"] = 0;
        lab.Seerr.MainSettings = new JsonObject { ["defaultPermissions"] = 0 };
        At(now.AddHours(-2));
        var move = new SeerrMigration(new SeerrMigrationReader(lab.Seerr.Transport), ledger, policy, view, aliases, feed, () => config, () => { }, () => clock);
        var commit = await move.CommitAsync(admin.UserId, (await move.PreviewAsync(default)).Digest, false, default);
        Assert.True(commit.HttpStatus == 200, commit.Reason + ": " + commit.Message);
        Assert.Equal("je", config.ArrRequestBackend);
        var moved = Assert.Single(ledger.ForTitle(key), w => w.OriginKind == RequestOrigin.SeerrImportKind);
        Assert.Equal("pending", moved.Status);
        // Nothing goes out until someone OKs it here, and Emma's row says so (not "Asked!" from the ask left on Seerr).
        Assert.Equal("waiting", await Row());
        Assert.DoesNotContain(sonarr.Writes, w => w.Path == "/api/v3/command");

        // Now: the admin OKs it in Jellyfin Enhanced and it goes to Sonarr (season 1 monitored and searched).
        At(now);
        Assert.Equal(200, (await requests.ApproveAsync(moved.Id, admin.UserId, null, default)).HttpStatus);
        await outbox.TickAsync(default);
        Assert.Equal("sent", ledger.Find(moved.Id)!.Status);
        Assert.Contains(sonarr.Writes, w => w.Path == "/api/v3/command");
        Assert.Equal("asked", await Row());
        // Sent a moment ago: E4 is being looked for (no Search), whatever the Seerr ask 20 days ago says.
        Assert.Equal(StatusReasonCode.Looking, await Episode4());

        // A day and an hour later with nothing grabbed: missing for a long while (Search).
        At(now.AddHours(25));
        Assert.Equal(StatusReasonCode.NoReleaseYet, await Episode4());
    }

    [Fact]
    public async Task InSeerrModeAnAskSeerrDoesNotShowYetReadsAsAskedForTheTitleSeasonAndEpisodeAtOnce()
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var config = lab.Config;
        var clock = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        void At(DateTimeOffset at)
        {
            clock = at;
            lab.Now = at;
        }
        At(clock);
        var view = new FakeJellyfinView();
        var emma = view.AddUser(false);
        var kid = view.AddUser(false);
        var firefly = TitleKey.Parse("tv:tmdb:1437")!;
        config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            [emma.UserId.ToString("N")] = new { Role = "Member" },
            [kid.UserId.ToString("N")] = new { Role = "Kid" },
        });
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 10, ["jellyfinUserId"] = emma.UserId.ToString("N"), ["permissions"] = 32, ["displayName"] = "Emma" });
        lab.Seerr.Users.Add(new JsonObject { ["id"] = 11, ["jellyfinUserId"] = kid.UserId.ToString("N"), ["permissions"] = 32, ["displayName"] = "Kid" });
        lab.Seerr.Shows[1437] = new JsonObject
        {
            ["id"] = 1437,
            ["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1 }, new JsonObject { ["seasonNumber"] = 2 }),
            ["mediaInfo"] = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["seasons"] = new JsonArray(), ["requests"] = new JsonArray() },
        };
        var aliases = new TitleAliases(lab.Arr.Store, null);
        using var db = new AcquireDatabase(Path.Combine(lab.Arr.Arr.Plugin.Core.Root, "held.db"));
        var ledger = new RequestLedger(db);
        var events = new RequestOutboxEvents();
        using var model = new SeerrRequestReadModel(lab.Seerr.Transport, null, null, () => config, () => clock, events);
        var router = new RequestBackendRouter(lab.Arr.Direct, new SeerrBackend(lab.Seerr.Transport, model, aliases, () => config, () => clock, ledger.BindSeerrSend), () => config);
        var policy = new RequestPolicy(view, lab.Arr.Store, new ArrInstanceLibraries(lab.Arr.Store, new FakeLibraryAccess()), aliases, null!, lab.Arr.Arr.Factory, router);
        var audit = new ArrAuditLog(Path.Combine(lab.Arr.Arr.Plugin.Core.Root, "held-audit.jsonl"), 100000, 1);
        var requests = new RequestService(ledger, policy, view, new ArrChangeFeed(), () => clock, aliases);
        var outbox = new RequestOutbox(ledger, policy, router, new RequestTitleLocks(), new ArrChangeFeed(), audit, () => clock, events);
        var facts = new LedgerRequestFacts(ledger, model, aliases, () => clock);
        Assert.True(await model.RefreshAsync(default));
        var revision = facts.Revision;

        // A Kid asks for season 2: it waits for an OK in Jellyfin Enhanced, and Seerr knows nothing of it yet.
        var kidAsk = await requests.CreateAsync(kid.UserId, new("kid-s2", new MutationInput { Key = "tv:tmdb:1437", Scope = "seasons", Seasons = new[] { 2 } }), default);
        Assert.Equal("awaiting_approval", kidAsk.Reason);
        Assert.NotEqual(revision, facts.Revision);
        Assert.True(facts.ForSeason(firefly, 2, kid)!.Pending);
        Assert.True(facts.ForEpisode(firefly, 2, 3, kid)!.AskedByViewer);
        Assert.True(facts.For(firefly, kid)!.Pending, "the series headline says it at the same time as the rows");
        Assert.Null(facts.ForSeason(firefly, 1, kid));
        Assert.True(facts.Requested(firefly));
        Assert.True(facts.AskedBy(firefly, kid.UserId));

        // Emma asks for season 1: OK'd here at once, then sent to Seerr. Until Seerr's list shows it, it is held here.
        var ask = await requests.CreateAsync(emma.UserId, new("emma-s1", new MutationInput { Key = "tv:tmdb:1437", Scope = "seasons", Seasons = new[] { 1 } }), default);
        Assert.Equal(201, ask.HttpStatus);
        Assert.NotNull(facts.ForSeason(firefly, 1, emma)!.ApprovedAt);
        Assert.False(model.Due());
        await outbox.TickAsync(default);
        Assert.Equal("sent", ledger.Find(ask.RequestId!)!.Status);
        Assert.True(facts.ForSeason(firefly, 1, emma)!.AskedByViewer, "sent, and Seerr's list doesn't show it yet");
        // The confirmed send asks Seerr's list to be read again about a second later.
        At(clock.AddSeconds(1));
        Assert.True(model.Due());

        // Seerr's list shows Emma's request: Seerr's own facts speak for it (no second copy of the ask).
        var created = lab.Seerr.Shows[1437]["mediaInfo"]!["requests"]!.AsArray().Single()!;
        lab.Seerr.Requests.Add(FakeSeerr.Request((int)created["id"]!, "tv", 1437, 1, emma.UserId, clock.UtcDateTime, seasons: new[] { 1 }, mediaStatus: 2));
        Assert.True(await model.RefreshAsync(default));
        Assert.DoesNotContain(facts.Held(firefly), w => w.Id == ask.RequestId);
        Assert.Contains(facts.Held(firefly), w => w.Id == kidAsk.RequestId);
        Assert.True(facts.ForSeason(firefly, 1, emma)!.Pending, "waiting for an OK in Seerr, as Seerr says");

        // Seerr drops the request: held here only for a while after the send, then Seerr's list is what's true.
        lab.Seerr.Requests.Clear();
        Assert.True(await model.RefreshAsync(default));
        Assert.NotNull(facts.ForSeason(firefly, 1, emma));
        At(clock + LedgerRequestFacts.SentUnseenFor);
        Assert.Null(facts.ForSeason(firefly, 1, emma));

        // Another Seerr: nothing held here belongs to it.
        config.JellyseerrUrls = "http://seerr-two.lan:5055";
        Assert.Empty(facts.Held(firefly));
        Assert.Null(facts.ForSeason(firefly, 2, kid));
    }

    [Fact]
    public void AHeldAskIsSeerrsOnlyForTheSamePersonAndEditionAndMergesHonestly()
    {
        var emma = Guid.NewGuid();
        var at = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        var target = RequestLedger.SeerrTargetKey("seerr-a");
        RequestWant Want(string status, string variant = "standard", params int[] seasons)
            => new("w", "a", emma, "c", "f", new MutationInput { Key = "tv:tmdb:1437", Scope = "seasons", Seasons = seasons, Variant = variant }, status, "r", 1, "{}", at, at, TargetKey: target);
        SeerrRequestRecord Record(bool is4k, int status, params int[] seasons)
            => new() { Id = 1, TmdbId = 1437, RequestedBy = emma, Is4k = is4k, Status = status, Seasons = seasons, CreatedAt = at.UtcDateTime };
        var sent = Want("sent", "4k", 1, 2);
        // The standard request (or a 4K one for fewer seasons, or someone else's) isn't the 4K ask's.
        Assert.True(LedgerRequestFacts.Unseen(sent, target, new[] { Record(false, 1, 1, 2), Record(true, 1, 1) }, at));
        Assert.False(LedgerRequestFacts.Unseen(sent, target, new[] { Record(true, 1, 1, 2, 3) }, at));
        Assert.False(LedgerRequestFacts.Unseen(sent, target, new[] { Record(true, 1) }, at), "a request for the whole series covers it");
        Assert.True(LedgerRequestFacts.Unseen(sent, target, new[] { new SeerrRequestRecord { TmdbId = 1437, RequestedBy = Guid.NewGuid(), Is4k = true, Status = 1, Seasons = new[] { 1, 2 } } }, at));
        // An old declined request isn't the new ask's; one declined since the ask is.
        var old = new SeerrRequestRecord { TmdbId = 1437, RequestedBy = emma, Is4k = true, Status = SeerrRequestStatus.Declined, Seasons = new[] { 1, 2 }, CreatedAt = at.UtcDateTime.AddDays(-30), UpdatedAt = at.UtcDateTime.AddDays(-29) };
        Assert.True(LedgerRequestFacts.Unseen(sent, target, new[] { old }, at));
        Assert.False(LedgerRequestFacts.Unseen(sent, target, new[] { new SeerrRequestRecord { TmdbId = 1437, RequestedBy = emma, Is4k = true, Status = SeerrRequestStatus.Declined, Seasons = new[] { 1, 2 }, CreatedAt = at.UtcDateTime, UpdatedAt = at.UtcDateTime.AddMinutes(5) } }, at));
        // Waiting here, or for another target, or settled: never Seerr's to show, or not held.
        Assert.True(LedgerRequestFacts.Unseen(Want("pending", "standard", 1), target, new[] { Record(false, 1, 1) }, at));
        Assert.False(LedgerRequestFacts.Unseen(Want("pending", "standard", 1), RequestLedger.SeerrTargetKey("seerr-b"), Array.Empty<SeerrRequestRecord>(), at));
        Assert.All(new[] { "declined", "cancelled", "fulfilled", "stale" }, status => Assert.False(LedgerRequestFacts.Unseen(Want(status, "standard", 1), target, Array.Empty<SeerrRequestRecord>(), at)));
        Assert.False(LedgerRequestFacts.Unseen(sent, target, Array.Empty<SeerrRequestRecord>(), at + LedgerRequestFacts.SentUnseenFor));

        // Merging: a new ask after Seerr's requests were all declined isn't declined, nor dated by them.
        var declined = new RequestFacts { AskedAt = at.UtcDateTime.AddDays(-30), Declined = true, StandardDone = true };
        var held = new RequestFacts { AskedAt = at.UtcDateTime, Pending = true, AskedByViewer = true };
        var merged = LedgerRequestFacts.Merge(declined, held)!;
        Assert.Equal((false, true, at.UtcDateTime, true), (merged.Declined, merged.Pending, merged.AskedAt, merged.StandardDone));
        // Otherwise asked when the first was, OK'd when the first was, sent parts of both.
        var seerr = new RequestFacts { AskedAt = at.UtcDateTime.AddDays(-2), ApprovedAt = at.UtcDateTime.AddDays(-1), ApprovedStandardAt = at.UtcDateTime.AddDays(-1), Sent = new[] { new RequestSentPart(false, 1, null, at.UtcDateTime.AddDays(-1)) } };
        var queued = new RequestFacts { AskedAt = at.UtcDateTime, ApprovedAt = at.UtcDateTime, Approved4kAt = at.UtcDateTime, Sent = new[] { new RequestSentPart(true, 2, null, at.UtcDateTime) } };
        var both = LedgerRequestFacts.Merge(seerr, queued)!;
        Assert.Equal((at.UtcDateTime.AddDays(-2), at.UtcDateTime.AddDays(-1), (DateTime?)at.UtcDateTime, false), (both.AskedAt, both.ApprovedAt, both.Approved4kAt, both.Pending));
        Assert.Equal(2, both.Sent.Count);
        Assert.Same(seerr, LedgerRequestFacts.Merge(seerr, null));
        Assert.Same(queued, LedgerRequestFacts.Merge(null, queued));
    }

    [Fact]
    public void TheSeerrReadModelFollowsConfirmedSeerrSendsOnlyAndLetsGoWhenDisposed()
    {
        using var seerr = new FakeSeerr();
        var config = new PluginConfiguration { JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key };
        var now = new DateTimeOffset(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        var events = new RequestOutboxEvents();
        var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => now, events);
        var field = typeof(RequestOutboxEvents).GetField(nameof(RequestOutboxEvents.Confirmed), System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        Assert.NotNull(field.GetValue(events));
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var direct = lab.Job(IntegrationRequestLedgerTests.Movie(), "Radarr");
        var toSeerr = lab.Job(IntegrationRequestLedgerTests.Movie(), "Radarr", backend: "seerr");
        events.RaiseConfirmed(direct);
        Assert.Null(model.RequestedAt);
        events.RaiseConfirmed(toSeerr);
        Assert.Equal(now, model.RequestedAt);
        model.Dispose();
        Assert.Null(field.GetValue(events));
    }
}
