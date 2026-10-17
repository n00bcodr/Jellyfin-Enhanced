using System.Globalization;
using System.Text.Json.Nodes;

namespace JE.Tests;

/// <summary>
/// A synthetic Seerr behind <see cref="IntegrationTransport"/> for the request read model: the
/// request list (paged, <c>sort=modified</c> newest change first, otherwise by id newest first as
/// Seerr's default <c>sort=added</c> does, <c>pageInfo.results</c>), movie and
/// series details, user list, call counting by path, optional request holds and a switchable failure.
/// </summary>
internal sealed class FakeSeerr : IDisposable
{
    public const string Url = "http://seerr.lan:5055";
    public const string Key = "SEERR-KEY-0123456789abcdef";

    /// <summary>The Seerr users returned by the paged user list.</summary>
    public List<JsonObject> Users { get; } = new();
    public List<JsonObject> Requests { get; } = new();
    public Dictionary<int, JsonObject> Movies { get; } = new();
    public Dictionary<int, JsonObject> Shows { get; } = new();
    public List<string> Calls { get; } = new();
    /// <summary>Non-zero: every call answers with this status.</summary>
    public int FailWith { get; set; }

    /// <summary>Runs before each page of the full request list (<c>sort=added</c>) with its skip: tests change the list between pages.</summary>
    public Action<int>? BeforePage { get; set; }

    /// <summary>Non-zero: the most rows a page of the request list holds, whatever <c>take</c> asked (a proxy or fork capping pages).</summary>
    public int PageCap { get; set; }

    /// <summary>Awaited before every answer (tests hold a call in flight).</summary>
    public Func<Task>? Hold { get; set; }

    public IntegrationTransport Transport { get; }

    /// <summary><c>/api/v1/settings/public</c> (lab Seerr shape: partial requests on, specials off, no 4K).</summary>
    public JsonObject Settings { get; set; } = new() { ["partialRequestsEnabled"] = true, ["enableSpecialEpisodes"] = false, ["movie4kEnabled"] = false, ["series4kEnabled"] = false };

    /// <summary><c>/api/v1/user/{id}/quota</c> by Seerr user id (default: no limits, nothing used).</summary>
    public Dictionary<int, JsonObject> Quotas { get; } = new();

    /// <summary>Request POSTs: the address's host, the <c>X-Api-User</c> header and the body.</summary>
    public List<(string Host, string? ApiUser, JsonObject Body)> Posts { get; } = new();

    /// <summary>Non-null: answers a request POST instead of the default (create, 409 duplicate, 202 no seasons).</summary>
    public Func<JsonObject, HttpResponseMessage?>? OnPost { get; set; }

    /// <summary>Non-null: runs after a request POST was applied; throw to lose the answer.</summary>
    public Action? AfterPost { get; set; }

    private int _nextRequest = 900;

    /// <summary><c>GET /api/v1/service/radarr|sonarr</c>: Seerr's servers of each kind (missing kind: none).</summary>
    public Dictionary<string, JsonArray> Services { get; } = new();

    /// <summary><c>GET /api/v1/service/{kind}/{id}</c> by <c>"{kind}/{id}"</c> (missing: 404).</summary>
    public Dictionary<string, JsonObject> ServiceDetails { get; } = new();

    /// <summary>
    /// How Seerr reaches each of its servers (<c>hostname</c>, <c>port</c>, <c>useSsl</c>, <c>baseUrl</c>, <c>apiKey</c>) by
    /// <c>"{kind}/{id}"</c>: only <c>GET /api/v1/settings/radarr|sonarr</c> (administrators) carries them, merged into the
    /// server rows of <see cref="Services"/>; a server without one gets <c>{kind}{id}.lan</c> and a fixed key.
    /// </summary>
    public Dictionary<string, JsonObject> Connections { get; } = new();

    /// <summary>True: a request POST is created without the server, profile and root folder it named (Seerr ignoring them).</summary>
    public bool DropAdvanced { get; set; }

    /// <summary>Non-null: the body of <c>GET /api/v1/settings/main</c> (else 404).</summary>
    public JsonObject? MainSettings { get; set; }

    /// <summary>Non-null: the body of <c>GET /api/v1/settings/jobs</c> (else 404).</summary>
    public JsonArray? Jobs { get; set; }

    /// <summary>Every non-GET call: method and path.</summary>
    public List<string> Writes { get; } = new();

    /// <summary>Non-null: awaited before every call is answered (a slow or hanging Seerr).</summary>
    public Func<Task>? Before { get => Hold; set => Hold = value; }

    /// <summary>Non-null: awaited for each request URI before it is answered.</summary>
    public Func<Uri, Task>? BeforeRequest { get; set; }

    public FakeSeerr()
    {
        Transport = new IntegrationTransport(async (request, _) =>
        {
            if (Hold is { } hold) await hold();
            if (BeforeRequest is { } beforeRequest) await beforeRequest(request.RequestUri!);
            return Answer(request);
        });
    }

    public int CallCount(string pathPart) { lock (Calls) return Calls.Count(c => c.Contains(pathPart, StringComparison.Ordinal)); }

    public static JsonObject Request(int id, string type, int tmdb, int status, Guid? user, DateTime created, DateTime? updated = null, int? tvdb = null, bool is4k = false, int[]? seasons = null, string? userName = null, int mediaStatus = 3)
        => new()
        {
            ["id"] = id,
            ["status"] = status,
            ["type"] = type,
            ["is4k"] = is4k,
            ["createdAt"] = created.ToString("o", CultureInfo.InvariantCulture),
            ["updatedAt"] = (updated ?? created).ToString("o", CultureInfo.InvariantCulture),
            ["media"] = new JsonObject { ["tmdbId"] = tmdb, ["tvdbId"] = tvdb, ["mediaType"] = type, ["status"] = mediaStatus, ["status4k"] = 1 },
            ["seasons"] = new JsonArray((seasons ?? Array.Empty<int>()).Select(s => (JsonNode)new JsonObject { ["seasonNumber"] = s }).ToArray()),
            ["requestedBy"] = new JsonObject { ["id"] = 7, ["jellyfinUserId"] = user?.ToString("N"), ["displayName"] = userName ?? "Seerr user " + id },
            ["modifiedBy"] = new JsonObject { ["id"] = 1, ["displayName"] = "Approver Name" },
        };

    private HttpResponseMessage Answer(HttpRequestMessage request)
    {
        var uri = request.RequestUri!;
        lock (Calls) Calls.Add(uri.PathAndQuery);
        if (FailWith != 0) return IntegrationTransport.Response("{\"message\":\"boom\"}", FailWith);
        var path = uri.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        if (request.Method != HttpMethod.Get)
        {
            lock (Writes) Writes.Add(request.Method + " " + path);
            if (path == "/api/v1/request" && request.Method == HttpMethod.Post) return Post(request);
            return IntegrationTransport.Response("{}");
        }
        if (path == "/api/v1/settings/public") return IntegrationTransport.Response(Settings.ToJsonString());
        if (path.StartsWith("/api/v1/user/", StringComparison.Ordinal))
        {
            var rest = path["/api/v1/user/".Length..];
            var quota = rest.EndsWith("/quota", StringComparison.Ordinal);
            if (!int.TryParse(quota ? rest[..^"/quota".Length] : rest, out var userId)) return IntegrationTransport.Response("{}", 404);
            if (quota) return IntegrationTransport.Response((Quotas.GetValueOrDefault(userId) ?? new JsonObject { ["movie"] = new JsonObject { ["used"] = 0, ["restricted"] = false }, ["tv"] = new JsonObject { ["used"] = 0, ["restricted"] = false } }).ToJsonString());
            lock (Users)
            {
                var user = Users.FirstOrDefault(u => (int?)u["id"] == userId);
                return user == null ? IntegrationTransport.Response("{\"message\":\"User not found.\"}", 404) : IntegrationTransport.Response(user.ToJsonString());
            }
        }
        if (path.StartsWith("/api/v1/service/", StringComparison.Ordinal))
        {
            var rest = path["/api/v1/service/".Length..];
            if (!rest.Contains('/')) return IntegrationTransport.Response((Services.GetValueOrDefault(rest) ?? new JsonArray()).ToJsonString());
            return ServiceDetails.TryGetValue(rest, out var detail) ? IntegrationTransport.Response(detail.ToJsonString()) : IntegrationTransport.Response("{\"message\":\"Not found\"}", 404);
        }
        if (path is "/api/v1/settings/radarr" or "/api/v1/settings/sonarr")
        {
            var kind = path["/api/v1/settings/".Length..];
            var rows = (Services.GetValueOrDefault(kind) ?? new JsonArray()).Select(row =>
            {
                var full = row!.DeepClone().AsObject();
                var id = (int)full["id"]!;
                var connection = Connections.GetValueOrDefault(kind + "/" + id) ?? new JsonObject { ["hostname"] = kind + id + ".lan", ["port"] = kind == "radarr" ? 7878 : 8989, ["useSsl"] = false, ["baseUrl"] = "", ["apiKey"] = kind.ToUpperInvariant() + "-KEY-" + id };
                foreach (var (name, value) in connection) full[name] = value?.DeepClone();
                return (JsonNode)full;
            }).ToArray();
            return IntegrationTransport.Response(new JsonArray(rows).ToJsonString());
        }
        if (path == "/api/v1/settings/main") return MainSettings == null ? IntegrationTransport.Response("{}", 404) : IntegrationTransport.Response(MainSettings.ToJsonString());
        if (path == "/api/v1/settings/jobs") return Jobs == null ? IntegrationTransport.Response("{}", 404) : IntegrationTransport.Response(Jobs.ToJsonString());
        if (path == "/api/v1/user")
        {
            var take = int.Parse(query["take"] ?? "10", CultureInfo.InvariantCulture);
            var skip = int.Parse(query["skip"] ?? "0", CultureInfo.InvariantCulture);
            lock (Users)
            {
                return IntegrationTransport.Response(new JsonObject
                {
                    ["pageInfo"] = new JsonObject { ["pages"] = (Users.Count + take - 1) / take, ["pageSize"] = take, ["results"] = Users.Count, ["page"] = skip / take + 1 },
                    ["results"] = new JsonArray(Users.Skip(skip).Take(take).Select(u => u.DeepClone()).ToArray()),
                }.ToJsonString());
            }
        }
        if (path == "/api/v1/request")
        {
            var take = int.Parse(query["take"] ?? "10", CultureInfo.InvariantCulture);
            var skip = int.Parse(query["skip"] ?? "0", CultureInfo.InvariantCulture);
            if (PageCap > 0) take = Math.Min(take, PageCap);
            if (query["sort"] != "modified") BeforePage?.Invoke(skip);
            if (FailWith != 0) return IntegrationTransport.Response("{\"message\":\"boom\"}", FailWith);
            List<JsonObject> all;
            lock (Requests)
            {
                all = query["sort"] == "modified"
                    ? Requests.OrderByDescending(r => (string)r["updatedAt"]!).ToList()
                    : Requests.OrderByDescending(r => (int)r["id"]!).ToList();
            }
            var page = all.Skip(skip).Take(take).Select(r => r.DeepClone()).ToArray();
            return IntegrationTransport.Response(new JsonObject
            {
                ["pageInfo"] = new JsonObject { ["pages"] = (all.Count + take - 1) / take, ["pageSize"] = take, ["results"] = all.Count, ["page"] = skip / take + 1 },
                ["results"] = new JsonArray(page),
            }.ToJsonString());
        }
        foreach (var (prefix, map) in new[] { ("/api/v1/movie/", Movies), ("/api/v1/tv/", Shows) })
        {
            if (path.StartsWith(prefix, StringComparison.Ordinal) && int.TryParse(path[prefix.Length..], out var id))
                return map.TryGetValue(id, out var details) ? IntegrationTransport.Response(details.ToJsonString()) : IntegrationTransport.Response("{\"message\":\"Unable to retrieve\"}", 404);
        }
        return IntegrationTransport.Response("{}", 404);
    }

    // Like Seerr's POST /api/v1/request: a duplicate movie request is a 409 with a JSON message, a series
    // request whose seasons are all requested (or already processing or available) is a 202 "No seasons
    // available to request", and otherwise only the other seasons go into the new request (lab spike, 2026-10-14).
    private HttpResponseMessage Post(HttpRequestMessage request)
    {
        var body = JsonNode.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!.AsObject();
        var user = request.Headers.TryGetValues("X-Api-User", out var values) ? values.First() : null;
        lock (Posts) Posts.Add((request.RequestUri!.Host, user, body));
        if (OnPost?.Invoke(body) is { } answer) return answer;
        var movie = (string?)body["mediaType"] == "movie";
        var tmdb = (int)body["mediaId"]!;
        var is4k = (bool)body["is4k"]!;
        var map = movie ? Movies : Shows;
        if (!map.TryGetValue(tmdb, out var details)) map[tmdb] = details = new JsonObject { ["id"] = tmdb };
        if (details["mediaInfo"] is not JsonObject media) details["mediaInfo"] = media = new JsonObject { ["status"] = 2, ["status4k"] = 1, ["requests"] = new JsonArray(), ["seasons"] = new JsonArray() };
        var existing = media["requests"]!.AsArray().Where(r => (bool)r!["is4k"]! == is4k && (int)r["status"]! != 3).ToList();
        int[] seasons = Array.Empty<int>();
        if (movie && existing.Count > 0) return IntegrationTransport.Response("{\"message\":\"Request for this media already exists.\"}", 409);
        if (!movie)
        {
            // Like Seerr (MediaRequest.request): seasons of its open requests (not declined or completed), and seasons the
            // media already knows (any status but unknown, 1, or deleted, 7), aren't requested again.
            var taken = existing.Where(r => (int)r!["status"]! != 5).SelectMany(r => r!["seasons"]!.AsArray().Select(x => (int)x!["seasonNumber"]!)).ToHashSet();
            foreach (var known in (media["seasons"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                if (known[is4k ? "status4k" : "status"] is { } status && (int)status! is not (1 or 7) && known["seasonNumber"] is { } number) taken.Add((int)number!);
            seasons = body["seasons"]!.AsArray().Select(x => (int)x!).Where(n => !taken.Contains(n)).ToArray();
            if (seasons.Length == 0) return IntegrationTransport.Response("{\"message\":\"No seasons available to request\"}", 202);
        }
        var id = Interlocked.Increment(ref _nextRequest);
        var row = new JsonObject
        {
            ["id"] = id, ["status"] = 1, ["type"] = movie ? "movie" : "tv", ["is4k"] = is4k,
            ["requestedBy"] = new JsonObject { ["id"] = int.TryParse(user, out var u) ? u : 1 },
            ["seasons"] = new JsonArray(seasons.Select(n => (JsonNode)new JsonObject { ["seasonNumber"] = n, ["status"] = 1 }).ToArray()),
        };
        // Like Seerr: the request keeps the server, profile and root folder it was made with.
        foreach (var field in new[] { "serverId", "profileId", "rootFolder" })
            if (!DropAdvanced && body[field] is { } value) row[field] = value.DeepClone();
        media["requests"]!.AsArray().Add(row);
        AfterPost?.Invoke();
        return IntegrationTransport.Response(row.ToJsonString(), 201);
    }

    public void Dispose() => Transport.Dispose();
}
