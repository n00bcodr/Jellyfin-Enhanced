using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>One of Maintainerr's collections as its <c>GET /api/collections</c> lists it.</summary>
    public sealed record MaintainerrCollection(int Id, string Title, string? LibraryId, string Type, bool IsActive, bool Manual, int? DeleteAfterDays, int? RadarrSettingsId, int? SonarrSettingsId);

    /// <summary>One of Maintainerr's Radarr or Sonarr servers (<c>GET /api/settings/radarr|sonarr</c>), with its key for the probe only.</summary>
    public sealed record MaintainerrArrServer(int Id, string Name, string Url, string ApiKey);

    /// <summary>What a resolution ended with: the collection, or why none fits.</summary>
    public sealed record MaintainerrMatch(MaintainerrCollection? Collection, string? Error)
    {
        public static MaintainerrMatch Of(MaintainerrCollection collection) => new(collection, null);
        public static MaintainerrMatch Fail(string error) => new(null, error);
    }

    /// <summary>The state of one item the item menu reads, and the answer of every action.</summary>
    public sealed class MaintainerrItemState
    {
        public string ItemId { get; init; } = string.Empty;
        public bool Marked { get; init; }
        public int? CollectionId { get; init; }
        public string? CollectionName { get; init; }
        public long? DeleteAt { get; init; }
        /// <summary>Whether the item is of a kind the actions handle (movies and series).</summary>
        public bool Supported { get; init; }
    }

    /// <summary>
    /// The administrator's Maintainerr actions: mark an item for removal (add it to the manual
    /// collection that fits it), keep it (remove it from its collection), postpone its removal
    /// or reset its timer. Every call goes through <see cref="MaintainerrHttp"/> (address guard,
    /// no redirects, timeouts, size cap, <c>X-Api-Key</c>) and ends with a forced Leaving soon
    /// refresh, so badges and the home row follow at once. The plugin never creates a
    /// collection: an item is matched to an existing manual collection of Maintainerr's by its
    /// library, then (several collections on one library) by the Radarr or Sonarr server that
    /// holds it, then by its type. The browser never sees the key, the addresses or the keys of
    /// the *arr servers Maintainerr knows.
    /// </summary>
    public sealed class MaintainerrActions
    {
        /// <summary>Longest postponement Maintainerr accepts (days).</summary>
        public const int MaxPostponeDays = 3650;

        private readonly IHttpClientFactory _http;
        private readonly ILibraryManager _library;
        private readonly LeavingSoonService _leaving;
        private readonly TagCacheService _cache;
        private readonly Logger _logger;
        private string? _loggedRedirectHost;

        /// <summary>The request timeout (tests shorten it).</summary>
        internal TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>
        /// Whether a Radarr/Sonarr server of Maintainerr's holds the item: by the movie's TMDB id or the series'
        /// TVDB id. Null when it could not say (unreachable, refused). Tests replace it.
        /// </summary>
        internal Func<MaintainerrArrServer, string, BaseItem, CancellationToken, Task<bool?>> ArrHolds { get; set; }

        public MaintainerrActions(IHttpClientFactory http, ILibraryManager library, LeavingSoonService leaving, TagCacheService cache, Logger logger)
        {
            _http = http;
            _library = library;
            _leaving = leaving;
            _cache = cache;
            _logger = logger;
            ArrHolds = ProbeArrAsync;
        }

        /// <summary>Whether the actions are on: the switch and a Maintainerr URL.</summary>
        public static bool Enabled(PluginConfiguration? config) => LeavingSoonSources.MaintainerrActionsEnabled(config);

        /// <summary>Maintainerr's type word for an item, or null for a kind the actions do not handle.</summary>
        public static string? MediaType(BaseItem item) => item switch
        {
            Movie => "movie",
            Series => "show",
            _ => null,
        };

        /// <summary>The item's state from the last read (cache-only; no Maintainerr call).</summary>
        public MaintainerrItemState State(BaseItem item, PluginConfiguration config, IReadOnlyList<MaintainerrCollection>? collections = null)
        {
            var fact = _leaving.Get(item.Id, config);
            var collectionId = _leaving.CollectionOf(item.Id, config);
            return new MaintainerrItemState
            {
                ItemId = item.Id.ToString("N"),
                Marked = fact != null && fact.Collections == null,
                CollectionId = collectionId,
                CollectionName = collectionId is { } id ? collections?.FirstOrDefault(c => c.Id == id)?.Title : null,
                DeleteAt = fact?.DeleteAt,
                Supported = MediaType(item) != null,
            };
        }

        /// <summary>
        /// Pick the manual collection for an item among <paramref name="collections"/>: active manual
        /// collections of the item's type on the item's library (<paramref name="libraryId"/>, N format);
        /// several of them are told apart by the *arr server that holds the item (<paramref name="servers"/>
        /// lists Maintainerr's servers of a kind, read only then; <paramref name="holds"/> answers true, false,
        /// or null when a server could not be asked). No fit, or more than one, fails with a reason naming the
        /// collections, so the administrator can see what Maintainerr has.
        /// </summary>
        internal static async Task<MaintainerrMatch> MatchAsync(BaseItem item, string? libraryId, IReadOnlyList<MaintainerrCollection> collections, Func<string, Task<IReadOnlyList<MaintainerrArrServer>>> servers, Func<MaintainerrArrServer, string, Task<bool?>> holds)
        {
            var type = MediaType(item);
            if (type == null) return MaintainerrMatch.Fail("Only movies and series can be marked.");
            var manual = collections.Where(c => c.IsActive && c.Manual).ToList();
            if (manual.Count == 0) return MaintainerrMatch.Fail("Maintainerr has no active manual collection. Create one (a rule with 'Use manual collection') and try again.");
            var typed = manual.Where(c => c.Type == type).ToList();
            if (typed.Count == 0) return MaintainerrMatch.Fail($"Maintainerr has no manual collection for {(type == "movie" ? "movies" : "shows")} (it has: {Names(manual)}).");
            var inLibrary = libraryId == null ? typed : typed.Where(c => c.LibraryId != null && string.Equals(c.LibraryId.Replace("-", string.Empty), libraryId, StringComparison.OrdinalIgnoreCase)).ToList();
            if (inLibrary.Count == 0) return MaintainerrMatch.Fail($"No Maintainerr manual collection is on this item's library (the {(type == "movie" ? "movie" : "show")} collections are: {Names(typed)}).");
            if (inLibrary.Count == 1) return MaintainerrMatch.Of(inLibrary[0]);

            // Several collections on one library: the one whose *arr server has the item.
            var known = await servers(type == "movie" ? "radarr" : "sonarr").ConfigureAwait(false);
            var owned = new List<MaintainerrCollection>();
            var unknown = false;
            foreach (var candidate in inLibrary)
            {
                var server = known.FirstOrDefault(s => s.Id == (type == "movie" ? candidate.RadarrSettingsId : candidate.SonarrSettingsId));
                if (server == null) { unknown = true; continue; }
                var answer = await holds(server, type).ConfigureAwait(false);
                if (answer == true) owned.Add(candidate);
                else if (answer == null) unknown = true;
            }

            if (owned.Count == 1) return MaintainerrMatch.Of(owned[0]);
            if (owned.Count > 1) return MaintainerrMatch.Fail($"Several Maintainerr collections fit this item ({Names(owned)}): more than one Radarr/Sonarr server has it.");
            return MaintainerrMatch.Fail(unknown
                ? $"Several Maintainerr collections fit this item ({Names(inLibrary)}) and their Radarr/Sonarr servers could not be asked which one holds it."
                : $"Several Maintainerr collections fit this item ({Names(inLibrary)}) but none of their Radarr/Sonarr servers has it.");
        }

        private static string Names(IEnumerable<MaintainerrCollection> collections) => string.Join(", ", collections.Select(c => c.Title));

        /// <summary>Add the item to the manual collection that fits it, then refresh the facts.</summary>
        public async Task<MaintainerrItemState> MarkAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            var type = MediaType(item) ?? throw new ActionException("Only movies and series can be marked.");
            var collections = await GetCollectionsAsync(config, token).ConfigureAwait(false);
            var existing = await MembershipAsync(item, config, token).ConfigureAwait(false);
            if (existing != null && collections.Any(c => c.Id == existing)) throw new ActionException("This item is already marked for removal.");
            var libraryId = ItemLibraryResolver.Resolve(_library, item);
            var match = await MatchAsync(item, libraryId, collections, kind => GetArrServersAsync(config, kind, token), (server, kind) => ArrHolds(server, kind, item, token)).ConfigureAwait(false);
            if (match.Collection == null) throw new ActionException(match.Error ?? "No Maintainerr collection fits this item.");
            await SendAsync(config, HttpMethod.Post, "/api/collections/media/add", new { action = 0, mediaId = item.Id.ToString("N"), context = new { id = item.Id.ToString("N"), type }, collectionId = match.Collection.Id }, token).ConfigureAwait(false);
            _logger.Info($"[Maintainerr] Marked '{item.Name}' for removal in collection '{match.Collection.Title}'.");
            return await AfterAsync(item, config, collections, token).ConfigureAwait(false);
        }

        /// <summary>Remove the item from its Maintainerr collection (Keep), then refresh the facts.</summary>
        public async Task<MaintainerrItemState> UnmarkAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            var type = MediaType(item) ?? throw new ActionException("Only movies and series can be kept.");
            var collections = await GetCollectionsAsync(config, token).ConfigureAwait(false);
            var collectionId = await MembershipAsync(item, config, token).ConfigureAwait(false);
            if (collectionId == null) throw new ActionException("This item is not marked for removal.");
            await SendAsync(config, HttpMethod.Post, "/api/collections/media/add", new { action = 1, mediaId = item.Id.ToString("N"), context = new { id = item.Id.ToString("N"), type }, collectionId }, token).ConfigureAwait(false);
            _logger.Info($"[Maintainerr] Kept '{item.Name}' (removed from collection {collectionId}).");
            return await AfterAsync(item, config, collections, token).ConfigureAwait(false);
        }

        /// <summary>
        /// Move the item's removal later by <paramref name="days"/> (1 to <see cref="MaxPostponeDays"/>), or
        /// restart its timer from today when null, then refresh the facts. Maintainerr never moves a removal
        /// sooner.
        /// </summary>
        public async Task<MaintainerrItemState> PostponeAsync(BaseItem item, int? days, PluginConfiguration config, CancellationToken token)
        {
            if (MediaType(item) == null) throw new ActionException("Only movies and series can be postponed.");
            if (days is { } d && (d < 1 || d > MaxPostponeDays)) throw new ActionException($"Days must be between 1 and {MaxPostponeDays}.");
            var collections = await GetCollectionsAsync(config, token).ConfigureAwait(false);
            var collectionId = await MembershipAsync(item, config, token).ConfigureAwait(false);
            if (collectionId == null) throw new ActionException("This item is not marked for removal.");
            object body = days is { } n ? new { collectionId, mediaId = item.Id.ToString("N"), days = n } : new { collectionId, mediaId = item.Id.ToString("N") };
            await SendAsync(config, HttpMethod.Post, "/api/collections/media/postpone", body, token).ConfigureAwait(false);
            _logger.Info(days is { } p ? $"[Maintainerr] Postponed '{item.Name}' by {p} days." : $"[Maintainerr] Reset the removal timer of '{item.Name}'.");
            return await AfterAsync(item, config, collections, token).ConfigureAwait(false);
        }

        /// <summary>Maintainerr's collections, now.</summary>
        public async Task<IReadOnlyList<MaintainerrCollection>> GetCollectionsAsync(PluginConfiguration config, CancellationToken token)
        {
            using var doc = await SendAsync(config, HttpMethod.Get, "/api/collections", null, token).ConfigureAwait(false);
            return ParseCollections(doc.RootElement);
        }

        /// <summary>Read <c>GET /api/collections</c> into the fields the resolver needs.</summary>
        internal static IReadOnlyList<MaintainerrCollection> ParseCollections(JsonElement root)
        {
            var list = root;
            if (root.ValueKind == JsonValueKind.Object)
            {
                list = default;
                foreach (var name in new[] { "data", "items", "collections", "results" })
                {
                    if (root.TryGetProperty(name, out var inner) && inner.ValueKind == JsonValueKind.Array) { list = inner; break; }
                }
            }

            if (list.ValueKind != JsonValueKind.Array) throw new JsonException("Expected a list of collections");
            var result = new List<MaintainerrCollection>();
            foreach (var c in list.EnumerateArray())
            {
                if (c.ValueKind != JsonValueKind.Object || !c.TryGetProperty("id", out var idProp) || !idProp.TryGetInt32(out var id)) continue;
                var type = c.TryGetProperty("type", out var t) ? t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "").Trim().ToLowerInvariant() : t.ValueKind == JsonValueKind.Number && t.TryGetInt32(out var n) ? n switch { 1 => "movie", 2 => "show", 3 => "season", 4 => "episode", _ => "unknown" } : "unknown" : "unknown";
                result.Add(new MaintainerrCollection(
                    id,
                    c.TryGetProperty("title", out var title) && title.ValueKind == JsonValueKind.String ? title.GetString() ?? ("Collection " + id) : "Collection " + id.ToString(CultureInfo.InvariantCulture),
                    c.TryGetProperty("libraryId", out var lib) && lib.ValueKind == JsonValueKind.String ? lib.GetString() : null,
                    type,
                    !(c.TryGetProperty("isActive", out var active) && active.ValueKind == JsonValueKind.False),
                    c.TryGetProperty("manualCollection", out var manual) && manual.ValueKind == JsonValueKind.True,
                    c.TryGetProperty("deleteAfterDays", out var days) && days.ValueKind == JsonValueKind.Number && days.TryGetInt32(out var dd) ? dd : null,
                    Int(c, "radarrSettingsId"),
                    Int(c, "sonarrSettingsId")));
            }

            return result;
        }

        private static int? Int(JsonElement obj, string name) => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

        private async Task<IReadOnlyList<MaintainerrArrServer>> GetArrServersAsync(PluginConfiguration config, string kind, CancellationToken token)
        {
            try
            {
                using var doc = await SendAsync(config, HttpMethod.Get, "/api/settings/" + kind, null, token).ConfigureAwait(false);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return Array.Empty<MaintainerrArrServer>();
                var servers = new List<MaintainerrArrServer>();
                foreach (var s in doc.RootElement.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object || Int(s, "id") is not { } id) continue;
                    var url = s.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String ? u.GetString() ?? "" : "";
                    var key = s.TryGetProperty("apiKey", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() ?? "" : "";
                    var name = s.TryGetProperty("serverName", out var sn) && sn.ValueKind == JsonValueKind.String ? sn.GetString() ?? kind : kind;
                    servers.Add(new MaintainerrArrServer(id, name, url.Trim().TrimEnd('/'), key));
                }

                return servers;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Warning($"[Maintainerr] Could not read the {kind} servers ({MaintainerrHttp.Describe(ex)}); collections on one library cannot be told apart.");
                return Array.Empty<MaintainerrArrServer>();
            }
        }

        /// <summary>
        /// Ask one of Maintainerr's Radarr/Sonarr servers whether it holds the item (<c>GET /api/v3/movie?tmdbId=</c>,
        /// <c>GET /api/v3/series?tvdbId=</c>), with the key Maintainerr gave. The address goes through the same guard
        /// as every *arr address. Null when the item has no such id or the server could not be asked.
        /// </summary>
        private async Task<bool?> ProbeArrAsync(MaintainerrArrServer server, string kind, BaseItem item, CancellationToken token)
        {
            var providerId = kind == "movie" ? item.GetProviderId(MetadataProvider.Tmdb) : item.GetProviderId(MetadataProvider.Tvdb);
            if (string.IsNullOrWhiteSpace(providerId) || !providerId.All(char.IsAsciiDigit) || server.Url.Length == 0) return null;
            var url = server.Url + (kind == "movie" ? "/api/v3/movie?tmdbId=" : "/api/v3/series?tvdbId=") + providerId;
            try
            {
                if (!await Shared.Arr.ArrUrlGuard.IsAllowedUrlAsync(url, token).ConfigureAwait(false)) return null;
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
                limit.CancelAfter(TimeSpan.FromSeconds(10));
                var client = _http.CreateClient(LeavingSoonService.ClientName);
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Accept.ParseAdd("application/json");
                if (server.ApiKey.Length > 0) request.Headers.TryAddWithoutValidation("X-Api-Key", server.ApiKey);
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) return null;
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(limit.Token).ConfigureAwait(false));
                return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.GetArrayLength() > 0 : doc.RootElement.ValueKind == JsonValueKind.Object;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
            {
                _logger.Warning($"[Maintainerr] Could not ask the {server.Name} server whether it holds '{item.Name}': {MaintainerrHttp.Describe(ex)}");
                return null;
            }
        }

        /// <summary>
        /// The collection holding the item: the last read's, or a fresh read's when that read does not list the
        /// item (marked since, in Maintainerr itself, or by an older snapshot without collection ids).
        /// </summary>
        private async Task<int?> MembershipAsync(BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            var known = _leaving.CollectionOf(item.Id, config);
            if (known != null) return known;
            await _leaving.RefreshAsync(config, force: true, token).ConfigureAwait(false);
            return _leaving.CollectionOf(item.Id, config);
        }

        private async Task<MaintainerrItemState> AfterAsync(BaseItem item, PluginConfiguration config, IReadOnlyList<MaintainerrCollection> collections, CancellationToken token)
        {
            try { await _cache.RefreshLeavingAsync(force: true, token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger.Warning($"[Maintainerr] The refresh after an action failed: {ex.Message}"); }
            return State(item, config, collections);
        }

        private async Task<JsonDocument> SendAsync(PluginConfiguration config, HttpMethod method, string path, object? body, CancellationToken token)
        {
            var baseUrl = MaintainerrHttp.BaseUrl(config) ?? throw new ActionException("No Maintainerr URL is set.");
            return await MaintainerrHttp.SendAsync(_http, config, method, baseUrl + path, body == null ? null : JsonSerializer.Serialize(body), Timeout, LogRedirect, token).ConfigureAwait(false);
        }

        private void LogRedirect(Uri from, Uri? location)
        {
            var host = location == null ? "(no location)" : !location.IsAbsoluteUri ? from.Host : location.Host;
            if (string.Equals(_loggedRedirectHost, host, StringComparison.OrdinalIgnoreCase)) return;
            _loggedRedirectHost = host;
            _logger.Warning($"[Maintainerr] Maintainerr answered with a redirect to host '{host}'; redirects are not followed, so set the Maintainerr URL to the final address.");
        }

        /// <summary>A refusal with a reason for the administrator (never the URL or key).</summary>
        public sealed class ActionException : Exception
        {
            public ActionException(string message) : base(message)
            {
            }
        }
    }
}
