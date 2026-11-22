using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace JE.Tests;

/// <summary>
/// The Reclaimerr integration against a fake Reclaimerr 0.6.15: the version check, the leaving-soon feed matched by Jellyfin ids,
/// the item actions and request reviews through the token, a user's own request through the trusted-proxy sign-in, and the user import.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationReclaimerrTests : IDisposable
{
    private readonly ApiPluginFixture _f = new();
    private readonly Mock<ILibraryManager> _library = new();
    private readonly ILibraryManager? _previousLibrary = BaseItem.LibraryManager;
    private readonly List<BaseItem> _items = new();
    private static readonly DateTimeOffset Fixed = new(2026, 11, 20, 12, 0, 0, TimeSpan.Zero);

    public IntegrationReclaimerrTests()
    {
        BaseItem.LibraryManager = _library.Object;
        _library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
        _library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => _items.SingleOrDefault(i => i.Id == id));
    }

    public void Dispose()
    {
        BaseItem.LibraryManager = _previousLibrary!;
        _f.Dispose();
    }

    /// <summary>A request the fake Reclaimerr saw.</summary>
    private sealed record Hit(string Method, string Path, string Body, string? Bearer, string? User);

    /// <summary>A fake Reclaimerr: <see cref="Routes"/> answers by "METHOD path" (query included), else <c>{}</c>.</summary>
    private sealed class Reclaimerr : IDisposable
    {
        private readonly HttpListener _listener = new();
        public string Url { get; }
        public string Version { get; set; } = "0.6.15";
        public List<Hit> Seen { get; } = new();
        public Dictionary<string, Func<Hit, (int Status, string Body)>> Routes { get; } = new(StringComparer.Ordinal);

        public Reclaimerr()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(Url + "/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    HttpListenerContext context;
                    try { context = await _listener.GetContextAsync(); } catch { return; }
                    try
                    {
                        using var reader = new StreamReader(context.Request.InputStream);
                        var hit = new Hit(context.Request.HttpMethod, context.Request.Url!.PathAndQuery, await reader.ReadToEndAsync(), context.Request.Headers["Authorization"], context.Request.Headers["Remote-User"]);
                        lock (Seen) Seen.Add(hit);
                        var (status, body) = hit.Path == "/openapi.json" ? (200, "{\"openapi\":\"3.1.0\",\"info\":{\"title\":\"reclaimerr API\",\"version\":\"" + Version + "\"}}")
                            : Routes.TryGetValue(hit.Method + " " + hit.Path, out var route) ? route(hit) : (200, "{}");
                        var bytes = Encoding.UTF8.GetBytes(body);
                        context.Response.StatusCode = status;
                        context.Response.ContentType = "application/json";
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes);
                    }
                    catch { /* client gone */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        public void Answer(string route, string body, int status = 200) => Routes[route] = _ => (status, body);

        public List<Hit> Calls(string method) { lock (Seen) return Seen.Where(s => s.Method == method).ToList(); }

        public void Dispose() => _listener.Close();
    }

    private (ReclaimerrActions Actions, LeavingSoonService Leaving) Setup(Reclaimerr server, bool requests = true)
    {
        var config = _f.Plugin.Configuration;
        config.ReclaimerrEnabled = true;
        config.LeavingSoonMaintainerrEnabled = false;
        config.LeavingSoonMaintainerrActions = true;
        config.ReclaimerrUrl = server.Url;
        config.ReclaimerrToken = "rcl_token";
        config.ReclaimerrUserRequests = requests;
        config.ReclaimerrUserHeader = "Remote-User";
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        var clients = services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
        var leaving = new LeavingSoonService(clients, Path.Combine(_f.Core.Root, "leaving-soon-" + Guid.NewGuid().ToString("N") + ".json"), _library.Object, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5), Now = () => Fixed };
        var cache = new TagCacheService(_library.Object, _f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), _f.Core.Logger, new MatroskaLanguageCache(_f.Core.Paths.Object, _f.Core.Logger), leavingSoonService: leaving);
        return (new ReclaimerrActions(clients, leaving, cache, _f.Core.Logger) { Timeout = TimeSpan.FromSeconds(5), Now = () => Fixed }, leaving);
    }

    private PluginConfiguration Config => _f.Plugin.Configuration;

    private T Add<T>(T item, string? tmdb = null) where T : BaseItem
    {
        if (item.Id == Guid.Empty) item.Id = Guid.NewGuid();
        if (tmdb != null) item.SetProviderId(MetadataProvider.Tmdb, tmdb);
        _items.Add(item);
        return item;
    }

    /// <summary>Make <paramref name="alternate"/> a hidden alternate version of <paramref name="primary"/> (a Guid on 12, text on 10.11).</summary>
    private static void AlternateOf(Video alternate, BaseItem primary)
    {
        var property = typeof(Video).GetProperty(nameof(Video.PrimaryVersionId))!;
        property.SetValue(alternate, property.PropertyType == typeof(string) ? primary.Id.ToString("N") : primary.Id);
    }

    private static string Jf(Guid item, Guid? media = null, int config = 1)
        => $"{{\"source_service\":\"jellyfin\",\"source_service_config_id\":{config},\"source_service_name\":\"Jellyfin\",\"source_item_id\":\"{item:N}\",\"source_media_id\":{(media is { } m ? $"\"{m:N}\"" : "null")}}}";

    private static string Page(params string[] items) => "{\"items\":[" + string.Join(",", items) + "],\"total\":" + items.Length + ",\"page\":1,\"per_page\":200,\"total_pages\":1}";

    private static string Entry(string source, string scope, string state, string deleteAt, string servers, int? candidate = null, int? schedule = null, long? size = null, string type = "movie")
        => $"{{\"source\":\"{source}\",\"candidate_id\":{(candidate?.ToString() ?? "null")},\"scheduled_deletion_id\":{(schedule?.ToString() ?? "null")},\"media_type\":\"{type}\",\"scope\":\"{scope}\",\"media_id\":1,"
            + $"\"media_server_items\":[{servers}],\"title\":\"T\",\"size_bytes\":{(size?.ToString() ?? "null")},\"delete_operation\":\"delete\",\"delete_at\":\"{deleteAt}\",\"state\":\"{state}\"}}";

    [Theory]
    [InlineData("0.6.15", 0, 6, 15)]
    [InlineData("0.6.15-dev.1", 0, 6, 15)]
    [InlineData("v0.6.15-dev.1", 0, 6, 15)]
    [InlineData("0.6.15-dev1", 0, 6, 15)]
    [InlineData("0.6.15dev1", 0, 6, 15)]
    [InlineData("0.6.15.dev1", 0, 6, 15)]
    [InlineData("0.6.16-dev", 0, 6, 16)]
    [InlineData(" V0.6.15 ", 0, 6, 15)]
    [InlineData("0.6.15-rc.1", 0, 6, 15)]
    [InlineData("0.6.15-dev.1+build.7", 0, 6, 15)]
    [InlineData("1.2-dev", 1, 2, 0)]
    [InlineData("v0.7.0+abc", 0, 7, 0)]
    [InlineData("1.2", 1, 2, 0)]
    public void A_version_is_read_with_its_pre_release_counting_as_that_release(string text, int major, int minor, int patch)
        => Assert.Equal(new Version(major, minor, patch), ReclaimerrApi.ParseVersion(text));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("latest")]
    [InlineData("0.6.x")]
    [InlineData("1")]
    [InlineData("dev-0.6.15")]
    [InlineData("0.6.15 unrelated text")]
    [InlineData("0.6.15.3")]
    [InlineData("0.6.15-")]
    public void Text_that_is_not_a_version_is_not_one(string? text) => Assert.Null(ReclaimerrApi.ParseVersion(text));

    [Fact]
    public async Task An_older_Reclaimerr_is_named_as_too_old_and_nothing_else_is_asked_of_it()
    {
        using var server = new Reclaimerr { Version = "0.6.1" };
        var (actions, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.Equal("This Reclaimerr is older than 0.6.15 (it reports 0.6.1); Jellyfin Enhanced needs 0.6.15 or newer", leaving.Status(Config).LastError);
        var ex = await Assert.ThrowsAsync<ReclaimerrApi.VersionException>(() => actions.ReviewRequestAsync(7, false, null, "admin", Config, CancellationToken.None));
        Assert.Contains("0.6.15", ex.Message);
        Assert.All(server.Seen, s => Assert.Equal("/openapi.json", s.Path));
    }

    [Theory]
    [InlineData("0.6.15-dev.1")]
    [InlineData("v0.6.15-dev.1")]
    [InlineData("0.6.15-dev1")]
    [InlineData("0.6.16-dev")]
    [InlineData("0.7.0")]
    public async Task Development_builds_of_0_6_15_and_anything_newer_are_accepted(string version)
    {
        using var server = new Reclaimerr { Version = version };
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (_, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.Null(leaving.Status(Config).LastError);
        Assert.Contains(server.Seen, s => s.Path.StartsWith("/api/v1/leaving-soon") && s.Bearer == "Bearer rcl_token");
    }

    [Theory]
    [InlineData("0.6.14-dev.3", "This Reclaimerr is older than 0.6.15 (it reports 0.6.14-dev.3); Jellyfin Enhanced needs 0.6.15 or newer")]
    [InlineData("0.6.14", "This Reclaimerr is older than 0.6.15 (it reports 0.6.14); Jellyfin Enhanced needs 0.6.15 or newer")]
    [InlineData("unknown", "Reclaimerr did not say which version it is; Jellyfin Enhanced needs 0.6.15 or newer")]
    public async Task A_development_build_of_an_older_release_is_too_old_and_named_as_Reclaimerr_reports_it(string version, string error)
    {
        using var server = new Reclaimerr { Version = version };
        var (_, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.Equal(error, leaving.Status(Config).LastError);
        Assert.All(server.Seen, s => Assert.Equal("/openapi.json", s.Path));
    }

    [Fact]
    public async Task The_leaving_soon_feed_marks_the_Jellyfin_items_it_names_by_id_with_its_day_owner_scope_and_size()
    {
        var film = Add(new Movie { Name = "Whole" });
        var merged = Add(new Movie { Name = "Merged" });
        // Jellyfin makes an alternate version with its primary's type, so a Movie.
        var uhd = Add(new Movie { Name = "Merged 4K" });
        AlternateOf(uhd, merged);
        var show = Add(new Series { Name = "Show" });
        var season = Add(new Season { Name = "Season 1" });
        var scheduled = Add(new Movie { Name = "Scheduled" });
        var approved = Add(new Movie { Name = "Approved later" });
        var blocked = Add(new Movie { Name = "Blocked" });
        var elsewhere = Guid.NewGuid(); // an item of another Jellyfin server Reclaimerr knows

        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page(
            Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", Jf(film.Id, film.Id), candidate: 4, size: 5_000_000_000),
            Entry("candidate", "version", "scheduled", "2026-12-02T00:00:00Z", Jf(merged.Id, uhd.Id), candidate: 5, size: 3_221_225_472),
            Entry("candidate", "series", "postponed", "2026-12-03T00:00:00Z", Jf(show.Id), candidate: 6, size: 9, type: "series"),
            Entry("candidate", "season", "eligible", "2026-12-04T00:00:00Z", Jf(season.Id), candidate: 7, type: "series"),
            Entry("manual", "movie", "scheduled", "2026-12-05T00:00:00Z", Jf(scheduled.Id, scheduled.Id), schedule: 11),
            Entry("delete_request", "movie", "scheduled", "2026-12-06T00:00:00Z", Jf(approved.Id, approved.Id), schedule: 12),
            Entry("manual", "movie", "blocked", "2026-11-01T00:00:00Z", Jf(blocked.Id, blocked.Id), schedule: 13),
            Entry("candidate", "movie", "eligible", "2026-12-07T00:00:00Z", Jf(elsewhere, elsewhere, config: 2), candidate: 8),
            Entry("candidate", "movie", "eligible", "2026-12-08T00:00:00Z", "{\"source_service\":\"plex\",\"source_service_config_id\":3,\"source_service_name\":\"Plex\",\"source_item_id\":\"123\",\"source_media_id\":\"9\"}", candidate: 9)));
        var (_, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);

        Assert.Null(leaving.Status(Config).LastError);
        long Day(int d) => new DateTimeOffset(2026, 12, d, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
        Assert.Equal((Day(1), 4, false, 5_000_000_000L), (leaving.Get(film.Id, Config)!.DeleteAt, leaving.CollectionOf(film.Id, Config), leaving.IsVersionOnly(film.Id, Config), leaving.SizeOf(film.Id, Config)));
        // One version of a merged movie: the version's own item and the movie the library shows, both as one version, with that copy's size.
        Assert.Equal((Day(2), 5, true, 3_221_225_472L), (leaving.Get(uhd.Id, Config)!.DeleteAt, leaving.CollectionOf(uhd.Id, Config), leaving.IsVersionOnly(uhd.Id, Config), leaving.SizeOf(uhd.Id, Config)));
        Assert.Equal((Day(2), 5, true, 3_221_225_472L), (leaving.Get(merged.Id, Config)!.DeleteAt, leaving.CollectionOf(merged.Id, Config), leaving.IsVersionOnly(merged.Id, Config), leaving.SizeOf(merged.Id, Config)));
        Assert.Equal((Day(3), 6), (leaving.Get(show.Id, Config)!.DeleteAt, leaving.CollectionOf(show.Id, Config)));
        // A schedule (manual or an approved request's) is listed by its id negated; a blocked one waits for an administrator.
        Assert.Equal((Day(5), -11), (leaving.Get(scheduled.Id, Config)!.DeleteAt, leaving.CollectionOf(scheduled.Id, Config)));
        Assert.Equal((Day(6), -12), (leaving.Get(approved.Id, Config)!.DeleteAt, leaving.CollectionOf(approved.Id, Config)));
        Assert.Null(leaving.Get(blocked.Id, Config));
        // A season alone does not mark anything, and ids of another server or of Plex mark nothing here.
        Assert.Null(leaving.Get(season.Id, Config));
        Assert.Null(leaving.Get(elsewhere, Config));
        // The lists show the merged movie once, by its card; the alternate keeps its fact for its own badge.
        var listed = leaving.MaintainerrItems(Config).Select(m => m.ItemId).ToList();
        Assert.Equal(5, listed.Count);
        Assert.Contains(merged.Id, listed);
        Assert.DoesNotContain(uhd.Id, listed);
        Assert.Null(leaving.SizeOf(scheduled.Id, Config));
    }

    [Fact]
    public async Task A_Reclaimerr_found_too_old_later_drops_its_facts_instead_of_keeping_stale_badges()
    {
        var film = Add(new Movie { Name = "Whole" });
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page(Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", Jf(film.Id), candidate: 4)));
        var (_, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.NotNull(leaving.Get(film.Id, Config));
        server.Version = "0.6.1";
        ReclaimerrApi.ForgetVersions();
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.Null(leaving.Get(film.Id, Config));
        Assert.Contains("older than 0.6.15", leaving.Status(Config).LastError);
    }

    [Fact]
    public async Task A_copy_merged_into_a_movie_after_the_last_read_stays_listed_until_the_next_read()
    {
        // Reclaimerr read the copy as a movie of its own; the library merged it under another movie afterwards.
        var movie = Add(new Movie { Name = "Movie card" });
        var copy = Add(new Movie { Name = "Its copy" });
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page(Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", Jf(copy.Id, copy.Id), candidate: 4)));
        var (_, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        AlternateOf(copy, movie);
        Assert.Equal(new[] { copy.Id }, leaving.MaintainerrItems(Config).Select(m => m.ItemId));
        // The next read marks the movie card, and the copy leaves the list.
        await leaving.RefreshAsync(Config, true, CancellationToken.None);
        Assert.Equal(new[] { movie.Id }, leaving.MaintainerrItems(Config).Select(m => m.ItemId));
    }

    [Fact]
    public void The_feed_skips_what_is_not_leaving_and_counts_entries_naming_no_Jellyfin_item()
    {
        var a = Guid.NewGuid();
        var json = "[" + string.Join(",",
            Entry("candidate", "movie", "disabled", "2026-12-01T00:00:00Z", Jf(a), candidate: 1),
            Entry("candidate", "episode", "eligible", "2026-12-01T00:00:00Z", Jf(a), candidate: 2, type: "series"),
            Entry("manual", "movie", "failed", "2026-12-01T00:00:00Z", Jf(a), schedule: 3),
            Entry("manual", "movie", "running", "2026-12-01T00:00:00Z", Jf(a), schedule: 4),
            Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", string.Empty, candidate: 5)) + "]";
        using var doc = JsonDocument.Parse(json);
        var members = LeavingSoonService.ParseReclaimerrLeaving(doc.RootElement.EnumerateArray().ToList(), Fixed, out var unmatched, out var outOfRange);
        var only = Assert.Single(members);
        Assert.Equal((a, -4), (only.ItemId!.Value, only.CollectionId!.Value));
        Assert.Equal((1, 0), (unmatched, outOfRange));

        // A day too far away to be real is skipped on its own: the other entries are still read.
        var b = Guid.NewGuid();
        using var far = JsonDocument.Parse("[" + Entry("manual", "movie", "scheduled", "2046-12-01T00:00:00Z", Jf(a), schedule: 1) + "," + Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", Jf(b), candidate: 2) + "]");
        var kept = LeavingSoonService.ParseReclaimerrLeaving(far.RootElement.EnumerateArray().ToList(), Fixed, out _, out outOfRange);
        Assert.Equal((b, 1), (Assert.Single(kept).ItemId!.Value, outOfRange));
    }

    private static string Movies(int id, params (int Version, Guid Media)[] versions)
        => "{\"items\":[{\"id\":" + id + ",\"media_type\":\"movie\",\"title\":\"T\",\"tmdb_id\":550,\"versions\":["
            + string.Join(",", versions.Select(v => $"{{\"id\":{v.Version},\"path\":\"/m/{v.Version}.mkv\",\"service_item_id\":\"{v.Media:N}\",\"service_media_id\":\"{v.Media:N}\",\"size_bytes\":1,\"resolution\":\"1080p\"}}")) + "]}],\"total\":1,\"page\":1,\"per_page\":5,\"total_pages\":1}";

    [Fact]
    public async Task Marking_schedules_through_the_token_and_picks_a_movie_version_by_its_media_source_id()
    {
        var movie = Add(new Movie { Name = "Two copies" }, tmdb: "550");
        var otherCopy = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id), (71, otherCopy)));
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);

        await actions.MarkAsync(movie, Config, Fixed.AddDays(7), otherCopy.ToString("N"), "admin", CancellationToken.None);
        var post = Assert.Single(server.Calls("POST"));
        Assert.Equal("/api/v1/scheduled-deletions", post.Path);
        Assert.Equal("Bearer rcl_token", post.Bearer);
        var body = JsonDocument.Parse(post.Body).RootElement;
        Assert.Equal(("movie", 42, 71, "2026-11-27T12:00:00Z"), (body.GetProperty("media_type").GetString(), body.GetProperty("media_id").GetInt32(), body.GetProperty("movie_version_id").GetInt32(), body.GetProperty("scheduled_at").GetString()));

        // No version picked: this item's own copy. A picked version Reclaimerr does not hold schedules nothing (not another copy).
        await actions.MarkAsync(movie, Config, null, null, "admin", CancellationToken.None);
        Assert.Equal(70, JsonDocument.Parse(server.Calls("POST")[1].Body).RootElement.GetProperty("movie_version_id").GetInt32());
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.MarkAsync(movie, Config, null, Guid.NewGuid().ToString("N"), "admin", CancellationToken.None));
        Assert.Equal(2, server.Calls("POST").Count);
    }

    [Fact]
    public async Task A_copy_Reclaimerr_has_not_synced_is_never_scheduled_through_the_copy_it_has()
    {
        // Jellyfin holds 1080p and 4K; Reclaimerr has synced only the 1080p.
        var movie = Add(new Movie { Name = "Two here, one there", LocalAlternateVersions = new[] { "/m/4k.mkv" } }, tmdb: "550");
        var uhd = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.MarkAsync(movie, Config, null, uhd.ToString("N"), "admin", CancellationToken.None));
        Assert.Empty(server.Calls("POST"));
        // Picking the copy Reclaimerr does hold schedules only that file, not the whole movie (the 4K stays, so must its Radarr entry).
        await actions.MarkAsync(movie, Config, null, movie.Id.ToString("N"), "admin", CancellationToken.None);
        Assert.Equal(70, JsonDocument.Parse(Assert.Single(server.Calls("POST")).Body).RootElement.GetProperty("movie_version_id").GetInt32());
    }

    [Fact]
    public async Task With_Reclaimerr_on_another_main_server_a_copy_is_found_by_its_path_or_scheduled_whole_when_each_side_has_one()
    {
        var movie = Add(new Movie { Name = "Linked", Path = "/movies/Linked (2020)/Linked.mkv" }, tmdb: "550");
        using var server = new Reclaimerr();
        // Plex ids, not Jellyfin's: two versions, one at this item's path.
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", "{\"items\":[{\"id\":42,\"tmdb_id\":550,\"versions\":[{\"id\":70,\"path\":\"/movies/Linked (2020)/Linked.mkv\",\"service_item_id\":\"9\",\"service_media_id\":\"9\"},{\"id\":71,\"path\":\"/movies/Linked (2020)/Linked 4K.mkv\",\"service_item_id\":\"9\",\"service_media_id\":\"10\"}]}]}");
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        await actions.MarkAsync(movie, Config, null, null, "admin", CancellationToken.None);
        Assert.Equal(70, JsonDocument.Parse(Assert.Single(server.Calls("POST")).Body).RootElement.GetProperty("movie_version_id").GetInt32());

        using var single = new Reclaimerr();
        single.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", "{\"items\":[{\"id\":43,\"tmdb_id\":550,\"versions\":[{\"id\":80,\"path\":\"/data/elsewhere.mkv\",\"service_item_id\":\"9\",\"service_media_id\":\"9\"}]}]}");
        single.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        await Setup(single).Actions.MarkAsync(movie, Config, null, null, "admin", CancellationToken.None);
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(Assert.Single(single.Calls("POST")).Body).RootElement.GetProperty("movie_version_id").ValueKind);
    }

    [Fact]
    public async Task Several_Reclaimerr_titles_with_the_TMDB_id_and_none_provably_this_item_are_refused()
    {
        var show = Add(new Series { Name = "Twice" }, tmdb: "77");
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/series?tmdb_id=77&per_page=5", "{\"items\":[{\"id\":1,\"tmdb_id\":77},{\"id\":2,\"tmdb_id\":77}]}");
        var (actions, _) = Setup(server);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.MarkAsync(show, Config, null, null, "admin", CancellationToken.None));
        Assert.Empty(server.Calls("POST"));
    }

    [Fact]
    public async Task A_movie_with_one_version_is_scheduled_whole()
    {
        var movie = Add(new Movie { Name = "One copy" }, tmdb: "550");
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        await actions.MarkAsync(movie, Config, null, null, "admin", CancellationToken.None);
        Assert.Equal(JsonValueKind.Null, JsonDocument.Parse(Assert.Single(server.Calls("POST")).Body).RootElement.GetProperty("movie_version_id").ValueKind);
    }

    [Fact]
    public async Task Keep_and_postpone_address_the_candidate_or_the_schedule_that_governs_the_item()
    {
        var candidate = Add(new Movie { Name = "Candidate" });
        var scheduled = Add(new Movie { Name = "Scheduled" });
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page(
            Entry("candidate", "movie", "eligible", "2026-12-01T00:00:00Z", Jf(candidate.Id), candidate: 4),
            Entry("delete_request", "movie", "scheduled", "2026-12-05T00:00:00Z", Jf(scheduled.Id), schedule: 12)));
        var (actions, leaving) = Setup(server);
        await leaving.RefreshAsync(Config, true, CancellationToken.None);

        await actions.UnmarkAsync(candidate, Config, "admin", CancellationToken.None);
        await actions.UnmarkAsync(scheduled, Config, "admin", CancellationToken.None);
        await actions.PostponeAsync(candidate, 10, null, Config, "admin", CancellationToken.None);
        await actions.PostponeAsync(scheduled, null, new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero), Config, "admin", CancellationToken.None);
        await actions.PostponeAsync(candidate, null, null, Config, "admin", CancellationToken.None);
        var posts = server.Calls("POST");
        Assert.Equal(new[] { "/api/v1/candidates/4/protect", "/api/v1/scheduled-deletions/12/cancel", "/api/v1/candidates/4/postpone", "/api/v1/scheduled-deletions/12/reschedule", "/api/v1/candidates/4/reset-timer" }, posts.Select(p => p.Path));
        Assert.Equal("2026-12-11T00:00:00Z", JsonDocument.Parse(posts[2].Body).RootElement.GetProperty("until").GetString());
        Assert.Equal("2026-12-01T00:00:00Z", JsonDocument.Parse(posts[3].Body).RootElement.GetProperty("scheduled_at").GetString());
        Assert.All(posts, p => Assert.Equal("Bearer rcl_token", p.Bearer));
    }

    [Fact]
    public async Task Approvals_and_denials_go_through_the_token_name_the_administrator_and_carry_the_day_as_asked()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        await actions.ReviewRequestAsync(7, true, "ok", "jake", Config, CancellationToken.None);
        await actions.ReviewRequestAsync(8, true, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        await actions.ReviewRequestAsync(9, true, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, new DateTimeOffset(2026, 12, 10, 18, 30, 0, TimeSpan.FromHours(5.5)));
        await actions.ReviewRequestAsync(10, false, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.Now);
        var posts = server.Calls("POST");
        Assert.Equal(new[] { "/api/v1/delete-requests/7/approve", "/api/v1/delete-requests/8/approve", "/api/v1/delete-requests/9/approve", "/api/v1/delete-requests/10/deny" }, posts.Select(p => p.Path));
        var bodies = posts.Select(p => JsonDocument.Parse(p.Body).RootElement).ToList();
        Assert.Equal("ok (Approved by jake in Jellyfin)", bodies[0].GetProperty("admin_notes").GetString());
        Assert.False(bodies[0].TryGetProperty("scheduled_at", out _), "omitting it is what asks for Reclaimerr's grace period");
        Assert.Equal(JsonValueKind.Null, bodies[1].GetProperty("scheduled_at").ValueKind);
        Assert.Equal("2026-12-10T13:00:00Z", bodies[2].GetProperty("scheduled_at").GetString());
        Assert.Equal("Denied by jake in Jellyfin", bodies[3].GetProperty("admin_notes").GetString());
        Assert.False(bodies[3].TryGetProperty("scheduled_at", out _));
        Assert.All(posts, p => Assert.Equal("Bearer rcl_token", p.Bearer));

        // A day in the past, or none, is refused before anything is sent.
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, Fixed.AddDays(-1)));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, null, Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.OnDate, null));
        Assert.Equal(4, server.Calls("POST").Count);
    }

    [Fact]
    public async Task Approving_with_the_grace_period_is_refused_when_Reclaimerr_now_says_another_period_or_cannot_say()
    {
        using var server = new Reclaimerr();
        var grace = "{\"delete_request_grace_period_days\":0}";
        server.Routes["GET /api/v1/delete-requests/approval-options"] = _ => (200, grace);
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        // The page said 14 days; it is 0 now, so the default would delete at once.
        var ex = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.GracePeriod, null, 14));
        Assert.Contains("now 0", ex.Message);
        server.Routes["GET /api/v1/delete-requests/approval-options"] = _ => (500, "{}");
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ReviewRequestAsync(7, true, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.GracePeriod, null, 14));
        Assert.Empty(server.Calls("POST"));
        grace = "{\"delete_request_grace_period_days\":14}";
        server.Routes["GET /api/v1/delete-requests/approval-options"] = _ => (200, grace);
        await actions.ReviewRequestAsync(7, true, null, "jake", Config, CancellationToken.None, ReclaimerrActions.ApprovalTiming.GracePeriod, null, 14);
        Assert.Equal("/api/v1/delete-requests/7/approve", Assert.Single(server.Calls("POST")).Path);
    }

    [Fact]
    public async Task The_grace_period_comes_from_the_approval_options_and_is_unknown_when_it_cannot_be_read()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/delete-requests/approval-options", "{\"delete_request_grace_period_days\":14}");
        Assert.Equal(14, await Setup(server).Actions.GracePeriodDaysAsync(Config, CancellationToken.None));
        using var refused = new Reclaimerr();
        refused.Answer("GET /api/v1/delete-requests/approval-options", "{\"detail\":\"API token requires the delete_requests:read scope\"}", 403);
        Assert.Null(await Setup(refused).Actions.GracePeriodDaysAsync(Config, CancellationToken.None));
    }

    private static string Request(int id, string status, Guid? requester, Guid? item, string? reason = null, string extra = "")
        => $"{{\"id\":{id},\"media_type\":\"movie\",\"media_id\":{id},\"media_title\":\"T{id}\",\"media_year\":2020,\"status\":\"{status}\",\"requested_by_user_id\":3,\"requested_by_username\":\"sam_user\","
            + $"\"requested_by_media_identities\":[{(requester is { } r ? $"{{\"source_service\":\"jellyfin\",\"source_service_config_id\":1,\"source_service_name\":\"Jellyfin\",\"source_user_id\":\"{r:N}\",\"username\":\"Sam\"}}" : string.Empty)}],"
            + $"\"media_server_items\":[{(item is { } i ? Jf(i) : string.Empty)}],\"reason\":{(reason == null ? "null" : $"\"{reason}\"")},\"created_at\":\"2026-11-16T10:00:00Z\",\"updated_at\":\"2026-11-16T10:00:00Z\"{extra}}}";

    [Fact]
    public async Task Requests_carry_the_Jellyfin_requester_and_item_ids_and_a_user_sees_only_their_own()
    {
        var sam = Guid.NewGuid();
        var pat = Guid.NewGuid();
        var film = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page(Request(1, "pending", sam, film, "too long"), Request(2, "pending", null, null)));
        server.Answer("GET /api/v1/delete-requests?status=approved&per_page=200&page=1", Page(Request(3, "approved", pat, null, extra: ",\"execution_error\":\"Radarr refused\""), Request(4, "approved", pat, null, extra: ",\"executed_at\":\"2026-11-17T00:00:00Z\"")));
        server.Answer("GET /api/v1/delete-requests?per_page=200&page=1", Page(Request(1, "pending", sam, film), Request(3, "approved", pat, null), Request(5, "denied", sam, null)));
        var (actions, _) = Setup(server);

        var admin = (await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None)).Rows;
        Assert.Equal(new[] { 1, 2, 3 }, admin!.Select(r => r.Id));
        Assert.Equal(new[] { sam }, admin[0].RequesterIds!);
        Assert.Equal(new[] { film }, admin[0].ItemIds!);
        Assert.Equal("too long", admin[0].Reason);
        Assert.Empty(admin[1].RequesterIds!);

        var mine = (await actions.RequestsAsync(Config, sam, mine: true, CancellationToken.None)).Rows;
        Assert.Equal(new[] { 1, 5 }, mine!.Select(r => r.Id));
        Assert.All(server.Seen.Where(s => s.Path.StartsWith("/api/v1/")), s => Assert.Equal("Bearer rcl_token", s.Bearer));
    }

    [Fact]
    public async Task Request_lists_are_read_once_for_every_caller_until_a_review_changes_them()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page(Request(1, "pending", Guid.NewGuid(), null)));
        server.Answer("GET /api/v1/delete-requests?status=approved&per_page=200&page=1", Page());
        server.Answer("GET /api/v1/leaving-soon?per_page=200&page=1", Page());
        var (actions, _) = Setup(server);
        int Reads() => server.Seen.Count(s => s.Path.StartsWith("/api/v1/delete-requests?status=pending"));
        await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None);
        await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None);
        Assert.Equal(1, Reads());
        await actions.ReviewRequestAsync(1, false, null, "jake", Config, CancellationToken.None);
        await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None);
        Assert.Equal(2, Reads());
        // A review Reclaimerr refuses (already reviewed there) forgets the list too: the card it showed may be stale.
        server.Answer("POST /api/v1/delete-requests/1/deny", "{\"detail\":\"Request is not pending\"}", 400);
        await Assert.ThrowsAsync<MaintainerrHttp.MaintainerrException>(() => actions.ReviewRequestAsync(1, false, null, "jake", Config, CancellationToken.None));
        await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None);
        Assert.Equal(3, Reads());
    }

    [Fact]
    public async Task Waiting_requests_stay_when_only_the_approved_list_fails()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page(Request(1, "pending", Guid.NewGuid(), null)));
        server.Answer("GET /api/v1/delete-requests?status=approved&per_page=200&page=1", "{\"detail\":\"boom\"}", 500);
        var (actions, _) = Setup(server);
        Assert.Equal(new[] { 1 }, (await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None)).Rows!.Select(r => r.Id));
    }

    [Fact]
    public async Task Requests_that_cannot_be_read_are_reported_as_unknown_not_as_none()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", "{\"detail\":\"API token requires the delete_requests:read scope\"}", 403);
        var (actions, _) = Setup(server);
        var (rows, error) = await actions.RequestsAsync(Config, Guid.NewGuid(), mine: false, CancellationToken.None);
        Assert.Null(rows);
        // The administrator is told Reclaimerr's own reason, here the scope the token lacks.
        Assert.Equal("API token requires the delete_requests:read scope", error);
    }

    private static string Users(params (string Name, Guid? Jellyfin, bool Active)[] users)
        => "[" + string.Join(",", users.Select((u, i) => $"{{\"id\":{i + 1},\"username\":\"{u.Name}\",\"display_name\":null,\"email\":null,\"role\":\"user\",\"is_active\":{(u.Active ? "true" : "false")},"
            + $"\"media_identities\":[{(u.Jellyfin is { } j ? $"{{\"source_service\":\"jellyfin\",\"source_service_config_id\":1,\"source_service_name\":\"Jellyfin\",\"source_user_id\":\"{j:N}\",\"username\":\"{u.Name}\"}}" : string.Empty)}]}}")) + "]";

    [Fact]
    public async Task A_request_is_filed_as_the_Reclaimerr_account_linked_to_the_Jellyfin_user_never_with_the_token()
    {
        var movie = Add(new Movie { Name = "Film" }, tmdb: "550");
        var sam = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/users?limit=1000&offset=0", Users(("sam_user", sam, true), ("other", Guid.NewGuid(), true)));
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page());
        server.Answer("POST /api/delete-requests", "{\"id\":9}", 201);
        var (actions, _) = Setup(server);

        var (_, existing) = await actions.RequestRemovalAsync(movie, sam, "Sam", "  not my taste ", Config, CancellationToken.None);
        Assert.Null(existing);
        var post = Assert.Single(server.Calls("POST"));
        Assert.Equal(("/api/delete-requests", "sam_user", (string?)null), (post.Path, post.User, post.Bearer));
        var body = JsonDocument.Parse(post.Body).RootElement;
        Assert.Equal(("movie", 42, "not my taste"), (body.GetProperty("media_type").GetString(), body.GetProperty("media_id").GetInt32(), body.GetProperty("reason").GetString()));
    }

    [Fact]
    public async Task A_waiting_request_is_reported_as_the_users_own_or_someone_elses_instead_of_filed_again()
    {
        var movie = Add(new Movie { Name = "Film" }, tmdb: "550");
        var sam = Guid.NewGuid();
        var pat = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/users?limit=1000&offset=0", Users(("sam_user", sam, true), ("pat_user", pat, true)));
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page(Request(42, "pending", sam, movie.Id)));
        var (actions, _) = Setup(server);
        Assert.Equal("mine", (await actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None)).Existing);
        Assert.Equal("other", (await actions.RequestRemovalAsync(movie, pat, "Pat", null, Config, CancellationToken.None)).Existing);
        Assert.Empty(server.Calls("POST"));
    }

    [Fact]
    public async Task A_waiting_request_for_one_season_or_version_is_not_the_same_as_one_for_the_whole_title()
    {
        var movie = Add(new Movie { Name = "Film" }, tmdb: "550");
        var sam = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/users?limit=1000&offset=0", Users(("sam_user", sam, true)));
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page(Request(42, "pending", sam, movie.Id, extra: ",\"target_scope\":\"version\",\"movie_version_id\":70")));
        server.Answer("POST /api/delete-requests", "{\"id\":9}", 201);
        var (actions, _) = Setup(server);
        Assert.Null((await actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None)).Existing);
        Assert.Single(server.Calls("POST"));
    }

    [Fact]
    public async Task An_unlinked_user_cannot_file_a_request_even_right_after_one_went_through()
    {
        var movie = Add(new Movie { Name = "Film" }, tmdb: "550");
        var sam = Guid.NewGuid();
        using var server = new Reclaimerr();
        var users = Users(("sam_user", sam, true));
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Routes["GET /api/v1/users?limit=1000&offset=0"] = _ => (200, users);
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page());
        server.Answer("POST /api/delete-requests", "{\"id\":9}", 201);
        var (actions, _) = Setup(server);
        await actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None);
        users = Users(("sam_user", null, true));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None));
        Assert.Single(server.Calls("POST"));
    }

    [Fact]
    public async Task A_user_without_a_linked_active_account_or_with_the_sign_in_refused_gets_a_clear_reason()
    {
        var movie = Add(new Movie { Name = "Film" }, tmdb: "550");
        var sam = Guid.NewGuid();
        var gone = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/movies?tmdb_id=550&per_page=5", Movies(42, (70, movie.Id)));
        server.Answer("GET /api/v1/users?limit=1000&offset=0", Users(("sam_user", sam, true), ("gone_user", gone, false)));
        server.Answer("GET /api/v1/delete-requests?status=pending&per_page=200&page=1", Page());
        server.Answer("POST /api/delete-requests", "{\"detail\":\"Not authenticated\"}", 401);
        var (actions, _) = Setup(server);

        var unlinked = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.RequestRemovalAsync(movie, Guid.NewGuid(), "Nobody", null, Config, CancellationToken.None));
        Assert.Contains("import Jellyfin users", unlinked.Message);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.RequestRemovalAsync(movie, gone, "Gone", null, Config, CancellationToken.None));
        Assert.Empty(server.Calls("POST"));
        var refused = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None));
        Assert.Contains("FORWARD_AUTH_ENABLED", refused.Message);
        // The user cannot tell a refused server from a refused account (Reclaimerr's local fallback answers both the same way), so
        // Reclaimerr's own words are kept and an administrator is pointed to the audit, which asks about the server itself.
        Assert.Contains("(HTTP 401: Not authenticated)", refused.Message);
        Assert.Contains("run the User audit", refused.Message);

        // Reclaimerr trusted this server and turned down the account itself: the user is not sent to the sign-in's setup, which works.
        server.Answer("POST /api/delete-requests", "{\"detail\":\"Trusted proxy user is not configured\"}", 401);
        var account = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None));
        Assert.Equal("Reclaimerr does not accept the Reclaimerr account sam_user linked to you (Trusted proxy user is not configured). Ask an administrator to check that account in Reclaimerr.", account.Message);

        // With requests off nothing is asked of Reclaimerr at all.
        using var off = new Reclaimerr();
        var (closed, _) = Setup(off, requests: false);
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => closed.RequestRemovalAsync(movie, sam, "Sam", null, Config, CancellationToken.None));
        Assert.Empty(off.Seen);
    }

    [Fact]
    public async Task Importing_users_picks_the_Reclaimerr_server_that_is_this_one_and_creates_only_the_missing_accounts()
    {
        var sam = Guid.NewGuid(); var pat = Guid.NewGuid(); var amy = Guid.NewGuid(); var lee = Guid.NewGuid();
        var jellyfin = new Dictionary<Guid, string> { [sam] = "Sam", [pat] = "Pat", [amy] = "Amy", [lee] = "Lee" };
        string Row(Guid id, string status, string message = "m") => $"{{\"source_user_id\":\"{id:N}\",\"username\":\"x\",\"status\":\"{status}\",\"message\":\"{message}\",\"revision\":\"r-{id:N}\"}}";
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/users/import-from-media-server/providers", "[{\"service_config_id\":1,\"service_type\":\"jellyfin\",\"name\":\"Other Jellyfin\"},{\"service_config_id\":2,\"service_type\":\"jellyfin\",\"name\":\"This one\"},{\"service_config_id\":3,\"service_type\":\"plex\",\"name\":\"Plex\"}]");
        server.Routes["POST /api/v1/users/import-from-media-server?preview=true"] = hit => JsonDocument.Parse(hit.Body).RootElement.GetProperty("service_config_id").GetInt32() == 2
            ? (200, "{\"rows\":[" + string.Join(",", Row(sam, "ready_to_create"), Row(pat, "skipped", "Identity is already linked; no changes"), Row(amy, "needs_review"), Row(lee, "conflict", "Multiple accounts")) + "]}")
            : (200, "{\"rows\":[" + Row(Guid.NewGuid(), "ready_to_create") + "]}");
        server.Answer("POST /api/v1/users/import-from-media-server?preview=false", "{\"rows\":[" + Row(sam, "created") + "],\"created\":1}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", Users(("pat_user", pat, true)));
        var (actions, _) = Setup(server);

        var result = await actions.ImportUsersAsync(Config, jellyfin, new[] { "request", "manage_users" }, new[] { "requests", "nope" }, CancellationToken.None);
        Assert.Equal(new[] { "Sam" }, result.Created);
        Assert.Equal(1, result.AlreadyLinked);
        Assert.Equal(new[] { "Amy" }, result.NeedsReview);
        Assert.Equal(new[] { "Lee: Multiple accounts" }, result.Skipped);

        var previews = server.Calls("POST").Where(p => p.Path.EndsWith("preview=true")).Select(p => JsonDocument.Parse(p.Body).RootElement).ToList();
        var run = JsonDocument.Parse(server.Calls("POST").Single(p => p.Path.EndsWith("preview=false")).Body).RootElement;
        Assert.Equal(new[] { 1, 2 }, previews.Select(p => p.GetProperty("service_config_id").GetInt32()));
        Assert.Equal(2, run.GetProperty("service_config_id").GetInt32());
        Assert.Equal(new[] { sam.ToString("N") }, run.GetProperty("source_user_ids").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("r-" + sam.ToString("N"), run.GetProperty("expected_revisions").GetProperty(sam.ToString("N")).GetString());
        // Only a User account, only the grantable permissions and pages, and the same access in the preview (its revisions cover it).
        foreach (var body in new[] { previews[1], run })
        {
            Assert.Equal("user", body.GetProperty("role").GetString());
            Assert.Equal(new[] { "request" }, body.GetProperty("permissions").EnumerateArray().Select(e => e.GetString()));
            Assert.Equal(new[] { "requests" }, body.GetProperty("allowed_pages").EnumerateArray().Select(e => e.GetString()));
            Assert.False(body.GetProperty("use_default_page_access").GetBoolean());
        }
    }


    private static string AuditUsers(params (string Name, Guid? Jellyfin, bool Active)[] users) => Users(users);

    [Fact]
    public async Task The_audit_names_missing_scopes_and_each_users_link_and_request_problems()
    {
        var ok = Guid.NewGuid(); var unlinked = Guid.NewGuid(); var off = Guid.NewGuid(); var twice = Guid.NewGuid(); var noPerm = Guid.NewGuid(); var admin = Guid.NewGuid(); var loneAdmin = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"api_version\":\"v1\",\"resources\":{},\"granted_scopes\":[\"candidates:manage\",\"media:read\",\"users:read\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("ok_user", ok, true), ("off_user", off, false), ("twice_a", twice, true), ("twice_b", twice, true), ("noperm_user", noPerm, true), ("boss", admin, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User switch
        {
            "ok_user" => (200, "{\"username\":\"ok_user\",\"role\":\"user\",\"permissions\":[\"request\"]}"),
            "noperm_user" => (200, "{\"username\":\"noperm_user\",\"role\":\"user\",\"permissions\":[]}"),
            _ => (401, "{\"detail\":\"Not authenticated\"}"),
        };
        var (actions, _) = Setup(server);
        var users = new List<(Guid, string, bool)> { (ok, "Ok", false), (unlinked, "Nobody", false), (off, "Off", false), (twice, "Twice", false), (noPerm, "NoPerm", false), (admin, "Boss", true), (loneAdmin, "LoneAdmin", true) };
        var result = await actions.AuditUsersAsync(Config, users, CancellationToken.None);

        Assert.Equal("0.6.15", result.Version);
        Assert.True(result.RequestsEnabled);
        Assert.Equal(new[] { "scheduled_deletions:manage", "delete_requests:manage", "users:manage" }, result.Issues.Select(i => i.Split(' ')[4].TrimEnd(':')));
        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Empty(Issues("Ok"));
        Assert.Contains("No Reclaimerr account", Assert.Single(Issues("Nobody")));
        Assert.Contains("disabled", Assert.Single(Issues("Off")));
        Assert.Contains("several active Reclaimerr accounts", Assert.Single(Issues("Twice")));
        Assert.Contains("lacks the Request permission", Assert.Single(Issues("NoPerm")));
        Assert.Empty(Issues("Boss"));
        // Administrators mark rather than request: even with no linked account, nothing about them is an issue.
        Assert.Empty(Issues("LoneAdmin"));
        Assert.All(result.Users, u => Assert.True(u.Checked));
        Assert.Equal("ok_user", result.Users.Single(u => u.JellyfinUsername == "Ok").ReclaimerrUsername);
        // Read-only: nothing but GETs, the sign-in check sent as the user without the token, and an administrator's sign-in never tried.
        Assert.All(server.Seen, s => Assert.Equal("GET", s.Method));
        Assert.All(server.Seen.Where(s => s.Path == "/api/account/me"), s => Assert.Null(s.Bearer));
        Assert.DoesNotContain(server.Seen, s => s.User == "boss");
    }

    [Fact]
    public async Task A_token_with_only_the_read_scopes_is_told_what_the_manage_scopes_add_not_that_reading_fails()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:read\",\"delete_requests:read\",\"media:read\",\"users:read\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", "[]");
        var (actions, _) = Setup(server, requests: false);
        var issues = (await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)>(), CancellationToken.None)).Issues;
        Assert.Equal(new[]
        {
            "The API token lacks candidates:manage: Keep and Postpone cannot act on cleanup candidates.",
            "The API token lacks scheduled_deletions:manage: Mark for removal, and Keep and Postpone on a scheduled deletion, are refused.",
            "The API token lacks delete_requests:manage: removal requests cannot be approved or denied.",
            "The API token lacks users:manage: Import Jellyfin users is refused.",
        }, issues);
    }

    [Fact]
    public async Task A_Reclaimerr_that_stops_answering_mid_audit_is_said_once_instead_of_timing_out_per_user()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true)));
        server.Routes["GET /api/account/me"] = _ => { Thread.Sleep(1500); return (200, "{\"role\":\"user\",\"permissions\":[\"request\"]}"); };
        var (actions, _) = Setup(server);
        actions.Timeout = TimeSpan.FromMilliseconds(500);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false) }, CancellationToken.None);
        Assert.Contains("did not answer", Assert.Single(result.Issues));
        Assert.Single(server.Seen, s => s.Path == "/api/account/me");
        Assert.All(result.Users, u => Assert.False(u.Checked));
    }

    [Fact]
    public async Task A_trusted_proxy_sign_in_refused_for_everyone_is_said_once_and_not_retried_per_user()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true), ("c_user", c, true)));
        server.Answer("GET /api/account/me", "{\"detail\":\"Not authenticated\"}", 401);
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false), (c, "C", false) }, CancellationToken.None);
        var setup = Assert.Single(result.Issues);
        Assert.Contains("FORWARD_AUTH_ENABLED", setup);
        // A setting on Reclaimerr, refused whoever is named (issue 1095): the account the check happened to start with is not named,
        // and Reclaimerr's reason, the header to set and the log line that names the address to trust are.
        Assert.DoesNotContain("a_user", setup);
        Assert.Contains("answered an account and a name no account can have the same way (HTTP 401: Not authenticated)", setup);
        Assert.Contains("Request removal fails for everyone", setup);
        Assert.Contains("HTTP 401: Not authenticated", setup);
        Assert.Contains("no user's Request permission was checked", setup);
        Assert.Contains("FORWARD_AUTH_USER_HEADER=Remote-User", setup);
        // Quoted without the header's name: Reclaimerr logs its own spelling of it ("remote-user"), which may differ from the plugin's.
        Assert.Contains("\"authentication header from untrusted peer\"", setup);
        // The first account's refusal does not say whom it is about, so the server is asked once, with a name no account can have.
        // It is refused the same way: nobody else is tried.
        Assert.Equal(new[] { "a_user", ReclaimerrActions.NoAccountName }, server.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));
        Assert.True(ReclaimerrActions.NoAccountName.Length > 32);
        // No user is known to be able to request: all are marked not checked, not counted as fine, and none has an issue of their own.
        Assert.All(result.Users, u => Assert.False(u.Checked));
        Assert.All(result.Users, u => Assert.Empty(u.Issues));

        // Requests switched on while the item menu is off: no one can request, and the audit says why instead of "all set up".
        using var menuOff = new Reclaimerr();
        menuOff.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        menuOff.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true)));
        var (noMenu, _) = Setup(menuOff);
        Config.LeavingSoonMaintainerrActions = false;
        var told = await noMenu.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false) }, CancellationToken.None);
        Assert.False(told.RequestsEnabled);
        Assert.Contains("Mark, keep and postpone from the item menu is off", Assert.Single(told.Issues));
        Assert.DoesNotContain(menuOff.Seen, s => s.Path == "/api/account/me");

        // With requests off, nobody's sign-in is tried: only links matter.
        using var quiet = new Reclaimerr();
        quiet.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        quiet.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true)));
        var (closed, _) = Setup(quiet, requests: false);
        var calm = await closed.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false) }, CancellationToken.None);
        Assert.Empty(calm.Issues);
        Assert.DoesNotContain(quiet.Seen, s => s.Path == "/api/account/me");
    }

    [Fact]
    public async Task A_sign_in_refused_for_one_account_only_is_that_users_issue_and_the_rest_are_still_checked()
    {
        // Reclaimerr 0.6.16 says "Trusted proxy ..." only once it has trusted this server and read the header: the name alone is turned down.
        var gone = Guid.NewGuid(); var longName = Guid.NewGuid(); var fine = Guid.NewGuid(); var noPerm = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("gone_user", gone, true), ("long_user", longName, true), ("fine_user", fine, true), ("noperm_user", noPerm, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User switch
        {
            "gone_user" => (401, "{\"detail\":\"Trusted proxy user is not configured\"}"),
            "long_user" => (401, "{\"detail\":\"Trusted proxy supplied an invalid username\"}"),
            "fine_user" => (200, "{\"username\":\"fine_user\",\"role\":\"user\",\"permissions\":[\"request\"]}"),
            _ => (200, "{\"username\":\"noperm_user\",\"role\":\"user\",\"permissions\":[]}"),
        };
        var (actions, _) = Setup(server);
        // The refused accounts come first by name, where the old audit stopped and called the sign-in refused for everyone.
        var users = new List<(Guid, string, bool)> { (gone, "A-Gone", false), (longName, "B-Long", false), (fine, "C-Fine", false), (noPerm, "D-NoPerm", false) };
        var result = await actions.AuditUsersAsync(Config, users, CancellationToken.None);

        Assert.Empty(result.Issues);
        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Equal("Reclaimerr's trusted-proxy sign-in refused the account gone_user (Trusted proxy user is not configured), so Request removal is refused for them.", Assert.Single(Issues("A-Gone")));
        Assert.Contains("refused the account long_user (Trusted proxy supplied an invalid username)", Assert.Single(Issues("B-Long")));
        Assert.Empty(Issues("C-Fine"));
        Assert.Contains("lacks the Request permission", Assert.Single(Issues("D-NoPerm")));
        Assert.All(result.Users, u => Assert.True(u.Checked));
        Assert.Equal(new[] { "gone_user", "long_user", "fine_user", "noperm_user" }, server.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));
    }

    [Fact]
    public async Task A_plain_refusal_after_Reclaimerr_accepted_another_account_is_that_accounts_issue_not_the_servers()
    {
        // With Reclaimerr's FORWARD_AUTH_ALLOW_LOCAL_FALLBACK on, a name it does not know gets its plain "Not authenticated". Once
        // another account was signed in during the same run, that answer cannot be about this server.
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true), ("c_user", c, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User == "b_user"
            ? (401, "{\"detail\":\"Not authenticated\"}")
            : (200, "{\"username\":\"" + hit.User + "\",\"role\":\"user\",\"permissions\":[\"request\"]}");
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false), (c, "C", false) }, CancellationToken.None);

        Assert.Empty(result.Issues);
        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Empty(Issues("A"));
        Assert.Equal("Reclaimerr showed in this audit that it takes this server's sign-in, but it refused the account b_user (HTTP 401: Not authenticated), so Request removal is refused for them.", Assert.Single(Issues("B")));
        Assert.Empty(Issues("C"));
        Assert.All(result.Users, u => Assert.True(u.Checked));
        // Reclaimerr had already signed an account in, so the server was not asked about.
        Assert.Equal(new[] { "a_user", "b_user", "c_user" }, server.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));
    }

    /// <summary>Reclaimerr's answer to a name no account can have when it trusts this server's sign-in.</summary>
    private const string TrustedAnswer = "{\"detail\":\"Trusted proxy supplied an invalid username\"}";

    [Fact]
    public async Task A_plain_refusal_is_settled_by_asking_about_the_server_not_by_which_account_came_first()
    {
        // Reclaimerr with its local fallback on: a name it does not know gets the plain "Not authenticated" a refused server gets.
        // Here two such accounts come first. Asked with a name no account can have, Reclaimerr turns it down as a name, which it
        // only does for a server it trusts: so both refusals are those accounts' own, and the third user is still checked.
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true), ("c_user", c, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User switch
        {
            ReclaimerrActions.NoAccountName => (401, TrustedAnswer),
            "c_user" => (200, "{\"username\":\"c_user\",\"role\":\"user\",\"permissions\":[\"request\"]}"),
            _ => (401, "{\"detail\":\"Not authenticated\"}"),
        };
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false), (c, "C", false) }, CancellationToken.None);

        Assert.Empty(result.Issues);
        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Equal("Reclaimerr showed in this audit that it takes this server's sign-in, but it refused the account a_user (HTTP 401: Not authenticated), so Request removal is refused for them.", Assert.Single(Issues("A")));
        Assert.Contains("but it refused the account b_user", Assert.Single(Issues("B")));
        Assert.Empty(Issues("C"));
        Assert.All(result.Users, u => Assert.True(u.Checked));
        // The server is asked about once, after the first refusal.
        Assert.Equal(new[] { "a_user", ReclaimerrActions.NoAccountName, "b_user", "c_user" }, server.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));

        // The only account there is: the same answer about the server makes its refusal its own, not a setup problem.
        using var lone = new Reclaimerr();
        lone.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        lone.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true)));
        lone.Routes["GET /api/account/me"] = hit => hit.User == ReclaimerrActions.NoAccountName ? (401, TrustedAnswer) : (401, "{\"detail\":\"Not authenticated\"}");
        var (alone, _) = Setup(lone);
        var single = await alone.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false) }, CancellationToken.None);
        Assert.Empty(single.Issues);
        Assert.Contains("but it refused the account a_user", Assert.Single(Assert.Single(single.Users).Issues));
        Assert.True(Assert.Single(single.Users).Checked);
    }

    [Fact]
    public async Task When_the_server_cannot_be_asked_about_nothing_is_concluded_about_it()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid();
        const string scopes = "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}";
        var users = new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false) };

        // The question about the server fails (a 500): nothing shows the server is trusted, so the check stops there, as it did before
        // there was a question. It is said once, as what was and was not found out, and asked once: not again for every user.
        using var broken = new Reclaimerr();
        broken.Answer("GET /api/v1", scopes);
        broken.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true)));
        broken.Routes["GET /api/account/me"] = hit => hit.User == ReclaimerrActions.NoAccountName
            ? (500, "{\"detail\":\"Internal Server Error\"}")
            : (401, "{\"detail\":\"Not authenticated\"}");
        var (first, _) = Setup(broken);
        var result = await first.AuditUsersAsync(Config, users, CancellationToken.None);
        var unsettled = Assert.Single(result.Issues);
        Assert.Contains("refused for an account (HTTP 401: Not authenticated), and asking Reclaimerr whether it takes this server's sign-in at all failed (Internal Server Error)", unsettled);
        Assert.Contains("no user's Request permission was checked", unsettled);
        // A failed question may be a passing fault: the issue says to try again before anything else.
        Assert.Contains("Run the audit again; if that keeps failing, check FORWARD_AUTH_ENABLED", unsettled);
        Assert.DoesNotContain("fails for everyone", unsettled);
        Assert.DoesNotContain("a_user", unsettled);
        Assert.All(result.Users, u => Assert.False(u.Checked));
        Assert.All(result.Users, u => Assert.Empty(u.Issues));
        Assert.Equal(new[] { "a_user", ReclaimerrActions.NoAccountName }, broken.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));

        // The question about the server gets no answer: that is said, the sign-in is not called refused, and nobody else is tried.
        using var slow = new Reclaimerr();
        slow.Answer("GET /api/v1", scopes);
        slow.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true)));
        slow.Routes["GET /api/account/me"] = hit =>
        {
            if (hit.User == ReclaimerrActions.NoAccountName) Thread.Sleep(1500);
            return (401, "{\"detail\":\"Not authenticated\"}");
        };
        var (second, _) = Setup(slow);
        second.Timeout = TimeSpan.FromMilliseconds(500);
        var quiet = await second.AuditUsersAsync(Config, users, CancellationToken.None);
        // Reclaimerr did answer the account (with a refusal): what got no answer was the question about the server, and that is what is said.
        Assert.Equal("Reclaimerr refused the trusted-proxy sign-in for an account (HTTP 401: Not authenticated) and then did not answer when asked whether it takes this server's sign-in at all, so no user's Request permission was checked. Run the audit again.", Assert.Single(quiet.Issues));
        Assert.All(quiet.Users, u => Assert.False(u.Checked));
        Assert.DoesNotContain(slow.Seen, s => s.User == "b_user");
    }

    [Fact]
    public async Task An_answer_without_the_permission_list_is_not_read_as_lacking_the_permission()
    {
        var bare = Guid.NewGuid(); var boss = Guid.NewGuid(); var none = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("bare_user", bare, true), ("boss_user", boss, true), ("none_user", none, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User switch
        {
            // The account, but nothing about what it may do: unknown.
            "bare_user" => (200, "{\"username\":\"bare_user\",\"role\":\"user\"}"),
            // A Reclaimerr administrator may request whatever the list says, so its absence does not matter.
            "boss_user" => (200, "{\"username\":\"boss_user\",\"role\":\"admin\"}"),
            // The list is there and lacks it: that is a no.
            _ => (200, "{\"username\":\"none_user\",\"role\":\"user\",\"permissions\":[\"manage_requests\"]}"),
        };
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (bare, "Bare", false), (boss, "Boss", false), (none, "None", false) }, CancellationToken.None);

        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Equal("Could not check the Reclaimerr account bare_user (Reclaimerr's answer did not list its permissions).", Assert.Single(Issues("Bare")));
        Assert.Empty(Issues("Boss"));
        Assert.Equal("The Reclaimerr account none_user lacks the Request permission, so Request removal is refused.", Assert.Single(Issues("None")));
        Assert.Empty(result.Issues);
    }

    [Fact]
    public async Task An_answer_that_is_not_the_account_asked_for_is_never_read_as_its_permissions()
    {
        var swapped = Guid.NewGuid(); var empty = Guid.NewGuid(); var last = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("empty_user", empty, true), ("last_user", last, true), ("swapped_user", swapped, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User switch
        {
            // An empty success (the plugin reads it as {}): nothing is known about the account, which is not "no permission".
            "empty_user" => (200, string.Empty),
            // Reclaimerr resolved another account than the one named (it trims the name it is sent), one that may request.
            "swapped_user" => (200, "{\"username\":\"someone_else\",\"role\":\"admin\",\"permissions\":[\"request\"]}"),
            _ => (401, "{\"detail\":\"Not authenticated\"}"),
        };
        var (actions, _) = Setup(server);
        var users = new List<(Guid, string, bool)> { (empty, "A-Empty", false), (swapped, "B-Swapped", false), (last, "C-Last", false) };
        var result = await actions.AuditUsersAsync(Config, users, CancellationToken.None);

        IReadOnlyList<string> Issues(string name) => result.Users.Single(u => u.JellyfinUsername == name).Issues;
        Assert.Equal("Could not check the Reclaimerr account empty_user (Reclaimerr's answer was not an account).", Assert.Single(Issues("A-Empty")));
        Assert.Equal("Reclaimerr signed in as someone_else instead of the linked account swapped_user: a request of theirs that Reclaimerr accepts would be filed as someone_else.", Assert.Single(Issues("B-Swapped")));
        // Reclaimerr signed someone in for B, so C's plain refusal is C's own; the empty answer for A alone would not have shown that.
        Assert.Contains("but it refused the account last_user", Assert.Single(Issues("C-Last")));
        Assert.Empty(result.Issues);
        Assert.DoesNotContain(server.Seen, s => s.User == ReclaimerrActions.NoAccountName);

        // An answer that is not an account does not show Reclaimerr trusts this server: the plain refusal after it has the server asked
        // about, and with that refused too the check stops.
        // The same for an account with an empty name: it is nobody's, so it is neither "another account" nor a sign of trust.
        server.Routes["GET /api/account/me"] = hit => hit.User == "empty_user" ? (200, "{\"username\":\" \",\"role\":\"admin\"}") : (401, "{\"detail\":\"Not authenticated\"}");
        var again = await actions.AuditUsersAsync(Config, users, CancellationToken.None);
        Assert.Contains("FORWARD_AUTH_ENABLED", Assert.Single(again.Issues));
        Assert.Contains(server.Seen, s => s.User == ReclaimerrActions.NoAccountName);
        Assert.Contains("was not an account", Assert.Single(again.Users.Single(u => u.JellyfinUsername == "A-Empty").Issues));
        Assert.False(again.Users.Single(u => u.JellyfinUsername == "B-Swapped").Checked);
        Assert.False(again.Users.Single(u => u.JellyfinUsername == "C-Last").Checked);
    }

    [Theory]
    [InlineData("{\"detail\":\"Trusted proxy supplied multiple username headers\"}", "HTTP 401: Trusted proxy supplied multiple username headers")]
    [InlineData("{\"detail\":\"Session has expired\"}", "HTTP 401: Session has expired")]
    [InlineData("{}", "HTTP 401)")]
    [InlineData("<html>401 Authorization Required</html>", "HTTP 401)")]
    public async Task A_401_with_any_other_reason_or_none_still_counts_as_refusing_this_server(string body, string said)
    {
        // Only Reclaimerr's two reasons about the named account are that user's own; anything else is said once and stops the check, as before.
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true), ("b_user", b, true), ("c_user", c, true)));
        server.Answer("GET /api/account/me", body, 401);
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false), (b, "B", false), (c, "C", false) }, CancellationToken.None);

        var setup = Assert.Single(result.Issues);
        Assert.Contains("FORWARD_AUTH_ENABLED", setup);
        Assert.Contains(said, setup);
        Assert.DoesNotContain("a_user", setup);
        // What to look for in Reclaimerr's log is only said for its plain "Not authenticated", where it is known to hold. Without
        // that answer (something in between may be the one answering), the issue says what was seen, not that everyone is refused.
        Assert.DoesNotContain("untrusted peer", setup);
        Assert.DoesNotContain("whoever is named", setup);
        Assert.DoesNotContain("fails for everyone", setup);
        Assert.Contains("for an account and for a name no account can have alike", setup);
        Assert.Contains("no user's Request permission was checked", setup);
        Assert.Equal(new[] { "a_user", ReclaimerrActions.NoAccountName }, server.Seen.Where(s => s.Path == "/api/account/me").Select(s => s.User));
        Assert.All(result.Users, u => Assert.False(u.Checked));
        Assert.All(result.Users, u => Assert.Empty(u.Issues));
    }

    [Fact]
    public async Task Two_refusals_that_differ_are_each_quoted_as_they_came()
    {
        // The account gets Reclaimerr's plain refusal, the name no account can have a 401 without a reason (something in between
        // answered it): the issue does not put Reclaimerr's words on the second answer, and does not say everyone is refused.
        var a = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1", "{\"granted_scopes\":[\"candidates:manage\",\"scheduled_deletions:manage\",\"delete_requests:manage\",\"media:read\",\"users:manage\"]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", AuditUsers(("a_user", a, true)));
        server.Routes["GET /api/account/me"] = hit => hit.User == ReclaimerrActions.NoAccountName ? (401, string.Empty) : (401, "{\"detail\":\"Not authenticated\"}");
        var (actions, _) = Setup(server);
        var result = await actions.AuditUsersAsync(Config, new List<(Guid, string, bool)> { (a, "A", false) }, CancellationToken.None);

        var setup = Assert.Single(result.Issues);
        Assert.Contains("refused for an account (HTTP 401: Not authenticated) and for a name no account can have (HTTP 401), so no user's Request permission was checked", setup);
        Assert.DoesNotContain("alike", setup);
        Assert.DoesNotContain("fails for everyone", setup);
        Assert.False(Assert.Single(result.Users).Checked);
    }

    [Theory]
    [InlineData("Trusted proxy user is not configured", true)]
    [InlineData("Trusted proxy supplied an invalid username", true)]
    [InlineData("Trusted proxy supplied multiple username headers", false)]
    [InlineData("Not authenticated", false)]
    [InlineData("trusted proxy user is not configured", false)]
    [InlineData("Trusted proxy user is not configured, sorry", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Only_Reclaimerrs_two_reasons_about_the_named_account_count_as_refusing_that_account_alone(string? reason, bool accountOnly)
        => Assert.Equal(accountOnly, ReclaimerrActions.RefusedForAccountOnly(reason));

    [Fact]
    public async Task Importing_carries_on_when_another_Jellyfin_server_Reclaimerr_knows_is_down()
    {
        var sam = Guid.NewGuid();
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/users/import-from-media-server/providers", "[{\"service_config_id\":1,\"service_type\":\"jellyfin\",\"name\":\"Down\"},{\"service_config_id\":2,\"service_type\":\"jellyfin\",\"name\":\"This one\"}]");
        server.Routes["POST /api/v1/users/import-from-media-server?preview=true"] = hit => JsonDocument.Parse(hit.Body).RootElement.GetProperty("service_config_id").GetInt32() == 2
            ? (200, "{\"rows\":[{\"source_user_id\":\"" + sam.ToString("N") + "\",\"status\":\"ready_to_create\",\"revision\":\"r\"}]}")
            : (502, "{\"detail\":\"Jellyfin unreachable\"}");
        server.Answer("POST /api/v1/users/import-from-media-server?preview=false", "{\"rows\":[{\"source_user_id\":\"" + sam.ToString("N") + "\",\"status\":\"created\"}]}");
        server.Answer("GET /api/v1/users?limit=1000&offset=0", "[]");
        var (actions, _) = Setup(server);
        var result = await actions.ImportUsersAsync(Config, new Dictionary<Guid, string> { [sam] = "Sam" }, new[] { "request" }, new[] { "requests" }, CancellationToken.None);
        Assert.Equal(new[] { "Sam" }, result.Created);
    }

    [Fact]
    public async Task Importing_without_a_Reclaimerr_server_holding_this_servers_users_changes_nothing()
    {
        using var server = new Reclaimerr();
        server.Answer("GET /api/v1/users/import-from-media-server/providers", "[{\"service_config_id\":1,\"service_type\":\"jellyfin\",\"name\":\"Other\"}]");
        server.Answer("POST /api/v1/users/import-from-media-server?preview=true", "{\"rows\":[{\"source_user_id\":\"" + Guid.NewGuid().ToString("N") + "\",\"status\":\"ready_to_create\"}]}");
        var (actions, _) = Setup(server);
        var ex = await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ImportUsersAsync(Config, new Dictionary<Guid, string> { [Guid.NewGuid()] = "Sam" }, new[] { "request" }, new[] { "requests" }, CancellationToken.None));
        Assert.Contains("no Jellyfin server", ex.Message);
        Assert.DoesNotContain(server.Seen, s => s.Path.EndsWith("preview=false"));
        await Assert.ThrowsAsync<MaintainerrActions.ActionException>(() => actions.ImportUsersAsync(Config, new Dictionary<Guid, string>(), new[] { "request" }, Array.Empty<string>(), CancellationToken.None));
    }
}
