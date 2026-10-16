using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// Phase 3f, Jellyfin Enhanced mode: the request ledger's requests follow where exactly the part asked for really is
/// (the Requests page, the household list, approval cards), arrivals mark them fulfilled (never stale), the
/// requester hears of an OK, a no (with the reason) and the arrival once each, across a restart, and the copy says
/// the right numbers. Against fakes of Sonarr/Radarr, Jellyfin, ntfy and SMTP.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationRequestArrivalsTests
{
    private const string Matrix = "movie:tmdb:603";
    private const string Firefly = "tv:tvdb:78874";

    /// <summary>Radarr with The Matrix downloading, Sonarr with Firefly (S1 monitored, E1 here; S2 unmonitored), Jellyfin with Firefly.</summary>
    internal sealed class Lab : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public FakeSeerr Seerr { get; } = new();
        public ArrStateStore Store { get; }
        public FakeJellyfinView View { get; } = new() { ResolveAnyItem = true };
        public ArrChangeFeed Feed { get; } = new();
        public SeerrRequestReadModel Model { get; }
        public TitleAliases Aliases { get; }
        public AcquireDatabase Db { get; }
        public RequestLedger Ledger { get; }
        public IntegrationRequestLedgerTests.Policy Policy { get; } = new();
        public IntegrationRequestLedgerTests.Backend Backend { get; } = new();
        public RequestService Requests { get; }
        public RequestOutbox Outbox { get; }
        public ArrStatusService Status { get; }
        public RequestsHubService Hub { get; }
        public RequestHubProjection Projection { get; }
        public IntegrationRequestHouseholdTests.FakeDirectory Directory { get; } = new();
        public RequestFulfilment Fulfilment { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Emma { get; }
        public StatusViewer Kid { get; }
        public Guid SeriesItem { get; } = Guid.NewGuid();
        public PluginConfiguration Config => Arr.Plugin.Plugin.Configuration;

        /// <param name="fourK">Also a 4K Radarr (role 4k) holding The Matrix in its own folder, no file yet.</param>
        public Lab(bool fourK = false)
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            if (fourK)
            {
                var uhd = Arr.Add("radarr4k.lan", "Radarr");
                Arr.Configure(("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"),
                    ("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"));
                var rows = JsonNode.Parse(Config.RadarrInstances)!.AsArray();
                foreach (var row in rows)
                {
                    if ((string?)row!["Name"] == "Radarr4kZ") row["Role"] = "4k";
                }
                Config.RadarrInstances = rows.ToJsonString();
                uhd.Movies.Add(FakeArr.Movie(8, 603, "The Matrix", hasFile: false, path: "/data/movies4k/The Matrix (1999)"));
            }
            else
            {
                Arr.Configure(("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            }
            var c = Config;
            c.ArrIntegrationEnabled = true;
            c.ArrPhase1Enabled = true;
            c.ArrPhase3Enabled = true;
            c.ArrRequestBackend = "je";
            c.ArrRequestsHubEnabled = true;
            c.ArrHouseholdContactName = "Dad";
            Radarr.Movies.Add(FakeArr.Movie(7, 603, "The Matrix", hasFile: false));
            Radarr.Queue.Add(FakeArr.RadarrQueueRow(7, 603, "The Matrix"));
            var series = FakeArr.SeriesRow(31, 78874, "Firefly", tmdb: 1437);
            series["seasons"] = new JsonArray(new JsonObject { ["seasonNumber"] = 1, ["monitored"] = true }, new JsonObject { ["seasonNumber"] = 2, ["monitored"] = false });
            Sonarr.Series.Add(series);
            for (var e = 1; e <= 4; e++) Sonarr.Episodes.Add(Episode(3100 + e, 1, e, hasFile: e == 1, monitored: true));
            for (var e = 1; e <= 2; e++) Sonarr.Episodes.Add(Episode(3200 + e, 2, e, hasFile: false, monitored: false));
            Store = Arr.Store();
            Model = new SeerrRequestReadModel(Seerr.Transport, Feed, null, () => Config, () => Arr.Now);
            Aliases = new TitleAliases(Store, null);
            Db = new AcquireDatabase(Path.Combine(Arr.Plugin.Core.Root, "arrivals-" + Guid.NewGuid().ToString("N") + ".db"));
            Ledger = new RequestLedger(Db);
            Admin = View.AddUser(true);
            Emma = View.AddUser(false);
            Kid = View.AddUser(false);
            Person(Admin, "Admin");
            Person(Emma, "Member");
            Person(Kid, "Kid");
            Requests = new RequestService(Ledger, Policy, View, Feed, () => Arr.Now);
            Outbox = new RequestOutbox(Ledger, Policy, Backend, new RequestTitleLocks(), Feed, new ArrAuditLog(Path.Combine(Arr.Plugin.Core.Root, "arrivals-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => Arr.Now);
            Status = new ArrStatusService(Store, View, new LedgerRequestFacts(Ledger, Model, Aliases), () => Config, () => Arr.Now, Feed, new ArrInstanceLibraries(Store, new FakeLibraryAccess(), () => Arr.Now));
            Hub = new RequestsHubService(Status, Model, () => Config, Ledger, (keys, viewer, ct) => Task.FromResult(keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k == Matrix ? "The Matrix" : "Firefly" })));
            Projection = new RequestHubProjection(Requests, Directory, Aliases, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => Arr.Now, null, Status);
            Fulfilment = new RequestFulfilment(Ledger, Status, View, Feed, Aliases, null, () => Config, () => Arr.Now);
            View.AddCopy(TitleKey.Parse(Firefly)!, new JfCopy { ItemId = SeriesItem, Path = "/media/tv/Firefly", LibraryName = "Shows", DateCreated = Arr.Now.UtcDateTime.AddDays(-300) });
            View.AddEpisode(SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = Arr.Now.UtcDateTime.AddDays(-300) });
        }

        private void Person(StatusViewer viewer, string role)
            => Policy.People[viewer.UserId] = new(viewer.UserId, role, role != "Watcher", role is "Manager" or "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");

        private static JsonObject Episode(int id, int season, int episode, bool hasFile, bool monitored) => new()
        {
            ["id"] = id, ["seriesId"] = 31, ["seasonNumber"] = season, ["episodeNumber"] = episode, ["title"] = "Ep " + episode,
            ["airDateUtc"] = $"2002-10-0{episode}T01:00:00Z", ["hasFile"] = hasFile, ["monitored"] = monitored,
        };

        /// <summary>Loads the snapshots (the first reads start them in the background).</summary>
        public async Task Warm()
        {
            var keys = new[] { TitleKey.Parse(Matrix)!, TitleKey.Parse(Firefly)! };
            await Status.ComposeForAsync(Admin, keys, null, default);
            await Task.Delay(50);
            await Status.ComposeForAsync(Admin, keys, null, default);
        }

        public async Task<string> Ask(StatusViewer who, MutationInput input)
        {
            var outcome = await Requests.CreateAsync(who.UserId, new CreateRequest(Guid.NewGuid().ToString("N"), input), default);
            Assert.True(outcome.HttpStatus < 300, outcome.Reason);
            return outcome.RequestId!;
        }

        /// <summary>The viewer's Requests page: every entry of My requests and Ready by title key.</summary>
        public async Task<Dictionary<string, JsonElement>> Page(StatusViewer viewer)
        {
            var body = await Hub.ForViewerAsync(viewer, default);
            using var doc = JsonDocument.Parse(body.Json);
            var result = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var list in new[] { "mine", "ready" })
            {
                foreach (var entry in doc.RootElement.GetProperty(list).EnumerateArray()) result[entry.GetProperty("key").GetString()!] = entry.Clone();
            }
            return result;
        }

        public void Dispose()
        {
            Fulfilment.Dispose();
            Db.Dispose();
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Model.Dispose();
            Seerr.Dispose();
            Arr.Dispose();
        }
    }

    private static (string Group, string Stage, string Reason) Row(JsonElement entry)
        => (entry.GetProperty("group").GetString()!, entry.GetProperty("status").GetProperty("stage").GetString()!, entry.GetProperty("status").GetProperty("reason").GetProperty("code").GetString()!);

    [Fact]
    public async Task JeModeRowsFollowWhereThePartAskedForIsAndArrivalsAreFulfilledNotStale()
    {
        using var lab = new Lab();
        await lab.Warm();
        // Emma (a Member) asks for The Matrix and for Firefly S1E4: both go out at once.
        var movie = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        var e4 = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } });
        await lab.Outbox.TickAsync(default);
        Assert.Equal(("sent", "sent"), (lab.Ledger.Find(movie)!.Status, lab.Ledger.Find(e4)!.Status));
        // The Kid asks for season 2 (Sonarr doesn't monitor it): it waits for an OK.
        var s2 = await lab.Ask(lab.Kid, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 2 } });
        Assert.Equal("pending", lab.Ledger.Find(s2)!.Status);

        // Not "OK'd! Getting started": the movie is downloading, the episode is being looked for (E1 being here
        // says nothing about E4), the Kid's season waits for an OK.
        var emma = await lab.Page(lab.Emma);
        Assert.Equal(("onTheWay", StatusStage.Downloading, StatusReasonCode.Downloading), Row(emma[Matrix]));
        Assert.Equal(50, emma[Matrix].GetProperty("status").GetProperty("progress").GetProperty("percent").GetInt32());
        Assert.Equal(("onTheWay", StatusStage.Looking, StatusReasonCode.Looking), Row(emma[Firefly]));
        Assert.Equal("The Matrix", emma[Matrix].GetProperty("title").GetString());
        var kid = await lab.Page(lab.Kid);
        Assert.Equal(("needsOk", StatusStage.Asked, StatusReasonCode.AwaitingApproval), Row(kid[Firefly]));

        // The household list (an admin's view) says the same for each request, not "On the way".
        var parts = await lab.Projection.PartStatusesAsync(lab.Ledger.ForTitle(Matrix).Concat(lab.Ledger.ForTitle(Firefly)), lab.Admin, default);
        Assert.Equal(StatusStage.Downloading, parts[movie].Stage);
        Assert.Equal(StatusStage.Looking, parts[e4].Stage);
        Assert.Equal(StatusStage.Asked, parts[s2].Stage);

        // Nothing is there yet: nothing is fulfilled.
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(null, default));

        // E4 and the movie arrive in Jellyfin: Ready with Play, and the requests are fulfilled (the Kid's season isn't).
        var movieItem = Guid.NewGuid();
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = movieItem, Path = "/media/movies/The Matrix", LibraryName = "Movies", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 4, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        emma = await lab.Page(lab.Emma);
        Assert.Equal("ready", emma[Matrix].GetProperty("group").GetString());
        Assert.Equal(movieItem.ToString("N"), emma[Matrix].GetProperty("itemId").GetString());
        Assert.Equal(("ready", StatusStage.Ready), (emma[Firefly].GetProperty("group").GetString(), emma[Firefly].GetProperty("status").GetProperty("stage").GetString()));
        var feedBefore = lab.Feed.Revision(ArrTitleKey.UserRequests(lab.Emma.UserId));
        Assert.Equal(2, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal(("fulfilled", "fulfilled", "pending"), (lab.Ledger.Find(movie)!.Status, lab.Ledger.Find(e4)!.Status, lab.Ledger.Find(s2)!.Status));
        Assert.True(lab.Feed.Revision(ArrTitleKey.UserRequests(lab.Emma.UserId)) > feedBefore, "open pages hear of it");
        // Retention 40 days later never turns them stale; nothing is looked at twice.
        lab.Ledger.Retain(lab.Arr.Now.AddDays(40), 30);
        Assert.Equal(("fulfilled", "fulfilled"), (lab.Ledger.Find(movie)!.Status, lab.Ledger.Find(e4)!.Status));
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal("ready", (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());
    }

    [Fact]
    public async Task ASeasonAskedForArrivesOnlyWhenEveryAiredEpisodeIsHereNotWhenTheMissingOneIsUnmonitored()
    {
        using var lab = new Lab();
        // Seen live (Seerr mode, before Seerr OK'd it): S1 E1-E3 here, E4 not monitored in Sonarr and not here. The ask
        // for season 1 must not be fulfilled at once because the season "reads Ready" for what Sonarr monitors.
        foreach (var e in lab.Sonarr.Episodes.Where(e => (int)e["seasonNumber"]! == 1 && (int)e["episodeNumber"]! is 2 or 3)) e["hasFile"] = true;
        lab.Sonarr.Episodes.Single(e => (int)e["seasonNumber"]! == 1 && (int)e["episodeNumber"]! == 4)["monitored"] = false;
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = lab.Arr.Now.UtcDateTime.AddDays(-5) });
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = lab.Arr.Now.UtcDateTime.AddDays(-5) });
        lab.View.Rev++;
        await lab.Warm();
        var s1 = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } });
        await lab.Outbox.TickAsync(default);
        Assert.Equal("sent", lab.Ledger.Find(s1)!.Status);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal("sent", lab.Ledger.Find(s1)!.Status);
        Assert.NotEqual(StatusStage.Ready, (await lab.Page(lab.Emma))[Firefly].GetProperty("status").GetProperty("stage").GetString());

        // E4 arrives: now the season is here and the ask is fulfilled.
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 4, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(s1)!.Status);
    }

    [Fact]
    public async Task AnArrivedRequestWhoseTitleWasRemovedSaysSoAndCanBeAskedForAgainNeverOkdAgain()
    {
        using var lab = new Lab();
        await lab.Warm();
        var movie = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        // It arrives and the request is fulfilled.
        lab.Radarr.Queue.Clear();
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = Guid.NewGuid(), Path = "/media/movies/The Matrix", LibraryName = "Movies", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(movie)!.Status);

        // Later it is removed from Jellyfin and from Radarr.
        lab.View.CopiesByKey.Remove(Matrix);
        lab.View.Rev++;
        lab.Radarr.Movies.Clear();
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Arr.Instance("RadarrZ"), default)).Ok);
        lab.Store.RequestRefresh(lab.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue);
        lab.Arr.Now += TimeSpan.FromHours(1);
        await lab.Warm();

        // Honest: "Was here, since removed" in its own group, no Play, never "OK'd! Getting started" again.
        var row = (await lab.Page(lab.Emma))[Matrix];
        Assert.Equal((HubGroup.Removed, StatusStage.NotHere, StatusReasonCode.Removed), Row(row));
        Assert.False(row.TryGetProperty("itemId", out var item) && item.ValueKind != JsonValueKind.Null, "no Play");
        // Everyone in the household reads the same status for the title (the request facts are the household's).
        foreach (var viewer in new[] { lab.Emma, lab.Kid, lab.Admin })
        {
            var status = (await lab.Status.ComposeForAsync(viewer, new[] { TitleKey.Parse(Matrix)! }, null, default)).Single().Status;
            Assert.Equal((StatusStage.NotHere, StatusReasonCode.Removed), (status.Stage, status.Reason.Code));
        }

        // Asked for again: a new request, OK'd and on its way like any new one (the removal no longer speaks for it).
        var again = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        Assert.NotEqual(movie, again);
        await lab.Outbox.TickAsync(default);
        Assert.Equal(("fulfilled", "sent"), (lab.Ledger.Find(movie)!.Status, lab.Ledger.Find(again)!.Status));
        Assert.Equal(HubGroup.OnTheWay, (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());
    }

    [Fact]
    public async Task ARemovedRowStaysAsLongAsAReadyOneWouldThenGoes()
    {
        using var lab = new Lab();
        await lab.Warm();
        var movie = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        Assert.True(lab.Ledger.Fulfil(movie, lab.Arr.Now));
        lab.Radarr.Movies.Clear();
        lab.Radarr.Queue.Clear();
        Assert.True((await lab.Store.RefreshLibraryNowAsync(lab.Arr.Instance("RadarrZ"), default)).Ok);
        lab.Store.RequestRefresh(lab.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue);
        lab.Arr.Now += TimeSpan.FromDays(13);
        await lab.Warm();
        Assert.Equal(HubGroup.Removed, (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());
        lab.Arr.Now += TimeSpan.FromDays(2);
        await lab.Warm();
        Assert.False((await lab.Page(lab.Emma)).ContainsKey(Matrix));
    }

    [Fact]
    public void LedgerFactsAreFulfilledOnlyWhenEveryRequestStillOnArrived()
    {
        var user = Guid.NewGuid();
        var now = new DateTimeOffset(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);
        RequestWant Want(string status, string variant = "standard")
            => new(Guid.NewGuid().ToString("N"), "a", user, "c", "f", new MutationInput { Key = Matrix, Variant = variant }.Normalize()!, status, "x", 1, "{}", now, now);
        bool Fulfilled(params RequestWant[] wants) => LedgerRequestFacts.FactsOf(wants, user, Array.Empty<RequestDispatch>)!.Fulfilled;
        Assert.True(Fulfilled(Want("fulfilled")));
        Assert.True(Fulfilled(Want("fulfilled"), Want("declined")));
        Assert.True(Fulfilled(Want("fulfilled"), Want("cancelled")));
        Assert.False(Fulfilled(Want("fulfilled"), Want("pending", "4k")));
        Assert.False(Fulfilled(Want("fulfilled"), Want("sent")));
        Assert.False(Fulfilled(Want("sent")));
        Assert.False(Fulfilled(Want("declined")));
    }

    [Fact]
    public async Task AWaitingAskWhosePartArrivesAnotherWayClosesAndGivesItsAllowanceBack()
    {
        using var lab = new Lab();
        await lab.Warm();
        // The Kid asks for E3; before anyone OKs it, it arrives (monitored in Sonarr outside Jellyfin Enhanced).
        var e3 = await lab.Ask(lab.Kid, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });
        Assert.Equal("pending", lab.Ledger.Find(e3)!.Status);
        Assert.Single(lab.Ledger.List(lab.Admin.UserId, true));
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        // Only the title that changed is looked at.
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
        Assert.Equal(("fulfilled", "ready"), (lab.Ledger.Find(e3)!.Status, lab.Ledger.Find(e3)!.Reason));
        Assert.Empty(lab.Ledger.List(lab.Admin.UserId, true));
        Assert.Equal(0, lab.Requests.Quota(lab.Kid.UserId).Used);
        Assert.DoesNotContain(lab.Ledger.ForWant(e3), j => j.State is "queued" or "retry");
        // "Keep getting new episodes" never ends, whatever is here.
        var future = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "future", Seasons = new[] { 1 } });
        await lab.Outbox.TickAsync(default);
        Assert.False(lab.Ledger.Fulfil(future, lab.Arr.Now));
    }

    [Fact]
    public void AlsoWantedByCountsOnlyTheSamePart()
    {
        MutationInput Eps(params (int S, int E)[] eps) => new() { Key = Firefly, Scope = "episodes", Episodes = eps.Select(e => new RequestEpisode(e.S, e.E)).ToArray() };
        MutationInput Seasons(string scope, params int[] s) => new() { Key = Firefly, Scope = scope, Seasons = s };
        Assert.True(Eps((1, 4)).Overlaps(Eps((1, 4), (1, 5))));
        Assert.False(Eps((1, 4)).Overlaps(Eps((1, 5))));
        Assert.True(Eps((2, 1)).Overlaps(Seasons("seasons", 2)));
        Assert.False(Eps((1, 1)).Overlaps(Seasons("seasons", 2)));
        Assert.True(Seasons("seasons", 1, 2).Overlaps(Seasons("next_season", 2)));
        Assert.False(Seasons("seasons", 1).Overlaps(Seasons("seasons", 2)));
        Assert.True(Seasons("future", 3).Overlaps(Seasons("future", 4)));
        Assert.False(new MutationInput { Key = Matrix }.Overlaps(new MutationInput { Key = Matrix, Variant = "4k" }));
        Assert.True(new MutationInput { Key = Matrix }.Overlaps(new MutationInput { Key = Matrix }));
    }

    [Fact]
    public async Task TheApprovalCardNamesOnlyPeopleWhoAskedForTheSamePartAndShowsWhereItIs()
    {
        using var lab = new Lab();
        await lab.Warm();
        var other = lab.View.AddUser(false);
        lab.Policy.People[other.UserId] = new(other.UserId, "Kid", true, false, false, true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        // The Kid asks for E3; another Kid for E3 and E4 (the same part, E3); Emma's E2 went out (another part).
        var e3 = await lab.Ask(lab.Kid, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });
        await lab.Ask(other, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3), new RequestEpisode(1, 4) } });
        await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } });
        await lab.Outbox.TickAsync(default);
        foreach (var (id, name) in new[] { (lab.Kid.UserId, "Kim"), (other.UserId, "Otto"), (lab.Emma.UserId, "Emma"), (lab.Admin.UserId, "Jake") })
            lab.Directory.People[id] = new HouseholdPerson { Id = id, Name = name };
        var body = await lab.Projection.ApprovalsAsync(lab.Admin, default);
        using var doc = JsonDocument.Parse(body.Json);
        var card = doc.RootElement.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetString() == e3);
        Assert.Equal(new[] { "Otto" }, card.GetProperty("alsoWanted").EnumerateArray().Select(x => x.GetString()).ToArray());
        // Sonarr already looks for E3 (season 1 is monitored): the card says so, not just "waiting for an OK".
        Assert.Equal(StatusStage.Looking, card.GetProperty("partStatus").GetProperty("stage").GetString());
    }

    [Fact]
    public void TheCountsSayOneRequestNotOneRequests()
    {
        var digest = NotifyTexts.Render(NotifyKind.StuckDigest, new Dictionary<string, string> { ["count"] = "1", ["hours"] = "6", ["items"] = "Dune" }, false);
        Assert.Equal("1 download needs attention", digest.Title);
        Assert.Equal("3 downloads need attention", NotifyTexts.Render(NotifyKind.StuckDigest, new Dictionary<string, string> { ["count"] = "3", ["hours"] = "6", ["items"] = "x" }, false).Title);
        var ok = NotifyTexts.Render(NotifyKind.Approved, new Dictionary<string, string> { ["title"] = "Firefly", ["scope"] = "S1E4", ["contact"] = "Dad" }, false);
        Assert.Equal("Dad OK'd Firefly S1E4", ok.Title);
        Assert.Equal("Dad OK'd a request", NotifyTexts.Render(NotifyKind.Approved, new Dictionary<string, string> { ["title"] = "Firefly", ["contact"] = "Dad" }, true).Title);
        Assert.Equal("Firefly is on its way", NotifyTexts.Render(NotifyKind.Approved, new Dictionary<string, string> { ["title"] = "Firefly", ["shared"] = "1" }, false).Title);
        Assert.Equal("S1E4", NotificationService.ScopeLabel(new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } }));
        Assert.Equal("S1–S3", NotificationService.ScopeLabel(new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1, 2, 3 } }));
        Assert.Null(NotificationService.ScopeLabel(new MutationInput { Key = Matrix }));
    }

    [Fact]
    public async Task OkAndNoReachTheRequesterOnceOnEveryChannelAcrossARestartAndHonourTheirSwitches()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "je";
        rig.Phones(rig.Kid);
        var policy = new IntegrationRequestLedgerTests.Policy();
        foreach (var (viewer, role) in new[] { (rig.Admin, "Admin"), (rig.Kid, "Kid"), (rig.Emma, "Member") })
            policy.People[viewer.UserId] = new(viewer.UserId, role, true, role == "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        RequestLedger ledger = null!;
        RequestService requests = null!;
        NotificationService service = null!;
        void Open()
        {
            ledger = new RequestLedger(rig.Db);
            requests = new RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
            service?.Dispose();
            service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger,
                (keys, viewer, ct) => Task.FromResult(keys.ToDictionary(k => k, k => new HubTitleMeta { Title = k == IntegrationNotificationsTestsDune ? "Dune: Part Two" : "Severance", Year = 2024 })));
        }
        Open();
        async Task Round()
        {
            await service.TickAsync(default);
            await rig.Dispatcher.RunOnceAsync(default);
        }

        // The Kid asks: nothing to tell yet. The OK tells them once: inbox, phone, e-mail.
        var ask = await requests.CreateAsync(rig.Kid.UserId, new("kid-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default);
        Assert.Equal("awaiting_approval", ask.Reason);
        await Round();
        Assert.Empty(rig.Inbox(rig.Kid));
        Assert.Equal(200, (await requests.ApproveAsync(ask.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        // Jellyfin restarts before the notice was handled: it is told after the start, once.
        rig.Open();
        Open();
        await Round();
        await Round();
        var ok = Assert.Single(rig.Inbox(rig.Kid));
        var p = JsonSerializer.Deserialize<Dictionary<string, string>>(ok.Payload)!;
        Assert.Equal(("approved", IntegrationNotificationsTestsDune, "Dune: Part Two", "Dad"), (ok.Kind, ok.Key, p["title"], p["contact"]));
        var push = Assert.Single(rig.Pushes);
        Assert.Equal("Dad OK'd Dune: Part Two", (string)push.Body["title"]!);
        Assert.Single(rig.Mail.Sent, m => m.Subject == "Dad OK'd Dune: Part Two");
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == "approved");
        Assert.Equal(0L, Convert.ToInt64(rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT COUNT(*) FROM request_notices", Array.Empty<(string, object?)>(), null))));

        // A restart over the same database tells nothing again.
        rig.Open();
        Open();
        await Round();
        Assert.Single(rig.Inbox(rig.Kid));
        Assert.Single(rig.Pushes);

        // A no, with the reason.
        var second = await requests.CreateAsync(rig.Kid.UserId, new("kid-sev", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "seasons", Seasons = new[] { 1 } }), default);
        Assert.Equal(200, (await requests.DeclineAsync(second.RequestId!, rig.Admin.UserId, "Too scary for now", default)).HttpStatus);
        await Round();
        var no = rig.Inbox(rig.Kid).Single(n => n.Kind == "declined");
        var np = JsonSerializer.Deserialize<Dictionary<string, string>>(no.Payload)!;
        Assert.Equal(("Too scary for now", "S1"), (np["reason"], np["scope"]));
        Assert.Contains(rig.Pushes, x => (string)x.Body["title"]! == "Dad said no to Severance");

        // Switched off: an OK is not told (and its notice doesn't wait for the switch).
        rig.Prefs(rig.Kid, x => x.Approved = false);
        var third = await requests.CreateAsync(rig.Kid.UserId, new("kid-dune-4k", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "seasons", Seasons = new[] { 2 } }), default);
        await requests.ApproveAsync(third.RequestId!, rig.Admin.UserId, null, default);
        await Round();
        Assert.Single(rig.Inbox(rig.Kid), n => n.Kind == "approved");
        Assert.Equal(0L, Convert.ToInt64(rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT COUNT(*) FROM request_notices", Array.Empty<(string, object?)>(), null))));
        service.Dispose();
    }

    [Fact]
    public async Task InJeModeARequestIsAnInterestAndItsArrivalIsToldOnceForExactlyThePartAskedFor()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "je";
        var policy = new IntegrationRequestLedgerTests.Policy();
        policy.People[rig.Emma.UserId] = new(rig.Emma.UserId, "Member", true, false, false, true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        var ledger = new RequestLedger(rig.Db);
        var requests = new RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var outbox = new RequestOutbox(ledger, policy, new IntegrationRequestLedgerTests.Backend(), new RequestTitleLocks(), rig.Feed, new ArrAuditLog(Path.Combine(rig.Arr.Plugin.Core.Root, "notify-audit.jsonl"), 100000, 1), () => rig.Arr.Now);
        using var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger);
        await service.TickAsync(default);

        // Severance is in Jellyfin with E1; Emma asks for E3 and for Dune (both go out).
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(IntegrationNotificationsTestsSeverance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        await requests.CreateAsync(rig.Emma.UserId, new("emma-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default);
        await requests.CreateAsync(rig.Emma.UserId, new("emma-e3", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } }), default);
        await outbox.TickAsync(default);
        // The ledger's change is a first look (what is there now is never told).
        await service.TickAsync(default, force: true);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, IntegrationNotificationsTestsSeverance, "eps"));

        // E2 arrives (not asked for): nothing. E3 and Dune arrive: told once each.
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        var dune = rig.Arrive(IntegrationNotificationsTestsDune);
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune, IntegrationNotificationsTestsSeverance }, null, default);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        service.FlushBatches(rig.Arr.Now);
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune, IntegrationNotificationsTestsSeverance }, null, default);
        service.FlushBatches(rig.Arr.Now);
        var inbox = rig.Inbox(rig.Emma);
        var ready = Assert.Single(inbox, n => n.Kind == "ready");
        Assert.Equal(dune.ToString("N"), ready.ItemId);
        var episodes = Assert.Single(inbox, n => n.Kind == "episodes");
        var ep = JsonSerializer.Deserialize<Dictionary<string, string>>(episodes.Payload)!;
        Assert.Equal(("single", "1", "3"), (ep["mode"], ep["season"], ep["episode"]));
    }

    [Fact]
    public async Task ASeasonIsNeverMarkedFulfilledFromAReadWhileSonarrCantBeRead()
    {
        using var lab = new Lab();
        // Jellyfin started before Sonarr: its library was never read. Jellyfin has S1E1 (of four) and S2E1 (of two).
        lab.Sonarr.FailWith = 503;
        await lab.Warm();
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        var sent = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 1 } });
        await lab.Outbox.TickAsync(default);
        var waiting = await lab.Ask(lab.Kid, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 2 } });
        Assert.Equal(("sent", "pending"), (lab.Ledger.Find(sent)!.Status, lab.Ledger.Find(waiting)!.Status));
        // One episode of each season is here, the rest unknown: nothing is closed, the Kid's ask stays for an OK.
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal(("sent", "pending"), (lab.Ledger.Find(sent)!.Status, lab.Ledger.Find(waiting)!.Status));
        Assert.Single(lab.Ledger.List(lab.Admin.UserId, true));
        // A single episode asked for is judged by Jellyfin alone: here is here.
        var e1 = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(2, 1) } });
        await lab.Outbox.TickAsync(default);
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(e1)!.Status);
    }

    [Fact]
    public async Task SweepsGoOnThroughEveryOpenRequestNotOnlyTheOldestOnes()
    {
        using var lab = new Lab();
        await lab.Warm();
        lab.Fulfilment.SweepPage = 2;
        // Three requests out, oldest first: The Matrix and E3 haven't arrived; E4, the newest, has.
        var asked = new List<string>();
        foreach (var input in new[]
        {
            new MutationInput { Key = Matrix },
            new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } },
            new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 4) } },
        })
        {
            asked.Add(await lab.Ask(lab.Emma, input));
            await lab.Outbox.TickAsync(default);
            lab.Arr.Now = lab.Arr.Now.AddSeconds(1);
        }
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 4, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        // The first sweep looks at the two oldest; the next one goes on to E4; then it starts again from the first.
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal(("sent", "sent", "fulfilled"), (lab.Ledger.Find(asked[0])!.Status, lab.Ledger.Find(asked[1])!.Status, lab.Ledger.Find(asked[2])!.Status));
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(null, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(asked[1])!.Status);
    }

    [Fact]
    public async Task ARequestThatChangedSinceItWasCheckedIsNotFulfilled()
    {
        using var lab = new Lab();
        await lab.Warm();
        // Emma's E2 went out; the Kid asks for E3, which is checked and found here.
        await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } });
        await lab.Outbox.TickAsync(default);
        var ask = await lab.Ask(lab.Kid, new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) } });
        var seen = lab.Ledger.Find(ask)!;
        // Before it is marked, the admin OKs it with edits: E2 instead (already out, so it reads sent at once).
        lab.Arr.Now = lab.Arr.Now.AddSeconds(1);
        var edits = new MutationInput { Key = Firefly, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } };
        Assert.Equal(200, (await lab.Requests.ApproveAsync(ask, lab.Admin.UserId, new ApproveRequest(edits), default)).HttpStatus);
        Assert.Equal("sent", lab.Ledger.Find(ask)!.Status);
        // What was checked (E3) is not what it asks for now (E2, not here): left for the next look.
        Assert.False(lab.Ledger.Fulfil(ask, lab.Arr.Now, seen));
        Assert.Equal("sent", lab.Ledger.Find(ask)!.Status);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
    }

    /// <summary>Jellyfin Enhanced mode over the notification rig: the ledger, its request service and a notification service reading it.</summary>
    private static (RequestLedger Ledger, RequestService Requests, NotificationService Service) JeMode(IntegrationNotificationsTests.Rig rig, IntegrationRequestLedgerTests.Policy policy, NotifyDispatcher? dispatcher = null)
    {
        rig.Config.ArrPhase3Enabled = true;
        rig.Config.ArrRequestBackend = "je";
        foreach (var (viewer, role) in new[] { (rig.Admin, "Admin"), (rig.Kid, "Kid"), (rig.Emma, "Member") })
            policy.People[viewer.UserId] = new(viewer.UserId, role, true, role == "Admin", role == "Admin", true, "p1", "je", "inst", "g1", 7, 7, 0, "{}");
        var ledger = new RequestLedger(rig.Db);
        var requests = new RequestService(ledger, policy, rig.View, rig.Feed, () => rig.Arr.Now);
        var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, dispatcher ?? rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger);
        return (ledger, requests, service);
    }

    [Fact]
    public async Task ARequestMadeJustBeforeARestartGetsItsFirstLookAtOnceSoItsArrivalIsTold()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var policy = new IntegrationRequestLedgerTests.Policy();
        var (_, requests, service) = JeMode(rig, policy);
        service.Begin();
        await service.TickAsync(default, force: true);
        // Emma asks for Dune; Jellyfin stops before the notifications looked at the ask.
        Assert.True((await requests.CreateAsync(rig.Emma.UserId, new("emma-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default)).HttpStatus < 300);
        service.Dispose();
        // After the start (its first sweep is a while off) the ask gets its first look at once ...
        rig.Open();
        (_, _, service) = JeMode(rig, policy);
        using var after = service;
        after.Begin();
        await after.TickAsync(default, force: true);
        // ... so Dune arriving next is told (not recorded silently as a first look).
        var dune = rig.Arrive(IntegrationNotificationsTestsDune);
        await after.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.Equal(dune.ToString("N"), Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready").ItemId);
    }

    [Fact]
    public async Task AnOkHeldByQuietHoursGoesOutWhenTheyEndUnlessTheRequestWasCancelledAndOldNoticesAreDropped()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Kid);
        rig.Prefs(rig.Kid, p => { p.QuietHours = true; p.QuietFrom = "00:00"; p.QuietTo = "23:59"; p.UtcOffsetMinutes = 0; });
        var policy = new IntegrationRequestLedgerTests.Policy();
        var ledger = new RequestLedger(rig.Db);
        using var dispatcher = new NotifyDispatcher(rig.NotifyStore, new NtfySender(rig.Ntfy), new EmailSender(rig.Mail), null, () => rig.Config, () => rig.Arr.Now, rig.Users, rig.View, rig.Status.Aliases, ledger);
        var (_, requests, service) = JeMode(rig, policy, dispatcher);
        using var _service = service;
        async Task Round()
        {
            await service.TickAsync(default);
            await dispatcher.RunOnceAsync(default);
        }
        // Two asks OK'd in the Kid's quiet hours: both in the inbox at once, phone and e-mail wait.
        var dune = await requests.CreateAsync(rig.Kid.UserId, new("kid-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default);
        var sev = await requests.CreateAsync(rig.Kid.UserId, new("kid-sev", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "seasons", Seasons = new[] { 1 } }), default);
        Assert.Equal(200, (await requests.ApproveAsync(dune.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        Assert.Equal(200, (await requests.ApproveAsync(sev.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        await Round();
        Assert.Equal(2, rig.Inbox(rig.Kid).Count(n => n.Kind == "approved"));
        Assert.Empty(rig.Pushes);
        Assert.Empty(rig.Mail.Sent);
        // Dune's request is cancelled before they end: only Severance's OK reaches the phone and the mailbox.
        Assert.True(requests.Close(dune.RequestId!, rig.Admin.UserId, null).HttpStatus < 300);
        Assert.Equal("cancelled", ledger.Find(dune.RequestId!)!.Status);
        rig.Prefs(rig.Kid, p => p.QuietHours = false);
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        await dispatcher.RunOnceAsync(default);
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
        Assert.Contains("Severance", (string)rig.Pushes[0].Body["title"]!);

        // An OK whose notice waited more than three days (notifications were off) is dropped, not told late.
        var late = await requests.CreateAsync(rig.Kid.UserId, new("kid-sev-2", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "seasons", Seasons = new[] { 2 } }), default);
        Assert.Equal(200, (await requests.ApproveAsync(late.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        rig.Arr.Now = rig.Arr.Now.AddDays(4);
        await Round();
        Assert.Equal(2, rig.Inbox(rig.Kid).Count(n => n.Kind == "approved"));
        Assert.Equal(0L, Convert.ToInt64(rig.Db.Read(c => NotifyStore.Scalar(c, "SELECT COUNT(*) FROM request_notices", Array.Empty<(string, object?)>(), null))));
        Assert.Single(rig.Pushes);
    }

    [Fact]
    public async Task InJeModeTurningNotifyMeOffForARequestedTitleMutesItsArrival()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var policy = new IntegrationRequestLedgerTests.Policy();
        var (_, requests, service) = JeMode(rig, policy);
        using var _service = service;
        await service.TickAsync(default, force: true);
        await requests.CreateAsync(rig.Emma.UserId, new("emma-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default);
        await service.TickAsync(default, force: true);
        // Followed because she asked for it; "Following" off mutes it (the request would otherwise follow it again).
        Assert.Contains(IntegrationNotificationsTestsDune, service.FollowsOf(rig.Emma.UserId).Requested);
        Assert.Equal("ok", await service.SetFollowAsync(rig.Emma, TitleKey.Parse(IntegrationNotificationsTestsDune)!, false, default));
        Assert.Contains(rig.NotifyStore.Follows(rig.Emma.UserId), f => f.Key == IntegrationNotificationsTestsDune && f.Muted);
        rig.Arrive(IntegrationNotificationsTestsDune);
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.DoesNotContain(rig.Inbox(rig.Emma), n => n.Kind == "ready");
    }

    // ------------------------------------------------------------------ review round 2

    [Fact]
    public async Task AFourKAskAfterTheStandardCopyArrivedFollowsTheFourKCopyNotTheStandardOnesReady()
    {
        using var lab = new Lab(fourK: true);
        lab.Policy.Adjust = (_, _, person) => person with { Can4k = true };
        await lab.Warm();
        // Emma asks for The Matrix; the standard copy arrives and her request is fulfilled.
        var standard = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix });
        await lab.Outbox.TickAsync(default);
        var hd = Guid.NewGuid();
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = hd, Path = "/media/movies/The Matrix", LibraryName = "Movies", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.Equal("ready", (await lab.Page(lab.Emma))[Matrix].GetProperty("group").GetString());

        // A day later she asks for the 4K copy: her row follows the 4K copy (not Ready with the standard copy's Play).
        lab.Arr.Now = lab.Arr.Now.AddDays(1);
        var fourK = await lab.Ask(lab.Emma, new MutationInput { Key = Matrix, Variant = "4k" });
        await lab.Outbox.TickAsync(default);
        Assert.Equal("sent", lab.Ledger.Find(fourK)!.Status);
        var row = (await lab.Page(lab.Emma))[Matrix];
        Assert.Equal("onTheWay", row.GetProperty("group").GetString());
        Assert.NotEqual(StatusStage.Ready, row.GetProperty("status").GetProperty("stage").GetString());
        Assert.True(row.GetProperty("is4k").GetBoolean());
        Assert.NotEqual(hd.ToString("N"), row.TryGetProperty("itemId", out var none) ? none.GetString() : null);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));

        // The 4K copy arrives: Ready with Play of the 4K copy, before and after its request is fulfilled.
        lab.Arr.Now = lab.Arr.Now.AddHours(1);
        var uhd = Guid.NewGuid();
        lab.View.AddCopy(TitleKey.Parse(Matrix)!, new JfCopy { ItemId = uhd, Path = "/media/movies4k/The Matrix (1999)/The Matrix.mkv", LibraryName = "Movies 4K", DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        row = (await lab.Page(lab.Emma))[Matrix];
        Assert.Equal(("ready", uhd.ToString("N")), (row.GetProperty("group").GetString(), row.GetProperty("itemId").GetString()));
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Matrix }, default));
        Assert.Equal(("fulfilled", "fulfilled"), (lab.Ledger.Find(standard)!.Status, lab.Ledger.Find(fourK)!.Status));
        row = (await lab.Page(lab.Emma))[Matrix];
        Assert.Equal(("ready", uhd.ToString("N")), (row.GetProperty("group").GetString(), row.GetProperty("itemId").GetString()));
    }

    /// <summary>Adds a 4K Radarr (role 4k) holding Dune in its own folder (no file yet), before anything is read.</summary>
    private static void FourKRadarr(IntegrationNotificationsTests.Rig r)
    {
        var host = r.Arr.Add("radarr4k.lan", "Radarr");
        r.Arr.Configure(
            ("RadarrZ", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"),
            ("SonarrZ", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"),
            ("Radarr4kZ", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR4K-KEY-0123456789"));
        var rows = JsonNode.Parse(r.Config.RadarrInstances)!.AsArray();
        foreach (var row in rows)
        {
            if ((string?)row!["Name"] == "Radarr4kZ") row["Role"] = "4k";
        }
        r.Config.RadarrInstances = rows.ToJsonString();
        host.Movies.Add(FakeArr.Movie(4, 693134, "Dune Part Two", hasFile: false, path: "/data/movies4k/Dune Part Two (2024)"));
    }

    private static RequestOutbox Outbox(IntegrationNotificationsTests.Rig rig, RequestLedger ledger, IntegrationRequestLedgerTests.Policy policy)
        => new(ledger, policy, new IntegrationRequestLedgerTests.Backend(), new RequestTitleLocks(), rig.Feed, new ArrAuditLog(Path.Combine(rig.Arr.Plugin.Core.Root, "r2-audit-" + Guid.NewGuid().ToString("N") + ".jsonl"), 100000, 1), () => rig.Arr.Now);

    [Fact]
    public async Task AFourKAskAfterTheStandardCopyArrivedIsToldWhenTheFourKCopyArrivesOnce()
    {
        using var rig = await IntegrationNotificationsTests.Started(FourKRadarr);
        var policy = new IntegrationRequestLedgerTests.Policy { Adjust = (_, _, person) => person with { Can4k = true } };
        var (ledger, requests, service) = JeMode(rig, policy);
        using var _service = service;
        var outbox = Outbox(rig, ledger, policy);
        await service.TickAsync(default, force: true);
        async Task<string> Ask(string id, string variant)
        {
            var outcome = await requests.CreateAsync(rig.Emma.UserId, new(id, new MutationInput { Key = IntegrationNotificationsTestsDune, Variant = variant }), default);
            Assert.True(outcome.HttpStatus < 300, outcome.Reason);
            await outbox.TickAsync(default);
            await service.TickAsync(default, force: true);
            return outcome.RequestId!;
        }
        // Emma asks for Dune; the standard copy arrives: told, and her request is fulfilled.
        var standard = await Ask("emma-dune", "standard");
        var hd = rig.Arrive(IntegrationNotificationsTestsDune);
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.True(ledger.Fulfil(standard, rig.Arr.Now, ledger.Find(standard)!));

        // She asks for the 4K copy: followed through the 4K copy, nothing told yet.
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        var fourK = await Ask("emma-dune-4k", "4k");
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, IntegrationNotificationsTestsDune, "m4k"));
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");

        // The 4K copy arrives: told once (as 4K), also after the request is marked fulfilled.
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        var uhd = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(IntegrationNotificationsTestsDune)!, new JfCopy { ItemId = uhd, Path = "/media/movies4k/Dune Part Two (2024)/Dune.mkv", LibraryName = "Movies 4K", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.True(ledger.Fulfil(fourK, rig.Arr.Now, ledger.Find(fourK)!));
        await service.TickAsync(default, force: true);
        await service.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        var ready = rig.Inbox(rig.Emma).Where(n => n.Kind == "ready").ToList();
        Assert.Equal(new[] { uhd.ToString("N"), hd.ToString("N") }, ready.Select(n => n.ItemId).ToArray());
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(ready[0].Payload)!["variant"]);
    }

    [Fact]
    public async Task InSeerrModeAFourKRequestAfterTheStandardCopyArrivedIsToldWhenTheFourKCopyArrivesOnce()
    {
        // Seerr's requests are the interests (no ledger): Emma's standard request for Dune, OK'd in Seerr.
        using var rig = await IntegrationNotificationsTests.Started(r =>
        {
            FourKRadarr(r);
            r.Request(1, 693134, r.Emma);
        });
        await rig.Step(IntegrationNotificationsTestsDune);
        // The standard copy arrives: told.
        var hd = rig.Arrive(IntegrationNotificationsTestsDune);
        await rig.Step(IntegrationNotificationsTestsDune);
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");

        // A day later she asks for the 4K copy in Seerr: followed through the 4K copy, nothing told yet.
        rig.Arr.Now = rig.Arr.Now.AddDays(1);
        rig.Request(2, 693134, rig.Emma, is4k: true, created: rig.Arr.Now.UtcDateTime);
        await rig.Step(IntegrationNotificationsTestsDune);
        Assert.NotNull(rig.NotifyStore.Watch(rig.Emma.UserId, IntegrationNotificationsTestsDune, "m4k"));
        Assert.Single(rig.Inbox(rig.Emma), n => n.Kind == "ready");

        // The 4K copy arrives: told once, as 4K, with the 4K item.
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        var uhd = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(IntegrationNotificationsTestsDune)!, new JfCopy { ItemId = uhd, Path = "/media/movies4k/Dune Part Two (2024)/Dune.mkv", LibraryName = "Movies 4K", DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        await rig.Step(IntegrationNotificationsTestsDune);
        await rig.Step(IntegrationNotificationsTestsDune);
        var ready = rig.Inbox(rig.Emma).Where(n => n.Kind == "ready").ToList();
        Assert.Equal(new[] { uhd.ToString("N"), hd.ToString("N") }, ready.Select(n => n.ItemId).ToArray());
        Assert.Equal("4k", JsonSerializer.Deserialize<Dictionary<string, string>>(ready[0].Payload)!["variant"]);
    }

    [Fact]
    public async Task APartThatArrivedBeforeTheFirstLookAfterARestartIsStillTold()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var policy = new IntegrationRequestLedgerTests.Policy();
        var (_, requests, service) = JeMode(rig, policy);
        service.Begin();
        await service.TickAsync(default, force: true);
        // Severance is in Jellyfin with S1E1 (from before). Emma asks for Dune and for S1E2; Jellyfin stops before
        // the notifications looked at either ask.
        var series = Guid.NewGuid();
        rig.View.AddCopy(TitleKey.Parse(IntegrationNotificationsTestsSeverance)!, new JfCopy { ItemId = series, Path = "/tv/Severance", DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1, DateCreated = rig.Arr.Now.UtcDateTime.AddDays(-30) });
        Assert.True((await requests.CreateAsync(rig.Emma.UserId, new("emma-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default)).HttpStatus < 300);
        Assert.True((await requests.CreateAsync(rig.Emma.UserId, new("emma-e2", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } }), default)).HttpStatus < 300);
        service.Dispose();
        // While it is down, Dune and S1E2 arrive (and S1E3, not asked for).
        rig.Arr.Now = rig.Arr.Now.AddMinutes(30);
        var dune = rig.Arrive(IntegrationNotificationsTestsDune);
        var e2 = Guid.NewGuid();
        rig.View.AddEpisode(series, new JfEpisode { ItemId = e2, Season = 1, Episode = 2, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 3, DateCreated = rig.Arr.Now.UtcDateTime });
        rig.View.Rev++;
        // The first look after the start is told what arrived since the ask (what was there before stays untold).
        rig.Open();
        (_, _, service) = JeMode(rig, policy);
        using var after = service;
        after.Begin();
        await after.TickAsync(default, force: true);
        await after.EvaluateAsync(new[] { IntegrationNotificationsTestsDune, IntegrationNotificationsTestsSeverance }, null, default);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        after.FlushBatches(rig.Arr.Now);
        await after.TickAsync(default, force: true);
        await after.EvaluateAsync(new[] { IntegrationNotificationsTestsDune, IntegrationNotificationsTestsSeverance }, null, default);
        after.FlushBatches(rig.Arr.Now);
        var inbox = rig.Inbox(rig.Emma);
        Assert.Equal(dune.ToString("N"), Assert.Single(inbox, n => n.Kind == "ready").ItemId);
        var episodes = JsonSerializer.Deserialize<Dictionary<string, string>>(Assert.Single(inbox, n => n.Kind == "episodes").Payload)!;
        Assert.Equal(("single", "1", "2"), (episodes["mode"], episodes["season"], episodes["episode"]));
        // A title asked for while it was already there is still only remembered.
        Assert.True((await requests.CreateAsync(rig.Kid.UserId, new("kid-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default)).HttpStatus < 300);
        await after.TickAsync(default, force: true);
        await after.EvaluateAsync(new[] { IntegrationNotificationsTestsDune }, null, default);
        Assert.DoesNotContain(rig.Inbox(rig.Kid), n => n.Kind == "ready");
        Assert.NotNull(rig.NotifyStore.Watch(rig.Kid.UserId, IntegrationNotificationsTestsDune, "m"));
    }

    [Fact]
    public async Task ChangedTitlesGoesOnFromTheLastEntryItTookNotPastTitlesItLeftOut()
    {
        using var lab = new Lab();
        var start = lab.Ledger.ChangedTitles(null).Cursor;
        lab.Ledger.ChangedPage = 2;
        // Three titles changed since the last look; a read takes two entries at a time.
        foreach (var key in new[] { Matrix, Firefly, "movie:tmdb:604" })
        {
            await lab.Ask(lab.Emma, key.StartsWith("movie", StringComparison.Ordinal) ? new MutationInput { Key = key } : new MutationInput { Key = key, Scope = "seasons", Seasons = new[] { 1 } });
        }
        var seen = new List<string>();
        var cursor = start;
        for (var i = 0; i < 10; i++)
        {
            var (next, titles) = lab.Ledger.ChangedTitles(cursor);
            seen.AddRange(titles);
            if (next == cursor) break;
            cursor = next;
        }
        Assert.Equal(new[] { Matrix, Firefly, "movie:tmdb:604" }, seen.Distinct().ToArray());
        Assert.Equal(lab.Ledger.ChangedTitles(null).Cursor, cursor);
    }

    [Fact]
    public async Task ANoticeBatchReadBeforeARestoreLeavesTheRestoredNoticesForTheNextRound()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var policy = new IntegrationRequestLedgerTests.Policy();
        var (ledger, requests, plain) = JeMode(rig, policy);
        plain.Dispose();
        // Two of the Kid's asks are OK'd; the database is backed up; then the second is cancelled.
        var dune = await requests.CreateAsync(rig.Kid.UserId, new("kid-dune", new MutationInput { Key = IntegrationNotificationsTestsDune }), default);
        var sev = await requests.CreateAsync(rig.Kid.UserId, new("kid-sev", new MutationInput { Key = IntegrationNotificationsTestsSeverance, Scope = "seasons", Seasons = new[] { 1 } }), default);
        var restoring = false;
        byte[]? backup = null;
        using var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now, rig.Hub, rig.Bridge, ledger,
            titleMeta: (keys, viewer, ct) =>
            {
                // The administrator restores the backup while the first OK is being told.
                if (restoring) { restoring = false; rig.Db.ReplaceWith(backup!); }
                return Task.FromResult(new Dictionary<string, HubTitleMeta>());
            });
        await service.DeliverRequestNoticesAsync(rig.Arr.Now, default);
        Assert.Equal(200, (await requests.ApproveAsync(dune.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        Assert.Equal(200, (await requests.ApproveAsync(sev.RequestId!, rig.Admin.UserId, null, default)).HttpStatus);
        backup = rig.Db.Snapshot()!;
        Assert.True(requests.Close(sev.RequestId!, rig.Admin.UserId, null).HttpStatus < 300);
        restoring = true;
        await service.DeliverRequestNoticesAsync(rig.Arr.Now, default);
        Assert.False(restoring);
        // Nothing decided from the old data landed in the restored one: both OKs are told in the next round.
        Assert.Empty(rig.Inbox(rig.Kid));
        Assert.Equal(2, await service.DeliverRequestNoticesAsync(rig.Arr.Now, default));
        Assert.Equal(2, rig.Inbox(rig.Kid).Count(n => n.Kind == "approved"));
    }

    [Fact]
    public async Task ASeasonReadFromSeasonCountsBecauseItsEpisodeListFailedIsNeverFulfilled()
    {
        using var lab = new Lab();
        await lab.Warm();
        // Emma asks for season 2 (Sonarr doesn't monitor it in what was read) and it goes out.
        var s2 = await lab.Ask(lab.Emma, new MutationInput { Key = Firefly, Scope = "seasons", Seasons = new[] { 2 } });
        await lab.Outbox.TickAsync(default);
        Assert.Equal("sent", lab.Ledger.Find(s2)!.Status);
        // Sonarr now monitors season 2 (the library read from before still says it doesn't); Jellyfin has S2E1 from elsewhere.
        foreach (var e in lab.Sonarr.Episodes.Where(e => (int)e["seasonNumber"]! == 2)) e["monitored"] = true;
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 1, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        // Sonarr's episode list can't be read (its library can): the season counts alone say nothing is missing.
        lab.Sonarr.Before = (path, _) => path.Contains("/episode", StringComparison.Ordinal) ? throw new HttpRequestException("down") : Task.CompletedTask;
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
        Assert.Equal("sent", lab.Ledger.Find(s2)!.Status);
        // Read in full (Sonarr is back): E2 is missing, still open; when it is here, fulfilled.
        lab.Sonarr.Before = null;
        lab.Arr.Now = lab.Arr.Now.AddMinutes(10);
        Assert.Equal(0, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
        lab.View.AddEpisode(lab.SeriesItem, new JfEpisode { ItemId = Guid.NewGuid(), Season = 2, Episode = 2, DateCreated = lab.Arr.Now.UtcDateTime });
        lab.View.Rev++;
        Assert.Equal(1, await lab.Fulfilment.CheckAsync(new[] { Firefly }, default));
        Assert.Equal("fulfilled", lab.Ledger.Find(s2)!.Status);
    }

    [Fact]
    public async Task AnAbsentSeriesPageNeverOffersASeasonAlreadyAskedForInEitherMode()
    {
        using var lab = new Lab();
        // Andor: no Sonarr holds it; two aired seasons on its native series page.
        const string Andor = "tv:tvdb:393189";
        var now = lab.Arr.Now.UtcDateTime;
        var page = new AbsentTitle
        {
            PageId = Guid.NewGuid(), Kind = "series", Title = TitleKey.Parse(Andor)!, TmdbId = 83867,
            Seasons = new[] { new AbsentSeason(1, 12, 12, now.AddYears(-3), Guid.NewGuid()), new AbsentSeason(2, 12, 12, now.AddYears(-1), Guid.NewGuid()) },
        };
        async Task<(string Title, string Seasons)> Stages(StatusViewer viewer)
        {
            using var doc = JsonDocument.Parse((await lab.Status.ForAbsentAsync(viewer, page, default)).Json);
            var status = doc.RootElement.GetProperty("items")[0];
            return (status.GetProperty("stage").GetString()!, string.Join(",", status.GetProperty("seasons").EnumerateArray().Select(x => x.GetProperty("stage").GetString())));
        }

        // Jellyfin Enhanced mode: the Kid asks for season 1 and it waits for an OK. Reopened, the page reads
        // season 1 as asked (not offered again) and season 2 as not here (the next one to get).
        await lab.Ask(lab.Kid, new MutationInput { Key = Andor, Scope = "seasons", Seasons = new[] { 1 } });
        Assert.Equal(("asked", "asked,notHere"), await Stages(lab.Kid));
        Assert.Equal("asked,notHere", (await Stages(lab.Emma)).Seasons);

        // Seerr mode: Seerr's requests are the authority; Emma's season 2 there waits for an OK.
        lab.Config.ArrRequestBackend = "seerr";
        lab.Config.JellyseerrEnabled = true;
        lab.Config.JellyseerrUrls = FakeSeerr.Url;
        lab.Config.JellyseerrApiKey = FakeSeerr.Key;
        lab.Seerr.Requests.Add(FakeSeerr.Request(41, "tv", 83867, 1, lab.Emma.UserId, now.AddHours(-1), tvdb: 393189, seasons: new[] { 2 }));
        Assert.True(await lab.Model.RefreshAsync(default));
        Assert.Equal(("asked", "notHere,asked"), await Stages(lab.Emma));
    }

    private const string IntegrationNotificationsTestsDune = "movie:tmdb:693134";
    private const string IntegrationNotificationsTestsSeverance = "tv:tvdb:371980";
}
