using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// The import review HTTP surface (acquire/lists/import/*, preview only) through real ASP.NET routing/auth: anonymous
// 401, a person first (403 user_required), the import / From URL switches (404 disabled, nothing looked up or fetched),
// bounds and body caps, a metadata source, edit rights on a target list, typed fetch errors with Retry-After, the
// administrators' deliberate MDBList API read, private no-store answers, and grouped watch orders. Ported from #936's
// ListPlaceholdersImportControllerTests (the link/apply/sync routes are 4c2b's).
[Collection("Plugin singleton")]
public class ListsImportControllerTests
{
    private sealed class HeaderAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var user = Request.Headers["X-Test-User"].ToString();
            if (user.Length == 0)
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            var identity = new ClaimsIdentity(new[] { new Claim("Jellyfin-UserId", user), new Claim(ClaimTypes.Role, "User") }, Scheme.Name);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
        }
    }

    private sealed class Activator(Func<Type, ControllerBase> create) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = create(context.ActionDescriptor.ControllerTypeInfo.AsType());
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly IHost _host;

        public ImportHarness H { get; } = new();
        public User Owner { get; }
        public User Viewer { get; }
        public User Admin { get; }
        public FakeListHost.FakeList Playlist { get; }
        public FakeListHost.FakeList Private { get; }

        public Fixture()
        {
            Owner = H.NewUser("owner");
            Viewer = H.NewUser("viewer");
            Admin = H.NewUser("admin", admin: true);
            Playlist = H.Host.AddPlaylist(Owner, openAccess: true);
            Private = H.Host.AddPlaylist(Owner);
            H.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
            H.Lookup.Details[("movie", 49521)] = new TitleDetails(Movie(49521, "Man of Steel", "2013-06-12", 16680), "tt0770828", null, "Released", null, Array.Empty<SeasonFacts>());
            H.Fetcher.Items = new List<SourceItem> { new("movie", 49521, null, null, "Man of Steel", 2013, null, null, null) };
            _host = new HostBuilder().ConfigureWebHost(web => web.UseTestServer().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(AcquireListImportController).Assembly);
                services.AddSingleton<IControllerActivator>(new Activator(type => type == typeof(AcquireListImportController)
                    ? new AcquireListImportController(H.Lists.Users.Object, H.Access, H.ImportResolver, H.Sources, H.Plugin.Core.Logger)
                    : throw new InvalidOperationException("Unexpected controller " + type)));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            })).Start();
        }

        public string List => Playlist.Info.Id.ToString("N");

        public HttpClient Client(User? user) => Client(user?.Id);

        public HttpClient Client(Guid? userId)
        {
            var client = _host.GetTestClient();
            if (userId != null)
            {
                client.DefaultRequestHeaders.Add("X-Test-User", userId.Value.ToString());
            }

            return client;
        }

        public void Dispose()
        {
            _host.Dispose();
            H.Dispose();
        }
    }

    private const string Resolve = "/JellyfinEnhanced/acquire/lists/import/resolve";
    private const string Source = "/JellyfinEnhanced/acquire/lists/import/source";
    private const string Providers = "/JellyfinEnhanced/acquire/lists/import/providers";

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private static async Task<JsonElement> Body(HttpResponseMessage response) => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static (string Method, string Path, string? Body)[] Routes() => new (string, string, string?)[]
    {
        ("POST", Resolve, "{\"entries\":[{\"title\":\"Man of Steel\",\"year\":2013}]}"),
        ("POST", Source, "{\"url\":\"https://mdblist.com/lists/a/b\"}"),
        ("GET", Providers, null),
    };

    private static Task<HttpResponseMessage> Send(HttpClient client, (string Method, string Path, string? Body) route) =>
        client.SendAsync(new HttpRequestMessage(new HttpMethod(route.Method), route.Path) { Content = route.Body == null ? null : Json(route.Body) });

    [Fact]
    public async Task EveryRouteNeedsAPersonAndTheSwitches()
    {
        using var f = new Fixture();
        using var anonymous = f.Client((Guid?)null);
        using var unknown = f.Client(Guid.NewGuid()); // an API key or a deleted user: not a person
        foreach (var route in Routes())
        {
            using var response = await Send(anonymous, route);
            Assert.True(HttpStatusCode.Unauthorized == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
            using var stranger = await Send(unknown, route);
            Assert.Equal(HttpStatusCode.Forbidden, stranger.StatusCode);
            Assert.Equal("user_required", (await Body(stranger)).GetProperty("code").GetString());
        }

        using var owner = f.Client(f.Owner);
        // Every parent of import, then import itself: 404 disabled on every route.
        foreach (var off in new Action<Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration>[]
        {
            c => c.ArrPhase4ListImportEnabled = false,
            c => c.ArrPhase4ListAuthoringEnabled = false,
            c => c.ArrPhase4ListPlaceholdersEnabled = false,
            c => c.ArrPhase4Enabled = false,
        })
        {
            ImportTestFlags.AllOn(f.H.Plugin.Plugin.Configuration);
            off(f.H.Plugin.Plugin.Configuration);
            foreach (var route in Routes())
            {
                using var response = await Send(owner, route);
                Assert.True(HttpStatusCode.NotFound == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
                Assert.Equal("disabled", (await Body(response)).GetProperty("code").GetString());
                Assert.True(response.Headers.CacheControl is { Private: true, NoStore: true }, response.Headers.CacheControl?.ToString());
            }
        }

        // From URL off: the URL route is off, paste/file review still works.
        ImportTestFlags.AllOn(f.H.Plugin.Plugin.Configuration);
        f.H.Plugin.Plugin.Configuration.ArrPhase4ListSourcesEnabled = false;
        Assert.Equal(HttpStatusCode.NotFound, (await Send(owner, Routes()[1])).StatusCode);
        Assert.Empty(f.H.Fetcher.Calls);
        Assert.Empty(f.H.Lookup.Log);
        Assert.Equal(HttpStatusCode.OK, (await Send(owner, Routes()[0])).StatusCode);
    }

    [Fact]
    public async Task ResolveBoundsItsInputNeedsAMetadataSourceAndEditRightsOnATargetList()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);

        using (var ok = await viewer.PostAsync(Resolve, Json("{\"entries\":[{\"title\":\"Man of Steel\",\"year\":2013}]}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            Assert.True(ok.Headers.CacheControl is { Private: true, NoStore: true }, ok.Headers.CacheControl?.ToString());
            var body = await Body(ok);
            var result = body.GetProperty("results")[0];
            Assert.Equal(("high", 49521), (result.GetProperty("confidence").GetString(), result.GetProperty("match").GetProperty("tmdbId").GetInt32()));
            Assert.Equal("seerr", body.GetProperty("metadataProvider").GetString()); // the fake lookup's label
        }

        var tooMany = "{\"entries\":[" + string.Join(',', Enumerable.Repeat("{\"title\":\"x\"}", 26)) + "]}";
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(Resolve, Json(tooMany))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(Resolve, Json("{\"entries\":[]}"))).StatusCode);
        // A target list must be editable by the caller; a private one they can't see answers like a missing one.
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync(Resolve, Json("{\"listId\":\"" + f.List + "\",\"entries\":[{\"title\":\"x\"}]}"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await viewer.PostAsync(Resolve, Json("{\"listId\":\"" + f.Private.Info.Id.ToString("N") + "\",\"entries\":[{\"title\":\"x\"}]}"))).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await viewer.PostAsync(Resolve, Json("{\"listId\":\"" + Guid.NewGuid().ToString("N") + "\",\"entries\":[{\"title\":\"x\"}]}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(Resolve, Json("{\"listId\":\"nope\",\"entries\":[{\"title\":\"x\"}]}"))).StatusCode);

        // A body over the reviewed cap is refused before binding.
        var huge = "{\"entries\":[{\"title\":\"" + new string('x', AcquireListImportController.ResolveBody) + "\"}]}";
        using (var tooLarge = await viewer.PostAsync(Resolve, Json(huge)))
        {
            Assert.Equal(HttpStatusCode.RequestEntityTooLarge, tooLarge.StatusCode);
        }

        f.H.Lookup.IsConfigured = false;
        using var off = await viewer.PostAsync(Resolve, Json("{\"entries\":[{\"title\":\"Man of Steel\"}]}"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, off.StatusCode);
        Assert.Equal("metadata_unavailable", (await Body(off)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task FetchingReturnsEntriesOrATypedErrorWithRetryAfter()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        using (var ok = await viewer.PostAsync(Source, Json("{\"url\":\"https://mdblist.com/lists/a/b\"}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            Assert.True(ok.Headers.CacheControl is { Private: true, NoStore: true }, ok.Headers.CacheControl?.ToString());
            var body = await Body(ok);
            Assert.Equal(("mdblist", "https://mdblist.com/lists/a/b"), (body.GetProperty("kind").GetString(), body.GetProperty("url").GetString()));
            var entry = body.GetProperty("entries")[0];
            Assert.Equal(("movie|49521||", 49521, "movie"), (entry.GetProperty("sourceKey").GetString(), entry.GetProperty("ids").GetProperty("tmdb").GetInt32(), entry.GetProperty("ids").GetProperty("tmdbType").GetString()));
            Assert.Equal("complete", body.GetProperty("snapshot").GetProperty("state").GetString());
        }

        Assert.False(f.H.Fetcher.Calls.Single().AllowMdblistApi); // never an implicit API read with JE's key

        using (var letterboxd = await viewer.PostAsync(Source, Json("{\"url\":\"https://letterboxd.com/a/list/b/\"}")))
        {
            Assert.Equal(HttpStatusCode.BadRequest, letterboxd.StatusCode);
            var body = await Body(letterboxd);
            Assert.Equal("letterboxd_unsupported", body.GetProperty("code").GetString());
            Assert.Contains("MDBList", body.GetProperty("message").GetString(), StringComparison.Ordinal); // the guidance
        }

        Assert.Single(f.H.Fetcher.Calls); // Letterboxd was never fetched
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(Source, Json("{}"))).StatusCode);

        f.H.Fetcher.FailCode = "rate_limited";
        f.H.Fetcher.RetryAfter = 30;
        using var limited = await viewer.PostAsync(Source, Json("{\"url\":\"https://mdblist.com/lists/a/b\"}"));
        Assert.Equal((HttpStatusCode)429, limited.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(30), limited.Headers.RetryAfter!.Delta);
        Assert.True(limited.Headers.CacheControl is { Private: true, NoStore: true }, limited.Headers.CacheControl?.ToString());

        using var providers = await viewer.GetAsync(Providers);
        var capabilities = await Body(providers);
        Assert.Equal(1000, capabilities.GetProperty("maxItems").GetInt32());
        Assert.Equal(25, capabilities.GetProperty("resolveChunk").GetInt32());
    }

    // SEC-07: the framework's own refusals (the body cap before binding, model validation of malformed JSON) happen
    // before the actions set their headers: they are private, no-store too.
    [Fact]
    public async Task TheFrameworksOwnRefusalsArePrivateAndNeverStored()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        var huge = "{\"entries\":[{\"title\":\"" + new string('x', AcquireListImportController.ResolveBody) + "\"}]}";
        foreach (var (path, body, status) in new[]
        {
            (Resolve, huge, HttpStatusCode.RequestEntityTooLarge),
            (Source, "{\"url\":\"" + new string('x', 20 * 1024) + "\"}", HttpStatusCode.RequestEntityTooLarge),
            (Resolve, "{\"entries\":[{\"title\":", HttpStatusCode.BadRequest),
            (Source, "{\"url\": 12,", HttpStatusCode.BadRequest),
            (Resolve, "{\"entries\":{\"title\":\"x\"}}", HttpStatusCode.BadRequest),
        })
        {
            using var response = await viewer.PostAsync(path, Json(body));
            Assert.True(status == response.StatusCode, $"{path} {body.Length}: {response.StatusCode}");
            Assert.True(response.Headers.CacheControl is { Private: true, NoStore: true }, $"{path} {response.StatusCode}: {response.Headers.CacheControl}");
        }

        Assert.Empty(f.H.Fetcher.Calls);
        Assert.Empty(f.H.Lookup.Log);
    }

    [Fact]
    public async Task OnlyAnAdministratorMayAskForTheMdblistApiAndOnlyDeliberately()
    {
        using var f = new Fixture();
        const string Api = "{\"url\":\"https://mdblist.com/lists/a/b\",\"useMdblistApi\":true}";

        using (var viewer = f.Client(f.Viewer))
        using (var refused = await viewer.PostAsync(Source, Json(Api)))
        {
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
            Assert.Equal("admin_required", (await Body(refused)).GetProperty("code").GetString());
        }

        Assert.Empty(f.H.Fetcher.Calls); // refused before anything was read

        using var admin = f.Client(f.Admin);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync(Source, Json("{\"url\":\"https://mdblist.com/lists/a/b\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsync(Source, Json(Api))).StatusCode);
        Assert.Equal(new[] { false, true }, f.H.Fetcher.Calls.Select(c => c.AllowMdblistApi));
    }

    [Fact]
    public async Task ResolveAdmitsAtMostTwoCallsPerUser()
    {
        using var f = new Fixture();
        var owner = f.Owner.Id.ToString("N");
        using var first = f.H.ImportResolver.TryEnterCall(owner);
        using var second = f.H.ImportResolver.TryEnterCall(owner);
        Assert.NotNull(first);
        Assert.NotNull(second);
        using (var client = f.Client(f.Owner))
        using (var busy = await client.PostAsync(Resolve, Json("{\"entries\":[{\"title\":\"Man of Steel\"}]}")))
        {
            Assert.Equal((HttpStatusCode)429, busy.StatusCode);
            Assert.Equal("busy", (await Body(busy)).GetProperty("code").GetString());
            Assert.True(busy.Headers.Contains("Retry-After"));
        }

        using var otherUser = f.H.ImportResolver.TryEnterCall(f.Viewer.Id.ToString("N"));
        Assert.NotNull(otherUser); // per user
        second!.Dispose();
        using var third = f.H.ImportResolver.TryEnterCall(owner);
        Assert.NotNull(third);
    }

    [Fact]
    public async Task GroupedWatchOrdersComeBackPreparedWithEveryKey()
    {
        using var f = new Fixture();
        f.H.Fetcher.Exact = true;
        f.H.Fetcher.Provider = "chronolists";
        SourceItem Ep(int e) => new("tv", 1412, "tt2193021", 257655, "Arrow", 2012, 1, e, null) { Details = new SourceItemDetails("E" + e, "2012-10-1" + e, "/a.jpg", null, "Season 1") };
        f.H.Lookup.AddShow(Tv(1412, "Arrow", "2012-10-10"), new SeasonFacts(1, 3, "2012-10-10", "Season 1")); // TMDB: S1 has 3 episodes
        f.H.Fetcher.Items = new List<SourceItem> { Ep(1), Ep(2), Ep(3), new("movie", 49521, null, null, "Man of Steel", 2013, null, null, null) { Details = new SourceItemDetails(null, "2013-06-12", null, null, null) } };
        using var owner = f.Client(f.Owner);
        using var viewer = f.Client(f.Viewer);

        // The target list must be editable by the caller (its owner's visibility then counts for "in library").
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync(Source, Json("{\"url\":\"https://chronolists.com/dctv\",\"listId\":\"" + f.List + "\"}"))).StatusCode);
        JsonElement fetched;
        using (var ok = await owner.PostAsync(Source, Json("{\"url\":\"https://chronolists.com/dctv\",\"listId\":\"" + f.List + "\"}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            fetched = await Body(ok);
        }

        Assert.True(fetched.GetProperty("grouped").GetBoolean());
        Assert.Equal(4, fetched.GetProperty("snapshotKeys").GetArrayLength());
        var season = fetched.GetProperty("entries")[0];
        Assert.Equal(("season", "high", 3), (season.GetProperty("prepared").GetProperty("kind").GetString(), season.GetProperty("prepared").GetProperty("confidence").GetString(), season.GetProperty("sourceKeys").GetArrayLength()));
        Assert.Equal(new[] { "tv|1412|1|1", "tv|1412|1|2", "tv|1412|1|3" }, season.GetProperty("sourceKeys").EnumerateArray().Select(k => k.GetString()));
    }

    [Fact]
    public async Task AWholeSeasonOfMoreThanAThousandEpisodesComesBackAsOneEntry()
    {
        using var f = new Fixture();
        f.H.Fetcher.Exact = true;
        f.H.Fetcher.Provider = "chronolists";
        f.H.Lookup.AddShow(Tv(30983, "Long Show", "1999-10-20"), new SeasonFacts(1, 1001, "1999-10-20", "Season 1"));
        f.H.Fetcher.Items = Enumerable.Range(1, 1001).Select(e => new SourceItem("tv", 30983, null, null, "Long Show", 1999, 1, e, null) { Details = new SourceItemDetails(null, "1999-10-20", null, null, "Season 1") }).ToList();
        using var owner = f.Client(f.Owner);
        using var ok = await owner.PostAsync(Source, Json("{\"url\":\"https://chronolists.com/dctv\"}"));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var entry = (await Body(ok)).GetProperty("entries")[0];
        Assert.Equal(("season", 1001), (entry.GetProperty("prepared").GetProperty("kind").GetString(), entry.GetProperty("sourceKeys").GetArrayLength()));
    }
}
