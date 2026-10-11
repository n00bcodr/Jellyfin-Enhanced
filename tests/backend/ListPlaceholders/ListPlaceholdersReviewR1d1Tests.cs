using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// Review round 1, track d1: list fetches that lack their list array are errors (F16, with the sync's empty-snapshot
// safety net), TMDB list reads are never served stale from the TMDB response cache (F17), and upstream list fetches
// are limited per user, the result cache is bounded and "Sync now" has a cooldown (F29).
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR1d1Tests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<HttpRequestMessage> Requests { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, Task<HttpResponseMessage>>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public ListSourceFetcher Fetcher { get; }

        public Net()
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Requests)
                {
                    Requests.Add(request);
                }

                var key = request.RequestUri!.GetLeftPart(UriPartial.Path);
                return Routes.TryGetValue(key, out var route) ? route(request) : Task.FromResult(IntegrationTransport.Response("{\"message\":\"not found\"}", 404));
            });
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            Fetcher = new ListSourceFetcher(Transport, Tmdb, new SeerrCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger);
        }

        public void Json(string url, string body) => Routes[url] = _ => Task.FromResult(IntegrationTransport.Response(body));

        public int Count(string path)
        {
            lock (Requests)
            {
                return Requests.Count(r => r.RequestUri!.AbsolutePath == path);
            }
        }

        public Task<SourceFetchResult> Fetch(string url, SourceFetchOptions? options = null)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, options ?? new SourceFetchOptions(), None);
        }

        public void Dispose()
        {
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static string MovieArray(int from, int count) =>
        "[" + string.Join(',', Enumerable.Range(from, count).Select(i => $"{{\"id\":{i},\"mediatype\":\"movie\",\"title\":\"M{i}\"}}")) + "]";

    // ── F16 ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task AnMdblistAnswerWithoutAnyListArrayIsAnErrorNotAnEmptyList()
    {
        using var net = new Net();
        net.Json("https://mdblist.com/lists/me/broken/json", "{\"error\":\"List not found\"}");
        var broken = await net.Fetch("https://mdblist.com/lists/me/broken", new SourceFetchOptions { Fresh = true });
        Assert.Equal((false, "upstream_error"), (broken.Ok, broken.ErrorCode));

        // The API (administrators, private lists) the same way.
        net.Plugin.Plugin.Configuration.MdblistApiKey = "mdb-key";
        net.Json("https://api.mdblist.com/lists/me/private/items", "{\"error\":\"Invalid API key\"}");
        var api = await net.Fetch("https://mdblist.com/lists/me/private", new SourceFetchOptions { AllowMdblistApi = true, Fresh = true });
        Assert.Equal((false, "upstream_error"), (api.Ok, api.ErrorCode));

        // A list that really is empty still reads as an empty list.
        net.Json("https://mdblist.com/lists/me/empty/json", "{\"movies\":[],\"shows\":[]}");
        var empty = await net.Fetch("https://mdblist.com/lists/me/empty", new SourceFetchOptions { Fresh = true });
        Assert.Equal((true, 0), (empty.Ok, empty.Items.Count));
        net.Json("https://mdblist.com/lists/me/none/json", "[]");
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/none", new SourceFetchOptions { Fresh = true })).Ok);
    }

    [Fact]
    public async Task TmdbAndSeerrAnswersWithoutTheirListArrayAreErrors()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        config.TMDB_API_KEY = "tmdb-key";
        net.Json("https://api.themoviedb.org/3/collection/10", "{\"id\":10,\"name\":\"Star Wars Collection\"}");
        net.Json("https://api.themoviedb.org/3/list/8136", "{\"status_code\":34,\"status_message\":\"gone\",\"total_pages\":1}");
        net.Json("https://api.themoviedb.org/3/movie/top_rated", "{\"page\":1}");
        Assert.Equal("upstream_error", (await net.Fetch("https://www.themoviedb.org/collection/10")).ErrorCode);
        Assert.Equal("upstream_error", (await net.Fetch("https://www.themoviedb.org/list/8136")).ErrorCode);
        Assert.Equal("upstream_error", (await net.Fetch("https://www.themoviedb.org/movie/top-rated")).ErrorCode);

        net.Json("https://api.themoviedb.org/3/collection/11", "{\"id\":11,\"name\":\"Empty\",\"parts\":[]}");
        var empty = await net.Fetch("https://www.themoviedb.org/collection/11");
        Assert.Equal((true, 0), (empty.Ok, empty.Items.Count));

        // The Seerr fallback (no TMDB key) the same way.
        config.TMDB_API_KEY = string.Empty;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        net.Json("http://seerr.test/api/v1/collection/12", "{\"id\":12,\"name\":\"No parts\"}");
        net.Json("http://seerr.test/api/v1/discover/trending", "{\"page\":1,\"totalPages\":1}");
        Assert.Equal("upstream_error", (await net.Fetch("https://www.themoviedb.org/collection/12")).ErrorCode);
        Assert.Equal("upstream_error", (await net.Fetch("https://www.themoviedb.org/trending/movie/week")).ErrorCode);
    }

    private sealed class World : IDisposable
    {
        public const string Url = "https://mdblist.com/lists/me/dc";

        public ListPlaceholdersHarness H { get; } = new();
        public User Owner { get; }
        public FakeListHost.FakeList List { get; }

        public World()
        {
            H.Plugin.Plugin.Configuration.ListPlaceholdersSyncEnabled = true;
            Owner = H.NewUser("owner");
            List = H.Host.AddPlaylist(Owner);
            foreach (var id in new[] { 1, 2, 3 })
            {
                H.Lookup.Details[("movie", id)] = new TitleDetails(FakeImportLookup.Movie(id, "Movie " + id, "2020-01-01"), null, null, "Released", null, Array.Empty<SeasonFacts>());
            }
        }

        public ListAccess Access => H.AccessFor(List, Owner);

        public ListDoc Doc => H.Store.Load(Access.ListIdN)!;

        public static SourceItem M(int tmdb) => new("movie", tmdb, null, null, "Movie " + tmdb, 2020, null, null, null);

        public void Source(params SourceItem[] items) => H.Fetcher.Items = items.ToList();

        public async Task Link(bool removeDropped)
        {
            var outcome = await H.Sources.LinkAsync(Access, new LinkSourceRequest { Url = Url, SyncEnabled = true, RemoveDropped = removeDropped }, None);
            Assert.Equal(200, outcome.StatusCode);
        }

        public Task<SourceSyncResultDto> Sync() => H.Sources.SyncAsync(Access.ListIdN, background: true, None);

        public List<string?> Titles() => Doc.Items.Select(p => p.Title).OrderBy(t => t, StringComparer.Ordinal).ToList<string?>();

        public void Dispose() => H.Dispose();
    }

    [Fact]
    public async Task ASourceThatSuddenlyAnswersEmptyRemovesNothing()
    {
        using var w = new World();
        w.Source(World.M(1), World.M(2));
        await w.Link(removeDropped: true);
        Assert.Equal(2, (await w.Sync()).Added);

        // A "successful" empty answer after a non-empty snapshot is far more likely an upstream fault than a list
        // whose every entry was deleted: like a partial answer, nothing is removed and the snapshot stays.
        w.Source();
        var empty = await w.Sync();
        Assert.Equal(("ok", 0), (empty.State, empty.Removed));
        Assert.Equal(new[] { "Movie 1", "Movie 2" }, w.Titles());
        Assert.Equal(new[] { "movie|1||", "movie|2||" }, w.Doc.Source!.LastSnapshotKeys);
        Assert.True(w.Doc.Source.LastSync!.Partial);

        // Entries that really leave a non-empty source are still removed.
        w.Source(World.M(1));
        var dropped = await w.Sync();
        Assert.Equal(1, dropped.Removed);
        Assert.Equal(new[] { "Movie 1" }, w.Titles());
    }

    // ── F17 ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task TmdbListsAndCollectionsAreReadFreshNotFromTheTmdbResponseCache()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        var version = 1;
        net.Routes["https://api.themoviedb.org/3/list/8136"] = _ => Task.FromResult(IntegrationTransport.Response(
            $"{{\"name\":\"L\",\"total_pages\":1,\"items\":[{{\"id\":{version},\"media_type\":\"movie\",\"title\":\"M\"}}]}}"));
        net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => Task.FromResult(IntegrationTransport.Response(
            $"{{\"name\":\"C\",\"parts\":[{{\"id\":{version},\"title\":\"M\",\"release_date\":\"2000-01-01\"}}]}}"));

        Assert.Equal("movie|1||", Assert.Single((await net.Fetch("https://www.themoviedb.org/list/8136")).Items).Key);
        Assert.Equal("movie|1||", Assert.Single((await net.Fetch("https://www.themoviedb.org/collection/10")).Items).Key);

        // The user edits the list on TMDB; a sync (fresh) sees it at once, not hours later.
        version = 2;
        Assert.Equal("movie|2||", Assert.Single((await net.Fetch("https://www.themoviedb.org/list/8136", new SourceFetchOptions { Fresh = true })).Items).Key);
        Assert.Equal("movie|2||", Assert.Single((await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Fresh = true })).Items).Key);
        Assert.Equal(2, net.Count("/3/list/8136"));
    }

    [Fact]
    public async Task TmdbResponseCacheRefreshSkipsTheCachedCopyAndStoresTheNewOne()
    {
        var version = 1;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response($"{{\"v\":{version}}}")));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);

        Assert.Equal("{\"v\":1}", (await cache.GetAsync("list/1", string.Empty, "k", None)).Content);
        version = 2;
        Assert.Equal("{\"v\":1}", (await cache.GetAsync("list/1", string.Empty, "k", None)).Content); // existing callers: cached
        Assert.Equal(1, transport.Calls);

        Assert.Equal("{\"v\":2}", (await cache.GetAsync("list/1", string.Empty, "k", None, refresh: true)).Content);
        Assert.Equal(2, transport.Calls);
        Assert.Equal("{\"v\":2}", (await cache.GetAsync("list/1", string.Empty, "k", None)).Content); // stored for everyone
        Assert.Equal(2, transport.Calls);
    }

    // ── F29 ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task UncachedFetchesAreLimitedPerCaller()
    {
        using var net = new Net();
        for (var i = 0; i <= ListSourceFetcher.MaxFetchesPerCaller; i++)
        {
            net.Json($"https://mdblist.com/lists/me/l{i}/json", MovieArray(1, 1));
        }

        var alice = new SourceFetchOptions { Caller = "alice" };
        for (var i = 0; i < ListSourceFetcher.MaxFetchesPerCaller; i++)
        {
            Assert.True((await net.Fetch($"https://mdblist.com/lists/me/l{i}", alice)).Ok);
        }

        var limited = await net.Fetch($"https://mdblist.com/lists/me/l{ListSourceFetcher.MaxFetchesPerCaller}", alice);
        Assert.Equal((false, "fetch_limited"), (limited.Ok, limited.ErrorCode));
        Assert.InRange(limited.RetryAfterSeconds!.Value, 1, (int)ListSourceFetcher.CallerWindow.TotalSeconds);
        Assert.Equal(0, net.Count($"/lists/me/l{ListSourceFetcher.MaxFetchesPerCaller}/json"));

        // Cached results cost nothing; other users and the sync (no caller) aren't affected.
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/l0", alice)).Ok);
        Assert.True((await net.Fetch($"https://mdblist.com/lists/me/l{ListSourceFetcher.MaxFetchesPerCaller}", new SourceFetchOptions { Caller = "bob" })).Ok);
        Assert.True((await net.Fetch("https://mdblist.com/lists/me/l1", new SourceFetchOptions { Fresh = true })).Ok);
    }

    [Fact]
    public async Task ACallerRunsOnlyAFewUncachedFetchesAtOnce()
    {
        using var net = new Net();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrived = 0;
        for (var i = 0; i <= ListSourceFetcher.MaxConcurrentFetchesPerCaller; i++)
        {
            net.Routes[$"https://mdblist.com/lists/me/slow{i}/json"] = async _ =>
            {
                Interlocked.Increment(ref arrived);
                await release.Task;
                return IntegrationTransport.Response(MovieArray(1, 1));
            };
        }

        var alice = new SourceFetchOptions { Caller = "alice" };
        var running = Enumerable.Range(0, ListSourceFetcher.MaxConcurrentFetchesPerCaller).Select(i => net.Fetch($"https://mdblist.com/lists/me/slow{i}", alice)).ToList();
        for (var spin = 0; Volatile.Read(ref arrived) < running.Count && spin < 200; spin++)
        {
            await Task.Delay(10);
        }

        // Answered at once (never queued behind the running ones).
        var busy = net.Fetch($"https://mdblist.com/lists/me/slow{ListSourceFetcher.MaxConcurrentFetchesPerCaller}", alice);
        var answered = await Task.WhenAny(busy, Task.Delay(TimeSpan.FromSeconds(5)));
        release.SetResult();
        Assert.Same(busy, answered);
        Assert.Equal("fetch_limited", (await busy).ErrorCode);
        Assert.All(await Task.WhenAll(running), r => Assert.True(r.Ok));
        Assert.True((await net.Fetch($"https://mdblist.com/lists/me/slow{ListSourceFetcher.MaxConcurrentFetchesPerCaller}", alice)).Ok);
    }

    [Fact]
    public async Task TheResultCacheEvictsTheOldestEntriesBeyondItsBudget()
    {
        using var net = new Net();
        for (var i = 0; i <= ListSourceFetcher.MaxCacheEntries; i++)
        {
            net.Json($"https://mdblist.com/lists/me/c{i}/json", MovieArray(1, 1));
            Assert.True((await net.Fetch($"https://mdblist.com/lists/me/c{i}")).Ok);
        }

        await net.Fetch("https://mdblist.com/lists/me/c0");
        await net.Fetch($"https://mdblist.com/lists/me/c{ListSourceFetcher.MaxCacheEntries}");
        Assert.Equal(2, net.Count("/lists/me/c0/json")); // the oldest went
        Assert.Equal(1, net.Count($"/lists/me/c{ListSourceFetcher.MaxCacheEntries}/json")); // the newest stayed

        // The entry budget is also counted in list entries, so a few huge lists can't pin memory.
        var big = MovieArray(1, ListSourceFetcher.MaxItems);
        var lists = ListSourceFetcher.MaxCachedItems / ListSourceFetcher.MaxItems + 1;
        for (var i = 0; i < lists; i++)
        {
            net.Json($"https://mdblist.com/lists/me/big{i}/json", big);
            Assert.True((await net.Fetch($"https://mdblist.com/lists/me/big{i}")).Ok);
        }

        await net.Fetch("https://mdblist.com/lists/me/big0");
        Assert.Equal(2, net.Count("/lists/me/big0/json"));
    }

    [Fact]
    public async Task InteractiveFetchesCarryTheCallerAndALimitIsA429()
    {
        using var w = new World();
        w.Source(World.M(1));
        Ok<SourceFetchResponse>(await w.H.Sources.FetchAsync(w.Owner, World.Url, None));
        Assert.Equal(w.Owner.Id.ToString("N"), w.H.Fetcher.Calls.Last().Caller);
        await w.H.Sources.PrepareLinkAsync(w.Owner, World.Url, true, false, None);
        Assert.Equal(w.Owner.Id.ToString("N"), w.H.Fetcher.Calls.Last().Caller);

        w.H.Fetcher.FailCode = "fetch_limited";
        w.H.Fetcher.RetryAfter = 42;
        var limited = await w.H.Sources.FetchAsync(w.Owner, World.Url, None);
        Error(limited, 429, "fetch_limited");
        Assert.Equal(42, limited.RetryAfterSeconds);

        // The sync itself isn't charged to anyone.
        w.H.Fetcher.FailCode = null;
        await w.Link(removeDropped: false);
        await w.Sync();
        Assert.Null(w.H.Fetcher.Calls.Last().Caller);
    }

    [Fact]
    public async Task RepeatedSyncNowByOneUserAnswersTheLastResultWithoutFetching()
    {
        using var w = new World();
        var editor = w.H.NewUser("editor");
        w.List.Info = w.List.Info with { Shares = new[] { new ListShare(editor.Id, true) } };
        w.Source(World.M(1));
        await w.Link(removeDropped: false);

        var first = Ok<SourceSyncResultDto>(await w.H.Sources.SyncNowAsync(w.Access, null, None));
        Assert.Equal(("ok", 1), (first.State, first.Added));
        var calls = w.H.Fetcher.Calls.Count;

        w.Source(World.M(1), World.M(2));
        var again = Ok<SourceSyncResultDto>(await w.H.Sources.SyncNowAsync(w.Access, null, None));
        Assert.Equal(("ok", 0), (again.State, again.Added));
        Assert.NotNull(again.View);
        Assert.Equal(calls, w.H.Fetcher.Calls.Count); // nothing fetched
        Assert.Equal(new[] { "Movie 1" }, w.Titles());

        // Another editor's Sync now (and the scheduled sync) still run.
        var other = Ok<SourceSyncResultDto>(await w.H.Sources.SyncNowAsync(w.H.AccessFor(w.List, editor), null, None));
        Assert.Equal(1, other.Added);
        Assert.Equal(new[] { "Movie 1", "Movie 2" }, w.Titles());
    }
}
