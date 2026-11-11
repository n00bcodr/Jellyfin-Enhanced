using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests.Features.MediaTags;

/// <summary>
/// Leaving soon: Maintainerr's collections answer (against a fixture HTTP server), the
/// refresh interval and retry delays, failures that keep the last good answer, the
/// collection-name fallback, the cache projection and the badge's calendar-day maths.
/// </summary>
[Collection("Plugin singleton")]
public sealed class LeavingSoonTests : IDisposable
{
    private static readonly DateTimeOffset Added = DateTimeOffset.Parse("2026-10-25T10:00:00Z");
    private const long DayMs = 86_400_000L;
    private readonly CoreFixture _core = new();

    public void Dispose() => _core.Dispose();

    /// <summary>
    /// A loopback HTTP server that answers like Maintainerr: <c>GET /api/collections</c> through
    /// <see cref="Answer"/>, and the paged member route through <see cref="Page"/>.
    /// </summary>
    private sealed class MaintainerrFixture : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly CancellationTokenSource _stop = new();
        public string Url { get; }
        public List<(string Path, string? Key)> Seen { get; } = new();
        public Func<HttpListenerResponse, Task> Answer { get; set; } = r => Json(r, "[]");

        /// <summary>
        /// <c>GET /api/collections/media/{id}/content/{page}?size={size}</c>: the collection id, the page (from 1),
        /// the page size (Maintainerr's own 25 when the request names none) and the response. Unless a test sets it
        /// the route is not there, and the answer is the 404 Maintainerr gives for a route it does not have.
        /// </summary>
        public Func<int, int, int, HttpListenerResponse, Task> Page { get; set; } = (_, _, _, r) => Json(r, "{\"message\":\"Cannot GET\",\"error\":\"Not Found\",\"statusCode\":404}", 404);

        /// <summary>The requests for a page of members, as path and query, in order.</summary>
        public List<string> Paged { get; } = new();

        public MaintainerrFixture(string basePath = "")
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = $"http://127.0.0.1:{port}{basePath}";
            _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            _listener.Start();
            _ = Task.Run(async () =>
            {
                while (!_stop.IsCancellationRequested)
                {
                    HttpListenerContext context;
                    try { context = await _listener.GetContextAsync(); }
                    catch { return; }
                    var paged = System.Text.RegularExpressions.Regex.Match(context.Request.Url!.AbsolutePath, "/api/collections/media/([0-9]+)/content/([0-9]+)$");
                    lock (Seen)
                    {
                        Seen.Add((context.Request.Url!.AbsolutePath, context.Request.Headers["X-Api-Key"]));
                        if (paged.Success) Paged.Add(context.Request.Url!.PathAndQuery);
                    }

                    try
                    {
                        if (paged.Success) await Page(int.Parse(paged.Groups[1].Value), int.Parse(paged.Groups[2].Value), int.TryParse(context.Request.QueryString["size"], out var size) ? size : 25, context.Response);
                        else await Answer(context.Response);
                    }
                    catch { /* the client gave up (timeout tests) */ }
                    finally { try { context.Response.Close(); } catch { } }
                }
            });
        }

        /// <summary>How often the collections were asked for (once per refresh attempt); the pages that follow are in <see cref="Paged"/>.</summary>
        public int Requests { get { lock (Seen) return Seen.Count - Paged.Count; } }

        public static async Task Json(HttpListenerResponse response, string body, int status = 200)
        {
            response.StatusCode = status;
            response.ContentType = "application/json";
            var bytes = Encoding.UTF8.GetBytes(body);
            response.ContentLength64 = bytes.Length;
            await response.OutputStream.WriteAsync(bytes);
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Close();
        }
    }

    /// <summary>The plugin's own registration of the Maintainerr client (redirects off).</summary>
    private static readonly IHttpClientFactory Registered = RegisteredClients();

    private static IHttpClientFactory RegisteredClients()
    {
        var services = new ServiceCollection();
        LeavingSoonService.AddHttpClient(services);
        return services.BuildServiceProvider().GetRequiredService<IHttpClientFactory>();
    }

    private sealed class Clients : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => Registered.CreateClient(name);
    }

    /// <summary>A factory whose clients follow redirects (not how the plugin registers it).</summary>
    private sealed class FollowingClients : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private static string Collections(params (bool Active, int? Days, object Type, Media[] Media)[] collections)
        => JsonSerializer.Serialize(collections.Select(c => new Dictionary<string, object?>
        {
            ["id"] = 1, ["title"] = "Leaving Soon", ["isActive"] = c.Active, ["deleteAfterDays"] = c.Days, ["type"] = c.Type,
            ["media"] = c.Media.Select(m => new Dictionary<string, object?> { ["mediaServerId"] = m.Id, ["tmdbId"] = m.Tmdb, ["addDate"] = m.Added }).ToArray(),
        }));

    /// <summary>One collection member as Maintainerr lists it.</summary>
    private sealed record Media(string? Id, string? Tmdb, string? Added);

    /// <summary>One collection of the list, with its id and the few members the list embeds.</summary>
    private static Dictionary<string, object?> Collection(object? id, bool active, int? days, IEnumerable<Media> embedded)
    {
        var collection = new Dictionary<string, object?>
        {
            ["title"] = "Leaving Soon", ["isActive"] = active, ["deleteAfterDays"] = days, ["type"] = "movie",
            ["media"] = embedded.Select(m => new Dictionary<string, object?> { ["mediaServerId"] = m.Id, ["tmdbId"] = m.Tmdb, ["addDate"] = m.Added }).ToArray(),
        };
        if (id != null) collection["id"] = id;
        return collection;
    }

    /// <summary>
    /// One page of a collection's members as Maintainerr answers it: <c>totalSize</c> counts every row, and
    /// <c>items</c> has the page's rows with the media server's metadata beside each, without the rows whose
    /// metadata Maintainerr could not read (<paramref name="lost"/>).
    /// </summary>
    private static string PageOf(IReadOnlyList<Media> members, int page, int size, Func<Media, bool>? lost = null, bool total = true)
    {
        var answer = new Dictionary<string, object?>
        {
            ["items"] = members.Skip((page - 1) * size).Take(size).Where(m => lost?.Invoke(m) != true).Select(m => new Dictionary<string, object?>
            {
                ["mediaServerId"] = m.Id, ["tmdbId"] = m.Tmdb, ["addDate"] = m.Added, ["mediaData"] = new Dictionary<string, object?> { ["title"] = "A title" },
            }).ToArray(),
        };
        if (total) answer["totalSize"] = members.Count;
        return JsonSerializer.Serialize(answer);
    }

    private static Media[] Members(int count) => Enumerable.Range(0, count).Select(_ => new Media(Guid.NewGuid().ToString(), null, "2026-10-25T10:00:00Z")).ToArray();

    private LeavingSoonService Service(ILibraryManager? library = null, DateTimeOffset? now = null)
    {
        var service = new LeavingSoonService(new Clients(), Path.Combine(_core.Root, "leaving-soon.json"), library, _core.Logger);
        var clock = now ?? Added.AddDays(1);
        service.Now = () => clock;
        return service;
    }

    private static PluginConfiguration Config(string? url = null, string key = "", string names = "", int hours = 6)
        => new() { LeavingSoonMaintainerrUrl = url ?? string.Empty, LeavingSoonMaintainerrApiKey = key, LeavingSoonCollections = names, LeavingSoonRefreshHours = hours };

    [Fact]
    public void Parses_dated_undated_inactive_wrapped_and_numeric_type_answers()
    {
        var a = Guid.NewGuid(); var b = Guid.NewGuid(); var c = Guid.NewGuid();
        var json = Collections(
            (true, 30, "movie", new Media[] { new(a.ToString(), "550", "2026-10-25T10:00:00.000Z"), new(b.ToString("N"), null, null) }),
            (false, 1, "movie", new Media[] { new(c.ToString(), null, "2026-10-25T10:00:00Z") }),
            (true, null, 2, new Media[] { new(c.ToString("D").ToUpperInvariant(), null, "2026-10-25T10:00:00Z") }));
        var members = LeavingSoonService.ParseCollections(JsonDocument.Parse(json).RootElement);
        Assert.Equal(3, members.Count);
        Assert.Equal(Added.AddDays(30).ToUnixTimeMilliseconds(), members[0].DeleteAt);
        Assert.Null(members[1].DeleteAt); // no addDate
        Assert.Equal(c, members[2].ItemId); // the inactive collection is skipped
        Assert.Equal("show", members[2].Type);
        Assert.Null(members[2].DeleteAt); // no deleteAfterDays

        var wrapped = LeavingSoonService.ParseCollections(JsonDocument.Parse("{\"data\":" + json + "}").RootElement);
        Assert.Equal(members, wrapped);
        Assert.Throws<JsonException>(() => LeavingSoonService.ParseCollections(JsonDocument.Parse("{\"error\":\"nope\"}").RootElement));
        Assert.Throws<JsonException>(() => LeavingSoonService.ParseCollections(JsonDocument.Parse("\"text\"").RootElement));
    }

    [Fact]
    public void A_plex_backed_answer_matches_movies_and_shows_by_tmdb_id_and_the_earliest_date_wins()
    {
        var movie = Guid.NewGuid(); var show = Guid.NewGuid(); var episode = Guid.NewGuid();
        var members = new List<LeavingSoonService.MaintainerrMember>
        {
            new(null, "550", "movie", 100), new(null, "1399", "show", 300), new(null, "1399", "episode", 50),
            new(movie, null, "movie", 200), new(episode, null, "episode", null), new(episode, null, "episode", 40),
        };
        var items = LeavingSoonService.ToItems(members, (type, tmdb) => (type, tmdb) switch { ("movie", "550") => new[] { movie }, ("show", "1399") => new[] { show }, _ => Array.Empty<Guid>() });
        Assert.Equal(100, items[movie.ToString("N")]);
        Assert.Equal(300, items[show.ToString("N")]); // an episode-type TMDB id is never taken as the show's
        Assert.Equal(40, items[episode.ToString("N")]); // a date beats no date
        Assert.Equal(3, items.Count);
        Assert.Equal(new TagLeaving { DeleteAt = 5 }, LeavingSoonService.Earliest(new TagLeaving(), new TagLeaving { DeleteAt = 5 }));
        Assert.Equal(new TagLeaving { DeleteAt = 5 }, LeavingSoonService.Earliest(new TagLeaving { DeleteAt = 9 }, new TagLeaving { DeleteAt = 5 }));
    }

    [Theory]
    [InlineData("http://maintainerr:6246", true)]
    [InlineData("https://host/maintainerr/", true)]
    [InlineData("ftp://host", false)]
    [InlineData("http://user:pass@host", false)]
    [InlineData("http://host/?apikey=x", false)]
    [InlineData("http://host/#x", false)]
    [InlineData("maintainerr:6246", false)]
    [InlineData("", false)]
    public void Only_plain_http_base_urls_are_accepted(string url, bool ok) => Assert.Equal(ok, LeavingSoonSources.IsMaintainerrUrl(url));

    [Fact]
    public async Task Requests_the_collections_with_the_key_header_and_never_logs_or_persists_the_key()
    {
        using var server = new MaintainerrFixture("/maintainerr");
        var item = Guid.NewGuid();
        server.Answer = r => MaintainerrFixture.Json(r, Collections((true, 10, "movie", new Media[] { new(item.ToString(), null, "2026-10-25T10:00:00Z") })));
        var service = Service();
        var config = Config(server.Url + "/", key: "secret-key-123");
        Assert.True(await service.RefreshAsync(config, false, CancellationToken.None));
        // The members are then asked for page by page, under the same base path and with the same key.
        Assert.Equal(new[] { ("/maintainerr/api/collections", (string?)"secret-key-123"), ("/maintainerr/api/collections/media/1/content/1", "secret-key-123") }, server.Seen);
        Assert.Equal(new TagLeaving { DeleteAt = Added.AddDays(10).ToUnixTimeMilliseconds() }, service.Get(item, config));
        var disk = File.ReadAllText(Path.Combine(_core.Root, "leaving-soon.json"));
        Assert.DoesNotContain("secret-key-123", disk);
        Assert.DoesNotContain("127.0.0.1", disk);

        // No key: no header. The snapshot is read back after a restart.
        var reloaded = Service();
        Assert.Equal(service.Get(item, config), reloaded.Get(item, config));
        var keyless = Config(server.Url);
        Assert.True(await reloaded.RefreshAsync(keyless, false, CancellationToken.None));
        Assert.Null(server.Seen[^1].Key);
        // Another source's facts never answer for this one.
        Assert.Null(reloaded.Get(item, config));
        Assert.NotNull(reloaded.Get(item, keyless));
    }

    [Fact]
    public async Task Every_member_of_a_collection_is_read_page_by_page_not_only_the_few_the_list_embeds()
    {
        using var server = new MaintainerrFixture("/maintainerr");
        var big = Members(1100); // three pages of 500
        var open = Members(3);   // answered without totalSize
        var paused = Members(2);
        var plain = Members(2);
        var named = Members(1);
        server.Answer = r => MaintainerrFixture.Json(r, JsonSerializer.Serialize(new[]
        {
            Collection(7, true, 30, big.Take(2)),
            Collection(8, false, 30, paused),      // inactive: skipped, so never asked for
            Collection(9, true, null, open.Take(1)),
            Collection(null, true, 5, plain),      // no id to ask with: its embedded list is all there is
            Collection("x-11", true, 5, named),    // an id that is not a number: the same
        }));
        // Maintainerr leaves a row out of a page when it cannot read that row's metadata from the media server.
        var lost = new HashSet<Media> { big[600], big[601] };
        server.Page = (id, page, size, r) => id switch
        {
            7 => MaintainerrFixture.Json(r, PageOf(big, page, size, lost.Contains)),
            9 => MaintainerrFixture.Json(r, PageOf(open, page, size, total: false)),
            _ => MaintainerrFixture.Json(r, "{\"totalSize\":0,\"items\":[]}"),
        };
        var service = Service();
        var config = Config(server.Url, key: "paged-secret-key");
        Assert.True(await service.RefreshAsync(config, false, CancellationToken.None));

        var status = service.Status(config);
        Assert.Null(status.LastError);
        Assert.Equal(1098 + 3 + 2 + 1, status.Items);
        var leaves = new TagLeaving { DeleteAt = Added.AddDays(30).ToUnixTimeMilliseconds() };
        foreach (var index in new[] { 0, 1, 2, 499, 500, 599, 602, 999, 1000, 1099 }) Assert.Equal(leaves, service.Get(Guid.Parse(big[index].Id!), config));
        foreach (var gone in lost) Assert.Null(service.Get(Guid.Parse(gone.Id!), config));
        foreach (var member in open) Assert.Equal(new TagLeaving(), service.Get(Guid.Parse(member.Id!), config));
        foreach (var member in paused) Assert.Null(service.Get(Guid.Parse(member.Id!), config));
        foreach (var member in plain.Concat(named)) Assert.Equal(new TagLeaving { DeleteAt = Added.AddDays(5).ToUnixTimeMilliseconds() }, service.Get(Guid.Parse(member.Id!), config));

        // A short page is not the last one (498 rows of 500): the count says when to stop, and without a count an
        // empty page does. Every request carries the key and stays under the configured base path.
        Assert.Equal(
            new[]
            {
                "/maintainerr/api/collections/media/7/content/1?size=500", "/maintainerr/api/collections/media/7/content/2?size=500", "/maintainerr/api/collections/media/7/content/3?size=500",
                "/maintainerr/api/collections/media/9/content/1?size=500", "/maintainerr/api/collections/media/9/content/2?size=500",
            },
            server.Paged);
        Assert.Equal(1, server.Requests);
        Assert.All(server.Seen, s => Assert.Equal("paged-secret-key", s.Key));
        Assert.DoesNotContain("paged-secret-key", File.ReadAllText(Path.Combine(_core.Root, "leaving-soon.json")));
    }

    [Fact]
    public async Task The_pages_add_to_the_embedded_members_and_a_maintainerr_without_the_route_keeps_the_embedded_ones()
    {
        using var server = new MaintainerrFixture();
        var members = Members(4);
        server.Answer = r => MaintainerrFixture.Json(r, JsonSerializer.Serialize(new[] { Collection(7, true, 10, members.Take(2)), Collection(8, true, 10, members.Skip(3)) }));
        var service = Service();
        var config = Config(server.Url);

        // The route is not there (404 for the first page): what the list embeds, and no failure.
        Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Null(service.Status(config).LastError);
        Assert.Equal(3, service.Status(config).Items);
        Assert.Equal(new[] { "/api/collections/media/7/content/1?size=500", "/api/collections/media/8/content/1?size=500" }, server.Paged);

        // The pages leave out one embedded row (its metadata is gone), repeat the other and name a third member:
        // all three are leaving. Pages without a single row leave the other collection's embedded member alone.
        server.Page = (id, page, size, r) => MaintainerrFixture.Json(r, id == 7 ? PageOf(members.Take(3).ToArray(), page, size, lost: m => m == members[0]) : "{\"totalSize\":1,\"items\":[]}");
        Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Null(service.Status(config).LastError);
        Assert.Equal((4, 4), (service.Status(config).Items, service.Status(config).Dated));
        foreach (var member in members) Assert.Equal(new TagLeaving { DeleteAt = Added.AddDays(10).ToUnixTimeMilliseconds() }, service.Get(Guid.Parse(member.Id!), config));
    }

    [Fact]
    public async Task A_first_page_answered_with_json_that_is_not_a_page_keeps_the_embedded_members_like_a_404()
    {
        using var server = new MaintainerrFixture("/maintainerr");
        var members = Members(5);
        var list = JsonSerializer.Serialize(new[] { Collection(7, true, 10, members.Take(2)), Collection(8, true, 10, members.Skip(4)) });
        server.Answer = r => MaintainerrFixture.Json(r, list);
        var service = Service();
        var config = Config(server.Url, key: "list-secret-key");
        var leaves = new TagLeaving { DeleteAt = Added.AddDays(10).ToUnixTimeMilliseconds() };

        // Only the collection whose first page is no page is read from the list; the other is still read page by page.
        server.Page = (id, page, size, r) => MaintainerrFixture.Json(r, id == 7 ? PageOf(members.Take(4).ToArray(), page, size) : "[]");
        Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Null(service.Status(config).LastError);
        Assert.Equal((5, 5), (service.Status(config).Items, service.Status(config).Dated));
        foreach (var member in members) Assert.Equal(leaves, service.Get(Guid.Parse(member.Id!), config));

        // A source that answers the collections list on every address (upstream's own test server does), or
        // anything else that is JSON but no page, has no paged route: each collection keeps the members the list
        // embeds, without a failure, after one request for its first page. Every request carries the key.
        var embedded = new[] { members[0], members[1], members[4] };
        foreach (var answer in new[] { list, "[]", "{}", "{\"totalSize\":600}", "{\"totalSize\":600,\"items\":{}}", "null", "\"moved\"", "5" })
        {
            server.Page = (_, _, _, r) => MaintainerrFixture.Json(r, answer);
            lock (server.Seen)
            {
                server.Seen.Clear();
                server.Paged.Clear();
            }

            await service.RefreshAsync(config, true, CancellationToken.None);
            var status = service.Status(config);
            Assert.Null(status.LastError);
            Assert.Equal((3, 3), (status.Items, status.Dated));
            foreach (var member in embedded) Assert.Equal(leaves, service.Get(Guid.Parse(member.Id!), config));
            Assert.Equal(new[] { "/maintainerr/api/collections/media/7/content/1?size=500", "/maintainerr/api/collections/media/8/content/1?size=500" }, server.Paged);
            Assert.Equal("/maintainerr/api/collections", server.Seen[0].Path);
            Assert.All(server.Seen, s => Assert.Equal("list-secret-key", s.Key));
        }
    }

    [Fact]
    public async Task A_page_that_fails_or_is_not_a_page_is_a_failed_refresh_that_keeps_the_last_good_answer()
    {
        using var server = new MaintainerrFixture();
        using var receiver = new MaintainerrFixture();
        var members = Members(600);
        server.Answer = r => MaintainerrFixture.Json(r, JsonSerializer.Serialize(new[] { Collection(7, true, 10, members.Take(2)) }));
        Func<int, int, HttpListenerResponse, Task> good = (page, size, r) => MaintainerrFixture.Json(r, PageOf(members, page, size));
        var answer = good;
        server.Page = (_, page, size, r) => answer(page, size, r);
        var service = Service();
        var config = Config(server.Url, key: "page-secret-key");
        Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Equal(600, service.Status(config).Items);
        var lastSuccess = service.Status(config).LastSuccess;
        var onPageTwo = Guid.Parse(members[550].Id!);

        // The second page fails, is missing although the first was there, redirects, is not a page or is slow; or
        // the first page is refused or is not JSON. None of them may shorten the list to the two members the list
        // embeds. (A first page that is JSON but no page is a source without the route: the test above.)
        Func<int, HttpListenerResponse, Task> Second(Func<HttpListenerResponse, Task> broken) => (page, r) => page == 2 ? broken(r) : good(page, 500, r);
        var failures = new (string Error, Func<int, HttpListenerResponse, Task> Page)[]
        {
            ("HTTP 500", Second(r => MaintainerrFixture.Json(r, "{\"message\":\"boom\"}", 500))),
            ("HTTP 404", Second(r => MaintainerrFixture.Json(r, "{\"statusCode\":404}", 404))),
            ("redirected (redirects are not followed)", Second(r => { r.StatusCode = 302; r.RedirectLocation = receiver.Url + "/receive"; return Task.CompletedTask; })),
            ("not a Maintainerr collections answer", Second(r => MaintainerrFixture.Json(r, "[]"))),
            ("not a Maintainerr collections answer", Second(r => MaintainerrFixture.Json(r, "{\"totalSize\":600}"))),
            ("not a Maintainerr collections answer", Second(r => MaintainerrFixture.Json(r, "{\"totalSize\":600,\"items\":{}}"))),
            ("not a Maintainerr collections answer", Second(r => MaintainerrFixture.Json(r, string.Empty))),
            ("not a Maintainerr collections answer", Second(r => MaintainerrFixture.Json(r, "<html>login</html>"))),
            ("HTTP 401", (_, r) => MaintainerrFixture.Json(r, "{\"message\":\"Unauthorized\"}", 401)),
            ("HTTP 500", (_, r) => MaintainerrFixture.Json(r, "{\"message\":\"boom\"}", 500)),
            ("not a Maintainerr collections answer", (_, r) => MaintainerrFixture.Json(r, string.Empty)),
            ("not a Maintainerr collections answer", (_, r) => MaintainerrFixture.Json(r, "<html>login</html>")),
            ("timed out", Second(async r => { await Task.Delay(2000); await MaintainerrFixture.Json(r, PageOf(members, 2, 500)); })),
        };
        foreach (var failure in failures)
        {
            answer = (page, _, r) => failure.Page(page, r);
            service.Timeout = failure.Error == "timed out" ? TimeSpan.FromMilliseconds(400) : TimeSpan.FromSeconds(20);
            Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
            var s = service.Status(config);
            Assert.Equal(failure.Error, s.LastError);
            Assert.Equal((600, 600), (s.Items, s.Dated));
            Assert.Equal(lastSuccess, s.LastSuccess);
            Assert.NotNull(service.Get(onPageTwo, config));
        }

        // (The fixture answers one request at a time, so the next ones wait for the slow page to finish.)
        service.Timeout = TimeSpan.FromSeconds(20);
        Assert.Equal(0, receiver.Requests);
        Assert.DoesNotContain("page-secret-key", File.ReadAllText(_core.Logger.CurrentLogFilePath));

        // A total that is not a number does not end the paging early, and is no failure: an empty page ends it.
        answer = (page, size, r) => MaintainerrFixture.Json(r, PageOf(members, page, size).Replace("\"totalSize\":600", "\"totalSize\":\"600\""));
        server.Paged.Clear();
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Null(service.Status(config).LastError);
        Assert.Equal(600, service.Status(config).Items);
        Assert.Equal(3, server.Paged.Count);

        // A refresh cancelled between pages records nothing.
        var attempt = service.Status(config).LastAttempt;
        var slow = Second(async r => { await Task.Delay(2000); await MaintainerrFixture.Json(r, "[]"); });
        answer = (page, _, r) => slow(page, r);
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.RefreshAsync(config, true, cancel.Token));
        Assert.Equal(attempt, service.Status(config).LastAttempt);
        Assert.Equal(600, service.Status(config).Items);
    }

    [Fact]
    public async Task Refreshes_only_when_due_and_backs_off_after_failures_keeping_the_last_good_answer()
    {
        using var server = new MaintainerrFixture();
        var item = Guid.NewGuid();
        var status = 200;
        server.Answer = r => status == 200
            ? MaintainerrFixture.Json(r, Collections((true, 10, "movie", new Media[] { new(item.ToString(), null, "2026-10-25T10:00:00Z") })))
            : MaintainerrFixture.Json(r, "{\"message\":\"boom\"}", status);
        var now = Added.AddDays(1);
        var service = Service();
        service.Now = () => now;
        var config = Config(server.Url, key: "k-should-not-leak", hours: 6);
        await service.RefreshAsync(config, false, CancellationToken.None);
        Assert.Equal(1, server.Requests);
        // Card reads never ask; a run before the interval does nothing.
        for (var i = 0; i < 5; i++) Assert.NotNull(service.Get(item, config));
        now = now.AddHours(5);
        Assert.False(await service.RefreshAsync(config, false, CancellationToken.None));
        Assert.Equal(1, server.Requests);
        // A forced refresh (the admin page) asks at once.
        Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Equal(2, server.Requests);

        // Failures: the previous answer stays, the retry waits 15, 30, 60 minutes… at most the interval.
        status = 500;
        now = now.AddHours(7);
        Assert.False(await service.RefreshAsync(config, false, CancellationToken.None));
        Assert.NotNull(service.Get(item, config));
        var s = service.Status(config);
        Assert.Equal("HTTP 500", s.LastError);
        Assert.Equal(now.AddMinutes(15).ToUnixTimeMilliseconds(), s.NextRefresh);
        now = now.AddMinutes(15);
        await service.RefreshAsync(config, false, CancellationToken.None);
        Assert.Equal(now.AddMinutes(30).ToUnixTimeMilliseconds(), service.Status(config).NextRefresh);
        Assert.Equal(TimeSpan.FromHours(6), LeavingSoonService.RetryDelay(9, TimeSpan.FromHours(6)));
        Assert.Equal(TimeSpan.FromMinutes(60), LeavingSoonService.RetryDelay(3, TimeSpan.FromHours(6)));
        Assert.DoesNotContain("k-should-not-leak", File.ReadAllText(_core.Logger.CurrentLogFilePath));
        Assert.DoesNotContain(server.Url, File.ReadAllText(_core.Logger.CurrentLogFilePath));

        // Recovery resets the delay.
        status = 200;
        now = now.AddMinutes(30);
        await service.RefreshAsync(config, false, CancellationToken.None);
        s = service.Status(config);
        Assert.Null(s.LastError);
        Assert.Equal(now.AddHours(6).ToUnixTimeMilliseconds(), s.NextRefresh);
        Assert.Equal(1, s.Items);
        Assert.Equal(1, s.Dated);
    }

    [Fact]
    public async Task Malformed_slow_oversized_and_unreachable_answers_are_failures_with_a_short_reason()
    {
        using var server = new MaintainerrFixture();
        var service = Service();
        service.Timeout = TimeSpan.FromMilliseconds(300);
        var config = Config(server.Url);

        server.Answer = r => MaintainerrFixture.Json(r, "<html>login</html>");
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal("not a Maintainerr collections answer", service.Status(config).LastError);

        server.Answer = r => MaintainerrFixture.Json(r, "{\"unexpected\":true}");
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal("not a Maintainerr collections answer", service.Status(config).LastError);

        server.Answer = async r => { await Task.Delay(2000); await MaintainerrFixture.Json(r, "[]"); };
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal("timed out", service.Status(config).LastError);

        server.Answer = async r =>
        {
            r.StatusCode = 200;
            r.SendChunked = true;
            var chunk = new byte[1024 * 1024];
            for (var i = 0; i < 17; i++) await r.OutputStream.WriteAsync(chunk);
        };
        service.Timeout = TimeSpan.FromSeconds(20);
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal("answer too large", service.Status(config).LastError);

        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var closed = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        var gone = Config($"http://127.0.0.1:{closed}");
        await service.RefreshAsync(gone, true, CancellationToken.None);
        Assert.Equal("not reachable", service.Status(gone).LastError);

        // A metadata address is refused before any request.
        var metadata = Config("http://169.254.169.254");
        await service.RefreshAsync(metadata, true, CancellationToken.None);
        Assert.Equal("address not allowed", service.Status(metadata).LastError);
    }

    [Fact]
    public async Task A_redirect_is_never_followed_so_the_key_never_reaches_another_origin()
    {
        using var server = new MaintainerrFixture();
        using var receiver = new MaintainerrFixture();
        var item = Guid.NewGuid();
        var location = (string?)null;
        server.Answer = r =>
        {
            if (location == null) return MaintainerrFixture.Json(r, Collections((true, 10, "movie", new Media[] { new(item.ToString(), null, "2026-10-25T10:00:00Z") })));
            r.StatusCode = 302;
            r.RedirectLocation = location;
            return Task.CompletedTask;
        };
        var service = Service();
        var config = Config(server.Url, key: "redirect-secret-key");
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.NotNull(service.Get(item, config));

        // Another origin (another host and port), the address guard's metadata address and a
        // relative redirect: none is followed, the last good answer stays.
        foreach (var to in new[] { receiver.Url.Replace("127.0.0.1", "localhost") + "/receive?token=t0ken", "http://169.254.169.254/latest/meta-data", "/elsewhere" })
        {
            location = to;
            Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
            Assert.Equal("redirected (redirects are not followed)", service.Status(config).LastError);
            Assert.NotNull(service.Get(item, config));
        }

        Assert.Equal(0, receiver.Requests);
        Assert.Equal(4, server.Requests);
        Assert.All(server.Seen, s => Assert.StartsWith("/api/collections", s.Path));
        var log = File.ReadAllText(_core.Logger.CurrentLogFilePath);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(log, "redirect to host 'localhost'"));
        Assert.Contains("redirect to host '169.254.169.254'", log);
        Assert.DoesNotContain("redirect-secret-key", log);
        Assert.DoesNotContain("t0ken", log);
        Assert.DoesNotContain("/receive", log);

        // A client that follows redirects anyway (not the plugin's registration): the answer
        // from the other address is refused.
        receiver.Answer = r => MaintainerrFixture.Json(r, "[]");
        location = receiver.Url + "/api/collections";
        var following = new LeavingSoonService(new FollowingClients(), Path.Combine(_core.Root, "following.json"), null, _core.Logger) { Now = () => Added.AddDays(1) };
        await following.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal("redirected (redirects are not followed)", following.Status(config).LastError);
    }

    [Fact]
    public async Task An_unrecognisable_list_is_a_failure_that_keeps_the_last_good_answer_but_a_real_empty_answer_clears_it()
    {
        using var server = new MaintainerrFixture();
        var item = Guid.NewGuid();
        var valid = Collections((true, 10, "movie", new Media[] { new(item.ToString(), null, "2026-10-25T10:00:00Z") }));
        var body = valid;
        server.Answer = r => MaintainerrFixture.Json(r, body);
        var service = Service();
        var config = Config(server.Url);
        await service.RefreshAsync(config, true, CancellationToken.None);
        Assert.Equal((1, 1), (service.Status(config).Items, service.Status(config).Dated));
        var lastSuccess = service.Status(config).LastSuccess;

        // No collection at all, wrong scalar types, members without a usable id: failures.
        foreach (var malformed in new[]
        {
            "[{\"error\":\"unexpected API payload\"}]", "[1,2,3]", "[\"a\",\"b\"]", "{\"data\":[{\"message\":\"nope\"}]}",
            "[{\"isActive\":true,\"deleteAfterDays\":5,\"media\":[{\"foo\":1},{\"mediaServerId\":\"not-a-guid\"},7]}]",
        })
        {
            body = malformed;
            Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
            var s = service.Status(config);
            Assert.Equal("not a Maintainerr collections answer", s.LastError);
            Assert.Equal((1, 1), (s.Items, s.Dated));
            Assert.Equal(lastSuccess, s.LastSuccess);
            Assert.NotNull(service.Get(item, config));
        }

        // Mixed: the unrecognisable entries and members are skipped, the usable ones count.
        body = "[{\"error\":\"x\"}," + valid.TrimStart('[').TrimEnd(']') + ",{\"isActive\":true,\"media\":[{\"foo\":1}]}]";
        Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Null(service.Status(config).LastError);
        Assert.NotNull(service.Get(item, config));

        // A reachable server that lists nothing (or only inactive or empty collections) really has nothing leaving.
        foreach (var empty in new[] { "[]", "{\"data\":[]}", "[{\"isActive\":false,\"title\":\"Paused\"}]", "[{\"isActive\":true,\"deleteAfterDays\":30,\"media\":[]}]" })
        {
            body = valid;
            await service.RefreshAsync(config, true, CancellationToken.None);
            body = empty;
            Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
            Assert.Null(service.Status(config).LastError);
            Assert.Equal(0, service.Status(config).Items);
            Assert.Null(service.Get(item, config));
        }

        // Recovery.
        body = valid;
        Assert.True(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.NotNull(service.Get(item, config));
    }

    [Fact]
    public async Task A_delete_date_beyond_ten_years_from_now_refuses_the_answer_and_keeps_the_last_good_one()
    {
        var now = DateTimeOffset.Parse("2026-10-31T00:00:00Z");
        string One(string added, int days) => Collections((true, days, "movie", new Media[] { new(Guid.NewGuid().ToString(), null, added) }));
        JsonElement Root(string json) => JsonDocument.Parse(json).RootElement;
        // Near the maximum plus days, a far-past addDate, an epoch beyond any DateTimeOffset.
        Assert.Throws<LeavingSoonService.DateRangeException>(() => LeavingSoonService.ParseCollections(Root(One("9999-12-31T00:00:00Z", 36500)), now));
        Assert.Throws<LeavingSoonService.DateRangeException>(() => LeavingSoonService.ParseCollections(Root(One("9999-12-31T00:00:00Z", 0)), now));
        Assert.Throws<LeavingSoonService.DateRangeException>(() => LeavingSoonService.ParseCollections(Root(One("0001-01-01T00:00:00Z", 30)), now));
        Assert.Throws<LeavingSoonService.DateRangeException>(() => LeavingSoonService.ParseCollections(Root(One("1900-01-01T00:00:00Z", 36500)), now));
        var epoch = "[{\"isActive\":true,\"deleteAfterDays\":1,\"media\":[{\"mediaServerId\":\"" + Guid.NewGuid() + "\",\"addDate\":";
        Assert.Throws<LeavingSoonService.DateRangeException>(() => LeavingSoonService.ParseCollections(Root(epoch + "1}]}]"), now));
        // An epoch no DateTimeOffset holds is not a date (the member stays, undated).
        Assert.Null(Assert.Single(LeavingSoonService.ParseCollections(Root(epoch + "999999999999999999}]}]"), now)).DeleteAt);
        // Inside the window: kept.
        Assert.Equal(now.AddDays(3650).ToUnixTimeMilliseconds(), Assert.Single(LeavingSoonService.ParseCollections(Root(One("2026-10-31T00:00:00Z", 3650)), now)).DeleteAt);
        Assert.Equal(now.AddDays(-3600).ToUnixTimeMilliseconds(), Assert.Single(LeavingSoonService.ParseCollections(Root(One(now.AddDays(-3600).ToString("o"), 0)), now)).DeleteAt);

        using var server = new MaintainerrFixture();
        var item = Guid.NewGuid();
        var body = Collections((true, 10, "movie", new Media[] { new(item.ToString(), null, "2026-10-25T10:00:00Z") }));
        server.Answer = r => MaintainerrFixture.Json(r, body);
        var service = Service();
        var config = Config(server.Url);
        await service.RefreshAsync(config, true, CancellationToken.None);
        var good = service.Get(item, config);
        Assert.NotNull(good?.DeleteAt);
        body = Collections((true, 36500, "movie", new Media[] { new(item.ToString(), null, "9999-12-31T00:00:00Z") }));
        Assert.False(await service.RefreshAsync(config, true, CancellationToken.None));
        Assert.Equal("a delete date is out of range", service.Status(config).LastError);
        Assert.Equal(good, service.Get(item, config));
    }

    [Fact]
    public void The_native_badge_reads_an_unrepresentable_stored_time_as_undated()
    {
        var now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        foreach (var at in new[] { long.MaxValue, long.MinValue, DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() + 1, DateTimeOffset.MaxValue.ToUnixTimeMilliseconds(), DateTimeOffset.MinValue.ToUnixTimeMilliseconds() })
        {
            foreach (var zone in new[] { "UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago" })
                Assert.Equal("Leaving soon", StatusRules.LeavingBadge(new TagLeaving { DeleteAt = at }, Native(zone), now).Text);
        }
    }

    [Fact]
    public async Task Cancellation_stops_a_refresh_without_recording_a_failure()
    {
        using var server = new MaintainerrFixture();
        server.Answer = async r => { await Task.Delay(3000); await MaintainerrFixture.Json(r, "[]"); };
        var service = Service();
        var config = Config(server.Url);
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.RefreshAsync(config, true, cancel.Token));
        Assert.Null(service.Status(config).LastAttempt);
    }

    [Fact]
    public async Task Existing_collections_named_by_the_administrator_mark_their_members_without_a_date()
    {
        var library = new Mock<ILibraryManager>();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Member" };
        var other = new Movie { Id = Guid.NewGuid(), Name = "Other" };
        var box = new BoxSet { Id = Guid.NewGuid(), Name = "Leaving Soon", LinkedChildren = [new LinkedChild { ItemId = movie.Id }] };
        var unrelated = new BoxSet { Id = Guid.NewGuid(), Name = "Favourites", LinkedChildren = [new LinkedChild { ItemId = other.Id }] };
        var items = new List<BaseItem> { movie, other, box, unrelated };
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => items.Where(i => q.IncludeItemTypes == null || q.IncludeItemTypes.Length == 0 || q.IncludeItemTypes.Contains(i.GetBaseItemKind())).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            var service = Service(library.Object);
            var config = Config(names: " leaving soon \nMissing collection, Leaving Soon");
            Assert.Equal(new[] { "leaving soon", "Missing collection" }, LeavingSoonSources.CollectionNames(config.LeavingSoonCollections));
            Assert.True(await service.RefreshAsync(config, false, CancellationToken.None));
            Assert.Equal(new TagLeaving { Collections = box.Id.ToString("N") }, service.Get(movie.Id, config));
            Assert.Null(service.Get(other.Id, config));
            var s = service.Status(config);
            Assert.Equal((2, 1, 1, 0), (s.Collections, s.CollectionsFound, s.Items, s.Dated));
            // Removing the names clears the facts.
            var none = Config();
            Assert.True(await service.RefreshAsync(none, false, CancellationToken.None));
            Assert.Null(service.Get(movie.Id, none));
            Assert.False(LeavingSoonSources.Configured(none));
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    [Fact]
    public async Task The_cache_carries_leaving_onto_seasons_and_episodes_and_hides_it_once_the_source_is_removed()
    {
        using var f = new ApiPluginFixture();
        var library = new Mock<ILibraryManager>();
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        var season = new Season { Id = Guid.NewGuid(), Name = "Season 1", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 1 };
        var episode = new Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 1 };
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        var items = new List<BaseItem> { series, season, episode, movie };
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        using var server = new MaintainerrFixture();
        var seasonDelete = Added.AddDays(20).ToUnixTimeMilliseconds();
        server.Answer = r => MaintainerrFixture.Json(r, Collections(
            (true, 40, "show", new Media[] { new(series.Id.ToString(), null, "2026-10-25T10:00:00Z") }),
            (true, 20, "season", new Media[] { new(season.Id.ToString(), null, "2026-10-25T10:00:00Z") })));
        try
        {
            f.Plugin.Configuration.TagCacheServerMode = true;
            f.Plugin.Configuration.LeavingSoonMaintainerrUrl = server.Url;
            var service = Service(library.Object);
            using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            cache.BuildFullCache(null, CancellationToken.None);
            Assert.True(cache.TryGetEntry(movie.Id, out var before));
            Assert.Null(before.Leaving);

            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            Leaving(cache, series).Should(Added.AddDays(40).ToUnixTimeMilliseconds());
            Leaving(cache, season).Should(seasonDelete);
            Leaving(cache, episode).Should(seasonDelete); // its season goes first
            Assert.Null(Leaving(cache, movie).Value);
            Assert.Equal(seasonDelete, cache.GetLeaving(episode)?.DeleteAt); // /tag-data and on-demand entries agree
            Assert.Equal(seasonDelete, cache.BuildEntryOnDemand(episode)?.Leaving?.DeleteAt);

            // The source removed: served entries drop the facts before the next publish.
            Assert.True(cache.TryGetEntry(series.Id, out var stored));
            f.Plugin.Configuration.LeavingSoonMaintainerrUrl = string.Empty;
            Assert.Null(TagCacheService.ApplySourceRatingAvailability(stored).Leaving);
            Assert.NotNull(stored.Leaving); // the shared entry is never changed in place
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    [Fact]
    public async Task Collection_facts_reach_only_users_who_can_access_a_leaving_collection_and_maintainerr_facts_reach_everyone()
    {
        using var f = new ApiPluginFixture();
        var library = new Mock<ILibraryManager>();
        var series = new Series { Id = Guid.NewGuid(), Name = "Show" };
        var season = new Season { Id = Guid.NewGuid(), Name = "Season 2", ParentId = series.Id, SeriesId = series.Id, IndexNumber = 2 };
        var episode = new TagCacheSubtitleLanguagesTests.Episode { Id = Guid.NewGuid(), Name = "Pilot", ParentId = season.Id, SeasonId = season.Id, SeriesId = series.Id, IndexNumber = 1, ParentIndexNumber = 2 };
        var member = new TagCacheSubtitleLanguagesTests.Movie { Id = Guid.NewGuid(), Name = "Member" };
        var dated = new Movie { Id = Guid.NewGuid(), Name = "Dated" };
        var hiddenBox = new BoxSet { Id = Guid.NewGuid(), Name = "Leaving Soon", LinkedChildren = [new LinkedChild { ItemId = member.Id }, new LinkedChild { ItemId = series.Id }, new LinkedChild { ItemId = dated.Id }] };
        var unrelatedBox = new BoxSet { Id = Guid.NewGuid(), Name = "Unrelated" };
        var items = new List<BaseItem> { series, season, episode, member, dated, hiddenBox };
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var viewer = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var hidden = new HashSet<Guid>();
        IEnumerable<BaseItem> As(InternalItemsQuery q) => q.User?.Id == viewer.Id ? Select(items, q).Where(i => !hidden.Contains(i.Id)) : Select(items, q);
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => As(q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => As(q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        library.Setup(l => l.GetItemById<BaseItem>(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        using var server = new MaintainerrFixture();
        var deleteAt = Added.AddDays(9).ToUnixTimeMilliseconds();
        server.Answer = r => MaintainerrFixture.Json(r, Collections((true, 9, "movie", new Media[] { new(dated.Id.ToString(), null, "2026-10-25T10:00:00Z") })));
        try
        {
            f.Plugin.Configuration.TagCacheServerMode = true;
            f.Plugin.Configuration.LeavingSoonMaintainerrUrl = server.Url;
            f.Plugin.Configuration.LeavingSoonCollections = "Leaving Soon";
            f.Plugin.Configuration.CustomTagRules = CustomTagRuleSet.Normalize(new[] { new CustomTagRule { Match = "collection", Value = "Leaving Soon", Label = "Leaving collection" } });
            var service = Service(library.Object);
            using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            cache.BuildFullCache(null, CancellationToken.None);
            items.Add(unrelatedBox); // access changes outside this cache generation do not change either source digest.
            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            string Key(BaseItem i) => i.Id.ToString("N");
            var box = Key(hiddenBox);
            Assert.True(cache.TryGetEntry(member.Id, out var shared));
            Assert.Equal(new TagLeaving { Collections = box }, shared.Leaving); // provenance stays on the server entry
            Assert.True(cache.TryGetEntry(episode.Id, out var sharedEpisode));
            Assert.Equal(box, sharedEpisode.Leaving?.Collections); // inherited from the series with it

            // Everyone sees the collection: the facts without their provenance.
            var before = cache.GetCacheForUser(viewer, out _, out _, out var visibleRevision);
            Assert.Equal(new TagLeaving(), before[Key(member)].Leaving);
            Assert.Single(before[Key(member)].CustomTags!);
            cache.InvalidateUserAccess();
            cache.GetCacheForUser(viewer, out _, out _, out var unchangedRevision);
            Assert.Equal(visibleRevision, unchangedRevision);
            hidden.Add(unrelatedBox.Id);
            cache.InvalidateUserAccess();
            cache.GetCacheForUser(viewer, out _, out _, out var unrelatedRevision);
            Assert.Equal(visibleRevision, unrelatedRevision);
            var served = JsonSerializer.Serialize(before.Values.Select(e => e.Leaving));
            Assert.DoesNotContain(box, served);
            Assert.DoesNotContain("Collections", served);

            // The collection hidden from the viewer (the items stay visible): cache, batch and native
            // drop the collection facts, Maintainerr's dated fact stays, the revision changes.
            hidden.Add(hiddenBox.Id);
            cache.InvalidateUserAccess();
            var viewed = cache.GetCacheForUser(viewer, out _, out _, out var hiddenRevision);
            Assert.NotEqual(visibleRevision, hiddenRevision);
            Assert.Contains(";c", hiddenRevision);
            Assert.Contains(";l", hiddenRevision);
            Assert.Empty(viewed[Key(member)].CustomTags ?? Array.Empty<string>());
            foreach (var item in new BaseItem[] { member, series, season, episode }) Assert.Null(viewed[Key(item)].Leaving);
            Assert.Equal(new TagLeaving { DeleteAt = deleteAt }, viewed[Key(dated)].Leaving);
            var adminView = cache.GetCacheForUser(admin, out _, out _, out var adminRevision);
            Assert.NotEqual(adminRevision, hiddenRevision);
            foreach (var item in new BaseItem[] { member, series, season, episode }) Assert.Equal(new TagLeaving(), adminView[Key(item)].Leaving);
            Assert.Equal(new TagLeaving { Collections = box }, shared.Leaving); // the shared entry is never changed
            Assert.Null(cache.GetLeavingForUser(member, viewer));
            Assert.Null(cache.GetLeavingForUser(episode, viewer));
            Assert.Equal(new TagLeaving { DeleteAt = deleteAt }, cache.GetLeavingForUser(dated, viewer));
            Assert.Equal(new TagLeaving(), cache.GetLeavingForUser(episode, admin));
            Assert.Null(cache.FilterLeavingForUser(shared, viewer).Leaving);

            // A delta with nothing new still reports the viewer's current revision.
            var cursor = viewed.Values.Max(e => e.LastUpdated);
            cache.GetCacheForUser(viewer, out _, out _, out var deltaRevision, since: cursor);
            Assert.Equal(hiddenRevision, deltaRevision);
            cache.GetCacheForUser(viewer, out _, out _, out var memoizedRevision, since: cursor);
            Assert.Equal(hiddenRevision, memoizedRevision);
            cache.GetShareableCacheForUser(viewer, out _, out _, out var serializedRevision, out _);
            Assert.Equal(hiddenRevision, serializedRevision);
            var serializedAdmin = cache.GetShareableCacheForUser(admin, out _, out _, out _, out var shareKey);
            Assert.NotNull(shareKey);
            cache.StoreSerializedItems(shareKey!, JsonSerializer.SerializeToUtf8Bytes(serializedAdmin), serializedAdmin.Count);
            Assert.False(cache.TryGetSerializedItems(viewer, out _, out _, out var responseRevision, out _, out _, out _));
            Assert.Equal(hiddenRevision, responseRevision);
            cache.SaveToDisk();
            using var reloaded = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            reloaded.LoadFromDisk();
            Assert.True(reloaded.TryGetEntry(member.Id, out var persisted));
            Assert.Equal(box, persisted.Leaving?.Collections);
            Assert.Null(reloaded.GetCacheForUser(viewer, out _, out _)[Key(member)].Leaving);
            Assert.Equal(new TagLeaving(), reloaded.GetCacheForUser(admin, out _, out _)[Key(member)].Leaving);

            // Native posters follow the viewer's access too.
            var resolver = new SpoilerUserResolver(f.Core.Manager, library.Object, f.Core.Logger, null!);
            using var native = new PosterTagDataProvider(cache, library.Object, new SpoilerTagDataStripper(library.Object, Mock.Of<IUserDataManager>(), resolver), resolver,
                new PosterTagReviewRatings(f.Core.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()), f.Core.Logger), f.Core.Logger);
            Assert.Null(native.GetPinnedSnapshot(member.Id, viewer, includeStatus: true)!.Entry.Leaving);
            Assert.Equal(new TagLeaving(), native.GetPinnedSnapshot(member.Id, admin, includeStatus: true)!.Entry.Leaving);
            Assert.NotEqual(native.GetPinnedSnapshot(member.Id, admin, true)!.PinnedHash, native.GetPinnedSnapshot(member.Id, viewer, true)!.PinnedHash);
            var hiddenHash = native.GetPinnedDataHash(member.Id, viewer, true);
            hidden.Remove(hiddenBox.Id);
            cache.InvalidateUserAccess();
            Assert.Equal(new TagLeaving(), native.GetPinnedSnapshot(member.Id, viewer, true)!.Entry.Leaving);
            Assert.Single(native.GetPinnedSnapshot(member.Id, viewer, true)!.Entry.CustomTags!);
            Assert.NotEqual(hiddenHash, native.GetPinnedDataHash(member.Id, viewer, true));
            hidden.Add(hiddenBox.Id);
            cache.InvalidateUserAccess();
            Assert.Equal(hiddenHash, native.GetPinnedDataHash(member.Id, viewer, true));

            // The real batch projection must drop Leaving in every guarded stub when tags are hidden.
            var users = new Mock<IUserManager>();
            users.Setup(u => u.GetUserById(admin.Id)).Returns(admin);
            foreach (var item in items)
                library.Setup(l => l.GetItemById<BaseItem>(item.Id, admin)).Returns(item);
            var userData = new Mock<IUserDataManager>();
            userData.Setup(d => d.GetUserData(admin, It.IsAny<BaseItem>())).Returns(new UserItemData { Key = "fixture", Played = false });
            var state = new UserSpoilerBlur();
            state.Series[series.Id.ToString("N")] = new();
            state.Movies[member.Id.ToString("N")] = new();
            f.Core.Manager.SaveUserConfiguration(admin.Id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, state);
            f.Plugin.Configuration.SpoilerBlurEnabled = true;
            f.Plugin.Configuration.SpoilerStripRatings = true;
            foreach (var stripTags in new[] { true, false })
            {
                f.Plugin.Configuration.SpoilerStripTags = stripTags;
                var guard = new SpoilerUserResolver(f.Core.Manager, library.Object, f.Core.Logger, null!);
                var stripper = new SpoilerTagDataStripper(library.Object, userData.Object, guard);
                var controller = ApiAssetTests.Controller(f.Core, users.Object, cache, library.Object, userData.Object, f.Core.Manager, guard, stripper);
                controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(admin.Id);
                var answer = Assert.IsType<OkObjectResult>(ApiAssetTests.SiblingOf<JeMediaTagsController>(controller).GetTagData(admin.Id, new BaseItem[] { member, series, season, episode }.Select(i => i.Id.ToString()).ToArray()));
                var facts = JsonSerializer.SerializeToElement(answer.Value).GetProperty("Items").EnumerateArray().ToList();
                Assert.Equal(4, facts.Count);
                foreach (var fact in facts)
                {
                    Assert.Equal(stripTags, fact.GetProperty("Leaving").ValueKind == JsonValueKind.Null);
                    Assert.DoesNotContain("Collections", fact.GetRawText());
                }
            }
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    [Fact]
    public void Two_undated_facts_join_their_collections_and_a_maintainerr_one_wins()
    {
        var a = new TagLeaving { Collections = "aa" };
        var b = new TagLeaving { Collections = "bb" };
        Assert.Equal(new TagLeaving { Collections = "aa,bb" }, LeavingSoonService.Earliest(b, a));
        Assert.Equal(new TagLeaving(), LeavingSoonService.Earliest(a, new TagLeaving()));
        Assert.Equal(new TagLeaving { DeleteAt = 3 }, LeavingSoonService.Earliest(a, new TagLeaving { DeleteAt = 3 }));
        var access = new HashSet<string> { "bb" };
        Assert.Equal(new TagLeaving(), LeavingSoonService.Visible(new TagLeaving { Collections = "aa,bb" }, access));
        Assert.Null(LeavingSoonService.Visible(a, access));
        Assert.Equal(new TagLeaving { DeleteAt = 3 }, LeavingSoonService.Visible(new TagLeaving { DeleteAt = 3 }, access));
    }

    [Fact]
    public async Task A_publish_cancelled_after_the_answer_was_saved_is_repaired_by_the_next_run_even_when_nothing_changed()
    {
        using var f = new ApiPluginFixture();
        var library = new Mock<ILibraryManager>();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        var items = new List<BaseItem> { movie };
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        using var server = new MaintainerrFixture();
        var days = 10;
        server.Answer = r => MaintainerrFixture.Json(r, Collections((true, days, "movie", new Media[] { new(movie.Id.ToString(), null, "2026-10-25T10:00:00Z") })));
        try
        {
            f.Plugin.Configuration.TagCacheServerMode = true;
            f.Plugin.Configuration.LeavingSoonMaintainerrUrl = server.Url;
            var service = Service(library.Object);
            using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            cache.BuildFullCache(null, CancellationToken.None);
            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            Leaving(cache, movie).Should(Added.AddDays(10).ToUnixTimeMilliseconds());
            Assert.False(service.PublishPending);

            // A changed answer is saved, then the publish is cancelled while it waits for the cache.
            days = 20;
            var rebuild = (SemaphoreSlim)typeof(TagCacheService).GetField("_rebuildLock", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(cache)!;
            await rebuild.WaitAsync();
            using (var cancel = new CancellationTokenSource())
            {
                var run = cache.RefreshLeavingAsync(force: true, cancel.Token);
                // Saved: the refresh now waits for the cache.
                while (service.Get(movie.Id, f.Plugin.Configuration)?.DeleteAt != Added.AddDays(20).ToUnixTimeMilliseconds()) await Task.Delay(10);
                await Task.Delay(50);
                cancel.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
            }

            rebuild.Release();
            Assert.Equal(Added.AddDays(20).ToUnixTimeMilliseconds(), service.Get(movie.Id, f.Plugin.Configuration)?.DeleteAt); // saved
            Leaving(cache, movie).Should(Added.AddDays(10).ToUnixTimeMilliseconds()); // not published
            Assert.True(service.PublishPending);
            // The marker survives a restart.
            Assert.True(Service(library.Object).PublishPending);

            // The next scheduled run is not due and asks nothing, yet publishes.
            var asked = server.Requests;
            await cache.RefreshLeavingAsync(force: false, CancellationToken.None);
            Assert.Equal(asked, server.Requests);
            Leaving(cache, movie).Should(Added.AddDays(20).ToUnixTimeMilliseconds());
            Assert.False(service.PublishPending);

            // Same again with a forced refresh that gets the same (unchanged) answer.
            days = 30;
            await rebuild.WaitAsync();
            using (var cancel = new CancellationTokenSource())
            {
                var run = cache.RefreshLeavingAsync(force: true, cancel.Token);
                while (service.Get(movie.Id, f.Plugin.Configuration)?.DeleteAt != Added.AddDays(30).ToUnixTimeMilliseconds()) await Task.Delay(10);
                await Task.Delay(50);
                cancel.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
            }

            rebuild.Release();
            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            Leaving(cache, movie).Should(Added.AddDays(30).ToUnixTimeMilliseconds());
            Assert.False(service.PublishPending);
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    [Fact]
    public async Task A_restart_after_a_publish_that_never_reached_the_cache_file_reapplies_the_snapshot()
    {
        using var f = new ApiPluginFixture();
        var library = new Mock<ILibraryManager>();
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        var gone = new Movie { Id = Guid.NewGuid(), Name = "Gone" };
        var items = new List<BaseItem> { movie, gone };
        library.Setup(l => l.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).Select(i => i.Id).ToArray());
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => Select(items, q).ToArray());
        library.Setup(l => l.GetItemById(It.IsAny<Guid>())).Returns((Guid id) => items.SingleOrDefault(i => i.Id == id));
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        using var server = new MaintainerrFixture();
        var days = 10;
        var members = new[] { movie, gone };
        server.Answer = r => MaintainerrFixture.Json(r, Collections((true, days, "movie", members.Select(m => new Media(m.Id.ToString(), null, "2026-10-25T10:00:00Z")).ToArray())));
        var cachePath = Path.Combine(f.Core.Root, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tag-cache.json");
        TagCacheService Restart(LeavingSoonService service)
        {
            var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            cache.LoadFromDisk();
            return cache;
        }

        string? OnDisk(BaseItem item) => JsonDocument.Parse(File.ReadAllText(cachePath)).RootElement.GetProperty("Items")
            .GetProperty(item.Id.ToString("N")).TryGetProperty("Leaving", out var leaving) ? leaving.GetRawText() : null;
        var crashed = new List<TagCacheService>();
        try
        {
            f.Plugin.Configuration.TagCacheServerMode = true;
            f.Plugin.Configuration.LeavingSoonMaintainerrUrl = server.Url;
            var service = Service(library.Object);
            var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger,
                new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger), leavingSoonService: service);
            crashed.Add(cache);
            cache.BuildFullCache(null, CancellationToken.None);
            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            cache.SaveToDisk();
            var old = Added.AddDays(10).ToUnixTimeMilliseconds();
            Assert.Contains(old.ToString(), OnDisk(movie));

            // A changed answer (later date, one member gone) is published in memory and
            // acknowledged; the process dies before the debounced cache save.
            days = 20;
            members = new[] { movie };
            await cache.RefreshLeavingAsync(force: true, CancellationToken.None);
            Leaving(cache, movie).Should(Added.AddDays(20).ToUnixTimeMilliseconds());
            Assert.False(service.PublishPending);
            Assert.Contains(old.ToString(), OnDisk(movie)); // the cache file is still the older one
            Assert.NotNull(OnDisk(gone));

            // Restart over the two files: the snapshot is re-applied, no request is made.
            var asked = server.Requests;
            var restartedService = Service(library.Object);
            var restarted = Restart(restartedService);
            crashed.Add(restarted);
            Leaving(restarted, movie).Should(Added.AddDays(20).ToUnixTimeMilliseconds());
            Assert.False(Leaving(restarted, gone).Present);
            await restarted.RefreshLeavingAsync(force: false, CancellationToken.None); // not due
            Assert.Equal(asked, server.Requests);
            Leaving(restarted, movie).Should(Added.AddDays(20).ToUnixTimeMilliseconds());

            // A cache save that fails (the temp path is taken) leaves the file older too;
            // the next restart repairs it the same way.
            days = 30;
            Directory.CreateDirectory(cachePath + ".tmp");
            await restarted.RefreshLeavingAsync(force: true, CancellationToken.None);
            restarted.SaveToDisk();
            Assert.DoesNotContain(Added.AddDays(30).ToUnixTimeMilliseconds().ToString(), OnDisk(movie));
            Directory.Delete(cachePath + ".tmp");
            var again = Restart(Service(library.Object));
            crashed.Add(again);
            Leaving(again, movie).Should(Added.AddDays(30).ToUnixTimeMilliseconds());
        }
        finally
        {
            BaseItem.LibraryManager = previous;
            foreach (var cache in crashed) cache.Dispose();
        }
    }

    private static IEnumerable<BaseItem> Select(List<BaseItem> items, InternalItemsQuery q)
    {
        IEnumerable<BaseItem> selected = items;
        if (q.ItemIds?.Length > 0) selected = selected.Where(i => q.ItemIds.Contains(i.Id));
        else if (q.IncludeItemTypes?.Length > 0) selected = selected.Where(i => q.IncludeItemTypes.Contains(i.GetBaseItemKind()));
        if (q.ParentId != Guid.Empty) selected = selected.Where(i => i.ParentId == q.ParentId || (i is Episode e && e.SeriesId == q.ParentId));
        return selected.Skip(q.StartIndex ?? 0).Take(q.Limit ?? int.MaxValue).ToArray();
    }

    private readonly record struct LeavingProbe(long? Value, bool Present)
    {
        public void Should(long expected)
        {
            Assert.True(Present);
            Assert.Equal(expected, Value);
        }
    }

    private static LeavingProbe Leaving(TagCacheService cache, BaseItem item)
        => cache.TryGetEntry(item.Id, out var entry) ? new(entry.Leaving?.DeleteAt, entry.Leaving != null) : throw new InvalidOperationException(item.Name);

    private static PosterTagSettings Native(string zone, string density = "full", string locale = "en-US")
    {
        var config = new PluginConfiguration { StatusTagsEnabled = true, LeavingSoonCollections = "Leaving Soon" };
        var user = new JellyfinEnhancedUserSettings
        {
            StatusTagsEnabled = true, StatusTagsLeaving = true, NativePosterTimeZone = zone, NativePosterDateLocale = locale,
            TagLayoutSettingsVersion = density == "compact" ? 1 : 0, TagLayout = density == "compact" ? "bands" : "corners", TagLabelDensity = density,
        };
        return PosterTagSettings.FromUserSettings(user, config);
    }

    [Theory]
    // Calendar days in the viewer's zone, not 24-hour blocks.
    [InlineData("UTC", "2026-10-30T23:30:00Z", "2026-10-31T00:30:00Z", "Leaving tomorrow")]
    [InlineData("Australia/Perth", "2026-10-30T23:30:00Z", "2026-10-31T15:30:00Z", "Leaving today")]
    [InlineData("UTC", "2026-10-30T23:30:00Z", "2026-10-31T15:30:00Z", "Leaving tomorrow")]
    // New York leaves daylight time on 1 November 2026: a 25-hour day still counts once.
    [InlineData("America/New_York", "2026-11-01T03:30:00Z", "2026-11-02T05:00:00Z", "Leaving in 2d")]
    [InlineData("America/New_York", "2026-11-01T03:30:00Z", "2026-11-02T04:59:00Z", "Leaving tomorrow")]
    // London left daylight time on 25 October 2026.
    [InlineData("Europe/London", "2026-10-24T22:30:00Z", "2026-10-29T23:30:00Z", "Leaving in 5d")]
    [InlineData("UTC", "2026-10-30T12:00:00Z", "2026-10-29T12:00:00Z", "Leaving soon")]
    public void The_badge_counts_local_calendar_days_across_time_zones_and_dst(string zone, string now, string deleteAt, string expected)
    {
        var badge = StatusRules.LeavingBadge(new TagLeaving { DeleteAt = DateTimeOffset.Parse(deleteAt).ToUnixTimeMilliseconds() }, Native(zone), DateTimeOffset.Parse(now));
        Assert.Equal(expected, badge.Text);
        Assert.Equal("leaving", badge.StyleKey);
    }

    [Fact]
    public void The_badge_text_comes_from_the_status_vocabulary_per_locale_and_density()
    {
        var now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        var leaving = new TagLeaving { DeleteAt = now.AddDays(5).ToUnixTimeMilliseconds() };
        Assert.Equal("Leaving in 5d", StatusRules.LeavingBadge(leaving, Native("UTC"), now).Text);
        Assert.Equal("5d left", StatusRules.LeavingBadge(leaving, Native("UTC", "compact"), now).Text);
        Assert.Equal("Leaving soon", StatusRules.LeavingBadge(new TagLeaving(), Native("UTC"), now).Text);
        // A locale without the strings falls back to English, as JE.t() does; one that has them speaks its own language.
        Assert.Equal("Leaving in 5d", StatusRules.LeavingBadge(leaving, Native("UTC", locale: "xx-XX"), now).Text);
        Assert.NotEqual("Leaving in 5d", StatusRules.LeavingBadge(leaving, Native("UTC", locale: "de-DE"), now).Text);
        Assert.Contains(StatusRules.StyleLabels, l => l.Key == "leaving" && l.Name == "Leaving soon");
    }

    [Fact]
    public void Native_leaving_needs_the_user_switch_and_a_source_and_comes_first()
    {
        var now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        var entry = new TagCacheEntry { Type = "Movie", TmdbId = "1", DateCreated = now.AddDays(-1).ToUnixTimeMilliseconds(), Leaving = new TagLeaving { DeleteAt = now.AddDays(3).ToUnixTimeMilliseconds() } };
        var context = new PosterStatusContext(now, Rank: 3);
        Assert.Equal("leaving_days", StatusRules.Resolve(entry, Native("UTC"), context)?.Key);
        var noSource = PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { StatusTagsEnabled = true, StatusTagsLeaving = true }, new PluginConfiguration { StatusTagsEnabled = true });
        Assert.False(noSource.StatusLeaving);
        Assert.Equal("just_added", StatusRules.Resolve(entry, noSource, context)?.Key);
        var off = PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { StatusTagsEnabled = true }, new PluginConfiguration { StatusTagsEnabled = true, LeavingSoonCollections = "x" });
        Assert.Equal("just_added", StatusRules.Resolve(entry, off, context)?.Key);
        // Only an opted-in user's settings token changes.
        Assert.NotEqual(Native("UTC").DigestAt(now), off.DigestAt(now));
        Assert.Equal(noSource.DigestAt(now), PosterTagSettings.FromUserSettings(new JellyfinEnhancedUserSettings { StatusTagsEnabled = true }, new PluginConfiguration { StatusTagsEnabled = true }).DigestAt(now));
    }

    [Fact]
    public void Cache_clone_compare_and_native_hash_include_leaving()
    {
        var entry = new TagCacheEntry { Type = "Movie", Leaving = new TagLeaving { DeleteAt = 5 } };
        var copy = entry.Clone();
        Assert.True(TagCacheEntry.ContentEquals(entry, copy));
        copy.Leaving = new TagLeaving { DeleteAt = 6 };
        Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        Assert.NotEqual(PosterTagDataProvider.ContentHash(entry), PosterTagDataProvider.ContentHash(copy));
        Assert.Equal(TagCacheService.CurrentCacheSchemaVersion, (int)typeof(TagCacheService).GetField("CurrentCacheSchemaVersion", BindingFlags.NonPublic | BindingFlags.Static)!.GetValue(null)!);
    }

    [Fact]
    public void Configuration_identity_follows_only_the_source()
    {
        var config = Config(names: "Leaving Soon");
        var before = LeavingSoonService.ConfigurationIdentity(config);
        config.LeavingSoonRefreshHours = 12;
        config.StatusTagsLeaving = true;
        Assert.Equal(before, LeavingSoonService.ConfigurationIdentity(config));
        config.LeavingSoonMaintainerrApiKey = "new";
        Assert.NotEqual(before, LeavingSoonService.ConfigurationIdentity(config));
        Assert.Equal(string.Empty, LeavingSoonService.ConfigurationIdentity(Config()));
    }

    [Theory]
    [InlineData("LeavingSoonMaintainerrUrl", "http://maintainerr:6246", true)]
    [InlineData("LeavingSoonMaintainerrUrl", "", true)]
    [InlineData("LeavingSoonMaintainerrUrl", "javascript:alert(1)", false)]
    [InlineData("LeavingSoonMaintainerrUrl", "http://a:b@host", false)]
    [InlineData("LeavingSoonMaintainerrApiKey", "abc123-XYZ", true)]
    [InlineData("LeavingSoonMaintainerrApiKey", "has space", false)]
    [InlineData("LeavingSoonCollections", "Leaving Soon\nGone Next Week", true)]
    [InlineData("LeavingSoonCollections", "", true)]
    public void Page_fields_are_validated(string field, string value, bool ok)
    {
        Assert.Contains(field, MediaTagsPageFields.Allowed);
        Assert.Equal(ok, MediaTagsPageFields.TryNormalize(field, value, out _, out var error));
        Assert.Equal(ok, error == null);
    }

    [Fact]
    public void Page_number_and_list_limits_are_validated()
    {
        Assert.True(MediaTagsPageFields.TryNormalize("LeavingSoonRefreshHours", 6, out _, out _));
        Assert.False(MediaTagsPageFields.TryNormalize("LeavingSoonRefreshHours", 0, out _, out _));
        Assert.False(MediaTagsPageFields.TryNormalize("LeavingSoonRefreshHours", 169, out _, out _));
        var many = string.Join("\n", Enumerable.Range(1, 21).Select(i => "Collection " + i));
        Assert.False(MediaTagsPageFields.TryNormalize("LeavingSoonCollections", many, out _, out _));
        Assert.False(MediaTagsPageFields.TryNormalize("LeavingSoonCollections", new string('x', 201), out _, out _));
        foreach (var field in new[] { "StatusTagsLeaving", "StatusTagsDirectPlay" }) Assert.Contains(field, MediaTagsPageFields.Allowed);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void The_public_configuration_says_only_whether_a_source_is_set(bool authenticated, bool admin)
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.UpdateConfiguration(new PluginConfiguration
        {
            StatusTagsLeaving = true, LeavingSoonMaintainerrUrl = "http://maintainerr.invalid:6246",
            LeavingSoonMaintainerrApiKey = "maintainerr-secret-key", LeavingSoonCollections = "Private Collection Name",
        });
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), fixture.Core.Paths.Object, fixture.Core.Logger);
        var controller = ApiAssetTests.Controller(fixture.Core, maintenance);
        var privateController = ApiAssetTests.Controller(fixture.Core, Mock.Of<IUserManager>());
        foreach (var c in new[] { controller, privateController })
        {
            c.HttpContext.User = new ClaimsPrincipal(authenticated
                ? new ClaimsIdentity([new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test")
                : new ClaimsIdentity());
        }

        foreach (var json in new[] { JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value), JsonSerializer.Serialize(Assert.IsType<JsonResult>(privateController.GetPrivateConfig()).Value) })
        {
            Assert.DoesNotContain("maintainerr-secret-key", json);
            Assert.DoesNotContain("maintainerr.invalid", json);
            Assert.DoesNotContain("Private Collection Name", json);
        }

        using var document = JsonDocument.Parse(JsonSerializer.Serialize(Assert.IsType<JsonResult>(controller.GetPublicConfig()).Value));
        Assert.True(document.RootElement.GetProperty("LeavingSoonAvailable").GetBoolean());
        Assert.True(document.RootElement.GetProperty("StatusTagsLeaving").GetBoolean());
        Assert.False(document.RootElement.GetProperty("StatusTagsDirectPlay").GetBoolean());
    }
}
