using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>One entry of a fetched list, in list order, with whatever ids the source provides.</summary>
    /// <param name="MediaType">"movie" or "tv".</param>
    /// <param name="TmdbId">TMDB id (movie, or the show for TV entries).</param>
    /// <param name="ImdbId">IMDb id (movie, or the show for TV entries).</param>
    /// <param name="TvdbId">TVDB id of the show.</param>
    /// <param name="Title">Title (the show's for season/episode entries).</param>
    /// <param name="Year">Year.</param>
    /// <param name="Season">Season (season/episode entries).</param>
    /// <param name="Episode">Episode (episode entries).</param>
    /// <param name="Note">The list's note for the entry.</param>
    public sealed record SourceItem(string MediaType, int? TmdbId, string? ImdbId, int? TvdbId, string? Title, int? Year, int? Season, int? Episode, string? Note)
    {
        /// <summary>The provenance key (F1), or null when the entry has no usable id.</summary>
        public string? Key => SourceKeys.For(this);

        /// <summary>Exact metadata from sources that publish it (Chronolists), so entries are built without a lookup.</summary>
        public SourceItemDetails? Details { get; init; }
    }

    /// <summary>Metadata a source publishes next to the ids (all optional, already validated).</summary>
    /// <param name="EpisodeTitle">Episode title (episode entries).</param>
    /// <param name="Date">Release date (movie) or air date (episode), yyyy-MM-dd.</param>
    /// <param name="PosterPath">TMDB poster path (the movie's, or the season's for episode entries).</param>
    /// <param name="Overview">Overview (movies).</param>
    /// <param name="SeasonName">Season name (episode entries).</param>
    public sealed record SourceItemDetails(string? EpisodeTitle, string? Date, string? PosterPath, string? Overview, string? SeasonName);

    /// <summary>Outcome of fetching one list.</summary>
    public sealed class SourceFetchResult
    {
        /// <summary>Whether the fetch completed (all pages read up to the cap).</summary>
        public bool Ok { get; init; }

        /// <summary>Machine error code when not Ok (see <see cref="SourceFailures"/>).</summary>
        public string? ErrorCode { get; init; }

        /// <summary>Human message when not Ok.</summary>
        public string? Message { get; init; }

        /// <summary>Upstream asked to retry after this many seconds.</summary>
        public int? RetryAfterSeconds { get; init; }

        /// <summary>Source kind.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>The upstream used (mdblist, mdblist-api, tmdb, seerr, trakt, imdb, chronolists).</summary>
        public string Provider { get; init; } = string.Empty;

        /// <summary>Canonical URL.</summary>
        public string CanonicalUrl { get; init; } = string.Empty;

        /// <summary>List title.</summary>
        public string? Title { get; init; }

        /// <summary>Unofficial access path (IMDb).</summary>
        public bool Unofficial { get; init; }

        /// <summary>A notice the review must show (<c>imdb_unofficial</c>, <c>seerr_fallback</c>, <c>mdblist_api</c>).</summary>
        public string? Notice { get; init; }

        /// <summary>Entries in list order (≤ <see cref="ListSourceFetcher.MaxItems"/>; exact sources ≤ <see cref="ChronolistsPage.MaxItems"/>).</summary>
        public IReadOnlyList<SourceItem> Items { get; init; } = Array.Empty<SourceItem>();

        /// <summary>Entries the source has (when known).</summary>
        public int Total { get; init; }

        /// <summary>More than the cap: the snapshot is incomplete (sync then never removes anything).</summary>
        public bool Truncated { get; init; }

        /// <summary>
        /// The upstream answered only partly (e.g. IMDb GraphQL errors next to data, unreadable Chronolists entries, a TMDB
        /// list that changed while its pages were read): entries may be missing anywhere in the list, so, like
        /// <see cref="Truncated"/>, a sync adds but never removes or replaces its snapshot (F2).
        /// </summary>
        public bool Partial { get; init; }

        /// <summary>
        /// Every entry carries exact TMDB ids and the metadata a placeholder needs (<see cref="SourceItem.Details"/>):
        /// entries are grouped (runs of episodes) and built without title lookups (Chronolists).
        /// </summary>
        public bool Exact { get; init; }

        /// <summary>An error result.</summary>
        /// <param name="source">Source.</param>
        /// <param name="code">Code.</param>
        /// <param name="message">Message.</param>
        /// <param name="retryAfter">Retry-After seconds.</param>
        /// <returns>The result.</returns>
        public static SourceFetchResult Fail(ParsedSourceUrl source, string code, string message, int? retryAfter = null) =>
            new() { Ok = false, ErrorCode = code, Message = message, RetryAfterSeconds = retryAfter, Kind = source.Kind, CanonicalUrl = source.CanonicalUrl };
    }

    /// <summary>Typed fetch failure codes (list-operation outcomes, never title acquisition reasons).</summary>
    public static class SourceFailures
    {
        /// <summary>The provider's own switch (or From URL) is off: nothing was contacted.</summary>
        public const string ProviderDisabled = "provider_disabled";

        /// <summary>IMDb's unofficial source is not opted in: nothing was contacted.</summary>
        public const string ImdbDisabled = "imdb_disabled";

        /// <summary>Trakt has no client id: typed unavailable, nothing was contacted.</summary>
        public const string TraktNotConfigured = "trakt_not_configured";

        /// <summary>The list is not served publicly by MDBList (an administrator may read it deliberately through the API).</summary>
        public const string MdblistNotPublic = "mdblist_not_public";

        /// <summary>The link is pinned to a provider that can't be used now; JE never switches to another one silently.</summary>
        public const string ProviderPinned = "provider_pinned";

        /// <summary>A source that must have entries answered none (an unofficial source's empty parse is never "empty").</summary>
        public const string SourceEmpty = "source_empty";

        /// <summary>The per-provider read budget is used up (try again later).</summary>
        public const string ReadBudgetExhausted = "read_budget_exhausted";

        /// <summary>The list site answered with a redirect, which is never followed.</summary>
        public const string Redirected = "source_redirected";

        /// <summary>The list site's host resolved to a non-public address: nothing was sent.</summary>
        public const string AddressBlocked = "source_address_blocked";
    }

    /// <summary>Provenance keys of source entries (F1): <c>type|id|season|episode</c>, never the list rank.</summary>
    public static class SourceKeys
    {
        private static readonly Regex KeyRegex = new(@"^(?:(?:movie|tv)\|[0-9]{1,9}|imdb\|tt[0-9]{5,10}|tvdb\|[0-9]{1,9})\|(?:[0-9]{1,3})?\|(?:[0-9]{1,4})?$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>Key of an entry: TMDB first, else IMDb, else TVDB; null without an id.</summary>
        /// <param name="item">Entry.</param>
        /// <returns>Key or null.</returns>
        public static string? For(SourceItem item)
        {
            string head;
            if (item.TmdbId is > 0)
            {
                head = item.MediaType + "|" + item.TmdbId.Value.ToString(CultureInfo.InvariantCulture);
            }
            else if (!string.IsNullOrEmpty(item.ImdbId))
            {
                head = "imdb|" + item.ImdbId;
            }
            else if (item.TvdbId is > 0 && item.MediaType == "tv")
            {
                head = "tvdb|" + item.TvdbId.Value.ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                return null;
            }

            var key = head + "|" + item.Season?.ToString(CultureInfo.InvariantCulture) + "|" + item.Episode?.ToString(CultureInfo.InvariantCulture);
            return IsValid(key) ? key : null;
        }

        /// <summary>Whether a client-supplied key has the key format.</summary>
        /// <param name="key">Key.</param>
        /// <returns>Valid.</returns>
        public static bool IsValid(string? key) => key != null && key.Length <= 40 && KeyRegex.IsMatch(key);

        /// <summary>The season and episode of an episode key (<c>…|season|episode</c>), else null.</summary>
        /// <param name="key">Key.</param>
        /// <returns>The coordinate or null.</returns>
        public static (int Season, int Episode)? EpisodeOf(string key)
        {
            var parts = key.Split('|');
            return parts.Length == 4
                && int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var season)
                && int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var episode)
                ? (season, episode)
                : null;
        }
    }

    /// <summary>Fetch options.</summary>
    public sealed class SourceFetchOptions
    {
        /// <summary>
        /// An administrator's deliberate MDBList API read (private lists through JE's key; needs the API switch). Never
        /// set for anyone else, never a fallback of the public read.
        /// </summary>
        public bool AllowMdblistApi { get; init; }

        /// <summary>Linked sources: the provider stored at link time; never switched silently (F4).</summary>
        public string? Provider { get; init; }

        /// <summary>Skip the short result cache (sync: the list as it is now).</summary>
        public bool Fresh { get; init; }

        /// <summary>
        /// The user an interactive fetch is for ("N"): fetches that miss the result cache are limited per caller. Null for
        /// background work (the sync), which runs once per list at a time.
        /// </summary>
        public string? Caller { get; init; }

        /// <summary>Background work (scheduled sync): yields to interactive reads in the read budget's queue.</summary>
        public bool Background { get; init; }
    }

    /// <summary>Fetches list URLs. Production: <see cref="ListSourceFetcher"/>.</summary>
    public interface IListSourceFetcher
    {
        /// <summary>Fetches a recognised list.</summary>
        /// <param name="source">Parsed URL.</param>
        /// <param name="options">Options.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The result.</returns>
        Task<SourceFetchResult> FetchAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken);

        /// <summary>Which providers can work with the current configuration, for this caller.</summary>
        /// <param name="caller">The caller (administrators also learn whether the MDBList API path works).</param>
        /// <returns>Capabilities (no secrets).</returns>
        SourceProvidersDto Providers(User caller);
    }

    /// <summary>
    /// The read budget of list sources, as plain parameters (4c2b wires them to the common automation admission, 4a's
    /// <c>source_fetch</c> budget, for the scheduled sync): how many upstream reads run at once, per caller, and per
    /// provider per rolling hour. A read that the budget refuses is a typed failure, never a silent skip.
    /// </summary>
    public sealed class SourceReadLimits
    {
        /// <summary>Upstream list reads running at once, server-wide.</summary>
        public int MaxConcurrent { get; init; } = 3;

        /// <summary>Upstream reads one interactive caller may have running at once.</summary>
        public int MaxConcurrentPerCaller { get; init; } = 2;

        /// <summary>Upstream reads one interactive caller may start within <see cref="CallerWindow"/>.</summary>
        public int MaxPerCaller { get; init; } = 10;

        /// <summary>The window of <see cref="MaxPerCaller"/>.</summary>
        public TimeSpan CallerWindow { get; init; } = TimeSpan.FromMinutes(5);

        /// <summary>
        /// Upstream reads per provider per rolling hour (every page counts as one read; a cached answer costs nothing).
        /// A provider not listed has <see cref="DefaultPerProviderPerHour"/>.
        /// </summary>
        public IReadOnlyDictionary<string, int> PerProviderPerHour { get; init; } = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["mdblist"] = 120,
            ["mdblist-api"] = 30,
            ["tmdb"] = 600,
            ["seerr"] = 120,
            ["trakt"] = 300,
            ["imdb"] = 60,
            ["chronolists"] = 60,
        };

        /// <summary>Per-provider hourly reads for a provider not in <see cref="PerProviderPerHour"/>.</summary>
        public int DefaultPerProviderPerHour { get; init; } = 60;

        /// <summary>The hourly budget of a provider.</summary>
        /// <param name="provider">Provider.</param>
        /// <returns>Reads per hour.</returns>
        public int PerHour(string provider) => PerProviderPerHour.TryGetValue(provider, out var limit) ? limit : DefaultPerProviderPerHour;
    }

    /// <summary>
    /// The admission seam of upstream list reads (one call per upstream request). The default
    /// (<see cref="RollingSourceReadAdmission"/>) keeps the per-provider hourly budgets of <see cref="SourceReadLimits"/>
    /// in memory; 4c2b replaces it with the durable automation budget for background work.
    /// </summary>
    public interface ISourceReadAdmission
    {
        /// <summary>Admits one upstream read of <paramref name="provider"/>, or refuses with the seconds until one is allowed.</summary>
        /// <param name="provider">Provider (mdblist, tmdb, …).</param>
        /// <param name="background">Background work (the sync).</param>
        /// <param name="retryAfterSeconds">Seconds until a read is allowed again (when refused).</param>
        /// <returns>Whether the read may go out.</returns>
        bool TryAdmit(string provider, bool background, out int retryAfterSeconds);
    }

    /// <summary>Rolling per-provider hourly read budgets in memory (thread-safe).</summary>
    public sealed class RollingSourceReadAdmission : ISourceReadAdmission
    {
        private readonly SourceReadLimits _limits;
        private readonly Func<DateTime> _now;
        private readonly Dictionary<string, Queue<DateTime>> _reads = new(StringComparer.Ordinal);

        /// <summary>Creates the admission.</summary>
        /// <param name="limits">Limits.</param>
        /// <param name="now">Clock (tests).</param>
        public RollingSourceReadAdmission(SourceReadLimits limits, Func<DateTime>? now = null)
        {
            _limits = limits;
            _now = now ?? (() => DateTime.UtcNow);
        }

        /// <inheritdoc />
        public bool TryAdmit(string provider, bool background, out int retryAfterSeconds)
        {
            lock (_reads)
            {
                var now = _now();
                if (!_reads.TryGetValue(provider, out var reads))
                {
                    _reads[provider] = reads = new Queue<DateTime>();
                }

                while (reads.Count > 0 && reads.Peek() <= now.AddHours(-1))
                {
                    reads.Dequeue();
                }

                // Background work keeps a quarter of each budget free for people waiting on a review.
                var limit = _limits.PerHour(provider);
                var allowed = background ? limit - (limit / 4) : limit;
                if (reads.Count >= allowed)
                {
                    retryAfterSeconds = reads.Count == 0 ? 3600 : Math.Max(1, (int)Math.Ceiling((reads.Peek().AddHours(1) - now).TotalSeconds));
                    return false;
                }

                reads.Enqueue(now);
                retryAfterSeconds = 0;
                return true;
            }
        }
    }

    /// <summary>
    /// What a fetched snapshot of a source is good for (tombstone-ready: 4c2b's sync keeps the last COMPLETE snapshot's
    /// keys, the editor's tombstones and the source's ownership, and only a complete, non-empty-after-non-empty snapshot
    /// may remove entries or replace the last one).
    /// </summary>
    public enum SnapshotState
    {
        /// <summary>Every entry was read: it may replace the last snapshot and drive removals.</summary>
        Complete,

        /// <summary>The source answered only partly: additions only, never removals or replacing the last snapshot.</summary>
        Partial,

        /// <summary>The source has more entries than the cap: additions only.</summary>
        Truncated,

        /// <summary>The fetch failed (typed code): nothing at all.</summary>
        Failed,

        /// <summary>The source's format changed (e.g. Chronolists): nothing at all until JE's reader is repaired.</summary>
        ShapeChanged,

        /// <summary>The source answered empty after an earlier non-empty snapshot: treated as a failure, nothing at all.</summary>
        EmptyAfterNonEmpty,
    }

    /// <summary>A snapshot's verdict, with the two decisions 4c2b's apply makes from it.</summary>
    /// <param name="State">State.</param>
    /// <param name="Code">The failure or limitation code (null when complete).</param>
    public sealed record SnapshotVerdict(SnapshotState State, string? Code)
    {
        /// <summary>New entries may be added from this snapshot.</summary>
        public bool MayAdd => State is SnapshotState.Complete or SnapshotState.Partial or SnapshotState.Truncated;

        /// <summary>Entries that left the source may be removed, and this snapshot may replace the last complete one.</summary>
        public bool MayRemoveAndReplace => State == SnapshotState.Complete;
    }

    /// <summary>The snapshot rules (pure).</summary>
    public static class SourceSnapshots
    {
        /// <summary>
        /// Classifies a fetch against the last complete snapshot: failed / shape changed / empty after non-empty refuse
        /// everything; truncated and partial allow additions only; complete allows removals and replacing the snapshot.
        /// </summary>
        /// <param name="fetched">The fetch.</param>
        /// <param name="lastCompleteKeys">Keys of the last complete snapshot (null or empty: none yet).</param>
        /// <returns>The verdict.</returns>
        public static SnapshotVerdict Classify(SourceFetchResult fetched, IReadOnlyCollection<string>? lastCompleteKeys)
        {
            if (!fetched.Ok)
            {
                return new SnapshotVerdict(fetched.ErrorCode == ChronolistsPage.FormatChanged ? SnapshotState.ShapeChanged : SnapshotState.Failed, fetched.ErrorCode ?? "upstream_error");
            }

            var keyed = fetched.Items.Count(i => i.Key != null);
            if (keyed == 0 && lastCompleteKeys is { Count: > 0 })
            {
                return new SnapshotVerdict(SnapshotState.EmptyAfterNonEmpty, "empty_after_nonempty");
            }

            if (fetched.Truncated)
            {
                return new SnapshotVerdict(SnapshotState.Truncated, "truncated");
            }

            return fetched.Partial ? new SnapshotVerdict(SnapshotState.Partial, "partial") : new SnapshotVerdict(SnapshotState.Complete, null);
        }

        /// <summary>The ordered, distinct keys of a fetch (what a snapshot stores).</summary>
        /// <param name="fetched">The fetch.</param>
        /// <returns>Keys in source order.</returns>
        public static IReadOnlyList<string> Keys(SourceFetchResult fetched)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            return fetched.Items.Select(i => i.Key).OfType<string>().Where(seen.Add).ToList();
        }

        /// <summary>A digest of the ordered keys (membership or order changed = another digest).</summary>
        /// <param name="keys">Keys in order.</param>
        /// <returns>Hex digest (16 characters).</returns>
        public static string Digest(IEnumerable<string> keys) =>
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', keys))), 0, 8).ToLowerInvariant();

        /// <summary>The client description of a successful fetch (state and digest; no keys of entries the caller can't see).</summary>
        /// <param name="fetched">The fetch.</param>
        /// <returns>The description.</returns>
        public static SourceSnapshotDto Describe(SourceFetchResult fetched) => Describe(fetched, Keys(fetched), false);

        /// <summary>
        /// The client description of what a reply actually carries (4c2-B3): the digest of <paramref name="represented"/>
        /// (the keys after every cap and filter), and a state that is never "complete" unless the reply carries every key
        /// of the fetch: a cap makes it truncated, any other key left out partial (both: additions only).
        /// </summary>
        /// <param name="fetched">The fetch.</param>
        /// <param name="represented">The keys the reply carries, in order.</param>
        /// <param name="capped">The reply was capped (it stands for the first part of the list).</param>
        /// <returns>The description.</returns>
        public static SourceSnapshotDto Describe(SourceFetchResult fetched, IReadOnlyList<string> represented, bool capped)
        {
            var verdict = Classify(fetched, null);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var keys = represented.Where(seen.Add).ToList();
            var all = Keys(fetched);
            var whole = keys.Count == all.Count && all.All(seen.Contains);
            var state = verdict.State == SnapshotState.Truncated || capped ? "truncated"
                : verdict.State == SnapshotState.Partial || !whole ? "partial"
                : "complete";
            return new SourceSnapshotDto { State = state, Digest = Digest(keys) };
        }

        /// <summary>
        /// The keys a sync may add from a fetch: in source order, not in the list already (<paramref name="present"/>), not
        /// removed by an editor (<paramref name="tombstones"/>). Removals are only planned when the verdict allows them:
        /// keys of the last complete snapshot that left the source and that the source itself owns (never a manual entry
        /// or another key's shared occurrence).
        /// </summary>
        /// <param name="fetched">The fetch.</param>
        /// <param name="verdict">Its verdict (<see cref="Classify"/>).</param>
        /// <param name="lastCompleteKeys">Keys of the last complete snapshot.</param>
        /// <param name="present">Keys that already have an entry in the list.</param>
        /// <param name="tombstones">Keys an editor removed (never re-added).</param>
        /// <param name="owned">Keys whose entries the source added (the only ones it may remove).</param>
        /// <returns>Keys to add, keys whose entries may be removed.</returns>
        public static (IReadOnlyList<string> Add, IReadOnlyList<string> Drop) Plan(
            SourceFetchResult fetched,
            SnapshotVerdict verdict,
            IReadOnlyCollection<string>? lastCompleteKeys,
            IReadOnlySet<string> present,
            IReadOnlySet<string> tombstones,
            IReadOnlySet<string> owned)
        {
            if (!verdict.MayAdd)
            {
                return (Array.Empty<string>(), Array.Empty<string>());
            }

            var keys = Keys(fetched);
            var add = keys.Where(k => !present.Contains(k) && !tombstones.Contains(k)).ToList();
            if (!verdict.MayRemoveAndReplace || lastCompleteKeys == null)
            {
                return (add, Array.Empty<string>());
            }

            var now = keys.ToHashSet(StringComparer.Ordinal);
            var drop = lastCompleteKeys.Where(k => !now.Contains(k) && owned.Contains(k)).Distinct(StringComparer.Ordinal).ToList();
            return (add, drop);
        }
    }
}
