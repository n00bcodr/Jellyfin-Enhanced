using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// The hub's household views over the request ledger: approval cards (Manager shape: names, role,
/// quota use, a limited requester's rating line, "also wanted by", the size estimate; never an
/// instance, profile or path), the caller's own requests, the chip bar's counts and the Household
/// tab (Managers read the people who share a library with them; administrators read everyone and
/// save roles, presets and quotas with every input validated). API keys and unknown users are no
/// person on any of them.
/// </summary>
public class IntegrationRequestHouseholdTests
{
    internal sealed class FakeDirectory : IHouseholdDirectory
    {
        public Dictionary<Guid, HouseholdPerson> People { get; } = new();
        public Dictionary<Guid, HouseholdItem> Items { get; } = new();
        public List<Guid> All { get; } = new() { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };
        IReadOnlyList<HouseholdPerson> IHouseholdDirectory.People() => People.Values.ToList();
        public HouseholdPerson? Person(Guid userId) => People.GetValueOrDefault(userId);
        public IReadOnlyCollection<Guid> Libraries() => All;
        public HouseholdItem? Item(Guid itemId) => Items.GetValueOrDefault(itemId);
    }

    /// <summary>Place facts the test sets per instance and title.</summary>
    internal sealed class FakePlaces : IRequestPlaces
    {
        public Dictionary<string, RequestPlace> Places { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, string> FourK { get; } = new(StringComparer.Ordinal);
        public List<(string Instance, string? Root)> Asked { get; } = new();
        public Task<RequestPlace?> PlaceAsync(string instanceId, string? rootFolder, string titleKey, CancellationToken ct)
        {
            Asked.Add((instanceId, rootFolder));
            return Task.FromResult(Places.GetValueOrDefault(instanceId));
        }
        public string? FourKHolder(string titleKey) => FourK.GetValueOrDefault(titleKey);
    }

    private sealed class Hub : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public FakePlaces Places { get; } = new();
        public FakeDirectory Directory { get; } = new();
        public Dictionary<int, HubTitleMeta?> Tmdb { get; } = new();
        public List<(string Media, int Id)> TmdbCalls { get; } = new();
        public Dictionary<string, int> Found { get; } = new();
        public List<string> FindCalls { get; } = new();
        public int Saves { get; private set; }
        public RequestHubProjection Projection { get; }
        public HouseholdService Household { get; }

        public Hub()
        {
            Projection = new RequestHubProjection(R.Service, Directory, null, (media, id, ct) =>
            {
                lock (TmdbCalls) TmdbCalls.Add((media, id));
                if (!Tmdb.TryGetValue(id, out var meta)) throw new HttpRequestException("TMDB unavailable");
                return Task.FromResult(meta);
            }, () => R.Now, Places, tmdbIdOf: (title, ct) =>
            {
                lock (FindCalls) FindCalls.Add(title.ToString());
                return Task.FromResult(Found.TryGetValue(title.ToString(), out var id) ? (int?)id : null);
            });
            Household = new HouseholdService(Projection, R.Feed, _ => Saves++);
            Name(R.Member, "Emma");
            Name(R.Kid, "Leo");
            Name(R.Manager, "Mum");
            Name(R.Admin, "Jake", admin: true);
        }

        public void Name(Guid id, string name, bool admin = false, IReadOnlyCollection<Guid>? libraries = null, bool parental = false, bool disabled = false)
            => Directory.People[id] = new HouseholdPerson { Id = id, Name = name, IsAdmin = admin, Libraries = libraries, HasParentalLimit = parental, Disabled = disabled };

        public void Limited(Guid id)
        {
            var viewer = R.View.Users[id];
            R.View.Users[id] = new StatusViewer { UserId = id, IsAdmin = viewer.IsAdmin, PolicyRevision = viewer.PolicyRevision + "L", HasParentalLimit = true, Handle = viewer.Handle };
        }

        public AcquireHouseholdController Controller(ClaimsPrincipal principal)
        {
            var controller = new AcquireHouseholdController(Projection, Household) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal;
            return controller;
        }

        public AcquireHouseholdController As(Guid user) => Controller(TestCallers.Principal(user, user == R.Admin));

        public void Dispose() => R.Dispose();
    }

    private static JsonElement Json(IActionResult result)
    {
        var file = Assert.IsType<FileContentResult>(result);
        return JsonDocument.Parse(file.FileContents).RootElement.Clone();
    }

    private static string Raw(IActionResult result) => System.Text.Encoding.UTF8.GetString(Assert.IsType<FileContentResult>(result).FileContents);

    private static RequestOutcome Refusal(IActionResult result, int status)
    {
        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(status, obj.StatusCode);
        return Assert.IsType<RequestOutcome>(obj.Value);
    }

    private static readonly TitleKey ToyStory = TitleKey.Parse("movie:tmdb:603")!;

    [Fact]
    public async Task ApprovalCardsCarryTheManagerShapeAndNeverAnInstanceProfileOrPath()
    {
        using var h = new Hub();
        var r = h.R;
        h.Limited(r.Kid);
        var sister = r.Add("Kid");
        h.Name(sister, "Mia");
        var item = Guid.NewGuid();
        r.View.AddCopy(ToyStory, new JfCopy { ItemId = item, Path = "/media/movies/Toy Story 5", LibraryName = "Movies" });
        h.Directory.Items[item] = new HouseholdItem("Toy Story 5", 2026, "G");
        var leo = await r.Create(r.Kid);
        await r.Create(sister);
        Assert.Equal("pending", r.Ledger.Find(leo.RequestId!)!.Status);

        var answer = await h.As(r.Manager).Approvals(default);
        var raw = Raw(answer);
        var card = Json(answer).GetProperty("items").EnumerateArray().First(i => i.GetProperty("id").GetString() == leo.RequestId);
        Assert.Equal("Toy Story 5", card.GetProperty("title").GetString());
        Assert.Equal(2026, card.GetProperty("year").GetInt32());
        Assert.Equal(item.ToString("N"), card.GetProperty("itemId").GetString());
        Assert.Equal("movie", card.GetProperty("scope").GetString());
        Assert.Equal("Leo", card.GetProperty("requester").GetProperty("name").GetString());
        Assert.Equal("kid", card.GetProperty("requester").GetProperty("role").GetString());
        Assert.Equal(7, card.GetProperty("requester").GetProperty("quota").GetProperty("limit").GetInt32());
        Assert.Equal("G", card.GetProperty("rating").GetProperty("label").GetString());
        Assert.True(card.GetProperty("rating").GetProperty("within").GetBoolean());
        Assert.Equal(new[] { "Mia" }, card.GetProperty("alsoWanted").EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal(8, card.GetProperty("estimateGb").GetDouble());
        Assert.True(card.GetProperty("canApprove").GetBoolean());
        Assert.False(card.GetProperty("stuck").GetBoolean());
        Assert.False(card.GetProperty("okd").GetBoolean());   // still waiting for an OK
        // Mia has no parental limit: no rating line on her card. Nothing about where it would land.
        var mia = Json(answer).GetProperty("items").EnumerateArray().First(i => i.GetProperty("id").GetString() != leo.RequestId);
        Assert.False(mia.TryGetProperty("rating", out _));
        foreach (var banned in new[] { "\"instanceId\"", "\"rootFolder\"", "\"profileId\"", "\"path\"", "/media/", "Movies", "\"admin\"", "\"jobs\"" })
            Assert.DoesNotContain(banned, raw, StringComparison.Ordinal);

        // The administrator also gets the reason code and the jobs; the Jellyfin item id is theirs too.
        var admin = Json(await h.As(r.Admin).Approvals(default)).GetProperty("items").EnumerateArray().First(i => i.GetProperty("id").GetString() == leo.RequestId);
        Assert.Equal("awaiting_approval", admin.GetProperty("admin").GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Array, admin.GetProperty("admin").GetProperty("jobs").ValueKind);
    }

    [Fact]
    public async Task ApprovalCardsSayWhereTheTitleWouldLandAndWhetherA4kCopyIsHere()
    {
        using var h = new Hub();
        var r = h.R;
        var leo = await r.Create(r.Kid);
        var instance = r.Ledger.Find(leo.RequestId!)!;
        // The requester's routing picks the instance; its drive's free space and library name are shown.
        var routed = r.Policy.Evaluate(r.Kid, instance.Input).InstanceId;
        h.Places.Places[routed] = new RequestPlace("Movies", 1_234_000_000_000);
        h.Places.FourK["movie:tmdb:603"] = "Radarr 4K";

        var manager = Raw(await h.As(r.Manager).Approvals(default));
        var card = JsonDocument.Parse(manager).RootElement.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetString() == leo.RequestId);
        Assert.Equal("Movies", card.GetProperty("space").GetProperty("library").GetString());
        Assert.Equal(1234, card.GetProperty("space").GetProperty("freeGb").GetDouble());
        Assert.True(card.GetProperty("already4k").GetBoolean());
        // Managers: "Already in 4K", never the instance's name; no path either way.
        Assert.False(card.TryGetProperty("already4kIn", out _));
        Assert.DoesNotContain("Radarr 4K", manager, StringComparison.Ordinal);
        Assert.Contains(h.Places.Asked, a => a.Instance == routed && a.Root == null);

        var admin = JsonDocument.Parse(Raw(await h.As(r.Admin).Approvals(default))).RootElement.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetString() == leo.RequestId);
        Assert.Equal("Radarr 4K", admin.GetProperty("already4kIn").GetString());

        // Nothing known: no space line, no 4K hint.
        h.Places.Places.Clear();
        h.Places.FourK.Clear();
        var plain = Json(await h.As(r.Manager).Approvals(default)).GetProperty("items").EnumerateArray().Single(i => i.GetProperty("id").GetString() == leo.RequestId);
        Assert.False(plain.TryGetProperty("space", out _));
        Assert.False(plain.TryGetProperty("already4k", out _));
    }

    [Fact]
    public async Task ASeriesNoSonarrHoldsYetIsNamedOnItsCardThroughTmdbsFindByItsTvdbId()
    {
        using var h = new Hub();
        var r = h.R;
        // Asked for from its own page: the ask names the series by its TVDB id, and nothing else names its TMDB id yet.
        var cheers = await r.Create(r.Kid, new MutationInput { Key = "tv:tvdb:77623", Scope = "seasons", Seasons = new[] { 1, 2 } });
        var unknown = await r.Create(r.Kid, new MutationInput { Key = "tv:tvdb:999999", Scope = "seasons", Seasons = new[] { 1 } });
        h.Found["tv:tvdb:77623"] = 141;
        h.Tmdb[141] = new HubTitleMeta { Title = "Cheers", Year = 1982, Poster = "/cheers.jpg" };
        var items = Json(await h.As(r.Admin).Approvals(default)).GetProperty("items").EnumerateArray().ToList();
        var card = items.First(i => i.GetProperty("id").GetString() == cheers.RequestId);
        Assert.Equal("Cheers", card.GetProperty("title").GetString());
        Assert.Equal("/cheers.jpg", card.GetProperty("poster").GetString());
        // TMDB doesn't know it: no title, and no details read for a guessed id.
        var nameless = items.First(i => i.GetProperty("id").GetString() == unknown.RequestId);
        Assert.False(nameless.TryGetProperty("title", out var title) && title.ValueKind == System.Text.Json.JsonValueKind.String);
        Assert.Contains("tv:tvdb:999999", h.FindCalls);
        Assert.Equal(new[] { 141 }, h.TmdbCalls.Select(c => c.Id).Distinct().ToArray());
        // TMDB's find answer: the first id of the kind asked for.
        Assert.Equal(141, RequestHubProjection.FoundTmdbId("{\"movie_results\":[{\"id\":5}],\"tv_results\":[{\"id\":141},{\"id\":7}]}", movie: false));
        Assert.Equal(5, RequestHubProjection.FoundTmdbId("{\"movie_results\":[{\"id\":5}],\"tv_results\":[]}", movie: true));
        Assert.Null(RequestHubProjection.FoundTmdbId("{\"tv_results\":[]}", movie: false));
        Assert.Null(RequestHubProjection.FoundTmdbId("not json", movie: false));
    }

    [Fact]
    public async Task ApprovalsAreOnlyForManagersAndAdminsAndOnlyForTitlesTheyCanSee()
    {
        using var h = new Hub();
        var r = h.R;
        var hidden = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(604));
        var shown = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(605));
        r.Policy.Adjust = (user, input, facts) => user == r.Manager && input.Key == "movie:tmdb:604" ? facts with { Visible = false } : facts;
        h.Tmdb[605] = new HubTitleMeta { Title = "Inside Out 3", Year = 2027, Poster = "/io3.jpg", Rating = "PG" };
        h.Tmdb[604] = new HubTitleMeta { Title = "Secret", Poster = "/../../etc/passwd" };

        var manager = Json(await h.As(r.Manager).Approvals(default)).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(new[] { shown.RequestId }, manager.Select(i => i.GetProperty("id").GetString()).ToArray());
        Assert.Equal("Inside Out 3", manager[0].GetProperty("title").GetString());
        Assert.Equal("/io3.jpg", manager[0].GetProperty("poster").GetString());
        Assert.DoesNotContain(h.TmdbCalls, c => c.Id == 604);       // nothing is looked up for a title the caller can't see

        // The administrator sees both; a poster path that isn't a plain TMDB path is dropped.
        var admin = Json(await h.As(r.Admin).Approvals(default)).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, admin.Count);
        var secret = admin.First(i => i.GetProperty("id").GetString() == hidden.RequestId);
        Assert.Equal("Secret", secret.GetProperty("title").GetString());
        Assert.False(secret.TryGetProperty("poster", out _));

        Assert.Equal("requests_approve_required", Refusal(await h.As(r.Member).Approvals(default), 403).Reason);
        Assert.Equal("requests_approve_required", Refusal(await h.As(r.Kid).Approvals(default), 403).Reason);
        Assert.Equal("user_required", Refusal(await h.Controller(TestCallers.ApiKey()).Approvals(default), 403).Reason);
        Assert.Equal("user_required", Refusal(await h.Controller(TestCallers.Unknown()).Approvals(default), 403).Reason);
    }

    [Fact]
    public async Task ATmdbFailureLeavesTheCardWithoutTitleDataAndTheListStillAnswers()
    {
        using var h = new Hub();
        var r = h.R;
        var ask = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(777));
        var card = Json(await h.As(r.Manager).Approvals(default)).GetProperty("items").EnumerateArray().Single();
        Assert.Equal(ask.RequestId, card.GetProperty("id").GetString());
        Assert.False(card.TryGetProperty("title", out _));
        Assert.Contains(h.TmdbCalls, c => c is ("movie", 777));
    }

    [Fact]
    public void TmdbDetailsAndCertificationsAreReadForTheServersCountry()
    {
        var movie = RequestHubProjection.ParseTmdb("movie", "{\"title\":\"Toy Story 5\",\"release_date\":\"2026-06-19\",\"poster_path\":\"/ts5.jpg\"}",
            "{\"results\":[{\"iso_3166_1\":\"GB\",\"release_dates\":[{\"certification\":\"U\"}]},{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"\"},{\"certification\":\"G\"}]}]}", "US")!;
        Assert.Equal(("Toy Story 5", (int?)2026, "/ts5.jpg", "G"), (movie.Title, movie.Year, movie.Poster, movie.Rating));
        var show = RequestHubProjection.ParseTmdb("tv", "{\"name\":\"Andor\",\"first_air_date\":\"2022-09-21\",\"poster_path\":\"bad path\"}",
            "{\"results\":[{\"iso_3166_1\":\"GB\",\"rating\":\"12\"}]}", "GB")!;
        Assert.Equal(("Andor", (int?)2022, (string?)null, "12"), (show.Title, show.Year, show.Poster, show.Rating));
        Assert.Null(RequestHubProjection.ParseTmdb("movie", "not json", null, "US"));
    }

    [Fact]
    public async Task TheChipBarCountsWaitingAndStuckRequestsTheCallerCanSee()
    {
        using var h = new Hub();
        var r = h.R;
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(701));
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(702));
        var held = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(703));
        var parked = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(704));
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(705));
        r.Ledger.Database.Write((c, t) =>
        {
            RequestLedger.Exec(c, t, "UPDATE wants SET reason='authorization_changed' WHERE id=$id", ("$id", held.RequestId));
            RequestLedger.Exec(c, t, "INSERT INTO jobs(id,want_id,action,instance_id,connection_generation,mutation_input,idempotency_key,fingerprint,authorization_context,state,next_attempt,reason,created_at,updated_at) VALUES('j1',$w,'request','r1','g1','{}','k1','f1','{}','parked',0,'instance_changed',0,0)", ("$w", parked.RequestId));
            return 0;
        });
        r.Policy.Adjust = (user, input, facts) => user == r.Manager && input.Key == "movie:tmdb:705" ? facts with { Visible = false } : facts;

        var counts = Json(h.As(r.Manager).Attention());
        Assert.Equal(2, counts.GetProperty("needOk").GetInt32());
        Assert.Equal(2, counts.GetProperty("stuck").GetInt32());
        Assert.Equal(3, Json(h.As(r.Admin).Attention()).GetProperty("needOk").GetInt32());
        Assert.Equal("requests_approve_required", Refusal(h.As(r.Member).Attention(), 403).Reason);
        Assert.Equal("user_required", Refusal(h.Controller(TestCallers.ApiKey()).Attention(), 403).Reason);
        Assert.Equal("user_required", Refusal(h.Controller(TestCallers.Unknown()).Attention(), 403).Reason);

        // Private, with an ETag the browser can revalidate; the same answer is a 304.
        var controller = h.As(r.Manager);
        controller.Attention();
        var etag = controller.Response.Headers.ETag.ToString();
        Assert.Equal("private, no-cache", controller.Response.Headers.CacheControl.ToString());
        var again = h.As(r.Manager);
        again.HttpContext.Request.Headers.IfNoneMatch = etag;
        Assert.Equal(304, Assert.IsType<StatusCodeResult>(again.Attention()).StatusCode);
        // Another approver never shares the body's validator.
        var admin = h.As(r.Admin);
        admin.Attention();
        Assert.NotEqual(etag, admin.Response.Headers.ETag.ToString());

        // Nothing at all while the feature is off.
        r.Policy.Configuration.ArrPhase3Enabled = false;
        Assert.Equal("feature_disabled", Refusal(h.As(r.Manager).Attention(), 403).Reason);
    }

    [Fact]
    public async Task MyRequestsListOwnWantsWithGroupsDeclineReasonsAndWhatCanStillBeCancelled()
    {
        using var h = new Hub();
        var r = h.R;
        h.Tmdb[801] = new HubTitleMeta { Title = "Waiting", Poster = "/w.jpg" };
        var waiting = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(801));
        var declined = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(802));
        var cancelled = await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(803));
        await r.Create(r.Member, IntegrationRequestLedgerTests.Movie(804));
        Assert.Equal(200, (await r.Service.DeclineAsync(declined.RequestId!, r.Manager, "Not for kids", default)).HttpStatus);
        Assert.Equal(200, r.Service.Close(cancelled.RequestId!, r.Kid, null).HttpStatus);

        var items = Json(await h.As(r.Kid).Mine(default)).GetProperty("items").EnumerateArray().ToDictionary(i => i.GetProperty("id").GetString()!);
        Assert.Equal(3, items.Count);
        Assert.Equal("needsOk", items[waiting.RequestId!].GetProperty("group").GetString());
        Assert.True(items[waiting.RequestId!].GetProperty("canCancel").GetBoolean());
        Assert.Equal("Waiting", items[waiting.RequestId!].GetProperty("title").GetString());
        Assert.Equal("declined", items[declined.RequestId!].GetProperty("group").GetString());
        Assert.Equal("Not for kids", items[declined.RequestId!].GetProperty("declineReason").GetString());
        Assert.False(items[declined.RequestId!].GetProperty("canCancel").GetBoolean());
        Assert.Equal("cancelled", items[cancelled.RequestId!].GetProperty("group").GetString());

        // The member's queued ask is on its way and can still be cancelled until it is sent.
        var member = Json(await h.As(r.Member).Mine(default)).GetProperty("items").EnumerateArray().Single();
        Assert.Equal("onTheWay", member.GetProperty("group").GetString());
        Assert.True(member.GetProperty("canCancel").GetBoolean());
        await r.Runner().TickAsync(default);
        member = Json(await h.As(r.Member).Mine(default)).GetProperty("items").EnumerateArray().Single();
        Assert.Equal("sent", member.GetProperty("status").GetString());
        Assert.False(member.GetProperty("canCancel").GetBoolean());

        // Watchers have a (possibly empty) list too; nobody else's names or requests are in it.
        var watcher = r.Add("Watcher");
        Assert.Empty(Json(await h.As(watcher).Mine(default)).GetProperty("items").EnumerateArray());
        Assert.DoesNotContain("Emma", Raw(await h.As(r.Kid).Mine(default)), StringComparison.Ordinal);
        Assert.Equal("user_required", Refusal(await h.Controller(TestCallers.ApiKey()).Mine(default), 403).Reason);
    }

    [Fact]
    public async Task ManagersSeeThePeopleSharingALibraryAndAdminsSeeEveryoneWithTheSettings()
    {
        using var h = new Hub();
        var r = h.R;
        // Jake (an administrator) can open every library, so he shares one with everybody.
        var kids = h.Directory.All[0];
        var grownUps = h.Directory.All[1];
        h.Name(r.Manager, "Mum", libraries: new[] { kids });
        h.Name(r.Kid, "Leo", libraries: new[] { kids }, parental: true);
        h.Name(r.Member, "Emma", libraries: new[] { grownUps });
        var gone = r.Add("Member");
        h.Name(gone, "Old account", disabled: true);
        r.Policy.Configuration.ArrRequestUsers = "{\"" + r.Kid.ToString("D") + "\":{\"Role\":\"Kid\",\"QuotaLimit\":3,\"FourKInstances\":[\"r4k\"]}}";
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(901));
        h.Tmdb[901] = new HubTitleMeta { Title = "Bluey" };

        var manager = Json(await h.As(r.Manager).Household(default));
        Assert.False(manager.GetProperty("canEdit").GetBoolean());
        Assert.False(manager.TryGetProperty("settings", out _));
        var people = manager.GetProperty("people").EnumerateArray().ToList();
        Assert.Equal(new[] { "Jake", "Leo", "Mum" }, people.Select(p => p.GetProperty("name").GetString()).ToArray());
        var leo = people.First(p => p.GetProperty("name").GetString() == "Leo");
        Assert.Equal("kid", leo.GetProperty("role").GetString());
        Assert.Equal(1, leo.GetProperty("active").GetInt32());
        Assert.Equal(1, leo.GetProperty("waiting").GetInt32());
        Assert.Equal("Bluey", leo.GetProperty("requests")[0].GetProperty("title").GetString());
        Assert.False(leo.TryGetProperty("admin", out _));
        Assert.True(people.Single(p => p.GetProperty("name").GetString() == "Mum").GetProperty("you").GetBoolean());

        var admin = Json(await h.As(r.Admin).Household(default));
        Assert.True(admin.GetProperty("canEdit").GetBoolean());
        var everyone = admin.GetProperty("people").EnumerateArray().ToList();
        Assert.Equal(new[] { "Emma", "Jake", "Leo", "Mum" }, everyone.Select(p => p.GetProperty("name").GetString()).ToArray());
        var leoAdmin = everyone.First(p => p.GetProperty("name").GetString() == "Leo").GetProperty("admin");
        Assert.Equal("kid", leoAdmin.GetProperty("roleOverride").GetString());
        Assert.Equal(3, leoAdmin.GetProperty("quotaOverride").GetInt32());
        Assert.True(leoAdmin.GetProperty("parentalLimit").GetBoolean());
        Assert.True(everyone.First(p => p.GetProperty("name").GetString() == "Jake").GetProperty("admin").GetProperty("fourK").GetBoolean());
        var settings = admin.GetProperty("settings");
        Assert.Equal("ask_first", settings.GetProperty("preset").GetString());
        Assert.Equal("member", settings.GetProperty("defaultRole").GetString());
        Assert.Equal("je", settings.GetProperty("backend").GetString());

        Assert.Equal("requests_approve_required", Refusal(await h.As(r.Member).Household(default), 403).Reason);
        Assert.Equal("requests_approve_required", Refusal(await h.As(r.Kid).Household(default), 403).Reason);
        Assert.Equal("user_required", Refusal(await h.Controller(TestCallers.ApiKey()).Household(default), 403).Reason);
        Assert.Equal("user_required", Refusal(await h.Controller(TestCallers.Unknown()).Household(default), 403).Reason);
    }

    [Fact]
    public async Task APersonsAsksForDifferentSeasonsOfOneTitleStayRowsOfTheirOwn()
    {
        using var h = new Hub();
        var r = h.R;
        // Leo (a Kid) asks for season 1, then season 2 of the same series: two asks for different parts, both waiting.
        var first = await r.Create(r.Kid, IntegrationRequestLedgerTests.Seasons(1));
        var second = await r.Create(r.Kid, IntegrationRequestLedgerTests.Seasons(2));
        await r.Create(r.Kid, IntegrationRequestLedgerTests.Movie(901));
        Assert.Equal(("pending", "pending"), (r.Ledger.Find(first.RequestId!)!.Status, r.Ledger.Find(second.RequestId!)!.Status));

        var leo = Json(await h.As(r.Admin).Household(default)).GetProperty("people").EnumerateArray().First(p => p.GetProperty("name").GetString() == "Leo");
        Assert.Equal((3, 3), (leo.GetProperty("active").GetInt32(), leo.GetProperty("waiting").GetInt32()));
        var series = leo.GetProperty("requests").EnumerateArray().Where(q => q.GetProperty("key").GetString() == "tv:tvdb:78874")
            .Select(q => q.GetProperty("seasons").EnumerateArray().Single().GetInt32()).OrderBy(n => n).ToArray();
        Assert.Equal(new[] { 1, 2 }, series);

        // Approving one: the other still waits, and each row cancels only its own request.
        await r.Service.ApproveAsync(first.RequestId!, r.Admin, null, CancellationToken.None);
        var mine = Json(await h.As(r.Kid).Mine(default)).GetProperty("items").EnumerateArray().Where(q => q.GetProperty("key").GetString() == "tv:tvdb:78874").ToArray();
        Assert.Equal(2, mine.Length);
        var waiting = mine.Single(q => q.GetProperty("id").GetString() == second.RequestId);
        Assert.Equal("pending", waiting.GetProperty("status").GetString());
        Assert.Equal(new[] { second.RequestId }, waiting.GetProperty("cancelIds").EnumerateArray().Select(e => e.GetString()).ToArray());
    }

    [Fact]
    public async Task AManagerSeesOnlyThePartsOfAMergedTitleTheyCanSee()
    {
        using var h = new Hub();
        var r = h.R;
        // Mum (a Manager) may not see season 2 of the series; Jake (an administrator) sees all of it.
        r.Policy.Adjust = (user, input, facts) => user == r.Manager && input.Key == "tv:tvdb:78874" && input.Seasons.Contains(2) ? facts with { Visible = false } : facts;
        // Leo's waiting ask for season 1, and seasons 1 and 2 already sent (the Seerr request it was linked to when
        // requests moved): one merged row, led by the waiting season 1.
        var first = await r.Create(r.Kid, IntegrationRequestLedgerTests.Seasons(1));
        r.Now = r.Now.AddMinutes(1);
        var both = await r.Create(r.Kid, IntegrationRequestLedgerTests.Seasons(1, 2));
        r.Db.Write((c, t) => { using var cmd = RequestLedger.Cmd(c, t, "UPDATE wants SET status='sent',reason='looking' WHERE id=$w", ("$w", both.RequestId)); return cmd.ExecuteNonQuery(); });
        Assert.Equal(("pending", "sent"), (r.Ledger.Find(first.RequestId!)!.Status, r.Ledger.Find(both.RequestId!)!.Status));

        static JsonElement Leo(JsonElement body) => body.GetProperty("people").EnumerateArray().First(p => p.GetProperty("name").GetString() == "Leo");
        static int[] Seasons(JsonElement row) => row.GetProperty("seasons").EnumerateArray().Select(s => s.GetInt32()).ToArray();
        var admin = Assert.Single(Leo(Json(await h.As(r.Admin).Household(default))).GetProperty("requests").EnumerateArray());
        Assert.Equal(new[] { 1, 2 }, Seasons(admin));

        // Mum gets the waiting season 1 only: no season 2, and nothing taken from the sent request she can't see.
        var leo = Leo(Json(await h.As(r.Manager).Household(default)));
        var row = Assert.Single(leo.GetProperty("requests").EnumerateArray());
        Assert.Equal((first.RequestId, "pending"), (row.GetProperty("id").GetString(), row.GetProperty("status").GetString()));
        Assert.Equal(new[] { 1 }, Seasons(row));
        Assert.Equal("seasons", row.GetProperty("scope").GetString());

        // When only the sent seasons 1 and 2 are left, Mum sees none of the title.
        Assert.Equal(200, r.Service.Close(first.RequestId!, r.Kid, null).HttpStatus);
        Assert.Empty(Leo(Json(await h.As(r.Manager).Household(default))).GetProperty("requests").EnumerateArray());
        Assert.Equal(new[] { 1, 2 }, Seasons(Assert.Single(Leo(Json(await h.As(r.Admin).Household(default))).GetProperty("requests").EnumerateArray())));
    }

    [Fact]
    public async Task AManagerSeesNoEpisodeOfAMergedTitleTheyCannotSee()
    {
        using var h = new Hub();
        var r = h.R;
        // Mum (a Manager) may not see anything of season 2.
        r.Policy.Adjust = (user, input, facts) => user == r.Manager && (input.Seasons.Contains(2) || input.Episodes.Any(e => e.Season == 2)) ? facts with { Visible = false } : facts;
        // Leo asks for episode 1 of seasons 1 and 2, later for all of season 1: both wait, and the newer ask leads.
        await r.Create(r.Kid, new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 1), new RequestEpisode(2, 1) } });
        r.Now = r.Now.AddMinutes(1);
        var season = await r.Create(r.Kid, IntegrationRequestLedgerTests.Seasons(1));
        Assert.Equal("pending", r.Ledger.Find(season.RequestId!)!.Status);

        static JsonElement Row(JsonElement body) => Assert.Single(body.GetProperty("people").EnumerateArray().First(p => p.GetProperty("name").GetString() == "Leo").GetProperty("requests").EnumerateArray());
        static string Parts(JsonElement row) => string.Join(",", row.GetProperty("seasons").EnumerateArray().Select(s => "S" + s.GetInt32()))
            + "|" + string.Join(",", row.GetProperty("episodes").EnumerateArray().Select(e => "S" + e.GetProperty("season").GetInt32() + "E" + e.GetProperty("episode").GetInt32()));
        Assert.Equal("S1|S2E1", Parts(Row(Json(await h.As(r.Admin).Household(default)))));
        var manager = Row(Json(await h.As(r.Manager).Household(default)));
        Assert.Equal(season.RequestId, manager.GetProperty("id").GetString());
        Assert.Equal("S1|", Parts(manager));
    }

    [Fact]
    public void OnlyAdministratorsSaveTheHouseholdAndEveryInputIsCheckedBeforeAnythingIsWritten()
    {
        using var h = new Hub();
        var r = h.R;
        var config = r.Policy.Configuration;
        config.ArrRequestUsers = "{\"" + r.Kid.ToString("D") + "\":{\"Role\":\"Kid\",\"FourKInstances\":[\"r4k\"],\"QuotaGb\":50}}";
        config.ArrRequestRoles = "{\"Member\":{\"QuotaGb\":20}}";
        var before = JsonSerializer.Serialize(config);
        var feed = r.Feed.Revision(ArrTitleKey.RequestsState);

        HouseholdSave Body(string json) => JsonSerializer.Deserialize<HouseholdSave>(json)!;
        void Refused(Guid caller, string json, string reason, int status = 400)
        {
            var outcome = Refusal(h.As(caller).SaveHousehold(Body(json)), status);
            Assert.Equal(reason, outcome.Reason);
            Assert.Equal("denied", outcome.Outcome);
        }
        Refused(r.Manager, "{\"preset\":\"open_house\"}", "admin_required", 403);
        Refused(r.Member, "{\"preset\":\"open_house\"}", "requests_approve_required", 403);
        Assert.Equal("user_required", Refusal(h.Controller(TestCallers.ApiKey()).SaveHousehold(Body("{\"preset\":\"open_house\"}")), 403).Reason);
        Assert.Equal("user_required", Refusal(h.Controller(TestCallers.Unknown()).SaveHousehold(Body("{\"preset\":\"open_house\"}")), 403).Reason);
        Refused(r.Admin, "{\"preset\":\"anything_goes\"}", "invalid_preset");
        Refused(r.Admin, "{\"defaultRole\":\"Admin\"}", "admin_role_refused");
        Refused(r.Admin, "{\"defaultRole\":\"Overlord\"}", "invalid_role");
        Refused(r.Admin, "{\"quotaLimit\":-5}", "invalid_quota");
        Refused(r.Admin, "{\"roles\":{\"Admin\":{\"quotaLimit\":3}}}", "admin_role_refused");
        Refused(r.Admin, "{\"roles\":{\"Kid\":{\"quotaLimit\":20000}}}", "invalid_quota");
        Refused(r.Admin, "{\"users\":{\"" + Guid.NewGuid().ToString("N") + "\":{\"role\":\"Member\"}}}", "unknown_user");
        Refused(r.Admin, "{\"users\":{\"not-a-guid\":{\"role\":\"Member\"}}}", "invalid_user");
        Refused(r.Admin, "{\"users\":{\"" + r.Member.ToString("N") + "\":{\"role\":\"Admin\"}}}", "admin_role_refused");
        // A valid part next to an invalid one changes nothing either.
        Refused(r.Admin, "{\"preset\":\"open_house\",\"users\":{\"" + r.Member.ToString("N") + "\":{\"role\":\"Admin\"}}}", "admin_role_refused");
        Assert.Equal(before, JsonSerializer.Serialize(config));
        Assert.Equal(0, h.Saves);
        Assert.Equal(feed, r.Feed.Revision(ArrTitleKey.RequestsState));
        Assert.Equal(400, Refusal(h.As(r.Admin).SaveHousehold(null), 400).HttpStatus);

        var saved = h.As(r.Admin).SaveHousehold(Body("{\"preset\":\"approve_everything\",\"defaultRole\":\"kid\",\"quotaLimit\":-1,"
            + "\"roles\":{\"member\":{\"quotaLimit\":4},\"Kid\":{\"quotaLimit\":null}},"
            + "\"users\":{\"" + r.Kid.ToString("D") + "\":{\"role\":\"member\",\"quotaLimit\":2},\"" + r.Member.ToString("N") + "\":{\"role\":\"Manager\"}}}"));
        var ok = Assert.IsType<ObjectResult>(saved);
        Assert.Equal(200, ok.StatusCode);
        Assert.Equal("saved", Assert.IsType<RequestOutcome>(ok.Value).Reason);
        Assert.Equal(1, h.Saves);
        Assert.True(r.Feed.Revision(ArrTitleKey.RequestsState) > feed);
        Assert.Equal("approve_everything", config.ArrRequestPreset);
        Assert.Equal("Kid", config.ArrRequestDefaultRole);
        Assert.Equal(-1, config.ArrRequestQuotaLimit);
        var users = JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(config.ArrRequestUsers)!;
        Assert.Equal(2, users.Count);
        var kid = users[r.Kid.ToString("N")];
        Assert.Equal(("Member", (int?)2, (double?)50.0), (kid.Role, kid.QuotaLimit, kid.QuotaGb));
        Assert.Equal(new[] { "r4k" }, kid.FourKInstances);       // the other parts of an override are kept
        Assert.Equal("Manager", users[r.Member.ToString("N")].Role);
        var roles = JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(config.ArrRequestRoles)!;
        Assert.Equal(((int?)4, (double?)20.0), (roles["Member"].QuotaLimit, roles["Member"].QuotaGb));
        Assert.False(roles.ContainsKey("Kid"));
        Assert.Equal("Member", RequestPolicy.Settings(config, r.Kid).Role);

        // Clearing an override removes the entry once nothing is left in it.
        h.As(r.Admin).SaveHousehold(Body("{\"users\":{\"" + r.Member.ToString("N") + "\":{\"role\":null,\"quotaLimit\":null}}}"));
        Assert.False(JsonSerializer.Deserialize<Dictionary<string, RequestUserSettings>>(config.ArrRequestUsers)!.ContainsKey(r.Member.ToString("N")));

        // Settings that can't be read are never overwritten.
        config.ArrRequestUsers = "{broken";
        Refused(r.Admin, "{\"users\":{\"" + r.Member.ToString("N") + "\":{\"role\":\"Kid\"}}}", "configuration_unreadable", 409);
        Assert.Equal("{broken", config.ArrRequestUsers);
    }

    [Fact]
    public async Task AHouseholdSaveWaitsForAConfigurationSwapAndNeverReportsAnEditThatDidNotLandAsSaved()
    {
        using var hub = new Hub();
        var admin = hub.R.View.Users[hub.R.Admin];
        var config = hub.R.Policy.Configuration;
        using var saved = new ManualResetEventSlim();
        var household = new HouseholdService(hub.Projection, hub.R.Feed, _ => saved.Set());
        Task<RequestOutcome> pending;
        // A config-page save swapping the configuration object holds this lock: the household edit waits for it.
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
        {
            pending = Task.Run(() => household.Save(admin, new HouseholdSave { Preset = "open_house" }));
            Assert.False(saved.Wait(300));
            Assert.False(pending.IsCompleted);
        }
        Assert.Equal(200, (await pending).HttpStatus);
        Assert.True(saved.IsSet);
        Assert.Equal("open_house", config.ArrRequestPreset);

        // The edit didn't land in what was saved (the configuration was replaced meanwhile): an error, not "saved".
        var replaced = new HouseholdService(hub.Projection, hub.R.Feed, c => c.ArrRequestPreset = "ask_first");
        var lost = replaced.Save(admin, new HouseholdSave { Preset = "approve_everything" });
        Assert.Equal((500, "save_failed"), (lost.HttpStatus, lost.Reason));
        var failing = new HouseholdService(hub.Projection, hub.R.Feed, _ => throw new IOException("disk full"));
        Assert.Equal((500, "save_failed"), failing.Save(admin, new HouseholdSave { DefaultRole = "Kid" }) is var f ? (f.HttpStatus, f.Reason) : default);
    }
}
