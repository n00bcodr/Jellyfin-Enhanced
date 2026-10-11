using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// The import / linked-source HTTP surface (both controllers share the route prefix): auth, master switch, Seerr gate,
// edit rights, validation, Retry-After, and URL imports linking the list through /apply and /playlists.
[Collection("Plugin singleton")]
public class ListPlaceholdersImportControllerTests
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

    private sealed class FakeLink(IHttpClientFactory factory, Jellyfin.Plugin.JellyfinEnhanced.Logger logger, Func<User, bool> allowed) : SeerrUserLink(factory, logger)
    {
        public override Task<bool> IsAllowedAsync(User user, CancellationToken cancellationToken) => Task.FromResult(allowed(user));
    }

    private sealed class Fixture : IDisposable
    {
        public ListPlaceholdersHarness H { get; } = new();
        public User Owner { get; }
        public User Viewer { get; }
        public User Unlinked { get; }
        public FakeListHost.FakeList Playlist { get; }
        public TestServer Server { get; }

        public Fixture()
        {
            Owner = H.NewUser("owner");
            Viewer = H.NewUser("viewer");
            Unlinked = H.NewUser("unlinked");
            Playlist = H.Host.AddPlaylist(Owner, openAccess: true);
            H.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
            H.Lookup.Details[("movie", 49521)] = new TitleDetails(Movie(49521, "Man of Steel", "2013-06-12", 16680), "tt0770828", null, "Released", null, Array.Empty<SeasonFacts>());
            H.Fetcher.Items = new List<SourceItem> { new("movie", 49521, null, null, "Man of Steel", 2013, null, null, null) };
            var link = new FakeLink(H.Transport, H.Plugin.Core.Logger, u => u.Id != Unlinked.Id);
            Server = new TestServer(new WebHostBuilder().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(ListPlaceholderImportController).Assembly);
                services.AddSingleton<IControllerActivator>(new Activator(type => type == typeof(ListPlaceholderImportController)
                    ? new ListPlaceholderImportController(H.Users.Object, H.Access, H.ImportResolver, link, H.Sources, H.Plugin.Core.Logger)
                    : type == typeof(ListPlaceholdersController)
                        ? new ListPlaceholdersController(H.Users.Object, H.Access, H.Service, H.Sources, H.Plugin.Core.Logger)
                        : throw new InvalidOperationException("Unexpected controller " + type)));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e => e.MapControllers());
            }));
        }

        public string List => Playlist.Info.Id.ToString("N");

        public HttpClient Client(User? user)
        {
            var client = Server.CreateClient();
            if (user != null)
            {
                client.DefaultRequestHeaders.Add("X-Test-User", user.Id.ToString());
            }

            return client;
        }

        public void Dispose()
        {
            Server.Dispose();
            H.Dispose();
        }
    }

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private static async Task<JsonElement> Body(HttpResponseMessage response) => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;

    private static (string Method, string Path, string? Body)[] Routes(Fixture f) => new (string, string, string?)[]
    {
        ("POST", "/JellyfinEnhanced/list-placeholders/resolve", "{\"entries\":[{\"title\":\"Man of Steel\",\"year\":2013}]}"),
        ("POST", "/JellyfinEnhanced/list-placeholders/source/fetch", "{\"url\":\"https://mdblist.com/lists/a/b\"}"),
        ("GET", "/JellyfinEnhanced/list-placeholders/source/providers", null),
        ("PUT", $"/JellyfinEnhanced/list-placeholders/{f.List}/source", "{\"url\":\"https://mdblist.com/lists/a/b\"}"),
        ("DELETE", $"/JellyfinEnhanced/list-placeholders/{f.List}/source", null),
        ("POST", $"/JellyfinEnhanced/list-placeholders/{f.List}/source/sync", null),
    };

    private static Task<HttpResponseMessage> Send(HttpClient client, (string Method, string Path, string? Body) route) =>
        client.SendAsync(new HttpRequestMessage(new HttpMethod(route.Method), route.Path) { Content = route.Body == null ? null : Json(route.Body) });

    [Fact]
    public async Task EveryRouteNeedsAUserAndTheFeature()
    {
        using var f = new Fixture();
        using var anonymous = f.Client(null);
        foreach (var route in Routes(f))
        {
            using var response = await Send(anonymous, route);
            Assert.True(HttpStatusCode.Unauthorized == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
        }

        f.H.Plugin.Plugin.Configuration.ListPlaceholdersEnabled = false;
        using var owner = f.Client(f.Owner);
        foreach (var route in Routes(f))
        {
            using var response = await Send(owner, route);
            Assert.True(HttpStatusCode.NotFound == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
        }

        Assert.Empty(f.H.Lookup.Log);
        Assert.Empty(f.H.Fetcher.Calls);
    }

    [Fact]
    public async Task ResolveNeedsSeerrAndALinkedAccountAndBoundsItsInput()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        var route = Routes(f)[0];

        using (var ok = await Send(viewer, route))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            var result = (await Body(ok)).GetProperty("results")[0];
            Assert.Equal(("high", 49521), (result.GetProperty("confidence").GetString(), result.GetProperty("match").GetProperty("tmdbId").GetInt32()));
        }

        using (var unlinked = await Send(f.Client(f.Unlinked), route))
        {
            Assert.Equal(HttpStatusCode.Forbidden, unlinked.StatusCode);
            Assert.Equal("seerr_unlinked", (await Body(unlinked)).GetProperty("code").GetString());
        }

        var tooMany = "{\"entries\":[" + string.Join(',', Enumerable.Repeat("{\"title\":\"x\"}", 26)) + "]}";
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(route.Path, Json(tooMany))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync(route.Path, Json("{\"entries\":[]}"))).StatusCode);
        // A target list must be editable by the caller.
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync(route.Path, Json("{\"listId\":\"" + f.List + "\",\"entries\":[{\"title\":\"x\"}]}"))).StatusCode);

        f.H.Lookup.IsConfigured = false;
        using var off = await Send(viewer, route);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, off.StatusCode);
        Assert.Equal("seerr_unavailable", (await Body(off)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task FetchingReturnsEntriesOrACodedErrorWithRetryAfter()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        using (var ok = await viewer.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://mdblist.com/lists/a/b\"}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            var body = await Body(ok);
            Assert.Equal(("mdblist", "https://mdblist.com/lists/a/b"), (body.GetProperty("kind").GetString(), body.GetProperty("url").GetString()));
            var entry = body.GetProperty("entries")[0];
            Assert.Equal(("movie|49521||", 49521, "movie"), (entry.GetProperty("sourceKey").GetString(), entry.GetProperty("ids").GetProperty("tmdb").GetInt32(), entry.GetProperty("ids").GetProperty("tmdbType").GetString()));
        }

        Assert.False(f.H.Fetcher.Calls.Single().AllowMdblistApi); // not an admin: no API fallback with JE's key

        using (var letterboxd = await viewer.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://letterboxd.com/a/list/b/\"}")))
        {
            Assert.Equal(HttpStatusCode.BadRequest, letterboxd.StatusCode);
            Assert.Equal("letterboxd_unsupported", (await Body(letterboxd)).GetProperty("code").GetString());
        }

        Assert.Equal(HttpStatusCode.BadRequest, (await viewer.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{}"))).StatusCode);

        f.H.Fetcher.FailCode = "rate_limited";
        f.H.Fetcher.RetryAfter = 30;
        using var limited = await viewer.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://mdblist.com/lists/a/b\"}"));
        Assert.Equal((HttpStatusCode)429, limited.StatusCode);
        Assert.Equal(TimeSpan.FromSeconds(30), limited.Headers.RetryAfter!.Delta);

        using var providers = await viewer.GetAsync("/JellyfinEnhanced/list-placeholders/source/providers");
        Assert.Equal(1000, (await Body(providers)).GetProperty("maxItems").GetInt32());
    }

    [Fact]
    public async Task LinkingAndSyncingNeedEditRights()
    {
        using var f = new Fixture();
        using var viewer = f.Client(f.Viewer);
        foreach (var route in Routes(f).Skip(3))
        {
            using var response = await Send(viewer, route);
            Assert.True(HttpStatusCode.Forbidden == response.StatusCode, $"{route.Method} {route.Path} -> {response.StatusCode}");
        }

        using var owner = f.Client(f.Owner);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PutAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/source", Json("{\"url\":\"\"}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/source/sync?requestId=bad%20id", null)).StatusCode);

        using (var link = await owner.PutAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/source", Json("{\"requestId\":\"l1\",\"url\":\"https://mdblist.com/lists/a/b\",\"removeDropped\":true}")))
        {
            Assert.Equal(HttpStatusCode.OK, link.StatusCode);
            var source = (await Body(link)).GetProperty("source");
            Assert.True(source.GetProperty("removeDropped").GetBoolean());
            Assert.False(source.TryGetProperty("owned", out _)); // never internal sync state
            Assert.False(source.TryGetProperty("linkedByUserId", out _));
        }

        using (var sync = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/source/sync?requestId=s1", null))
        {
            Assert.Equal(HttpStatusCode.OK, sync.StatusCode);
            var body = await Body(sync);
            Assert.Equal(("ok", 1), (body.GetProperty("state").GetString(), body.GetProperty("added").GetInt32()));
            Assert.Equal(1, body.GetProperty("view").GetProperty("placeholders").GetArrayLength());
        }

        using var unlink = await owner.DeleteAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/source?requestId=u1");
        Assert.Equal(HttpStatusCode.OK, unlink.StatusCode);
        var unlinked = await Body(unlink);
        Assert.True(!unlinked.TryGetProperty("source", out var gone) || gone.ValueKind == JsonValueKind.Null);
    }

    [Fact]
    public async Task UrlImportsLinkTheListThroughApplyAndCreate()
    {
        using var f = new Fixture();
        using var owner = f.Client(f.Owner);
        const string Entries = "[{\"type\":\"placeholder\",\"sourceKey\":\"movie|49521||\",\"placeholder\":{\"kind\":\"movie\",\"tmdbId\":49521,\"title\":\"Man of Steel\"}}]";
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"entries\":[{\"type\":\"placeholder\",\"sourceKey\":\"rank|1\",\"placeholder\":{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"x\"}}]}"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"entries\":" + Entries + ",\"source\":{\"url\":\"https://letterboxd.com/a/list/b/\"}}"))).StatusCode);
        Assert.Null(f.H.Store.Load(f.List));

        using (var applied = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"requestId\":\"imp-1\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\",\"syncEnabled\":true,\"snapshotKeys\":[\"movie|49521||\",\"movie|2||\"]}}")))
        {
            Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
            var view = (await Body(applied)).GetProperty("view");
            Assert.Equal("https://mdblist.com/lists/a/b", view.GetProperty("source").GetProperty("url").GetString());
        }

        var source = f.H.Store.Load(f.List)!.Source!;
        Assert.Equal(new[] { "movie|49521||" }, source.Owned.Keys);
        Assert.Equal("movie|49521||", f.H.Store.Load(f.List)!.Items.Single().SourceKey);
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|2||"));

        using var created = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/playlists",
            Json("{\"requestId\":\"new-1\",\"name\":\"From MDBList\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\",\"syncEnabled\":true}}"));
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var listId = (await Body(created)).GetProperty("listId").GetString()!;
        var createdSource = f.H.Store.Load(listId)!.Source!;
        Assert.Equal((f.Owner.Id.ToString("N"), true), (createdSource.LinkedByUserId, createdSource.SyncEnabled));
        Assert.Single(createdSource.Owned);

        // B10: retries replay even while the list site is rate limiting (no second fetch before the replay check).
        f.H.Fetcher.FailCode = "rate_limited";
        var fetches = f.H.Fetcher.Calls.Count;
        using (var replayApply = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"requestId\":\"imp-1\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\",\"syncEnabled\":true}}")))
        {
            Assert.Equal(HttpStatusCode.OK, replayApply.StatusCode);
        }

        using (var replayCreate = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/playlists",
            Json("{\"requestId\":\"new-1\",\"name\":\"From MDBList\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\",\"syncEnabled\":true}}")))
        {
            Assert.Equal(HttpStatusCode.OK, replayCreate.StatusCode);
            Assert.Equal(listId, (await Body(replayCreate)).GetProperty("listId").GetString());
        }

        Assert.Equal(fetches, f.H.Fetcher.Calls.Count);
        Assert.Single(f.H.Store.Load(f.List)!.Items);
        using var fresh = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/playlists",
            Json("{\"requestId\":\"new-2\",\"name\":\"Other\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\"}}"));
        Assert.Equal((HttpStatusCode)429, fresh.StatusCode);
    }

    // R4-1/R4-9: a URL import whose fetch was still running when the owner removed the editor's share (or made it
    // read-only) writes nothing: rights are checked again under the list lock, as PUT /source does (H8).
    [Theory]
    [InlineData(false, HttpStatusCode.NotFound)]
    [InlineData(true, HttpStatusCode.Forbidden)]
    public async Task AUrlImportFetchedAfterTheEditorLostTheirRightsWritesNothing(bool keepViewShare, HttpStatusCode expected)
    {
        using var f = new Fixture();
        var editor = f.H.NewUser("editor");
        var playlist = f.H.Host.AddPlaylist(f.Owner, false, new ListShare(editor.Id, true));
        var listId = playlist.Info.Id.ToString("N");
        f.H.Fetcher.OnFetch = () =>
        {
            playlist.Info = playlist.Info with
            {
                Shares = keepViewShare
                    ? new[] { new ListShare(editor.Id, false) }
                    : Array.Empty<ListShare>(),
            };
            return Task.CompletedTask;
        };

        using var client = f.Client(editor);
        const string Entries = "[{\"type\":\"placeholder\",\"sourceKey\":\"movie|49521||\",\"placeholder\":{\"kind\":\"movie\",\"tmdbId\":49521,\"title\":\"Man of Steel\"}}]";
        using var applied = await client.PostAsync($"/JellyfinEnhanced/list-placeholders/{listId}/apply",
            Json("{\"requestId\":\"imp-r4\",\"entries\":" + Entries + ",\"source\":{\"url\":\"https://mdblist.com/lists/a/b\",\"syncEnabled\":true}}"));
        Assert.Equal(expected, applied.StatusCode);
        Assert.Single(f.H.Fetcher.Calls);
        var doc = f.H.Store.Load(listId);
        Assert.True(doc == null || (doc.Source == null && doc.Items.Count == 0));
    }

    // R5-1: POST /items and PATCH (link) also write with rights checked again under the list lock: the parental check
    // and the TMDB poster / Seerr reads before it can take seconds, and the owner may remove the editor's share (or
    // make it read-only) meanwhile.
    [Theory]
    [InlineData(false, false, HttpStatusCode.NotFound)]
    [InlineData(false, true, HttpStatusCode.Forbidden)]
    [InlineData(true, false, HttpStatusCode.NotFound)]
    [InlineData(true, true, HttpStatusCode.Forbidden)]
    public async Task AddsAndLinksReadAfterTheEditorLostTheirRightsWriteNothing(bool patch, bool keepViewShare, HttpStatusCode expected)
    {
        using var f = new Fixture();
        f.H.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        f.H.Tmdb["/3/movie/49521"] = "{\"id\":49521,\"poster_path\":\"/mos.jpg\"}";
        var editor = f.H.NewUser("editor");
        var playlist = f.H.Host.AddPlaylist(f.Owner, false, new ListShare(editor.Id, true));
        var listId = playlist.Info.Id.ToString("N");
        var custom = ListPlaceholdersHarness.Ph("{\"kind\":\"custom\",\"title\":\"Man of Steel?\"}");
        var rev = ListPlaceholdersHarness.Ok<ApplyResultDto>(await f.H.Service.AddPlaceholdersAsync(f.H.AccessFor(playlist, f.Owner), new[] { custom }, null, null, null, CancellationToken.None)).View!.Rev;
        var reply = f.H.Reply;
        var tmdbReads = 0;
        f.H.ReplyAsync = (request, _) =>
        {
            if (request.RequestUri!.Host == "api.themoviedb.org")
            {
                Interlocked.Increment(ref tmdbReads);
                playlist.Info = playlist.Info with
                {
                    Shares = keepViewShare ? new[] { new ListShare(editor.Id, false) } : Array.Empty<ListShare>(),
                };
            }

            return Task.FromResult(reply(request));
        };

        using var client = f.Client(editor);
        const string Title = "{\"kind\":\"movie\",\"tmdbId\":49521,\"title\":\"Man of Steel\",\"posterPath\":\"/mos.jpg\"}";
        using var response = patch
            ? await client.PatchAsync($"/JellyfinEnhanced/list-placeholders/{listId}/items/{custom.Id}", Json("{\"rev\":" + rev + ",\"link\":" + Title + "}"))
            : await client.PostAsync($"/JellyfinEnhanced/list-placeholders/{listId}/items", Json("{\"placeholders\":[" + Title + "]}"));
        Assert.Equal(expected, response.StatusCode);
        Assert.True(tmdbReads > 0);
        var stored = Assert.Single(f.H.Store.Load(listId)!.Items);
        Assert.Equal((custom.Id, PlaceholderKinds.Custom), (stored.Id, stored.Kind));
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
        using (var busy = await client.PostAsync("/JellyfinEnhanced/list-placeholders/resolve", Json("{\"entries\":[{\"title\":\"Man of Steel\"}]}")))
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
    public async Task GroupedWatchOrdersComeBackPreparedAndImportWithEveryKey()
    {
        using var f = new Fixture();
        f.H.Fetcher.Exact = true;
        f.H.Fetcher.Provider = "chronolists";
        SourceItem Ep(int e) => new("tv", 1412, "tt2193021", 257655, "Arrow", 2012, 1, e, null) { Details = new SourceItemDetails("E" + e, "2012-10-1" + e, "/a.jpg", null, "Season 1") };
        f.H.Lookup.AddShow(FakeImportLookup.Tv(1412, "Arrow", "2012-10-10"), new SeasonFacts(1, 3, "2012-10-10", "Season 1")); // TMDB: S1 has 3 episodes
        f.H.Fetcher.Items = new List<SourceItem> { Ep(1), Ep(2), Ep(3), new("movie", 49521, null, null, "Man of Steel", 2013, null, null, null) { Details = new SourceItemDetails(null, "2013-06-12", null, null, null) } };
        using var owner = f.Client(f.Owner);
        using var viewer = f.Client(f.Viewer);

        // The target list must be editable by the caller (its owner's visibility then counts for "in library").
        Assert.Equal(HttpStatusCode.Forbidden, (await viewer.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://chronolists.com/dctv\",\"listId\":\"" + f.List + "\"}"))).StatusCode);
        JsonElement fetched;
        using (var ok = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://chronolists.com/dctv\",\"listId\":\"" + f.List + "\"}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            fetched = (await Body(ok)).Clone();
        }

        Assert.True(fetched.GetProperty("grouped").GetBoolean());
        Assert.Equal(4, fetched.GetProperty("snapshotKeys").GetArrayLength());
        var season = fetched.GetProperty("entries")[0];
        Assert.Equal(("season", "high", 3), (season.GetProperty("prepared").GetProperty("kind").GetString(), season.GetProperty("prepared").GetProperty("confidence").GetString(), season.GetProperty("sourceKeys").GetArrayLength()));

        const string Body1 = "{\"type\":\"placeholder\",\"sourceKey\":\"tv|1412|1|1\",\"sourceKeys\":[\"tv|1412|1|1\",\"tv|1412|1|2\",\"tv|1412|1|3\"],\"placeholder\":{\"kind\":\"season\",\"tmdbId\":1412,\"title\":\"Arrow\",\"seasonNumber\":1,\"episodeTotal\":3}}";
        const string Source = ",\"source\":{\"url\":\"https://chronolists.com/dctv\",\"syncEnabled\":true,\"snapshotKeys\":[\"tv|1412|1|1\",\"tv|1412|1|2\",\"tv|1412|1|3\",\"movie|49521||\"]}";
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"entries\":[" + Body1.Replace("tv|1412|1|3\"]", "rank 3\"]", StringComparison.Ordinal) + "]" + Source + "}"))).StatusCode);
        // At most 5000 keys in total (the most a fetch hands out), however they are spread over the entries.
        var half = string.Join(",", Enumerable.Range(1, 2501).Select(e => "\"tv|1412|1|" + e + "\""));
        var halfEntry = Body1.Replace("\"sourceKeys\":[\"tv|1412|1|1\",\"tv|1412|1|2\",\"tv|1412|1|3\"]", "\"sourceKeys\":[" + half + "]", StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply",
            Json("{\"entries\":[" + halfEntry + "," + halfEntry + "]" + Source + "}"))).StatusCode);
        Assert.Null(f.H.Store.Load(f.List));

        // Keys the fetched list doesn't have (here 3x99) are ignored, never stored.
        var withUnknown = Body1.Replace("\"tv|1412|1|3\"]", "\"tv|1412|1|3\",\"tv|1412|1|99\"]", StringComparison.Ordinal);
        using (var applied = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply", Json("{\"requestId\":\"chrono-1\",\"entries\":[" + withUnknown + "]" + Source + "}")))
        {
            Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        }

        var source = f.H.Store.Load(f.List)!.Source!;
        var placeholder = f.H.Store.Load(f.List)!.Items.Single();
        Assert.Equal(new[] { "tv|1412|1|1", "tv|1412|1|2", "tv|1412|1|3" }, source.Owned.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.All(source.Owned.Values, o => Assert.Equal(placeholder.Id, o.PhId));
        Assert.True(source.UserRemovedKeys.ContainsKey("movie|49521||")); // not imported: declined
        Assert.Equal("chronolists", source.Kind);
    }

    [Fact]
    public async Task AWholeSeasonOfMoreThanAThousandEpisodesImportsAsOneEntry()
    {
        using var f = new Fixture();
        f.H.Fetcher.Exact = true;
        f.H.Fetcher.Provider = "chronolists";
        f.H.Lookup.AddShow(FakeImportLookup.Tv(30983, "Long Show", "1999-10-20"), new SeasonFacts(1, 1001, "1999-10-20", "Season 1"));
        f.H.Fetcher.Items = Enumerable.Range(1, 1001).Select(e => new SourceItem("tv", 30983, null, null, "Long Show", 1999, 1, e, null) { Details = new SourceItemDetails(null, "1999-10-20", null, null, "Season 1") }).ToList();
        using var owner = f.Client(f.Owner);
        JsonElement entry;
        using (var ok = await owner.PostAsync("/JellyfinEnhanced/list-placeholders/source/fetch", Json("{\"url\":\"https://chronolists.com/dctv\"}")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            entry = (await Body(ok)).GetProperty("entries")[0].Clone();
        }

        Assert.Equal(("season", 1001), (entry.GetProperty("prepared").GetProperty("kind").GetString(), entry.GetProperty("sourceKeys").GetArrayLength()));

        // What the client sends for it: the prepared season with every key of the fetched entry.
        var keys = entry.GetProperty("sourceKeys").GetRawText();
        var body = "{\"entries\":[{\"type\":\"placeholder\",\"sourceKey\":\"tv|30983|1|1\",\"sourceKeys\":" + keys + ",\"placeholder\":{\"kind\":\"season\",\"tmdbId\":30983,\"title\":\"Long Show\",\"seasonNumber\":1,\"episodeTotal\":1001}}],"
            + "\"source\":{\"url\":\"https://chronolists.com/dctv\",\"syncEnabled\":true,\"snapshotKeys\":" + keys + "}}";
        using (var applied = await owner.PostAsync($"/JellyfinEnhanced/list-placeholders/{f.List}/apply", Json(body)))
        {
            Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        }

        Assert.Equal(1001, f.H.Store.Load(f.List)!.Source!.Owned.Count);
    }
}
