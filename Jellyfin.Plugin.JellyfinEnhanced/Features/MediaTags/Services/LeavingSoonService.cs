using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.LeavingSoonSources;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>
    /// Leaving soon facts (Status group): which library items Maintainerr will delete and
    /// when, from its REST API (<c>GET /api/collections</c>, then every member of each active
    /// collection page by page, <c>addDate + deleteAfterDays</c> per item), and which items
    /// are in the administrator's leaving collections (existing
    /// Jellyfin collections by name, no date). A collection fact keeps which collections
    /// produced it (<see cref="TagLeaving.Collections"/>) and is only served to a user who
    /// can access one of them (<see cref="Visible"/>), as collection-matched custom badges
    /// are; Maintainerr's facts carry no collection and are served to anyone who can see
    /// the item. Only the refresh (the scheduled task, a
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
        /// <summary>Largest Maintainerr answer read (bytes).</summary>
        internal const int MaxResponseBytes = 16 * 1024 * 1024;
        /// <summary>First retry delay after a failed Maintainerr request.</summary>
        internal static readonly TimeSpan FirstRetry = TimeSpan.FromMinutes(15);
        private const long DayMs = 86_400_000L;
        /// <summary>How far from now a computed delete time may be (10 years); further is a bad answer.</summary>
        internal const long MaxDateDistanceMs = 3653 * DayMs;
        /// <summary>The snapshot layout (2: collection facts keep their collections).</summary>
        private const int SnapshotSchema = 2;

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
                // An older layout is read again by the next refresh.
                if (disk?.Schema == SnapshotSchema) _snapshot = disk;
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

        /// <summary>
        /// The leaving of two that comes first: a dated one before an undated one. Of two
        /// undated ones, one anyone may see (Maintainerr's) wins; two collection facts join
        /// their collections, so a user who can access either sees it.
        /// </summary>
        internal static TagLeaving? Earliest(TagLeaving? a, TagLeaving? b)
        {
            if (a == null) return b;
            if (b == null) return a;
            if (a.DeleteAt is { } x && b.DeleteAt is { } y) return x <= y ? a : b;
            if (a.DeleteAt != null) return a;
            if (b.DeleteAt != null) return b;
            if (a.Collections == null) return a;
            if (b.Collections == null || a.Collections == b.Collections) return b;
            return new TagLeaving { Collections = JoinIds(a.Collections.Split(',').Concat(b.Collections.Split(','))) };
        }

        /// <summary>
        /// A fact as one user may see it: Maintainerr's as it is, a collection fact only while
        /// <paramref name="access"/> (the user's accessible ids, N format) holds one of its
        /// collections. The provenance never leaves the server.
        /// </summary>
        public static TagLeaving? Visible(TagLeaving? leaving, IReadOnlySet<string> access)
        {
            if (leaving?.Collections is not { } ids) return leaving;
            foreach (var id in ids.Split(','))
            {
                if (access.Contains(id)) return leaving with { Collections = null };
            }

            return null;
        }

        /// <summary>Collection ids (N format) as one sorted, comma-separated value.</summary>
        private static string JoinIds(IEnumerable<string> ids) => string.Join(",", ids.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));

        /// <summary>
        /// A copy of the current item map (N-format id → facts with their provenance), for
        /// publishing to the cache, and the snapshot revision it belongs to (for <see cref="MarkPublished"/>).
        /// </summary>
        internal IReadOnlyDictionary<string, TagLeaving> Items(PluginConfiguration? config, out long revision)
        {
            lock (_sync)
            {
                revision = _snapshot.Revision;
                if (!Configured(config) || _snapshot.Signature != Signature(config!)) return new Dictionary<string, TagLeaving>();
                return Merge(_snapshot);
            }
        }

        /// <summary>
        /// Whether a changed answer is saved but not yet published to the cache (a publish was
        /// cancelled or failed, or the server stopped in between). Persisted, so the next run
        /// publishes it even when nothing is due and the answer is unchanged.
        /// </summary>
        internal bool PublishPending
        {
            get { lock (_sync) return _snapshot.PublishedRevision != _snapshot.Revision; }
        }

        /// <summary>Record that the cache now carries the facts of <paramref name="revision"/> (see <see cref="Items"/>).</summary>
        internal void MarkPublished(long revision)
        {
            lock (_sync)
            {
                if (revision <= _snapshot.PublishedRevision) return;
                _snapshot.PublishedRevision = Math.Min(revision, _snapshot.Revision);
            }

            Save();
        }

        /// <summary>The leaving collections found by the last read (N-format ids), for the per-user access revision.</summary>
        internal IReadOnlyList<string> NamedCollectionIds(PluginConfiguration? config)
        {
            if (!Configured(config)) return Array.Empty<string>();
            var signature = Signature(config!);
            lock (_sync)
            {
                return _snapshot.Signature != signature ? Array.Empty<string>() : _snapshot.NamedCollections;
            }
        }

        /// <summary>What the admin page shows: counts, times and the last failure (never the URL or key).</summary>
        public LeavingSoonStatus Status(PluginConfiguration? config)
        {
            lock (_sync)
            {
                var current = config != null && Configured(config) && _snapshot.Signature == Signature(config);
                var merged = current ? Merge(_snapshot) : new Dictionary<string, TagLeaving>();
                return new LeavingSoonStatus
                {
                    Configured = Configured(config),
                    Maintainerr = config != null && IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl),
                    Collections = config == null ? 0 : CollectionNames(config.LeavingSoonCollections).Count,
                    Items = merged.Count,
                    Dated = merged.Count(p => p.Value.DeleteAt != null),
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
                    var cleared = Merge(before).Count > 0;
                    lock (_sync) _snapshot = new Snapshot { Revision = before.Revision + (cleared ? 1 : 0), PublishedRevision = before.PublishedRevision };
                    Save();
                    return cleared;
                }

                var signature = Signature(config);
                var now = Now().ToUnixTimeMilliseconds();
                var sameSource = before.Signature == signature;
                if (!force && sameSource && before.NextRefresh is { } due && now < due) return false;

                var next = new Snapshot { Signature = signature, LastAttempt = now, Failures = sameSource ? before.Failures : 0, Revision = before.Revision, PublishedRevision = before.PublishedRevision };
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
                        (next.Named, next.NamedCollections) = ReadCollections(names);
                        next.CollectionsFound = next.NamedCollections.Count;
                    }
                    catch (Exception ex)
                    {
                        error ??= "collections could not be read";
                        _logger.Warning($"[LeavingSoon] Reading the leaving collections failed: {ex.Message}");
                        next.Named = sameSource ? before.Named : new Dictionary<string, string>(StringComparer.Ordinal);
                        next.NamedCollections = sameSource ? before.NamedCollections : new List<string>();
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

                var changed = !SameItems(sameSource ? Merge(before) : new Dictionary<string, TagLeaving>(), Merge(next)) || !sameSource;
                // A changed answer is a new revision, published by the caller (see PublishPending).
                if (changed) next.Revision++;
                lock (_sync)
                {
                    // A publish that finished while this refresh ran.
                    next.PublishedRevision = Math.Max(next.PublishedRevision, _snapshot.PublishedRevision);
                    _snapshot = next;
                }

                Save();
                return changed;
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
            DateRangeException => "a delete date is out of range",
            JsonException => "not a Maintainerr collections answer",
            InvalidDataException => "answer too large",
            UnauthorizedAccessException => "address not allowed",
            RedirectException => "redirected (redirects are not followed)",
            _ => "request failed",
        };

        /// <summary>How many members one page of a collection is asked for.</summary>
        private const int PageSize = 500;
        /// <summary>Most pages read per collection (20,000 members).</summary>
        private const int MaxMemberPages = 40;

        private async Task<Dictionary<string, long?>> FetchMaintainerrAsync(PluginConfiguration config, CancellationToken token)
        {
            var baseUrl = config.LeavingSoonMaintainerrUrl.Trim().TrimEnd('/');
            using var document = await GetJsonAsync(config, baseUrl + "/api/collections", token).ConfigureAwait(false);

            // /api/collections embeds only a few members per collection; the paged route has all of them.
            var pages = new Dictionary<int, List<JsonDocument>>();
            try
            {
                foreach (var id in PagedCollections(document.RootElement))
                {
                    if (pages.ContainsKey(id)) continue;
                    var fetched = new List<JsonDocument>();
                    pages[id] = fetched;
                    for (var page = 1; page <= MaxMemberPages; page++)
                    {
                        JsonDocument doc;
                        try
                        {
                            doc = await GetJsonAsync(config, baseUrl + "/api/collections/media/" + id.ToString(CultureInfo.InvariantCulture) + "/content/" + page.ToString(CultureInfo.InvariantCulture) + "?size=" + PageSize.ToString(CultureInfo.InvariantCulture), token).ConfigureAwait(false);
                        }
                        catch (HttpRequestException ex) when (page == 1 && ex.StatusCode == HttpStatusCode.NotFound)
                        {
                            // A Maintainerr without the paged route: the embedded list is all there is for this collection.
                            break;
                        }

                        fetched.Add(doc);
                        // Any other failure, and an answer that is not a page, fails the refresh, which keeps the
                        // previous answer: carrying on with the members read so far would untag the others.
                        var root = doc.RootElement;
                        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) throw new JsonException("Not a page of collection members");
                        // Rows whose media-server metadata is gone are dropped from a page, so a short page is not the last one: stop on totalSize or an empty page.
                        if (items.GetArrayLength() == 0) break;
                        if (root.TryGetProperty("totalSize", out var total) && total.ValueKind == JsonValueKind.Number && total.TryGetInt64(out var totalSize) && (long)page * PageSize >= totalSize) break;
                    }
                }

                var parsed = ParseCollections(document.RootElement, Now(), id =>
                    pages.TryGetValue(id, out var docs) ? docs.SelectMany(d => d.RootElement.GetProperty("items").EnumerateArray()).ToList() : null);
                return ToItems(parsed, TmdbLookup);
            }
            finally
            {
                foreach (var d in pages.Values.SelectMany(x => x)) d.Dispose();
            }
        }

        /// <summary>
        /// One guarded GET of a Maintainerr address, as JSON: the address guard, the key header, the timeout,
        /// no redirect followed and at most <see cref="MaxResponseBytes"/> read. Anything else throws.
        /// </summary>
        private async Task<JsonDocument> GetJsonAsync(PluginConfiguration config, string url, CancellationToken token)
        {
            if (!await Shared.Arr.ArrUrlGuard.IsAllowedUrlAsync(url, token).ConfigureAwait(false)) throw new UnauthorizedAccessException();
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

            return JsonDocument.Parse(buffer.ToArray());
        }

        /// <summary>A computed delete time too far from now to be real (and possibly beyond what a renderer can show).</summary>
        internal sealed class DateRangeException : JsonException
        {
            public DateRangeException() : base("Delete date out of range")
            {
            }
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
        /// leaves undated. An empty list (or only inactive or empty collections) is a real
        /// "nothing is leaving". Entries that are not collections, and members without a usable
        /// id, are skipped while others are usable; an answer with entries but no collection, or
        /// with members but none usable, is refused with <see cref="JsonException"/> (so the
        /// last good answer stays), as is any other shape. A delete time more than
        /// <see cref="MaxDateDistanceMs"/> from <paramref name="now"/> refuses the answer with
        /// <see cref="DateRangeException"/>. <paramref name="fullMedia"/> gives the members the
        /// paged route listed for a collection id (null when it was not asked); they are read
        /// like the embedded ones and add to them.
        /// </summary>
        internal static IReadOnlyList<MaintainerrMember> ParseCollections(JsonElement root, DateTimeOffset? now = null, Func<int, IReadOnlyList<JsonElement>?>? fullMedia = null)
        {
            var nowMs = (now ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
            var collections = CollectionList(root);
            if (collections.ValueKind != JsonValueKind.Array) throw new JsonException("Expected a list of collections");
            var members = new List<MaintainerrMember>();
            int entries = 0, recognised = 0, listed = 0;
            foreach (var collection in collections.EnumerateArray())
            {
                entries++;
                if (!IsCollection(collection)) continue;
                recognised++;
                if (collection.TryGetProperty("isActive", out var active) && active.ValueKind == JsonValueKind.False) continue;
                int? days = collection.TryGetProperty("deleteAfterDays", out var d) && d.ValueKind == JsonValueKind.Number && d.TryGetInt32(out var n) && n is >= 0 and <= 36500 ? n : null;
                var type = CollectionType(collection);
                JsonElement media = default;
                foreach (var name in new[] { "media", "collectionMedia" })
                {
                    if (collection.TryGetProperty(name, out var m) && m.ValueKind == JsonValueKind.Array) { media = m; break; }
                }

                IEnumerable<JsonElement> mediaItems = media.ValueKind == JsonValueKind.Array ? media.EnumerateArray() : Enumerable.Empty<JsonElement>();
                // The pages add to the embedded list: a row a page left out (its media-server metadata is gone) is still a member.
                if (fullMedia != null && TryCollectionId(collection, out var collectionId) && fullMedia(collectionId) is { } full) mediaItems = mediaItems.Concat(full);
                foreach (var item in mediaItems)
                {
                    listed++;
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
                        // No overflow: |addDate| < 2.6e14 ms and days * DayMs < 3.2e12.
                        var at = addedAt.ToUnixTimeMilliseconds() + days.Value * DayMs;
                        if (Math.Abs(at - nowMs) > MaxDateDistanceMs) throw new DateRangeException();
                        deleteAt = at;
                    }

                    members.Add(new MaintainerrMember(id, tmdb, type, deleteAt));
                }
            }

            if (entries > 0 && recognised == 0) throw new JsonException("No Maintainerr collection in the answer");
            if (listed > 0 && members.Count == 0) throw new JsonException("No usable collection member in the answer");
            return members;
        }

        /// <summary>The answer's list of collections: the root array, or the one an object wraps in <c>data</c>, <c>items</c>, <c>collections</c> or <c>results</c> (else not an array).</summary>
        private static JsonElement CollectionList(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object) return root;
            foreach (var name in new[] { "data", "items", "collections", "results" })
            {
                if (root.TryGetProperty(name, out var inner) && inner.ValueKind == JsonValueKind.Array) return inner;
            }

            return default;
        }

        /// <summary>A collection's id for the paged route: a whole number (any other id has no pages to ask for).</summary>
        private static bool TryCollectionId(JsonElement collection, out int id)
        {
            id = 0;
            return collection.TryGetProperty("id", out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out id);
        }

        /// <summary>The ids to ask the paged route with: the list's active collections that have one.</summary>
        private static IEnumerable<int> PagedCollections(JsonElement root)
        {
            var collections = CollectionList(root);
            if (collections.ValueKind != JsonValueKind.Array) yield break;
            foreach (var collection in collections.EnumerateArray())
            {
                if (!IsCollection(collection) || (collection.TryGetProperty("isActive", out var active) && active.ValueKind == JsonValueKind.False)) continue;
                if (TryCollectionId(collection, out var id)) yield return id;
            }
        }

        /// <summary>A Maintainerr collection: an object with its media list, its active flag or its delete delay.</summary>
        private static bool IsCollection(JsonElement collection)
        {
            if (collection.ValueKind != JsonValueKind.Object) return false;
            foreach (var name in new[] { "media", "collectionMedia" })
            {
                if (collection.TryGetProperty(name, out var media) && media.ValueKind == JsonValueKind.Array) return true;
            }

            return (collection.TryGetProperty("isActive", out var active) && active.ValueKind is JsonValueKind.True or JsonValueKind.False)
                || (collection.TryGetProperty("deleteAfterDays", out var days) && days.ValueKind is JsonValueKind.Number or JsonValueKind.Null);
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
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var ms) && ms > 0 && ms <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds())
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

        /// <summary>
        /// The members (N-format ids) of the existing collections with these names, each with
        /// the collections holding it, and the ids of the collections that matched.
        /// </summary>
        private (Dictionary<string, string> Members, List<string> Collections) ReadCollections(IReadOnlyList<string> names)
        {
            var members = new Dictionary<string, string>(StringComparer.Ordinal);
            var collections = new List<string>();
            if (_library == null) return (members, collections);
            var wanted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
            var by = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var boxSet in _library.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.BoxSet }, Recursive = true }))
            {
                if (boxSet is not Folder folder || boxSet.Name == null || !wanted.Contains(boxSet.Name.Trim())) continue;
                var collection = boxSet.Id.ToString("N");
                collections.Add(collection);
                foreach (var child in folder.GetLinkedChildren())
                {
                    if (child == null) continue;
                    var key = child.Id.ToString("N");
                    if (!by.TryGetValue(key, out var list)) by[key] = list = new List<string>(1);
                    list.Add(collection);
                }
            }

            foreach (var pair in by) members[pair.Key] = JoinIds(pair.Value);
            return (members, collections);
        }

        /// <summary>Maintainerr's answer over the undated collection members (which keep their collections).</summary>
        private static Dictionary<string, TagLeaving> Merge(Snapshot snapshot)
        {
            var merged = new Dictionary<string, TagLeaving>(StringComparer.Ordinal);
            foreach (var pair in snapshot.Api) merged[pair.Key] = new TagLeaving { DeleteAt = pair.Value };
            foreach (var pair in snapshot.Named) merged.TryAdd(pair.Key, new TagLeaving { Collections = pair.Value });
            return merged;
        }

        private static TagLeaving? Lookup(Snapshot snapshot, string key)
        {
            if (snapshot.Api.TryGetValue(key, out var at)) return new TagLeaving { DeleteAt = at };
            return snapshot.Named.TryGetValue(key, out var collections) ? new TagLeaving { Collections = collections } : null;
        }

        private static bool SameItems(IReadOnlyDictionary<string, TagLeaving> a, IReadOnlyDictionary<string, TagLeaving> b)
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
            public int Schema { get; set; } = SnapshotSchema;
            public string Signature { get; set; } = string.Empty;
            public Dictionary<string, long?> Api { get; set; } = new(StringComparer.Ordinal);
            /// <summary>Collection members (N format) → the ids of the leaving collections holding them (sorted, comma-separated).</summary>
            public Dictionary<string, string> Named { get; set; } = new(StringComparer.Ordinal);
            /// <summary>The ids (N format) of the leaving collections the last read found.</summary>
            public List<string> NamedCollections { get; set; } = new();
            public int CollectionsFound { get; set; }
            public long? LastSuccess { get; set; }
            public long? LastAttempt { get; set; }
            public long? NextRefresh { get; set; }
            public int Failures { get; set; }
            public string? LastError { get; set; }
            /// <summary>Counts changed answers.</summary>
            public long Revision { get; set; }
            /// <summary>The last revision published to the tag cache.</summary>
            public long PublishedRevision { get; set; }
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
