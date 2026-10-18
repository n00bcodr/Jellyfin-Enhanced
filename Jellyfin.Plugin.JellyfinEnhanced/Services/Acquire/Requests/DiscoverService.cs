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
        private readonly Func<string, int, Guid, CancellationToken, Task<bool>> _maySeeAbsent;
        private readonly Func<string, string, CancellationToken, Task<string?>> _tmdb;
        private readonly Func<StatusViewer, int, IReadOnlyList<RecentTitle>> _recent;
        private readonly Func<Guid, HiddenTitles> _hidden;
        private readonly Func<DateTimeOffset> _now;
        private readonly ConcurrentDictionary<string, (DateTimeOffset At, DiscoverAnswer Answer)> _cache = new(StringComparer.Ordinal);

        /// <summary>Creates the service over the shared TMDB cache, the parental filter and Jellyfin.</summary>
        public DiscoverService(RequestService requests, TitleAliases aliases, SeerrParentalFilter parental, TmdbResponseCache tmdb, ILibraryManager library, UserConfigurationManager userConfig, SpoilerPresentation? presentation = null)
            : this(requests, aliases,
                (kind, id, user, ct) => parental.MaySeeAbsentAsync(kind, id, user.ToString("N", CultureInfo.InvariantCulture), ct),
                (path, query, ct) => TmdbAsync(tmdb, path, query, ct),
                (viewer, max) => RecentlyWatched(library, viewer, max),
                user => ReadHidden(userConfig, library, user),
                () => DateTimeOffset.UtcNow)
        {
            _presentation = presentation; _userConfig = userConfig; _library = library;
        }

        /// <summary>Creates the service with explicit readers (tests).</summary>
        internal DiscoverService(RequestService requests, TitleAliases? aliases,
            Func<string, int, Guid, CancellationToken, Task<bool>> maySeeAbsent,
            Func<string, string, CancellationToken, Task<string?>> tmdb,
            Func<StatusViewer, int, IReadOnlyList<RecentTitle>> recent,
            Func<Guid, HiddenTitles> hidden,
            Func<DateTimeOffset> now)
        {
            _requests = requests;
            _aliases = aliases;
            _maySeeAbsent = maySeeAbsent;
            _tmdb = tmdb;
            _recent = recent;
            _hidden = hidden;
            _now = now;
        }

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
        public async Task<DiscoverAnswer?> DiscoverAsync(StatusViewer viewer, string list, string type, int page, string? language, CancellationToken ct)
        {
            var lang = Lang(language);
            var hidden = Hidden(viewer.UserId);
            var spoilerRevision = _presentation?.Load(viewer.UserId).Revision;
            var cacheKey = CacheKey(viewer, list + "|" + type + "|" + page + "|" + lang + "|" + spoilerRevision, hidden);
            if (Cached(cacheKey) is { } cached) return await WithPausesAsync(viewer, cached, ct).ConfigureAwait(false);

            DiscoverAnswer? answer;
            if (list == "because")
            {
                var groups = new List<DiscoverGroup>();
                foreach (var seed in _recent(viewer, MaxSeeds).Take(MaxSeeds))
                {
                    var kind = seed.Movie ? "movie" : "tv";
                    var json = await Read($"{kind}/{seed.TmdbId}/recommendations", Query(1, lang), ct).ConfigureAwait(false);
                    if (json == null) continue;
                    var seedKey = kind + ":tmdb:" + seed.TmdbId.ToString(CultureInfo.InvariantCulture);
                    if (hidden.Discovery.Contains(seedKey)) continue;
                    var (rows, _) = Parse(json, kind);
                    var cards = await ProjectAsync(viewer, rows.Where(r => r.Key != seedKey), hidden.Discovery, ct).ConfigureAwait(false);
                    if (cards.Count > 0) groups.Add(new DiscoverGroup { BasedOn = seed.Title.Length > 200 ? seed.Title[..200] : seed.Title, Key = seedKey, Results = cards });
                }
                answer = new DiscoverAnswer { List = list, Type = "all", Page = 1, TotalPages = 1, Groups = groups };
            }
            else
            {
                var path = list switch
                {
                    "trending" => $"trending/{type}/week",
                    "upcoming" => type == "movie" ? "movie/upcoming" : "tv/on_the_air",
                    _ => $"{type}/popular",
                };
                var json = await Read(path, Query(page, lang), ct).ConfigureAwait(false);
                if (json == null) return null;
                var (rows, total) = Parse(json, type);
                var cards = await ProjectAsync(viewer, rows, hidden.Discovery, ct).ConfigureAwait(false);
                answer = new DiscoverAnswer { List = list, Type = type, Page = page, TotalPages = Math.Clamp(total, 1, MaxPage), Results = cards };
            }
            var delivered = await WithPausesAsync(viewer, answer, ct).ConfigureAwait(false);
            // The final gate and insertion are synchronous. An in-flight old snapshot never enters this cache.
            var current = Hidden(viewer.UserId);
            delivered = Present(viewer, delivered, current);
            if (current.Stamp == hidden.Stamp && _presentation?.Load(viewer.UserId).Revision == spoilerRevision) Store(cacheKey, delivered);
            return delivered;
        }

        /// <summary>One page of free-text search (movies and series only), or null when TMDB could not answer.</summary>
        public async Task<DiscoverAnswer?> SearchAsync(StatusViewer viewer, string query, int page, string? language, CancellationToken ct)
        {
            var lang = Lang(language);
            var hidden = Hidden(viewer.UserId);
            var spoilerRevision = _presentation?.Load(viewer.UserId).Revision;
            var cacheKey = CacheKey(viewer, "search|" + page + "|" + lang + "|" + query + "|" + spoilerRevision, hidden);
            if (Cached(cacheKey) is { } cached) return await WithPausesAsync(viewer, cached, ct).ConfigureAwait(false);
            var json = await Read("search/multi", Query(page, lang) + "&include_adult=false&query=" + Uri.EscapeDataString(query), ct).ConfigureAwait(false);
            if (json == null) return null;
            var (rows, total) = Parse(json, null);
            var cards = await ProjectAsync(viewer, rows, hidden.Search, ct).ConfigureAwait(false);
            var answer = new DiscoverAnswer { List = "search", Type = "all", Page = page, TotalPages = Math.Clamp(total, 1, MaxPage), Results = cards };
            var delivered = await WithPausesAsync(viewer, answer, ct).ConfigureAwait(false);
            // The final gate and insertion are synchronous. An in-flight old snapshot never enters this cache.
            var current = Hidden(viewer.UserId);
            delivered = Present(viewer, delivered, current);
            if (current.Stamp == hidden.Stamp && _presentation?.Load(viewer.UserId).Revision == spoilerRevision) Store(cacheKey, delivered);
            return delivered;
        }

        /// <summary>
        /// The answer with each card the caller can't ask for right now because of storage marked (see
        /// <see cref="DiscoverCard.Blocked"/>), title by title: a title Sonarr/Radarr already has is measured on its own
        /// folder's drive, a new one on the default root's. Worked out from what is in memory on every answer (cached
        /// ones too); facts not read yet are only started, so a browse never waits for them.
        /// </summary>
        private async Task<DiscoverAnswer> WithPausesAsync(StatusViewer viewer, DiscoverAnswer answer, CancellationToken ct)
        {
            var cards = answer.Results.Concat(answer.Groups?.SelectMany(g => g.Results) ?? Enumerable.Empty<DiscoverCard>());
            var paused = await _requests.StoragePausesAsync(viewer.UserId, cards.Select(c => c.Key), false, ct).ConfigureAwait(false);
            DiscoverCard Mark(DiscoverCard card) => card with { Blocked = paused.TryGetValue(card.Key, out var block) ? block : null };
            return Present(viewer, answer with
            {
                Results = answer.Results.Select(Mark).ToList(),
                Groups = answer.Groups?.Select(g => g with { Results = g.Results.Select(Mark).ToList() }).ToList(),
            }, Hidden(viewer.UserId));
        }

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

        /// <summary>
        /// The rows the viewer may see, with library and request flags: parental checks run in
        /// parallel (bounded), the order of the page is kept.
        /// </summary>
        private async Task<IReadOnlyList<DiscoverCard>> ProjectAsync(StatusViewer viewer, IEnumerable<Row> rows, IReadOnlySet<string> hidden, CancellationToken ct)
        {
            var list = rows.Where(r => !hidden.Contains(r.Key)).ToList();
            var tasks = list.Select(row => CardAsync(viewer, row, hidden, ct)).ToList();
            var cards = await Task.WhenAll(tasks).ConfigureAwait(false);
            return cards.Where(c => c != null).Select(c => c!).Take(MaxResults).ToList();
        }

        private async Task<DiscoverCard?> CardAsync(StatusViewer viewer, Row row, IReadOnlySet<string> hidden, CancellationToken ct)
        {
            var key = TitleKey.Parse(row.Key)!;
            var aliases = _aliases?.Of(key) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>();
            var copies = _requests.View.Copies(key, viewer, aliases);
            var open = copies.FirstOrDefault(c => c.Visible);
            if (viewer.HasParentalLimit)
            {
                // A copy Jellyfin hides from them (rating, tags or library) hides the title; an absent
                // title needs a verified rating they may see.
                if (copies.Count > 0 ? open == null : !await MaySeeAsync(row.Kind, row.TmdbId, viewer.UserId, ct).ConfigureAwait(false)) return null;
            }
            var itemId = open?.ItemId.ToString("N", CultureInfo.InvariantCulture);
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

        private async Task<bool> MaySeeAsync(string kind, int tmdbId, Guid user, CancellationToken ct)
        {
            await ParentalSlots.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                return await _maySeeAbsent(kind, tmdbId, user, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                ParentalSlots.Release();
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

        private DiscoverAnswer? Cached(string key)
            => _cache.TryGetValue(key, out var entry) && _now() - entry.At < CacheTtl ? entry.Answer : null;

        private void Store(string key, DiscoverAnswer answer)
        {
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
