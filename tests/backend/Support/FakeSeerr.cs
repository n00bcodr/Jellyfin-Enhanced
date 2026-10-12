using System.Globalization;
using System.Text.Json.Nodes;

namespace JE.Tests;

/// <summary>
/// A synthetic Seerr behind <see cref="IntegrationTransport"/> for the request read model: the
/// request list (paged, <c>sort=modified</c> newest change first, otherwise by id newest first as
/// Seerr's default <c>sort=added</c> does, <c>pageInfo.results</c>), movie and
/// series details, call counting by path and a switchable failure.
/// </summary>
internal sealed class FakeSeerr : IDisposable
{
    public const string Url = "http://seerr.lan:5055";
    public const string Key = "SEERR-KEY-0123456789abcdef";

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

    public FakeSeerr()
    {
        Transport = new IntegrationTransport(async (request, _) =>
        {
            if (Hold is { } hold) await hold();
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

    public void Dispose() => Transport.Dispose();
}
