using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Serves title statuses to the status routes: resolves the Jellyfin items for the viewer, reads
    /// the arr snapshots from memory (never calling an arr on the request; a cold snapshot is loaded
    /// in the background and waited for, bounded), composes per viewer and caches the serialized body
    /// per user. Phase 1 of "Requests &amp; downloads".
    /// </summary>
    public sealed class ArrStatusService
    {
        /// <summary>Most Jellyfin item ids per batch request.</summary>
        public const int MaxIds = 100;

        /// <summary>Most title keys per batch request.</summary>
        public const int MaxKeys = 50;

        private static readonly TimeSpan TimeBucket = TimeSpan.FromMinutes(10);

        private static readonly JsonSerializerOptions Json = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private static readonly ConditionalWeakTable<ArrQueueSnapshot, ILookup<int, ArrQueueEntry>> QueueIndex = new();
        private static readonly ConditionalWeakTable<ArrHistorySnapshot, ILookup<int, ArrHistoryEntry>> HistoryIndex = new();

        private readonly ArrStateStore _store;
        private readonly IArrJellyfinView _view;
        private readonly IArrRequestFacts _requests;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly ArrChangeFeed? _feed;
        private readonly TitleAliases _aliases;
        private readonly ArrInstanceLibraries _libraries;

        /// <summary>The service for a Jellyfin installation (DI).</summary>
        public ArrStatusService(ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests, ArrChangeFeed feed, ArrInstanceLibraries libraries)
            : this(store, view, requests, null, null, feed, libraries)
        {
        }

        /// <summary>A service with explicit configuration, clock and change feed (tests).</summary>
        internal ArrStatusService(ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, ArrChangeFeed? feed = null, ArrInstanceLibraries? libraries = null)
        {
            _store = store;
            _view = view;
            _requests = requests;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _feed = feed;
            _libraries = libraries ?? new ArrInstanceLibraries(store, () => Array.Empty<JfLibraryRoot>(), _now);
            _aliases = new TitleAliases(store, requests as SeerrRequestReadModel);
            Editions = new EditionAvailability(view, _config, CopiesOf);
        }

        /// <summary>
        /// Edition availability over this service's Jellyfin view and title aliases: the one source-level answer to
        /// "does the viewer have edition E of this scope" (see <see cref="EditionAvailability"/>).
        /// </summary>
        public EditionAvailability Editions { get; }

        /// <summary>The per-user body cache.</summary>
        public ArrStatusCache Cache { get; } = new();

        /// <summary>The arr state store (for the request counter).</summary>
        public ArrStateStore Store => _store;

        /// <summary>The Jellyfin view.</summary>
        public IArrJellyfinView View => _view;

        /// <summary>True when "Requests &amp; downloads" and its phase 1 (status on pages) are both on.</summary>
        public bool Enabled => _config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true };

        /// <summary>
        /// Statuses for poster cards and other compact surfaces: Jellyfin items by id (items the viewer
        /// cannot see are left out) and titles by key (movie and series keys).
        /// </summary>
        public Task<StatusBody> ForBatchAsync(StatusViewer viewer, IReadOnlyList<Guid> ids, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken)
        {
            var titleKeys = keys.Where(k => !k.Season.HasValue).Distinct().ToList();
            return GatedAsync(
                viewer,
                v =>
                {
                    var items = BatchItems(v, ids);
                    return GatherAsync(v, items.Select(i => i.Key!.Title).Concat(titleKeys), loadEpisodes: null, peekEpisodes: items.Where(i => i.Kind is "season" or "episode").Select(i => i.Key!.Title), cancellationToken);
                },
                // The items as the viewer can open them now (only titles whose facts were read).
                (now, gather) => BatchBody(now, BatchItems(now, ids).Where(i => gather.Facts.ContainsKey(i.Key!.Title)).ToList(), titleKeys, gather),
                refused => Nothing(refused, "batch"));
        }

        /// <summary>The batch's Jellyfin items the viewer can see (with a key), once each.</summary>
        private List<JfItemRef> BatchItems(StatusViewer viewer, IReadOnlyList<Guid> ids)
        {
            var items = new List<JfItemRef>();
            foreach (var id in ids.Distinct())
            {
                if (_view.Resolve(id, viewer) is { Key: not null } item) items.Add(item);
            }
            return items;
        }

        /// <summary>The cards body from gathered facts, for the viewer past the final gate.</summary>
        private StatusBody BatchBody(StatusViewer viewer, List<JfItemRef> items, List<TitleKey> titleKeys, Gathered gather)
        {
            var cacheKey = CacheKey(viewer, "batch", string.Join(",", items.Select(i => i.ItemId.ToString("N", CultureInfo.InvariantCulture)).OrderBy(x => x, StringComparer.Ordinal))
                + "|" + string.Join(",", titleKeys.Select(k => k.ToString()).OrderBy(x => x, StringComparer.Ordinal)), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var statuses = new List<TitleStatus>();
            var seriesEpisodes = new Dictionary<Guid, IReadOnlyList<JfEpisode>>();
            var titleCopies = new Dictionary<TitleKey, IReadOnlyList<JfCopy>>();
            // A series, season or episode card is of one series copy: it reads the Sonarr that owns that copy's folder. The
            // copies the gather read for the viewer serve (the final gate kept their policy), so a page of posters reads
            // each title's copies once.
            IReadOnlyList<JfCopy>? SeriesCopiesOf(TitleFacts facts)
            {
                if (!facts.Copies.Any(x => x.Series != null)) return null;
                if (!titleCopies.TryGetValue(facts.Key, out var found)) titleCopies[facts.Key] = found = gather.Copies.GetValueOrDefault(facts.Key) ?? CopiesOf(facts.Key, viewer);
                return found;
            }
            foreach (var item in items)
            {
                var facts = gather.Facts[item.Key!.Title];
                var added = statuses.Count;
                switch (item.Kind)
                {
                    case "movie":
                        statuses.Add(StatusComposer.Movie(facts, item, null, c, detail: false));
                        break;
                    case "series":
                        statuses.Add(StatusComposer.SeriesCard(facts, item, c, HiddenFromViewer(facts, item.ItemId, viewer), SeriesCopiesOf(facts)));
                        break;
                    case "season":
                        if (item.SeriesId is not Guid seriesId) break;
                        if (!seriesEpisodes.TryGetValue(seriesId, out var jf))
                        {
                            jf = _view.Episodes(seriesId, null, viewer, includeVirtual: false);
                            seriesEpisodes[seriesId] = jf;
                        }
                        statuses.Add(StatusComposer.Season(facts, item, jf, c, detail: false, SeriesCopiesOf(facts), seriesId));
                        break;
                    case "episode":
                        statuses.Add(StatusComposer.Episode(facts, item, c, detail: false, SeriesCopiesOf(facts), item.SeriesId));
                        break;
                }
                if (statuses.Count > added) WithLiveKey(statuses[^1], facts);
            }
            foreach (var key in titleKeys)
            {
                var facts = gather.Facts[key];
                var copies = CopiesOf(key, viewer);
                // Absent titles require an openable destination or the viewer's own request.
                // Jellyfin copies retain their own content and library visibility decision.
                if (!MayAskByKey(viewer, key, copies)) continue;
                statuses.Add(WithLiveKey(key.IsMovie
                    ? StatusComposer.Movie(facts, null, copies, c, detail: false)
                    : StatusComposer.SeriesByKey(facts, copies, c, copies.FirstOrDefault(x => x.Visible) is { } shown ? HiddenFromViewer(facts, shown.ItemId, viewer) : null), facts));
            }
            return Cache.Put(cacheKey, Serialize(statuses));
        }

        /// <summary>The empty answer for an item id (the same body an item the viewer can't see gets).</summary>
        public StatusBody Empty(StatusViewer viewer, Guid itemId)
        {
            var none = CacheKey(viewer, "item", itemId.ToString("N", CultureInfo.InvariantCulture), "none");
            return Cache.Get(none) ?? Cache.Put(none, Serialize(Array.Empty<TitleStatus>()));
        }

        /// <summary>
        /// The full status of one Jellyfin item for its details page (journey, seasons or episodes).
        /// No statuses (an empty list) when the viewer can't see the item, it is not a movie, series,
        /// season or episode, or it has no provider id: one quiet, cacheable answer for all three, so a
        /// details page of a person, collection or album costs one cheap request and no error.
        /// </summary>
        public Task<StatusBody> ForItemAsync(StatusViewer viewer, Guid itemId, CancellationToken cancellationToken)
            => GatedAsync(
                viewer,
                v => PrepareItemAsync(v, itemId, load: true, cancellationToken),
                (now, gather) => gather != null && ItemNow(now, itemId, gather) is { } item ? ItemBody(now, item, gather) : Empty(now, itemId),
                refused => Empty(refused, itemId));

        /// <summary>
        /// The arr reads for one Jellyfin item's status: null when the viewer can't see it or it has no key. Episode
        /// lists are read (<paramref name="load"/>) or only taken from memory.
        /// </summary>
        private async Task<Gathered?> PrepareItemAsync(StatusViewer viewer, Guid itemId, bool load, CancellationToken cancellationToken)
        {
            if (_view.Resolve(itemId, viewer) is not { Key: not null } item) return null;
            var title = item.Key.Title;
            var episodes = item.Kind is "series" or "season" or "episode" ? new[] { title } : Array.Empty<TitleKey>();
            return await GatherAsync(viewer, new[] { title }, loadEpisodes: load ? episodes : null, peekEpisodes: load ? null : episodes, cancellationToken).ConfigureAwait(false);
        }

        /// <summary>The item as the viewer (past the final gate) can open it now, when its facts were read; else null.</summary>
        private JfItemRef? ItemNow(StatusViewer viewer, Guid itemId, Gathered gather)
            => _view.Resolve(itemId, viewer) is { Key: not null } item && gather.Facts.ContainsKey(item.Key.Title) ? item : null;

        /// <summary>The details-page body of one item from gathered facts, for the viewer past the final gate.</summary>
        private StatusBody ItemBody(StatusViewer viewer, JfItemRef item, Gathered gather)
        {
            var title = item.Key!.Title;
            var cacheKey = CacheKey(viewer, "item", item.ItemId.ToString("N", CultureInfo.InvariantCulture), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            // A missing (virtual) episode or season whose file has arrived: Jellyfin adds the file's item
            // under a new id and drops the virtual one at its next series refresh. Until then the page of
            // the virtual item reads as the arrived one and names it, so the page can move there.
            if (item.Virtual && item.Kind is "episode" or "season" && ScopeItem(viewer, item.Key, item.SeriesId) is { Virtual: false } arrived && arrived.ItemId != item.ItemId)
            {
                var status = WithVersions(ComposeItem(viewer, arrived, gather), arrived, viewer);
                status.OpenItemId = arrived.ItemId.ToString("N", CultureInfo.InvariantCulture);
                return Cache.Put(cacheKey, Serialize(new[] { status }));
            }

            // A movie or episode whose file Jellyfin now keeps as a version of another item (a higher resolution
            // file joined it and became the item): the page reads as that item and names it.
            if (item.PrimaryId is Guid primaryId && _view.Resolve(primaryId, viewer) is { Key: not null } primary && primary.Key.Title.Equals(title) && primary.Kind == item.Kind)
            {
                var status = WithVersions(ComposeItem(viewer, primary, gather), primary, viewer);
                status.OpenItemId = primary.ItemId.ToString("N", CultureInfo.InvariantCulture);
                return Cache.Put(cacheKey, Serialize(new[] { status }));
            }

            return Cache.Put(cacheKey, Serialize(new[] { WithVersions(ComposeItem(viewer, item, gather), item, viewer) }));
        }

        /// <summary>
        /// A movie or episode status with how many versions Jellyfin plays its item from for the viewer (none for a
        /// missing one): only versions whose own item they can open count (a version in a library they can't open, or
        /// above their parental limit, isn't theirs, and its arrival tells them nothing). Sources are read only when
        /// Jellyfin has more than one.
        /// </summary>
        private TitleStatus WithVersions(TitleStatus status, JfItemRef item, StatusViewer viewer)
        {
            if (item.Kind is "movie" or "episode" && !item.Virtual && item.Versions > 0)
                status.Versions = item.Versions > 1 ? Math.Max(1, _view.Sources(item.ItemId, viewer).Select(s => s.BackingItemId).Distinct().Count()) : item.Versions;
            return status;
        }

        /// <summary>The details-page status of one resolved item from gathered facts (no caching).</summary>
        private TitleStatus ComposeItem(StatusViewer viewer, JfItemRef item, Gathered gather)
        {
            var title = item.Key!.Title;
            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var facts = gather.Facts[title];
            // The Jellyfin copies tell which Sonarr copy owns the page's own series copy (its arr facts are that copy's,
            // never another instance's: none when that can't be told), and admins see every Sonarr holding it and which
            // are in the library.
            var seriesCopies = item.Kind != "movie" && facts.Copies.Any(x => x.Series != null) ? CopiesOf(title, viewer) : null;
            var page = item.Kind == "series" ? item.ItemId : item.SeriesId;
            TitleStatus status;
            switch (item.Kind)
            {
                case "movie":
                {
                    var copies = CopiesOf(title, viewer);
                    status = StatusComposer.Movie(facts, item, copies, c, detail: true);
                    // Get 4K is pointless when a copy the viewer can open (this one or another library's) has a 4K source.
                    if (Editions.Movie(viewer, copies, Edition.FourK).Count > 0) status.FourK = true;
                    break;
                }
                case "series":
                    status = StatusComposer.Series(facts, item, _view.Episodes(item.ItemId, null, viewer, includeVirtual: false), _view.Seasons(item.ItemId, viewer), c, detail: true, seriesCopies, page);
                    status.AskedSeasons = AskedSeasons(facts);
                    break;
                case "season":
                    status = StatusComposer.Season(facts, item, item.SeriesId is Guid sid ? _view.Episodes(sid, item.Season, viewer, includeVirtual: viewer.DisplayMissingEpisodes) : Array.Empty<JfEpisode>(), c, detail: true, seriesCopies, page);
                    break;
                default:
                    status = StatusComposer.Episode(facts, item, c, detail: true, seriesCopies, page);
                    break;
            }
            return WithLiveKey(status, facts);
        }

        /// <summary>
        /// The current status of one title for a viewer, uncached (notifications and "Remind"): of a
        /// Jellyfin item the viewer can see when <paramref name="itemId"/> is given, else of the title
        /// by key (movie or series). Null when the viewer may not see it. Never calls an arr.
        /// </summary>
        internal async Task<TitleStatus?> CurrentAsync(StatusViewer viewer, Guid? itemId, TitleKey? key, CancellationToken cancellationToken)
        {
            if (itemId is Guid id)
            {
                return await GatedAsync(
                    viewer,
                    v => PrepareItemAsync(v, id, load: false, cancellationToken),
                    (now, gathered) => gathered != null && ItemNow(now, id, gathered) is { } item ? ComposeItem(now, item, gathered) : null,
                    _ => (TitleStatus?)null).ConfigureAwait(false);
            }
            if (key == null) return null;
            var composed = await ComposeForAsync(viewer, new[] { key.Title }, null, cancellationToken).ConfigureAwait(false);
            return composed.Count > 0 ? composed[0].Status : null;
        }

        /// <summary>
        /// Titles composed by key for one viewer without touching the body cache (the notification
        /// service judges each follower's and requester's status with it), scoped like the Requests
        /// page when <paramref name="scopes"/> name the part asked for. Titles the viewer may not ask
        /// about by key are left out. Never calls an arr.
        /// </summary>
        internal async Task<IReadOnlyList<KeyedStatus>> ComposeForAsync(StatusViewer viewer, IReadOnlyList<TitleKey> keys, IReadOnlyDictionary<TitleKey, RequestScope>? scopes, CancellationToken cancellationToken, bool loadEpisodes = false)
        {
            var titles = keys.Select(k => k.Title).Distinct().ToList();
            return await GatedAsync(
                viewer,
                // Series scoped to seasons or episodes are judged by Sonarr's episode list (read when it isn't in memory).
                v => GatherAsync(v, titles, loadEpisodes: loadEpisodes ? EpisodeScoped(titles, scopes) : null, peekEpisodes: null, cancellationToken),
                (now, gather) =>
                {
                    var result = new List<KeyedStatus>();
                    foreach (var title in titles)
                    {
                        RequestScope? scope = scopes != null && scopes.TryGetValue(title, out var s) ? s : null;
                        if (Compose(now, gather, title, detail: false, scope) is not { } composed) continue;
                        result.Add(scope != null ? Scoped(now, gather, composed, scope) : composed);
                    }
                    return (IReadOnlyList<KeyedStatus>)result;
                },
                _ => Array.Empty<KeyedStatus>()).ConfigureAwait(false);
        }

        /// <summary>The series among <paramref name="titles"/> whose scope names seasons or episodes.</summary>
        private static List<TitleKey> EpisodeScoped(IEnumerable<TitleKey> titles, IReadOnlyDictionary<TitleKey, RequestScope>? scopes)
            => titles.Where(t => !t.IsMovie && scopes != null && scopes.TryGetValue(t, out var s) && (s.Seasons.Count > 0 || s.Episodes?.Count > 0)).ToList();

        /// <summary>
        /// Whether a viewer may follow a title ("Notify me"): exactly when they may read its status by
        /// key, including its destination-library gate and the own-request exception.
        /// </summary>
        internal bool MayFollow(StatusViewer viewer, TitleKey key) => MayAskByKey(viewer, key.Title, CopiesOf(key.Title, viewer));

        /// <summary>
        /// The status of one movie or series by its key, for a page about a title that may not be in
        /// Jellyfin (the Seerr more-info modal): a movie also gets its journey. Empty when the viewer
        /// may not ask about it by key (see <see cref="MayAskByKey"/>).
        /// </summary>
        public Task<StatusBody> ForKeyDetailAsync(StatusViewer viewer, TitleKey key, CancellationToken cancellationToken)
        {
            var title = key.Title;
            return GatedAsync(
                viewer,
                v => GatherAsync(v, new[] { title }, loadEpisodes: null, peekEpisodes: null, cancellationToken),
                (now, gather) =>
                {
                    var cacheKey = CacheKey(now, "key", title.ToString(), gather.Revision);
                    if (Cache.Get(cacheKey) is { } hit) return hit;
                    var composed = Compose(now, gather, title, detail: true);
                    return Cache.Put(cacheKey, Serialize(composed == null ? Array.Empty<TitleStatus>() : new[] { composed.Status }));
                },
                refused => Nothing(refused, "key"));
        }

        /// <summary>
        /// The details-page status of a title, season or episode that isn't in the library (the native
        /// details page, whose id is a page id and never a copy): composed by key like the more-info
        /// modal, with the season and episode facts from public metadata. A Sonarr that holds the
        /// series supplies the episode states; otherwise every aired episode is simply not here. Once a
        /// copy the viewer can open arrives, <see cref="TitleStatus.OpenItemId"/> names it. Empty when the
        /// viewer may not ask about the title by key.
        /// </summary>
        public Task<StatusBody> ForAbsentAsync(StatusViewer viewer, AbsentTitle page, CancellationToken cancellationToken)
        {
            var title = page.Title.Title;
            // The page (what the library hides from the viewer, their Spoiler Guard) was read for the viewer as they
            // were: when that changed during the arr reads, the answer is empty (the page asks again).
            return GatedAsync(
                viewer,
                v => GatherAsync(v, new[] { title }, loadEpisodes: title.IsMovie ? null : new[] { title }, peekEpisodes: null, cancellationToken),
                (now, gather) =>
                {
                    // An episode or season page also follows the asks that cover that part (never the series' other parts).
                    var asked = page.Kind == "episode" && page.Season is int s && page.Episode is int e ? _requests.ForEpisode(title, s, e, now)
                        : page.Kind == "season" && page.Season is int whole ? _requests.ForSeason(title, whole, now)
                        : null;
                    var cacheKey = CacheKey(now, "absent", page.Signature + "|" + (asked == null ? string.Empty : JsonSerializer.Serialize(asked)), gather.Revision);
                    if (Cache.Get(cacheKey) is { } hit) return hit;
                    var status = ComposeAbsent(now, page, gather, asked);
                    return Cache.Put(cacheKey, Serialize(status == null ? Array.Empty<TitleStatus>() : new[] { status }));
                },
                refused => Nothing(refused, "absent"),
                again: false);
        }

        /// <summary>
        /// The status of part of a title in one edition, by key (a list entry): the 4K copies alone for the 4K edition,
        /// and only the seasons or episodes named, composed like the Requests page's row for an ask of that part with the
        /// asks that cover it (<see cref="IArrRequestFacts.ForPart"/>). So a 4K entry is never Ready because the standard
        /// copy is in. Empty when the viewer may not ask about the title by key.
        /// </summary>
        /// <param name="viewer">Viewer.</param>
        /// <param name="key">Movie or series key.</param>
        /// <param name="seasons">Whole seasons (none: the whole title).</param>
        /// <param name="episodes">Single episodes.</param>
        /// <param name="fourK">The 4K edition.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        internal async Task<StatusBody> ForPartAsync(StatusViewer viewer, TitleKey key, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, bool fourK, CancellationToken cancellationToken)
        {
            var title = key.Title;
            var gather = await GatherAsync(viewer, new[] { title }, loadEpisodes: title.IsMovie ? null : new[] { title }, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            var request = _requests.ForPart(title, fourK, seasons, episodes, viewer);
            // Seerr's word on that edition being available, composed as the Requests page composes its row (with no 4K
            // instance in Jellyfin Enhanced it is all there is to go by for a 4K copy).
            var availability = _requests.AvailabilityForPart(title, fourK, seasons, episodes, viewer);
            var scope = new RequestScope(seasons, fourK, request, availability?.Available == true, availability?.AvailableAt, availability?.JellyfinItemId, episodes);
            var cacheKey = CacheKey(viewer, "part", title + "@" + scope + "|" + (request == null ? string.Empty : JsonSerializer.Serialize(request)), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;
            var composed = Compose(viewer, gather, title, detail: false, scope);
            var status = composed == null ? null : Scoped(viewer, gather, composed, scope).Status;
            return Cache.Put(cacheKey, Serialize(status == null ? Array.Empty<TitleStatus>() : new[] { status }));
        }

        /// <summary>The whole seasons the viewer asked for themselves, for a series page (null when none).</summary>
        private static IReadOnlyList<int>? AskedSeasons(TitleFacts facts) => facts.Request?.ViewerSeasons is { Count: > 0 } asked ? asked : null;

        private TitleStatus? ComposeAbsent(StatusViewer viewer, AbsentTitle page, Gathered gather, RequestFacts? episodeRequests)
        {
            var title = page.Title.Title;
            var copies = CopiesOf(title, viewer);
            if (!MayAskByKey(viewer, title, copies)) return null;
            ApplyRequests(gather, viewer);
            var facts = gather.Facts[title];
            var c = Context(viewer);
            // Virtual: the page id never stands for a file, so nothing on it can read as Ready.
            var item = new JfItemRef { ItemId = page.PageId, Kind = page.Kind, Key = page.ScopeKey, Season = page.Season, Episode = page.Episode, Virtual = true, TmdbId = page.TmdbId };
            TitleStatus status;
            switch (page.Kind)
            {
                case "movie":
                    status = StatusComposer.Movie(facts, null, copies, c, detail: true);
                    break;
                case "series":
                    // What the library hides from the viewer goes in as hidden markers (numbers only), so a
                    // Sonarr's states of those seasons and episodes never reach the page's seasons or counts.
                    var seasons = page.Seasons.Select(s => new JfSeason { ItemId = s.PageId, Season = s.Season })
                        .Concat(page.HiddenSeasons.Select(n => new JfSeason { Season = n, Hidden = true })).ToList();
                    var hiddenEpisodes = page.HiddenSeriesEpisodes.Select(p => new JfEpisode { Season = p.Season, Episode = p.Episode, Hidden = true }).ToList();
                    status = facts.Copies.Any(x => x.Series != null)
                        ? StatusComposer.Series(facts, item, hiddenEpisodes, seasons, c, detail: true)
                        : StatusComposer.AbsentSeries(facts, page, c, number => _requests.ForSeason(title, number, viewer));
                    status.AskedSeasons = AskedSeasons(facts);
                    break;
                case "season":
                    var rows = page.Rows
                        ? page.Episodes.Select(e => new JfEpisode { ItemId = e.PageId, Season = e.Season, Episode = e.Episode, Virtual = true }).ToList()
                        : new List<JfEpisode>();
                    // The season's episodes the library hides from the viewer (as the season rows leave them out).
                    rows.AddRange(page.HiddenEpisodes.Select(n => new JfEpisode { Season = page.Season ?? 0, Episode = n, Hidden = true }));
                    status = facts.Copies.Any(x => x.Series != null)
                        ? StatusComposer.Season(facts, item, rows, c, detail: true, request: episodeRequests)
                        : StatusComposer.AbsentSeason(facts, page, episodeRequests, c);
                    break;
                default:
                    status = facts.Copies.Any(x => x.Series != null)
                        ? StatusComposer.Episode(facts, item, c, detail: true)
                        : StatusComposer.AbsentEpisode(facts, page, item, episodeRequests, c);
                    break;
            }

            // Spoiler Guard's air-date switch on the title: the page names no air date (as its episode list).
            if (page.Spoilers?.AirDate == true) StatusComposer.WithoutAirDates(status);
            status = WithLiveKey(status, facts);
            status.OpenItemId = OpenableCopy(viewer, page, copies);
            return status;
        }

        /// <summary>
        /// The library item the viewer can open for an absent page once a copy has arrived: the movie or
        /// series; for a season or episode page that season or (playable) episode, when it is there.
        /// </summary>
        private string? OpenableCopy(StatusViewer viewer, AbsentTitle page, IReadOnlyList<JfCopy> copies)
        {
            if (copies.FirstOrDefault(x => x.Visible) is not { } shown) return null;
            if (page.Kind is "movie" or "series") return shown.ItemId.ToString("N", CultureInfo.InvariantCulture);
            var scope = ScopeItem(viewer, page.ScopeKey);
            if (scope == null || (page.Kind == "episode" && scope.Virtual)) return null;
            return scope.ItemId.ToString("N", CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// The Jellyfin season or episode item a season/episode key names, when the viewer can see the
        /// series (a virtual episode included); null otherwise or for movie/series keys. In the series item
        /// <paramref name="seriesId"/> when given (a page's own copy: a 4K copy, or the series in another
        /// library, is another series item; never swapped for one). Unpinned (no series named), every copy the
        /// viewer can open is searched: the first copy's item with the file, else the first missing item.
        /// </summary>
        internal JfItemRef? ScopeItem(StatusViewer viewer, TitleKey key, Guid? seriesId = null)
        {
            if (key.IsMovie || key.Season is not int season) return null;
            var copies = CopiesOf(key.Title, viewer);
            if (seriesId is Guid shown)
                return copies.Any(x => x.Visible && x.ItemId == shown) ? ScopeItemIn(viewer, key, shown, season) : null;
            JfItemRef? first = null;
            foreach (var copy in copies.Where(x => x.Visible).DistinctBy(x => x.ItemId))
            {
                var item = ScopeItemIn(viewer, key, copy.ItemId, season);
                if (item is { Virtual: false }) return item;
                first ??= item;
            }
            return first;
        }

        /// <summary>The season or episode item of a key in exactly one series item (see <see cref="ScopeItem"/>).</summary>
        private JfItemRef? ScopeItemIn(StatusViewer viewer, TitleKey key, Guid seriesItemId, int season)
        {
            // Only that series item's own season or episodes: with automatic series grouping Jellyfin lists another
            // folder's (a 4K copy in the same library) with them, which is never this copy's item.
            var kind = key.Episode != null ? "episode" : "season";
            var ids = _view.SeriesParts(seriesItemId, season, key.Episode, viewer);
            // Jellyfin can list a missing (virtual) item and the one its file brought for the same slot
            // until its next series refresh: the one with the file is the scope's item.
            JfItemRef? first = null;
            foreach (var id in ids)
            {
                if (_view.Resolve(id, viewer) is not { } item || item.Kind != kind || item.SeriesId != seriesItemId) continue;
                if (!item.Virtual) return item;
                first ??= item;
            }
            return first;
        }

        /// <summary>
        /// The item a details page of <paramref name="key"/>'s scope should show now (the arrival route):
        /// the movie's copy (<paramref name="shown"/> while the viewer can open it), the series, the
        /// season, or the episode with a file (a multi-episode file covering it included; a missing
        /// one is no arrival). A series, season or episode stays in the series copy the page showed: the
        /// shown item's own series while Jellyfin still has it, else <paramref name="seriesId"/> (the page
        /// names it once the item is gone); never another copy then, except one: once Jellyfin deleted the
        /// shown item and its own copy has nothing for the scope, a series item automatic grouping presents as the
        /// same show (Jellyfin itself deletes a folder's missing episode when another grouped folder has the file).
        /// Null when the viewer can open none. Never calls an arr.
        /// </summary>
        internal Guid? ArrivedItem(StatusViewer viewer, TitleKey key, Guid? shown, Guid? seriesId = null)
        {
            if (key.Season == null)
            {
                var visible = CopiesOf(key.Title, viewer).Where(x => x.Visible).Select(x => x.ItemId).ToList();
                if (visible.Count == 0) return null;
                if (shown is Guid id && visible.Contains(id)) return id;
                if (key.IsMovie && shown is Guid gone)
                {
                    // The movie item whose file became a version of a new item (another resolution joined it): that
                    // item, never another copy (12.x keeps the old item as its version; 10.11 deletes it).
                    if (_view.Resolve(gone, viewer) is { PrimaryId: Guid primary }) return visible.Contains(primary) ? primary : null;
                    if (_view.VersionHolder(gone, visible, viewer) is Guid holder) return holder;
                }
                if (!key.IsMovie && seriesId is Guid copy) return visible.Contains(copy) ? copy : null;
                return visible[0];
            }
            var shownItem = shown is Guid page ? _view.Resolve(page, viewer) : null;
            var series = shownItem is { SeriesId: Guid of } ? of : seriesId;
            if (Arrival(ScopeItem(viewer, key, series)) is Guid own) return own;
            if (shown is Guid && shownItem == null && series is Guid ownSeries)
            {
                foreach (var sibling in _view.GroupedSeries(ownSeries, viewer))
                {
                    if (Arrival(ScopeItem(viewer, key, sibling)) is Guid other) return other;
                }
            }
            return null;

            Guid? Arrival(JfItemRef? scope) => scope == null || (key.Episode != null && scope.Virtual) ? null : scope.ItemId;
        }

        /// <summary>
        /// For a family Search: the instance whose standard copy of the movie or episode in <paramref name="key"/>
        /// has been missing for a long while (monitored, out, nothing grabbed for longer than the "still looking"
        /// hours, a request going out restarting that clock); null when none is, the viewer may not search the series
        /// (<see cref="SeriesSearchView"/>: a series not in Jellyfin yet included), already has the episode, or Jellyfin
        /// hides it from them. Only the standard edition is searched (the one a family Search checked a sent request for): never a 4K copy, and only <paramref name="instanceId"/>'s copy when one is
        /// named (the request target). <c>Sent</c>: the request facts say a request covering that part went out
        /// (in Seerr mode: an OK'd Seerr request, not one still waiting there).
        /// </summary>
        internal async Task<(string? InstanceId, bool Sent)> SearchableInstanceAsync(StatusViewer viewer, TitleKey key, string? instanceId, CancellationToken cancellationToken)
        {
            if (!key.IsMovie && (key.Season == null || key.Episode == null)) return (null, false);
            var title = key.Title;
            return await GatedAsync(
                viewer,
                v => GatherAsync(v, new[] { title }, loadEpisodes: key.IsMovie ? null : new[] { title }, peekEpisodes: null, cancellationToken),
                (now, gather) => SearchableInstance(now, key, instanceId, gather),
                _ => ((string?)null, false)).ConfigureAwait(false);
        }

        /// <summary>The answer of <see cref="SearchableInstanceAsync"/> from gathered facts, for the viewer past the final gate.</summary>
        private (string? InstanceId, bool Sent) SearchableInstance(StatusViewer viewer, TitleKey key, string? instanceId, Gathered gather)
        {
            var title = key.Title;
            ApplyRequests(gather, viewer);
            if (!gather.Facts.TryGetValue(title, out var facts)) return (null, false);
            var sent = facts.Request?.SentFor(false, key.Season, key.Episode) != null;
            var c = Context(viewer);
            if (key.IsMovie)
            {
                // A copy the viewer can already open is not missing.
                if (CopiesOf(title, viewer).Any(x => x.Visible)) return (null, sent);
            }
            else
            {
                if (SeriesSearchView(viewer, title) is not { } view) return (null, sent);
                if (view.Hidden?.Hides(key.Season!.Value, key.Episode!.Value) == true || view.Have.Contains((key.Season!.Value, key.Episode!.Value))) return (null, sent);
            }
            foreach (var copy in facts.Copies.Where(x => x.Instance.Role != "4k" && (string.IsNullOrEmpty(instanceId) || x.Instance.Id == instanceId)))
            {
                StatusComposer.CopyState? state = key.IsMovie
                    ? copy.Movie != null && !copy.Movie.HasFile ? StatusComposer.MovieFromArr(copy, c, facts.Request) : null
                    : copy.Series != null ? StatusComposer.EpisodeFromArr(copy, key.Season!.Value, key.Episode!.Value, copy.Episodes?.Find(key.Season!.Value, key.Episode!.Value), c, facts.Request) : null;
                if (state?.Reason == StatusReasonCode.NoReleaseYet) return (copy.Instance.Id, sent);
            }
            return (null, sent);
        }

        /// <summary>
        /// Jellyfin's side of a family Search of a series' episodes: the episodes the viewer already has (nothing to
        /// search) and the seasons and episodes Jellyfin hides from them (never searched, whatever the queue holds).
        /// A series Jellyfin doesn't have yet has neither, when the viewer may ask about it by key. Null when they may
        /// not search it: Jellyfin has the series but not in a copy they can open, or they may not ask about it.
        /// </summary>
        private (EpisodeCoverage Have, HiddenParts? Hidden)? SeriesSearchView(StatusViewer viewer, TitleKey title)
        {
            var copies = CopiesOf(title, viewer);
            if (copies.FirstOrDefault(x => x.Visible) is { } series)
            {
                var jf = _view.Episodes(series.ItemId, null, viewer, includeVirtual: false);
                var hidden = viewer.IsAdmin || !viewer.HasParentalLimit ? null : StatusComposer.SplitHidden(jf, _view.Seasons(series.ItemId, viewer)).Hidden;
                return (new EpisodeCoverage(jf.Where(e => !e.Hidden)), hidden);
            }
            if (copies.Count > 0 || !MayAskByKey(viewer, title, copies)) return null;
            return (new EpisodeCoverage(Array.Empty<JfEpisode>()), null);
        }

        /// <summary>One standard Sonarr copy's episodes a family Search of a series or season would search.</summary>
        /// <param name="InstanceId">The Sonarr instance.</param>
        /// <param name="Episodes">Its episodes missing for a long while in scope (season, episode, Sonarr id), in order.</param>
        /// <param name="Sent">The request facts say a request covering every one of them went out (Seerr mode: OK'd there).</param>
        internal sealed record SearchableEpisodes(string InstanceId, IReadOnlyList<(int Season, int Episode, int Id)> Episodes, bool Sent);

        /// <summary>
        /// For a family Search of a series or season (<paramref name="key"/> without an episode; a series leaves out the
        /// specials, as its status does): per standard (never 4K) Sonarr copy, its monitored, aired episodes in scope that have been missing for a long while (as each episode's
        /// own status says: nothing grabbed for longer than the "still looking" hours, a request going out restarting that
        /// clock), leaving out episodes the viewer already has in Jellyfin and ones Jellyfin hides from them; at most
        /// <paramref name="max"/> per copy, in episode order, taken from the ones <paramref name="searched"/> doesn't
        /// name (searched in this "still looking" period), so a long series gets its next episodes searched, not the same
        /// first ones again. A copy whose every such episode was searched gives its first <paramref name="max"/> of
        /// them (the caller says so). Copies with none are left out; empty when the viewer may not search the series
        /// (<see cref="SeriesSearchView"/>: a series not in Jellyfin yet included).
        /// </summary>
        /// <param name="viewer">The caller.</param>
        /// <param name="key">The series, or one season of it.</param>
        /// <param name="max">The most episodes per copy.</param>
        /// <param name="searched">True for a (season, episode) searched in this period; null: none was.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        internal async Task<IReadOnlyList<SearchableEpisodes>> SearchableEpisodesAsync(StatusViewer viewer, TitleKey key, int max, Func<int, int, bool>? searched, CancellationToken cancellationToken)
        {
            if (key.IsMovie || key.Episode != null) return Array.Empty<SearchableEpisodes>();
            var title = key.Title;
            return await GatedAsync(
                viewer,
                async v => SeriesSearchView(v, title) == null ? null : await GatherAsync(v, new[] { title }, loadEpisodes: new[] { title }, peekEpisodes: null, cancellationToken).ConfigureAwait(false),
                // Jellyfin's side (what the viewer has, and what it hides from them) as it is now.
                (now, gather) => gather != null && SeriesSearchView(now, title) is { } view ? SearchableEpisodesOf(now, key, max, searched, view, gather) : Array.Empty<SearchableEpisodes>(),
                _ => Array.Empty<SearchableEpisodes>()).ConfigureAwait(false);
        }

        /// <summary>The answer of <see cref="SearchableEpisodesAsync"/> from gathered facts, for the viewer past the final gate.</summary>
        private IReadOnlyList<SearchableEpisodes> SearchableEpisodesOf(StatusViewer viewer, TitleKey key, int max, Func<int, int, bool>? searched, (EpisodeCoverage Have, HiddenParts? Hidden) view, Gathered gather)
        {
            var result = new List<SearchableEpisodes>();
            var title = key.Title;
            ApplyRequests(gather, viewer);
            if (!gather.Facts.TryGetValue(title, out var facts)) return result;
            var c = Context(viewer);
            foreach (var copy in facts.Copies.Where(x => x.Instance.Role != "4k" && x.Series != null && x.Episodes != null))
            {
                // Not searched in this period first; the searched ones only stand in when there are no others.
                var found = new List<(int Season, int Episode, int Id)>();
                var spent = new List<(int Season, int Episode, int Id)>();
                foreach (var arr in copy.Episodes!.Episodes.Where(e => key.Season is int only ? e.SeasonNumber == only : e.SeasonNumber > 0).OrderBy(e => e.SeasonNumber).ThenBy(e => e.EpisodeNumber))
                {
                    if (found.Count >= max) break;
                    if (view.Hidden?.Hides(arr.SeasonNumber, arr.EpisodeNumber) == true || view.Have.Contains((arr.SeasonNumber, arr.EpisodeNumber))) continue;
                    if (StatusComposer.EpisodeFromArr(copy, arr.SeasonNumber, arr.EpisodeNumber, arr, c, facts.Request).Reason != StatusReasonCode.NoReleaseYet) continue;
                    var into = searched?.Invoke(arr.SeasonNumber, arr.EpisodeNumber) == true ? spent : found;
                    if (into.Count < max) into.Add((arr.SeasonNumber, arr.EpisodeNumber, arr.Id));
                }
                var picked = found.Count > 0 ? found : spent;
                var sent = picked.All(e => facts.Request?.SentFor(false, e.Season, e.Episode) != null);
                if (picked.Count > 0) result.Add(new SearchableEpisodes(copy.Instance.Id, picked, sent));
            }
            return result;
        }

        /// <summary>
        /// The full status of a season or episode Jellyfin has no item for, by key (the Manage drawer):
        /// where Sonarr has got to with that season or episode, not the whole series. Reads the
        /// series' episodes from the arr when they aren't in memory (administrators only).
        /// </summary>
        internal async Task<StatusBody> ForScopeKeyAsync(StatusViewer viewer, TitleKey key, CancellationToken cancellationToken)
        {
            if (key.IsMovie || key.Season is not int season) return await ForKeyDetailAsync(viewer, key, cancellationToken).ConfigureAwait(false);
            var title = key.Title;
            return await GatedAsync(
                viewer,
                v => GatherAsync(v, new[] { title }, loadEpisodes: new[] { title }, peekEpisodes: null, cancellationToken),
                (now, gather) => ScopeKeyBody(now, key, season, gather),
                refused => Nothing(refused, "scope")).ConfigureAwait(false);
        }

        /// <summary>The answer of <see cref="ForScopeKeyAsync"/> from gathered facts, for the viewer past the final gate.</summary>
        private StatusBody ScopeKeyBody(StatusViewer viewer, TitleKey key, int season, Gathered gather)
        {
            var title = key.Title;
            var cacheKey = CacheKey(viewer, "scope", key.ToString(), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;
            ApplyRequests(gather, viewer);
            var facts = gather.Facts[title];
            var c = Context(viewer);
            var series = CopiesOf(title, viewer).FirstOrDefault(x => x.Visible);
            // A stand-in for the missing Jellyfin item (no id): the arr's view of that season or episode.
            var standIn = new JfItemRef { Kind = key.Episode.HasValue ? "episode" : "season", Key = key, SeriesId = series?.ItemId, Season = season, Episode = key.Episode, Virtual = true };
            var status = key.Episode.HasValue
                ? StatusComposer.Episode(facts, standIn, c, detail: true)
                : StatusComposer.Season(facts, standIn, series != null ? _view.Episodes(series.ItemId, season, viewer, includeVirtual: false) : Array.Empty<JfEpisode>(), c, detail: true);
            return Cache.Put(cacheKey, Serialize(new[] { WithLiveKey(status, facts) }));
        }

        /// <summary>
        /// One title composed by key for <see cref="ForTitlesAsync"/>: its status and the Jellyfin copy
        /// the viewer can open, if any. <paramref name="Scoped"/>: the status is of the part asked for
        /// (<see cref="RequestScope"/>), and <paramref name="ArrivedAt"/> is when that part arrived.
        /// <paramref name="Guessed"/>: a requested season reads Ready without Sonarr's episode list (no Sonarr copy could
        /// be judged while a Sonarr couldn't be read, or a copy's list couldn't be read and only its season counts were
        /// there): fine to show, not enough to close a request on.
        /// </summary>
        internal sealed record KeyedStatus(TitleKey Key, TitleStatus Status, JfCopy? Visible, bool Scoped = false, DateTime? ArrivedAt = null, bool Guessed = false);

        /// <summary>
        /// The part of a title a request asked for: series seasons (none: the whole title, or the
        /// 4K Sonarr copies' monitored seasons for a 4K request), and whether only the 4K copy was
        /// asked for (movie or series). With no 4K seasons to follow, the request alone decides.
        /// </summary>
        /// <remarks>
        /// <paramref name="Request"/>: the facts of those requests only (not other people's, other
        /// seasons' or the other quality's); the title is always composed with them.
        /// <paramref name="Available"/>: Seerr says the variant asked for is available
        /// (<paramref name="AvailableAt"/>: when it last changed), which is all there is to go by
        /// for a 4K request when no 4K instance is set up in Jellyfin Enhanced.
        /// <paramref name="JellyfinItemId"/>: the Jellyfin item Seerr matched the 4K copy to (4K
        /// scopes only), used for Play when it is a copy the viewer can open; a 4K scope never falls
        /// back to the standard copy.
        /// </remarks>
        internal sealed record RequestScope(IReadOnlyList<int> Seasons, bool Only4k, RequestFacts? Request, bool Available = false, DateTime? AvailableAt = null, Guid? JellyfinItemId = null, IReadOnlyList<(int Season, int Episode)>? Episodes = null)
        {
            /// <summary>A stable text form (part of the cache key; the request facts follow the read model's revision).</summary>
            public override string ToString() => string.Join(".", Seasons) + (Only4k ? "4k" : string.Empty) + (Available ? "a" : string.Empty)
                + (JellyfinItemId is Guid id ? "@" + id.ToString("N", CultureInfo.InvariantCulture) : string.Empty)
                + (Episodes is { Count: > 0 } picked ? "e" + string.Join(".", picked.Select(p => p.Season.ToString(CultureInfo.InvariantCulture) + "x" + p.Episode.ToString(CultureInfo.InvariantCulture))) : string.Empty);
        }

        /// <summary>The copy Seerr matched a 4K request to, when it is one the viewer can open (else null).</summary>
        private static JfCopy? SeerrCopy(RequestScope scope, IReadOnlyList<JfCopy> copies)
            => scope.JellyfinItemId is Guid id ? copies.FirstOrDefault(x => x.Visible && x.ItemId == id) : null;

        /// <summary>
        /// A body built from many titles composed by key (the Requests page), cached per user like
        /// the status bodies: <paramref name="what"/> names everything else the body depends on.
        /// Titles the viewer may not ask about by key are left out. Never calls an arr.
        /// </summary>
        /// <remarks>
        /// Everything the caller prepared (<paramref name="what"/>, <paramref name="build"/>) is the viewer's as they
        /// were: when their policy changed during the arr reads (or they are gone), <see cref="ViewerChangedException"/>
        /// tells the caller to prepare it again. <paramref name="responseGate"/> wraps the cache lookup and the build
        /// (a caller's own final gate).
        /// </remarks>
        internal async Task<StatusBody> ForTitlesAsync(StatusViewer viewer, IReadOnlyList<TitleKey> keys, string route, string what, Func<IReadOnlyList<KeyedStatus>, byte[]> build, CancellationToken cancellationToken, IReadOnlyDictionary<TitleKey, RequestScope>? scopes = null, IReadOnlyCollection<TitleKey>? loadEpisodes = null, Func<Func<StatusBody>, StatusBody>? responseGate = null)
        {
            var titles = keys.Select(k => k.Title).Distinct().ToList();
            var gather = await GatherAsync(viewer, titles, loadEpisodes: loadEpisodes, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            if (Current(viewer) is not { } now) throw new ViewerChangedException();
            return responseGate != null ? responseGate(Respond) : Respond();

            StatusBody Respond()
            {
                RequestScope? ScopeOf(TitleKey t) => scopes != null && scopes.TryGetValue(t, out var scope) ? scope : null;
                var cacheKey = CacheKey(now, route, what + "|" + string.Join(",", titles.Select(t => t + (ScopeOf(t) is { } scope ? "@" + scope : string.Empty))), gather.Revision);
                if (Cache.Get(cacheKey) is { } hit) return hit;
                var result = new List<KeyedStatus>();
                foreach (var title in titles)
                {
                    if (Compose(now, gather, title, detail: false, ScopeOf(title)) is not { } composed) continue;
                    result.Add(ScopeOf(title) is { } asked ? Scoped(now, gather, composed, asked) : composed);
                }
                return Cache.Put(cacheKey, build(result));
            }
        }

        /// <summary>
        /// The status of the part of a title that was asked for (requested seasons and episodes; the edition), when
        /// that differs from the whole title. The edition is judged by <see cref="Editions"/>: a 4K request is Ready
        /// only with a playable 4K source in a copy the viewer can open, a standard one with any playable copy (or a
        /// non-4K one with the administrator's switch), across every copy they can open; arr ownership, a shared
        /// folder or library, or Seerr's word alone never is. Jellyfin and memory only.
        /// </summary>
        private KeyedStatus Scoped(StatusViewer viewer, Gathered gather, KeyedStatus whole, RequestScope scope)
        {
            var whose = gather.Facts[whole.Key];
            var c = Context(viewer);
            var copies = CopiesOf(whole.Key, viewer);
            var edition = EditionAvailability.Of(scope.Only4k);
            // A standard request is satisfied by any playable copy unless the administrator says it needs a non-4K one.
            var anyCopy = !scope.Only4k && !Editions.StandardNeedsNonFourK;
            var noFourKArr = scope.Only4k && !_store.Instances(whole.Key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr).Any(i => i.Role == "4k");
            var facts = new TitleFacts(whose.Key) { Request = scope.Request, LiveKey = whose.LiveKey };
            facts.Copies.AddRange(whose.Copies);
            facts.Unreadable.AddRange(whose.Unreadable);
            facts.Stale.AddRange(whose.Stale);
            facts.Checked.AddRange(whose.Checked);

            if (whole.Key.IsMovie)
            {
                // Any playable copy will do (its own file is enough, no versions read); never a placeholder or a missing item.
                var hits = Editions.Movie(viewer, copies, edition, readDimensions: !anyCopy);
                var held = HeldCopies(hits.Select(h => h.CopyId), copies, scope.JellyfinItemId);
                if (anyCopy)
                {
                    // The whole title, as before, once a copy plays: Play opens one that does.
                    if (held.Count > 0) return whole.Visible is { } open && held.Any(x => x.ItemId == open.ItemId) ? whole : whole with { Visible = held[0] };
                    // A copy that doesn't play (a placeholder, a missing item) is no arrival: where every Radarr has got to.
                    var (none, _, _) = StatusComposer.RequestedEdition(facts, whole.Status, held, hits, c, fourK: false, everyEdition: true);
                    return whole with { Status = WithLiveKey(none, facts), Visible = null, Scoped = true, ArrivedAt = null };
                }
                if (noFourKArr)
                {
                    // No 4K instance set up in Jellyfin Enhanced: the standard copy says nothing about the 4K one, so
                    // the request says where it is, and a 4K source in a copy the viewer can open says it arrived
                    // (Seerr's word that it is available is not enough on its own).
                    var arrivedAt = hits.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max();
                    var (only, at) = StatusComposer.RequestedOnly(whole.Status, scope.Request, held.Count > 0, held.Count > 0 ? arrivedAt ?? scope.AvailableAt : null);
                    return whole with { Status = WithLiveKey(only, whose), Visible = held.FirstOrDefault(), Scoped = true, ArrivedAt = at };
                }
                var (status, arrived, shown) = StatusComposer.RequestedEdition(facts, whole.Status, held, hits, c, scope.Only4k);
                return whole with { Status = WithLiveKey(status, facts), Visible = shown, Scoped = true, ArrivedAt = arrived };
            }

            var seasons = scope.Seasons;
            var picked = scope.Episodes ?? Array.Empty<(int Season, int Episode)>();
            if (!scope.Only4k && !anyCopy && seasons.Count == 0 && picked.Count == 0)
            {
                // A standard whole series that needs a non-4K copy: the standard Sonarrs' monitored seasons, judged like
                // requested seasons below (only episodes with a non-4K source count).
                seasons = StatusComposer.StandardOnly(facts).Copies.Where(x => x.Series != null)
                    .SelectMany(x => x.Series!.Seasons).Where(s => s.Monitored && s.SeasonNumber > 0)
                    .Select(s => s.SeasonNumber).Distinct().OrderBy(n => n).ToList();
                if (seasons.Count == 0)
                {
                    // No standard seasons to follow: it arrived once a copy the viewer can open has a non-4K episode.
                    var any = Editions.Episodes(viewer, copies, Edition.Standard, null, readDimensions: true);
                    var held = HeldCopies(any.Hits.Select(h => h.CopyId), copies, null);
                    if (held.Count > 0)
                        return whole with { Visible = held[0], Scoped = true, ArrivedAt = any.Hits.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max() };
                    var (only, _) = StatusComposer.RequestedOnly(whole.Status, scope.Request, false, null);
                    return whole with { Status = WithLiveKey(only, facts), Visible = null, Scoped = true, ArrivedAt = null };
                }
            }
            if (scope.Only4k && seasons.Count == 0 && picked.Count == 0)
            {
                seasons = StatusComposer.FourKOnly(facts).Copies.Where(x => x.Series != null)
                    .SelectMany(x => x.Series!.Seasons).Where(s => s.Monitored && s.SeasonNumber > 0)
                    .Select(s => s.SeasonNumber).Distinct().OrderBy(n => n).ToList();
                if (seasons.Count == 0)
                {
                    // No 4K seasons to follow (no 4K Sonarr, or one that monitors none): the request says where it is,
                    // and 4K episodes in a copy the viewer can open say it arrived, when the newest of them did (Seerr's
                    // word that it is available is neither needed nor enough; its time only when Jellyfin has none).
                    var any = Editions.Episodes(viewer, copies, Edition.FourK, null, readDimensions: true);
                    var held = HeldCopies(any.Hits.Select(h => h.CopyId), copies, scope.JellyfinItemId);
                    var arrivedAt = any.Hits.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max();
                    var (only, at) = StatusComposer.RequestedOnly(whole.Status, scope.Request, held.Count > 0, held.Count > 0 ? arrivedAt ?? scope.AvailableAt : null);
                    return whole with { Status = WithLiveKey(only, facts), Visible = held.FirstOrDefault(), Scoped = true, ArrivedAt = at };
                }
            }
            if (seasons.Count > 0 || picked.Count > 0)
            {
                // A 4K request is followed (and "no 4K Sonarr has it" judged) through the 4K Sonarrs only.
                if (scope.Only4k) facts = StatusComposer.FourKOnly(facts);
                var mine = copies;
                if (scope.Only4k)
                {
                    // The Jellyfin copies matched to the 4K Sonarr copies, for which Sonarr copy a family member follows.
                    var siblings = StatusComposer.SeriesCopies(whose);
                    // Positive matches only (never "the only copy there is": it may be the standard one).
                    mine = facts.Copies.Where(x => x.Series != null).SelectMany(x => StatusComposer.MatchCopies(x, copies, siblings, soleFallback: false)).Distinct().ToList();
                }
                // The requested parts' episodes that have a playable source of the edition, in any copy the viewer can
                // open (each episode by its own sources, in its own series item): never a grouped folder's HD episode
                // for a 4K request. Read per requested season, with dimensions only when the edition needs them.
                var parts = seasons.Concat(picked.Select(p => p.Season)).Distinct().OrderBy(n => n).ToList();
                var hits = parts.SelectMany(n => Editions.Episodes(viewer, copies, edition, n, readDimensions: !anyCopy).Hits).ToList();
                var available = new EpisodeEditions(hits);
                var wanted = new HashSet<int>(seasons);
                var asked = hits.Where(h => (h.Season is int n && wanted.Contains(n)) || picked.Any(p => h.Covers(p.Season, p.Episode))).ToList();
                // Play opens a copy holding the edition's episodes asked for; a 4K scope never falls back to the standard copy.
                var shown = HeldCopies(asked.Select(h => h.CopyId), copies, null).FirstOrDefault()
                    ?? (scope.Only4k ? mine.FirstOrDefault(x => x.Visible) ?? SeerrCopy(scope, copies) : whole.Visible);
                if (scope.Only4k && mine.Count == 0 && shown != null) mine = new List<JfCopy> { shown };
                var episodes = available.AsEpisodes().ToList();
                // What the library hides from a viewer with parental limits goes in as hidden markers (numbers only).
                if (!viewer.IsAdmin && viewer.HasParentalLimit && (shown ?? whole.Visible) is { } basis)
                    episodes.AddRange(_view.Episodes(basis.ItemId, null, viewer, includeVirtual: false).Where(e => e.Hidden));
                var (status, arrived) = StatusComposer.RequestedSeasons(facts, whole.Status, seasons, episodes, mine, c, scope.Only4k, picked);
                // A requested season read Ready without Sonarr's episode list: with no Sonarr copy while a Sonarr (that
                // may hold it) couldn't be read ("one episode of each requested season is here"), or from a copy whose
                // list couldn't be read (its season counts, which miss episodes it doesn't monitor yet).
                var guessed = status.Stage == StatusStage.Ready && seasons.Count > 0
                    && ((facts.Unreadable.Count > 0 && !facts.Copies.Any(x => x.Series != null)) || facts.Copies.Any(x => x.Series != null && x.Episodes == null));
                return whole with { Status = WithLiveKey(status, facts), Visible = shown, Scoped = true, ArrivedAt = arrived, Guessed = guessed };
            }
            return whole;
        }

        /// <summary>
        /// The copies (movie items or series items) the viewer can open among <paramref name="ids"/>, in the order of
        /// <paramref name="ids"/> (the edition's preferred hits first), the one Seerr matched first when it is among them.
        /// </summary>
        private static List<JfCopy> HeldCopies(IEnumerable<Guid> ids, IReadOnlyList<JfCopy> copies, Guid? seerr)
        {
            var order = new Dictionary<Guid, int>();
            foreach (var id in ids) order.TryAdd(id, order.Count);
            return copies.Where(x => x.Visible && order.ContainsKey(x.ItemId)).DistinctBy(x => x.ItemId)
                .OrderBy(x => seerr is Guid id && x.ItemId == id ? 0 : 1).ThenBy(x => order[x.ItemId]).ToList();
        }

        /// <summary>The household contact name and "still looking" hours, as the status responses carry them.</summary>
        internal (string Contact, int LookingHours) Texts()
        {
            var config = _config();
            return ((config?.ArrHouseholdContactName ?? string.Empty).Trim() is { Length: <= 40 } name ? name : string.Empty, Math.Clamp(config?.ArrStatusLookingHours ?? 24, 1, 720));
        }

        /// <summary>Now, by the service's clock.</summary>
        internal DateTimeOffset Now => _now();

        /// <summary>
        /// A title composed by key. With a <paramref name="scope"/> (a Requests page entry), the
        /// request facts are that entry's own, not every household member's for the title.
        /// </summary>
        private KeyedStatus? Compose(StatusViewer viewer, Gathered gather, TitleKey key, bool detail, RequestScope? scope = null)
        {
            var facts = gather.Facts[key];
            var copies = CopiesOf(key, viewer);
            if (!MayAskByKey(viewer, key, copies)) return null;
            facts.Request = scope != null ? scope.Request : _requests.For(key, viewer);
            var c = Context(viewer);
            var status = key.IsMovie
                ? StatusComposer.Movie(facts, null, copies, c, detail)
                : StatusComposer.SeriesByKey(facts, copies, c, copies.FirstOrDefault(x => x.Visible) is { } shown ? HiddenFromViewer(facts, shown.ItemId, viewer) : null);
            return new KeyedStatus(key, WithLiveKey(status, facts), copies.FirstOrDefault(x => x.Visible));
        }

        /// <summary>
        /// Whether a viewer may ask about a title by key: a visible Jellyfin copy, or an absent
        /// title with an openable arr destination and no parental limits. With no arr holding it, the
        /// destination is where a request would land (the default instance's, as the request policy
        /// reads it). Unresolved destinations require every library. Their own request grants access
        /// only while Jellyfin has no copy.
        /// </summary>
        private bool MayAskByKey(StatusViewer viewer, TitleKey key, IReadOnlyList<JfCopy> copies)
        {
            if ((viewer.IsAdmin && (!ArrInstanceLibraries.AbsentParentalEnabled || !viewer.HasParentalLimit)) || copies.Any(x => x.Visible)) return true;
            if (copies.Count > 0) return !viewer.HasParentalLimit;
            if (!_libraries.MaySeeAbsent(viewer, key)) return false;
            if (AskedBy(key, viewer)) return true;
            if (!ArrInstanceLibraries.AbsentParentalEnabled && viewer.HasParentalLimit) return false;
            var holders = _store.Instances(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr)
                .SelectMany(i => PathsOf(i, key).Select(path => (Instance: i, Path: path))).ToList();
            if (holders.Count > 0) return holders.Any(c => MayUseCopy(viewer, new CopyAccess(true, false, false), c.Instance, c.Path));
            var destination = _store.Registry.DefaultFor(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr, Model.Arr.ArrInstanceRole.Standard) is { } instance
                ? _libraries.ResolveTitle(instance, key)
                : new ArrLibraryTarget(null, null, ArrLibraryProblem.NoInstance);
            return viewer.Handle is User user && ArrInstanceLibraries.CanOpen(user, destination, _libraries.Libraries());
        }

        private bool AskedBy(TitleKey key, StatusViewer viewer)
            => _aliases.AskedBy(key, viewer.UserId, _requests);

        private IEnumerable<string?> PathsOf(ArrConnection instance, TitleKey key)
        {
            if (_store.PeekLibrary(instance.Id) is not { } library) yield break;
            if (key.IsMovie)
            {
                foreach (var movie in MoviesOf(library, key)) yield return movie.Path;
            }
            else
            {
                foreach (var series in SeriesOf(library, key)) yield return series.Path;
            }
        }

        private sealed record CopyAccess(bool Absent, bool Visible, bool Asked);

        private CopyAccess AccessOf(TitleKey key, StatusViewer viewer, IReadOnlyList<JfCopy>? read = null)
        {
            var copies = read ?? CopiesOf(key, viewer);
            var absent = copies.Count == 0;
            return new CopyAccess(absent, copies.Any(c => c.Visible), absent && AskedBy(key, viewer));
        }

        private bool MayUseCopy(StatusViewer viewer, CopyAccess access, ArrConnection instance, string? path)
        {
            if (viewer.IsAdmin && (!ArrInstanceLibraries.AbsentParentalEnabled || !viewer.HasParentalLimit)) return true;
            if (access.Absent) return _libraries.CanSeeAbsent(viewer, instance, path, access.Asked);
            var target = _libraries.Resolve(instance, path);
            // A visible Jellyfin title already grants access to its arr facts. Only a resolved
            // destination can distinguish an inaccessible quality copy from that visible title.
            if (access.Visible && !target.Resolved) return true;
            return viewer.Handle is User user && ArrInstanceLibraries.CanOpen(user, target, _libraries.Libraries());
        }

        private IEnumerable<ArrMovieEntry> MoviesOf(ArrLibrarySnapshot library, TitleKey key)
            => FindMovie(library, key) is { } exact ? new[] { exact }
                : _aliases.Of(key).Where(k => k.IsMovie).Select(k => FindMovie(library, k)).OfType<ArrMovieEntry>().DistinctBy(m => m.Id);

        private IEnumerable<ArrSeriesEntry> SeriesOf(ArrLibrarySnapshot library, TitleKey key)
            => FindSeries(library, key) is { } exact ? new[] { exact }
                : _aliases.Of(key).Where(k => !k.IsMovie).Select(k => FindSeries(library, k)).OfType<ArrSeriesEntry>().DistinctBy(s => s.Id);

        private static ArrMovieEntry? FindMovie(ArrLibrarySnapshot library, TitleKey key)
            => key.Provider == "tmdb" && key.NumericId is int id ? library.MovieByTmdb(id) : key.Provider == "imdb" ? library.MovieByImdb(key.Id) : null;

        private static ArrSeriesEntry? FindSeries(ArrLibrarySnapshot library, TitleKey key)
            => key.Provider switch
            {
                "tvdb" when key.NumericId is int id => library.SeriesByTvdb(id),
                "tmdb" when key.NumericId is int id => library.SeriesByTmdb(id),
                "imdb" => library.SeriesByImdb(key.Id),
                _ => null,
            };

        /// <summary>The request facts in use (the Seerr read model, or none).</summary>
        internal IArrRequestFacts Requests => _requests;

        /// <summary>The title's other ids (arr libraries, Seerr's requests), from memory.</summary>
        internal TitleAliases Aliases => _aliases;

        /// <summary>
        /// Every Jellyfin copy of a title as the viewer sees it, found by the title's key and every
        /// alias (a series Jellyfin knows only by its TMDB id is found by its TVDB key).
        /// </summary>
        internal IReadOnlyList<JfCopy> CopiesOf(TitleKey key, StatusViewer viewer) => _view.Copies(key, viewer, _aliases.Of(key));

        /// <summary>
        /// Sets the key the change feed announces a title under when it differs from the status key
        /// (a Jellyfin title known only by IMDb, or a series by TMDB/IMDb): the arr copy's TMDB
        /// movie or TVDB series id, with the status' season and episode.
        /// </summary>
        private static TitleStatus WithLiveKey(TitleStatus status, TitleFacts facts)
        {
            if (facts.LiveKey is not { } live || live.Equals(facts.Key) || TitleKey.Parse(status.Key) is not { } key) return status;
            status.LiveKey = (key.Episode is int e && key.Season is int se ? live.WithEpisode(se, e)
                : key.Season is int s ? live.WithSeason(s) : live).ToString();
            return status;
        }

        /// <summary>
        /// For a viewer with parental limits, the episodes and seasons of a series Jellyfin hides from
        /// them, so the queue-only surfaces (series cards, series keys) don't count their downloads.
        /// Read only when a Sonarr copy of the series has queue rows (a few series per page); null otherwise.
        /// </summary>
        private HiddenParts? HiddenFromViewer(TitleFacts facts, Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.IsAdmin || !viewer.HasParentalLimit || !facts.Copies.Any(x => x.Series != null && x.Queue.Count > 0)) return null;
            return StatusComposer.SplitHidden(_view.Episodes(seriesItemId, null, viewer, includeVirtual: false), _view.Seasons(seriesItemId, viewer)).Hidden;
        }

        /// <summary>How many times an answer is prepared again for a viewer whose policy changed under it before it fails closed.</summary>
        internal const int GateAttempts = 3;

        /// <summary>
        /// The final gate of an answer prepared across awaits (the arr reads): the viewer as Jellyfin has them now,
        /// when nothing that decides what they may see or get changed meanwhile (their role, library access, parental
        /// settings, missing-episode display: the policy revision). Null when it did or they are gone or disabled:
        /// everything prepared for the old policy is stale (cached answers too, which are keyed by it). The library
        /// context has no person to change.
        /// </summary>
        private StatusViewer? Current(StatusViewer prepared)
        {
            if (prepared.IsLibraryContext) return prepared;
            var now = _view.Viewer(prepared.UserId);
            return now != null && now.IsAdmin == prepared.IsAdmin && string.Equals(now.PolicyRevision, prepared.PolicyRevision, StringComparison.Ordinal) ? now : null;
        }

        /// <summary>
        /// Prepares an answer (<paramref name="prepare"/>: the Jellyfin lookups and arr reads, which await) and gives it,
        /// past the final gate (<see cref="Current"/>), to <paramref name="answer"/> with the viewer as they are now:
        /// <paramref name="answer"/> re-reads what Jellyfin decides for them (the item, its copies) and composes, never
        /// awaiting. When the viewer changed meanwhile, the prepared facts are dropped and prepared again for the
        /// changed viewer (<paramref name="again"/>, up to <see cref="GateAttempts"/> times), else
        /// <paramref name="refused"/> answers (nothing): also when they are gone.
        /// </summary>
        private async Task<T> GatedAsync<TPrepared, T>(StatusViewer viewer, Func<StatusViewer, Task<TPrepared>> prepare, Func<StatusViewer, TPrepared, T> answer, Func<StatusViewer, T> refused, bool again = true)
        {
            var prepared = viewer;
            for (var attempt = 0; attempt < GateAttempts; attempt++)
            {
                var facts = await prepare(prepared).ConfigureAwait(false);
                if (Current(prepared) is { } now) return answer(now, facts);
                if (!again || _view.Viewer(prepared.UserId) is not { } changed) break;
                prepared = changed;
            }
            return refused(prepared);
        }

        /// <summary>The empty answer of a route for a viewer (what they get when there is nothing they may see).</summary>
        private StatusBody Nothing(StatusViewer viewer, string route)
        {
            var none = CacheKey(viewer, route, "none", "none");
            return Cache.Get(none) ?? Cache.Put(none, Serialize(Array.Empty<TitleStatus>()));
        }

        private void ApplyRequests(Gathered gathered, StatusViewer viewer)
        {
            foreach (var (key, facts) in gathered.Facts) facts.Request = _requests.For(key, viewer);
        }

        private ComposeContext Context(StatusViewer viewer)
        {
            var config = _config();
            return new(viewer, _now().UtcDateTime, config?.ArrStatusLookingHours ?? 24)
            {
                HandoffGrace = HandoffGrace(config),
                RequestClock = config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase3Enabled: true },
            };
        }

        /// <summary>
        /// The grace period after which an OK'd Seerr request no Sonarr/Radarr holds is reported to
        /// administrators (phase 2 only; null when off).
        /// </summary>
        internal static TimeSpan? HandoffGrace(PluginConfiguration? config)
            => config is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, ArrPhase2Enabled: true }
                ? TimeSpan.FromMinutes(Math.Clamp(config.ArrSeerrHandoffGraceMinutes, 1, 1440))
                : null;

        private byte[] Serialize(IReadOnlyList<TitleStatus> statuses)
        {
            var config = _config();
            return JsonSerializer.SerializeToUtf8Bytes(new StatusResponse
            {
                Contact = (config?.ArrHouseholdContactName ?? string.Empty).Trim() is { Length: <= 40 } name ? name : string.Empty,
                LookingHours = Math.Clamp(config?.ArrStatusLookingHours ?? 24, 1, 720),
                Items = statuses,
            }, Json);
        }

        /// <summary>
        /// The per-user cache key: user, policy revision, what was asked, the arr facts revision, the
        /// Jellyfin library revision, the request facts revision, the settings that change texts and a
        /// ten-minute time bucket (for time-based wording such as "Still looking").
        /// </summary>
        private string CacheKey(StatusViewer viewer, string route, string what, string factsRevision)
        {
            var config = _config();
            var bucket = _now().UtcTicks / TimeBucket.Ticks;
            var raw = string.Join(
                "|",
                viewer.UserId.ToString("N", CultureInfo.InvariantCulture),
                viewer.PolicyRevision,
                route,
                what,
                factsRevision,
                _view.Revision.ToString(CultureInfo.InvariantCulture),
                _requests.Revision.ToString(CultureInfo.InvariantCulture),
                _libraries.Revision,
                (config?.ArrRequestBackend ?? "seerr") + "#" + (config?.ArrPhase3Enabled == true ? "3" : "0") + "#" + (config?.ArrHouseholdContactName ?? string.Empty) + "#" + (config?.ArrStatusLookingHours ?? 24).ToString(CultureInfo.InvariantCulture)
                    + "#" + (HandoffGrace(config)?.TotalMinutes.ToString(CultureInfo.InvariantCulture) ?? "-") + "#" + HandoffEpoch(viewer, config),
                bucket.ToString(CultureInfo.InvariantCulture));
            // Hashed so the key's size does not grow with the request; the user id stays readable as the prefix.
            return viewer.UserId.ToString("N", CultureInfo.InvariantCulture) + ":" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
        }

        /// <summary>
        /// How many OK'd requests have passed this viewer's handoff grace (administrators: the
        /// setting; everyone else: the "still looking" hours). Part of the cache key, so a status
        /// turns into "OK'd in Seerr, but no Sonarr/Radarr has it" as soon as the grace passes,
        /// not at the next ten-minute bucket. Empty with phase 2 off.
        /// </summary>
        private string HandoffEpoch(StatusViewer viewer, PluginConfiguration? config)
        {
            if (HandoffGrace(config) is not TimeSpan grace || _requests is not SeerrRequestReadModel model) return string.Empty;
            var wait = viewer.IsAdmin ? grace : TimeSpan.FromHours(Math.Clamp(config?.ArrStatusLookingHours ?? 24, 1, 720));
            var before = _now().UtcDateTime - wait;
            var count = 0;
            foreach (var r in model.All)
            {
                if (r.Status is SeerrRequestStatus.Approved or SeerrRequestStatus.Failed && (r.UpdatedAt ?? r.CreatedAt) is DateTime at && at <= before) count++;
            }
            return count.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// The viewer an answer was being prepared for changed (role, library access, parental settings) or was removed
        /// before it was ready, and what the caller prepared for them is stale: the caller prepares it again for the
        /// viewer as they are now (see <see cref="ForTitlesAsync"/>).
        /// </summary>
        public sealed class ViewerChangedException : Exception
        {
            /// <summary>Creates the exception.</summary>
            public ViewerChangedException()
                : base("The viewer changed while the answer was being prepared.")
            {
            }

            /// <summary>Creates the exception with a message.</summary>
            /// <param name="message">Message.</param>
            public ViewerChangedException(string message)
                : base(message)
            {
            }

            /// <summary>Creates the exception with a message and its cause.</summary>
            /// <param name="message">Message.</param>
            /// <param name="innerException">Cause.</param>
            public ViewerChangedException(string message, Exception innerException)
                : base(message, innerException)
            {
            }
        }

        private sealed class Gathered
        {
            public Dictionary<TitleKey, TitleFacts> Facts { get; } = new();

            /// <summary>The Jellyfin copies of each title, as the viewer the facts were gathered for could open them.</summary>
            public Dictionary<TitleKey, IReadOnlyList<JfCopy>> Copies { get; } = new();

            public string Revision { get; set; } = string.Empty;
        }

        /// <summary>
        /// Reads every snapshot the titles need (library, queue, history per instance of each kind
        /// needed; episodes of the series in <paramref name="loadEpisodes"/>, or only those already in
        /// memory for <paramref name="peekEpisodes"/>) and builds the facts plus their revision.
        /// </summary>
        private async Task<Gathered> GatherAsync(StatusViewer viewer, IEnumerable<TitleKey> titles, IEnumerable<TitleKey>? loadEpisodes, IEnumerable<TitleKey>? peekEpisodes, CancellationToken ct)
        {
            var result = new Gathered();
            var distinct = titles.Distinct().ToList();
            foreach (var t in distinct) result.Facts[t] = new TitleFacts(t);
            var access = new Dictionary<TitleKey, CopyAccess>();
            var revision = new StringBuilder();
            var kinds = new List<ArrKind>();
            if (distinct.Any(t => t.IsMovie)) kinds.Add(ArrKind.Radarr);
            if (distinct.Any(t => !t.IsMovie)) kinds.Add(ArrKind.Sonarr);
            var load = new HashSet<TitleKey>(loadEpisodes ?? Array.Empty<TitleKey>());
            var peek = new HashSet<TitleKey>(peekEpisodes ?? Array.Empty<TitleKey>());
            AppendFeedRevisions(revision, distinct);

            foreach (var kind in kinds)
            {
                var instances = _store.Instances(kind);
                var reads = await Task.WhenAll(instances.Select(async i => (
                    Instance: i,
                    Library: await _store.GetLibraryAsync(i, ct).ConfigureAwait(false),
                    Queue: await _store.GetQueueAsync(i, ct).ConfigureAwait(false),
                    History: await _store.GetHistoryAsync(i, ct).ConfigureAwait(false)))).ConfigureAwait(false);
                foreach (var (instance, library, queue, history) in reads)
                {
                    revision.Append(instance.Id).Append(':').Append(instance.Name).Append(':').Append(instance.Role)
                        .Append(':').Append(string.Join(",", instance.LinkedLibraryIds))
                        .Append(':').Append(string.Join(",", instance.PathMappings.Select(m => m.ArrPath + ">" + m.JellyfinPath)))
                        .Append(':').Append(Stamp(library.LoadedAt)).Append(library.Error?.Kind.ToString() ?? string.Empty)
                        .Append(':').Append(Stamp(queue.LoadedAt)).Append(queue.Error?.Kind.ToString() ?? string.Empty).Append(queue.Stale ? "s" : string.Empty).Append(queue.Expired ? "x" : string.Empty)
                        .Append(':').Append(Stamp(history.LoadedAt)).Append(history.Error?.Kind.ToString() ?? string.Empty).Append(history.Expired ? "x" : string.Empty).Append(';');
                    // Past its longest serve time with the latest read failed, the queue says nothing
                    // about now: its rows aren't used (no frozen "Downloading 43%"), and titles of the
                    // instance that aren't in Jellyfin read "can't be checked" (see ArrCopyFacts.QueueUnknown).
                    // So is one that was never read and can't be (cold, and the read failed).
                    var unknown = queue.Expired || history.Expired || (queue.Value == null && queue.Error != null) || (history.Value == null && history.Error != null);
                    var queueLoadedAt = queue.LoadedAt?.UtcDateTime;
                    // The latest read failed: the held rows' time left is no longer known.
                    var queueStale = queue.Stale || (queue.Value != null && queue.Error != null);
                    Func<ArrQueueEntry, ArrQueueSeen?> seen = row => _store.QueueSeen(instance, row);
                    var queueIndex = queue.Value != null && !queue.Expired ? QueueIndex.GetValue(queue.Value, q => q.Records.Where(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId).HasValue).ToLookup(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId)!.Value)) : null;
                    // An expired history says nothing about now either: its last rows never decide a status.
                    var historyIndex = history.Value != null && !history.Expired ? HistoryIndex.GetValue(history.Value, h => h.Records.Where(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId).HasValue).ToLookup(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId)!.Value)) : null;
                    // Suspects are useful only while the queue is still within its serving limit.
                    var missedState = _store.MissedQueueState(instance);
                    var missed = queue.Expired ? Array.Empty<ArrQueueEntry>() : missedState.Current;
                    // A suspect can expire before the newer snapshot does. That changes the body
                    // even if the feed and the snapshot's timestamp have not changed.
                    revision.Append("missedExpired:").Append(string.Join(",", missedState.Expired.Select(r => r.Id))).Append(';');

                    foreach (var title in distinct.Where(t => t.IsMovie == (kind == ArrKind.Radarr)))
                    {
                        var facts = result.Facts[title];
                        if (library.Value == null)
                        {
                            facts.Unreadable.Add(new UnreadableArr(instance, instance.Name + " (" + (library.Error?.Kind.ToString() ?? "loading") + ")"));
                            continue;
                        }
                        facts.Checked.Add(instance);
                        if (library.Error != null) facts.Stale.Add(instance);
                        // Library reads above also populate aliases; decide access after they finish,
                        // once per title, even when several instances hold that title.
                        if (!access.TryGetValue(title, out var copyAccess))
                            access[title] = copyAccess = AccessOf(title, viewer, result.Copies[title] = CopiesOf(title, viewer));
                        if (kind == ArrKind.Radarr)
                        {
                            foreach (var movie in MoviesOf(library.Value, title))
                            {
                                if (!MayUseCopy(viewer, copyAccess, instance, movie.Path)) continue;
                                if (movie.TmdbId is > 0 and var canonical) NoteLiveKey(revision, facts, TitleKey.ForMovie(canonical.ToString(CultureInfo.InvariantCulture), null));
                                facts.Copies.Add(new ArrCopyFacts(instance)
                                {
                                    Movie = movie,
                                    LibraryLoadedAt = library.LoadedAt?.UtcDateTime,
                                    LeftQueue = (m, e) => _store.LeftQueueAt(instance, m, e)?.UtcDateTime,
                                    Queue = QueueRowsOf(queueIndex, missed, movie.Id, movie: true),
                                    History = historyIndex?[movie.Id].ToList() ?? new List<ArrHistoryEntry>(),
                                    Seen = seen,
                                    QueueLoadedAt = queueLoadedAt,
                                    QueueStale = queueStale || missed.Any(r => r.MovieId == movie.Id),
                                    QueueUnknown = unknown || missedState.Expired.Any(r => r.MovieId == movie.Id),
                                });
                            }
                        }
                        else
                        {
                            foreach (var series in SeriesOf(library.Value, title))
                            {
                                if (!MayUseCopy(viewer, copyAccess, instance, series.Path)) continue;
                                if (series.TvdbId is > 0 and var canonical) NoteLiveKey(revision, facts, TitleKey.ForSeries(canonical.ToString(CultureInfo.InvariantCulture), null, null));
                                ArrSnapshotRead<ArrEpisodesSnapshot>? episodes = null;
                                if (load.Contains(title)) episodes = await _store.GetEpisodesAsync(instance, series.Id, ct).ConfigureAwait(false);
                                else if (peek.Contains(title)) episodes = _store.PeekEpisodes(instance, series.Id);
                                if (episodes != null) revision.Append('e').Append(series.Id).Append(':').Append(Stamp(episodes.LoadedAt)).Append(';');
                                // Its episode list was needed and can't be read (nothing to serve meanwhile): the copy is judged by
                                // Sonarr's season counts, and administrators are told the list can't be read.
                                if (load.Contains(title) && episodes is { Value: null, Error: { } failed })
                                    facts.Unreadable.Add(new UnreadableArr(instance, instance.Name + " episode list (" + failed.Kind + ")"));
                                facts.Copies.Add(new ArrCopyFacts(instance)
                                {
                                    Series = series,
                                    Queue = QueueRowsOf(queueIndex, missed, series.Id, movie: false),
                                    History = historyIndex?[series.Id].ToList() ?? new List<ArrHistoryEntry>(),
                                    Episodes = episodes?.Value,
                                    LibraryLoadedAt = library.LoadedAt?.UtcDateTime,
                                    EpisodesLoadedAt = episodes?.LoadedAt?.UtcDateTime,
                                    LeftQueue = (m, e) => _store.LeftQueueAt(instance, m, e)?.UtcDateTime,
                                    Seen = seen,
                                    QueueLoadedAt = queueLoadedAt,
                                    QueueStale = queueStale || missed.Any(r => r.SeriesId == series.Id),
                                    QueueUnknown = unknown || missedState.Expired.Any(r => r.SeriesId == series.Id),
                                });
                            }
                        }
                    }
                }
            }
            result.Revision = revision.ToString();
            return result;
        }

        /// <summary>
        /// The queue rows of one movie or series: the snapshot's, plus the rows a paged read missed
        /// that aren't known to have left (<see cref="ArrStateStore.MissedQueueRows"/>), unless the
        /// snapshot holds that movie or episode after all.
        /// </summary>
        private static List<ArrQueueEntry> QueueRowsOf(ILookup<int, ArrQueueEntry>? index, IReadOnlyList<ArrQueueEntry> missed, int id, bool movie)
        {
            var rows = index?[id].ToList() ?? new List<ArrQueueEntry>();
            foreach (var row in missed)
            {
                if ((movie ? row.MovieId : row.SeriesId) != id) continue;
                if (rows.Any(r => movie ? r.MovieId == row.MovieId : r.EpisodeId == row.EpisodeId)) continue;
                rows.Add(row);
            }
            return rows;
        }

        /// <summary>
        /// Records the key the change feed announces a matched arr copy under (TMDB movie, TVDB
        /// series). When the title's own key is another one (IMDb, TMDB series), that key never
        /// moves in the feed, so the canonical key's revision joins the facts revision: a live patch
        /// of the copy (which keeps the snapshot's age) still changes the cached body.
        /// </summary>
        private void NoteLiveKey(StringBuilder revision, TitleFacts facts, TitleKey? canonical)
        {
            if (canonical == null || canonical.Equals(facts.Key)) return;
            facts.LiveKey ??= canonical;
            if (_feed != null) revision.Append("live:").Append(canonical).Append('=').Append(_feed.Revision(canonical.ToString()).ToString(CultureInfo.InvariantCulture)).Append(';');
        }

        private static string Stamp(DateTimeOffset? at) => at?.UtcTicks.ToString(CultureInfo.InvariantCulture) ?? "-";

        /// <summary>
        /// The change feed's revision of each title (its epoch first). The feed bumps a title for
        /// every change it sees — a queue row, a live library patch from SignalR or a webhook re-read
        /// (which keeps the snapshot's age), a new history event, its episodes, a Jellyfin add or
        /// remove — so a cached body never outlives a change the browser was just told about. A
        /// season or episode change also bumps its series, so the series key covers them.
        /// </summary>
        private void AppendFeedRevisions(StringBuilder revision, IEnumerable<TitleKey> titles)
        {
            if (_feed == null) return;
            revision.Append("feed:").Append(_feed.Epoch);
            foreach (var title in titles.OrderBy(t => t.ToString(), StringComparer.Ordinal))
            {
                revision.Append(',').Append(_feed.Revision(title.Title.ToString()).ToString(CultureInfo.InvariantCulture));
            }
            revision.Append(';');
        }
    }
}
