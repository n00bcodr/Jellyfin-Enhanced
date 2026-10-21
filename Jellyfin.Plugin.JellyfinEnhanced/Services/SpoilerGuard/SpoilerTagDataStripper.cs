using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The effective Spoiler Guard tag-strip policy for one user: the admin strip toggles with the user's
    /// per-category opt-outs applied ("user opt-out wins", null override = inherit admin = strip).
    /// </summary>
    public sealed class SpoilerTagStripPolicy
    {
        internal SpoilerTagStripPolicy(UserSpoilerBlur state, bool stripGenres, bool stripRatings, bool replaceTitle, bool stripOverview)
        {
            State = state;
            StripGenres = stripGenres;
            StripRatings = stripRatings;
            ReplaceTitle = replaceTitle;
            StripOverview = stripOverview;
        }

        /// <summary>The user's spoiler state the policy was built from (non-empty).</summary>
        public UserSpoilerBlur State { get; }

        /// <summary>Strip genres, languages and stream data (SpoilerStripTags).</summary>
        public bool StripGenres { get; }

        /// <summary>Strip community/critic ratings and an Episode/Season's own age rating (SpoilerStripRatings).</summary>
        public bool StripRatings { get; }

        /// <summary>Episode titles are replaced (SpoilerReplaceTitle).</summary>
        public bool ReplaceTitle { get; }

        /// <summary>Descriptions are stripped (SpoilerStripOverview).</summary>
        public bool StripOverview { get; }

        /// <summary>Title-bearing stream fields must be sanitized.</summary>
        public bool SanitizeTitleStreams => ReplaceTitle || StripOverview;

        /// <summary>
        /// A one-way fingerprint of the policy (the viewer's state and the effective strip flags): a request re-reads it
        /// before it emits, and answers again when it changed while the request was waiting.
        /// </summary>
        public string Revision => _revision ??= Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(
            Newtonsoft.Json.JsonConvert.SerializeObject(State) + "|" + StripGenres + StripRatings + ReplaceTitle + StripOverview)));

        private string? _revision;

        /// <summary>The revision of a possibly absent policy ("-": nothing is stripped).</summary>
        public static string RevisionOf(SpoilerTagStripPolicy? policy) => policy?.Revision ?? "-";
    }

    /// <summary>Which Spoiler Guard stub POST /tag-data returns for an item.</summary>
    public enum SpoilerTagDataStub
    {
        /// <summary>No stub: the item gets its regular projection.</summary>
        None,

        /// <summary>Unwatched episode of a guarded series.</summary>
        Episode,

        /// <summary>A guarded series.</summary>
        Series,

        /// <summary>Unwatched movie in spoiler scope (directly or via an opted-in collection).</summary>
        Movie,

        /// <summary>A season after S1 of a guarded series with no watched episode.</summary>
        Season,

        /// <summary>An extra (trailer, featurette, theme song or video) of a guarded title, by its owner's rules.</summary>
        Extra,
    }

    // Spoiler Guard's stripping of JE tag data, shared by GET /tag-cache, POST
    // /tag-data (JellyfinEnhancedController) and native poster tags (so a
    // poster baked for a guarded item shows exactly what the web overlays
    // would: nothing that the web hides). Extracted verbatim from the
    // controller; the decisions mirror SpoilerBlurImageFilter and
    // SpoilerFieldStripFilter (played episodes/movies pass, S0/S1 seasons and
    // seasons with any watched episode are exempt, collections pass).
    //
    // TagCacheService stores ONE shared TagCacheEntry per item across ALL
    // users: every strip clones, never mutates.
    public sealed class SpoilerTagDataStripper
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerUserResolver _spoilerResolver;
        private readonly MediaBrowser.Model.Globalization.ILocalizationManager? _localization;
        private readonly SpoilerNextUnwatchedService? _nextUnwatched;

        public SpoilerTagDataStripper(ILibraryManager libraryManager, IUserDataManager userDataManager, SpoilerUserResolver spoilerResolver,
            MediaBrowser.Model.Globalization.ILocalizationManager? localization = null, SpoilerNextUnwatchedService? nextUnwatched = null)
        {
            // The shared next-unwatched boundary (advanced reveals); without it, computed per ask.
            _nextUnwatched = nextUnwatched;
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _spoilerResolver = spoilerResolver;
            // The host's closed lists (languages, ratings) a guarded entry's values are checked against.
            _localization = localization;
            // Verdict inputs with revisions: the watched-state and ownership changes the delivery gate compares, and the
            // events that invalidate the ownership memo below.
            PrivacyInputs.Observe(libraryManager, userDataManager);
            var self = new WeakReference<SpoilerTagDataStripper>(this);
            Action<IReadOnlyCollection<Guid>>? forget = null;
            forget = ids => { if (self.TryGetTarget(out var stripper)) stripper.Forget(ids); else PrivacyInputs.LibraryChanged -= forget; };
            PrivacyInputs.LibraryChanged += forget;
        }

        /// <summary>What the host vouches for in one strip (its closed lists, the library's entities).</summary>
        public PrivacyValueHost Host() => new(_libraryManager, _localization);

        /// <summary>
        /// True when Spoiler Guard is on with at least one tag-relevant strip toggle, i.e. when the endpoints
        /// load the user's spoiler state at all. Each overlay has its own admin toggle; title replacement or
        /// overview strip alone must also trigger the strip so stream titles can't leak episode titles.
        /// </summary>
        public static bool IsConfigured(PluginConfiguration? cfg)
            => cfg?.SpoilerBlurEnabled == true
                && (cfg.SpoilerStripTags || cfg.SpoilerStripRatings || cfg.SpoilerReplaceTitle || cfg.SpoilerStripOverview);

        /// <summary>
        /// The effective policy for a user, or null when nothing is stripped: Spoiler Guard off, no strip
        /// toggle, no spoiler state or an empty one (all three of Series/Movies/Collections), or the user
        /// opted out of every category the admin enabled.
        /// </summary>
        public static SpoilerTagStripPolicy? CreatePolicy(PluginConfiguration? cfg, UserSpoilerBlur? state)
        {
            if (!IsConfigured(cfg)) return null;
            // Empty lists = nothing to strip; check all three dicts, not just
            // Series.Count, so a movies-only user isn't short-circuited.
            if (state == null || (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0 && state.ProviderTitles.Count == 0 && state.PendingTmdb.Count == 0))
            {
                return null;
            }

            var prefs = state.Prefs;
            var stripGenres = cfg!.SpoilerStripTags && (prefs?.HideTags ?? true);
            var stripRatings = cfg.SpoilerStripRatings && (prefs?.HideRatings ?? true);
            var replaceTitle = cfg.SpoilerReplaceTitle && (prefs?.ReplaceEpisodeTitles ?? true);
            var stripOverview = cfg.SpoilerStripOverview && (prefs?.HideEpisodeDescriptions ?? true);
            // The user opted out of everything the admin enabled: nothing to do.
            if (!(stripGenres || stripRatings || replaceTitle || stripOverview)) return null;
            return new SpoilerTagStripPolicy(state, stripGenres, stripRatings, replaceTitle, stripOverview);
        }

        /// <summary>
        /// Which guarded kind (Episode/Season/Movie/Series) a tag-cache entry is under this user's Spoiler
        /// Guard, or null when it isn't guarded. <paramref name="key"/> is the item id in N format.
        /// </summary>
        public string? GetGuardedKind(UserSpoilerBlur state, string key, TagCacheEntry? e)
            => GetGuardedKind(state, key, e, null);

        /// <summary>
        /// As <see cref="GetGuardedKind(UserSpoilerBlur, string, TagCacheEntry?)"/>, with the series each episode or season
        /// entry belongs to now already read in one batch (<see cref="EntrySeries(IReadOnlyDictionary{string, TagCacheEntry}, UserSpoilerBlur?)"/>).
        /// </summary>
        public string? GetGuardedKind(UserSpoilerBlur state, string key, TagCacheEntry? e, IReadOnlyDictionary<string, (Guid Series, string? Key)>? series)
        {
            if (e == null || !Guid.TryParse(key, out var id)) return null;
            if (!Enum.TryParse<BaseItemKind>(e.Type, out var kind) || kind is not (BaseItemKind.Movie or BaseItemKind.Series or BaseItemKind.Season or BaseItemKind.Episode)) return null;
            // The entry's own owner facts (no per-entry library lookup over a whole cache), asked through the one scope
            // rule every Spoiler Guard site uses: a movie by its id, a guarded collection or its TMDB key; a series, season
            // or episode by the owning series' id or key.
            var owned = kind is BaseItemKind.Season or BaseItemKind.Episode;
            var (current, seriesKey) = !owned ? (Guid.Empty, null) : series is RiderPass pass ? Stored(e, pass.SeriesKeys, pass.Keyed)
                : series != null && series.TryGetValue(key, out var known) ? known : EntrySeries(id, e);
            var owner = owned ? current : id;
            if (owner == Guid.Empty) return null;
            // A movie's key is the library's current one where it was read (an entry names the key it was built with).
            var titleKey = owned ? seriesKey : kind == BaseItemKind.Movie && series != null && series.TryGetValue(key, out var movie) ? movie.Key
                : HiddenContentPolicy.TitleIdentity(kind == BaseItemKind.Movie ? "movie" : "tv", e.TmdbId);
            var identity = new PrivacyIdentity(id, kind, owner, titleKey,
                Array.Empty<Guid>(), null, owned ? BaseItemKind.Series : kind);
            return _spoilerResolver.InSpoilerScope(state, identity) ? e.Type : null;
        }

        /// <summary>
        /// The series an episode's or season's entry belongs to NOW and that series' typed TMDB key, read from the library's
        /// current item (a cached or persisted entry names the series and key it was built under, which a move or a new key
        /// since leaves behind). An item the library no longer has keeps its entry's series, with that series' current key.
        /// </summary>
        public (Guid Series, string? Key) EntrySeries(Guid id, TagCacheEntry e)
        {
            if (PrivacyReads.Item(_libraryManager, id) is { } item and (Episode or Season))
            {
                var identity = PrivacyIdentities.Of(_libraryManager, item);
                return (identity.OwnerId, identity.TitleKey);
            }
            return Stored(e);
        }

        /// <summary>
        /// An entry's stored series and that series' current key (its own stored key only when the series is gone). Each
        /// distinct series is read once per pass (<paramref name="keys"/>): a pass over a thousand episodes of one show reads
        /// the show once, and its facts (or its absence) are recorded once.
        /// </summary>
        private (Guid Series, string? Key) Stored(TagCacheEntry e, Dictionary<Guid, string?>? keys = null, bool keyed = true)
        {
            var stored = Guid.TryParse(e.SeriesId, out var series) ? series : Guid.Empty;
            string? key = null;
            if (stored != Guid.Empty && keyed)
            {
                if (keys == null || !keys.TryGetValue(stored, out key))
                {
                    key = PrivacyIdentities.TitleKey(PrivacyReads.Item(_libraryManager, stored));
                    if (keys != null) keys[stored] = key;
                }
            }
            return (stored, key ?? HiddenContentPolicy.TitleIdentity("tv", e.SeriesTmdbId));
        }

        /// <summary>Whether a viewer's Spoiler Guard state can guard a series (by id, provider key or a pending key).</summary>
        private static bool GuardsSeries(UserSpoilerBlur state)
            => state.Series.Count > 0 || state.ProviderTitles.Keys.Any(k => k.StartsWith("tv:", StringComparison.Ordinal))
                || state.PendingTmdb.Keys.Any(k => k.StartsWith("tv:", StringComparison.Ordinal));

        /// <summary>Whether a viewer's Spoiler Guard state can guard a movie by its provider key.</summary>
        private static bool GuardsMovieKeys(UserSpoilerBlur state)
            => state.ProviderTitles.Keys.Any(k => k.StartsWith("movie:", StringComparison.Ordinal))
                || state.PendingTmdb.Keys.Any(k => k.StartsWith("movie:", StringComparison.Ordinal));

        /// <summary>
        /// The series every episode and season entry belongs to now and that series' key (and a movie entry's own key), read
        /// from the library in one batched lookup (the same identity resolver the item answers use; the facts each was judged
        /// by are compared with the live items at the gate). Only the entries whose verdict those facts can decide:
        /// with <paramref name="state"/> given, episodes and seasons when it guards a series, movies when it guards a
        /// movie by its provider key; every one without a state (Hidden Content's rules).
        /// </summary>
        public Dictionary<string, (Guid Series, string? Key)> EntrySeries(IReadOnlyDictionary<string, TagCacheEntry> items, UserSpoilerBlur? state = null)
        {
            var answer = new Dictionary<string, (Guid Series, string? Key)>(StringComparer.Ordinal);
            var tv = state == null || GuardsSeries(state);
            var movies = state == null || GuardsMovieKeys(state);
            if (!tv && !movies) return answer;
            var ids = new Dictionary<Guid, string>();
            foreach (var (key, entry) in items)
                if ((tv && entry?.Type is "Episode" or "Season" || movies && entry?.Type == "Movie") && Guid.TryParse(key, out var id)) ids[id] = key;
            if (ids.Count == 0) return answer;
            var resolved = PrivacyIdentities.Resolve(_libraryManager, ids.Keys);
            var stored = new Dictionary<Guid, string?>();
            foreach (var (id, key) in ids)
            {
                var entry = items[key];
                if (entry?.Type == "Movie")
                {
                    answer[key] = (id, resolved.TryGetValue(id, out var film) ? film.TitleKey : HiddenContentPolicy.TitleIdentity("movie", entry.TmdbId));
                    continue;
                }
                answer[key] = resolved.TryGetValue(id, out var identity) && identity.Kind is BaseItemKind.Episode or BaseItemKind.Season
                    ? (identity.OwnerId, identity.TitleKey) : Stored(entry!, stored);
            }
            return answer;
        }

        /// <summary>
        /// Whether an image owner known only by id, type and (for Episode/Season) series id is under this
        /// user's Spoiler Guard: the <see cref="GetGuardedKind"/> rule on a probe entry, regardless of played
        /// state, season exemptions or strip toggles (native poster tags: token minting and image caching).
        /// </summary>
        public bool IsGuarded(UserSpoilerBlur state, Guid ownerId, string ownerType, string? ownerSeriesIdN)
        {
            if (state.Series.Count == 0 && state.Movies.Count == 0 && state.Collections.Count == 0 && state.ProviderTitles.Count == 0 && state.PendingTmdb.Count == 0) return false;
            // Any other kind may be an extra of a guarded title: its owner decides, as for tag data.
            if (!IsTitleKind(ownerType))
                return PrivacyReads.Item(_libraryManager, ownerId) is { } item && PrivacyIdentities.Of(_libraryManager, item) is { IsExtra: true } identity && _spoilerResolver.InSpoilerScope(state, identity);
            var probe = new TagCacheEntry { Type = ownerType, SeriesId = ownerSeriesIdN };
            return GetGuardedKind(state, ownerId.ToString("N"), probe) != null;
        }

        /// <summary>The kinds a tag-cache entry describes by itself (Spoiler Guard's titles and a collection).</summary>
        private static bool IsTitleKind(string? type) => type is "Movie" or "Series" or "Season" or "Episode" or "BoxSet";

        /// <summary>
        /// The owners of the entries whose kind is not a title of their own (a Video, Trailer or Audio entry may be a theme
        /// video, trailer or featurette of a guarded or hidden title): one batched identity lookup, since cache entries do
        /// not carry their owner. Keyed like the cache (N format); extras only.
        /// </summary>
        public Dictionary<string, PrivacyIdentity> OwnedIdentities(IReadOnlyDictionary<string, TagCacheEntry> items, JUser? viewer)
        {
            var ids = new List<Guid>();
            foreach (var (key, entry) in items)
            {
                if (entry == null || IsTitleKind(entry.Type) || !Guid.TryParse(key, out var id)) continue;
                // An entry already known not to be an extra needs no lookup (its remembered facts are replayed: compared with
                // the live library at every check); an extra is resolved again every time (its owner's verdict and watched
                // state are the viewer's, and current).
                if (NotAnExtra(id)) continue;
                ids.Add(id);
            }
            if (ids.Count == 0) return new Dictionary<string, PrivacyIdentity>(StringComparer.Ordinal);
            // The memo is dropped by the library's ownership events (PrivacyInputs) and by a check that finds its facts changed:
            // an item whose owner changed while it was being resolved is not remembered from that resolution.
            var since = PrivacyInputs.Now;
            var chains = new Dictionary<Guid, List<(Guid Id, PrivacyFacts? Facts)>>();
            var resolved = PrivacyIdentities.Resolve(_libraryManager, ids, viewer, _userDataManager, null, chains);
            var owned = resolved.Where(p => p.Value.IsExtra).ToDictionary(p => p.Key.ToString("N"), p => p.Value, StringComparer.Ordinal);
            lock (_notExtras)
            {
                // Under the lock Forget takes: an event logged after this read drops what is written here.
                var changed = PrivacyInputs.LibraryChangesSince(since);
                if (changed == null) return owned;
                if (_notExtras.Count > MaxKnownExtras) _notExtras.Clear();
                // Only an item the library resolved, as no extra, is remembered as one: an unresolved id is never a negative.
                foreach (var (id, identity) in resolved)
                    if (!identity.IsExtra && !changed.Contains(id) && chains.TryGetValue(id, out var chain) && chain.Count == 1 && chain[0].Facts is { } facts)
                        _notExtras[id] = facts;
            }
            return owned;
        }

        /// <summary>
        /// The library items known not to be extras, with the facts that judgment consumed (an item that names no owner), until
        /// a library ownership event for them (<see cref="Forget"/>) or a check that finds those facts changed.
        /// </summary>
        private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, PrivacyFacts> _notExtras = new();

        /// <summary>
        /// Whether <paramref name="id"/> is remembered as no extra: a hit replays the facts that judgment consumed into the
        /// current answer (the negative is evidence the answer used, as the positive is).
        /// </summary>
        private bool NotAnExtra(Guid id)
        {
            if (!_notExtras.TryGetValue(id, out var facts)) return false;
            if (PrivacyReadSet.Current is { } reads)
            {
                reads.Item(_libraryManager, id, facts);
                reads.OnStale(id, () => _notExtras.TryRemove(id, out _));
            }
            return true;
        }

        private const int MaxKnownExtras = 500_000;

        /// <summary>Drops the ownership memo of items whose ownership facts changed (or may have: added, removed).</summary>
        private void Forget(IReadOnlyCollection<Guid> ids)
        {
            lock (_notExtras)
                foreach (var id in ids) _notExtras.TryRemove(id, out _);
        }

        /// <summary>
        /// THE guarded set of a tag-cache answer, the one derivation full loads and deltas share (the strip, the strip
        /// fingerprint and a delta's riders all read it): every entry whose title is in the viewer's spoiler scope, by kind
        /// (<see cref="GetGuardedKind"/>), and every extra whose owner is (<paramref name="owned"/>, the batched owner lookup),
        /// "Extra". Membership is scope only: watched state decides what a member is stripped of, never whether it is a
        /// member, so a title watched or unwatched since the client's copy is corrected by the next delta, not a full load.
        /// </summary>
        public Dictionary<string, string> GuardedSet(UserSpoilerBlur state, IReadOnlyDictionary<string, TagCacheEntry> items, IReadOnlyDictionary<string, PrivacyIdentity> owned,
            IReadOnlyDictionary<string, (Guid Series, string? Key)>? series = null)
        {
            var set = new Dictionary<string, string>(StringComparer.Ordinal);
            // Every episode and season entry by the series the library holds it under now (one batched lookup).
            series ??= EntrySeries(items, state);
            foreach (var (key, entry) in items)
            {
                if (owned.TryGetValue(key, out var identity))
                {
                    if (_spoilerResolver.InSpoilerScope(state, identity)) set[key] = "Extra";
                    continue;
                }
                if (GetGuardedKind(state, key, entry, series) is { } kind) set[key] = kind;
            }
            return set;
        }

        /// <summary>
        /// Whether an unchanged entry rides with a delta: it may be in <see cref="GuardedSet"/> (a guarded title's entry, or
        /// an entry that may be an extra, whose owner only the batched lookup knows). Riders outside the set leave again
        /// (<see cref="StripTagCache"/> with the delta's cursor).
        /// </summary>
        public bool MayBeGuarded(UserSpoilerBlur state, string key, TagCacheEntry? entry) => Riders(state)(key, entry!);

        /// <summary>
        /// The rider test of one delta (<see cref="MayBeGuarded"/>), sharing its reads: each distinct stored series is read
        /// once for the whole pass, not once per entry.
        /// </summary>
        public Func<string, TagCacheEntry, bool> Riders(UserSpoilerBlur state)
        {
            // A show's key is read only when the viewer guards a show by its key (a guard by id needs no read).
            var pass = new RiderPass { Keyed = state.ProviderTitles.Keys.Any(k => k.StartsWith("tv:", StringComparison.Ordinal))
                || state.PendingTmdb.Keys.Any(k => k.StartsWith("tv:", StringComparison.Ordinal)) };
            return (key, entry) => entry != null && (GetGuardedKind(state, key, entry, pass) != null
                || !IsTitleKind(entry.Type) && !(Guid.TryParse(key, out var id) && NotAnExtra(id)));
        }

        /// <summary>
        /// A delta's riders are chosen by their entries' stored series (a cheap per-entry test over the whole cache: one read
        /// per distinct series); the guarded set the answer is stripped by is then decided from the library's current series.
        /// </summary>
        private sealed class RiderPass : Dictionary<string, (Guid Series, string? Key)>
        {
            public RiderPass() : base(StringComparer.Ordinal) { }

            /// <summary>The key of each distinct stored series this pass read.</summary>
            public Dictionary<Guid, string?> SeriesKeys { get; } = new();

            /// <summary>Whether a show's key can decide its scope for this viewer (else a stored series is not read).</summary>
            public bool Keyed { get; init; }
        }

        /// <summary>Whether an extra is stripped for this viewer: its owner is guarded, and a movie's extra until the movie is watched.</summary>
        private bool ExtraGuarded(UserSpoilerBlur state, PrivacyIdentity identity)
            => identity.IsExtra && _spoilerResolver.InSpoilerScope(state, identity) && !(identity.OwnerKind == BaseItemKind.Movie && identity.Played == true);

        /// <summary>
        /// GET /tag-cache strip: replaces every guarded, not-exempt entry of <paramref name="items"/> with a
        /// stripped clone. Played state is looked up in ONE bounded query instead of a UserData read per entry.
        /// Returns a fingerprint of the effective strip flags and the guarded set (<see cref="GuardedSet"/>; the client
        /// replaces its stored copy, rather than applying a delta, when it changes). With a delta's <paramref name="since"/>,
        /// the unchanged entries that rode along without being in the set leave.
        /// </summary>
        public string StripTagCache(SpoilerTagStripPolicy policy, JUser user, Dictionary<string, TagCacheEntry> items, IReadOnlyDictionary<string, PrivacyIdentity>? owned = null, long? since = null,
            IReadOnlyDictionary<string, (Guid Series, string? Key)>? series = null)
        {
            var spState = policy.State;
            // What the host vouches for, memoized for the whole strip (series ratings and genres, tables).
            var host = Host();
            var extras = owned ?? OwnedIdentities(items, user);
            // Every episode and season entry by the series the library holds it under now (one batched lookup): the guarded
            // set, the vocabulary and the age-rating source all use this reconciled owner.
            series ??= EntrySeries(items, spState);
            // Kind per guarded key: the one derivation, reused by every pass below.
            var guardedKinds = GuardedSet(spState, items, extras, series);
            if (since is { } cursor)
                foreach (var (key, entry) in items.ToList())
                    if (entry != null && entry.LastUpdated <= cursor && !guardedKinds.ContainsKey(key)) items.Remove(key);

            // Played state is looked up in ONE bounded query instead of a UserData read per entry (with whole libraries
            // guarded that was thousands of reads and seconds per cache load): the guarded episodes and movies; the set it
            // answered is a fact of the answer (the same query at every check).
            var playedCandidates = new List<Guid>();
            var laterSeasons = new List<Season>();
            foreach (var (key, kind) in guardedKinds)
            {
                if (!Guid.TryParse(key, out var cGuid)) continue;
                if (kind is "Episode" or "Movie")
                {
                    playedCandidates.Add(cGuid);
                }
                else if (kind == "Season"
                    && PrivacyReads.Item<BaseItem>(_libraryManager, cGuid) is Season laterSeason
                    && laterSeason.IndexNumber.GetValueOrDefault(int.MaxValue) > 1)
                {
                    laterSeasons.Add(laterSeason);
                }
            }
            var playedIds = LoadPlayedIdsForTagStrip(user, playedCandidates);
            // Each guarded later season's watched evidence (any of the episodes the host lists in it played): a fact per
            // season, the same value whether a season was probed or skipped by the played-series prefilter.
            var seasonWatched = LaterSeasonsWatched(user, laterSeasons);

            var revisionKeys = guardedKinds.Keys.ToList();
            revisionKeys.Sort(StringComparer.Ordinal);
            var fingerprint = $"g{(policy.StripGenres ? 1 : 0)}r{(policy.StripRatings ? 1 : 0)}t{(policy.SanitizeTitleStreams ? 1 : 0)}|{string.Join(',', revisionKeys)}";

            // The owners whose vocabulary and age rating the strip copies, read in one batch (not once per owner).
            host.Prefetch(guardedKinds.Keys.Select(k => series.TryGetValue(k, out var s) ? s.Series : Guid.Empty)
                .Concat(guardedKinds.Where(p => p.Value == "Extra").Select(p => extras[p.Key].OwnerId)));

            // The advanced reveal of each unwatched guarded episode, from the numbering the library holds for it now (the
            // same per-item reveal its item answers, tag data and native poster tags get).
            var reveals = EpisodeReveals(policy, user, guardedKinds.Where(p => p.Value == "Episode").Select(p => p.Key), playedIds);

            foreach (var kvp in items.ToList())
            {
                var entry = kvp.Value;
                if (!guardedKinds.TryGetValue(kvp.Key, out var kind)) continue;
                if (kind == "Extra")
                {
                    // An extra gets its owner's verdict (the same as tag data): a movie's until the movie is watched.
                    if (ExtraGuarded(spState, extras[kvp.Key])) items[kvp.Key] = StripEntryFields(entry, kind, policy, host, extras[kvp.Key].OwnerId);
                    continue;
                }
                var episodic = kind is "Episode" or "Season";
                Guid? owner = !episodic ? null : series.TryGetValue(kvp.Key, out var current) && current.Series != Guid.Empty ? current.Series : SeriesOf(entry);

                // Episodes/movies: played skips the strip. Seasons: IndexNumber<=1
                // OR any-episode-watched skips (mirrors SpoilerBlurImageFilter and
                // SpoilerFieldStripFilter Season blur logic).
                if (Guid.TryParse(kvp.Key, out var entryGuid))
                {
                    if (kind is "Episode" or "Movie")
                    {
                        if (playedIds.Contains(entryGuid)) continue;
                    }
                    else if (kind == "Season"
                        && PrivacyReads.Item<BaseItem>(_libraryManager, entryGuid) is Season seasonItem)
                    {
                        var sNum = seasonItem.IndexNumber.GetValueOrDefault(int.MaxValue);
                        // S0/S1 posters always pass (their existence isn't a
                        // spoiler), as do seasons with any watched episode — "exempt".
                        if (sNum <= 1 || seasonWatched.GetValueOrDefault(seasonItem.Id))
                        {
                            // The season itself is the viewer's entry point, but its entry carries values of its
                            // episodes (their audio languages, the first one's streams and name): those are validated.
                            items[kvp.Key] = PrivacyValues.TagEntry(entry, new PrivacyTagStrip(false, policy.StripRatings, policy.SanitizeTitleStreams), owner, host);
                            continue;
                        }
                    }
                }
                else
                {
                    // Rate-limited warn so a future TagCacheService key-format
                    // change is observable rather than silently stripping every rail.
                    _spoilerResolver.WarnRateLimited(
                        "tagcache-key-not-guid",
                        $"Spoiler Guard tag-cache strip: TagCacheService key '{kvp.Key}' did not parse as Guid; played-state check skipped. Possible cache-key format change.");
                }

                items[kvp.Key] = StripEntryFields(entry, kind, policy, host, owner, reveals.GetValueOrDefault(kvp.Key));
            }

            return fingerprint;
        }

        /// <summary>
        /// The same strip as <see cref="StripTagCache"/> for ONE entry (native poster tags). Returns the
        /// shared entry unchanged when nothing applies, else a stripped clone, with
        /// <paramref name="stripped"/> telling which.
        /// </summary>
        public TagCacheEntry StripEntry(SpoilerTagStripPolicy policy, JUser user, BaseItem item, TagCacheEntry entry, out bool stripped)
        {
            stripped = false;
            var key = item.Id.ToString("N");
            // The series the library holds the item under now (the vocabulary and age-rating source too).
            var current = entry.Type is "Episode" or "Season" ? EntrySeries(item.Id, entry) : default;
            Guid? owner = entry.Type is not ("Episode" or "Season") ? null : current.Series != Guid.Empty ? current.Series : SeriesOf(entry);
            var kind = GetGuardedKind(policy.State, key, entry, new Dictionary<string, (Guid Series, string? Key)>(StringComparer.Ordinal) { [key] = current });
            if (kind == null && !IsTitleKind(entry.Type) && PrivacyIdentities.Of(_libraryManager, item, user, _userDataManager) is var identity && ExtraGuarded(policy.State, identity))
            {
                // An extra of a guarded title (native poster tags): its owner's verdict, as in the tag cache and tag data.
                stripped = true;
                return StripEntryFields(entry, "Extra", policy, Host(), identity.OwnerId);
            }
            if (kind == null) return entry;

            if (kind is "Episode" or "Movie")
            {
                // Same rule as the bulk IsPlayed query: played passes.
                bool played;
                try
                {
                    played = PrivacyReads.UserData(_userDataManager, user, item)?.Played == true;
                }
                catch (Exception ex)
                {
                    _spoilerResolver.WarnRateLimited(
                        "postertags-played-probe:" + ex.GetType().FullName,
                        $"Spoiler Guard tag strip (native poster tags): played-state lookup failed for {item.Id}: {ex.Message}");
                    played = false; // fail-closed: strip
                }

                if (played) return entry;
            }
            else if (kind == "Season" && PrivacyReads.Item<BaseItem>(_libraryManager, item.Id) is Season season)
            {
                var sNum = season.IndexNumber.GetValueOrDefault(int.MaxValue);
                if (sNum <= 1 || HasWatchedAnyEpisode(season, user, "postertags-season-probe:"))
                {
                    // Exempt itself, but the values it carries of its episodes are validated (as in the tag cache).
                    stripped = true;
                    return PrivacyValues.TagEntry(entry, new PrivacyTagStrip(false, policy.StripRatings, policy.SanitizeTitleStreams), owner, Host());
                }
            }

            stripped = true;
            // An unwatched episode keeps what its advanced category reveals (the same reveal as tag data and the tag cache).
            var reveal = kind == "Episode" ? CategoryReveal(policy, user, item) : default;
            return StripEntryFields(entry, kind, policy, Host(), owner, reveal);
        }

        /// <summary>
        /// POST /tag-data: which Spoiler Guard stub (if any) replaces this item's regular projection.
        /// </summary>
        public SpoilerTagDataStub GetTagDataStub(SpoilerTagStripPolicy policy, JUser user, BaseItem item)
        {
            // The item's identity (its owning title, that title's key, the viewer's watched state) and the one scope
            // rule; the kind decides which stub. Collections, folders, people and programmes are not guarded titles.
            var identity = PrivacyIdentities.Of(_libraryManager, item, user, _userDataManager);
            if (!_spoilerResolver.InSpoilerScope(policy.State, identity)) return SpoilerTagDataStub.None;
            switch (identity.Kind)
            {
                case BaseItemKind.Episode:
                    return identity.Played == true ? SpoilerTagDataStub.None : SpoilerTagDataStub.Episode;
                case BaseItemKind.Series:
                    // Covers home-rail cards bound to seriesId — e.g. NextUp / Continue Watching with "Use episode
                    // images" OFF, where cards show the series poster.
                    return SpoilerTagDataStub.Series;
                case BaseItemKind.Movie:
                    return identity.Played == true ? SpoilerTagDataStub.None : SpoilerTagDataStub.Movie;
                case BaseItemKind.Season:
                    // Mirrors the field-strip filter's Season strip + the image filter's HasWatchedAnyEpisodeInSeason gate.
                    return item is Season season && season.IndexNumber.GetValueOrDefault(int.MaxValue) > 1 && !HasWatchedAnyEpisode(season, user, "tagdata-season-probe:")
                        ? SpoilerTagDataStub.Season : SpoilerTagDataStub.None;
                default:
                    // An extra follows its owner: a movie's by the movie's watched state, a series' always.
                    return identity.IsExtra && !(identity.OwnerKind == BaseItemKind.Movie && identity.Played == true) ? SpoilerTagDataStub.Extra : SpoilerTagDataStub.None;
            }
        }

        /// <summary>
        /// What an unwatched guarded episode's advanced category reveals for this viewer (the same reveal its item answers,
        /// search hints and the activity log get): nothing unless the administrator turned advanced mode on and the viewer
        /// kept it.
        /// </summary>
        public SpoilerCategoryReveal CategoryReveal(SpoilerTagStripPolicy policy, JUser user, BaseItem episode)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerAdvancedMode != true || policy.State.Prefs?.UseAdvancedCategories == false || episode is not Episode) return default;
            // The episode as the library holds it now: its series and its numbering decide its category.
            var current = PrivacyReads.Item(_libraryManager, episode.Id) as Episode ?? (Episode)episode;
            var series = PrivacyIdentities.Of(_libraryManager, current).SeriesId;
            return Reveal(policy, user, cfg, series, current.Id, current.ParentIndexNumber, current.IndexNumber);
        }

        private SpoilerCategoryReveal Reveal(SpoilerTagStripPolicy policy, JUser user, PluginConfiguration cfg, Guid series, Guid episode, int? parentIndex, int? index)
        {
            var category = _nextUnwatched != null
                ? _nextUnwatched.CategoryOf(user.Id, policy.State, cfg, series, episode, parentIndex, index)
                : SpoilerNextUnwatchedService.Categorize(SpoilerNextUnwatchedService.ComputeNow(_libraryManager, user, series), episode, parentIndex, index);
            return SpoilerCategoryReveal.Of(category, cfg);
        }

        // TagCacheService stores ONE shared TagCacheEntry per item across ALL users: the construction table clones,
        // never mutates. An episode's or season's age rating is its series' when ratings are stripped (its own can
        // differ and Jellyfin never shows it); its vocabulary is its series', an extra's its owner's.
        // An unwatched episode's advanced category reveal applies here exactly as in its item answers and tag data: a revealed
        // rating stays (with its own age rating), a revealed title family keeps the title-bearing stream values. The
        // vocabulary and age-rating source is the item's owner as the library holds it now (an episode's or season's
        // current series), never the series a cached entry was built under.
        private static TagCacheEntry StripEntryFields(TagCacheEntry entry, string kind, SpoilerTagStripPolicy policy, PrivacyValueHost host, Guid? owner = null,
            SpoilerCategoryReveal reveal = default)
        {
            var episodic = kind is "Episode" or "Season";
            var source = episodic ? owner ?? SeriesOf(entry) : owner;
            var scores = policy.StripRatings && !reveal.Ratings;
            var titles = policy.ReplaceTitle && !reveal.Title || policy.StripOverview && !reveal.Overview;
            return PrivacyValues.TagEntry(entry, new PrivacyTagStrip(policy.StripGenres, scores, titles, scores && episodic ? source : null), source, host);
        }

        /// <summary>
        /// The advanced reveal of each unwatched guarded episode of a strip (by key), from the episodes as the library holds
        /// them now (one batched read; their facts recorded): nothing without advanced mode, or for a viewer who opted out.
        /// </summary>
        private Dictionary<string, SpoilerCategoryReveal> EpisodeReveals(SpoilerTagStripPolicy policy, JUser user, IEnumerable<string> keys, HashSet<Guid> played)
        {
            var reveals = new Dictionary<string, SpoilerCategoryReveal>(StringComparer.Ordinal);
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerAdvancedMode != true || policy.State.Prefs?.UseAdvancedCategories == false) return reveals;
            var ids = keys.Select(k => Guid.TryParse(k, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty && !played.Contains(id)).ToArray();
            foreach (var (id, item) in PrivacyReads.Items(_libraryManager, ids))
                if (item is Episode episode)
                    reveals[id.ToString("N")] = Reveal(policy, user, cfg, episode.SeriesId, episode.Id, episode.ParentIndexNumber, episode.IndexNumber);
            return reveals;
        }

        /// <summary>The series an episode's or season's entry belongs to (its vocabulary's source).</summary>
        private static Guid? SeriesOf(TagCacheEntry entry) => Guid.TryParse(entry.SeriesId, out var series) && series != Guid.Empty ? series : null;

        // Fail-CLOSED: a failed probe counts as "nothing watched", so the
        // season stays stripped.
        private bool HasWatchedAnyEpisode(Season season, JUser user, string warnKeyPrefix)
        {
            // The season's watched evidence (the host's listing of it and the viewer's watched state of each episode), one
            // fact; a failed read is "nothing watched" and records nothing (the season stays stripped).
            if (PrivacyReads.SeasonWatchedOrUnknown(_libraryManager, _userDataManager, user, season) is { } watched) return watched;
            var label = warnKeyPrefix.StartsWith("tagdata", StringComparison.Ordinal)
                ? "Spoiler Guard tag-data"
                : "Spoiler Guard tag strip (native poster tags)";
            _spoilerResolver.WarnRateLimited(warnKeyPrefix + "unreadable", $"{label}: season any-watched probe failed for {season.Id}");
            return false;
        }

        /// <summary>
        /// Which of <paramref name="candidateIds"/> <paramref name="user"/> has
        /// played, from one id-only query (tag-cache Spoiler Guard strip).
        /// Fail-closed: on error nothing counts as played, so every guarded
        /// entry is stripped.
        /// </summary>
        private HashSet<Guid> LoadPlayedIdsForTagStrip(JUser user, List<Guid> candidateIds)
        {
            if (candidateIds.Count == 0) return new HashSet<Guid>();
            if (PrivacyReads.PlayedOf(_libraryManager, _userDataManager, user, candidateIds) is { } played) return played;
            _spoilerResolver.WarnRateLimited(
                "tagcache-played-probe:unreadable",
                $"Spoiler Guard tag-cache strip: played-state query failed for {user.Id}");
            return new HashSet<Guid>();
        }

        /// <summary>
        /// Whether the viewer has played any episode the host lists in each guarded later season, by one batched played query
        /// over their episodes; each season's answer is a fact compared with the same queries at every check. Season.GetEpisodes
        /// is a query per season: a full load can carry hundreds of guarded later seasons, so above 16 the shows the viewer
        /// has played nothing of (by series id and by presentation key, which GetEpisodes matches on) are skipped: they can't
        /// contain a watched episode. Probed or skipped, a season's value is the same; the check uses the same rule. A
        /// season that cannot be read is fail-CLOSED (not watched, stripped) and records nothing.
        /// </summary>
        private Dictionary<Guid, bool> LaterSeasonsWatched(JUser user, List<Season> seasons)
        {
            var answer = new Dictionary<Guid, bool>();
            if (seasons.Count == 0) return answer;
            PrivacyReads.HostSpecials();
            var prefilter = seasons.Count > 16;
            var playedSeries = prefilter ? LoadPlayedSeriesForTagStrip(user) : null;
            var episodes = new Dictionary<Guid, List<Guid>>();
            foreach (var season in seasons)
                if (SeasonEpisodeIds(user, season, playedSeries) is { } ids) episodes[season.Id] = ids;
            HashSet<Guid> played;
            try { played = PlayedNow(user, episodes.Values.SelectMany(e => e)); }
            catch (Exception ex)
            {
                _spoilerResolver.WarnRateLimited("tagcache-season-probe:" + ex.GetType().FullName, $"Spoiler Guard tag-cache strip: season played query failed for {user.Id}: {ex.Message}");
                return answer;
            }
            var library = _libraryManager;
            foreach (var (season, ids) in episodes)
            {
                var watched = ids.Exists(played.Contains);
                answer[season] = watched;
                PrivacyReads.Query("season-played:" + user.Id.ToString("N") + ":" + season.ToString("N"), watched ? "1" : "0", check =>
                {
                    if (PrivacyHostView.Item(library, season) is not Season live) return "0";
                    var series = prefilter ? check.Memo("played-series:" + user.Id.ToString("N"), () => LoadPlayedSeriesForTagStrip(user)) : null;
                    if (SeasonEpisodeIds(user, live, series) is not { } now) return null;
                    return PlayedNow(user, now).Count > 0 ? "1" : "0";
                });
            }
            return answer;
        }

        /// <summary>The episodes the host lists in a later season (empty for a show the played-series prefilter skips; null: unreadable).</summary>
        private List<Guid>? SeasonEpisodeIds(JUser user, Season season, (HashSet<Guid> Ids, HashSet<string> Keys)? playedSeries)
        {
            if (playedSeries is { } touched
                && !touched.Ids.Contains(season.SeriesId)
                && (string.IsNullOrEmpty(season.SeriesPresentationUniqueKey) || !touched.Keys.Contains(season.SeriesPresentationUniqueKey))
                && (season.Series?.PresentationUniqueKey is not { Length: > 0 } currentKey || !touched.Keys.Contains(currentKey)))
                return new List<Guid>();
            try
            {
                return PrivacyReads.SeasonEpisodes(season, user).Where(ep => ep != null).Select(ep => ep.Id).ToList();
            }
            catch (Exception ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagcache-season-probe:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-cache strip: season any-watched probe failed for {season.Id}: {ex.Message}");
                return null;
            }
        }

        /// <summary>Which of <paramref name="ids"/> the viewer has played, by the host's played query (unrecorded: callers record what they consume).</summary>
        private HashSet<Guid> PlayedNow(JUser user, IEnumerable<Guid> ids)
        {
            var played = new HashSet<Guid>();
            foreach (var batch in ids.Distinct().Chunk(PrivacyHostView.Batch))
                foreach (var id in _libraryManager.GetItemIds(new InternalItemsQuery(user) { ItemIds = batch, IsPlayed = true, GroupByPresentationUniqueKey = false }) ?? [])
                    played.Add(id);
            return played;
        }

        /// <summary>
        /// Series ids and series presentation keys of every show
        /// <paramref name="user"/> has played at least one episode of
        /// (tag-cache Spoiler Guard strip: gates the per-season watched probe).
        /// On error returns null, so every season is probed as before.
        /// </summary>
        private (HashSet<Guid> Ids, HashSet<string> Keys)? LoadPlayedSeriesForTagStrip(JUser user)
        {
            try
            {
                var ids = new HashSet<Guid>();
                var keys = new HashSet<string>(StringComparer.Ordinal);
                var watched = new HashSet<Guid>();
                foreach (var item in _libraryManager.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    IsPlayed = true,
                    Recursive = true,
                    GroupByPresentationUniqueKey = false,
                    DtoOptions = new MediaBrowser.Controller.Dto.DtoOptions(false),
                }))
                {
                    if (item is not Episode ep) continue;
                    watched.Add(ep.Id);
                    if (ep.SeriesId != Guid.Empty) ids.Add(ep.SeriesId);
                    if (!string.IsNullOrEmpty(ep.SeriesPresentationUniqueKey)) keys.Add(ep.SeriesPresentationUniqueKey);
                }
                return (ids, keys);
            }
            catch (Exception ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagcache-played-series-probe:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-cache strip: played-series query failed for {user.Id}: {ex.Message}");
                return null;
            }
        }
    }
}
