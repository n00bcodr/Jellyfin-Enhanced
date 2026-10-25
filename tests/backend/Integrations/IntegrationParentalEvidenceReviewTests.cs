using Microsoft.AspNetCore.Hosting;
using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationParentalEvidenceReviewTests
{
    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public StatusViewer Viewer { get; }
        public User User => (User)Viewer.Handle!;
        public ServerConfiguration Server { get; } = new() { MetadataCountryCode = "US" };
        public Func<int, CancellationToken, Task<string?>> Evidence { get; set; } = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id));
        public string Page { get; set; } = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "Visible only when verified"));
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public SeerrParentalFilter Gate { get; }
        public ArrStateStore Store { get; }
        public ArrInstanceLibraries Libraries { get; }
        public RequestPolicy Policy { get; }
        public AcquireDatabase Database { get; }
        public RequestService Requests { get; }
        public IUserManager Users { get; }
        public ILibraryManager Library { get; }
        public Mock<ILibraryManager> LibraryMock { get; }
        public DiscoverService Discover { get; }
        public Rig()
        {
            Arr.Add("movies.invalid", "Radarr");
            Arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
            var config = Arr.Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = true;
            config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = "Kid"; config.TMDB_API_KEY = "test-tmdb";
            config.JellyseerrEnabled = false; config.JellyseerrUrls = string.Empty;
            Viewer = View.AddUser(false, parental: true); User.MaxParentalRatingScore = 10;
            Transport = new IntegrationTransport(async (request, ct) =>
            {
                Assert.Equal("api.themoviedb.org", request.RequestUri!.Host);
                var segment = request.RequestUri.Segments.Last();
                var body = int.TryParse(segment, out var id) ? await Evidence(id, ct) : Page;
                return IntegrationTransport.Response(body ?? "{}", body == null ? 503 : 200);
            });
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            var users = new Mock<IUserManager>(); users.Setup(m => m.GetUserById(User.Id)).Returns(User);
            Users = users.Object;
            var localization = new Mock<ILocalizationManager>();
            localization.Setup(m => m.GetRatingScore("G", "US")).Returns(new ParentalRatingScore(1, null));
            localization.Setup(m => m.GetRatingScore("R", "US")).Returns(new ParentalRatingScore(18, null));
            localization.Setup(m => m.GetRatingScore("THROWS", "US")).Throws(new InvalidOperationException("unscorable"));
            var server = new Mock<IServerConfigurationManager>(); server.SetupGet(m => m.Configuration).Returns(Server);
            var library = new Mock<ILibraryManager>(); library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
            LibraryMock = library;
            Library = library.Object;
            Gate = new SeerrParentalFilter(Transport, users.Object, localization.Object, server.Object, Arr.Plugin.Core.Logger,
                new TitleParentalEvidenceProvider(Transport, Tmdb, library.Object));
            Store = Arr.Store(); Libraries = new ArrInstanceLibraries(Store, new FakeLibraryAccess()) { Parental = Gate };
            var aliases = new TitleAliases(Store, null);
            Policy = new RequestPolicy(View, Store, Libraries, aliases, Gate, Arr.Factory, new UnavailableRequestBackend());
            Database = new AcquireDatabase(Path.Combine(Arr.Plugin.Core.Root, "requests.db"));
            Requests = new RequestService(new RequestLedger(Database), Policy, View, new ArrChangeFeed(), aliases);
            Discover = new DiscoverService(Requests, aliases, Gate, Tmdb, library.Object, Arr.Plugin.Core.Manager);
        }
        public async Task<(int Status, JsonElement Body, AcquireDiscoverController Controller)> Read(bool search = false, string query = "family", EvidenceClock? clock = null)
        {
            using var metadataViewer = Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails.ViewerMetadataAdmission.ForViewer(Viewer.UserId);
            var c = new AcquireDiscoverController(Discover) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(User.Id, false);
            c.HttpContext.Request.Method = "GET";
            c.HttpContext.Request.Path = "/JellyfinEnhanced/acquire/" + (search ? "search" : "discover");
            var result = clock == null ? search ? await c.Search(query) : await c.Discover("trending", "movie")
                : (IActionResult)typeof(AcquireDiscoverController).GetMethod("Send", BindingFlags.Instance | BindingFlags.NonPublic)!
                    .Invoke(c, new object?[] { Viewer, await clock.Read(this, search), search ? "search" : "discover", metadataViewer.Refused })!;
            var context = new Microsoft.AspNetCore.Mvc.Filters.ResultExecutingContext(EndpointRouting.Bind(c.HttpContext),
                new List<Microsoft.AspNetCore.Mvc.Filters.IFilterMetadata>(), result, c);
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.RequestOutcomeFilterAttribute().OnResultExecuting(context);
            var spoilers = new SpoilerPresentation(Arr.Plugin.Core.Manager, Library, Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>());
            new TitlePresentationResultFilter(Arr.Plugin.Core.Manager, spoilers, Library,
                Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), null!).OnResultExecuting(context);
            return IntegrationRequestDiscoverTests.Read(context.Result, c);
        }
        public void Dispose() { Database.Dispose(); Store.Dispose(); Tmdb.Dispose(); Transport.Dispose(); Arr.Dispose(); }
    }

    // Test host mutations use the same input-writer owner as the pinned host events.
    private static void MoveCountry(Rig rig, string country) => EvidenceRevision.Advance(() => rig.Server.MetadataCountryCode = country);

    public static IEnumerable<object[]> RegionalCases()
    {
        foreach (var kind in new[] { "movie", "tv" })
        foreach (var shape in new[] { "empty", "foreign", "unscorable", "throws" })
        foreach (var tags in new[] { false, true }) yield return new object[] { shape, tags, kind };
    }

    [Theory]
    [MemberData(nameof(RegionalCases))]
    public async Task MissingRegionalRatingIsUnknownAtEveryJeEntryPoint(string shape, bool tagsOnly, string kind)
    {
        using var r = new Rig();
        if (tagsOnly) { r.User.MaxParentalRatingScore = null; r.User.SetPreference(PreferenceKind.AllowedTags, new[] { "family" }); }
        r.Page = IntegrationRequestDiscoverTests.Page(kind == "movie" ? IntegrationRequestDiscoverTests.Movie(603, "Unverified") : IntegrationRequestDiscoverTests.Show(603, "Unverified"));
        r.Evidence = (id, _) =>
        {
            var rating = shape == "unscorable" ? "NOT-A-RATING" : shape == "throws" ? "THROWS" : "G";
            var json = JsonNode.Parse(kind == "movie" ? IntegrationParentalEvidenceTests.Movie(id, rating) : JsonSerializer.Serialize(new
            {
                id, adult = false, content_ratings = new { results = new[] { new { iso_3166_1 = "US", rating } } },
                keywords = new { results = new[] { new { name = "family" } } }, genres = new[] { new { name = "Family" } },
            }))!;
            var ratings = kind == "movie" ? "release_dates" : "content_ratings";
            if (shape == "empty") json[ratings]!["results"] = new JsonArray();
            if (shape == "foreign") json[ratings]!["results"]![0]!["iso_3166_1"] = "AU";
            return Task.FromResult<string?>(json.ToJsonString());
        };
        Assert.True(await r.Gate.IsBlockedAsync(kind, 603, r.User.Id.ToString("N")));
        Assert.Null(r.Gate.AbsentVerdict(kind, 603, r.User.Id.ToString("N")));
        Assert.False(r.Gate.MaySeeAbsent(kind, 603, r.User.Id.ToString("N"), out var facts)); Assert.Null(facts);
        var filtered = await r.Gate.ApplyAsync(r.Page, "/api/v1/discover/" + (kind == "movie" ? "movies" : "tv"), r.User.Id.ToString("N"));
        Assert.Empty(JsonDocument.Parse(filtered.Body).RootElement.GetProperty("results").EnumerateArray());
        using var cache = new TmdbResponseCache(r.Transport, TimeProvider.System);
        var proxy = ApiAssetTests.Controller(r.Arr.Plugin.Core, cache, r.Gate);
        proxy.HttpContext.User = TestCallers.Principal(r.User.Id, false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await proxy.ProxyTmdbRequest(kind + "/603")).StatusCode);
        await r.Policy.PrepareVisibilityAsync(r.User.Id, new MutationInput { Key = kind + ":tmdb:603" }, default);
        Assert.True(r.Policy.Evaluate(r.User.Id, new MutationInput { Key = kind + ":tmdb:603" }).VisibilityUnknown);
        Assert.Null(await new ListAccessService(new FakeListHost(), Mock.Of<IUserManager>(), r.Gate, r.Arr.Plugin.Core.Logger)
            .CheckTitleAsync(kind, 603, SeerrParentalFilter.PolicyFor(r.User), r.User.Id, default));
        Assert.False(r.Libraries.MaySeeAbsent(r.Viewer, TitleKey.Parse(kind + ":tmdb:603")!));
        Assert.Empty((await r.Discover.DiscoverAsync(r.Viewer, "trending", kind, 1, null, default))!.Results);
        Assert.Empty((await r.Discover.SearchAsync(r.Viewer, "family", 1, null, default))!.Results);
    }

    [Theory]
    [InlineData("apply")] [InlineData("proxy")]
    public async Task MissingRatingBroadCallersFailClosedIndependently(string caller)
    {
        using var r = new Rig();
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, ""));
        if (caller == "apply")
        {
            var filtered = await r.Gate.ApplyAsync(r.Page, "/api/v1/discover/movies", r.User.Id.ToString("N"));
            Assert.Empty(JsonDocument.Parse(filtered.Body).RootElement.GetProperty("results").EnumerateArray());
        }
        else
        {
            var proxy = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
            proxy.HttpContext.User = TestCallers.Principal(r.User.Id, false);
            Assert.Equal(403, Assert.IsType<ObjectResult>(await proxy.ProxyTmdbRequest("movie/603")).StatusCode);
        }
    }

    [Theory]
    [InlineData(false, "credential")] [InlineData(true, "credential")]
    [InlineData(false, "region")] [InlineData(true, "region")]
    [InlineData(false, "backend")] [InlineData(true, "backend")]
    public async Task WarmDecisionCannotSurviveEvidenceRevision(bool search, string change)
    {
        using var r = new Rig();
        Assert.Single((await r.Read(search)).Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        if (change == "credential") EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty);
        if (change == "region") MoveCountry(r, "AU");
        if (change == "backend") EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.ArrRequestBackend = "status_only");
        // Call the real service for backend changes: the controller separately rejects disabled JE browsing.
        var answer = search ? await r.Discover.SearchAsync(r.Viewer, "family", 1, null, default)
            : await r.Discover.DiscoverAsync(r.Viewer, "trending", "movie", 1, null, default);
        Assert.True(answer == null || answer.Results.Count == 0);
    }

    [Theory]
    [InlineData(false, "region")] [InlineData(true, "region")]
    [InlineData(false, "credential")] [InlineData(true, "credential")]
    public async Task RevisionChangedDuringPreparationCannotPublishAnOldAllow(bool search, string change)
    {
        using var r = new Rig();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Page = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "Early allow"), IntegrationRequestDiscoverTests.Movie(604, "Deferred"));
        r.Evidence = async (id, ct) => { if (id == 604) { started.TrySetResult(); await release.Task.WaitAsync(ct); } return IntegrationParentalEvidenceTests.Movie(id); };
        var pending = r.Read(search);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        if (change == "region") MoveCountry(r, "AU");
        else EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty);
        release.SetResult();
        var result = await pending;
        Assert.True(result.Status == 503 || result.Body.GetProperty("answer").GetProperty("results").GetArrayLength() == 0);
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task UnknownEvidenceReturnsRetryablePartialAndCannotBecomeACompleteCachedEmptyPage(bool search)
    {
        using var r = new Rig(); r.Evidence = (_, _) => Task.FromResult<string?>(null);
        var first = await r.Read(search);
        Assert.Equal(200, first.Status);
        Assert.Equal("partial", first.Body.GetProperty("answer").GetProperty("verification").GetString());
        Assert.Equal("evidence_unavailable", first.Body.GetProperty("reason").GetString());
        Assert.Equal("private, no-store", first.Controller.Response.Headers.CacheControl);
        Assert.Empty(first.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.False(first.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.True(first.Body.GetProperty("answer").GetProperty("retryAfterSeconds").GetInt32() > 0);
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id));
        EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "recovered-source");
        var recovered = await r.Read(search);
        Assert.Equal(200, recovered.Status);
        Assert.True(recovered.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Single(recovered.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
    }


    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task CompleteRefusalIsInvalidatedWhenTheEvidenceConnectionChanges(bool search)
    {
        using var r = new Rig();
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, "R"));
        var refused = await r.Read(search);
        Assert.Equal(200, refused.Status);
        Assert.True(refused.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Empty(refused.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "replacement-source");
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id));
        Assert.Single((await r.Read(search)).Body.GetProperty("answer").GetProperty("results").EnumerateArray());
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task MixedVerificationRetainsSafeCardsWithoutAnEtagOrACompleteClaim(bool search)
    {
        using var r = new Rig();
        r.Page = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "Allowed"), IntegrationRequestDiscoverTests.Movie(604, "Never disclose"));
        r.Evidence = (id, _) => Task.FromResult<string?>(id == 603 ? IntegrationParentalEvidenceTests.Movie(id) : null);
        var result = await r.Read(search);
        Assert.Equal(200, result.Status);
        Assert.False(result.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Single(result.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.DoesNotContain("Never disclose", result.Body.GetRawText());
        Assert.False(result.Controller.Response.Headers.ContainsKey("ETag"));
        Assert.Equal("5", result.Controller.Response.Headers.RetryAfter);
        // An unrestricted administrator still gets the full list with no evidence preparation.
        var admin = r.View.AddUser(true);
        Assert.Equal(2, (await r.Discover.DiscoverAsync(admin, "trending", "movie", 1, null, default))!.Results.Count);
    }

    [Fact]
    public async Task AdultJeEvidenceIsAVerifiedRefusalForListsEvenWithoutARating()
    {
        using var r = new Rig(); r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, adult: true));
        Assert.False(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        Assert.False(r.Gate.AbsentVerdict("movie", 603, r.User.Id.ToString("N")));
        Assert.False(await new ListAccessService(new FakeListHost(), Mock.Of<IUserManager>(), r.Gate, r.Arr.Plugin.Core.Logger)
            .CheckTitleAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), r.User.Id, default));
        var answer = await r.Read(); Assert.Equal(200, answer.Status);
        Assert.True(answer.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
    }

    [Fact]
    public async Task ATitleThatBecomesAbsentDuringPreparationIsHiddenAndMakesThePagePartial()
    {
        using var r = new Rig(); var key = TitleKey.Parse("movie:tmdb:603")!;
        r.View.AddCopy(key, new JfCopy { ItemId = Guid.NewGuid() });
        r.Page = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "Became absent"), IntegrationRequestDiscoverTests.Movie(604, "Allowed"));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Evidence = async (id, ct) => { started.TrySetResult(); await release.Task.WaitAsync(ct); return IntegrationParentalEvidenceTests.Movie(id); };
        var pending = r.Read(); await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        r.View.CopiesByKey.Remove(key.ToString()); r.View.Rev++;
        release.SetResult(); var result = await pending;
        Assert.Equal(200, result.Status);
        Assert.Single(result.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.DoesNotContain("Became absent", result.Body.GetRawText());
    }

    // The production budget is private and lazily creates its timer. Install a controlled source
    // before preparation first reads it, leaving PublishAsync, both preparation paths, slot waits,
    // evidence coalescing and controller publication intact. Never replace a budget on a retry.
    private sealed class EvidenceClock : IDisposable
    {
        private readonly Dictionary<object, (TimeSpan Due, CancellationTokenSource Source)> _deadlines = new();
        public TimeSpan Elapsed { get; private set; }
        public TimeSpan Duration { get; } = ProductionDuration();

        private static TimeSpan ProductionDuration()
        {
            // Evaluate the compiled duration expression given to CancelAfter, without arming a
            // wall-clock timer. A changed production duration must change this clock too.
            var budget = typeof(DiscoverService).GetNestedType("EvidenceDeadline", BindingFlags.NonPublic)!;
            var getter = budget.GetProperty("Token")!.GetMethod!;
            var members = PrivacyDeliveryScan.Referenced(getter).ToArray();
            var factory = Assert.Single(members.Where(m => m.Member is MethodInfo { DeclaringType: var type, Name: "FromSeconds" } && type == typeof(TimeSpan)));
            var source = members.Last(m => m.Offset < factory.Offset && m.Member is FieldInfo { Name: "_source" });
            var arm = Assert.Single(members.Where(m => m.Member is MethodInfo { DeclaringType: var type, Name: "CancelAfter" } && type == typeof(CancellationTokenSource)));
            Assert.True(factory.Offset < arm.Offset);
            var expression = getter.GetMethodBody()!.GetILAsByteArray()![(source.Offset + 5)..factory.Offset];
            var evaluate = new DynamicMethod("EvidenceBudgetDuration", typeof(TimeSpan), Type.EmptyTypes);
            var body = evaluate.GetDynamicILInfo();
            body.SetLocalSignature(new byte[] { 0x07, 0x00 });
            var call = body.GetTokenFor(((MethodInfo)factory.Member).MethodHandle);
            body.SetCode(expression.Concat(new byte[] { 0x28 }).Concat(BitConverter.GetBytes(call)).Append((byte)0x2a).ToArray(), 8);
            return evaluate.CreateDelegate<Func<TimeSpan>>()();
        }

        public void Advance(TimeSpan duration)
        {
            CancellationTokenSource[] due;
            lock (_deadlines)
            {
                Elapsed += duration;
                due = _deadlines.Values.Where(d => d.Due <= Elapsed && !d.Source.IsCancellationRequested).Select(d => d.Source).ToArray();
            }
            foreach (var source in due) source.Cancel();
        }

        public Task<DiscoverAnswer?> Read(Rig rig, bool search)
        {
            var publish = typeof(DiscoverService).GetMethod("PublishAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var budgetType = typeof(DiscoverService).GetNestedType("EvidenceDeadline", BindingFlags.NonPublic)!;
            var prepare = GetType().GetMethod(nameof(Preparation), BindingFlags.Instance | BindingFlags.NonPublic)!
                .MakeGenericMethod(budgetType).Invoke(this, new object[] { rig, search });
            return (Task<DiscoverAnswer?>)publish.Invoke(rig.Discover,
                new object?[] { rig.Viewer, search ? "controlled-search" : "controlled-discover", search, prepare, CancellationToken.None })!;
        }

        private Func<StatusViewer, HiddenTitles, TDeadline, Task<DiscoverService.Prepared?>> Preparation<TDeadline>(Rig rig, bool search)
            where TDeadline : notnull
            => (viewer, hidden, budget) =>
            {
                var field = typeof(TDeadline).GetField("_source", BindingFlags.Instance | BindingFlags.NonPublic)!;
                lock (_deadlines)
                {
                    if (!_deadlines.TryGetValue(budget, out var existing))
                    {
                        Assert.Null(field.GetValue(budget));
                        var source = new CancellationTokenSource();
                        _deadlines.Add(budget, (Elapsed + Duration, source));
                        field.SetValue(budget, source);
                    }
                    else Assert.Same(existing.Source, field.GetValue(budget));
                }
                var prepare = typeof(DiscoverService).GetMethod(search ? "PrepareSearchAsync" : "PrepareDiscoverAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
                var args = search
                    ? new object?[] { viewer, "family", 1, null, hidden, budget, CancellationToken.None }
                    : new object?[] { viewer, "trending", "movie", 1, null, hidden, budget, CancellationToken.None };
                return (Task<DiscoverService.Prepared?>)prepare.Invoke(rig.Discover, args)!;
            };

        public void Dispose()
        {
            foreach (var deadline in _deadlines.Values) deadline.Source.Dispose();
        }
    }

    [Fact]
    public async Task TwentyDeferredTitlesHaveOneDeadlineIncludingSlotWaitsAndWarmAfterRelease()
    {
        using var r = new Rig();
        using var clock = new EvidenceClock();
        Assert.Equal(TimeSpan.FromSeconds(2), clock.Duration);
        var timeout = TimeSpan.FromMinutes(2);
        r.Page = IntegrationRequestDiscoverTests.Page(Enumerable.Range(600, 20).Select(id => IntegrationRequestDiscoverTests.Movie(id, "Title " + id)).ToArray());
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reads = new System.Collections.Concurrent.ConcurrentDictionary<int, int>();
        r.Evidence = async (id, ct) =>
        {
            reads.AddOrUpdate(id, 1, (_, n) => n + 1);
            if (reads.Count == 8) started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return IntegrationParentalEvidenceTests.Movie(id);
        };
        var first = r.Read(clock: clock);
        Task<(int Status, JsonElement Body, AcquireDiscoverController Controller)>? second = null;
        Task[] survivors = Array.Empty<Task>();
        try
        {
            await started.Task.WaitAsync(timeout);
            Assert.Equal(8, reads.Count);
            Assert.False(first.IsCompleted);
            clock.Advance(TimeSpan.FromSeconds(1));
            second = r.Read(true, clock: clock); // All eight slots are occupied for its first second.
            Assert.False(second.IsCompleted);
            clock.Advance(TimeSpan.FromSeconds(1) - TimeSpan.FromTicks(1));
            Assert.False(first.IsCompleted);
            Assert.False(second.IsCompleted);
            clock.Advance(TimeSpan.FromTicks(1));
            var result = await first.WaitAsync(timeout);
            Assert.Equal(200, result.Status);
            Assert.False(result.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
            Assert.Empty(result.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
            Assert.Equal(TimeSpan.FromSeconds(2), clock.Elapsed);
            clock.Advance(TimeSpan.FromSeconds(1) - TimeSpan.FromTicks(1));
            Assert.False(second.IsCompleted); // Slot waits consumed its existing budget; they did not restart it.
            clock.Advance(TimeSpan.FromTicks(1));
            var searched = await second.WaitAsync(timeout);
            Assert.Equal(200, searched.Status);
            Assert.False(searched.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
            Assert.Empty(searched.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
            Assert.Equal(TimeSpan.FromSeconds(3), clock.Elapsed);
            Assert.False(release.Task.IsCompleted); // Both deadlines expired with the transport still held.
            Assert.All(reads.Values, n => Assert.Equal(1, n));
            // Join the underlying shared reads before releasing the transport. Their completion
            // proves the caches are warm, rather than racing a background cache publication.
            survivors = reads.Keys.Select(async id => Assert.True(await r.Gate.MaySeeAbsentAsync("movie", id, r.User.Id.ToString("N"), default))).ToArray();
        }
        finally
        {
            release.TrySetResult();
            await Task.WhenAll(second == null ? new Task[] { first } : new Task[] { first, second }).WaitAsync(timeout);
            await Task.WhenAll(survivors).WaitAsync(timeout);
        }
        var recovered = await r.Read(clock: clock).WaitAsync(timeout);
        Assert.Equal(200, recovered.Status);
        Assert.True(recovered.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Equal(20, recovered.Body.GetProperty("answer").GetProperty("results").GetArrayLength());
        Assert.Equal(20, reads.Count);
        Assert.All(reads.Values, n => Assert.Equal(1, n)); // Shared reads survive abandoned waiters.
    }

    [Theory]
    [InlineData("tv/603")]
    [InlineData("tv/603/season/1")]
    [InlineData("tv/603/season/1/watch/providers")]
    [InlineData("apply-detail")]
    [InlineData("apply-list")]
    [InlineData("apply-knownfor")]
    [InlineData("apply-nested")]
    [InlineData("apply-subresource")]
    public async Task OwnedOpenableUnratedSeriesUsesNativeEntitlementOnEveryBroadConsumer(string route)
    {
        using var r = new Rig();
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Path = "/media/tv/Owned", ProviderIds = new() { ["Tmdb"] = "603" } };
        var visible = true;
        r.LibraryMock.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) =>
            q.User == null || visible ? new List<BaseItem> { series } : new List<BaseItem>());
        r.LibraryMock.Setup(m => m.GetItemById<BaseItem>(series.Id, r.User)).Returns(() => visible ? series : null);
        r.Evidence = (id, _) => Task.FromResult<string?>(JsonSerializer.Serialize(new { id, adult = false, seasons = new[] { new { season_number = 1 } }, content_ratings = new { results = Array.Empty<object>() } }));
        async Task<bool> Allowed()
        {
            if (route.StartsWith("apply"))
            {
                var (path, body) = route switch
                {
                    "apply-list" => ("/api/v1/discover/tv", IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Show(603, "Owned"))),
                    "apply-knownfor" => ("/api/v1/search", """{"results":[{"mediaType":"person","id":2,"knownFor":[{"mediaType":"tv","id":603}]}]}"""),
                    "apply-nested" => ("/api/v1/issue/1", """{"media":{"mediaType":"tv","tmdbId":603}}"""),
                    "apply-subresource" => ("/api/v1/tv/603/season/1", "{}"),
                    _ => ("/api/v1/tv/603", "{}"),
                };
                var filtered = await r.Gate.ApplyAsync(body, path, r.User.Id.ToString("N"));
                if (filtered.Block) return false;
                using var parsed = JsonDocument.Parse(filtered.Body);
                return route switch
                {
                    "apply-list" => parsed.RootElement.GetProperty("results").GetArrayLength() == 1,
                    "apply-knownfor" => parsed.RootElement.GetProperty("results")[0].GetProperty("knownFor").GetArrayLength() == 1,
                    _ => true,
                };
            }
            var proxy = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
            proxy.HttpContext.User = TestCallers.Principal(r.User.Id, false);
            return await proxy.ProxyTmdbRequest(route) is ContentResult or FileContentResult;
        }
        Assert.True(await Allowed());
        // Native access is read afresh: a hidden physical copy cannot confer this exception.
        visible = false;
        Assert.False(await Allowed());
        Assert.Null(r.Gate.AbsentVerdict("tv", 603, r.User.Id.ToString("N")));
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task OnlyAFailedListReadReturns503WhileMovingEvidenceRemainsAnIncomplete200(bool search)
    {
        using var r = new Rig(); var change = 0;
        r.Evidence = (id, _) =>
        {
            EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "moving-source-" + ++change);
            return Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id));
        };
        var moving = await r.Read(search);
        Assert.Equal(200, moving.Status);
        Assert.False(moving.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Empty(moving.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.Equal("evidence_unavailable", moving.Body.GetProperty("reason").GetString());
        r.Page = null!;
        EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "failed-list-source");
        Assert.Equal(503, (await r.Read(search)).Status);
    }

    [Fact]
    public async Task ExpiredUnknownFollowedByFailedRefreshBacksOffSequentialRatingChecks()
    {
        using var r = new Rig();
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, ""));
        Assert.Null(await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default));
        // Age the real signature cache without a five-minute wall-clock sleep.
        var cache = (System.Collections.IDictionary)typeof(SeerrParentalFilter).GetField("_certCache", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(r.Gate)!;
        foreach (var key in cache.Keys.Cast<string>().ToArray())
        {
            var value = cache[key]!;
            var fields = (System.Runtime.CompilerServices.ITuple)value;
            cache[key] = Activator.CreateInstance(value.GetType(), fields[0], fields[1], DateTime.UtcNow.AddMinutes(-6));
        }
        var refreshes = 0;
        r.Evidence = (_, _) => { refreshes++; return Task.FromResult<string?>(null); };
        for (var i = 0; i < 3; i++) Assert.Null(await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default));
        Assert.Equal(1, refreshes);
    }

    [Fact]
    public async Task FailedTagUpgradePreservesAFreshRatedSignatureAndBacksOffTagCallers()
    {
        using var r = new Rig();
        var rating = SeerrParentalFilter.PolicyFor(r.User);
        Assert.True(await r.Gate.AbsentVerdictAsync("movie", 603, rating, default));
        var failures = 0;
        r.Evidence = (_, _) => { failures++; return Task.FromResult<string?>(null); };
        r.User.SetPreference(PreferenceKind.AllowedTags, new[] { "family" });
        var tagged = SeerrParentalFilter.PolicyFor(r.User);
        Assert.Null(await r.Gate.AbsentVerdictAsync("movie", 603, tagged, default));
        Assert.Null(await r.Gate.AbsentVerdictAsync("movie", 603, tagged, default));
        Assert.True(await r.Gate.AbsentVerdictAsync("movie", 603, rating, default));
        Assert.Equal(1, failures);
    }

    [Fact]
    public async Task EvidenceChangeDuringMultiTitleBuildCannotPublishOrCacheEarlierDecisions()
    {
        using var r = new Rig(); var key = TitleKey.Parse("movie:tmdb:603")!;
        await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default);
        var status = new ArrStatusService(r.Store, r.View, new NoRequestFacts(), () => r.Arr.Plugin.Plugin.Configuration, () => r.Arr.Now, libraries: r.Libraries);
        await Assert.ThrowsAsync<ArrStatusService.ViewerChangedException>(() => status.ForTitlesAsync(r.Viewer, new[] { key }, "review", "same", rows =>
        {
            Assert.Single(rows);
            MoveCountry(r, "AU");
            return JsonSerializer.SerializeToUtf8Bytes(new { items = rows.Select(row => row.Status) });
        }, default));
        Assert.Equal(0, status.Cache.Count);
    }

    [Fact]
    public async Task EvidenceRevisionMovingAcrossDeferredGatherIsCheckedBeforeAStatusCacheHit()
    {
        using var r = new Rig(); var key = TitleKey.Parse("movie:tmdb:603")!;
        await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default);
        var status = new ArrStatusService(r.Store, r.View, new NoRequestFacts(), () => r.Arr.Plugin.Plugin.Configuration, () => r.Arr.Now, libraries: r.Libraries);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        r.Arr.Hosts["movies.invalid"].Before = async (_, ct) => { started.TrySetResult(); await release.Task.WaitAsync(ct); };
        var pending = status.ForKeyDetailAsync(r.Viewer, key, default);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        MoveCountry(r, "AU");
        release.SetResult();
        Assert.Empty(JsonDocument.Parse((await pending).Json).RootElement.GetProperty("items").EnumerateArray());
    }

    public static IEnumerable<object[]> StatusCaches()
    {
        foreach (var route in new[] { "batch", "detail", "absent", "part", "titles" })
        foreach (var change in new[] { "country", "connection", "refusal-recovery" }) yield return new object[] { route, change };
    }

    [Theory]
    [MemberData(nameof(StatusCaches))]
    public async Task SerializedStatusDecisionsFollowEvidenceRevisionBothDirections(string route, string change)
    {
        using var r = new Rig();
        var key = TitleKey.Parse("movie:tmdb:603")!;
        var refused = change == "refusal-recovery";
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, refused ? "R" : "G"));
        await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default);
        var status = new ArrStatusService(r.Store, r.View, new NoRequestFacts(), () => r.Arr.Plugin.Plugin.Configuration, () => r.Arr.Now, libraries: r.Libraries);
        var absent = new AbsentTitle { PageId = Guid.NewGuid(), Title = key, TmdbId = 603 };
        async Task<byte[]> Read()
        {
            if (route is "batch" or "detail")
            {
                var controller = new ArrStatusController(status) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
                controller.HttpContext.User = TestCallers.Principal(r.User.Id, false);
                return Assert.IsType<FileContentResult>(await controller.GetStatuses(null, key.ToString(), default, route == "detail")).FileContents;
            }
            return (route switch
            {
                "absent" => await status.ForAbsentAsync(r.Viewer, absent, default),
                "part" => await status.ForPartAsync(r.Viewer, key, Array.Empty<int>(), Array.Empty<(int, int)>(), false, default),
                _ => await status.ForTitlesAsync(r.Viewer, new[] { key }, "review", "same", rows => JsonSerializer.SerializeToUtf8Bytes(new { items = rows.Select(row => row.Status) }), default),
            }).Json;
        }
        static int Count(byte[] body) => JsonDocument.Parse(body).RootElement.GetProperty("items").GetArrayLength();
        Assert.Equal(refused ? 0 : 1, Count(await Read()));
        Assert.Equal(refused ? 0 : 1, Count(await Read())); // warm cache hit
        if (change == "country") MoveCountry(r, "AU");
        else { EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "changed-source"); refused = !refused; }
        await r.Gate.AbsentVerdictAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default);
        Assert.Equal(change == "refusal-recovery" ? 1 : 0, Count(await Read()));
    }
    private static string TvEvidence(int id) => JsonSerializer.Serialize(new
    {
        id, adult = false, content_ratings = new { results = new[] { new { iso_3166_1 = "US", rating = "G" } } },
        keywords = new { results = Array.Empty<object>() }, genres = Array.Empty<object>(),
    });

    private sealed class Pages(Func<Task<AbsentPageResult>> resolve) : IAbsentTitlePages
    {
        public Task<AbsentPageResult> ResolveAsync(Guid viewer, Guid id, CancellationToken ct) => resolve();
    }

    [Theory]
    [InlineData("stable")] [InlineData("metadata")] [InlineData("page")] [InlineData("projection")]
    public async Task SeasonControllerNeverPublishesRevokedAbsentMetadata(string change)
    {
        using var r = new Rig();
        r.Arr.Add("tv.invalid", "Sonarr");
        r.Arr.Configure(("TV", ArrKind.Sonarr, "http://tv.invalid", "test-key"));
        r.Evidence = (id, _) => Task.FromResult<string?>(TvEvidence(id));
        Assert.True(await r.Gate.MaySeeAbsentAsync("tv", 603, r.User.Id.ToString("N"), default));
        var page = new AbsentTitle { PageId = Guid.NewGuid(), Kind = "season", Title = TitleKey.Parse("tv:tvdb:393189")!,
            TmdbId = 603, Season = 1, SeriesPageId = Guid.NewGuid() };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var rows = new SeasonRowsService(r.View, r.Requests.Ledger, r.Policy, null, async (_, _, _, _) =>
        {
            entered.TrySetResult();
            if (change == "metadata") await release.Task;
            return """{"episodes":[{"episode_number":1,"name":"Private episode","overview":"Private plot","still_path":"/private.jpg"}]}""";
        });
        var pages = new Pages(async () =>
        {
            if (change == "page") { entered.TrySetResult(); await release.Task; }
            return new AbsentPageResult(AbsentLookup.Found, page);
        });
        using var services = new ServiceCollection().AddSingleton<IAbsentTitlePages>(pages).BuildServiceProvider();
        var c = new AcquireRequestsController(r.Requests, rows) { ControllerContext = new() { HttpContext = new DefaultHttpContext { RequestServices = services } } };
        c.HttpContext.User = TestCallers.Principal(r.User.Id, false);
        if (change == "projection")
        {
            // RequestPolicy's publication probe re-reads its current native view synchronously.
            r.View.OnCopies = () => MoveCountry(r, "AU");
        }
        var pending = c.Season(page.PageId.ToString("N"));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        if (change is "metadata" or "page") MoveCountry(r, "AU");
        release.TrySetResult();
        var answer = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        if (change == "stable")
        {
            var file = Assert.IsType<FileContentResult>(answer);
            Assert.Contains("Private episode", System.Text.Encoding.UTF8.GetString(file.FileContents));
        }
        else Assert.Equal(404, Assert.IsType<ObjectResult>(answer).StatusCode);
    }

    [Theory]
    [InlineData("title")] [InlineData("season")] [InlineData("ratings")] [InlineData("related")]
    public async Task PublicDetailsControllerPreservesOwnedUnratedNativeEntitlement(string route)
    {
        using var r = new Rig();
        var config = r.Arr.Plugin.Plugin.Configuration;
        // A1 owns source selection. This existing source-admission guard is independent of the parental consumer.
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://configured.invalid"; config.JellyseerrApiKey = "test-only";
        var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), Path = "/media/owned", ProviderIds = new() { ["Tmdb"] = "603" } };
        var visible = true;
        r.LibraryMock.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == null || visible ? new List<BaseItem> { series } : new List<BaseItem>());
        r.LibraryMock.Setup(m => m.GetItemById<BaseItem>(series.Id, r.User)).Returns(() => visible ? series : null);
        r.Evidence = (id, _) => Task.FromResult<string?>(JsonSerializer.Serialize(new { id, adult = false, content_ratings = new { results = Array.Empty<object>() } }));
        var source = new Mock<INativeDetailsSource>();
        var data = SourceAnswer.Of(JsonDocument.Parse("""{"id":603,"name":"Owned","seasons":[{"seasonNumber":1}],"episodes":[{"episodeNumber":1,"seasonNumber":1}],"results":[]}""").RootElement.Clone());
        source.Setup(m => m.SeriesAsync(603, r.User.Id, It.IsAny<CancellationToken>())).ReturnsAsync(data);
        source.Setup(m => m.SeasonAsync(603, 1, r.User.Id, It.IsAny<CancellationToken>())).ReturnsAsync(data);
        source.Setup(m => m.RatingsAsync(false, 603, r.User.Id, It.IsAny<CancellationToken>())).ReturnsAsync(data);
        source.Setup(m => m.RelatedAsync(false, 603, "similar", 1, r.User.Id, It.IsAny<CancellationToken>())).ReturnsAsync(data);
        var libraries = new FakeLibraryAccess(); libraries.AddLibrary("TV", "tvshows", "/media");
        var policy = new NativeDetailsPolicy(r.Gate, source.Object, libraries, physical: new NativeDetailsLibrary(r.Library));
        var feeds = new NativeDetailsFeeds(source.Object, policy, r.Gate, r.Library);
        var c = new NativeDetailsFeedsController(feeds, r.Users) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        c.HttpContext.User = TestCallers.Principal(r.User.Id, false);
        async Task<IActionResult> Read() => route switch
        {
            "season" => await c.Season(603, 1, default), "ratings" => await c.Ratings("tv", 603, default),
            "related" => await c.Related("tv", 603, "similar", 1), _ => await c.Title("tv", 603, default),
        };
        Assert.IsType<ContentResult>(await Read());
        visible = false;
        Assert.Equal(404, Assert.IsAssignableFrom<ObjectResult>(await Read()).StatusCode);
        Assert.False(await policy.MaySeeAsync(r.User, SyntheticId.SeasonOf(603, 1), default));
    }

    [Fact]
    public async Task FeedAudienceDoesNotReuseAnAllowOrRefusalAcrossEvidenceRevisions()
    {
        using var r = new Rig();
        var audience = new ArrFeedAudience(r.Library, r.Users, r.Store, view: r.View, libraries: r.Libraries);
        var changes = new[] { new ArrFeedChange("movie:tmdb:603", 1, r.Arr.Instance("Movies").Id) };
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        Assert.Single(audience.Visible(r.User.Id, false, changes));
        MoveCountry(r, "AU");
        Assert.Empty(audience.Visible(r.User.Id, false, changes));
        MoveCountry(r, "US");
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        Assert.Single(audience.Visible(r.User.Id, false, changes));
    }

    [Theory]
    [InlineData("ProxyTmdbRequest")] [InlineData("Title")] [InlineData("Season")] [InlineData("Ratings")]
    [InlineData("Related")] [InlineData("Filmography")] [InlineData("Discover")] [InlineData("Collection")]
    [InlineData("native-item")] [InlineData("native-episodes")] [InlineData("native-image")] [InlineData("stable")]
    public void FinalHttpPublicationRejectsEvidenceChangedAfterAdmission(string action)
    {
        using var r = new Rig();
        var actualAction = action == "stable" ? "ProxyTmdbRequest" : action;
        ControllerBase controller = actualAction == "ProxyTmdbRequest" ? ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate)
            : new NativeDetailsFeedsController(null!, r.Users);
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = TestCallers.Principal(r.User.Id, false);
        controller.HttpContext.Request.Method = "GET";
        Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor descriptor = action.StartsWith("native-")
            ? new Microsoft.AspNetCore.Mvc.Abstractions.ActionDescriptor { RouteValues = new Dictionary<string, string?> { ["controller"] = action == "native-item" ? "UserLibrary" : action == "native-image" ? "Image" : "TvShows", ["action"] = action == "native-item" ? "GetItem" : action == "native-image" ? "GetItemImage" : "GetEpisodes" } }
            : new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
        {
            ControllerTypeInfo = controller.GetType().GetTypeInfo(), ControllerName = controller.GetType().Name.Replace("Controller", ""), ActionName = actualAction,
            MethodInfo = controller.GetType().GetMethods().First(m => m.Name == actualAction),
        };
        var context = new Microsoft.AspNetCore.Mvc.ActionContext(controller.HttpContext, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
        var spoilers = new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>());
        using var services = new ServiceCollection().AddSingleton(r.Gate).BuildServiceProvider();
        var filter = ActivatorUtilities.CreateInstance<TitlePresentationResultFilter>(services, r.Arr.Plugin.Core.Manager, spoilers, r.Library,
            Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!));
        filter.OnResourceExecuting(new ResourceExecutingContext(context, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>()));
        if (action != "stable") MoveCountry(r, "AU");
        controller.Response.Headers.ETag = "\"old\"";
        IActionResult body = action == "native-image" ? new FileContentResult(new byte[] { 0xff, 0xd8, 0xff }, "image/jpeg")
            : new ContentResult { Content = "{\"title\":\"private\"}", ContentType = "application/json" };
        var result = new ResultExecutingContext(context, new List<IFilterMetadata>(), body, controller);
        filter.OnResultExecuting(result);
        if (action == "stable") { Assert.IsType<ContentResult>(result.Result); return; }
        Assert.Equal(503, Assert.IsType<StatusCodeResult>(result.Result).StatusCode);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl);
        Assert.False(controller.Response.Headers.ContainsKey("ETag"));
    }

    private sealed class MovingImportView(Action move) : IImportViewerPolicy
    {
        public ImportViewer For(User viewer) { move(); return ImportViewer.None; }
    }

    [Fact]
    public async Task ListProjectionDoesNotReusePreparedPlaceholderVisibilityAcrossEvidenceRevisions()
    {
        using var r = new Rig();
        var host = new FakeListHost();
        var access = new ListAccessService(host, r.Users, r.Gate, r.Arr.Plugin.Core.Logger);
        var list = host.AddPlaylist(r.User, false);
        var context = access.Resolve(list.Info.Id, r.User)!;
        var items = new[] { new Placeholder { Id = "p", Kind = PlaceholderKinds.Movie, TmdbId = 603 } };
        var known = await access.Gate.VisibilityAsync(items, r.User, default);
        Assert.True(known.IsVisible(items[0]));
        MoveCountry(r, "AU");
        var published = await access.Gate.ProjectAsync(context, items, known, grant => items.Where(grant.Visibility.IsVisible).ToList(), default);
        Assert.NotNull(published);
        Assert.Empty(published);
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task ImportAndSourcePreviewWithholdEarlierAllowAfterFinalAwait(bool preview)
    {
        using var r = new Rig();
        var host = new FakeListHost();
        var access = new ListAccessService(host, r.Users, r.Gate, r.Arr.Plugin.Core.Logger);
        var lookup = new FakeImportLookup(); lookup.AddSearch("Allowed", FakeImportLookup.Movie(603, "Allowed", "2000-01-01"));
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        var viewer = new MovingImportView(() => MoveCountry(r, "AU"));
        var resolver = new ListImportResolver(lookup, new FakeLibraryLookup(), access, limiter, r.Arr.Plugin.Core.Logger, viewer);
        if (preview)
        {
            var fetcher = new FakeSourceFetcher { Items = new() { new SourceItem("movie", 603, null, null, "Allowed", 2000, null, null, null) } };
            var source = new ListSourcePreview(fetcher, resolver, access, r.Arr.Plugin.Core.Logger, viewer);
            var answer = await source.FetchAsync(r.User, new SourceFetchRequest { Url = "https://mdblist.com/lists/test/list" }, default);
            Assert.Equal(504, answer.StatusCode);
            Assert.IsType<ListErrorDto>(answer.Value);
        }
        else
        {
            var answer = await resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Allowed", Year = 2000, TypeHint = "movie" } },
                new ImportResolveOptions { Caller = r.User, LibraryUsers = new[] { r.User }, Context = new ImportCallContext(r.User.Id.ToString("N"), false), Deadline = TimeSpan.FromSeconds(5) }, default);
            Assert.Empty(answer.Response.Results);
            Assert.False(answer.Response.Complete);
        }
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task CollectionGapsDiscardEarlierEvidenceAcrossAwaitAndProjection(bool projection)
    {
        using var r = new Rig();
        var config = r.Arr.Plugin.Plugin.Configuration;
        config.ArrPhase4Enabled = config.ArrPhase4CollectionGapsEnabled = true;
        var box = new MediaBrowser.Controller.Entities.Movies.BoxSet { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "99" } };
        r.LibraryMock.Setup(m => m.GetItemById<BaseItem>(box.Id, r.User)).Returns(box);
        r.Evidence = (id, _) => Task.FromResult<string?>(id == 99
            ? """{"parts":[{"id":603,"title":"Allowed","release_date":"2000-01-01"}]}""" : IntegrationParentalEvidenceTests.Movie(id));
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var coverage = new Mock<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home.ICollectionCoverage>();
        coverage.Setup(m => m.PrepareAsync(box.Id, r.Viewer, It.IsAny<CancellationToken>())).Returns(async () =>
        { entered.TrySetResult(); if (!projection) await release.Task; return () => new HashSet<string>(); });
        var gaps = new CollectionGapsService(r.View, r.Library, r.Requests.Ledger, new TitleAliases(r.Store, null), r.Tmdb, r.Gate, r.Policy, r.Requests, coverage.Object);
        var moved = false;
        var pending = gaps.ProjectAsync(r.Viewer, box.Id, null, answer =>
        {
            if (projection && !moved) { moved = true; MoveCountry(r, "AU"); }
            return answer;
        }, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        if (!projection) MoveCountry(r, "AU");
        release.TrySetResult();
        var result = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotNull(result.Gaps);
        Assert.Empty(result.Gaps.Missing);
    }

    [Theory]
    [InlineData("credential")] [InlineData("backend")]
    public async Task R6AllInputRoundTripsInvalidateEveryPreparedDependency(string input)
    {
        using var r = new Rig();
        var owner = r.Gate.CapturePublication(r.User.Id);
        var gate = new ResponseGate(r.View, () => r.Arr.Plugin.Plugin.Configuration, () => r.Gate.EvidenceRevision);
        var prepared = gate.Take(r.Viewer);
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        var fingerprint = r.Gate.EvidenceFingerprint;
        var config = r.Arr.Plugin.Plugin.Configuration;
        var old = input == "credential" ? config.TMDB_API_KEY : config.ArrRequestBackend;
        EvidenceRevision.Advance(() => { if (input == "credential") config.TMDB_API_KEY = "roundtrip-replacement"; else config.ArrRequestBackend = "status_only"; });
        EvidenceRevision.Advance(() => { if (input == "credential") config.TMDB_API_KEY = old; else config.ArrRequestBackend = old; });
        Assert.Equal(fingerprint, r.Gate.EvidenceFingerprint);
        Assert.False(owner.Current);
        Assert.False(gate.EvidenceCurrent(prepared));
        Assert.Null(gate.Current(prepared));
        Assert.False(r.Gate.MaySeeAbsent("movie", 603, r.User.Id.ToString("N"), out _)); // old signature partition is a miss
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        Assert.True(r.Gate.CapturePublication(r.User.Id).Current);
    }

    [Theory]
    [InlineData(false, false)] [InlineData(true, false)]
    [InlineData(false, true)] [InlineData(true, true)]
    public async Task R6CountryRoundTripCanPublishAnIntermediateAllow(bool roundTrip, bool kestrel)
    {
        using var r = new Rig();
        r.Evidence = (id, _) => Task.FromResult<string?>("{\"id\":" + id + ",\"adult\":false,\"release_dates\":{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"certification\":\"R\"}]},{\"iso_3166_1\":\"AU\",\"release_dates\":[{\"certification\":\"G\"}]}]}}");
        var localization = (ILocalizationManager)typeof(SeerrParentalFilter).GetField("_localization", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(r.Gate)!;
        Mock.Get(localization).Setup(m => m.GetRatingScore("G", "AU")).Returns(new ParentalRatingScore(1, null));
        Assert.False(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        var initial = r.Gate.EvidenceFingerprint;
        var before = EvidenceRevision.Current;
        var builder = new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, false);
                var action = EndpointRouting.Bind(http);
                var resource = new ResourceExecutingContext(action, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
                {
                    if (roundTrip) EvidenceRevision.Advance(() => r.Server.MetadataCountryCode = "AU");
                    var controller = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
                    controller.ControllerContext = new() { HttpContext = http };
                    var answer = await controller.ProxyTmdbRequest("movie/603");
                    if (roundTrip)
                    {
                        Assert.True(r.Gate.MaySeeAbsent("movie", 603, r.User.Id.ToString("N"), out _));
                        EvidenceRevision.Advance(() => r.Server.MetadataCountryCode = "US");
                    }
                    var projection = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager,
                        new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>()), r.Library,
                        Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                    var executing = new ResultExecutingContext(action, new List<IFilterMetadata>(), answer, controller);
                    projection.OnResultExecuting(executing);
                    await executing.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, new List<IFilterMetadata>());
                });
            }));
        using var test = !kestrel ? new Microsoft.AspNetCore.TestHost.TestServer(builder) : null;
        using var server = kestrel ? builder.UseKestrel().UseUrls("http://127.0.0.1:0").Build() : null;
        if (server != null) await server.StartAsync();
        using var client = test?.CreateClient() ?? new HttpClient { BaseAddress = new Uri(server!.ServerFeatures.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.Single()) };
        using var response = await client.GetAsync("/JellyfinEnhanced/tmdb/movie/603");
        var body = await response.Content.ReadAsStringAsync();
        Assert.Equal(initial, r.Gate.EvidenceFingerprint);
        Assert.False(r.Gate.MaySeeAbsent("movie", 603, r.User.Id.ToString("N"), out _));
        if (roundTrip)
        {
            Assert.True(EvidenceRevision.Current >= before + 2);
            if ((int)response.StatusCode == 200) Assert.Contains("\"id\":603", body);
        }
        Assert.Equal(roundTrip ? 503 : 403, (int)response.StatusCode);
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task R6AutomaticCredentialRecoveryMustDrainExistingAdmissions(bool holdAdmission)
    {
        using var r = new Rig();
        var path = Path.Combine(r.Arr.Plugin.Core.Root, "recovery.json");
        File.WriteAllText(path, "{ unreadable");
        var now = DateTimeOffset.UtcNow;
        var store = new Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets.SecretsStore(path, now: () => now);
        typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).GetField("<Secrets>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(r.Arr.Plugin.Plugin, store);
        EvidenceRevision.Advance(() => r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets.SecretValue.Mask("test-restored"));
        Assert.False(store.IsAvailable);
        var before = r.Gate.EvidenceRevision;
        var epoch = EvidenceRevision.Current;
        using var admission = holdAdmission ? EvidenceRevision.TryAcquire(() => true) : null;
        Assert.Equal(holdAdmission ? 1 : 0, EvidenceRevision.Outstanding);
        File.WriteAllText(path, "{\"version\":1,\"secrets\":{\"TMDB_API_KEY\":\"test-restored\"}}");
        now += Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets.SecretsStore.ReloadInterval;
        var recovery = Task.Run(() => store.Get("TMDB_API_KEY"));
        var completedWhileHeld = await Task.WhenAny(recovery, Task.Delay(150)) == recovery;
        try
        {
            if (holdAdmission)
            {
                Assert.True(EvidenceRevision.Advancing);
                Assert.Equal(epoch, EvidenceRevision.Current);
                Assert.Equal(before, r.Gate.EvidenceRevision);
                // Final validation is a snapshot; it cannot recover, wait on this writer or mutate its input.
                Assert.Null(EvidenceRevision.Snapshot(() => store.Get("TMDB_API_KEY")));
                Assert.Equal(epoch, EvidenceRevision.Current);
            }
        }
        finally { admission?.Dispose(); }
        Assert.NotNull(await recovery.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(EvidenceRevision.Current > epoch);
        Assert.True(store.IsAvailable);
        if (holdAdmission) Assert.False(completedWhileHeld, "Recovery published a credential before draining the existing admission.");
        else Assert.True(completedWhileHeld);
    }

    // Adopted reviewer schedules. The original 503 oracle is retained in reviewer-original-before.trx (3 red/3 controls).
    // With the writer barrier, the earlier response must finish under US before the external writer may select AU.
    [Theory]
    [InlineData(false)] [InlineData(true)]
    public Task R5RealJellyfinTimingCallbackMustNotOutliveTheOwner(bool revokeAtCommit) => R5WriterWitness("jellyfin", revokeAtCommit);

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public Task R5EarlierMiddlewareCallbackKestrelMustNotOutliveTheOwner(bool revokeAtCommit) => R5WriterWitness("kestrel", revokeAtCommit);

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public Task R5EarlierMiddlewareCallbackMustNotOutliveTheOwner(bool revokeAtCommit) => R5WriterWitness("testserver", revokeAtCommit);

    private async Task R5WriterWitness(string transport, bool change)
    {
        using var r = new Rig();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = 0;
        r.Server.EnableSlowResponseWarning = true;
        r.Server.SlowResponseThresholdMs = -1;
        async Task Observe(HttpContext http)
        {
            if (Interlocked.Exchange(ref first, 1) != 0) return;
            Assert.False(http.Response.HasStarted);
            var guard = PrivacyResponseGuard.Find(http);
            Assert.NotNull(guard);
            Assert.True((bool)typeof(PrivacyResponseGuard).GetField("_startChecked", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(guard)!);
            Assert.True(guard.Holds());
            entered.TrySetResult();
            await release.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        var builder = new WebHostBuilder().ConfigureServices(services => services.AddControllers())
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async outerHttp =>
            {
                RequestDelegate next = async http =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    var controller = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
                    controller.ControllerContext = new() { HttpContext = http };
                    var context = EndpointRouting.Bind(http);
                    var spoilers = new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>());
                    var filter = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager, spoilers, r.Library,
                        Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),
                        new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                    var resource = new ResourceExecutingContext(context, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                    filter.OnResourceExecuting(resource);
                    await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
                    {
                        var admitted = await controller.ProxyTmdbRequest("movie/603");
                        var result = new ResultExecutingContext(context, new List<IFilterMetadata>(), admitted, controller);
                        filter.OnResultExecuting(result);
                        await result.Result.ExecuteResultAsync(context);
                        return new ResourceExecutedContext(context, new List<IFilterMetadata>());
                    });
                };
                if (transport == "jellyfin")
                {
                    var native = Assembly.LoadFrom(JellyfinApiAssembly.Pinned("jf12").Path).GetType("Jellyfin.Api.Middleware.ResponseTimeMiddleware", true)!;
                    var logger = Activator.CreateInstance(typeof(R5HostTimingLogger<>).MakeGenericType(native), (Action)(() => Observe(outerHttp).GetAwaiter().GetResult()));
                    var configuration = new Mock<IServerConfigurationManager>();
                    configuration.SetupGet(m => m.Configuration).Returns(r.Server);
                    var middleware = Activator.CreateInstance(native, next, logger);
                    await (Task)native.GetMethod("Invoke")!.Invoke(middleware, new object[] { outerHttp, configuration.Object })!;
                }
                else
                {
                    outerHttp.Response.OnStarting(() => Observe(outerHttp));
                    await next(outerHttp);
                }
            }));
        using var test = transport == "testserver" ? new Microsoft.AspNetCore.TestHost.TestServer(builder) : null;
        using var server = transport == "testserver" ? null : builder.UseKestrel().UseUrls("http://127.0.0.1:0").Build();
        if (server != null) await server.StartAsync();
        using var client = test?.CreateClient() ?? new HttpClient { BaseAddress = new Uri(server!.ServerFeatures.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.Single()) };
        var responseTask = client.GetAsync("/JellyfinEnhanced/tmdb/movie/603");
        Task writer = Task.CompletedTask;
        bool waited = true;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
            if (change)
            {
                writer = Task.Run(() => R5Advance(() => r.Server.MetadataCountryCode = "AU", r.Arr.Plugin.Core.Logger));
                await Task.Delay(150);
                waited = !writer.IsCompleted && r.Server.MetadataCountryCode == "US";
            }
        }
        finally { release.TrySetResult(); }
        using var response = await responseTask.WaitAsync(TimeSpan.FromSeconds(10));
        var body = await response.Content.ReadAsStringAsync();
        await writer.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(waited, "The evidence writer advanced while the owner's final check had passed and HTTP headers were still uncommitted.");
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(603, JsonDocument.Parse(body).RootElement.GetProperty("id").GetInt32());
        if (change)
        {
            Assert.False(r.Gate.MaySeeAbsent("movie", 603, r.User.Id.ToString("N"), out _));
            using var refused = await client.GetAsync("/JellyfinEnhanced/tmdb/movie/603");
            Assert.Equal(System.Net.HttpStatusCode.Forbidden, refused.StatusCode);
        }
    }

    // Runtime fallback keeps the exact witness executable against the original production DLL, without new API failures.
    private static void R5Advance(Action mutation, Jellyfin.Plugin.JellyfinEnhanced.Logger logger)
    {
        var owner = typeof(PrivacyResponseGuard).Assembly.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.EvidenceRevision");
        if (owner == null) { mutation(); return; }
        owner.GetMethod("Advance", BindingFlags.Static | BindingFlags.NonPublic, new[] { typeof(Action), typeof(Jellyfin.Plugin.JellyfinEnhanced.Logger) })!
            .Invoke(null, new object[] { mutation, logger });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task R4EvidenceMustHoldAtActualHttpCommit(bool revokeAtCommit)
    {
        using var r = new Rig();
        var startRan = false;
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(
            new Microsoft.AspNetCore.Hosting.WebHostBuilder()
                .ConfigureServices(services => services.AddControllers())
                .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    var controller = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
                    controller.ControllerContext = new() { HttpContext = http };
                    var context = EndpointRouting.Bind(http);
                    var spoilers = new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>());
                    var filter = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager, spoilers, r.Library,
                        Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(),
                        new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                    var resource = new ResourceExecutingContext(context, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                    filter.OnResourceExecuting(resource);
                    await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
                    {
                        var admitted = await controller.ProxyTmdbRequest("movie/603");
                        var result = new ResultExecutingContext(context, new List<IFilterMetadata>(), admitted, controller);
                        filter.OnResultExecuting(result);
                        Assert.NotNull(PrivacyResponseGuard.Find(http));
                        // A real ASP.NET header-start callback, before the guard validates and releases any bytes.
                        http.Response.OnStarting(() =>
                        {
                            startRan = true;
                            if (revokeAtCommit) MoveCountry(r, "AU");
                            return Task.CompletedTask;
                        });
                        await result.Result.ExecuteResultAsync(context);
                        return new ResourceExecutedContext(context, new List<IFilterMetadata>());
                    });
                })));
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/JellyfinEnhanced/tmdb/movie/603");
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(startRan);
        if (revokeAtCommit)
        {
            Assert.False(r.Gate.MaySeeAbsent("movie", 603, r.User.Id.ToString("N"), out _));
            Assert.True(response.StatusCode == System.Net.HttpStatusCode.ServiceUnavailable,
                "Evidence revoked before guarded HTTP commit, but status=" + (int)response.StatusCode + "; body=" + body);
        }
        else Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
    }

    // Real MVC result executors and ASP.NET header-start callbacks, after a production admission.
    [Theory]
    [InlineData("physical", "GET", true)] [InlineData("physical", "GET", false)]
    [InlineData("lazy", "GET", true)] [InlineData("lazy", "GET", false)]
    [InlineData("iresult", "GET", true)] [InlineData("iresult", "GET", false)]
    [InlineData("summary", "GET", true)] [InlineData("summary", "GET", false)]
    public async Task R5PhysicalLazyAndCustomResultsRemainHeld(string kind, string method, bool revoke)
    {
        using var r = new Rig();
        using var physical = new R5TempFile();
        var ran = false;
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, false);
                var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
                {
                    ControllerTypeInfo = typeof(AcquireListImportController).GetTypeInfo(),
                    ControllerName = "AcquireListImport", ActionName = kind == "import-fetch" ? "FetchSource" : "Resolve",
                };
                var action = new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
                var filters = new List<IFilterMetadata>();
                var resource = new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                var owner = new PrivacyCommitFilter();
                await owner.OnResourceExecutionAsync(resource, async () =>
                {
                    // The import reader/other action's first evidence read follows resource admission.
                    Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
                    IActionResult result = kind switch
                    {
                        "physical" => new PhysicalFileResult(physical.Path, "text/plain"),
                        "lazy" => new ObjectResult(R5LazyTitles()),
                        "iresult" => new R5HttpResult(Results.Text("private evidence title")),
                        "summary" => new ObjectResult(new { count = 1, allowed = true, id = 603 }),
                        "object" or "import-resolve" or "import-fetch" => new ObjectResult(new { title = "private evidence title" }),
                        "file" => new FileContentResult(System.Text.Encoding.UTF8.GetBytes("private evidence title"), "image/jpeg") { FileDownloadName = "private evidence title.jpg" },
                        "stream" => new FileStreamResult(new MemoryStream(System.Text.Encoding.UTF8.GetBytes("private evidence title")), "image/jpeg") { FileDownloadName = "private evidence title.jpg" },
                        "304" => new StatusCodeResult(304),
                        "pending" or "busy" => new ObjectResult(new ListErrorDto { Code = kind == "pending" ? "parental_pending" : "busy", Message = "private evidence title" }) { StatusCode = kind == "pending" ? 504 : 429 },
                        "exception" => new ObjectResult(new { title = "private evidence error" }) { StatusCode = 500 },
                        _ => new ContentResult { Content = "private evidence title", ContentType = "text/plain" },
                    };
                    var executing = new ResultExecutingContext(action, filters, result, new object());
                    // Discover and arbitrary POSTs do not need a JSON presentation filter to own HTTP publication.
                    if (kind == "pre-result") MoveCountry(r, "AU");
                    // Resolve the optional pre-result hook at runtime: baseline's sealed owner did not implement it.
                    // A compiled interface call against the new owner is not a valid mixed-DLL baseline probe.
                    owner.GetType().GetMethod("OnResultExecuting")?.Invoke(owner, new object[] { executing });
                    http.Response.Headers.ETag = "\"old-private\"";
                    http.Response.Headers.LastModified = "Wed, 21 Oct 2015 07:28:00 GMT";
                    http.Response.OnStarting(() =>
                    {
                        ran = true;
                        if (revoke) MoveCountry(r, "AU");
                        return Task.CompletedTask;
                    });
                    await executing.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, filters);
                });
            })));
        using var client = server.CreateClient();
        using var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), "/publication"));
        Assert.True(ran);
        if (kind is "pending" or "busy")
        {
            Assert.Equal(kind == "pending" ? 504 : 429, (int)response.StatusCode);
            Assert.DoesNotContain("private evidence title", await response.Content.ReadAsStringAsync());
            Assert.Equal("2", response.Headers.RetryAfter!.ToString());
            Assert.Null(response.Headers.ETag);
        }
        else if (revoke)
        {
            Assert.Equal(System.Net.HttpStatusCode.ServiceUnavailable, response.StatusCode);
            Assert.Empty(await response.Content.ReadAsByteArrayAsync());
            Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
            Assert.Equal("1", response.Headers.RetryAfter!.ToString());
            Assert.Null(response.Headers.ETag);
            Assert.Null(response.Content.Headers.LastModified);
            Assert.Null(response.Content.Headers.ContentDisposition);
        }
        else
        {
            Assert.Equal(kind == "304" ? System.Net.HttpStatusCode.NotModified : System.Net.HttpStatusCode.OK, response.StatusCode);
            if (kind == "summary") Assert.Contains("\"allowed\":true", await response.Content.ReadAsStringAsync());
            else if (kind != "304" && method != "HEAD") Assert.Contains("private evidence title", await response.Content.ReadAsStringAsync());
        }
    }

    private static async IAsyncEnumerable<string> R5LazyTitles()
    {
        await Task.Yield();
        yield return "private evidence title";
    }

    [Theory]
    [InlineData("object", "GET", true)] [InlineData("object", "GET", false)]
    [InlineData("content", "GET", true)] [InlineData("file", "GET", true)]
    [InlineData("stream", "GET", true)] [InlineData("stream", "GET", false)]
    [InlineData("file", "HEAD", true)] [InlineData("file", "HEAD", false)]
    [InlineData("304", "GET", true)] [InlineData("304", "GET", false)]
    [InlineData("short-circuit", "GET", true)] [InlineData("exception", "GET", true)]
    [InlineData("pre-result", "GET", true)]
    [InlineData("pending", "POST", true)] [InlineData("busy", "POST", true)]
    [InlineData("import-resolve", "POST", true)] [InlineData("import-fetch", "POST", true)]
    public async Task R4EveryResultCommitsUnderItsAdmission(string kind, string method, bool revoke)
    {
        using var r = new Rig();
        var ran = false;
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, false);
                var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
                {
                    ControllerTypeInfo = typeof(AcquireListImportController).GetTypeInfo(),
                    ControllerName = "AcquireListImport", ActionName = kind == "import-fetch" ? "FetchSource" : "Resolve",
                };
                var action = new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
                var filters = new List<IFilterMetadata>();
                var resource = new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                var owner = new PrivacyCommitFilter();
                await owner.OnResourceExecutionAsync(resource, async () =>
                {
                    // The import reader/other action's first evidence read follows resource admission.
                    Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
                    IActionResult result = kind switch
                    {
                        "object" or "import-resolve" or "import-fetch" => new ObjectResult(new { title = "private evidence title" }),
                        "file" => new FileContentResult(System.Text.Encoding.UTF8.GetBytes("private evidence title"), "image/jpeg") { FileDownloadName = "private evidence title.jpg" },
                        "stream" => new FileStreamResult(new MemoryStream(System.Text.Encoding.UTF8.GetBytes("private evidence title")), "image/jpeg") { FileDownloadName = "private evidence title.jpg" },
                        "304" => new StatusCodeResult(304),
                        "pending" or "busy" => new ObjectResult(new ListErrorDto { Code = kind == "pending" ? "parental_pending" : "busy", Message = "private evidence title" }) { StatusCode = kind == "pending" ? 504 : 429 },
                        "exception" => new ObjectResult(new { title = "private evidence error" }) { StatusCode = 500 },
                        _ => new ContentResult { Content = "private evidence title", ContentType = "text/plain" },
                    };
                    var executing = new ResultExecutingContext(action, filters, result, new object());
                    // Discover and arbitrary POSTs do not need a JSON presentation filter to own HTTP publication.
                    if (kind == "pre-result") MoveCountry(r, "AU");
                    // Resolve the optional pre-result hook at runtime: baseline's sealed owner did not implement it.
                    // A compiled interface call against the new owner is not a valid mixed-DLL baseline probe.
                    owner.GetType().GetMethod("OnResultExecuting")?.Invoke(owner, new object[] { executing });
                    http.Response.Headers.ETag = "\"old-private\"";
                    http.Response.Headers.LastModified = "Wed, 21 Oct 2015 07:28:00 GMT";
                    http.Response.OnStarting(() =>
                    {
                        ran = true;
                        if (revoke) MoveCountry(r, "AU");
                        return Task.CompletedTask;
                    });
                    await executing.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, filters);
                });
            })));
        using var client = server.CreateClient();
        using var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), "/publication"));
        Assert.True(ran);
        if (kind is "pending" or "busy")
        {
            Assert.Equal(kind == "pending" ? 504 : 429, (int)response.StatusCode);
            Assert.DoesNotContain("private evidence title", await response.Content.ReadAsStringAsync());
            Assert.Equal("2", response.Headers.RetryAfter!.ToString());
            Assert.Null(response.Headers.ETag);
        }
        else if (revoke)
        {
            Assert.Equal(System.Net.HttpStatusCode.ServiceUnavailable, response.StatusCode);
            Assert.Empty(await response.Content.ReadAsByteArrayAsync());
            Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
            Assert.Equal("1", response.Headers.RetryAfter!.ToString());
            Assert.Null(response.Headers.ETag);
            Assert.Null(response.Content.Headers.LastModified);
            Assert.Null(response.Content.Headers.ContentDisposition);
        }
        else
        {
            Assert.Equal(kind == "304" ? System.Net.HttpStatusCode.NotModified : System.Net.HttpStatusCode.OK, response.StatusCode);
            if (kind != "304" && method != "HEAD") Assert.Contains("private evidence title", await response.Content.ReadAsStringAsync());
        }
    }

    [Theory]
    [InlineData(false, false)] [InlineData(false, true)]
    [InlineData(true, false)] [InlineData(true, true)]
    public async Task R4DiscoverHandsFinalPublicationToHttpOwner(bool partial, bool revokeAtCommit)
    {
        using var r = new Rig();
        if (partial) r.Evidence = (_, _) => Task.FromResult<string?>(null);
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, false);
                var action = EndpointRouting.Bind(http);
                var resource = new ResourceExecutingContext(action, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
                {
                    var controller = new AcquireDiscoverController(r.Discover) { ControllerContext = new() { HttpContext = http } };
                    var result = await controller.Discover("trending", "movie");
                    http.Response.OnStarting(() =>
                    {
                        if (revokeAtCommit) MoveCountry(r, "AU");
                        return Task.CompletedTask;
                    });
                    await result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, new List<IFilterMetadata>());
                });
            })));
        using var client = server.CreateClient();
        using var response = await client.GetAsync("/JellyfinEnhanced/acquire/discover");
        var body = await response.Content.ReadAsStringAsync();
        Assert.Equal(revokeAtCommit ? System.Net.HttpStatusCode.ServiceUnavailable : System.Net.HttpStatusCode.OK, response.StatusCode);
        if (revokeAtCommit) { Assert.Empty(body); Assert.Contains("no-store", response.Headers.CacheControl!.ToString()); }
        else if (partial) { Assert.Contains("\"complete\":false", body); Assert.Contains("evidence_unavailable", body); }
        else Assert.Contains("Visible only when verified", body);
    }

    [Theory]
    [InlineData(false, false)] [InlineData(false, true)]
    [InlineData(true, false)] [InlineData(true, true)]
    public async Task R4ImportHttpKeepsTypedParentalPending(bool preview, bool move)
    {
        using var r = new Rig();
        ImportTestFlags.AllOn(r.Arr.Plugin.Plugin.Configuration);
        var access = new ListAccessService(new FakeListHost(), r.Users, r.Gate, r.Arr.Plugin.Core.Logger);
        var lookup = new FakeImportLookup(); lookup.AddSearch("Allowed", FakeImportLookup.Movie(603, "Allowed", "2000-01-01"));
        var viewer = new MovingImportView(() => { if (move) MoveCountry(r, "AU"); });
        var resolver = new ListImportResolver(lookup, new FakeLibraryLookup(), access,
            new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), r.Arr.Plugin.Core.Logger, viewer);
        var fetcher = new FakeSourceFetcher { Items = new() { new SourceItem("movie", 603, null, null, "Allowed", 2000, null, null, null) } };
        var source = new ListSourcePreview(fetcher, resolver, access, r.Arr.Plugin.Core.Logger, viewer);
        var controller = new AcquireListImportController(r.Users, access, resolver, source, r.Arr.Plugin.Core.Logger)
            { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(r.User.Id, false);
        controller.HttpContext.Request.Method = "POST";
        controller.HttpContext.Request.Path = "/JellyfinEnhanced/acquire/lists/import/" + (preview ? "source" : "resolve");
        var actionName = preview ? "FetchSource" : "Resolve";
        var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
        {
            ControllerTypeInfo = controller.GetType().GetTypeInfo(), ControllerName = "AcquireListImport", ActionName = actionName,
            MethodInfo = controller.GetType().GetMethod(actionName)!,
        };
        var context = new Microsoft.AspNetCore.Mvc.ActionContext(controller.HttpContext, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
        var spoilers = new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>());
        using var services = new ServiceCollection().AddSingleton(r.Gate).BuildServiceProvider();
        var filter = ActivatorUtilities.CreateInstance<TitlePresentationResultFilter>(services, r.Arr.Plugin.Core.Manager, spoilers, r.Library,
            Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!));
        filter.OnResourceExecuting(new ResourceExecutingContext(context, new List<IFilterMetadata>(), new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>()));
        IActionResult answer = preview
            ? await controller.FetchSource(new SourceFetchRequest { Url = "https://mdblist.com/lists/test/list" }, default)
            : await controller.Resolve(new ResolveRequest { Entries = new() { new ImportEntryDto { Title = "Allowed", Year = 2000, TypeHint = "movie" } } }, default);
        var expected = move ? 504 : 200;
        var original = Assert.IsAssignableFrom<ObjectResult>(answer);
        Assert.Equal(expected, original.StatusCode);
        if (move) Assert.Equal("parental_pending", Assert.IsType<ListErrorDto>(original.Value).Code);
        var result = new ResultExecutingContext(context, new List<IFilterMetadata>(), answer, controller);
        filter.OnResultExecuting(result);
        var delivered = result.Result switch { ObjectResult obj => obj.StatusCode, StatusCodeResult status => status.StatusCode, _ => null };
        Assert.True(delivered == expected, $"Controller answered {expected}; final filter delivered {delivered} for {actionName} (move={move})");
        if (move) Assert.Equal("parental_pending", Assert.IsType<ListErrorDto>(Assert.IsAssignableFrom<ObjectResult>(result.Result).Value).Code);
    }

    [Theory]
    [InlineData(false, false)] [InlineData(false, true)]
    [InlineData(true, false)] [InlineData(true, true)]
    public async Task R4CollageProjectionRemainsInsideTheHttpCommitOwner(bool revoke, bool guardedObject)
    {
        using var r = new Rig();
        var markers = Path.Combine(r.Arr.Plugin.Core.Root, "collage-markers");
        Directory.CreateDirectory(markers);
        File.WriteAllText(Path.Combine(markers, Guid.NewGuid().ToString("N") + ".json"), "{}");
        var collage = new LegacyCollageBody(new LegacyCollageWithhold(new[] { markers }, r.Library), r.Arr.Plugin.Core.Logger);
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, false);
                var action = EndpointRouting.Bind(http);
                var filters = new List<IFilterMetadata>();
                var resource = new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                var owner = new PrivacyCommitFilter();
                // Same order as production registration, including the pre-redesign order in the baseline DLL.
                ResourceExecutionDelegate execute = async () =>
                {
                    var spoilers = new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>());
                    var projection = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager, spoilers, r.Library,
                        Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                    projection.OnResourceExecuting(resource);
                    Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
                    IActionResult result;
                    if (guardedObject)
                    {
                        using var reads = PrivacyReadSet.Begin();
                        var guard = PrivacyResponseGuard.Install(http, reads.Reads)!;
                        result = PrivacyResponseGuard.Guarded(new ObjectResult(new { title = "private collage answer" }), guard);
                    }
                    else result = new ContentResult { Content = "{\"title\":\"private collage answer\"}", ContentType = "application/json" };
                    http.Response.OnStarting(() => { if (revoke) MoveCountry(r, "AU"); return Task.CompletedTask; });
                    await result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, filters);
                };
                if (owner.Order < LegacyCollageBody.Order)
                    await owner.OnResourceExecutionAsync(resource, async () => { await collage.OnResourceExecutionAsync(resource, execute); return new ResourceExecutedContext(action, filters); });
                else
                    await collage.OnResourceExecutionAsync(resource, async () => { await owner.OnResourceExecutionAsync(resource, execute); return new ResourceExecutedContext(action, filters); });
            })));
        using var response = await server.CreateClient().GetAsync("/JellyfinEnhanced/tmdb/movie/603");
        var body = await response.Content.ReadAsStringAsync();
        Assert.Equal(revoke ? System.Net.HttpStatusCode.ServiceUnavailable : System.Net.HttpStatusCode.OK, response.StatusCode);
        if (revoke) { Assert.Empty(body); Assert.Null(response.Headers.ETag); Assert.Contains("no-store", response.Headers.CacheControl!.ToString()); }
        else Assert.Contains("private collage answer", body);
    }

    [Theory]
    [InlineData("unhandled")]
    public async Task R5KestrelUnhandledErrorRemainsOwnedByHost(string mode)
    {
        using var r = new Rig();
        using var server = new WebHostBuilder().UseKestrel().UseUrls("http://127.0.0.1:0")
            .ConfigureServices(services =>
            {
                services.AddSingleton(r.Gate);
                services.AddControllers(options =>
                {
                    options.Filters.Add(new PrivacyCommitFilter());
                    if (mode != "unhandled") options.Filters.Add(new R4LifecycleFilter(() => MoveCountry(r, "AU")));
                    options.Conventions.Add(new R4LifecycleConvention());
                }).AddApplicationPart(typeof(R4LifecycleController).Assembly);
            })
            .Configure(app =>
            {
                Microsoft.AspNetCore.Builder.UseExtensions.Use(app, async (http, next) =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    try { await next(); }
                    catch (InvalidOperationException) when (mode == "unhandled")
                    {
                        Assert.False(http.Response.HasStarted, "Owner committed before the host could handle an unhandled MVC exception");
                        http.Response.StatusCode = 500;
                        http.Response.ContentLength = 0;
                    }
                });
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseRouting(app);
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseEndpoints(app, endpoints => Microsoft.AspNetCore.Builder.ControllerEndpointRouteBuilderExtensions.MapControllers(endpoints));
            }).Build();
        await server.StartAsync();
        var address = server.ServerFeatures.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.Single();
        using var client = new HttpClient { BaseAddress = new Uri(address) };
        using var response = await client.GetAsync("/r4-lifecycle/" + mode);
        Assert.Equal(mode == "unhandled" ? System.Net.HttpStatusCode.InternalServerError : System.Net.HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync());
        if (mode != "unhandled") Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
    }

    [Theory]
    [InlineData("short")] [InlineData("exception")] [InlineData("unhandled")]
    public async Task R4MvcShortCircuitAndExceptionResultsReachTheOwner(string mode)
    {
        using var r = new Rig();
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services =>
            {
                services.AddSingleton(r.Gate);
                services.AddControllers(options =>
                {
                    options.Filters.Add(new PrivacyCommitFilter());
                    if (mode != "unhandled") options.Filters.Add(new R4LifecycleFilter(() => MoveCountry(r, "AU")));
                    options.Conventions.Add(new R4LifecycleConvention());
                }).AddApplicationPart(typeof(R4LifecycleController).Assembly);
            })
            .Configure(app =>
            {
                Microsoft.AspNetCore.Builder.UseExtensions.Use(app, async (http, next) =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    try { await next(); }
                    catch (InvalidOperationException) when (mode == "unhandled")
                    {
                        Assert.False(http.Response.HasStarted, "Owner committed before the host could handle an unhandled MVC exception");
                        http.Response.StatusCode = 500;
                        http.Response.ContentLength = 0;
                    }
                });
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseRouting(app);
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseEndpoints(app, endpoints => Microsoft.AspNetCore.Builder.ControllerEndpointRouteBuilderExtensions.MapControllers(endpoints));
            }));
        using var response = await server.CreateClient().GetAsync("/r4-lifecycle/" + mode);
        Assert.Equal(mode == "unhandled" ? System.Net.HttpStatusCode.InternalServerError : System.Net.HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync());
        if (mode != "unhandled") Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task R5CollageDoesNotLoseAnonymousJsonOrSettingsAcknowledgements(bool acknowledgement)
    {
        using var r = new Rig();
        var markers = Path.Combine(r.Arr.Plugin.Core.Root, "empty-collage-markers"); Directory.CreateDirectory(markers);
        var collage = new LegacyCollageBody(new LegacyCollageWithhold(new[] { markers }, r.Library), r.Arr.Plugin.Core.Logger);
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                if (acknowledgement) http.User = TestCallers.Principal(r.User.Id, false);
                var action = new ActionContext(http, new(), new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
                {
                    ControllerTypeInfo = (acknowledgement ? typeof(ConfigurationPatchController) : typeof(JellyfinEnhancedController)).GetTypeInfo(),
                    ControllerName = acknowledgement ? "ConfigurationPatch" : "JellyfinEnhanced", ActionName = acknowledgement ? "Patch" : "GetPublicConfig",
                });
                var filters = new List<IFilterMetadata>();
                var resource = new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                await new PrivacyCommitFilter().OnResourceExecutionAsync(resource, async () =>
                {
                    await collage.OnResourceExecutionAsync(resource, async () =>
                    {
                        var projection = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager,
                            new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>()), r.Library,
                            Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                        projection.OnResourceExecuting(resource);
                        IActionResult answer = acknowledgement ? new ObjectResult(new { success = true }) : new JsonResult(new { configured = true });
                        await answer.ExecuteResultAsync(action);
                        return new ResourceExecutedContext(action, filters);
                    });
                    return new ResourceExecutedContext(action, filters);
                });
            })));
        using var response = await server.CreateClient().GetAsync("/JellyfinEnhanced/" + (acknowledgement ? "configuration" : "public-config"));
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(acknowledgement ? "\"success\":true" : "\"configured\":true", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("ToastDuration", "1601")]
    [InlineData("TMDB_API_KEY", "\"replacement-only-test\"")]
    [InlineData("ArrRequestBackend", "\"seerr\"")]
    public async Task R5SuccessfulConfigurationPatchKeepsItsAcknowledgement(string field, string raw)
    {
        using var r = new Rig();
        var beforeRevision = r.Gate.EvidenceRevision;
        Assert.True(await r.Gate.MaySeeAbsentAsync("movie", 603, r.User.Id.ToString("N"), default));
        r.User.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator, true);
        r.User.MaxParentalRatingScore = null;
        var applied = false;
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, true);
                var controller = new ConfigurationPatchController(r.Users, r.Arr.Plugin.Core.Logger) { ControllerContext = new() { HttpContext = http } };
                var descriptor = new Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor
                {
                    ControllerTypeInfo = controller.GetType().GetTypeInfo(), ControllerName = "ConfigurationPatch", ActionName = "Patch", MethodInfo = controller.GetType().GetMethod("Patch")!,
                };
                var action = new ActionContext(http, new Microsoft.AspNetCore.Routing.RouteData(), descriptor);
                var filters = new List<IFilterMetadata>();
                var owner = new PrivacyCommitFilter();
                await owner.OnResourceExecutionAsync(new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>()), async () =>
                {
                    var result = controller.Patch(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch { Set = new() { [field] = JsonDocument.Parse(raw).RootElement.Clone() } });
                    Assert.IsType<OkObjectResult>(result);
                    var saved = field == "TMDB_API_KEY" ? JsonSerializer.SerializeToElement(r.Arr.Plugin.Plugin.Configuration.GetTmdbApiKey()) : JsonSerializer.SerializeToElement(r.Arr.Plugin.Plugin.Configuration).GetProperty(field);
                    Assert.Equal(raw, saved.GetRawText());
                    applied = true;
                    var executing = new ResultExecutingContext(action, filters, result, controller);
                    owner.GetType().GetMethod("OnResultExecuting")?.Invoke(owner, new object[] { executing });
                    await executing.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, filters);
                });
            })));
        using var response = await server.CreateClient().SendAsync(new HttpRequestMessage(HttpMethod.Patch, "/JellyfinEnhanced/configuration"));
        Assert.True(applied);
        Assert.True((int)response.StatusCode == 200, $"Persisted {field} successfully, but HTTP acknowledgement was {(int)response.StatusCode}");
        Assert.Contains("\"success\":true", await response.Content.ReadAsStringAsync());
        if (field != "ToastDuration") Assert.NotEqual(beforeRevision, r.Gate.EvidenceRevision);
        if (field == "TMDB_API_KEY")
        {
            r.User.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator, false);
            r.User.MaxParentalRatingScore = 10;
            r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id, "R"));
            var next = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
            next.HttpContext.User = TestCallers.Principal(r.User.Id, false);
            Assert.Equal(403, Assert.IsType<ObjectResult>(await next.ProxyTmdbRequest("movie/603")).StatusCode);
        }

    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task R5HostCanWriteAnUnhandledErrorBody(bool writeBody)
    {
        using var r = new Rig();
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services =>
            {
                services.AddSingleton(r.Gate);
                services.AddControllers(options => { options.Filters.Add(new PrivacyCommitFilter()); options.Conventions.Add(new R4LifecycleConvention()); })
                    .AddApplicationPart(typeof(R4LifecycleController).Assembly);
            })
            .Configure(app =>
            {
                Microsoft.AspNetCore.Builder.UseExtensions.Use(app, async (http, next) =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    try { await next(); }
                    catch (InvalidOperationException)
                    {
                        Assert.False(http.Response.HasStarted);
                        http.Response.StatusCode = 500;
                        if (writeBody) await http.Response.WriteAsync("{\"error\":\"host failure\"}");
                        else http.Response.ContentLength = 0;
                    }
                });
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseRouting(app);
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseEndpoints(app, endpoints => Microsoft.AspNetCore.Builder.ControllerEndpointRouteBuilderExtensions.MapControllers(endpoints));
            }));
        using var response = await server.CreateClient().GetAsync("/r4-lifecycle/unhandled");
        Assert.True((int)response.StatusCode == 500, $"Host error middleware produced 500, delivered {(int)response.StatusCode}");
        if (writeBody) Assert.Contains("host failure", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task R5RoutineSettingsSaveDoesNotBreakLongProxyAnswer(bool admin)
    {
        using var r = new Rig();
        r.User.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator, admin);
        if (admin) r.User.MaxParentalRatingScore = null;
        using var server = new Microsoft.AspNetCore.TestHost.TestServer(new WebHostBuilder()
            .ConfigureServices(services => { services.AddControllers(); services.AddSingleton(r.Gate); })
            .Configure(app => Microsoft.AspNetCore.Builder.RunExtensions.Run(app, async http =>
            {
                http.User = TestCallers.Principal(r.User.Id, admin);
                var controller = ApiAssetTests.Controller(r.Arr.Plugin.Core, r.Tmdb, r.Gate);
                controller.ControllerContext = new() { HttpContext = http };
                var action = EndpointRouting.Bind(http);
                var filters = new List<IFilterMetadata>();
                var resource = new ResourceExecutingContext(action, filters, new List<Microsoft.AspNetCore.Mvc.ModelBinding.IValueProviderFactory>());
                var projection = new TitlePresentationResultFilter(r.Arr.Plugin.Core.Manager, new SpoilerPresentation(r.Arr.Plugin.Core.Manager, r.Library, r.Users, Mock.Of<IUserDataManager>()), r.Library,
                    Mock.Of<MediaBrowser.Controller.IServerApplicationHost>(), new SpoilerFieldStripFilter(null!, r.Library, r.Users, Mock.Of<IUserDataManager>(), null!), parental: r.Gate);
                var owner = new PrivacyCommitFilter();
                await owner.OnResourceExecutionAsync(resource, async () =>
                {
                    projection.OnResourceExecuting(resource);
                    var result = new ResultExecutingContext(action, filters, await controller.ProxyTmdbRequest("movie/603"), controller);
                    projection.OnResultExecuting(result);
                    http.Response.OnStarting(() =>
                    {
                        r.Arr.Plugin.Plugin.PatchConfiguration(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.ConfigurationPatch { Set = new() { ["ToastDuration"] = JsonDocument.Parse("1601").RootElement.Clone() } });
                        return Task.CompletedTask;
                    });
                    await result.Result.ExecuteResultAsync(action);
                    return new ResourceExecutedContext(action, filters);
                });
            })));
        using var response = await server.CreateClient().GetAsync("/JellyfinEnhanced/tmdb/movie/603");
        Assert.Equal(200, (int)response.StatusCode);
        Assert.NotEmpty(await response.Content.ReadAsByteArrayAsync());
    }

    [Theory]
    [InlineData(false, false)] [InlineData(true, false)]
    [InlineData(false, true)] [InlineData(true, true)]
    public async Task R5RealJellyfinErrorMiddlewareKeepsItsStatus(bool ownerEnabled, bool kestrel)
    {
        using var r = new Rig();
        var type = Assembly.LoadFrom(JellyfinApiAssembly.Pinned("jf12").Path).GetType("Jellyfin.Api.Middleware.ExceptionMiddleware", throwOnError: true)!;
        var logger = Activator.CreateInstance(typeof(Microsoft.Extensions.Logging.Abstractions.NullLogger<>).MakeGenericType(type))!;
        var environment = new Mock<IWebHostEnvironment>();
        environment.SetupGet(e => e.EnvironmentName).Returns("Production");
        var builder = new WebHostBuilder()
            .ConfigureServices(services =>
            {
                services.AddSingleton(r.Gate);
                services.AddControllers(options => { if (ownerEnabled) options.Filters.Add(new PrivacyCommitFilter()); options.Conventions.Add(new R4LifecycleConvention()); })
                    .AddApplicationPart(typeof(R4LifecycleController).Assembly);
            })
            .Configure(app =>
            {
                Microsoft.AspNetCore.Builder.UseExtensions.Use(app, async (http, next) =>
                {
                    http.User = TestCallers.Principal(r.User.Id, false);
                    var middleware = Activator.CreateInstance(type, new RequestDelegate(_ => next()), logger, Mock.Of<IServerConfigurationManager>(), environment.Object)!;
                    await (Task)type.GetMethod("Invoke")!.Invoke(middleware, new object[] { http })!;
                });
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseRouting(app);
                Microsoft.AspNetCore.Builder.EndpointRoutingApplicationBuilderExtensions.UseEndpoints(app, endpoints => Microsoft.AspNetCore.Builder.ControllerEndpointRouteBuilderExtensions.MapControllers(endpoints));
            });
        using var test = !kestrel ? new Microsoft.AspNetCore.TestHost.TestServer(builder) : null;
        using var server = kestrel ? builder.UseKestrel().UseUrls("http://127.0.0.1:0").Build() : null;
        if (server != null) await server.StartAsync();
        using var client = test?.CreateClient() ?? new HttpClient { BaseAddress = new Uri(server!.ServerFeatures.Get<Microsoft.AspNetCore.Hosting.Server.Features.IServerAddressesFeature>()!.Addresses.Single()) };
        using var response = await client.GetAsync("/r4-lifecycle/unhandled");
        Assert.True((int)response.StatusCode == 500, $"Jellyfin 12.2 ExceptionMiddleware: owner={ownerEnabled}, delivered {(int)response.StatusCode}");
        Assert.Equal("Error processing request.", await response.Content.ReadAsStringAsync());
    }

}


// Test-only MVC lifecycle controls: a native facade action identity, with no production route added.
[ApiController]
[Route("r4-lifecycle")]
public sealed class R4LifecycleController : ControllerBase
{
    [HttpGet("{mode}")]
    public IActionResult Read(string mode) => throw new InvalidOperationException("handled test exception");
}

internal sealed class R4LifecycleConvention : Microsoft.AspNetCore.Mvc.ApplicationModels.IControllerModelConvention
{
    public void Apply(Microsoft.AspNetCore.Mvc.ApplicationModels.ControllerModel controller)
    {
        if (controller.ControllerType != typeof(R4LifecycleController)) return;
        controller.ControllerName = "UserLibrary";
        foreach (var action in controller.Actions) action.ActionName = "GetItem";
    }
}

internal sealed class R4LifecycleFilter(Action move) : IResourceFilter, IExceptionFilter
{
    private void Start(HttpContext http) => http.Response.OnStarting(() => { move(); return Task.CompletedTask; });
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        if (!context.HttpContext.Request.Path.Value!.EndsWith("/short", StringComparison.Ordinal)) return;
        Start(context.HttpContext);
        context.Result = new ObjectResult(new { title = "private short circuit" });
    }
    public void OnResourceExecuted(ResourceExecutedContext context) { }
    public void OnException(ExceptionContext context)
    {
        Start(context.HttpContext);
        context.Result = new ObjectResult(new { title = "private exception result" }) { StatusCode = 500 };
        context.ExceptionHandled = true;
    }
}

internal sealed class R5HostTimingLogger<T>(Action observe) : Microsoft.Extensions.Logging.ILogger<T>
{
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;
    public void Log<TState>(Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => observe();
}

internal sealed class R5HttpResult(IResult result) : IActionResult
{
    public Task ExecuteResultAsync(ActionContext context) => result.ExecuteAsync(context.HttpContext);
}
internal sealed class R5TempFile : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "r5-physical-" + Guid.NewGuid().ToString("N") + ".txt");
    public R5TempFile() => File.WriteAllText(Path, "private evidence title");
    public void Dispose() => File.Delete(Path);
}
