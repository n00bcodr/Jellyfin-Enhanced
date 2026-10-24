using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One title on a Discover row or in the search row, as the caller may see it.</summary>
    public sealed record DiscoverCard
    {
        /// <summary>Title key (movie:tmdb:N or tv:tmdb:N): what a request or a follow names.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>movie or tv.</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = "movie";

        /// <summary>TMDB id (opens the existing more-info window).</summary>
        [JsonPropertyName("tmdbId")] public int TmdbId { get; init; }

        /// <summary>Title.</summary>
        [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

        /// <summary>Release (first air) year.</summary>
        [JsonPropertyName("year")] public int? Year { get; init; }

        /// <summary>TMDB poster path ("/abc.jpg"), validated; the client builds the image URL.</summary>
        [JsonPropertyName("poster")] public string? Poster { get; init; }

        /// <summary>Plain-text overview, at most <see cref="DiscoverService.MaxOverview"/> characters.</summary>
        [JsonPropertyName("overview")] public string? Overview { get; init; }

        /// <summary>Effective viewer projection flags; no private rule lists.</summary>
        [JsonPropertyName("jeSpoiler")] public System.Text.Json.Nodes.JsonObject? Spoiler { get; init; }

        /// <summary>The caller can open a Jellyfin copy of it.</summary>
        [JsonPropertyName("inLibrary")] public bool InLibrary { get; init; }

        /// <summary>That Jellyfin copy (only when <see cref="InLibrary"/>).</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; init; }

        /// <summary>Someone in the household (the caller included) has an active ask for it.</summary>
        [JsonPropertyName("requested")] public bool Requested { get; init; }

        /// <summary>The caller's own ask: waiting (for an OK), asked, declined, or null.</summary>
        [JsonPropertyName("mine")] public string? Mine { get; init; }

        /// <summary>The copies (standard, 4k) the caller's own waiting or sent asks are for; omitted when none.</summary>
        [JsonPropertyName("mineVariants")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public IReadOnlyList<string>? MineVariants { get; init; }

        /// <summary>
        /// The seasons the caller's own waiting or sent standard asks cover whole (series); omitted when
        /// none. The card keeps its Request button while more can be asked for.
        /// </summary>
        [JsonPropertyName("mineSeasons")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public IReadOnlyList<int>? MineSeasons { get; init; }

        /// <summary>
        /// Why the caller can't ask for this title's standard edition right now (omitted when they can): <c>low_disk</c>,
        /// the drive it would land on (its own folder when Sonarr/Radarr has it, else the default root) is nearly full;
        /// instance, folder and sizes for administrators only. Worked out for each answer, never cached.
        /// </summary>
        [JsonPropertyName("blocked")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public RequestBlock? Blocked { get; init; }
    }

    /// <summary>"Because you watched {title}": recommendations for one title the caller watched lately.</summary>
    public sealed record DiscoverGroup
    {
        /// <summary>The watched title's name, as Jellyfin shows it to the caller.</summary>
        [JsonPropertyName("basedOn")] public string BasedOn { get; init; } = string.Empty;

        /// <summary>The watched title's key.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>The recommendations the caller may see.</summary>
        [JsonPropertyName("results")] public IReadOnlyList<DiscoverCard> Results { get; init; } = Array.Empty<DiscoverCard>();
    }

    /// <summary>One Discover row page or one search page.</summary>
    public sealed record DiscoverAnswer
    {
        /// <summary>trending, upcoming, popular, because or search.</summary>
        [JsonPropertyName("list")] public string List { get; init; } = string.Empty;

        /// <summary>movie or tv (search and "because": all).</summary>
        [JsonPropertyName("type")] public string Type { get; init; } = string.Empty;

        /// <summary>Page number.</summary>
        [JsonPropertyName("page")] public int Page { get; init; } = 1;

        /// <summary>Pages there are (at most <see cref="DiscoverService.MaxPage"/>).</summary>
        [JsonPropertyName("totalPages")] public int TotalPages { get; init; } = 1;

        /// <summary>The titles of the page the caller may see.</summary>
        [JsonPropertyName("results")] public IReadOnlyList<DiscoverCard> Results { get; init; } = Array.Empty<DiscoverCard>();

        /// <summary>False when some titles could not yet be verified; hidden titles are never named.</summary>
        [JsonPropertyName("complete")] public bool Complete { get; init; } = true;

        /// <summary>complete or partial; a partial page must not be rendered as a completed empty result.</summary>
        [JsonPropertyName("verification")] public string Verification => Complete ? "complete" : "partial";

        /// <summary>Minimum retry delay for partial verification; null for a complete answer.</summary>
        [JsonPropertyName("retryAfterSeconds")] public int? RetryAfterSeconds => Complete ? null : 5;

        /// <summary>"Because you watched" only: one group per watched title (empty: no row).</summary>
        [JsonPropertyName("groups")] public IReadOnlyList<DiscoverGroup>? Groups { get; init; }
    }

    /// <summary>A title the caller watched lately (the seed of a "because you watched" group).</summary>
    internal sealed record RecentTitle(bool Movie, int TmdbId, string Title);

    /// <summary>
    /// What the caller hid with Hidden Content, per surface (Discover rows, the search row): title keys
    /// (movie:tmdb:N, tv:tmdb:N) and Jellyfin item ids (32 hex digits) in one set each.
    /// </summary>
    internal sealed record HiddenTitles(IReadOnlySet<string> Discovery, IReadOnlySet<string> Search)
    {
        /// <summary>Nothing hidden.</summary>
        public static readonly HiddenTitles None = new(new HashSet<string>(), new HashSet<string>());

        /// <summary>A short fingerprint for cache keys.</summary>
        public string Stamp => Discovery.Count + "." + Search.Count + "." +
            string.Join(",", Discovery.OrderBy(s => s, StringComparer.Ordinal)).GetHashCode(StringComparison.Ordinal).ToString(CultureInfo.InvariantCulture) + "." +
            string.Join(",", Search.OrderBy(s => s, StringComparer.Ordinal)).GetHashCode(StringComparison.Ordinal).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Discover rows (trending, coming soon, popular, "because you watched") and the free-text search
    /// row for the JE request backend, from TMDB through the shared <see cref="TmdbResponseCache"/>
    /// (server key). Every title is projected for the caller: callers with parental limits only get
    /// titles Jellyfin lets them open, or absent titles whose verified rating they may see
    /// (<see cref="SeerrParentalFilter.MaySeeAbsentAsync"/>; unknown, unrated and failed lookups refuse);
    /// "in your library" only counts copies the caller can open; titles hidden with Hidden Content are
    /// left out; request flags come from the ledger (the caller's own state, and "someone asked").
    /// Nothing about instances, paths or other people is returned. Answers are cached per caller for a
    /// short time; upstream reads are bounded (one list read, at most three recommendation reads).
    /// </summary>
    public sealed class DiscoverService
    {
        /// <summary>Longest search query (characters).</summary>
        public const int MaxQuery = 100;

        /// <summary>Highest page a client may ask for.</summary>
        public const int MaxPage = 10;

        /// <summary>Longest overview sent (characters).</summary>
        public const int MaxOverview = 300;

        /// <summary>Most titles per page.</summary>
        public const int MaxResults = 20;

        /// <summary>Most watched titles a "because you watched" answer is built from.</summary>
        public const int MaxSeeds = 3;

        /// <summary>The Discover lists.</summary>
        public static readonly IReadOnlyList<string> Lists = new[] { "trending", "upcoming", "popular", "because" };

        private const int MaxCacheEntries = 500;
        private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(2);
        private static readonly Regex PosterPath = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
        private static readonly Regex Language = new("^[a-z]{2}(-[A-Z]{2})?$", RegexOptions.CultureInvariant);

        // One rating-lookup fan-out limit for all Discover answers (the filter's own list pool is
        // for Seerr bodies; single-title checks bypass it).
        private static readonly SemaphoreSlim ParentalSlots = new(8);

        private readonly RequestService _requests;
        private SpoilerPresentation? _presentation;
        private UserConfigurationManager? _userConfig;
        private ILibraryManager? _library;
        private readonly TitleAliases? _aliases;
        private readonly Func<string, int, StatusViewer, CancellationToken, Task<bool?>> _maySeeAbsent;
        private readonly Func<string> _evidenceRevision;
        private readonly Func<string, string, CancellationToken, Task<string?>> _tmdb;
        private readonly Func<StatusViewer, int, IReadOnlyList<RecentTitle>> _recent;
        private readonly Func<Guid, HiddenTitles> _hidden;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<string, (DateTimeOffset At, Prepared Page)> _cache = new(StringComparer.Ordinal);
        private readonly ResponseGate _gate;

        /// <summary>Creates the service over the shared TMDB cache, the parental filter and Jellyfin.</summary>
        public DiscoverService(RequestService requests, TitleAliases aliases, SeerrParentalFilter parental, TmdbResponseCache tmdb, ILibraryManager library, UserConfigurationManager userConfig, SpoilerPresentation? presentation = null)
            : this(requests, aliases,
                ParentalCheck(parental),
                (path, query, ct) => TmdbAsync(tmdb, path, query, ct),
                (viewer, max) => RecentlyWatched(library, viewer, max),
                user => ReadHidden(userConfig, library, user),
                () => DateTimeOffset.UtcNow, () => parental.EvidenceRevision)
        {
            _presentation = presentation; _userConfig = userConfig; _library = library;
        }

        /// <summary>Creates the service with explicit readers (tests).</summary>
        internal DiscoverService(RequestService requests, TitleAliases? aliases,
            Func<string, int, StatusViewer, CancellationToken, Task<bool>> maySeeAbsent,
            Func<string, string, CancellationToken, Task<string?>> tmdb,
            Func<StatusViewer, int, IReadOnlyList<RecentTitle>> recent,
            Func<Guid, HiddenTitles> hidden,
            Func<DateTimeOffset> now)
            : this(requests, aliases, async (kind, id, viewer, ct) => (bool?)await maySeeAbsent(kind, id, viewer, ct).ConfigureAwait(false), tmdb, recent, hidden, now) { }

        /// <summary>Creates the service with tri-state evidence and its revision.</summary>
        internal DiscoverService(RequestService requests, TitleAliases? aliases,
            Func<string, int, StatusViewer, CancellationToken, Task<bool?>> maySeeAbsent,
            Func<string, string, CancellationToken, Task<string?>> tmdb,
            Func<StatusViewer, int, IReadOnlyList<RecentTitle>> recent,
            Func<Guid, HiddenTitles> hidden,
            Func<DateTimeOffset> now,
            Func<string>? evidenceRevision = null)
        {
            _evidenceRevision = evidenceRevision ?? (() => requests.Policy.Configuration.ArrRequestBackend);
            _requests = requests;
            _aliases = aliases;
            _maySeeAbsent = maySeeAbsent;
            _tmdb = tmdb;
            _recent = recent;
            _hidden = hidden;
            _now = now;
            _gate = new ResponseGate(requests.View, () => requests.Policy.Configuration, _evidenceRevision);
        }

        /// <summary>
        /// The absent-title rating check of the production service: decided with the policy of the viewer as the request
        /// read them (<see cref="StatusViewer.Handle"/>, the same read its answer is keyed by), never a later read of the
        /// person by id, which a policy change can land between (a widened then restored limit would file a title the
        /// narrow limit hides under the narrow limit's key). A restricted viewer with no read user is refused.
        /// </summary>
        /// <param name="parental">The parental filter.</param>
        /// <returns>The check.</returns>
        internal static Func<string, int, StatusViewer, CancellationToken, Task<bool?>> ParentalCheck(SeerrParentalFilter parental)
            => (kind, id, viewer, ct) => viewer.Handle is not User person
                ? Task.FromResult<bool?>(null)
                : parental.TryGetRestrictedPolicy(person, out var policy) ? parental.AbsentVerdictAsync(kind, id, policy, ct) : Task.FromResult<bool?>(true);

        /// <summary>Hidden Content's per-user file.</summary>
        internal const string HiddenContentFile = "hidden-content.json";

        /// <summary>The request service (caller resolution, identity and configuration).</summary>
        public RequestService Requests => _requests;

        /// <summary>Discover and search are on: phase 3 with the JE request backend (Seerr mode keeps Seerr's own).</summary>
        public bool Enabled => _requests.Enabled && _requests.Policy.Configuration.ArrRequestBackend == "je";

        /// <summary>
        /// One page of a Discover list for the viewer, or null when TMDB could not answer (not set up,
        /// failed). "because" answers groups (empty when the viewer has watched nothing with a TMDB id).
        /// </summary>
        public Task<DiscoverAnswer?> DiscoverAsync(StatusViewer viewer, string list, string type, int page, string? language, CancellationToken ct)
        {
            var lang = Lang(language);
            return PublishAsync(viewer, list + "|" + type + "|" + page + "|" + lang, false, (v, hidden, budget) => PrepareDiscoverAsync(v, list, type, page, lang, hidden, budget, ct), ct);
        }

        /// <summary>One page of free-text search (movies and series only), or null when TMDB could not answer.</summary>
        public Task<DiscoverAnswer?> SearchAsync(StatusViewer viewer, string query, int page, string? language, CancellationToken ct)
        {
            var lang = Lang(language);
            return PublishAsync(viewer, "search|" + page + "|" + lang + "|" + query, true, (v, hidden, budget) => PrepareSearchAsync(v, query, page, lang, hidden, budget, ct), ct);
        }

        /// <summary>
        /// A Discover or search answer through the response gate (D53, edition round 19: every response proven fresh at
        /// publication). The TMDB pages and the rating checks of absent titles await; after the last await every card is built
        /// again from Jellyfin as it is now, for the viewer as they are now: their copies, what Jellyfin hides from them, what
        /// Hidden Content hides (a card for a copy they lost meanwhile never names it). A viewer whose policy or Hidden Content
        /// changed meanwhile gets the page prepared again for them as they are now, at most <see cref="ResponseGate.Attempts"/>
        /// times, then nothing (fail closed). An answer is cached only under a stamp that held from the start to publication.
        /// </summary>
        private async Task<DiscoverAnswer?> PublishAsync(StatusViewer viewer, string what, bool search, Func<StatusViewer, HiddenTitles, EvidenceDeadline, Task<Prepared?>> prepare, CancellationToken ct)
        {
            // Cards whose copy lookup reached its scan bound read "not in the library" for this answer only (see Store).
            using var bound = CopyLookupBound.Track();
            using var budget = new EvidenceDeadline(ct);
            Prepared? lastRead = null;
            for (var attempt = 0; attempt < ResponseGate.Attempts; attempt++)
            {
                var hidden = Hidden(viewer.UserId);
                var stamp = _gate.Take(viewer, hidden.Stamp);
                var cacheKey = CacheKey(viewer, what, hidden) + "|" + stamp.Evidence;
                Prepared? prepared;
                if (Cached(cacheKey) is { } cached) prepared = cached;
                else
                {
                    prepared = await prepare(viewer, hidden, budget).ConfigureAwait(false);
                    if (prepared == null) return null;
                }
                lastRead = prepared;
                var paused = await _requests.StoragePausesAsync(viewer.UserId, prepared.Keys, false, ct).ConfigureAwait(false);
                // Publication: no await from here on.
                var nowHidden = Hidden(viewer.UserId);
                if (_gate.Current(stamp, nowHidden.Stamp, rereadsLibrary: true) is not { } now)
                {
                    if (_requests.View.Viewer(viewer.UserId) is not { } changed) break;
                    viewer = changed;
                    continue;
                }
                var before = _gate.Take(now, nowHidden.Stamp);
                // The final Hidden Content and Spoiler Guard projection (D46), at publication, under the presentation revision it read.
                var revision = _presentation?.Load(now.UserId).Revision;
                var answer = Present(now, Project(now, prepared, search ? nowHidden.Search : nowHidden.Discovery, paused), nowHidden);
                if (!ResponseGate.SameViewer(before, _gate.Take(now, Hidden(now.UserId).Stamp)) || _presentation?.Load(now.UserId).Revision != revision || !_gate.EvidenceCurrent(stamp))
                {
                    viewer = now;
                    continue;
                }
                // Only what held from start to finish is kept for the next read.
                if (answer.Complete && ResponseGate.Same(stamp, before)) Store(cacheKey, prepared);
                return answer;
            }
            // The list succeeded. Continuous authority/evidence changes leave no card verified for publication,
            // but this is still an incomplete successful list read, never an upstream-list failure or complete empty.
            return lastRead == null ? null : new DiscoverAnswer
            {
                List = lastRead.List, Type = lastRead.Type, Page = lastRead.Page, TotalPages = lastRead.TotalPages,
                Complete = false, Groups = lastRead.Groups == null ? null : Array.Empty<DiscoverGroup>(),
            };
        }

        private async Task<Prepared?> PrepareDiscoverAsync(StatusViewer viewer, string list, string type, int page, string? lang, HiddenTitles hidden, EvidenceDeadline budget, CancellationToken ct)
        {
            if (list == "because")
            {
                var groups = new List<PreparedGroup>();
                foreach (var seed in _recent(viewer, MaxSeeds).Take(MaxSeeds))
                {
                    var kind = seed.Movie ? "movie" : "tv";
                    var json = await Read($"{kind}/{seed.TmdbId}/recommendations", Query(1, lang), ct).ConfigureAwait(false);
                    if (json == null) continue;
                    var seedKey = kind + ":tmdb:" + seed.TmdbId.ToString(CultureInfo.InvariantCulture);
                    if (hidden.Discovery.Contains(seedKey)) continue;
                    var (rows, _) = Parse(json, kind);
                    var kept = Page(rows.Where(r => r.Key != seedKey), hidden.Discovery);
                    groups.Add(new PreparedGroup(seed.Title.Length > 200 ? seed.Title[..200] : seed.Title, seedKey, kept));
                }
                return new Prepared("because", "all", 1, 1, Array.Empty<Row>(), groups, await RatingsAsync(viewer, groups.SelectMany(g => g.Rows), budget, ct).ConfigureAwait(false));
            }
            var path = list switch
            {
                "trending" => $"trending/{type}/week",
                "upcoming" => type == "movie" ? "movie/upcoming" : "tv/on_the_air",
                _ => $"{type}/popular",
            };
            var page1 = await Read(path, Query(page, lang), ct).ConfigureAwait(false);
            if (page1 == null) return null;
            var (found, total) = Parse(page1, type);
            var pageRows = Page(found, hidden.Discovery);
            return new Prepared(list, type, page, Math.Clamp(total, 1, MaxPage), pageRows, null, await RatingsAsync(viewer, pageRows, budget, ct).ConfigureAwait(false));
        }

        private async Task<Prepared?> PrepareSearchAsync(StatusViewer viewer, string query, int page, string? lang, HiddenTitles hidden, EvidenceDeadline budget, CancellationToken ct)
        {
            var json = await Read("search/multi", Query(page, lang) + "&include_adult=false&query=" + Uri.EscapeDataString(query), ct).ConfigureAwait(false);
            if (json == null) return null;
            var (found, total) = Parse(json, null);
            var pageRows = Page(found, hidden.Search);
            return new Prepared("search", "all", page, Math.Clamp(total, 1, MaxPage), pageRows, null, await RatingsAsync(viewer, pageRows, budget, ct).ConfigureAwait(false));
        }

        /// <summary>The rows of a page that Hidden Content doesn't hide by key, at most <see cref="MaxResults"/>.</summary>
        private static List<Row> Page(IEnumerable<Row> rows, IReadOnlySet<string> hidden) => rows.Where(r => !hidden.Contains(r.Key)).Take(MaxResults).ToList();

        /// <summary>Final caller projection for cache hits, inserts and byte serialization; never awaits.</summary>
        public DiscoverAnswer Present(StatusViewer viewer, DiscoverAnswer answer) => Present(viewer, answer, Hidden(viewer.UserId));

        private DiscoverAnswer Present(StatusViewer viewer, DiscoverAnswer answer, HiddenTitles hidden)
        {
            var final = _userConfig == null ? null : TitlePresentationGate.Read(_userConfig, _presentation, viewer.UserId, _library);
            if (final != null) hidden = new HiddenTitles(final.Hidden.GlobalKeys("discovery"), final.Hidden.GlobalKeys("search"));
            var keys = answer.List == "search" ? hidden.Search : hidden.Discovery;
            var spoiler = final?.Spoilers ?? _presentation?.Load(viewer.UserId);
            bool Keep(DiscoverCard card) => !keys.Contains(card.Key) && (card.ItemId == null || !keys.Contains(card.ItemId));
            DiscoverCard Project(DiscoverCard card)
            {
                if (spoiler == null) return card;
                var flags = spoiler.Flags(card.Key);
                return card with { Overview = flags["overview"]?.GetValue<bool>() == true ? null : card.Overview,
                    Poster = spoiler.ProtectArtwork(card.Key, card.Kind, "Primary") ? null : card.Poster, Spoiler = flags };
            }
            return answer with { Results = answer.Results.Where(Keep).Select(Project).ToArray(),
                Groups = answer.Groups?.Where(g => !keys.Contains(g.Key)).Select(g => g with { Results = g.Results.Where(Keep).Select(Project).ToArray() })
                    .Where(g => g.Results.Count > 0).ToArray() };
        }

        // ------------------------------------------------------------------ projection

        /// <summary>A parsed TMDB row before the caller's checks.</summary>
        internal sealed record Row(string Key, string Kind, int TmdbId, string Title, int? Year, string? Poster, string? Overview);

        /// <summary>A page prepared ahead of publication: its rows (or "because" groups) and the rating checks of absent titles.</summary>
        internal sealed record Prepared(string List, string Type, int Page, int TotalPages, IReadOnlyList<Row> Rows, IReadOnlyList<PreparedGroup>? Groups, IReadOnlyDictionary<string, bool?> Ratings)
        {
            /// <summary>Every title key of the page.</summary>
            public IEnumerable<string> Keys => Rows.Concat(Groups?.SelectMany(g => g.Rows) ?? Enumerable.Empty<Row>()).Select(r => r.Key);
        }

        /// <summary>One "because you watched" group, prepared.</summary>
        internal sealed record PreparedGroup(string BasedOn, string Key, IReadOnlyList<Row> Rows);

        /// <summary>
        /// For a viewer with parental limits, the rating checks of the titles Jellyfin proves absent for them now (an absent
        /// title needs a verified rating they may see): run in parallel, bounded. Others need none.
        /// </summary>
        private sealed class EvidenceDeadline(CancellationToken request) : IDisposable
        {
            private CancellationTokenSource? _source;
            // One preparation budget across all title checks, slot waits and publication retries.
            public CancellationToken Token
            {
                get
                {
                    if (_source == null)
                    {
                        _source = CancellationTokenSource.CreateLinkedTokenSource(request);
                        _source.CancelAfter(TimeSpan.FromSeconds(2));
                    }
                    return _source.Token;
                }
            }
            public void Dispose() => _source?.Dispose();
        }

        private async Task<IReadOnlyDictionary<string, bool?>> RatingsAsync(StatusViewer viewer, IEnumerable<Row> rows, EvidenceDeadline budget, CancellationToken ct)
        {
            var result = new Dictionary<string, bool?>(StringComparer.Ordinal);
            if (!viewer.HasParentalLimit) return result;
            var absent = rows.DistinctBy(r => r.Key).Where(r => Lookup(viewer, r) is { Seen.Count: 0, IsProvenAbsent: true }).ToList();
            var checks = absent.Select(r => MaySeeAsync(r.Kind, r.TmdbId, viewer, budget.Token)).ToArray();
            try { await Task.WhenAll(checks).WaitAsync(budget.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
            ct.ThrowIfCancellationRequested();
            for (var i = 0; i < absent.Count; i++) result[absent[i].Key] = checks[i].IsCompletedSuccessfully ? checks[i].Result : null;
            return result;
        }

        private CopyLookup Lookup(StatusViewer viewer, Row row)
        {
            var key = TitleKey.Parse(row.Key)!;
            return _requests.View.Copies(key, viewer, _aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>());
        }

        /// <summary>The answer for the viewer as they are now, from Jellyfin as it is now (no I/O beyond Jellyfin and the ledger).</summary>
        private DiscoverAnswer Project(StatusViewer viewer, Prepared prepared, IReadOnlySet<string> hidden, IReadOnlyDictionary<string, RequestBlock> paused)
        {
            var complete = prepared.Ratings.Values.All(v => v != null);
            List<DiscoverCard> Cards(IEnumerable<Row> rows) => rows.Where(r => !hidden.Contains(r.Key)).Select(r =>
                {
                    var card = Card(viewer, r, hidden, prepared.Ratings, out var unverified);
                    if (unverified) complete = false;
                    return card;
                }).Where(c => c != null)
                .Select(c => paused.TryGetValue(c!.Key, out var block) ? c with { Blocked = block } : c!).Take(MaxResults).ToList();
            if (prepared.Groups != null)
            {
                var groups = prepared.Groups.Select(g => new DiscoverGroup { BasedOn = g.BasedOn, Key = g.Key, Results = Cards(g.Rows) }).Where(g => g.Results.Count > 0).ToList();
                return new DiscoverAnswer { List = prepared.List, Type = prepared.Type, Page = 1, TotalPages = 1, Groups = groups, Complete = complete };
            }
            return new DiscoverAnswer { List = prepared.List, Type = prepared.Type, Page = prepared.Page, TotalPages = prepared.TotalPages, Results = Cards(prepared.Rows), Complete = complete };
        }

        private DiscoverCard? Card(StatusViewer viewer, Row row, IReadOnlySet<string> hidden, IReadOnlyDictionary<string, bool?> ratings, out bool unverified)
        {
            unverified = false;
            var key = TitleKey.Parse(row.Key)!;
            var lookup = Lookup(viewer, row);
            // The card shows what a finished lookup found (one that couldn't finish reads as not in the library). In the library
            // means a copy they open plays (D53, edition round 19 part B: the one availability predicate): a movie whose copy
            // is only a ".disc" stub, or a series whose copies list only stubs or missing episodes, is still askable.
            var shown = lookup.Display.FirstOrDefault(c => c.Visible);
            var playing = shown == null ? null : new EditionAvailability(_requests.View, () => null, (_, _) => lookup.Display).Holding(viewer, lookup.Display, key.IsMovie, Edition.Any);
            var open = playing == null ? null : lookup.Display.FirstOrDefault(c => c.Visible && playing.Contains(c.ItemId));
            if (viewer.HasParentalLimit)
            {
                // A copy Jellyfin hides from them (rating, tags or library) hides the title unless one they can open
                // was seen too; an absent title needs a verified rating they may see, and only a proven absence is one (a
                // title no rating was checked for, absent only now, is left out: never shown on an unchecked rating).
                var seen = lookup.Seen;
                if (seen.Count > 0)
                {
                    if (lookup.SeenOpenable == null) return null;
                }
                else
                {
                    if (!lookup.IsProvenAbsent || !ratings.TryGetValue(row.Key, out var may) || may == null)
                    {
                        unverified = true;
                        return null;
                    }
                    if (may != true) return null;
                }
            }
            var itemId = open?.ItemId.ToString("N", CultureInfo.InvariantCulture);
            // Hidden Content keyed by a copy's item id hides the title whether or not that copy plays.
            if (shown != null && hidden.Contains(shown.ItemId.ToString("N", CultureInfo.InvariantCulture))) return null;
            if (itemId != null && hidden.Contains(itemId)) return null;
            var flags = Flags(key, viewer.UserId);
            return new DiscoverCard
            {
                Key = row.Key,
                Kind = row.Kind,
                TmdbId = row.TmdbId,
                Title = row.Title,
                Year = row.Year,
                Poster = row.Poster,
                Overview = row.Overview,
                InLibrary = open != null,
                ItemId = itemId,
                Requested = flags.Requested,
                Mine = flags.Mine,
                MineVariants = flags.MineVariants,
                MineSeasons = flags.MineSeasons,
            };
        }

        private async Task<bool?> MaySeeAsync(string kind, int tmdbId, StatusViewer viewer, CancellationToken ct)
        {
            var entered = false;
            try
            {
                await ParentalSlots.WaitAsync(ct).ConfigureAwait(false);
                entered = true;
                return await _maySeeAbsent(kind, tmdbId, viewer, ct).ConfigureAwait(false);
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (entered) ParentalSlots.Release();
            }
        }

        /// <summary>
        /// The ledger flags of a title: any active ask (pending, queued, sent, stale) by anyone, the
        /// viewer's own state (waiting, asked, declined; the strongest when they asked more than once),
        /// and what the viewer's own active asks cover: their copies (standard, 4k) and the seasons
        /// their standard asks cover whole. A partial ask (one season, or the other copy) leaves the
        /// rest requestable.
        /// </summary>
        internal LedgerFlags Flags(TitleKey key, Guid user)
        {
            var ledger = _requests.Ledger;
            if (!ledger.Database.Available) return LedgerFlags.None;
            var keys = new HashSet<string>(StringComparer.Ordinal) { key.ToString() };
            if (_aliases != null) keys.Add(_aliases.Canonical(key).ToString());
            var requested = false;
            string? mine = null;
            var variants = new SortedSet<string>(StringComparer.Ordinal);
            var seasons = new SortedSet<int>();
            try
            {
                foreach (var want in keys.SelectMany(k => ledger.ForTitle(k)))
                {
                    var state = want.Status switch
                    {
                        "pending" => "waiting",
                        "queued" or "sent" or "stale" => "asked",
                        "declined" => "declined",
                        _ => null,
                    };
                    if (state is "waiting" or "asked") requested = true;
                    if (state == null || want.UserId != user) continue;
                    mine = SeasonRowsService.Stronger(mine, state);
                    if (state == "declined") continue;
                    variants.Add(want.Input.Variant);
                    if (want.Input.Variant == "standard" && want.Input.Scope is "seasons" or "future" or "next_season")
                        seasons.UnionWith(want.Input.Seasons);
                }
            }
            catch (Exception)
            {
                return LedgerFlags.None;
            }
            return new LedgerFlags(requested, mine, variants.Count == 0 ? null : variants.ToArray(), seasons.Count == 0 ? null : seasons.ToArray());
        }

        /// <summary>The ledger flags of one title for one viewer (see <see cref="Flags"/>).</summary>
        /// <param name="Requested">Someone has an active ask for it.</param>
        /// <param name="Mine">The viewer's own state, or null.</param>
        /// <param name="MineVariants">The copies the viewer's own active asks are for, or null.</param>
        /// <param name="MineSeasons">The seasons the viewer's own active standard asks cover whole, or null.</param>
        internal readonly record struct LedgerFlags(bool Requested, string? Mine, string[]? MineVariants, int[]? MineSeasons)
        {
            /// <summary>Nothing known.</summary>
            public static LedgerFlags None => new(false, null, null, null);
        }

        // ------------------------------------------------------------------ TMDB

        /// <summary>
        /// Parses a TMDB list or search page: movies and series only (people, adult titles and rows
        /// without an id or a name are left out). <paramref name="kind"/> names the rows' kind for
        /// lists of one kind; null reads each row's media_type (search, trending/all).
        /// </summary>
        internal static (List<Row> Rows, int TotalPages) Parse(string? json, string? kind)
        {
            var rows = new List<Row>();
            if (string.IsNullOrWhiteSpace(json)) return (rows, 1);
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(json);
            }
            catch (JsonException)
            {
                return (rows, 1);
            }
            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return (rows, 1);
                var total = root.TryGetProperty("total_pages", out var t) && t.ValueKind == JsonValueKind.Number && t.TryGetInt32(out var pages) ? pages : 1;
                if (!root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return (rows, total);
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var e in results.EnumerateArray())
                {
                    if (e.ValueKind != JsonValueKind.Object) continue;
                    var media = kind ?? Text(e, "media_type");
                    if (media is not ("movie" or "tv")) continue;
                    if (e.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True) continue;
                    if (!e.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.Number || !idElement.TryGetInt32(out var id) || id <= 0) continue;
                    var title = Text(e, media == "movie" ? "title" : "name") ?? Text(e, media == "movie" ? "original_title" : "original_name");
                    if (title == null) continue;
                    if (title.Length > 200) title = title[..200];
                    var key = media + ":tmdb:" + id.ToString(CultureInfo.InvariantCulture);
                    if (!seen.Add(key)) continue;
                    var date = Text(e, media == "movie" ? "release_date" : "first_air_date");
                    int? year = date != null && date.Length >= 4 && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var y) && y > 1800 && y < 3000 ? y : null;
                    var poster = Text(e, "poster_path");
                    var overview = Text(e, "overview");
                    if (overview?.Length > MaxOverview) overview = overview[..(MaxOverview - 1)].TrimEnd() + "…";
                    rows.Add(new Row(key, media, id, title, year, poster != null && PosterPath.IsMatch(poster) ? poster : null, overview));
                }
                return (rows, total);
            }
        }

        private static string? Text(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;

        private static string? Lang(string? language) => language != null && Language.IsMatch(language) ? language : null;

        private static string Query(int page, string? language)
            => "?page=" + page.ToString(CultureInfo.InvariantCulture) + (language == null ? string.Empty : "&language=" + language);

        private Task<string?> Read(string path, string query, CancellationToken ct) => _tmdb(path, query, ct);

        /// <summary>A TMDB read through the shared cache (null when TMDB isn't set up or fails).</summary>
        private static async Task<string?> TmdbAsync(TmdbResponseCache tmdb, string path, string query, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                var response = await tmdb.GetAsync(path, query, key, ct).ConfigureAwait(false);
                return response.IsSuccess ? response.Content : null;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return null;
            }
            catch (System.Net.Http.HttpRequestException)
            {
                return null;
            }
        }

        // ------------------------------------------------------------------ Jellyfin

        /// <summary>
        /// The movies and series the viewer played most recently (newest first) that carry a TMDB id,
        /// one entry per title; empty on any library failure.
        /// </summary>
        private static IReadOnlyList<RecentTitle> RecentlyWatched(ILibraryManager library, StatusViewer viewer, int max)
        {
            if (viewer.Handle is not User user) return Array.Empty<RecentTitle>();
            try
            {
                var items = library.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
                    IsPlayed = true,
                    Recursive = true,
                    OrderBy = new[] { (ItemSortBy.DatePlayed, JSortOrder.Descending) },
                    Limit = 50,
                    DtoOptions = new DtoOptions(false),
                });
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var list = new List<RecentTitle>();
                foreach (var item in items)
                {
                    BaseItem? title = item is Episode episode ? episode.Series : item as Movie;
                    if (title == null || !int.TryParse(title.GetProviderId(MetadataProvider.Tmdb), NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0) continue;
                    var movie = title is Movie;
                    if (!seen.Add((movie ? "m" : "t") + id.ToString(CultureInfo.InvariantCulture))) continue;
                    list.Add(new RecentTitle(movie, id, title.Name ?? string.Empty));
                    if (list.Count >= max) break;
                }
                return list;
            }
            catch (Exception)
            {
                return Array.Empty<RecentTitle>();
            }
        }

        /// <summary>
        /// What the user hid everywhere with Hidden Content (global hides only), for the surfaces whose
        /// filter they have on (Discovery, Search): TMDB ids by kind and Jellyfin item ids.
        /// </summary>
        private static HiddenTitles ReadHidden(UserConfigurationManager config, ILibraryManager library, Guid user)
        {
            var policy = HiddenContentPolicy.Load(config, user, library: library);
            var discovery = policy.GlobalKeys("discovery");
            var search = policy.GlobalKeys("search");
            return discovery.Count + search.Count == 0 ? HiddenTitles.None : new HiddenTitles(discovery, search);
        }

        /// <summary>The hidden sets of a Hidden Content file.</summary>
        internal static HiddenTitles FromHiddenContent(UserHiddenContent? data)
        {
            var settings = data?.Settings ?? new HiddenContentSettings();
            var keys = GlobalHiddenKeys(data);
            if (keys.Count == 0) return HiddenTitles.None;
            var empty = new HashSet<string>();
            return new HiddenTitles(settings.FilterDiscovery ? keys : empty, settings.FilterSearch ? keys : empty);
        }

        /// <summary>
        /// What a Hidden Content file hides everywhere (global scope): title keys (movie:tmdb:N, tv:tmdb:N)
        /// and Jellyfin item ids (32 hex digits). Empty when Hidden Content is off; the caller applies its
        /// own surface switch.
        /// </summary>
        internal static HashSet<string> GlobalHiddenKeys(UserHiddenContent? data)
        {
            return HiddenContentPolicy.Build(data).GlobalKeys();
        }

        private HiddenTitles Hidden(Guid user)
        {
            return _hidden(user);
        }

        // ------------------------------------------------------------------ per-caller cache

        private string CacheKey(StatusViewer viewer, string what, HiddenTitles hidden)
        {
            long ledger;
            try
            {
                ledger = _requests.Ledger.Revision;
            }
            catch (Exception)
            {
                ledger = -1;
            }
            return string.Join("|", viewer.UserId.ToString("N", CultureInfo.InvariantCulture), viewer.PolicyRevision, viewer.HasParentalLimit ? "P" : "-",
                _requests.View.Revision.ToString(CultureInfo.InvariantCulture), ledger.ToString(CultureInfo.InvariantCulture), hidden.Stamp, what);
        }

        private Prepared? Cached(string key)
            => _cache.TryGetValue(key, out var entry) && _now() - entry.At < CacheTtl ? entry.Page : null;

        // Not an answer composed from a copy lookup that reached its bound: the next read looks again.
        private void Store(string key, Prepared answer)
        {
            if (CopyLookupBound.Reached || answer.Ratings.Values.Any(v => v == null)) return;
            var now = _now();
            if (_cache.Count >= MaxCacheEntries)
            {
                foreach (var stale in _cache.Where(e => now - e.Value.At >= CacheTtl).Select(e => e.Key).ToList()) _cache.TryRemove(stale, out _);
                if (_cache.Count >= MaxCacheEntries) _cache.Clear();
            }
            _cache[key] = (now, answer);
        }
    }
}
