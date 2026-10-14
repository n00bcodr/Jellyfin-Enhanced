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
        }

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
        public async Task<StatusBody> ForBatchAsync(StatusViewer viewer, IReadOnlyList<Guid> ids, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken)
        {
            var items = new List<JfItemRef>();
            foreach (var id in ids.Distinct())
            {
                if (_view.Resolve(id, viewer) is { Key: not null } item) items.Add(item);
            }
            var titleKeys = keys.Where(k => !k.Season.HasValue).Distinct().ToList();
            var gather = await GatherAsync(viewer, items.Select(i => i.Key!.Title).Concat(titleKeys), loadEpisodes: null, peekEpisodes: items.Where(i => i.Kind is "season" or "episode").Select(i => i.Key!.Title), cancellationToken).ConfigureAwait(false);

            var cacheKey = CacheKey(viewer, "batch", string.Join(",", items.Select(i => i.ItemId.ToString("N", CultureInfo.InvariantCulture)).OrderBy(x => x, StringComparer.Ordinal))
                + "|" + string.Join(",", titleKeys.Select(k => k.ToString()).OrderBy(x => x, StringComparer.Ordinal)), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var statuses = new List<TitleStatus>();
            var seriesEpisodes = new Dictionary<Guid, IReadOnlyList<JfEpisode>>();
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
                        statuses.Add(StatusComposer.SeriesCard(facts, item, c, HiddenFromViewer(facts, item.ItemId, viewer)));
                        break;
                    case "season":
                        if (item.SeriesId is not Guid seriesId) break;
                        if (!seriesEpisodes.TryGetValue(seriesId, out var jf))
                        {
                            jf = _view.Episodes(seriesId, null, viewer, includeVirtual: false);
                            seriesEpisodes[seriesId] = jf;
                        }
                        statuses.Add(StatusComposer.Season(facts, item, jf, c, detail: false));
                        break;
                    case "episode":
                        statuses.Add(StatusComposer.Episode(facts, item, c, detail: false));
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

        /// <summary>
        /// The full status of one Jellyfin item for its details page (journey, seasons or episodes).
        /// No statuses (an empty list) when the viewer can't see the item, it is not a movie, series,
        /// season or episode, or it has no provider id: one quiet, cacheable answer for all three, so a
        /// details page of a person, collection or album costs one cheap request and no error.
        /// </summary>
        public async Task<StatusBody> ForItemAsync(StatusViewer viewer, Guid itemId, CancellationToken cancellationToken)
        {
            if (_view.Resolve(itemId, viewer) is not { Key: not null } item)
            {
                var none = CacheKey(viewer, "item", itemId.ToString("N", CultureInfo.InvariantCulture), "none");
                return Cache.Get(none) ?? Cache.Put(none, Serialize(Array.Empty<TitleStatus>()));
            }
            var title = item.Key.Title;
            var episodes = item.Kind is "series" or "season" or "episode" ? new[] { title } : Array.Empty<TitleKey>();
            var gather = await GatherAsync(viewer, new[] { title }, loadEpisodes: episodes, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            var cacheKey = CacheKey(viewer, "item", item.ItemId.ToString("N", CultureInfo.InvariantCulture), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            return Cache.Put(cacheKey, Serialize(new[] { ComposeItem(viewer, item, gather) }));
        }

        /// <summary>The details-page status of one resolved item from gathered facts (no caching).</summary>
        private TitleStatus ComposeItem(StatusViewer viewer, JfItemRef item, Gathered gather)
        {
            var title = item.Key!.Title;
            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var facts = gather.Facts[title];
            // Admins see every Sonarr holding a series; its Jellyfin copies tell which are in the library.
            var seriesCopies = viewer.IsAdmin && item.Kind != "movie" && facts.Copies.Count(x => x.Series != null) > 1 ? CopiesOf(title, viewer) : null;
            TitleStatus status;
            switch (item.Kind)
            {
                case "movie":
                    status = StatusComposer.Movie(facts, item, CopiesOf(title, viewer), c, detail: true);
                    break;
                case "series":
                    status = StatusComposer.Series(facts, item, _view.Episodes(item.ItemId, null, viewer, includeVirtual: false), _view.Seasons(item.ItemId, viewer), c, detail: true, seriesCopies);
                    break;
                case "season":
                    status = StatusComposer.Season(facts, item, item.SeriesId is Guid sid ? _view.Episodes(sid, item.Season, viewer, includeVirtual: viewer.DisplayMissingEpisodes) : Array.Empty<JfEpisode>(), c, detail: true, seriesCopies);
                    break;
                default:
                    status = StatusComposer.Episode(facts, item, c, detail: true, seriesCopies);
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
                if (_view.Resolve(id, viewer) is not { Key: not null } item) return null;
                var episodes = item.Kind is "series" or "season" or "episode" ? new[] { item.Key.Title } : Array.Empty<TitleKey>();
                var gathered = await GatherAsync(viewer, new[] { item.Key.Title }, loadEpisodes: null, peekEpisodes: episodes, cancellationToken).ConfigureAwait(false);
                return ComposeItem(viewer, item, gathered);
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
        internal async Task<IReadOnlyList<KeyedStatus>> ComposeForAsync(StatusViewer viewer, IReadOnlyList<TitleKey> keys, IReadOnlyDictionary<TitleKey, RequestScope>? scopes, CancellationToken cancellationToken)
        {
            var titles = keys.Select(k => k.Title).Distinct().ToList();
            var gather = await GatherAsync(viewer, titles, loadEpisodes: null, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            var result = new List<KeyedStatus>();
            foreach (var title in titles)
            {
                RequestScope? scope = scopes != null && scopes.TryGetValue(title, out var s) ? s : null;
                if (Compose(viewer, gather, title, detail: false, scope) is not { } composed) continue;
                result.Add(scope != null ? Scoped(viewer, gather, composed, scope) : composed);
            }
            return result;
        }

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
        public async Task<StatusBody> ForKeyDetailAsync(StatusViewer viewer, TitleKey key, CancellationToken cancellationToken)
        {
            var title = key.Title;
            var gather = await GatherAsync(viewer, new[] { title }, loadEpisodes: null, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            var cacheKey = CacheKey(viewer, "key", title.ToString(), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;
            var composed = Compose(viewer, gather, title, detail: true);
            return Cache.Put(cacheKey, Serialize(composed == null ? Array.Empty<TitleStatus>() : new[] { composed.Status }));
        }

        /// <summary>
        /// The Jellyfin season or episode item a season/episode key names, when the viewer can see the
        /// series (a virtual episode included); null otherwise or for movie/series keys.
        /// </summary>
        internal JfItemRef? ScopeItem(StatusViewer viewer, TitleKey key)
        {
            if (key.IsMovie || key.Season is not int season) return null;
            if (CopiesOf(key.Title, viewer).FirstOrDefault(x => x.Visible) is not { } series) return null;
            Guid? id = key.Episode is int e
                ? _view.Episodes(series.ItemId, season, viewer, includeVirtual: true)
                    .FirstOrDefault(x => !x.Hidden && x.Season == season && new EpisodeRange(x.Episode, x.EpisodeEnd).Contains(e))?.ItemId
                : _view.Seasons(series.ItemId, viewer).FirstOrDefault(x => !x.Hidden && x.Season == season)?.ItemId;
            return id is Guid found ? _view.Resolve(found, viewer) : null;
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
            var gather = await GatherAsync(viewer, new[] { title }, loadEpisodes: new[] { title }, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
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
        /// </summary>
        internal sealed record KeyedStatus(TitleKey Key, TitleStatus Status, JfCopy? Visible, bool Scoped = false, DateTime? ArrivedAt = null);

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
        internal sealed record RequestScope(IReadOnlyList<int> Seasons, bool Only4k, RequestFacts? Request, bool Available = false, DateTime? AvailableAt = null, Guid? JellyfinItemId = null)
        {
            /// <summary>A stable text form (part of the cache key; the request facts follow the read model's revision).</summary>
            public override string ToString() => string.Join(".", Seasons) + (Only4k ? "4k" : string.Empty) + (Available ? "a" : string.Empty)
                + (JellyfinItemId is Guid id ? "@" + id.ToString("N", CultureInfo.InvariantCulture) : string.Empty);
        }

        /// <summary>The copy Seerr matched a 4K request to, when it is one the viewer can open (else null).</summary>
        private static JfCopy? SeerrCopy(RequestScope scope, IReadOnlyList<JfCopy> copies)
            => scope.JellyfinItemId is Guid id ? copies.FirstOrDefault(x => x.Visible && x.ItemId == id) : null;

        /// <summary>
        /// A body built from many titles composed by key (the Requests page), cached per user like
        /// the status bodies: <paramref name="what"/> names everything else the body depends on.
        /// Titles the viewer may not ask about by key are left out. Never calls an arr.
        /// </summary>
        internal async Task<StatusBody> ForTitlesAsync(StatusViewer viewer, IReadOnlyList<TitleKey> keys, string route, string what, Func<IReadOnlyList<KeyedStatus>, byte[]> build, CancellationToken cancellationToken, IReadOnlyDictionary<TitleKey, RequestScope>? scopes = null)
        {
            var titles = keys.Select(k => k.Title).Distinct().ToList();
            var gather = await GatherAsync(viewer, titles, loadEpisodes: null, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            RequestScope? ScopeOf(TitleKey t) => scopes != null && scopes.TryGetValue(t, out var scope) ? scope : null;
            var cacheKey = CacheKey(viewer, route, what + "|" + string.Join(",", titles.Select(t => t + (ScopeOf(t) is { } scope ? "@" + scope : string.Empty))), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;
            var result = new List<KeyedStatus>();
            foreach (var title in titles)
            {
                if (Compose(viewer, gather, title, detail: false, ScopeOf(title)) is not { } composed) continue;
                result.Add(ScopeOf(title) is { } asked ? Scoped(viewer, gather, composed, asked) : composed);
            }
            return Cache.Put(cacheKey, build(result));
        }

        /// <summary>
        /// The status of the part of a title that was asked for (requested seasons; the 4K copy),
        /// when that differs from the whole title. Jellyfin and memory only.
        /// </summary>
        private KeyedStatus Scoped(StatusViewer viewer, Gathered gather, KeyedStatus whole, RequestScope scope)
        {
            var whose = gather.Facts[whole.Key];
            var c = Context(viewer);
            var copies = CopiesOf(whole.Key, viewer);
            if (scope.Only4k && !_store.Instances(whole.Key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr).Any(i => i.Role == "4k"))
            {
                // No 4K instance set up in Jellyfin Enhanced: the standard copy says nothing about the
                // 4K one, so the request (and Seerr's word that the 4K copy is available) is all there is.
                var (only, at) = StatusComposer.RequestedOnly(whole.Status, scope.Request, scope.Available, scope.AvailableAt);
                // Never the standard copy: Play opens the 4K copy Seerr names, when the viewer can open it.
                return whole with { Status = WithLiveKey(only, whose), Visible = SeerrCopy(scope, copies), Scoped = true, ArrivedAt = at };
            }
            var facts = new TitleFacts(whose.Key) { Request = scope.Request, LiveKey = whose.LiveKey };
            facts.Copies.AddRange(whose.Copies);
            facts.Unreadable.AddRange(whose.Unreadable);
            facts.Stale.AddRange(whose.Stale);
            facts.Checked.AddRange(whose.Checked);
            if (whole.Key.IsMovie && scope.Only4k)
            {
                var (status, arrived, shown) = StatusComposer.Requested4k(facts, whole.Status, copies, c, SeerrCopy(scope, copies));
                return whole with { Status = WithLiveKey(status, facts), Visible = shown ?? SeerrCopy(scope, copies), Scoped = true, ArrivedAt = arrived };
            }
            var seasons = scope.Seasons;
            if (!whole.Key.IsMovie && scope.Only4k && seasons.Count == 0)
            {
                seasons = StatusComposer.FourKOnly(facts).Copies.Where(x => x.Series != null)
                    .SelectMany(x => x.Series!.Seasons).Where(s => s.Monitored && s.SeasonNumber > 0)
                    .Select(s => s.SeasonNumber).Distinct().OrderBy(n => n).ToList();
                if (seasons.Count == 0)
                {
                    var (only, at) = StatusComposer.RequestedOnly(whole.Status, scope.Request, scope.Available, scope.AvailableAt);
                    return whole with { Status = WithLiveKey(only, facts), Visible = SeerrCopy(scope, copies), Scoped = true, ArrivedAt = at };
                }
            }
            if (!whole.Key.IsMovie && seasons.Count > 0)
            {
                // A 4K request is followed (and "no 4K Sonarr has it" judged) through the 4K Sonarrs only.
                if (scope.Only4k) facts = StatusComposer.FourKOnly(facts);
                var shown = whole.Visible;
                var mine = copies;
                if (scope.Only4k)
                {
                    // The Jellyfin copies matched to the 4K Sonarr copies: their episodes, not the standard copy's.
                    var siblings = StatusComposer.SeriesCopies(whose);
                    // Positive matches only (never "the only copy there is": it may be the standard one).
                    mine = facts.Copies.Where(x => x.Series != null).SelectMany(x => StatusComposer.MatchCopies(x, copies, siblings, soleFallback: false)).Distinct().ToList();
                    shown = mine.FirstOrDefault(x => x.Visible) ?? SeerrCopy(scope, copies);
                    if (mine.Count == 0 && shown != null) mine = new List<JfCopy> { shown };
                }
                var episodes = shown != null ? _view.Episodes(shown.ItemId, null, viewer, includeVirtual: false) : null;
                var (status, arrived) = StatusComposer.RequestedSeasons(facts, whole.Status, seasons, episodes, mine, c, scope.Only4k);
                // A 4K scope never falls back to the standard copy (Play would open the HD item).
                return whole with { Status = WithLiveKey(status, facts), Visible = scope.Only4k ? shown : shown ?? whole.Visible, Scoped = true, ArrivedAt = arrived };
            }
            return whole;
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
        /// title with an openable arr destination and no parental limits. Unresolved destinations
        /// require every library. Their own request grants access only while Jellyfin has no copy.
        /// </summary>
        private bool MayAskByKey(StatusViewer viewer, TitleKey key, IReadOnlyList<JfCopy> copies)
        {
            if (viewer.IsAdmin || copies.Any(x => x.Visible)) return true;
            if (copies.Count > 0) return !viewer.HasParentalLimit;
            if (AskedBy(key, viewer)) return true;
            if (viewer.HasParentalLimit) return false;
            var holders = _store.Instances(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr)
                .SelectMany(i => PathsOf(i, key).Select(path => (Instance: i, Path: path))).ToList();
            return holders.Count > 0 ? holders.Any(c => MayUseCopy(viewer, new CopyAccess(true, false, false), c.Instance, c.Path))
                : viewer.Handle is User user && ArrInstanceLibraries.CanOpenEveryLibrary(user, _libraries.Libraries());
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

        private CopyAccess AccessOf(TitleKey key, StatusViewer viewer)
        {
            var copies = CopiesOf(key, viewer);
            var absent = copies.Count == 0;
            return new CopyAccess(absent, copies.Any(c => c.Visible), absent && AskedBy(key, viewer));
        }

        private bool MayUseCopy(StatusViewer viewer, CopyAccess access, ArrConnection instance, string? path)
        {
            if (viewer.IsAdmin) return true;
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

        private void ApplyRequests(Gathered gathered, StatusViewer viewer)
        {
            foreach (var (key, facts) in gathered.Facts) facts.Request = _requests.For(key, viewer);
        }

        private ComposeContext Context(StatusViewer viewer)
        {
            var config = _config();
            return new(viewer, _now().UtcDateTime, config?.ArrStatusLookingHours ?? 24) { HandoffGrace = HandoffGrace(config) };
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
                (config?.ArrHouseholdContactName ?? string.Empty) + "#" + (config?.ArrStatusLookingHours ?? 24).ToString(CultureInfo.InvariantCulture)
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

        private sealed class Gathered
        {
            public Dictionary<TitleKey, TitleFacts> Facts { get; } = new();

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
                            access[title] = copyAccess = AccessOf(title, viewer);
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
