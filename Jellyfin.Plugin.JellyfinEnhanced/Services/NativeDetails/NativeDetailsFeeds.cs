#if JF12
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>What a feed request came to.</summary>
    public enum FeedOutcome
    {
        /// <summary>The feed, filtered for the viewer.</summary>
        Ok,

        /// <summary>Not for this viewer (answered like a hidden item: 404).</summary>
        Refused,

        /// <summary>The source says there is no such person or feed (404).</summary>
        NotFound,

        /// <summary>The source can't answer now (503, retryable).</summary>
        Unavailable,

        /// <summary>The viewer's parental checks for these titles are still running (504, retry shortly).</summary>
        Pending,

        /// <summary>The request names no valid feed (400).</summary>
        Invalid,

        /// <summary>
        /// The list isn't cached and the viewer (or the server) has too many upstream reads running to
        /// start another now (429, retry shortly).
        /// </summary>
        Busy,
    }

    /// <summary>One feed answer: the outcome and, when <see cref="FeedOutcome.Ok"/>, the JSON body.</summary>
    /// <param name="Outcome">The outcome.</param>
    /// <param name="Json">The body (Seerr's result shape, projected), or null.</param>
    public readonly record struct FeedAnswer(FeedOutcome Outcome, string? Json);

    /// <summary>
    /// The title lists of the pages a not-in-library title links to (native details, Jellyfin 12 web): a
    /// person's filmography and the discovery feeds of a genre, studio or network. Read with Jellyfin
    /// Enhanced's own Seerr key (no Seerr account needed, so Jellyfin Enhanced request mode works for
    /// every viewer) and filtered here for the effective viewer before anything reaches the browser:
    /// the viewer's parental limit, then each title by the library first: a library copy the viewer can
    /// open is shown as that copy (its Jellyfin id, checked by Jellyfin for this viewer); a title the
    /// library holds but hides from the viewer is left out entirely; a title the library doesn't have
    /// is listed only when its own native page would open for the viewer (library or request
    /// visibility). Only whitelisted public fields are passed on (no requests, requesters, download or
    /// watchlist data).
    /// </summary>
    public sealed class NativeDetailsFeeds
    {
        /// <summary>The most titles a filmography lists (the best known first).</summary>
        internal const int MaxCredits = 400;

        private static readonly Regex SeerrSort = new("^[a-z_]{1,32}\\.(asc|desc)$", RegexOptions.CultureInvariant);
        private static readonly Regex Appearance = new("^(self|himself|herself|themselves)\\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
        // TMDB's talk show, news and reality genres: appearances rather than roles.
        private static readonly HashSet<int> AppearanceGenres = new() { 10767, 10763, 10764 };
        private static readonly string[] Strings = { "title", "name", "originalTitle", "originalName", "overview", "releaseDate", "firstAirDate", "originalLanguage", "character", "job", "department" };
        private static readonly string[] Numbers = { "voteAverage", "voteCount", "popularity" };
        // Seerr media states an absent title can be in (pending, processing, blocklisted, deleted).
        private static readonly HashSet<int> AbsentStates = new() { 2, 3, 6, 7 };

        private readonly INativeDetailsSource _source;
        private readonly NativeDetailsPolicy _policy;
        private readonly SeerrParentalFilter _parental;
        private readonly ILibraryManager _library;

        /// <summary>Creates the feeds.</summary>
        /// <param name="source">Public metadata source.</param>
        /// <param name="policy">The native details viewer policy.</param>
        /// <param name="parental">The parental filter.</param>
        /// <param name="library">Library manager (read only).</param>
        public NativeDetailsFeeds(INativeDetailsSource source, NativeDetailsPolicy policy, SeerrParentalFilter parental, ILibraryManager library)
        {
            _source = source;
            _policy = policy;
            _parental = parental;
            _library = library;
        }

        /// <summary>
        /// A person's filmography (<c>{ results }</c>, cast roles before crew credits of the same title,
        /// roles before appearances, the best known first), under the person page's own rule: the
        /// viewer-level rule, and an adult performer is refused to a viewer with a parental limit.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="tmdb">TMDB person id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> FilmographyAsync(User viewer, int tmdb, CancellationToken ct)
        {
            if (tmdb <= 0) return new FeedAnswer(FeedOutcome.Invalid, null);
            var access = await ViewerAsync(_policy.SeeLinkedPageAsync(viewer, SyntheticId.Person(tmdb), ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            // The credits first: their read is the one admitted against the viewer's budget, so a
            // viewer naming person after person can't make the person reads go upstream unbounded.
            var credits = await _source.PersonCreditsAsync(tmdb, viewer.Id, ct).ConfigureAwait(false);
            if (credits.Data is not { } data) return Failed(credits);
            var person = await _source.PersonAsync(tmdb, ct).ConfigureAwait(false);
            if (person.Data is not { } details) return Failed(person);
            if (!NativeDetailsPolicy.PersonAllowed(viewer, details)) return new FeedAnswer(FeedOutcome.Refused, null);
            var path = "/api/v1/person/" + tmdb.ToString(CultureInfo.InvariantCulture) + "/combined_credits";
            var (outcome, filtered) = await ParentalAsync(data, path, viewer, ct).ConfigureAwait(false);
            if (outcome != FeedOutcome.Ok) return new FeedAnswer(outcome, null);

            using var doc = JsonDocument.Parse(filtered!);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var rows = new List<(JsonElement Row, bool Movie, int Tmdb, int Order)>();
            foreach (var list in new[] { "cast", "crew" })
            {
                if (!doc.RootElement.TryGetProperty(list, out var entries) || entries.ValueKind != JsonValueKind.Array) continue;
                foreach (var row in entries.EnumerateArray())
                {
                    if (!TitleOf(row, null, out var movie, out var id)) continue;
                    if (seen.Add((movie ? "movie:" : "tv:") + id.ToString(CultureInfo.InvariantCulture))) rows.Add((row, movie, id, rows.Count));
                }
            }

            var results = new JsonArray();
            var ordered = rows
                .OrderBy(r => IsAppearance(r.Row) ? 1 : 0)
                .ThenByDescending(r => NativeDetailsDtos.Int(r.Row, "voteCount") ?? 0)
                .ThenBy(r => r.Order)
                .Take(MaxCredits);
            foreach (var (row, movie, id, _) in ordered)
            {
                if (Card(viewer, row, movie, id) is { } card) results.Add(card);
            }

            return new FeedAnswer(FeedOutcome.Ok, new JsonObject { ["results"] = results }.ToJsonString());
        }

        /// <summary>
        /// One page of a genre, studio or network discovery feed (<c>{ page, totalPages, results }</c>):
        /// movies by <c>genre</c> or <c>studio</c>; series by <c>genre</c>, <c>network</c> or
        /// <c>company</c> (a studio's own series, from TMDB). The viewer-level rule applies (these
        /// pages hold public data only). A page whose every title is left out is an empty page, not
        /// the end of the feed: <c>totalPages</c> is the upstream count.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movies (else series).</param>
        /// <param name="source">The feed: genre, studio, network or company.</param>
        /// <param name="id">The TMDB genre, company or network id.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="sortBy">The sort, or null for the default.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> DiscoverAsync(User viewer, bool movie, string? source, int id, int page, string? sortBy, CancellationToken ct)
        {
            var known = movie ? source is "genre" or "studio" or "keyword" : source is "genre" or "network" or "company" or "keyword";
            if (!known || id <= 0 || page is < 1 or > 500 || (!string.IsNullOrEmpty(sortBy) && !SeerrSort.IsMatch(sortBy)))
            {
                return new FeedAnswer(FeedOutcome.Invalid, null);
            }

            var access = await ViewerAsync(_policy.ViewerAccessAsync(viewer, ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            // No library of this kind the viewer can open: no title of the feed could ever be shown to them
            // (no copy they can open, no absent title whose page would open), so the feed ends here
            // instead of being paged through empty.
            if (!_policy.CanOpenLibraryFor(viewer, movie))
            {
                return new FeedAnswer(FeedOutcome.Ok, new JsonObject { ["page"] = page, ["totalPages"] = 1, ["results"] = new JsonArray() }.ToJsonString());
            }

            var company = source == "company";
            var answer = company
                ? await _source.CompanySeriesAsync(id, page, sortBy, viewer.Id, ct).ConfigureAwait(false)
                : await _source.DiscoverAsync(movie, source == "keyword" ? "keywords" : source!, id, page, sortBy, viewer.Id, ct).ConfigureAwait(false);
            if (answer.Data is not { } data) return Failed(answer);
            var number = id.ToString(CultureInfo.InvariantCulture);
            var pageText = page.ToString(CultureInfo.InvariantCulture);
            // The path the parental filter knows these lists by (the Seerr-proxied feeds' own).
            var path = company
                ? "/api/v1/discover/tv?studio=" + number + "&page=" + pageText
                : "/api/v1/discover/" + (movie ? "movies" : "tv") + "?page=" + pageText + "&" + (source == "keyword" ? "keywords" : source) + "=" + number;
            var (outcome, filtered) = await ParentalAsync(data, path, viewer, ct).ConfigureAwait(false);
            if (outcome != FeedOutcome.Ok) return new FeedAnswer(outcome, null);

            using var doc = JsonDocument.Parse(filtered!);
            var root = doc.RootElement;
            var results = new JsonArray();
            if (root.TryGetProperty("results", out var rows) && rows.ValueKind == JsonValueKind.Array)
            {
                var seen = new HashSet<int>();
                foreach (var row in rows.EnumerateArray())
                {
                    // Only titles of the feed's own kind (Seerr's discover rows are), once each.
                    if (!TitleOf(row, movie, out var isMovie, out var tmdb) || isMovie != movie || !seen.Add(tmdb)) continue;
                    if (Card(viewer, row, movie, tmdb) is { } card) results.Add(card);
                }
            }

            var total = Math.Clamp(NativeDetailsDtos.Int(root, "totalPages") ?? 1, 1, 500);
            return new FeedAnswer(FeedOutcome.Ok, new JsonObject
            {
                ["page"] = NativeDetailsDtos.Int(root, "page") ?? page,
                ["totalPages"] = total,
                ["results"] = results,
            }.ToJsonString());
        }

        /// <summary>
        /// A movie's or series' public details for its native page's extras (the information panel,
        /// trailers, collection, Spoiler Guard's switch), under that page's own rule (<see
        /// cref="NativeDetailsPolicy.SeeAsync"/>): read with Jellyfin Enhanced's Seerr key, so a viewer
        /// without a Seerr account gets them too. Seerr's per-account part (<c>mediaInfo</c>: requests,
        /// library links, downloads) is left out.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> TitleAsync(User viewer, bool movie, int tmdb, CancellationToken ct)
        {
            if (tmdb <= 0) return new FeedAnswer(FeedOutcome.Invalid, null);
            var access = await ViewerAsync(_policy.SeeAsync(viewer, movie ? SyntheticId.Movie(tmdb) : SyntheticId.Series(tmdb), ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            var answer = movie ? await _source.MovieAsync(tmdb, viewer.Id, ct).ConfigureAwait(false) : await _source.SeriesAsync(tmdb, viewer.Id, ct).ConfigureAwait(false);
            if (answer.Data is not { } data) return Failed(answer);
            if (JsonNode.Parse(data.GetRawText()) is not JsonObject body) return new FeedAnswer(FeedOutcome.Unavailable, null);
            body.Remove("mediaInfo");
            return new FeedAnswer(FeedOutcome.Ok, body.ToJsonString());
        }

        /// <summary>
        /// A title's ratings (Seerr's shape) for its native page, under <see cref="TitleAsync"/>'s rule; an
        /// upstream read comes out of the viewer's feed budget.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> RatingsAsync(User viewer, bool movie, int tmdb, CancellationToken ct)
        {
            if (tmdb <= 0) return new FeedAnswer(FeedOutcome.Invalid, null);
            var access = await ViewerAsync(_policy.SeeAsync(viewer, movie ? SyntheticId.Movie(tmdb) : SyntheticId.Series(tmdb), ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            var answer = await _source.RatingsAsync(movie, tmdb, viewer.Id, ct).ConfigureAwait(false);
            return answer.Data is { } data ? new FeedAnswer(FeedOutcome.Ok, data.GetRawText()) : Failed(answer);
        }

        /// <summary>
        /// The TMDB keywords matching a tag (<c>{ results: [{ id, name }] }</c>), so a tag's discovery
        /// row can find its keyword without a Seerr account. The viewer-level rule applies.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="query">The tag.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> KeywordsAsync(User viewer, string? query, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(query) || query.Trim().Length > 100) return new FeedAnswer(FeedOutcome.Invalid, null);
            var access = await ViewerAsync(_policy.ViewerAccessAsync(viewer, ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            var answer = await _source.KeywordsAsync(query.Trim(), viewer.Id, ct).ConfigureAwait(false);
            if (answer.Data is not { } data) return Failed(answer);
            var results = new JsonArray();
            if (data.ValueKind == JsonValueKind.Object && data.TryGetProperty("results", out var rows) && rows.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in rows.EnumerateArray())
                {
                    if (row.ValueKind == JsonValueKind.Object && NativeDetailsDtos.Int(row, "id") is int id && id > 0 && NativeDetailsDtos.Str(row, "name") is { } name)
                    {
                        results.Add(new JsonObject { ["id"] = id, ["name"] = name });
                    }
                }
            }

            return new FeedAnswer(FeedOutcome.Ok, new JsonObject { ["results"] = results }.ToJsonString());
        }

        /// <summary>
        /// TMDB's movie or series genres (<c>[{ id, name }]</c>), so a library genre's discovery row can
        /// find its TMDB genre without a Seerr account. The viewer-level rule applies.
        /// </summary>
        /// <param name="viewer">The effective viewer.</param>
        /// <param name="movie">Movie genres (else series).</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The answer.</returns>
        public async Task<FeedAnswer> GenresAsync(User viewer, bool movie, CancellationToken ct)
        {
            var access = await ViewerAsync(_policy.ViewerAccessAsync(viewer, ct)).ConfigureAwait(false);
            if (access != FeedOutcome.Ok) return new FeedAnswer(access, null);
            var answer = await _source.GenresAsync(movie, ct).ConfigureAwait(false);
            if (answer.Data is not { } data) return Failed(answer);
            var genres = new JsonArray();
            if (data.ValueKind == JsonValueKind.Array)
            {
                foreach (var row in data.EnumerateArray())
                {
                    if (row.ValueKind == JsonValueKind.Object && NativeDetailsDtos.Int(row, "id") is int id && id > 0 && NativeDetailsDtos.Str(row, "name") is { } name)
                    {
                        genres.Add(new JsonObject { ["id"] = id, ["name"] = name });
                    }
                }
            }

            return new FeedAnswer(FeedOutcome.Ok, genres.ToJsonString());
        }

        private static async Task<FeedOutcome> ViewerAsync(Task<NativeDetailsPolicy.Access> access)
            => await access.ConfigureAwait(false) switch
            {
                NativeDetailsPolicy.Access.Allowed => FeedOutcome.Ok,
                NativeDetailsPolicy.Access.Unknown => FeedOutcome.Unavailable,
                _ => FeedOutcome.Refused,
            };

        private static FeedAnswer Failed(SourceAnswer answer)
            => new(answer.Busy ? FeedOutcome.Busy : answer.NotFound ? FeedOutcome.NotFound : FeedOutcome.Unavailable, null);

        /// <summary>The viewer's parental limit over a list (unrestricted viewers: the body as it is).</summary>
        private async Task<(FeedOutcome Outcome, string? Body)> ParentalAsync(JsonElement data, string path, User viewer, CancellationToken ct)
        {
            var result = await _parental.ApplyAsync(data.GetRawText(), path, viewer.Id.ToString("N"), ct).ConfigureAwait(false);
            if (result.Block) return (FeedOutcome.Refused, null);
            // Titles still being checked are not missing titles: the client asks again shortly.
            if (result.RetryLater) return (FeedOutcome.Pending, null);
            return (FeedOutcome.Ok, result.Body);
        }

        /// <summary>The kind and TMDB id of a movie or series row (other rows, people, are not titles).</summary>
        private static bool TitleOf(JsonElement row, bool? fallbackMovie, out bool movie, out int tmdb)
        {
            movie = false;
            tmdb = row.ValueKind == JsonValueKind.Object ? NativeDetailsDtos.Int(row, "id") ?? 0 : 0;
            if (tmdb <= 0) return false;
            switch (NativeDetailsDtos.Str(row, "mediaType"))
            {
                case "movie":
                    movie = true;
                    return true;
                case "tv":
                    return true;
                case null when fallbackMovie is bool hint:
                    movie = hint;
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>1 for an appearance rather than a role (a talk show, news or reality series, or playing themselves).</summary>
        private static bool IsAppearance(JsonElement row)
        {
            if (row.TryGetProperty("genreIds", out var genres) && genres.ValueKind == JsonValueKind.Array
                && genres.EnumerateArray().Any(g => g.ValueKind == JsonValueKind.Number && g.TryGetInt32(out var id) && AppearanceGenres.Contains(id)))
            {
                return true;
            }

            return NativeDetailsDtos.Str(row, "character") is { } character && Appearance.IsMatch(character);
        }

        /// <summary>
        /// How the viewer sees one listed title: a library copy Seerr names (standard or 4K) that
        /// Jellyfin lets the viewer open, else any copy the library finds that they can open
        /// (<see cref="NativeDetailsPolicy.Listed"/>). Left out when copies exist and none of them is
        /// one they can open: a copy Seerr names that is hidden from them is never shown as absent.
        /// </summary>
        private NativeDetailsPolicy.ListedTitle Listed(User viewer, JsonElement media, bool movie, int tmdb)
        {
            var hiddenCopy = false;
            foreach (var field in new[] { "jellyfinMediaId", "jellyfinMediaId4k" })
            {
                if (NativeDetailsDtos.Str(media, field) is not { } text || !Guid.TryParse(text, out var named) || named == Guid.Empty) continue;
                if (_library.GetItemById<BaseItem>(named, viewer) != null) return NativeDetailsPolicy.ListedTitle.Copy(named);
                hiddenCopy |= _library.GetItemById(named) != null;
            }

            var library = _policy.Listed(viewer, movie, tmdb);
            return hiddenCopy && library.LibraryCopy == null ? NativeDetailsPolicy.ListedTitle.Left : library;
        }

        /// <summary>The card a listed title gets (whitelisted public fields), or null when the viewer doesn't get it.</summary>
        private JsonObject? Card(User viewer, JsonElement row, bool movie, int tmdb)
        {
            var media = NativeDetailsDtos.Obj(row, "mediaInfo");
            var listed = Listed(viewer, media, movie, tmdb);
            if (!listed.Shown) return null;
            var card = new JsonObject { ["id"] = tmdb, ["mediaType"] = movie ? "movie" : "tv" };
            foreach (var name in Strings)
            {
                if (NativeDetailsDtos.Str(row, name) is { } value) card[name] = value;
            }

            foreach (var name in new[] { "posterPath", "backdropPath" })
            {
                if (NativeDetailsDtos.Str(row, name) is { } path && NativeDetailsArtwork.IsSafeTmdbPath(path)) card[name] = path;
            }

            foreach (var name in Numbers)
            {
                if (row.TryGetProperty(name, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetDouble(out var d) && double.IsFinite(d)) card[name] = d;
            }

            if (row.TryGetProperty("genreIds", out var genres) && genres.ValueKind == JsonValueKind.Array)
            {
                var ids = new JsonArray();
                foreach (var g in genres.EnumerateArray())
                {
                    if (g.ValueKind == JsonValueKind.Number && g.TryGetInt32(out var gid)) ids.Add(gid);
                }

                card["genreIds"] = ids;
            }

            var state = NativeDetailsDtos.Int(media, "status");
            if (listed.LibraryCopy is { } copy)
            {
                // A library card: it opens the copy the viewer can open.
                card["mediaInfo"] = new JsonObject
                {
                    ["status"] = state == 4 ? 4 : 5,
                    ["jellyfinMediaId"] = copy.ToString("N", CultureInfo.InvariantCulture),
                };
            }
            else if (state is int s && AbsentStates.Contains(s))
            {
                card["mediaInfo"] = new JsonObject { ["status"] = s };
            }

            return card;
        }
    }
}
#endif
