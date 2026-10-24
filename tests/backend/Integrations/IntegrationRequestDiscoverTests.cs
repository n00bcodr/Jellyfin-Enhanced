using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

/// <summary>
/// Discover rows and the search row for the JE request backend (acquire/discover, acquire/search):
/// gating, TMDB paths and input caps, per-caller projection (library copies the caller can open,
/// ledger flags, Hidden Content, parental limits), "because you watched", caching, and that bodies
/// carry nothing about instances or paths.
/// </summary>
public class IntegrationRequestDiscoverTests
{
    /// <summary>A Discover service that never reaches TMDB (the route matrix).</summary>
    internal static DiscoverService Offline(RequestService service)
        => new(service, null, (_, _, _, _) => Task.FromResult(false), (_, _, _) => Task.FromResult<string?>(null), (_, _) => Array.Empty<RecentTitle>(), _ => HiddenTitles.None, () => DateTimeOffset.UtcNow);

    internal sealed class Rig : IDisposable
    {
        public IntegrationRequestLedgerTests.Rig R { get; } = new();
        public Dictionary<string, string?> Tmdb { get; } = new(StringComparer.Ordinal);
        public List<(string Path, string Query)> Reads { get; } = new();
        public List<RecentTitle> Recent { get; } = new();
        public HiddenTitles Hidden { get; set; } = HiddenTitles.None;
        public Func<string, int, Guid, Task<bool>> MaySee { get; set; } = (_, _, _) => Task.FromResult(true);
        public int MaySeeCalls;
        public DateTimeOffset Now { get; set; } = new(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);
        public DiscoverService Service { get; }
        public PluginConfiguration Config => R.Policy.Configuration;

        public Rig()
        {
            Service = new DiscoverService(R.Service, null,
                (kind, id, viewer, ct) => { Interlocked.Increment(ref MaySeeCalls); return MaySee(kind, id, viewer.UserId); },
                (path, query, ct) => { lock (Reads) Reads.Add((path, query)); return Task.FromResult(Tmdb.TryGetValue(path, out var json) ? json : null); },
                (viewer, max) => Recent.Take(max).ToList(),
                _ => Hidden,
                () => Now);
        }

        /// <summary>A Kid with Jellyfin parental limits.</summary>
        public Guid AddLimitedKid()
        {
            var viewer = R.View.AddUser(false, parental: true);
            R.Policy.People[viewer.UserId] = new(viewer.UserId, "Kid", true, false, false, true, "p1", "je", "r1", "g1", 7, 7, 0, "{\"score\":5}");
            return viewer.UserId;
        }

        public AcquireDiscoverController Controller(Guid user) => Controller(TestCallers.Principal(user, user == R.Admin));

        public AcquireDiscoverController Controller(ClaimsPrincipal principal)
        {
            var controller = new AcquireDiscoverController(Service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = principal;
            return controller;
        }

        public async Task<(int Status, JsonElement Body, AcquireDiscoverController Controller)> Discover(Guid user, string? list, string? type = "movie", int page = 1, string? language = null)
        {
            var controller = Controller(user);
            return Read(await controller.Discover(list, type, page, language, default), controller);
        }

        public async Task<(int Status, JsonElement Body, AcquireDiscoverController Controller)> Search(Guid user, string? q, int page = 1)
        {
            var controller = Controller(user);
            return Read(await controller.Search(q, page, null, default), controller);
        }

        public void Dispose() => R.Dispose();
    }

    internal static (int Status, JsonElement Body, AcquireDiscoverController Controller) Read(IActionResult result, AcquireDiscoverController controller) => result switch
    {
        FileContentResult file => (200, JsonDocument.Parse(file.FileContents).RootElement.Clone(), controller),
        ContentResult content => (content.StatusCode ?? 200, JsonDocument.Parse(content.Content!).RootElement.Clone(), controller),
        ObjectResult o => (o.StatusCode ?? 200, JsonSerializer.SerializeToElement(o.Value), controller),
        StatusCodeResult code => (code.StatusCode, default, controller),
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    internal static string Page(params object[] rows) => JsonSerializer.Serialize(new { page = 1, total_pages = 37, results = rows });
    internal static object Movie(int id, string title, string? date = "2024-05-01", string? poster = "/p.jpg", string? overview = "An overview.", bool adult = false)
        => new { id, title, release_date = date, poster_path = poster, overview, adult, media_type = "movie" };
    internal static object Show(int id, string name, string? date = "2023-01-02") => new { id, name, first_air_date = date, poster_path = "/s.jpg", overview = "A show.", media_type = "tv" };

    private static string[] Keys(JsonElement body) => body.GetProperty("answer").GetProperty("results").EnumerateArray().Select(e => e.GetProperty("key").GetString()!).ToArray();
    private static JsonElement Card(JsonElement body, string key) => body.GetProperty("answer").GetProperty("results").EnumerateArray().Single(e => e.GetProperty("key").GetString() == key);

    [Theory]
    [InlineData("trending")][InlineData("search")][InlineData("because")]
    public async Task HideDuringPendingProjectionRemovesCardsAndSeedBeforeCacheAndReturn(string list)
    {
        using var rig = new Rig(); var user = rig.AddLimitedKid();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        rig.MaySee = async (_,_,_) => { started.TrySetResult(); await release.Task; return true; };
        rig.Recent.Add(new RecentTitle(true, 9, "Secret seed"));
        rig.Tmdb["trending/movie/week"] = rig.Tmdb["search/multi"] = rig.Tmdb["movie/9/recommendations"] = Page(Movie(42,"Secret"));
        var pending = list == "search" ? rig.Search(user,"Secret") : rig.Discover(user,list);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var keys = new HashSet<string> { "movie:tmdb:42", "movie:tmdb:9" }; rig.Hidden = new HiddenTitles(keys,keys); release.SetResult();
        var result = await pending; Assert.DoesNotContain("Secret", result.Body.GetRawText());
        var repeat = list == "search" ? await rig.Search(user,"Secret") : await rig.Discover(user,list);
        Assert.DoesNotContain("Secret", repeat.Body.GetRawText());
    }

    [Fact]
    public async Task SeerrModePhaseOffWatchersApiKeysAndUnknownUsersAreRefusedBeforeAnyRead()
    {
        using var rig = new Rig();
        rig.Tmdb["trending/movie/week"] = Page(Movie(1, "One"));
        var watcher = rig.R.Add("Watcher");

        rig.Config.ArrRequestBackend = "seerr";
        foreach (var (status, body, _) in new[] { await rig.Discover(rig.R.Member, "trending"), await rig.Search(rig.R.Member, "dune") })
        {
            Assert.Equal(403, status);
            Assert.Equal("feature_disabled", body.GetProperty("reason").GetString());
        }
        rig.Config.ArrRequestBackend = "je";
        rig.Config.ArrPhase3Enabled = false;
        Assert.Equal("feature_disabled", (await rig.Discover(rig.R.Member, "trending")).Body.GetProperty("reason").GetString());
        rig.Config.ArrPhase3Enabled = true;

        var refused = await rig.Discover(watcher, "trending");
        Assert.Equal(403, refused.Status);
        Assert.Equal("requests_create_required", refused.Body.GetProperty("reason").GetString());
        Assert.Equal(403, (await rig.Search(watcher, "dune")).Status);

        foreach (var principal in new[] { TestCallers.ApiKey(), TestCallers.Unknown() })
        {
            var controller = rig.Controller(principal);
            var discover = Read(await controller.Discover("trending", "movie", 1, null, default), controller);
            var search = Read(await rig.Controller(principal).Search("dune", 1, null, default), controller);
            Assert.Equal((403, "user_required"), (discover.Status, discover.Body.GetProperty("reason").GetString()));
            Assert.Equal((403, "user_required"), (search.Status, search.Body.GetProperty("reason").GetString()));
        }
        Assert.Empty(rig.Reads);

        // The refusals are the caller and the mode: a member in JE mode gets the row.
        var ok = await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(200, ok.Status);
        Assert.Equal("private, no-cache", ok.Controller.Response.Headers["Cache-Control"].ToString());
        Assert.Equal(new[] { "movie:tmdb:1" }, Keys(ok.Body));
    }

    [Fact]
    public async Task ListsReadOneTmdbPageEachAndInputsAreValidated()
    {
        using var rig = new Rig();
        foreach (var path in new[] { "trending/movie/week", "trending/tv/week", "movie/upcoming", "tv/on_the_air", "movie/popular", "tv/popular" })
            rig.Tmdb[path] = Page(path.Contains("tv", StringComparison.Ordinal) ? Show(5, "Show") : Movie(5, "Film"));

        var trending = await rig.Discover(rig.R.Member, "trending", "movie", 2, "de-DE");
        Assert.Equal(200, trending.Status);
        Assert.Equal(("trending/movie/week", "?page=2&language=de-DE"), rig.Reads.Last());
        Assert.Equal(10, trending.Body.GetProperty("answer").GetProperty("totalPages").GetInt32());   // TMDB says 37; capped
        await rig.Discover(rig.R.Member, "upcoming", "tv", 1, "<script>");
        Assert.Equal(("tv/on_the_air", "?page=1"), rig.Reads.Last());                                  // a bad language is left out
        await rig.Discover(rig.R.Member, "upcoming", "movie");
        Assert.Equal("movie/upcoming", rig.Reads.Last().Path);
        var popular = await rig.Discover(rig.R.Member, "popular", "tv");
        Assert.Equal("tv/popular", rig.Reads.Last().Path);
        Assert.Equal("tv", Card(popular.Body, "tv:tmdb:5").GetProperty("kind").GetString());
        await rig.Discover(rig.R.Member, "trending", null);
        Assert.Equal("trending/movie/week", rig.Reads.Last().Path);                                     // type defaults to movie
        var reads = rig.Reads.Count;

        foreach (var (list, type, page) in new (string?, string?, int)[] { (null, "movie", 1), ("everything", "movie", 1), ("trending", "person", 1), ("trending", "movie", 0), ("trending", "movie", 11) })
        {
            var bad = await rig.Discover(rig.R.Member, list, type, page);
            Assert.Equal(400, bad.Status);
            Assert.Equal("invalid_input", bad.Body.GetProperty("reason").GetString());
        }
        Assert.Equal(reads, rig.Reads.Count);

        // TMDB not set up (or failing): an honest 503, nothing cached.
        rig.Tmdb["movie/popular"] = null;
        var down = await rig.Discover(rig.R.Member, "popular", "movie", 3);
        Assert.Equal(503, down.Status);
        Assert.Equal("discover_unavailable", down.Body.GetProperty("reason").GetString());
        Assert.Equal("unavailable", down.Body.GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task CardsCarryVisibleCopiesAndLedgerFlagsButNothingAboutInstancesOrPaths()
    {
        using var rig = new Rig();
        var longText = new string('x', 900);
        rig.Tmdb["trending/movie/week"] = Page(
            Movie(1, "In my library"), Movie(2, "Only in a library I can't open"), Movie(3, "A kid asked"), Movie(4, "I asked"), Movie(5, "I wait"),
            Movie(6, "Bad poster", poster: "../../etc/passwd", overview: longText, date: "not a date"), Movie(7, "Adult", adult: true),
            new { id = 9, name = "A person", media_type = "person" }, new { id = 0, title = "No id" }, new { id = 8 });
        var mine = Guid.NewGuid(); var hidden = Guid.NewGuid();
        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:1")!, new JfCopy { ItemId = mine, LibraryId = "lib1", LibraryName = "Movies", Path = "/media/secret/movies/One.mkv" });
        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:2")!, new JfCopy { ItemId = hidden, LibraryId = "lib4k", LibraryName = "Movies 4K", Path = "/media/secret/4k/Two.mkv" }, rig.R.Admin);
        await rig.R.Create(rig.R.Kid, IntegrationRequestLedgerTests.Movie(3));
        await rig.R.Create(rig.R.Member, IntegrationRequestLedgerTests.Movie(4));
        rig.Config.ArrRequestPreset = "approve_everything";
        var waiting = await rig.R.Create(rig.R.Member, IntegrationRequestLedgerTests.Movie(5));
        Assert.Equal("awaiting_approval", waiting.Reason);

        var (status, body, _) = await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(200, status);
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:2", "movie:tmdb:3", "movie:tmdb:4", "movie:tmdb:5", "movie:tmdb:6" }, Keys(body));
        var one = Card(body, "movie:tmdb:1");
        Assert.True(one.GetProperty("inLibrary").GetBoolean());
        Assert.Equal(mine.ToString("N"), one.GetProperty("itemId").GetString());
        Assert.Equal(2024, one.GetProperty("year").GetInt32());
        Assert.Equal("/p.jpg", one.GetProperty("poster").GetString());
        Assert.Equal(1, one.GetProperty("tmdbId").GetInt32());
        var two = Card(body, "movie:tmdb:2");
        Assert.False(two.GetProperty("inLibrary").GetBoolean());
        Assert.Equal(JsonValueKind.Null, two.GetProperty("itemId").ValueKind);
        var kidAsked = Card(body, "movie:tmdb:3");
        Assert.True(kidAsked.GetProperty("requested").GetBoolean());
        Assert.Equal(JsonValueKind.Null, kidAsked.GetProperty("mine").ValueKind);                       // someone else asked
        Assert.Equal("asked", Card(body, "movie:tmdb:4").GetProperty("mine").GetString());
        Assert.Equal("waiting", Card(body, "movie:tmdb:5").GetProperty("mine").GetString());
        var six = Card(body, "movie:tmdb:6");
        Assert.Equal(JsonValueKind.Null, six.GetProperty("poster").ValueKind);
        Assert.Equal(JsonValueKind.Null, six.GetProperty("year").ValueKind);
        Assert.True(six.GetProperty("overview").GetString()!.Length <= DiscoverService.MaxOverview);
        Assert.False(six.GetProperty("requested").GetBoolean());

        // The kid's own view of the title they asked for.
        Assert.Equal("waiting", Card((await rig.Discover(rig.R.Kid, "trending")).Body, "movie:tmdb:3").GetProperty("mine").GetString());

        var raw = body.GetRawText();
        foreach (var leak in new[] { "/media", "secret", "Movies 4K", "lib4k", "lib1", "\"path\"", "instance", "Radarr", "Sonarr", "profile", "rootFolder", hidden.ToString("N") })
            Assert.DoesNotContain(leak, raw, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CardsSayWhatTheCallersOwnAsksCoverSoAPartialAskLeavesTheRestRequestable()
    {
        using var rig = new Rig();
        rig.Tmdb["search/multi"] = Page(Show(10, "One season asked"), Movie(11, "Asked in 4K"), Movie(12, "Asked in HD"), Show(13, "Nothing asked"), Show(14, "Episodes asked"));
        rig.R.Policy.People[rig.R.Member] = rig.R.Policy.People[rig.R.Member] with { Can4k = true };
        await rig.R.Create(rig.R.Member, new MutationInput { Key = "tv:tmdb:10", Scope = "seasons", Seasons = new[] { 1, 2 } });
        await rig.R.Create(rig.R.Member, new MutationInput { Key = "tv:tmdb:10", Scope = "seasons", Seasons = new[] { 3 }, Variant = "4k" });
        await rig.R.Create(rig.R.Member, IntegrationRequestLedgerTests.Movie(11, "4k"));
        await rig.R.Create(rig.R.Member, IntegrationRequestLedgerTests.Movie(12));
        await rig.R.Create(rig.R.Member, new MutationInput { Key = "tv:tmdb:14", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } });

        var (status, body, _) = await rig.Search(rig.R.Member, "asked");
        Assert.Equal(200, status);
        var series = Card(body, "tv:tmdb:10");
        Assert.Equal("asked", series.GetProperty("mine").GetString());
        Assert.Equal(new[] { 1, 2 }, series.GetProperty("mineSeasons").EnumerateArray().Select(e => e.GetInt32()));   // the 4K season is not a standard one
        Assert.Equal(new[] { "4k", "standard" }, series.GetProperty("mineVariants").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(new[] { "4k" }, Card(body, "movie:tmdb:11").GetProperty("mineVariants").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(new[] { "standard" }, Card(body, "movie:tmdb:12").GetProperty("mineVariants").EnumerateArray().Select(e => e.GetString()));
        Assert.False(Card(body, "movie:tmdb:12").TryGetProperty("mineSeasons", out _));
        var none = Card(body, "tv:tmdb:13");
        Assert.False(none.TryGetProperty("mineVariants", out _));
        Assert.False(none.TryGetProperty("mineSeasons", out _));
        var episodes = Card(body, "tv:tmdb:14");
        Assert.False(episodes.TryGetProperty("mineSeasons", out _));   // some episodes are not a whole season

        // Someone else's view of the same titles carries none of it.
        var other = (await rig.Search(rig.R.Kid, "asked")).Body;
        Assert.False(Card(other, "tv:tmdb:10").TryGetProperty("mineSeasons", out _));
        Assert.False(Card(other, "movie:tmdb:11").TryGetProperty("mineVariants", out _));
    }

    [Fact]
    public async Task SearchIsCappedAndKeepsOnlyMoviesAndSeries()
    {
        using var rig = new Rig();
        rig.Tmdb["search/multi"] = Page(Movie(1, "Dune"), Show(2, "Dune: Prophecy"), new { id = 3, name = "Denis Villeneuve", media_type = "person" }, new { id = 4, name = "Collection", media_type = "collection" });

        var tooLong = await rig.Search(rig.R.Member, new string('a', DiscoverService.MaxQuery + 1));
        Assert.Equal((400, "query_too_long"), (tooLong.Status, tooLong.Body.GetProperty("reason").GetString()));
        foreach (var q in new[] { null, "", "   " })
            Assert.Equal(400, (await rig.Search(rig.R.Member, q)).Status);
        Assert.Equal(400, (await rig.Search(rig.R.Member, "dune", 11)).Status);
        Assert.Empty(rig.Reads);

        var (status, body, _) = await rig.Search(rig.R.Member, "  dune & co?  ", 2);
        Assert.Equal(200, status);
        Assert.Equal(("search/multi", "?page=2&include_adult=false&query=dune%20%26%20co%3F"), rig.Reads.Single());
        Assert.Equal(new[] { "movie:tmdb:1", "tv:tmdb:2" }, Keys(body));
        Assert.Equal("search", body.GetProperty("answer").GetProperty("list").GetString());
        Assert.Equal(200, (await rig.Search(rig.R.Member, new string('a', DiscoverService.MaxQuery))).Status);
    }

    [Fact]
    public async Task KidsHideSearchRefusesKidsOnlyAndLeavesDiscoverOn()
    {
        using var rig = new Rig();
        rig.Tmdb["search/multi"] = Page(Movie(1, "Dune"));
        rig.Tmdb["trending/movie/week"] = Page(Movie(1, "Dune"));
        Assert.False(new PluginConfiguration().ArrKidsHideSearch);
        Assert.Equal(200, (await rig.Search(rig.R.Kid, "dune")).Status);

        rig.Config.ArrKidsHideSearch = true;
        var kid = await rig.Search(rig.R.Kid, "dune");
        Assert.Equal((403, "search_hidden"), (kid.Status, kid.Body.GetProperty("reason").GetString()));
        Assert.Equal(200, (await rig.Search(rig.R.Member, "dune")).Status);
        Assert.Equal(200, (await rig.Search(rig.R.Manager, "dune")).Status);
        Assert.Equal(200, (await rig.Discover(rig.R.Kid, "trending")).Status);
    }

    [Fact]
    public async Task BecauseYouWatchedUsesAtMostThreeRecentTitlesAndIsEmptyWithoutAny()
    {
        using var rig = new Rig();
        var none = await rig.Discover(rig.R.Member, "because");
        Assert.Equal(200, none.Status);
        Assert.Empty(none.Body.GetProperty("answer").GetProperty("groups").EnumerateArray());
        Assert.Empty(rig.Reads);

        rig.Recent.AddRange(new[] { new RecentTitle(true, 10, "Arrival"), new RecentTitle(false, 20, "Severance"), new RecentTitle(true, 30, "Nothing similar"), new RecentTitle(true, 40, "Fourth") });
        rig.Tmdb["movie/10/recommendations"] = Page(Movie(11, "Sicario"), Movie(10, "Arrival"), Movie(12, "Enemy"));
        rig.Tmdb["tv/20/recommendations"] = JsonSerializer.Serialize(new { results = new[] { Show(21, "Dark") } });
        rig.Tmdb["movie/30/recommendations"] = Page();
        rig.Tmdb["movie/40/recommendations"] = Page(Movie(41, "Never read"));
        var (status, body, _) = await rig.Discover(rig.R.Member, "because", "tv", 7);
        Assert.Equal(200, status);
        Assert.Equal(new[] { "movie/10/recommendations", "tv/20/recommendations", "movie/30/recommendations" }, rig.Reads.Select(r => r.Path));
        Assert.All(rig.Reads, r => Assert.Equal("?page=1", r.Query));
        var groups = body.GetProperty("answer").GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(new[] { "Arrival", "Severance" }, groups.Select(g => g.GetProperty("basedOn").GetString()));
        Assert.Equal(new[] { "movie:tmdb:11", "movie:tmdb:12" }, groups[0].GetProperty("results").EnumerateArray().Select(c => c.GetProperty("key").GetString()));   // not the watched title itself
        Assert.Equal("tv:tmdb:21", groups[1].GetProperty("results")[0].GetProperty("key").GetString());
        Assert.Equal("movie:tmdb:10", groups[0].GetProperty("key").GetString());
    }

    [Fact]
    public async Task HiddenContentLeavesOutGloballyHiddenTitlesPerSurface()
    {
        using var rig = new Rig();
        var hiddenCopy = Guid.NewGuid();
        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:4")!, new JfCopy { ItemId = hiddenCopy });
        rig.Hidden = DiscoverService.FromHiddenContent(new UserHiddenContent
        {
            Settings = new HiddenContentSettings { Enabled = true, FilterDiscovery = true, FilterSearch = false },
            Items = new()
            {
                ["a"] = new HiddenContentItem { TmdbId = "1", Type = "Movie" },
                ["b"] = new HiddenContentItem { TmdbId = "2", Type = "Series" },
                ["c"] = new HiddenContentItem { TmdbId = "3", Type = "Movie", HideScope = "nextup" },
                ["d"] = new HiddenContentItem { ItemId = hiddenCopy.ToString(), Type = "Movie" },
            },
        });
        rig.Tmdb["trending/movie/week"] = Page(Movie(1, "Hidden film"), Movie(3, "Hidden on Next Up only"), Movie(4, "Hidden copy"));
        rig.Tmdb["trending/tv/week"] = Page(Show(2, "Hidden show"), Show(1, "Same id, other kind"));
        rig.Tmdb["search/multi"] = Page(Movie(1, "Hidden film"), Show(2, "Hidden show"), Movie(3, "Hidden on Next Up only"), Movie(4, "Hidden copy"), Show(1, "Same id, other kind"));

        Assert.Equal(new[] { "movie:tmdb:3" }, Keys((await rig.Discover(rig.R.Member, "trending")).Body));
        Assert.Equal(new[] { "tv:tmdb:1" }, Keys((await rig.Discover(rig.R.Member, "trending", "tv")).Body));
        // Search filtering is the user's own choice (off by default in Hidden Content).
        Assert.Equal(5, Keys((await rig.Search(rig.R.Member, "hidden")).Body).Length);

        Assert.Same(HiddenTitles.None, DiscoverService.FromHiddenContent(new UserHiddenContent { Settings = new HiddenContentSettings { Enabled = false }, Items = new() { ["a"] = new HiddenContentItem { TmdbId = "1", Type = "Movie" } } }));
        Assert.Same(HiddenTitles.None, DiscoverService.FromHiddenContent(null));
    }

    [Fact]
    public async Task ParentalLimitsNeedAVisibleCopyOrAVerifiedRatingAndFailuresRefuse()
    {
        using var rig = new Rig();
        var kid = rig.AddLimitedKid();
        var open = Guid.NewGuid(); var blocked = Guid.NewGuid();
        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:1")!, new JfCopy { ItemId = open });
        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:2")!, new JfCopy { ItemId = blocked }, rig.R.Admin);   // Jellyfin hides it from the kid
        rig.Tmdb["trending/movie/week"] = Page(Movie(1, "Visible copy"), Movie(2, "Hidden copy"), Movie(3, "Rated G"), Movie(4, "Rated R"), Movie(5, "Lookup fails"));
        rig.MaySee = (kind, id, user) => id switch
        {
            3 => Task.FromResult(true),
            5 => Task.FromException<bool>(new HttpRequestException("down")),
            _ => Task.FromResult(false),
        };

        var (status, body, _) = await rig.Discover(kid, "trending");
        Assert.Equal(200, status);
        Assert.False(body.GetProperty("answer").GetProperty("complete").GetBoolean());
        Assert.Equal(new[] { "movie:tmdb:1", "movie:tmdb:3" }, Keys(body));
        Assert.Equal(3, rig.MaySeeCalls);                     // absent titles only; copies decide by Jellyfin's own check
        Assert.True(Card(body, "movie:tmdb:1").GetProperty("inLibrary").GetBoolean());

        // Callers without limits never pay for rating lookups.
        Assert.Equal(5, Keys((await rig.Discover(rig.R.Member, "trending")).Body).Length);
        Assert.Equal(3, rig.MaySeeCalls);
    }

    [Fact]
    public async Task AnswersAreCachedPerCallerAndAnAskOrALibraryChangeRefreshesThem()
    {
        using var rig = new Rig();
        rig.Tmdb["trending/movie/week"] = Page(Movie(1, "One"));
        var first = await rig.Discover(rig.R.Member, "trending");
        await rig.Discover(rig.R.Member, "trending");
        Assert.Single(rig.Reads);
        await rig.Discover(rig.R.Manager, "trending");
        Assert.Equal(2, rig.Reads.Count);                                     // never another caller's body

        // ETag: the same body answers 304.
        var controller = rig.Controller(rig.R.Member);
        controller.Request.Headers["If-None-Match"] = first.Controller.Response.Headers["ETag"].ToString();
        Assert.Equal(304, Read(await controller.Discover("trending", "movie", 1, null, default), controller).Status);

        await rig.R.Create(rig.R.Member, IntegrationRequestLedgerTests.Movie(1));
        var asked = await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(3, rig.Reads.Count);
        Assert.Equal("asked", Card(asked.Body, "movie:tmdb:1").GetProperty("mine").GetString());

        rig.R.View.AddCopy(TitleKey.Parse("movie:tmdb:1")!, new JfCopy { ItemId = Guid.NewGuid() });
        rig.R.View.Rev++;
        Assert.True(Card((await rig.Discover(rig.R.Member, "trending")).Body, "movie:tmdb:1").GetProperty("inLibrary").GetBoolean());
        Assert.Equal(4, rig.Reads.Count);

        rig.Now = rig.Now.AddMinutes(3);
        await rig.Discover(rig.R.Member, "trending");
        Assert.Equal(5, rig.Reads.Count);                                     // a short time only
    }
}

/// <summary>Kids through the production parental filter: verified ratings only (G yes; R, unrated and failures no).</summary>
[Collection("Plugin singleton")]
public class IntegrationRequestDiscoverParentalTests
{
    [Fact]
    public async Task KidsSeeOnlyTitlesWithAVerifiedRatingWithinTheirLimit()
    {
        using var arr = new FakeArr();
        var config = arr.Plugin.Plugin.Configuration;
        config.JellyseerrEnabled = true; config.JellyseerrUrls = "http://seerr.invalid"; config.JellyseerrApiKey = "test-seerr";
        var ratings = new Dictionary<string, string> { ["101"] = "G", ["102"] = "R", ["103"] = "" };
        using var transport = new IntegrationTransport((request, _) =>
        {
            var id = request.RequestUri!.AbsolutePath.Split('/').Last();
            if (!ratings.TryGetValue(id, out var rating)) return Task.FromResult(IntegrationTransport.Response("{}", 500));
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new
            { id = int.Parse(id), releases = new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = rating } } } } }, keywords = new { keywords = Array.Empty<object>() }, genres = Array.Empty<object>() })));
        });
        using var rig = new IntegrationRequestDiscoverTests.Rig();
        var kid = rig.AddLimitedKid();
        var user = (User)rig.R.View.Users[kid].Handle!; user.MaxParentalRatingScore = 10;
        var users = new Mock<IUserManager>(); users.Setup(u => u.GetUserById(kid)).Returns(user);
        var localization = new Mock<ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        localization.Setup(l => l.GetRatingScore("R", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(18, null));
        var server = new Mock<IServerConfigurationManager>(); server.SetupGet(s => s.Configuration).Returns(new ServerConfiguration { MetadataCountryCode = "US" });
        var parental = new SeerrParentalFilter(transport, users.Object, localization.Object, server.Object, arr.Plugin.Core.Logger);
        rig.MaySee = (kind, id, person) => parental.MaySeeAbsentAsync(kind, id, person.ToString("N"), default);
        rig.Tmdb["trending/movie/week"] = IntegrationRequestDiscoverTests.Page(
            IntegrationRequestDiscoverTests.Movie(101, "Rated G"), IntegrationRequestDiscoverTests.Movie(102, "Rated R"),
            IntegrationRequestDiscoverTests.Movie(103, "Unrated"), IntegrationRequestDiscoverTests.Movie(104, "Lookup fails"));

        var (status, body, _) = await rig.Discover(kid, "trending");
        Assert.Equal(200, status);
        Assert.Equal(new[] { "movie:tmdb:101" }, body.GetProperty("answer").GetProperty("results").EnumerateArray().Select(c => c.GetProperty("key").GetString()));

        // A member (no limits) sees all four without a single rating lookup.
        var calls = transport.Calls;
        Assert.Equal(4, (await rig.Discover(rig.R.Member, "trending")).Body.GetProperty("answer").GetProperty("results").GetArrayLength());
        Assert.Equal(calls, transport.Calls);
    }
}
