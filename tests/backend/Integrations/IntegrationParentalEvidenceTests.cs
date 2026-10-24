using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Mvc;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationParentalEvidenceTests
{
    [Theory]
    [InlineData("MayOpenLocal")]
    [InlineData("TryReadLocal")]
    public void LocalEvidenceDecisionsUseTheAvailabilityOwner(string method)
    {
        var source = Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", "TitleParentalEvidence.cs");
        var body = CSharpSyntaxTree.ParseText(File.ReadAllText(source)).GetRoot().DescendantNodes()
            .OfType<MethodDeclarationSyntax>().Single(m => m.Identifier.ValueText == method);
        var reads = body.DescendantNodes().OfType<MemberAccessExpressionSyntax>().ToArray();
        Assert.DoesNotContain(reads, r => r.Name.Identifier.ValueText is "IsVirtualItem" or "IsPlaceHolder" or "Playable");
        Assert.Contains(body.DescendantNodes().OfType<InvocationExpressionSyntax>(),
            call => call.Expression.ToString() == "EditionAvailability.Plays");
    }

    [Theory]
    [InlineData("movie", "/movies/a.mkv", false, "603", true)]
    [InlineData("movie", "/movies/a.disc", false, "603", true)]
    [InlineData("tv", "/shows/a", false, "603", true)]
    [InlineData("movie", "/movies/a.mkv", true, "603", false)]
    [InlineData("tv", "/shows/a", true, "603", false)]
    [InlineData("movie", "relative/a.mkv", false, "603", false)]
    [InlineData("tv", "relative/a", false, "603", false)]
    [InlineData("movie", "", false, "603", false)]
    [InlineData("movie", " ", false, "603", false)]
    [InlineData("tv", null, false, "603", false)]
    [InlineData("movie", "/movies/a.mkv", false, "604", false)]
    public void LocalEvidenceProjectionPreservesPhysicalIdentityAndUserEntitlement(string kind, string? path, bool virtualItem, string providerId, bool physical)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var user = FakeListHost.MakeUser("Member");
        BaseItem item = kind == "movie" ? new Movie() : new MediaBrowser.Controller.Entities.TV.Series();
        item.Id = Guid.NewGuid(); item.Path = path; item.IsVirtualItem = virtualItem;
        item.CustomRating = "G"; item.Tags = new[] { "local!" }; item.ProviderIds["Tmdb"] = providerId;
        var library = new Mock<ILibraryManager>();
        library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { item });
        library.Setup(m => m.GetItemById<BaseItem>(item.Id, user)).Returns(item);
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Local facts must not use transport"));
        using var tmdb = new TmdbResponseCache(transport, TimeProvider.System);
        var provider = new TitleParentalEvidenceProvider(transport, tmdb, library.Object);
        Assert.Equal(physical, provider.MayOpenLocal(kind, 603, user));
        Assert.Equal(physical, provider.TryReadLocal(kind, 603, "US", out var evidence));
        if (physical) { Assert.Equal("G", evidence!.Certification); Assert.Equal(new[] { "local!" }, evidence.Keywords); }
        else Assert.Null(evidence);
        // User-neutral evidence does not confer entitlement after Jellyfin refuses the scoped item read.
        library.Setup(m => m.GetItemById<BaseItem>(item.Id, user)).Returns((BaseItem?)null);
        Assert.False(provider.MayOpenLocal(kind, 603, user));
        Assert.Equal(physical, provider.TryReadLocal(kind, 603, "US", out _));
        Assert.False(provider.MayOpenLocal(kind, 603, null));
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task JeWithoutSeerrResolvesAllowedTagsThroughTheSharedGate()
    {
        using var plugin = new ApiPluginFixture();
        var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "je";
        config.JellyseerrEnabled = false;
        config.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Kid");
        user.MaxParentalRatingScore = 10;
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "Horror" });
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Equal("api.themoviedb.org", request.RequestUri!.Host);
            return Task.FromResult(IntegrationTransport.Response(Movie(603)));
        });
        var gate = Filter(plugin, transport, user);
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.True(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.True(gate.MaySeeAbsent("movie", 603, user.Id.ToString("N"), out var facts));
        Assert.NotNull(facts);
        Assert.True(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.False(await gate.IsBlockedAsync("movie", 603, user.Id.ToString("N")));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task StatusOnlyPreservesTheExistingSeerrMetadataPathWithoutATmdbKey()
    {
        using var plugin = new ApiPluginFixture(); var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "status_only"; config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var user = FakeListHost.MakeUser("Member"); user.SetPreference(PreferenceKind.AllowedTags, new[] { "family" });
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            Movie(603).Replace("\"release_dates\":{\"results\"", "\"releases\":{\"results\"", StringComparison.Ordinal))));
        Assert.True(await Filter(plugin, transport, user).MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Equal(1, transport.Calls);
    }

    public static IEnumerable<object[]> ProviderCases()
    {
        foreach (var backend in new[] { "je", "seerr" })
        foreach (var role in new[] { "Kid", "Member", "Admin" })
        foreach (var scenario in new[] { "allowed", "keyword", "genre", "allowlist", "rating", "unrated", "adult", "unknown" })
            yield return new object[] { backend, role, scenario };
    }

    [Theory]
    [MemberData(nameof(ProviderCases))]
    public async Task EvidenceMatrixPreservesPolicyForEveryRestrictedRole(string backend, string role, string scenario)
    {
        using var plugin = new ApiPluginFixture();
        var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = backend;
        // Deliberately retain a configured Seerr in JE: the transport trap must still see zero attempts.
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        config.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser(role, admin: role == "Admin");
        user.MaxParentalRatingScore = 10;
        user.SetPreference(PreferenceKind.AllowedTags, new[] { "family" });
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "violence", "horror" });
        user.SetPreference(PreferenceKind.BlockUnratedItems, new[] { "Movie" });
        var raw = Movie(603, scenario == "rating" ? "R" : scenario == "unrated" ? "" : "G", scenario == "adult",
            scenario == "keyword" ? "violence" : scenario == "allowlist" ? "family!" : "family", scenario == "genre" ? "Horror" : "Family");
        var body = backend == "seerr" ? raw.Replace("\"release_dates\":{\"results\"", "\"releases\":{\"results\"", StringComparison.Ordinal) : raw;
        var seerrCalls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.Host != "api.themoviedb.org") Interlocked.Increment(ref seerrCalls);
            return Task.FromResult(IntegrationTransport.Response(body, scenario == "unknown" ? 503 : 200));
        });
        var gate = Filter(plugin, transport, user);
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        var allowed = scenario == "allowed" || (backend == "seerr" && scenario == "adult");
        Assert.Equal(allowed, await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Equal(scenario == "unknown" || (backend == "je" && scenario == "unrated") ? null : allowed, gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(!allowed, await gate.IsBlockedAsync("movie", 603, user.Id.ToString("N")));
        Assert.Equal(backend == "je" ? 0 : 1, seerrCalls);
        // Failure and success are both bounded/cached: repeated checks never hammer either provider.
        Assert.Equal(1, transport.Calls);
    }

    [Theory]
    [InlineData("{\"id\":603,\"adult\":false}")]
    [InlineData("{\"id\":603,\"adult\":false,\"release_dates\":{\"results\":{}}}")]
    [InlineData("{\"id\":99,\"adult\":false,\"release_dates\":{\"results\":[]}}")]
    public async Task IncompleteTmdbEvidenceStaysUnknownRatherThanKnownUnrated(string body)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je"; plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Kid"); user.MaxParentalRatingScore = 10;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body)));
        var gate = Filter(plugin, transport, user);
        Assert.False(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
    }

    [Theory]
    [InlineData("keywords", "{}")]
    [InlineData("keywords", "{\"keywords\":[{}]}")]
    [InlineData("genres", "null")]
    public async Task MalformedTagContainersDoNotMeanVerifiedEmptyTags(string field, string value)
    {
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.ArrRequestBackend = "je"; plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Member"); user.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        var json = System.Text.Json.Nodes.JsonNode.Parse(Movie(603))!.AsObject();
        json[field] = System.Text.Json.Nodes.JsonNode.Parse(value);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(json.ToJsonString())));
        var gate = Filter(plugin, transport, user);
        Assert.False(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Null(await new ListAccessService(new FakeListHost(), Mock.Of<IUserManager>(), gate, plugin.Core.Logger)
            .CheckTitleAsync("movie", 603, SeerrParentalFilter.PolicyFor(user), default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task NativeCustomRatingAndTagsAreReadFreshAndConflictingCopiesStayUnknown()
    {
        using var plugin = new ApiPluginFixture(); plugin.Plugin.Configuration.ArrRequestBackend = "je"; plugin.Plugin.Configuration.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Member"); user.MaxParentalRatingScore = 10; user.SetPreference(PreferenceKind.AllowedTags, new[] { "custom!" });
        var item = new Movie { Id = Guid.NewGuid(), Path = "/movies/a.mkv", OfficialRating = "R", CustomRating = "G", Tags = new[] { "custom!" }, Genres = new[] { "Family" } };
        item.ProviderIds["Tmdb"] = "603";
        var local = new List<BaseItem> { item };
        var library = new Mock<ILibraryManager>(); library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(() => local);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Movie(603))));
        using var tmdb = new TmdbResponseCache(transport, TimeProvider.System);
        var gate = Filter(plugin, transport, user, new TitleParentalEvidenceProvider(transport, tmdb, library.Object));
        Assert.True(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        item.Tags = new[] { "custom" };
        Assert.False(gate.MaySeeAbsent("movie", 603, user.Id.ToString("N"), out _));
        Assert.False(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        item.Tags = new[] { "custom!" }; item.CustomRating = "R";
        Assert.False(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        var copy = new Movie { Id = Guid.NewGuid(), Path = "/movies/b.mkv", OfficialRating = "G", Tags = new[] { "custom!" } };
        copy.ProviderIds["Tmdb"] = "603"; local.Add(copy);
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(1, transport.Calls);
    }

    public static IEnumerable<object[]> LocalCases()
    {
        foreach (var role in new[] { "Kid", "Member", "Admin" })
        {
            yield return new object[] { role, false, false, false, "G", true };
            yield return new object[] { role, true, false, false, "G", false };
            yield return new object[] { role, false, true, false, "G", false };
            yield return new object[] { role, false, false, true, "G", false };
            yield return new object[] { role, false, false, false, "R", false };
        }
    }

    [Theory]
    [MemberData(nameof(LocalCases))]
    public async Task LocalRatingAndTagsCannotInventANonAdultVerdict(string role, bool adult, bool unavailable, bool blocked, string rating, bool allowed)
    {
        using var plugin = new ApiPluginFixture(); var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "je"; config.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser(role, admin: role == "Admin"); user.MaxParentalRatingScore = 10;
        user.SetPreference(PreferenceKind.AllowedTags, new[] { "local tag" });
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "blocked" });
        var item = new Movie { Id = Guid.NewGuid(), Path = "/movies/a.mkv", CustomRating = rating, Tags = blocked ? new[] { "local tag", "blocked" } : new[] { "local tag" } };
        item.ProviderIds["Tmdb"] = "603";
        var library = new Mock<ILibraryManager>(); library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem> { item });
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Movie(603, adult: adult), unavailable ? 503 : 200)));
        using var tmdb = new TmdbResponseCache(transport, TimeProvider.System);
        var gate = Filter(plugin, transport, user, new TitleParentalEvidenceProvider(transport, tmdb, library.Object));
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(allowed, await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Equal(unavailable ? null : allowed, gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task ConcurrentTagChecksShareOneLookupAndAnAbandonedWaiterDoesNotCancelIt()
    {
        using var plugin = new ApiPluginFixture(); var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "je"; config.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Kid"); user.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, ct) =>
        {
            started.TrySetResult(); await release.Task.WaitAsync(ct); return IntegrationTransport.Response(Movie(603));
        });
        var gate = Filter(plugin, transport, user);
        using var cancelled = new CancellationTokenSource();
        var first = gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), cancelled.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default);
        cancelled.Cancel(); Assert.False(await first);
        release.SetResult(); Assert.True(await second);
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task UnrestrictedAdministratorPaysNoLookupEvenWithMissingProviders()
    {
        using var plugin = new ApiPluginFixture(); plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var user = FakeListHost.MakeUser("Admin", admin: true);
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("No lookup"));
        var gate = Filter(plugin, transport, user);
        Assert.True(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.True(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task BackendChangesAndFailedTmdbNeverFallBackToSeerrOrItsCachedSignature()
    {
        using var plugin = new ApiPluginFixture(); var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "seerr"; config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var user = FakeListHost.MakeUser("Kid"); user.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        var seerrCalls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.Host == "api.themoviedb.org") return Task.FromResult(IntegrationTransport.Response("{}", 503));
            Interlocked.Increment(ref seerrCalls);
            return Task.FromResult(IntegrationTransport.Response(Movie(603).Replace("\"release_dates\":{\"results\"", "\"releases\":{\"results\"", StringComparison.Ordinal)));
        });
        var gate = Filter(plugin, transport, user);
        Assert.True(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        config.ArrRequestBackend = "je";
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        // No TMDB credential, then upstream failure with a credential: neither permits the configured fallback.
        Assert.False(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        config.TMDB_API_KEY = "test-tmdb";
        Assert.False(await gate.MaySeeAbsentAsync("movie", 603, user.Id.ToString("N"), default));
        Assert.Null(gate.AbsentVerdict("movie", 603, user.Id.ToString("N")));
        Assert.Equal(1, seerrCalls);
    }

    [Theory]
    [InlineData("Kid")]
    [InlineData("Member")]
    [InlineData("Admin")]
    public async Task JeCallersShareTheSameAllowedRefusedAndUnknownEvidence(string role)
    {
        using var arr = new FakeArr(); arr.Add("movies.invalid", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://movies.invalid", "test-key"));
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true; config.ArrPhase1Enabled = true; config.ArrPhase3Enabled = true;
        config.ArrRequestBackend = "je"; config.ArrRequestDefaultRole = role; config.TMDB_API_KEY = "test-tmdb";
        config.JellyseerrEnabled = false; config.JellyseerrUrls = string.Empty;
        var view = new FakeJellyfinView(); var viewer = view.AddUser(role == "Admin", parental: true);
        var user = (User)viewer.Handle!;
        user.MaxParentalRatingScore = 10;
        user.SetPreference(PreferenceKind.AllowedTags, new[] { "family" });
        user.SetPreference(PreferenceKind.BlockedTags, new[] { "horror" });
        var seerrCalls = 0;
        using var transport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.Host != "api.themoviedb.org") Interlocked.Increment(ref seerrCalls);
            var id = int.Parse(request.RequestUri.Segments.Last());
            return Task.FromResult(IntegrationTransport.Response(Movie(id, genre: id == 604 ? "Horror" : "Family"), id == 605 ? 503 : 200));
        });
        var gate = Filter(arr.Plugin, transport, user);
        using var store = arr.Store();
        var libraries = new ArrInstanceLibraries(store, new FakeLibraryAccess()) { Parental = gate };
        var aliases = new TitleAliases(store, null);
        var policy = new RequestPolicy(view, store, libraries, aliases, gate, arr.Factory, new UnavailableRequestBackend());
        using var db = new AcquireDatabase(Path.Combine(arr.Plugin.Core.Root, "requests.db"));
        var ledger = new RequestLedger(db); var requests = new RequestService(ledger, policy, view, new ArrChangeFeed(), aliases);
        var statuses = new ArrStatusService(store, view, new NoRequestFacts(), () => config, () => DateTimeOffset.UtcNow, libraries: libraries);
        var page = IntegrationRequestDiscoverTests.Page(IntegrationRequestDiscoverTests.Movie(603, "Allowed"),
            IntegrationRequestDiscoverTests.Movie(604, "Refused"), IntegrationRequestDiscoverTests.Movie(605, "Unknown"));
        var discover = new DiscoverService(requests, aliases, DiscoverService.ParentalCheck(gate),
            (_, _, _) => Task.FromResult<string?>(page), (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => DateTimeOffset.UtcNow);
        Assert.Equal(new[] { "movie:tmdb:603" }, (await discover.DiscoverAsync(viewer, "trending", "movie", 1, null, default))!.Results.Select(r => r.Key));
        Assert.Equal(new[] { "movie:tmdb:603" }, (await discover.SearchAsync(viewer, "a family movie", 1, null, default))!.Results.Select(r => r.Key));
        var lists = new ListAccessService(new FakeListHost(), Mock.Of<IUserManager>(), gate, arr.Plugin.Core.Logger);
        foreach (var id in new[] { 603, 604, 605 })
        {
            var input = IntegrationRequestLedgerTests.Movie(id);
            await policy.PrepareVisibilityAsync(user.Id, input, default);
            var result = policy.Evaluate(user.Id, input);
            Assert.Equal(id == 603, result.Visible);
            Assert.Equal(id == 605, result.VisibilityUnknown);
            Assert.Equal(id == 603, libraries.MaySeeAbsent(viewer, TitleKey.Parse(input.Key)!));
            Assert.Equal(id == 603, statuses.MayFollow(viewer, TitleKey.Parse(input.Key)!));
            Assert.Equal(id == 605 ? null : id == 603, await lists.CheckTitleAsync("movie", id, SeerrParentalFilter.PolicyFor(user), default));
        }
        var controller = new Jellyfin.Plugin.JellyfinEnhanced.Controllers.AcquireRequestsController(requests)
            { ControllerContext = new() { HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(user.Id, viewer.IsAdmin);
        Assert.Equal(201, Assert.IsType<ObjectResult>(await controller.Create(new("allowed", IntegrationRequestLedgerTests.Movie()), default)).StatusCode);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.Create(new("refused", IntegrationRequestLedgerTests.Movie(604)), default)).StatusCode);
        Assert.Single(ledger.List(user.Id, false));
        var users = new Mock<IUserManager>(); users.Setup(m => m.GetUserById(user.Id)).Returns(user);
        var library = new Mock<ILibraryManager>(); library.Setup(m => m.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        var audience = new ArrFeedAudience(library.Object, users.Object, store, view: view, libraries: libraries);
        var changes = new[] { 603, 604, 605 }.Select(id => new ArrFeedChange("movie:tmdb:" + id, 1, arr.Instance("Movies").Id)).ToArray();
        Assert.Equal(new[] { "movie:tmdb:603" }, audience.Visible(user.Id, viewer.IsAdmin, changes));
        Assert.Equal(0, seerrCalls);
        Assert.Equal(3, transport.Calls);
    }

    [Fact]
    public async Task TvEvidenceUsesContentRatingsAndResultsKeywordsAndNeverABetterForeignRating()
    {
        using var plugin = new ApiPluginFixture(); var config = plugin.Plugin.Configuration;
        config.ArrRequestBackend = "je"; config.TMDB_API_KEY = "test-tmdb";
        var user = FakeListHost.MakeUser("Member"); user.SetPreference(PreferenceKind.AllowedTags, new[] { "family" });
        var calls = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            calls.Add(request.RequestUri!.PathAndQuery);
            var id = int.Parse(request.RequestUri.Segments.Last());
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
            {
                id, adult = false,
                content_ratings = new { results = new[] { new { iso_3166_1 = id == 603 ? "US" : "AU", rating = "G" } } },
                keywords = new { results = new[] { new { id = 1, name = "family" } } }, genres = Array.Empty<object>(),
            })));
        });
        var gate = Filter(plugin, transport, user);
        Assert.True(await gate.MaySeeAbsentAsync("tv", 603, user.Id.ToString("N"), default));
        Assert.False(await gate.MaySeeAbsentAsync("tv", 604, user.Id.ToString("N"), default));
        Assert.Null(gate.AbsentVerdict("tv", 604, user.Id.ToString("N")));
        Assert.All(calls, call => Assert.Contains("append_to_response=content_ratings,keywords", call));
    }

    internal static SeerrParentalFilter Filter(ApiPluginFixture plugin, IntegrationTransport transport, User user, TitleParentalEvidenceProvider? provider = null)
    {
        var users = new Mock<IUserManager>();
        users.Setup(m => m.GetUserById(user.Id)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(m => m.GetRatingScore("G", "US")).Returns(new ParentalRatingScore(1, null));
        localization.Setup(m => m.GetRatingScore("R", "US")).Returns(new ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>();
        server.SetupGet(m => m.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        return new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, plugin.Core.Logger, provider);
    }

    internal static string Movie(int id, string rating = "G", bool adult = false, string keyword = "family", string genre = "Family")
        => JsonSerializer.Serialize(new
        {
            id, adult,
            release_dates = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } },
            keywords = new { keywords = new[] { new { id = 1, name = keyword } } },
            genres = new[] { new { id = 2, name = genre } },
        });
}
