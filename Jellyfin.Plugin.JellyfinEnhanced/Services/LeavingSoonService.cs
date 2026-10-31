using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Leaving soon facts (Status group): which library items Maintainerr will delete and
    /// when, from its REST API (<c>GET /api/collections</c>, <c>addDate + deleteAfterDays</c>
    /// per item), and which items are in the administrator's leaving collections (existing
    /// Jellyfin collections by name, no date). Only the refresh (the scheduled task, a
    /// configuration change or the admin page's Refresh) does any work; card and poster
    /// reads are cache-only. A failed Maintainerr request keeps the last good answer and
    /// retries with a growing delay (15 minutes, doubling, at most the refresh interval).
    /// The API key is sent as <c>X-Api-Key</c> and is never logged, persisted here or
    /// handed to clients. Redirects are never followed (<see cref="ClientName"/>): a 3xx
    /// answer is a failed refresh, so the key only ever goes to the configured origin,
    /// whose address the URL guard checked.
    /// </summary>
    public sealed class LeavingSoonService
    {
        /// <summary>The named HttpClient for Maintainerr: automatic redirects off (see <see cref="AddHttpClient"/>).</summary>
        public const string ClientName = "JellyfinEnhanced.Maintainerr";
        /// <summary>Most collection names the fallback list takes.</summary>
        public const int MaxCollectionNames = 20;
        /// <summary>Longest collection name the fallback list takes.</summary>
        public const int MaxCollectionNameLength = 200;
        /// <summary>Largest Maintainerr answer read (bytes).</summary>
        internal const int MaxResponseBytes = 16 * 1024 * 1024;
        /// <summary>First retry delay after a failed Maintainerr request.</summary>
        internal static readonly TimeSpan FirstRetry = TimeSpan.FromMinutes(15);
        private const long DayMs = 86_400_000L;

        private readonly IHttpClientFactory _http;
        private readonly ILibraryManager? _library;
        private readonly Logger _logger;
        private readonly string _path;
        private readonly SemaphoreSlim _refresh = new(1, 1);
        private readonly object _sync = new();
        private Snapshot _snapshot = new();
        private string? _loggedRedirectHost;

        /// <summary>The clock (tests replace it).</summary>
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        /// <summary>The request timeout (tests shorten it).</summary>
        internal TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

        public LeavingSoonService(IHttpClientFactory http, IApplicationPaths paths, ILibraryManager library, Logger logger)
            : this(http, Path.Combine(paths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "leaving-soon.json"), library, logger)
        {
        }

        /// <summary>A service over an explicit snapshot file (tests).</summary>
        internal LeavingSoonService(IHttpClientFactory http, string path, ILibraryManager? library, Logger logger)
        {
            _http = http;
            _library = library;
            _logger = logger;
            _path = path;
            try
            {
                if (!File.Exists(_path)) return;
                var disk = JsonSerializer.Deserialize<Snapshot>(File.ReadAllText(_path));
                if (disk?.Schema == 1) _snapshot = disk;
            }
            catch (Exception ex) { _logger.Warning($"[LeavingSoon] Could not read snapshot: {ex.Message}"); }
        }

        /// <summary>
        /// Register <see cref="ClientName"/>: a client that never follows a redirect, so the
        /// <c>X-Api-Key</c> header cannot be carried to another origin or to an address the
        /// URL guard never checked.
        /// </summary>
        public static IHttpClientBuilder AddHttpClient(IServiceCollection services)
            => services.AddHttpClient(ClientName).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });

        /// <summary>Whether a source is set: a usable Maintainerr URL or at least one collection name.</summary>
        public static bool Configured(PluginConfiguration? config)
            => config != null && (IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl) || CollectionNames(config.LeavingSoonCollections).Count > 0);

        /// <summary>An absolute http(s) base URL without credentials, query or fragment (empty is not one).</summary>
        public static bool IsMaintainerrUrl(string? url)
        {
            if (string.IsNullOrWhiteSpace(url) || url.Length > 512) return false;
            if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return false;
            return (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment)
                && !string.IsNullOrEmpty(uri.Host);
        }

        /// <summary>The fallback collection names: one per line or comma separated, trimmed, distinct (case-insensitive), bounded.</summary>
        public static IReadOnlyList<string> CollectionNames(string? text)
        {
            if (string.IsNullOrWhiteSpace(text)) return Array.Empty<string>();
            return text.Split(new[] { '\n', '\r', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.Length is > 0 and <= MaxCollectionNameLength)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxCollectionNames)
                .ToArray();
        }

        /// <summary>Whether a fallback list is acceptable as typed: every name within bounds and at most <see cref="MaxCollectionNames"/>.</summary>
        public static bool IsCollectionList(string? text)
        {
            if (text == null) return false;
            var names = text.Split(new[] { '\n', '\r', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(n => n.Length > 0).ToArray();
            return names.All(n => n.Length <= MaxCollectionNameLength) && names.Distinct(StringComparer.OrdinalIgnoreCase).Count() <= MaxCollectionNames;
        }

        /// <summary>What the facts depend on: the URL, key and names. Only a digest is kept.</summary>
        internal static string Signature(PluginConfiguration config) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            (IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl) ? config.LeavingSoonMaintainerrUrl.Trim().TrimEnd('/') : string.Empty)
            + "\n" + (config.LeavingSoonMaintainerrApiKey ?? string.Empty).Trim()
            + "\n" + string.Join("\n", CollectionNames(config.LeavingSoonCollections).Select(n => n.ToLowerInvariant()).Order(StringComparer.Ordinal)))));

        /// <summary>Only a source change needs a refresh on an admin save.</summary>
        internal static string ConfigurationIdentity(PluginConfiguration? config) => config == null || !Configured(config) ? string.Empty : Signature(config);

        /// <summary>The facts for one item under the current configuration (cache-only), or null.</summary>
        public TagLeaving? Get(Guid itemId, PluginConfiguration? config)
        {
            if (itemId == Guid.Empty || !Configured(config)) return null;
            var signature = Signature(config!);
            lock (_sync)
            {
                if (_snapshot.Signature != signature) return null;
                return Lookup(_snapshot, itemId.ToString("N"));
            }
        }

        /// <summary>
        /// An item's facts with its Season's and Series' (a Season/Episode leaves with them):
        /// the earliest known date wins, and any date wins over none.
        /// </summary>
        public TagLeaving? Resolve(Guid itemId, Guid? seasonId, Guid? seriesId, PluginConfiguration? config)
        {
            var own = Get(itemId, config);
            var season = seasonId is { } s ? Get(s, config) : null;
            var series = seriesId is { } p ? Get(p, config) : null;
            return Earliest(Earliest(own, season), series);
        }

        /// <summary>The leaving of two that comes first: a dated one before an undated one.</summary>
        internal static TagLeaving? Earliest(TagLeaving? a, TagLeaving? b)
        {
            if (a == null) return b;
            if (b == null) return a;
            if (a.DeleteAt is { } x && b.DeleteAt is { } y) return x <= y ? a : b;
            return a.DeleteAt != null ? a : b;
        }

        /// <summary>A copy of the current item map (N-format id → delete time), for publishing to the cache.</summary>
        internal IReadOnlyDictionary<string, long?> Items(PluginConfiguration? config)
        {
            if (!Configured(config)) return new Dictionary<string, long?>();
            var signature = Signature(config!);
            lock (_sync)
            {
                return _snapshot.Signature != signature ? new Dictionary<string, long?>() : Merge(_snapshot);
            }
        }

        /// <summary>What the admin page shows: counts, times and the last failure (never the URL or key).</summary>
        public LeavingSoonStatus Status(PluginConfiguration? config)
        {
            lock (_sync)
            {
                var current = config != null && Configured(config) && _snapshot.Signature == Signature(config);
                var merged = current ? Merge(_snapshot) : new Dictionary<string, long?>();
                return new LeavingSoonStatus
                {
                    Configured = Configured(config),
                    Maintainerr = config != null && IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl),
                    Collections = config == null ? 0 : CollectionNames(config.LeavingSoonCollections).Count,
                    Items = merged.Count,
                    Dated = merged.Count(p => p.Value != null),
                    CollectionsFound = current ? _snapshot.CollectionsFound : 0,
                    LastSuccess = current ? _snapshot.LastSuccess : null,
                    LastAttempt = current ? _snapshot.LastAttempt : null,
                    NextRefresh = current ? _snapshot.NextRefresh : null,
                    LastError = current ? _snapshot.LastError : null,
                };
            }
        }

        /// <summary>
        /// Refresh when due (or always, with <paramref name="force"/>): Maintainerr when a URL is
        /// set, then the collection names. A part that fails keeps its previous answer. Returns
        /// whether the published item map changed.
        /// </summary>
        public async Task<bool> RefreshAsync(PluginConfiguration config, bool force, CancellationToken token)
        {
            await _refresh.WaitAsync(token).ConfigureAwait(false);
            try
            {
                Snapshot before;
                lock (_sync) before = _snapshot;
                if (!Configured(config))
                {
                    if (before.Api.Count == 0 && before.Named.Count == 0 && before.Signature.Length == 0) return false;
                    lock (_sync) _snapshot = new Snapshot();
                    Save();
                    return Merge(before).Count > 0;
                }

                var signature = Signature(config);
                var now = Now().ToUnixTimeMilliseconds();
                var sameSource = before.Signature == signature;
                if (!force && sameSource && before.NextRefresh is { } due && now < due) return false;

                var next = new Snapshot { Signature = signature, LastAttempt = now, Failures = sameSource ? before.Failures : 0 };
                string? error = null;
                if (IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl))
                {
                    try
                    {
                        next.Api = await FetchMaintainerrAsync(config, token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch (Exception ex)
                    {
                        error = Describe(ex);
                        // Never log the request: the URL may carry a token-bearing path and the key is in a header.
                        _logger.Warning($"[LeavingSoon] Maintainerr refresh failed ({error}); keeping the previous answer.");
                        next.Api = sameSource ? before.Api : new Dictionary<string, long?>();
                    }
                }

                var names = CollectionNames(config.LeavingSoonCollections);
                if (names.Count > 0)
                {
                    try
                    {
                        (next.Named, next.CollectionsFound) = ReadCollections(names);
                    }
                    catch (Exception ex)
                    {
                        error ??= "collections could not be read";
                        _logger.Warning($"[LeavingSoon] Reading the leaving collections failed: {ex.Message}");
                        next.Named = sameSource ? before.Named : new HashSet<string>(StringComparer.Ordinal);
                        next.CollectionsFound = sameSource ? before.CollectionsFound : 0;
                    }
                }

                var cadence = TimeSpan.FromHours(Math.Clamp(config.LeavingSoonRefreshHours, 1, 168));
                if (error == null)
                {
                    next.Failures = 0;
                    next.LastSuccess = now;
                    next.NextRefresh = now + (long)cadence.TotalMilliseconds;
                }
                else
                {
                    next.Failures = Math.Min(next.Failures + 1, 16);
                    next.LastSuccess = sameSource ? before.LastSuccess : null;
                    next.LastError = error;
                    next.NextRefresh = now + (long)RetryDelay(next.Failures, cadence).TotalMilliseconds;
                }

                lock (_sync) _snapshot = next;
                Save();
                return !SameItems(sameSource ? Merge(before) : new Dictionary<string, long?>(), Merge(next)) || !sameSource;
            }
            finally
            {
                _refresh.Release();
            }
        }

        /// <summary>The wait after the <paramref name="failures"/>th failure in a row: 15 minutes, doubling, at most the cadence.</summary>
        internal static TimeSpan RetryDelay(int failures, TimeSpan cadence)
        {
            var delay = FirstRetry * Math.Pow(2, Math.Clamp(failures - 1, 0, 10));
            return delay < cadence ? delay : cadence;
        }

        /// <summary>A short reason for the admin page, without the URL or key.</summary>
        private static string Describe(Exception ex) => ex switch
        {
            HttpRequestException { StatusCode: { } code } => "HTTP " + ((int)code).ToString(CultureInfo.InvariantCulture),
            HttpRequestException => "not reachable",
            TaskCanceledException or TimeoutException => "timed out",
            JsonException => "not a Maintainerr collections answer",
            InvalidDataException => "answer too large",
            UnauthorizedAccessException => "address not allowed",
            RedirectException => "redirected (redirects are not followed)",
            _ => "request failed",
        };

        private async Task<Dictionary<string, long?>> FetchMaintainerrAsync(PluginConfiguration config, CancellationToken token)
        {
            var baseUrl = config.LeavingSoonMaintainerrUrl.Trim().TrimEnd('/');
            var url = baseUrl + "/api/collections";
            if (!await Helpers.ArrUrlGuard.IsAllowedUrlAsync(url, token).ConfigureAwait(false)) throw new UnauthorizedAccessException();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(Timeout);
            var client = _http.CreateClient(ClientName);
            var target = new Uri(url);
            using var request = new HttpRequestMessage(HttpMethod.Get, target);
            request.Headers.Accept.ParseAdd("application/json");
            var key = (config.LeavingSoonMaintainerrApiKey ?? string.Empty).Trim();
            if (key.Length > 0) request.Headers.TryAddWithoutValidation("X-Api-Key", key);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                LogRedirect(target, response.Headers.Location);
                throw new RedirectException();
            }

            // A client that followed a redirect anyway (not ClientName's) answered for another address: refuse it.
            if (response.RequestMessage?.RequestUri is { } answered && answered != target) throw new RedirectException();
            if (!response.IsSuccessStatusCode) throw new HttpRequestException("Maintainerr answered " + (int)response.StatusCode, null, response.StatusCode);
            if (response.Content.Headers.ContentLength > MaxResponseBytes) throw new InvalidDataException();
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, timeout.Token).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxResponseBytes) throw new InvalidDataException();
                buffer.Write(chunk, 0, read);
            }

            using var document = JsonDocument.Parse(buffer.ToArray());
            var parsed = ParseCollections(document.RootElement);
            return ToItems(parsed, TmdbLookup);
        }

        /// <summary>A 3xx answer: never followed.</summary>
        private sealed class RedirectException : Exception
        {
        }

        /// <summary>
        /// Say once per destination host where a redirect pointed (the host only: a path or
        /// query may carry a token, and the key is never logged).
        /// </summary>
        private void LogRedirect(Uri from, Uri? location)
        {
            var host = location == null ? "(no location)" : !location.IsAbsoluteUri ? from.Host : location.Host;
            if (string.Equals(_loggedRedirectHost, host, StringComparison.OrdinalIgnoreCase)) return;
            _loggedRedirectHost = host;
            _logger.Warning($"[LeavingSoon] Maintainerr answered with a redirect to host '{host}'; redirects are not followed, so set the Maintainerr URL to the final address.");
        }

        /// <summary>One Maintainerr collection member: its Jellyfin id (when the answer has one), TMDB id and type, and delete time.</summary>
        internal sealed record MaintainerrMember(Guid? ItemId, string? TmdbId, string Type, long? DeleteAt);

        /// <summary>
        /// Read <c>GET /api/collections</c>: an array of collections (or one wrapped in
        /// <c>data</c>/<c>items</c>/<c>collections</c>), each with <c>isActive</c>,
        /// <c>deleteAfterDays</c>, <c>type</c> and <c>media</c> (<c>mediaServerId</c> or
        /// <c>plexId</c>, <c>tmdbId</c>, <c>addDate</c>). Inactive collections are skipped; a
        /// member without a usable date (or a collection without <c>deleteAfterDays</c>)
        /// leaves undated. Anything else about the shape is refused with <see cref="JsonException"/>.
        /// </summary>
        internal static IReadOnlyList<MaintainerrMember> ParseCollections(JsonElement root)
        {
            var collections = root;
            if (root.ValueKind == JsonValueKind.Object)
            {
                collections = default;
                foreach (var name in new[] { "data", "items", "collections", "results" })
                {
                    if (root.TryGetProperty(name, out var inner) && inner.ValueKind == JsonValueKind.Array) { collections = inner; break; }
                }
            }

            if (collections.ValueKind != JsonValueKind.Array) throw new JsonException("Expected a list of collections");
            var members = new List<MaintainerrMember>();
            foreach (var collection in collections.EnumerateArray())
            {
                if (collection.ValueKind != JsonValueKind.Object) continue;
                if (collection.TryGetProperty("isActive", out var active) && active.ValueKind == JsonValueKind.False) continue;
                int? days = collection.TryGetProperty("deleteAfterDays", out var d) && d.ValueKind == JsonValueKind.Number && d.TryGetInt32(out var n) && n is >= 0 and <= 36500 ? n : null;
                var type = CollectionType(collection);
                JsonElement media = default;
                foreach (var name in new[] { "media", "collectionMedia" })
                {
                    if (collection.TryGetProperty(name, out var m) && m.ValueKind == JsonValueKind.Array) { media = m; break; }
                }

                if (media.ValueKind != JsonValueKind.Array) continue;
                foreach (var item in media.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    Guid? id = null;
                    foreach (var name in new[] { "mediaServerId", "jellyfinId", "plexId" })
                    {
                        if (item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && Guid.TryParse(v.GetString(), out var g) && g != Guid.Empty) { id = g; break; }
                    }

                    string? tmdb = null;
                    if (item.TryGetProperty("tmdbId", out var t) && t.ValueKind is JsonValueKind.Number or JsonValueKind.String)
                    {
                        var text = t.ToString();
                        if (text.Length is > 0 and < 12 && text.All(char.IsAsciiDigit) && text != "0") tmdb = text;
                    }

                    if (id == null && tmdb == null) continue;
                    long? deleteAt = null;
                    if (days != null && item.TryGetProperty("addDate", out var added) && TryReadDate(added, out var addedAt))
                    {
                        deleteAt = addedAt.ToUnixTimeMilliseconds() + days.Value * DayMs;
                    }

                    members.Add(new MaintainerrMember(id, tmdb, type, deleteAt));
                }
            }

            return members;
        }

        /// <summary>movie, show, season or episode, from Maintainerr's text or numeric (Plex data type) form.</summary>
        private static string CollectionType(JsonElement collection)
        {
            if (!collection.TryGetProperty("type", out var type)) return "unknown";
            if (type.ValueKind == JsonValueKind.Number && type.TryGetInt32(out var number))
            {
                return number switch { 1 => "movie", 2 => "show", 3 => "season", 4 => "episode", _ => "unknown" };
            }

            var text = type.ValueKind == JsonValueKind.String ? type.GetString()?.Trim().ToLowerInvariant() : null;
            return text switch { "movie" or "movies" => "movie", "show" or "shows" or "tv" or "series" => "show", "season" or "seasons" => "season", "episode" or "episodes" => "episode", _ => "unknown" };
        }

        /// <summary>An ISO 8601 date-time (UTC unless it says otherwise) or Unix milliseconds.</summary>
        internal static bool TryReadDate(JsonElement value, out DateTimeOffset date)
        {
            date = default;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var ms) && ms > 0)
            {
                date = DateTimeOffset.FromUnixTimeMilliseconds(ms);
                return true;
            }

            return value.ValueKind == JsonValueKind.String
                && DateTimeOffset.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out date);
        }

        /// <summary>
        /// Members to items: a Jellyfin id as it is; otherwise (a Plex-backed Maintainerr) a
        /// movie or show by its TMDB id, through <paramref name="tmdbLookup"/>.
        /// </summary>
        internal static Dictionary<string, long?> ToItems(IReadOnlyList<MaintainerrMember> members, Func<string, string, IReadOnlyList<Guid>>? tmdbLookup)
        {
            var items = new Dictionary<string, long?>(StringComparer.Ordinal);
            void Add(Guid id, long? at)
            {
                var key = id.ToString("N");
                items[key] = items.TryGetValue(key, out var old) ? Earliest(new TagLeaving { DeleteAt = old }, new TagLeaving { DeleteAt = at })!.DeleteAt : at;
            }

            foreach (var member in members)
            {
                if (member.ItemId is { } id) { Add(id, member.DeleteAt); continue; }
                if (tmdbLookup == null || member.TmdbId == null || member.Type is not ("movie" or "show")) continue;
                foreach (var found in tmdbLookup(member.Type, member.TmdbId)) Add(found, member.DeleteAt);
            }

            return items;
        }

        private Dictionary<string, List<Guid>>? _tmdbIndex;

        /// <summary>Library movies/series by TMDB id, read once per refresh when a member needs it.</summary>
        private IReadOnlyList<Guid> TmdbLookup(string type, string tmdb)
        {
            if (_library == null) return Array.Empty<Guid>();
            _tmdbIndex ??= _library.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                Recursive = true,
                IsVirtualItem = false,
            }).Select(i => (Key: (i.GetBaseItemKind() == BaseItemKind.Series ? "show:" : "movie:") + i.GetProviderId(MetadataProvider.Tmdb), i.Id))
              .Where(p => !p.Key.EndsWith(':'))
              .GroupBy(p => p.Key, StringComparer.Ordinal)
              .ToDictionary(g => g.Key, g => g.Select(p => p.Id).ToList(), StringComparer.Ordinal);
            return _tmdbIndex.TryGetValue(type + ":" + tmdb, out var ids) ? ids : Array.Empty<Guid>();
        }

        /// <summary>The members (N-format ids) of the existing collections with these names, and how many collections matched.</summary>
        private (HashSet<string> Members, int Found) ReadCollections(IReadOnlyList<string> names)
        {
            var members = new HashSet<string>(StringComparer.Ordinal);
            if (_library == null) return (members, 0);
            var wanted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
            var found = 0;
            foreach (var boxSet in _library.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.BoxSet }, Recursive = true }))
            {
                if (boxSet is not Folder folder || boxSet.Name == null || !wanted.Contains(boxSet.Name.Trim())) continue;
                found++;
                foreach (var child in folder.GetLinkedChildren())
                {
                    if (child != null) members.Add(child.Id.ToString("N"));
                }
            }

            return (members, found);
        }

        /// <summary>Maintainerr's dated answer over the undated collection members.</summary>
        private static Dictionary<string, long?> Merge(Snapshot snapshot)
        {
            var merged = new Dictionary<string, long?>(snapshot.Api, StringComparer.Ordinal);
            foreach (var id in snapshot.Named) merged.TryAdd(id, null);
            return merged;
        }

        private static TagLeaving? Lookup(Snapshot snapshot, string key)
        {
            if (snapshot.Api.TryGetValue(key, out var at)) return new TagLeaving { DeleteAt = at };
            return snapshot.Named.Contains(key) ? new TagLeaving() : null;
        }

        private static bool SameItems(IReadOnlyDictionary<string, long?> a, IReadOnlyDictionary<string, long?> b)
            => a.Count == b.Count && a.All(p => b.TryGetValue(p.Key, out var v) && v == p.Value);

        private void Save()
        {
            _tmdbIndex = null;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                lock (_sync)
                {
                    File.WriteAllText(_path + ".tmp", JsonSerializer.Serialize(_snapshot));
                    File.Move(_path + ".tmp", _path, overwrite: true);
                }
            }
            catch (Exception ex) { _logger.Warning($"[LeavingSoon] Could not save snapshot: {ex.Message}"); }
        }

        /// <summary>The persisted answer. Holds a digest of the source, never the URL or key.</summary>
        public sealed class Snapshot
        {
            public int Schema { get; set; } = 1;
            public string Signature { get; set; } = string.Empty;
            public Dictionary<string, long?> Api { get; set; } = new(StringComparer.Ordinal);
            public HashSet<string> Named { get; set; } = new(StringComparer.Ordinal);
            public int CollectionsFound { get; set; }
            public long? LastSuccess { get; set; }
            public long? LastAttempt { get; set; }
            public long? NextRefresh { get; set; }
            public int Failures { get; set; }
            public string? LastError { get; set; }
        }
    }

    /// <summary>The Leaving soon source state the admin page shows.</summary>
    public sealed class LeavingSoonStatus
    {
        public bool Configured { get; init; }
        public bool Maintainerr { get; init; }
        public int Collections { get; init; }
        public int CollectionsFound { get; init; }
        public int Items { get; init; }
        public int Dated { get; init; }
        public long? LastSuccess { get; init; }
        public long? LastAttempt { get; init; }
        public long? NextRefresh { get; init; }
        public string? LastError { get; init; }
    }
}
