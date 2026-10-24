using System.Diagnostics;
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
        public ILibraryManager Library { get; }
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
            var localization = new Mock<ILocalizationManager>();
            localization.Setup(m => m.GetRatingScore("G", "US")).Returns(new ParentalRatingScore(1, null));
            localization.Setup(m => m.GetRatingScore("R", "US")).Returns(new ParentalRatingScore(18, null));
            localization.Setup(m => m.GetRatingScore("THROWS", "US")).Throws(new InvalidOperationException("unscorable"));
            var server = new Mock<IServerConfigurationManager>(); server.SetupGet(m => m.Configuration).Returns(Server);
            var library = new Mock<ILibraryManager>(); library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
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
        public async Task<(int Status, JsonElement Body, AcquireDiscoverController Controller)> Read(bool search = false, string query = "family")
        {
            var c = new AcquireDiscoverController(Discover) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            c.HttpContext.User = TestCallers.Principal(User.Id, false);
            c.HttpContext.Request.Method = "GET";
            c.HttpContext.Request.Path = "/JellyfinEnhanced/acquire/" + (search ? "search" : "discover");
            var result = search ? await c.Search(query) : await c.Discover("trending", "movie");
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
            .CheckTitleAsync(kind, 603, SeerrParentalFilter.PolicyFor(r.User), default));
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
        if (change == "credential") r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        if (change == "region") r.Server.MetadataCountryCode = "AU";
        if (change == "backend") r.Arr.Plugin.Plugin.Configuration.ArrRequestBackend = "status_only";
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
        if (change == "region") r.Server.MetadataCountryCode = "AU";
        else r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
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
        Assert.Equal(503, first.Status);
        Assert.Equal("partial", first.Body.GetProperty("answer").GetProperty("verification").GetString());
        Assert.Equal("evidence_unavailable", first.Body.GetProperty("reason").GetString());
        Assert.Equal("private, no-store", first.Controller.Response.Headers.CacheControl);
        Assert.Empty(first.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.False(first.Body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.True(first.Body.GetProperty("answer").GetProperty("retryAfterSeconds").GetInt32() > 0);
        r.Evidence = (id, _) => Task.FromResult<string?>(IntegrationParentalEvidenceTests.Movie(id));
        r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "recovered-source";
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
        r.Arr.Plugin.Plugin.Configuration.TMDB_API_KEY = "replacement-source";
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
        Assert.Equal(503, result.Status);
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
            .CheckTitleAsync("movie", 603, SeerrParentalFilter.PolicyFor(r.User), default));
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
        Assert.Equal(503, result.Status);
        Assert.Single(result.Body.GetProperty("answer").GetProperty("results").EnumerateArray());
        Assert.DoesNotContain("Became absent", result.Body.GetRawText());
    }

    [Fact]
    public async Task TwentyDeferredTitlesHaveOneDeadlineIncludingSlotWaitsAndWarmAfterRelease()
    {
        using var r = new Rig();
        r.Page = IntegrationRequestDiscoverTests.Page(Enumerable.Range(600, 20).Select(id => IntegrationRequestDiscoverTests.Movie(id, "Title " + id)).ToArray());
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var reads = new System.Collections.Concurrent.ConcurrentDictionary<int, int>();
        r.Evidence = async (id, ct) => { reads.AddOrUpdate(id, 1, (_, n) => n + 1); if (reads.Count == 8) started.TrySetResult(); await release.Task.WaitAsync(ct); return IntegrationParentalEvidenceTests.Movie(id); };
        var clock = Stopwatch.StartNew(); var first = r.Read();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = r.Read(true); // Competes for the same eight slots.
        try
        {
            var result = await first.WaitAsync(TimeSpan.FromSeconds(4));
            Assert.Equal(503, result.Status); Assert.True(clock.Elapsed < TimeSpan.FromSeconds(4));
            Assert.Equal(503, (await second.WaitAsync(TimeSpan.FromSeconds(4))).Status);
        }
        finally { release.TrySetResult(); await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(10)); }
        var recovered = await r.Read();
        Assert.Equal(200, recovered.Status);
        Assert.Equal(20, recovered.Body.GetProperty("answer").GetProperty("results").GetArrayLength());
        Assert.All(reads.Values, n => Assert.Equal(1, n)); // Shared reads survive abandoned waiters.
    }
}
