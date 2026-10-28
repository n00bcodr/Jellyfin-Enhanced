using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>One movie of a collection the viewer doesn't have yet.</summary>
    public sealed record CollectionPart
    {
        /// <summary>Movie title key (movie:tmdb:{id}), what a request names.</summary>
        [JsonPropertyName("key")] public string Key { get; init; } = string.Empty;

        /// <summary>Movie title.</summary>
        [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;

        /// <summary>Release year, when known.</summary>
        [JsonPropertyName("year")] public int? Year { get; init; }

        /// <summary>TMDB poster path ("/abc.jpg"), validated; the client builds the image URL.</summary>
        [JsonPropertyName("poster")] public string? Poster { get; init; }

        /// <summary>Out already (a release date on or before today): only released parts can be asked for.</summary>
        [JsonPropertyName("released")] public bool Released { get; init; }

        /// <summary>
        /// The viewer's request state of the movie: waiting (their ask waits for an OK), asked (their ask
        /// is on its way), declined (their ask was declined), household (someone else asked), or null.
        /// </summary>
        [JsonPropertyName("request")] public string? Request { get; init; }

        /// <summary>
        /// Why the viewer can't ask for this movie right now (left out when they can): <c>low_disk</c>, the drive it
        /// would land on (its own folder when Radarr has it, else the default root) is nearly full; instance, folder
        /// and sizes for administrators only. Only released movies nobody has asked for are checked.
        /// </summary>
        [JsonPropertyName("blocked"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public RequestBlock? Blocked { get; init; }

        /// <summary>
        /// False when the viewer can't ask for this movie at all (the same answer as the title check's
        /// <c>canRequest: false</c> with nothing to explain, e.g. it would land in a library they can't open): it is
        /// left out of "Get the N missing". Left out when they can.
        /// </summary>
        [JsonPropertyName("askable"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Askable { get; init; }
    }

    /// <summary>What the viewer has of a collection and what is missing.</summary>
    public sealed record CollectionGaps
    {
        /// <summary>Movies of the collection in a library the viewer can open.</summary>
        [JsonPropertyName("have")] public int Have { get; init; }

        /// <summary>Movies of the collection the viewer may know about (have + missing).</summary>
        [JsonPropertyName("total")] public int Total { get; init; }

        /// <summary>Missing movies in release order (unreleased ones last).</summary>
        [JsonPropertyName("missing")] public IReadOnlyList<CollectionPart> Missing { get; init; } = Array.Empty<CollectionPart>();

        /// <summary>
        /// Missing movies left out of <see cref="Missing"/> because the collection's list already holds them as entries
        /// the viewer can see (counted in <see cref="Total"/>). Only with the phase 4 collection-gaps switch on; left out
        /// otherwise.
        /// </summary>
        [JsonPropertyName("covered"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Covered { get; init; }

        /// <summary>
        /// True when the storage check of some missing movie couldn't be made yet (the arr's disk facts or list of titles
        /// weren't read within the wait, e.g. right after a restart): those movies aren't marked paused, but that isn't
        /// known; read again shortly before offering them. Left out when every movie was checked.
        /// </summary>
        [JsonPropertyName("pausesPending"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? PausesPending { get; init; }
    }

    /// <summary>A collection (BoxSet) item the viewer can open, with its TMDB collection id.</summary>
    /// <param name="ItemId">BoxSet item id.</param>
    /// <param name="TmdbCollectionId">TMDB collection id from the item's provider ids, if any.</param>
    public sealed record BoxSetRef(Guid ItemId, int? TmdbCollectionId);

    /// <summary>
    /// "You have 4 of 6. Get the 2 missing" on collection pages: the movies of a Jellyfin collection's
    /// TMDB collection (read through the shared <see cref="TmdbResponseCache"/> with the server key),
    /// split into the ones the viewer has (a copy in a library they can open) and the ones missing.
    /// Movies Jellyfin has but hides from the viewer are left out entirely; for viewers with parental
    /// limits a missing movie is listed only when its verified rating allows it (unknown ratings and
    /// failed lookups leave it out). Nothing about instances, paths or other people is returned.
    /// </summary>
    public sealed class CollectionGapsService
    {
        /// <summary>Most collection parts read (larger TMDB collections are cut).</summary>
        public const int MaxParts = 60;

        private static readonly Regex PosterPath = new("^/[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);
        private static readonly Regex Language = new("^[a-z]{2}(-[A-Z]{2})?$", RegexOptions.CultureInvariant);
        private readonly IArrJellyfinView _view;
        private readonly Func<StatusViewer, Guid, BoxSetRef?> _boxSet;
        private readonly RequestLedger? _ledger;
        private readonly TitleAliases? _aliases;
        private readonly Func<int, string?, CancellationToken, Task<string?>> _tmdbCollection;
        private readonly Func<int, Guid, CancellationToken, Task<bool>> _maySee;
        private readonly Func<DateTimeOffset> _now;
        private readonly Func<int> _declineCooldownDays;
        private readonly Func<Guid, string?>? _currentTarget;
        private readonly Func<Guid, IReadOnlyList<string>, CancellationToken, Task<IReadOnlyDictionary<string, RequestBlock>>>? _pauses;
        private readonly Func<IReadOnlyList<string>, bool>? _pausesUnknown;
        private readonly Func<Guid, IReadOnlyList<string>, IReadOnlyDictionary<string, RequestBlock?>>? _refusals;
        private readonly ICollectionCoverage? _coverage;
        private readonly Func<bool> _phase4;
        private readonly Func<bool> _enabled;
        private readonly Func<string> _policyRevision;

        /// <summary>Creates the service over the library, the shared TMDB cache and the parental filter.</summary>
        /// <param name="view">Jellyfin facts.</param>
        /// <param name="libraryManager">Library (the collection item).</param>
        /// <param name="ledger">Request ledger (the viewer's request states).</param>
        /// <param name="aliases">Title aliases.</param>
        /// <param name="tmdb">Shared TMDB cache (the collection's parts).</param>
        /// <param name="parental">Parental filter for movies not in the library.</param>
        /// <param name="policy">Request policy (storage verdicts).</param>
        /// <param name="requests">Request service (storage pauses).</param>
        /// <param name="coverage">Titles the collection's list holds as entries (phase 4; null: none).</param>
        public CollectionGapsService(IArrJellyfinView view, ILibraryManager libraryManager, RequestLedger ledger, TitleAliases aliases, TmdbResponseCache tmdb, SeerrParentalFilter parental, IRequestPolicy policy, RequestService requests, ICollectionCoverage? coverage = null)
            : this(
                view,
                (viewer, id) => ResolveBoxSet(libraryManager, viewer, id),
                ledger,
                aliases,
                (id, language, ct) => TmdbCollectionAsync(tmdb, id, language, ct),
                (tmdbId, user, ct) => parental.MaySeeAbsentAsync("movie", tmdbId, user.ToString("N", CultureInfo.InvariantCulture), ct),
                () => DateTimeOffset.UtcNow,
                () => policy.Configuration.ArrRequestDeclineCooldownDays,
                user => RequestLedger.TargetKey(policy.Evaluate(user, new MutationInput { Key = "movie:tmdb:1" })),
                (user, keys, ct) => requests.StoragePausesAsync(user, keys, true, ct),
                keys => StorageUnknown(policy, keys),
                coverage,
                () => HomeFlags.CollectionGaps(policy.Configuration),
                (user, keys) => Refusals(policy, user, keys),
                () => requests.Enabled,
                () => MutationInput.Hash(JsonSerializer.Serialize(policy.Configuration)) + "|" + parental.EvidenceRevision)
        {
        }

        /// <summary>Creates the service with explicit readers (tests).</summary>
        internal CollectionGapsService(
            IArrJellyfinView view,
            Func<StatusViewer, Guid, BoxSetRef?> boxSet,
            RequestLedger? ledger,
            TitleAliases? aliases,
            Func<int, string?, CancellationToken, Task<string?>> tmdbCollection,
            Func<int, Guid, CancellationToken, Task<bool>> maySee,
            Func<DateTimeOffset> now,
            Func<int>? declineCooldownDays = null,
            Func<Guid, string?>? currentTarget = null,
            Func<Guid, IReadOnlyList<string>, CancellationToken, Task<IReadOnlyDictionary<string, RequestBlock>>>? pauses = null,
            Func<IReadOnlyList<string>, bool>? pausesUnknown = null,
            ICollectionCoverage? coverage = null,
            Func<bool>? phase4 = null,
            Func<Guid, IReadOnlyList<string>, IReadOnlyDictionary<string, RequestBlock?>>? refusals = null,
            Func<bool>? enabled = null,
            Func<string>? policyRevision = null)
        {
            _view = view;
            _boxSet = boxSet;
            _ledger = ledger;
            _aliases = aliases;
            _tmdbCollection = tmdbCollection;
            _maySee = maySee;
            _now = now;
            _declineCooldownDays = declineCooldownDays ?? (() => 7);
            _currentTarget = currentTarget;
            _pauses = pauses;
            _pausesUnknown = pausesUnknown;
            _coverage = coverage;
            _phase4 = phase4 ?? (() => false);
            _refusals = refusals;
            _enabled = enabled ?? (() => true);
            _policyRevision = policyRevision ?? (() => string.Empty);
        }

        /// <summary>
        /// The gaps of one collection item. Refusal "not_found" when the item isn't a collection the
        /// viewer can open, "collection_unknown" when it has no TMDB collection id or TMDB can't be read
        /// (no server key, failure); otherwise the gaps.
        /// </summary>
        public async Task<(CollectionGaps? Gaps, string? Refusal)> ForCollectionAsync(StatusViewer viewer, Guid itemId, string? language, CancellationToken ct)
        {
            return await ProjectAsync(viewer, itemId, language, gaps => gaps, ct).ConfigureAwait(false);
        }

        /// <summary>Prepares the facts and projects/serialises the answer inside the common final response gate.</summary>
        /// <typeparam name="T">Answer body.</typeparam>
        /// <param name="viewer">Viewer.</param>
        /// <param name="itemId">Collection.</param>
        /// <param name="language">Metadata language.</param>
        /// <param name="project">Synchronous projection (including serialisation).</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Body or refusal.</returns>
        internal async Task<(T? Gaps, string? Refusal)> ProjectAsync<T>(StatusViewer viewer, Guid itemId, string? language, Func<CollectionGaps, T> project, CancellationToken ct) where T : class
        {
            var gate = new AcquireResponseGate(_view, viewer.UserId, _ => _phase4() + "|" + _enabled() + "|" + _policyRevision());
            for (var attempt = 0; attempt < AcquireResponseGate.Attempts; attempt++)
            {
                if (gate.Read() is not { } policy) return (null, "not_found");
                if (!_enabled()) return (null, "feature_disabled");
                try { return await PrepareAsync(policy.Viewer, itemId, language, gate, policy, project, ct).ConfigureAwait(false); }
                catch (AcquireResponseGate.Changed) { ct.ThrowIfCancellationRequested(); }
            }
            if (gate.Read() is not { } finalPolicy) return (null, "not_found");
            return gate.Publish(finalPolicy, current => ((T?)null, _boxSet(current, itemId) == null ? "not_found" : "authorization_changed"));
        }

        private async Task<(T? Gaps, string? Refusal)> PrepareAsync<T>(StatusViewer viewer, Guid itemId, string? language, AcquireResponseGate gate, AcquireResponseGate.Policy policy, Func<CollectionGaps, T> project, CancellationToken ct) where T : class
        {
            if (_boxSet(viewer, itemId) is not { } set) return (null, "not_found");
            if (set.TmdbCollectionId is not int collectionId || collectionId <= 0) return (null, "collection_unknown");
            using var metadataViewer = NativeDetails.ViewerMetadataAdmission.ForViewer(viewer.UserId);
            var json = await _tmdbCollection(collectionId, language != null && Language.IsMatch(language) ? language : null, ct).ConfigureAwait(false);
            if (metadataViewer.Refused) return (null, "metadata_unavailable");
            var parts = ParseCollection(json, DateOnly.FromDateTime(_now().UtcDateTime));
            if (parts == null) return gate.Publish(policy, current =>
                ((T?)null, _boxSet(current, itemId) is { } finalSet && finalSet.TmdbCollectionId == collectionId
                    ? "collection_unknown" : "not_found"));
            var covering = _coverage != null && _phase4() ? CoveredAsync(set.ItemId, viewer, ct) : null;
            // "Have" is the one availability predicate (D53, edition round 19 part B): a copy they open that plays (any
            // edition); never a ".disc" stub or a pathless item, which are missing like a movie Jellyfin doesn't have.
            var editions = new EditionAvailability(_view, () => null, (k, v) => _view.Copies(k, v, _aliases?.Of(k)).Display);
            // A copy they open that plays nothing is theirs to see: missing. A copy the viewer can't open (another library, its
            // rating or tags): Jellyfin's answer is final, so the movie isn't theirs to see here. Otherwise only a movie proven
            // absent is missing (a lookup that couldn't finish may have a copy they can't open among the rows it didn't read).
            bool Plays(CopyLookup copies, StatusViewer who) => editions.Movie(who, copies.Seen, Edition.Any).Count > 0;
            static bool Missing(CopyLookup copies) => copies.SeenOpenable != null || copies.IsProvenAbsent;
            // Prepare every absent part, including covered titles: a later revoke can make them gaps again.
            var absent = parts.Where(p =>
            {
                var key = TitleKey.Parse(p.Key)!;
                var copies = _view.Copies(key, viewer, _aliases?.Of(key));
                return !Plays(copies, viewer) && Missing(copies);
            }).ToList();
            var allowed = await Task.WhenAll(absent.Select(p => MaySeeAsync(p, viewer.UserId, ct))).ConfigureAwait(false);
            if (metadataViewer.Refused) return (null, "metadata_unavailable");
            var permitted = absent.Where((_, i) => allowed[i]).Select(p => p.Key).ToHashSet(StringComparer.Ordinal);
            var coverage = covering != null ? await covering.ConfigureAwait(false) : null;
            var wants = _ledger?.Database.Available == true;
            var target = wants ? _currentTarget?.Invoke(viewer.UserId) : null;
            var askable = absent.Where(p => permitted.Contains(p.Key) && p.Released && (!wants || RequestState(p.Key, viewer.UserId, target) == null)).Select(p => p.Key).ToList();
            var paused = _pauses != null && askable.Count > 0 ? await _pauses(viewer.UserId, askable, ct).ConfigureAwait(false) : new Dictionary<string, RequestBlock>();
            return gate.Publish(policy, current =>
            {
                // Everything below, including the caller's serialiser, runs without another await.
                if (_boxSet(current, itemId) is not { } finalSet || finalSet.TmdbCollectionId != collectionId) return ((T?)null, "not_found");
                var keys = _phase4() && coverage != null ? coverage() : new HashSet<string>(StringComparer.Ordinal);
                var have = 0;
                int? covered = _phase4() && coverage != null ? 0 : null;
                var listed = new List<CollectionPart>();
                var currentTarget = wants ? _currentTarget?.Invoke(current.UserId) : null;
                foreach (var part in parts)
                {
                    var key = TitleKey.Parse(part.Key)!;
                    var copies = _view.Copies(key, current, _aliases?.Of(key));
                    if (Plays(copies, current)) { have++; continue; }
                    if (!Missing(copies) || !permitted.Contains(part.Key)) continue;
                    if (IsCovered(part.Key, keys)) { covered++; continue; }
                    var row = wants ? part with { Request = RequestState(part.Key, current.UserId, currentTarget) } : part;
                    if (paused.TryGetValue(part.Key, out var block)) row = row with { Blocked = block };
                    listed.Add(row);
                }
                var open = listed.Where(p => p.Released && p.Request == null && p.Blocked == null).Select(p => p.Key).ToList();
                var refused = _refusals?.Invoke(current.UserId, open);
                if (refused is { Count: > 0 })
                {
                    listed = listed.Select(p => refused.TryGetValue(p.Key, out var block) ? block != null ? p with { Blocked = block } : p with { Askable = false } : p).ToList();
                    open = open.Where(k => !refused.ContainsKey(k)).ToList();
                }
                bool? pending = open.Count > 0 && _pausesUnknown?.Invoke(open) == true ? true : null;
                return (project(new CollectionGaps { Have = have, Total = have + (covered ?? 0) + listed.Count, Missing = listed, Covered = covered, PausesPending = pending }), (string?)null);
            });
        }

        /// <summary>
        /// Whether the storage verdict of any of <paramref name="keys"/> (movies, standard edition) is still unknown: the
        /// target instance's disk facts or list of titles aren't in memory (their reads are started), so the low-disk
        /// guard has no verdict for it yet. False when nothing needs knowing (guard off, Seerr handling, no usable instance).
        /// </summary>
        /// <param name="policy">Request policy.</param>
        /// <param name="keys">Movie title keys.</param>
        /// <returns>Whether a verdict is missing.</returns>
        internal static bool StorageUnknown(IRequestPolicy policy, IReadOnlyList<string> keys)
            => keys.Any(k => TitleKey.Parse(k) is { IsMovie: true } key && !policy.DiskKnown(StorageInput(key)));

        /// <summary>
        /// The movies of <paramref name="keys"/> (standard edition) the person can't ask for now for a reason other than
        /// storage (that is the pause answer's): the shown block (<see cref="RequestBlock.Of"/>) or null when the request
        /// controls don't explain it (e.g. it would land in a library they can't open). A change under way
        /// (<c>authorization_changed</c>) decides nothing; the next read answers.
        /// </summary>
        /// <param name="policy">Request policy.</param>
        /// <param name="user">The person.</param>
        /// <param name="keys">Movie title keys.</param>
        /// <returns>The refused keys.</returns>
        internal static IReadOnlyDictionary<string, RequestBlock?> Refusals(IRequestPolicy policy, Guid user, IReadOnlyList<string> keys)
        {
            var refused = new Dictionary<string, RequestBlock?>(StringComparer.Ordinal);
            foreach (var k in keys)
            {
                if (TitleKey.Parse(k) is not { IsMovie: true } key) continue;
                var facts = policy.Evaluate(user, StorageInput(key));
                if (facts.Refusal is null or "low_disk" or "authorization_changed") continue;
                refused[k] = RequestBlock.Of(facts);
            }
            return refused;
        }

        private static MutationInput StorageInput(TitleKey key) => new() { Key = key.Title.ToString(), Scope = "movie", Variant = "standard" };

        private async Task<Func<IReadOnlySet<string>>> CoveredAsync(Guid collectionId, StatusViewer viewer, CancellationToken ct)
        {
            try
            {
                return await _coverage!.PrepareAsync(collectionId, viewer, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                // Coverage is an addition: when it can't be read, every missing title is offered, as before.
                return () => new HashSet<string>(StringComparer.Ordinal);
            }
        }

        /// <summary>Whether a collection part is one of the covered titles (under any id the title is known by).</summary>
        private bool IsCovered(string key, IReadOnlySet<string> covered)
        {
            if (covered.Contains(key)) return true;
            var parsed = TitleKey.Parse(key);
            return parsed != null && _aliases != null && _aliases.Of(parsed).Any(alias => covered.Contains(alias.ToString()));
        }

        private async Task<bool> MaySeeAsync(CollectionPart part, Guid user, CancellationToken ct)
        {
            var id = TitleKey.Parse(part.Key)?.NumericId;
            if (id is not int tmdbId) return false;
            try
            {
                return await _maySee(tmdbId, user, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// The viewer's request state of a movie (standard edition), from the ledger: asks on
        /// <paramref name="target"/> (where an ask goes now) win over asks left on another target.
        /// </summary>
        private string? RequestState(string key, Guid viewer, string? target)
        {
            var parsed = TitleKey.Parse(key)!;
            var canonical = (_aliases?.Canonical(parsed) ?? parsed).ToString();
            string? state = null;
            string? elsewhere = null;
            foreach (var want in _ledger!.ForTitle(canonical))
            {
                if (want.Input.Scope != "movie" || want.Input.Variant != "standard") continue;
                var next = SeasonRowsService.StateOf(want, viewer, _now(), _declineCooldownDays());
                if (next == null) continue;
                if (target == null || want.TargetKey == target) state = SeasonRowsService.Stronger(state, next);
                else elsewhere = SeasonRowsService.Stronger(elsewhere, next);
            }
            return state ?? elsewhere;
        }

        /// <summary>
        /// Parses TMDB's collection details into parts (adult and invalid parts left out, at most
        /// <see cref="MaxParts"/>), released ones first by date; null when the body isn't a collection.
        /// </summary>
        internal static List<CollectionPart>? ParseCollection(string? json, DateOnly today)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(json);
            }
            catch (JsonException)
            {
                return null;
            }
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("parts", out var list) || list.ValueKind != JsonValueKind.Array) return null;
                var parts = new List<(CollectionPart Part, DateOnly? Date)>();
                var seen = new HashSet<int>();
                foreach (var p in list.EnumerateArray())
                {
                    if (parts.Count >= MaxParts) break;
                    if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.Number || !idElement.TryGetInt32(out var id) || id <= 0) continue;
                    if (p.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True) continue;
                    if (p.TryGetProperty("media_type", out var type) && type.ValueKind == JsonValueKind.String && type.GetString() != "movie") continue;
                    if (!seen.Add(id)) continue;
                    var title = Text(p, "title") ?? Text(p, "original_title");
                    if (title == null) continue;
                    if (title.Length > 200) title = title[..200];
                    DateOnly? date = DateOnly.TryParseExact(Text(p, "release_date") ?? string.Empty, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
                    var poster = Text(p, "poster_path");
                    parts.Add((new CollectionPart
                    {
                        Key = "movie:tmdb:" + id.ToString(CultureInfo.InvariantCulture),
                        Title = title,
                        Year = date?.Year,
                        Poster = poster != null && PosterPath.IsMatch(poster) ? poster : null,
                        Released = date.HasValue && date.Value <= today,
                    }, date));
                }
                return parts
                    .OrderBy(x => x.Part.Released ? 0 : 1)
                    .ThenBy(x => x.Date ?? DateOnly.MaxValue)
                    .Select(x => x.Part)
                    .ToList();
            }
        }

        private static string? Text(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) ? v.GetString()!.Trim() : null;

        /// <summary>The collection item if the viewer can open it (Jellyfin's own access check).</summary>
        private static BoxSetRef? ResolveBoxSet(ILibraryManager libraryManager, StatusViewer viewer, Guid itemId)
        {
            if (viewer.Handle is not User user) return null;
            if (libraryManager.GetItemById<BaseItem>(itemId, user) is not BoxSet set) return null;
            // A collection Jellyfin made from TMDB carries the collection id as TmdbCollection (or as
            // Tmdb, set by the TMDb collection provider); a hand-made one names it through its movies.
            var tmdb = Positive(set.GetProviderId(MetadataProvider.TmdbCollection)) ?? Positive(set.GetProviderId(MetadataProvider.Tmdb));
            tmdb ??= set.GetLinkedChildren().OfType<Movie>()
                .Select(m => Positive(m.GetProviderId(MetadataProvider.TmdbCollection)))
                .Where(id => id.HasValue)
                .GroupBy(id => id!.Value)
                .OrderByDescending(g => g.Count())
                .Select(g => (int?)g.Key)
                .FirstOrDefault();
            return new BoxSetRef(set.Id, tmdb);
        }

        private static int? Positive(string? raw)
            => int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : null;

        /// <summary>TMDB collection details through the shared cache (null when TMDB isn't set up or fails).</summary>
        private static async Task<string?> TmdbCollectionAsync(TmdbResponseCache tmdb, int collectionId, string? language, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration.GetTmdbApiKey();
            if (string.IsNullOrEmpty(key)) return null;
            try
            {
                var response = await tmdb.GetAsync("collection/" + collectionId.ToString(CultureInfo.InvariantCulture), language == null ? string.Empty : "?language=" + language, key, ct).ConfigureAwait(false);
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
    }
}
