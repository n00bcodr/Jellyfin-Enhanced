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

        /// <summary>Creates the service over the library, the shared TMDB cache and the parental filter.</summary>
        public CollectionGapsService(IArrJellyfinView view, ILibraryManager libraryManager, RequestLedger ledger, TitleAliases aliases, TmdbResponseCache tmdb, SeerrParentalFilter parental, IRequestPolicy policy)
            : this(
                view,
                (viewer, id) => ResolveBoxSet(libraryManager, viewer, id),
                ledger,
                aliases,
                (id, language, ct) => TmdbCollectionAsync(tmdb, id, language, ct),
                (tmdbId, user, ct) => parental.MaySeeAbsentAsync("movie", tmdbId, user.ToString("N", CultureInfo.InvariantCulture), ct),
                () => DateTimeOffset.UtcNow,
                () => policy.Configuration.ArrRequestDeclineCooldownDays,
                user => RequestLedger.TargetKey(policy.Evaluate(user, new MutationInput { Key = "movie:tmdb:1" })))
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
            Func<Guid, string?>? currentTarget = null)
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
        }

        /// <summary>
        /// The gaps of one collection item. Refusal "not_found" when the item isn't a collection the
        /// viewer can open, "collection_unknown" when it has no TMDB collection id or TMDB can't be read
        /// (no server key, failure); otherwise the gaps.
        /// </summary>
        public async Task<(CollectionGaps? Gaps, string? Refusal)> ForCollectionAsync(StatusViewer viewer, Guid itemId, string? language, CancellationToken ct)
        {
            if (_boxSet(viewer, itemId) is not { } set) return (null, "not_found");
            if (set.TmdbCollectionId is not int collectionId || collectionId <= 0) return (null, "collection_unknown");
            var json = await _tmdbCollection(collectionId, language != null && Language.IsMatch(language) ? language : null, ct).ConfigureAwait(false);
            var parts = ParseCollection(json, DateOnly.FromDateTime(_now().UtcDateTime));
            if (parts == null) return (null, "collection_unknown");

            var have = 0;
            var missing = new List<CollectionPart>();
            foreach (var part in parts)
            {
                var key = TitleKey.Parse(part.Key)!;
                var aliases = _aliases?.Of(key);
                var copies = _view.Copies(key, viewer, aliases);
                if (copies.Any(c => c.Visible)) have++;
                // A copy the viewer can't open (another library, its rating or tags): Jellyfin's answer
                // is final, so the movie isn't theirs to see here.
                else if (copies.Count == 0) missing.Add(part);
            }

            // Absent movies: only what the viewer's parental limits allow (the filter refuses unknowns).
            var allowed = await Task.WhenAll(missing.Select(p => MaySeeAsync(p, viewer.UserId, ct))).ConfigureAwait(false);
            var visible = missing.Where((_, i) => allowed[i]).ToList();

            var wants = _ledger?.Database.Available == true;
            var target = wants ? _currentTarget?.Invoke(viewer.UserId) : null;
            var listed = visible.Select(p => wants ? p with { Request = RequestState(p.Key, viewer.UserId, target) } : p).ToList();
            return (new CollectionGaps { Have = have, Total = have + listed.Count, Missing = listed }, null);
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
