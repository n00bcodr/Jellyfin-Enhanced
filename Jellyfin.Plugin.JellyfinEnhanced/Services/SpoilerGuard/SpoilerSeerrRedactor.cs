using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Spoiler Guard for metadata JE shows from outside Jellyfin. More Info, the
    // Seerr cards, the release-date chips and the MDBList row render Seerr, TMDB
    // and MDBList data that SpoilerFieldStripFilter never sees, so this applies the
    // same per-user policy to those responses on the server. Every caller is then
    // protected without the client having to work out what is guarded, which it
    // can't: it has neither the TMDB id of a library item nor collection members.
    //
    // A title counts as protected on the same terms as StripItem: a Series on the
    // user's list, an unplayed Movie on it or in an opted-in collection, and
    // anything pending on PendingTmdb. Fields follow the same toggles, and started
    // seasons and played episodes stay visible, as they do on the item itself.
    //
    // Runs per request on top of the shared upstream caches, which is what lets
    // those caches stay shared between users. LoadRows does the same for the rows
    // JE builds itself from Seerr and the *arrs. Changing a rule in
    // SpoilerFieldStripFilter.ApplyStripping means changing it here too.
    public sealed class SpoilerSeerrRedactor
    {
        private static readonly TimeSpan IndexTtl = TimeSpan.FromSeconds(30);
        private static readonly Regex SeerrTitle = new(@"^/api/v1/(movie|tv)/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex SeerrSeason = new(@"^/api/v1/tv/(\d+)/season/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex SeerrRatings = new(@"^/api/v1/(?:(movie)/(\d+)/ratingscombined|(tv)/(\d+)/ratings)$", RegexOptions.Compiled);
        private static readonly Regex SeerrSonarrLookup = new(@"^/api/v1/service/sonarr/lookup/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex SeerrCollection = new(@"^/api/v1/collection/\d+$", RegexOptions.Compiled);
        private static readonly Regex SeerrPersonCredits = new(@"^/api/v1/person/\d+/combined_credits$", RegexOptions.Compiled);
        private static readonly Regex TmdbTitle = new(@"^(movie|tv)/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex TmdbSeason = new(@"^tv/(\d+)/season/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex TmdbEpisode = new(@"^tv/(\d+)/season/(\d+)/episode/(\d+)$", RegexOptions.Compiled);
        private static readonly Regex TmdbReleaseDates = new(@"^movie/(\d+)/release_dates$", RegexOptions.Compiled);

        private static readonly Dialect SeerrKeys = new(
            "voteAverage", "voteCount", "releaseDate", "firstAirDate", "lastAirDate", "lastEpisodeToAir",
            "nextEpisodeToAir", "posterPath", "backdropPath", "stillPath", "airDate", "relatedVideos",
            "seasonNumber", "episodeNumber", "guestStars");

        private static readonly Dialect TmdbKeys = new(
            "vote_average", "vote_count", "release_date", "first_air_date", "last_air_date", "last_episode_to_air",
            "next_episode_to_air", "poster_path", "backdrop_path", "still_path", "air_date", "videos",
            "season_number", "episode_number", "guest_stars");

        // Keyed by user. An entry is only trusted for the state object it was built
        // from: a write drops that object from the resolver's cache, so a new one
        // rebuilds the index with no invalidation of its own. The TTL bounds staleness
        // from library edits, such as a guarded item gaining its TMDB id.
        private static readonly ConcurrentDictionary<string, (UserSpoilerBlur State, GuardIndex Index, DateTime BuiltAt)> _indexes
            = new(StringComparer.OrdinalIgnoreCase);

        // The other ids Seerr reports for a TMDB title. Ratings and season requests carry
        // only the TMDB id, so a guarded item the library knows by another id needs these
        // to stay matched after its details. They're facts about the title, not the user.
        private const int MaxAliases = 8192;
        private static readonly ConcurrentDictionary<string, string[]> _aliases = new(StringComparer.Ordinal);

        private readonly SpoilerUserResolver _resolver;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;

        public SpoilerSeerrRedactor(
            SpoilerUserResolver resolver,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager)
        {
            _resolver = resolver;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
        }

        // Field names differ between Seerr (camelCase) and raw TMDB (snake_case).
        private sealed record Dialect(
            string VoteAverage,
            string VoteCount,
            string ReleaseDate,
            string FirstAirDate,
            string LastAirDate,
            string LastEpisode,
            string NextEpisode,
            string Poster,
            string Backdrop,
            string Still,
            string AirDate,
            string Videos,
            string SeasonNumber,
            string EpisodeNumber,
            string GuestStars);

        private sealed record Policy(
            bool Overview,
            bool SeasonOverview,
            bool ReplaceTitle,
            bool Tags,
            bool Taglines,
            bool Ratings,
            bool Dates,
            bool CastAll,
            bool Poster,
            bool Backdrop,
            string Placeholder)
        {
            // The title-bearing block in ApplyStripping runs on the same condition.
            public bool Auxiliary => ReplaceTitle || Overview;
        }

        // Tokens are "tmdb:{id}", "tvdb:{id}", "shoko:{id}" and "jf:{guid}", which covers
        // a title with no TMDB id through the ids Seerr or the *arrs report for it.
        internal sealed class GuardIndex
        {
            public Dictionary<string, List<Guid>> Series { get; } = new(StringComparer.OrdinalIgnoreCase);

            public Dictionary<string, List<GuardedMovie>> Movies { get; } = new(StringComparer.OrdinalIgnoreCase);

            // A guarded item with no TMDB id can only be matched through _aliases.
            public bool SeriesWithoutTmdb { get; set; }

            public bool MoviesWithoutTmdb { get; set; }

            // A failed lookup leaves the guarded set unknown, which isn't a "no".
            public bool Failed { get; set; }
        }

        internal sealed record GuardedMovie(Guid Id, bool Direct);

        internal sealed record GuardScope(PluginConfiguration Config, UserSpoilerBlur State, GuardIndex Index, Guid UserId);

        // Why a title is protected. Inherited means only through a collection, so
        // the guard can't be switched off from the title itself.
        private sealed record GuardMatch(IReadOnlyList<Guid> SeriesIds, bool Inherited);

        /// <summary>What Spoiler Guard hides on a row JE builds for a protected title.</summary>
        /// <param name="HideOverview">Descriptions.</param>
        /// <param name="HideDates">Air and release dates.</param>
        /// <param name="HidePoster">The poster.</param>
        /// <param name="HideBackdrop">The backdrop.</param>
        public sealed record RowPolicy(bool HideOverview, bool HideDates, bool HidePoster, bool HideBackdrop);

        /// <summary>
        /// One caller's guards, for the rows JE assembles itself. Resolved up front so
        /// parallel row builders never touch the request, and applied after any cache
        /// shared between users. Loaded through <see cref="LoadRows"/>.
        /// </summary>
        public sealed class GuardedRows
        {
            private readonly SpoilerSeerrRedactor _owner;
            private readonly GuardScope _scope;
            private readonly ConcurrentDictionary<Guid, Dictionary<int, HashSet<int>>> _progress = new();

            internal GuardedRows(SpoilerSeerrRedactor owner, GuardScope scope)
            {
                _owner = owner;
                _scope = scope;
            }

            /// <summary>The policy for a title's row, or null when it isn't protected.</summary>
            /// <param name="isSeries">True for a series.</param>
            /// <param name="tmdbId">The TMDB id, when known.</param>
            /// <param name="tvdbId">The TVDB id, when known.</param>
            /// <param name="jellyfinId">The Jellyfin id Seerr reports, when known.</param>
            /// <returns>What to hide, or null.</returns>
            public RowPolicy? ForTitle(bool isSeries, string? tmdbId, string? tvdbId, string? jellyfinId)
            {
                if (_owner.MatchTokens(_scope, isSeries, tmdbId, RowTokens(tvdbId, null, jellyfinId)) == null) return null;
                var policy = BuildPolicy(_scope, isSeries);
                return new RowPolicy(policy.Overview, policy.Dates, policy.Poster, policy.Backdrop);
            }

            /// <summary>Whether an episode's title is hidden from this caller.</summary>
            /// <param name="tmdbId">The series' TMDB id, when known.</param>
            /// <param name="tvdbId">The series' TVDB id, when known.</param>
            /// <param name="shokoSeriesId">The Shoko series id, when known.</param>
            /// <param name="season">The season number, when known.</param>
            /// <param name="episode">The episode number, when known.</param>
            /// <returns>True when the title must not be shown.</returns>
            public bool HidesEpisodeTitle(string? tmdbId, string? tvdbId, string? shokoSeriesId, int? season, int? episode)
                => BuildPolicy(_scope, true).ReplaceTitle && IsUnplayedAndGuarded(tmdbId, tvdbId, shokoSeriesId, season, episode);

            /// <summary>Whether an episode's description is hidden from this caller.</summary>
            /// <param name="tmdbId">The series' TMDB id, when known.</param>
            /// <param name="tvdbId">The series' TVDB id, when known.</param>
            /// <param name="shokoSeriesId">The Shoko series id, when known.</param>
            /// <param name="season">The season number, when known.</param>
            /// <param name="episode">The episode number, when known.</param>
            /// <returns>True when the description must not be shown.</returns>
            public bool HidesEpisodeOverview(string? tmdbId, string? tvdbId, string? shokoSeriesId, int? season, int? episode)
                => BuildPolicy(_scope, true).SeasonOverview && IsUnplayedAndGuarded(tmdbId, tvdbId, shokoSeriesId, season, episode);

            private bool IsUnplayedAndGuarded(string? tmdbId, string? tvdbId, string? shokoSeriesId, int? season, int? episode)
            {
                var match = _owner.MatchTokens(_scope, true, tmdbId, RowTokens(tvdbId, shokoSeriesId, null));
                if (match == null) return false;
                if (episode == null) return true;
                foreach (var seriesId in match.SeriesIds)
                {
                    var progress = _progress.GetOrAdd(seriesId, id => _owner.LoadProgress(_scope, new[] { id }));
                    // Shoko numbers an episode without a season.
                    if (season == null)
                    {
                        foreach (var played in progress.Values)
                        {
                            if (played.Contains(episode.Value)) return false;
                        }
                    }
                    else if (progress.TryGetValue(season.Value, out var played) && played.Contains(episode.Value))
                    {
                        return false;
                    }
                }

                return true;
            }

            private static List<string> RowTokens(string? tvdbId, string? shokoSeriesId, string? jellyfinId)
            {
                var tokens = new List<string>();
                if (!string.IsNullOrEmpty(tvdbId)) tokens.Add("tvdb:" + tvdbId);
                if (!string.IsNullOrEmpty(shokoSeriesId)) tokens.Add("shoko:" + shokoSeriesId);
                if (Guid.TryParse(jellyfinId, out var id)) tokens.Add(JellyfinToken(id));
                return tokens;
            }
        }

        /// <summary>
        /// Applies the caller's Spoiler Guard policy to a proxied Seerr GET body.
        /// </summary>
        /// <param name="json">The response body, after parental filtering.</param>
        /// <param name="apiPath">The Seerr path, with any query string.</param>
        /// <param name="jellyfinUserId">The authenticated caller.</param>
        /// <param name="httpContext">The current request.</param>
        /// <returns>The body to send, the same string when nothing applies.</returns>
        public string RedactSeerr(string json, string apiPath, string? jellyfinUserId, HttpContext httpContext)
        {
            var scope = LoadScope(jellyfinUserId, httpContext);
            if (scope == null || string.IsNullOrEmpty(json)) return json;

            var path = apiPath.Split('?', 2)[0];
            try
            {
                var root = JsonNode.Parse(json);
                return RedactSeerrRoot(root, path, scope) ? root!.ToJsonString() : json;
            }
            catch (JsonException)
            {
                // Not JSON, so nothing here can be rendered as a title.
                return json;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "seerr-redact:" + ex.GetType().FullName,
                    $"Spoiler Guard: Seerr redaction failed for {path}: {ex.Message}");
                return json;
            }
        }

        /// <summary>
        /// Applies the caller's Spoiler Guard policy to a raw TMDB passthrough body.
        /// </summary>
        /// <param name="json">The response body.</param>
        /// <param name="apiPath">The TMDB path, without a leading slash or query.</param>
        /// <param name="jellyfinUserId">The authenticated caller.</param>
        /// <param name="httpContext">The current request.</param>
        /// <param name="redacted">The body to send when this returns true.</param>
        /// <returns>True when the title is protected and the body was changed.</returns>
        public bool TryRedactTmdb(string json, string apiPath, string? jellyfinUserId, HttpContext httpContext, out string redacted)
        {
            redacted = json;
            var scope = LoadScope(jellyfinUserId, httpContext);
            if (scope == null || string.IsNullOrEmpty(json)) return false;

            var path = apiPath.TrimStart('/');
            try
            {
                if (JsonNode.Parse(json) is not JsonObject root) return false;
                if (!RedactTmdbRoot(root, path, scope)) return false;
                redacted = root.ToJsonString();
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "tmdb-redact:" + ex.GetType().FullName,
                    $"Spoiler Guard: TMDB redaction failed for {path}: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Whether the caller's Spoiler Guard policy hides this title's ratings.
        /// </summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">The TMDB id.</param>
        /// <param name="jellyfinUserId">The authenticated caller.</param>
        /// <param name="httpContext">The current request.</param>
        /// <returns>True when ratings for the title must not be shown.</returns>
        public bool HidesRatings(string mediaType, string tmdbId, string? jellyfinUserId, HttpContext httpContext)
        {
            var scope = LoadScope(jellyfinUserId, httpContext);
            if (scope == null) return false;
            var isSeries = mediaType == "tv";
            return BuildPolicy(scope, isSeries).Ratings && Match(scope, isSeries, tmdbId, null, null) != null;
        }

        /// <summary>
        /// Loads the caller's guards for rows JE builds itself, which never pass through
        /// the proxies: the Requests page, Downloads and the calendar.
        /// </summary>
        /// <param name="jellyfinUserId">The authenticated caller.</param>
        /// <param name="httpContext">The current request.</param>
        /// <returns>The guards, or null when Spoiler Guard doesn't apply to this caller.</returns>
        public GuardedRows? LoadRows(string? jellyfinUserId, HttpContext httpContext)
        {
            var scope = LoadScope(jellyfinUserId, httpContext);
            return scope == null ? null : new GuardedRows(this, scope);
        }

        // Null when Spoiler Guard can't apply to this caller, the path nearly every
        // request takes: no body parsing and no library lookups.
        private GuardScope? LoadScope(string? jellyfinUserId, HttpContext httpContext)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.SpoilerBlurEnabled != true) return null;
            if (!Guid.TryParse(jellyfinUserId, out var userId) || userId == Guid.Empty) return null;

            var state = _resolver.LoadUserState(httpContext, userId);
            if (state.Series.Count == 0 && state.Movies.Count == 0
                && state.Collections.Count == 0 && state.PendingTmdb.Count == 0)
            {
                return null;
            }

            return new GuardScope(config, state, GetIndex(userId, state), userId);
        }

        private GuardIndex GetIndex(Guid userId, UserSpoilerBlur state)
        {
            var key = userId.ToString("N");
            var now = DateTime.UtcNow;
            if (_indexes.TryGetValue(key, out var entry)
                && ReferenceEquals(entry.State, state)
                && now - entry.BuiltAt < IndexTtl)
            {
                return entry.Index;
            }

            var index = BuildIndex(state);
            _indexes[key] = (state, index, now);
            if (_indexes.Count > 512)
            {
                foreach (var kvp in _indexes)
                {
                    if (now - kvp.Value.BuiltAt >= IndexTtl) _indexes.TryRemove(kvp.Key, out _);
                }
            }

            return index;
        }

        private GuardIndex BuildIndex(UserSpoilerBlur state)
        {
            var index = new GuardIndex();
            foreach (var key in state.Series.Keys)
            {
                if (!Guid.TryParse(key, out var id)) continue;
                AddToken(index.Series, JellyfinToken(id), id);
                var series = Lookup(id, index) as Series;
                if (!AddProviderToken(index.Series, series, MetadataProvider.Tmdb.ToString(), "tmdb:", id)) index.SeriesWithoutTmdb = true;
                AddProviderToken(index.Series, series, MetadataProvider.Tvdb.ToString(), "tvdb:", id);
                AddProviderToken(index.Series, series, "Shoko Series", "shoko:", id);
            }

            foreach (var key in state.Movies.Keys)
            {
                if (!Guid.TryParse(key, out var id)) continue;
                AddMovie(index, id, Lookup(id, index) as Movie, true);
            }

            foreach (var key in state.Collections.Keys)
            {
                if (!Guid.TryParse(key, out var id)) continue;
                if (Lookup(id, index) is not BoxSet collection) continue;
                try
                {
                    foreach (var child in collection.GetLinkedChildren())
                    {
                        if (child is Movie movie) AddMovie(index, movie.Id, movie, false);
                    }
                }
                catch (Exception ex)
                {
                    index.Failed = true;
                    _resolver.WarnRateLimited(
                        "seerr-redact-collection:" + ex.GetType().FullName,
                        $"Spoiler Guard: collection lookup failed for {id}: {ex.Message}");
                }
            }

            return index;
        }

        private BaseItem? Lookup(Guid id, GuardIndex index)
        {
            try
            {
                return _libraryManager.GetItemById(id);
            }
            catch (Exception ex)
            {
                index.Failed = true;
                _resolver.WarnRateLimited(
                    "seerr-redact-lookup:" + ex.GetType().FullName,
                    $"Spoiler Guard: library lookup failed for {id}: {ex.Message}");
                return null;
            }
        }

        private static void AddMovie(GuardIndex index, Guid id, Movie? movie, bool direct)
        {
            AddMovieToken(index, JellyfinToken(id), id, direct);
            if (movie?.ProviderIds != null
                && movie.ProviderIds.TryGetValue(MetadataProvider.Tmdb.ToString(), out var tmdb)
                && !string.IsNullOrEmpty(tmdb))
            {
                AddMovieToken(index, "tmdb:" + tmdb, id, direct);
            }
            else
            {
                index.MoviesWithoutTmdb = true;
            }
        }

        private static void AddMovieToken(GuardIndex index, string token, Guid id, bool direct)
        {
            if (!index.Movies.TryGetValue(token, out var movies))
            {
                movies = new List<GuardedMovie>();
                index.Movies[token] = movies;
            }

            var existing = movies.FindIndex(m => m.Id == id);
            if (existing < 0) movies.Add(new GuardedMovie(id, direct));
            else if (direct) movies[existing] = new GuardedMovie(id, true);
        }

        private static void AddToken(Dictionary<string, List<Guid>> tokens, string token, Guid id)
        {
            if (!tokens.TryGetValue(token, out var ids))
            {
                ids = new List<Guid>();
                tokens[token] = ids;
            }

            if (!ids.Contains(id)) ids.Add(id);
        }

        private static bool AddProviderToken(Dictionary<string, List<Guid>> tokens, Series? series, string provider, string prefix, Guid id)
        {
            if (series?.ProviderIds == null
                || !series.ProviderIds.TryGetValue(provider, out var value)
                || string.IsNullOrEmpty(value))
            {
                return false;
            }

            AddToken(tokens, prefix + value, id);
            return true;
        }

        private static string JellyfinToken(Guid id) => "jf:" + id.ToString("N");

        // mediaInfo and externalIds carry the other ids Seerr knows for a title. The ones
        // reported here stay available to the requests that follow with a bare TMDB id. A
        // details response settles a title even with none, as for one outside the library.
        private GuardMatch? Match(GuardScope scope, bool isSeries, string tmdbId, JsonObject? mediaInfo, string? tvdbId, bool details = false)
        {
            var tokens = new List<string>();
            if (!string.IsNullOrEmpty(tvdbId)) tokens.Add("tvdb:" + tvdbId);
            if (mediaInfo != null)
            {
                var infoTvdb = Scalar(mediaInfo["tvdbId"]);
                if (infoTvdb != null) tokens.Add("tvdb:" + infoTvdb);
                foreach (var name in new[] { "jellyfinMediaId", "jellyfinMediaId4k" })
                {
                    if (Guid.TryParse(Scalar(mediaInfo[name]), out var jellyfinId)) tokens.Add(JellyfinToken(jellyfinId));
                }
            }

            if (details || mediaInfo != null) Remember(AliasKey(isSeries, tmdbId), tokens);
            return MatchTokens(scope, isSeries, tmdbId, tokens);
        }

        private static string AliasKey(bool isSeries, string tmdbId) => (isSeries ? "tv:" : "movie:") + tmdbId;

        private static void Remember(string key, List<string> tokens)
        {
            if (_aliases.Count >= MaxAliases) _aliases.Clear();
            _aliases.AddOrUpdate(
                key,
                _ => tokens.ToArray(),
                (_, known) =>
                {
                    var merged = new HashSet<string>(known, StringComparer.OrdinalIgnoreCase);
                    merged.UnionWith(tokens);
                    return merged.Count == known.Length ? known : new List<string>(merged).ToArray();
                });
        }

        private GuardMatch? MatchTokens(GuardScope scope, bool isSeries, string? tmdbId, List<string> tokens)
        {
            if (scope.Index.Failed) return new GuardMatch(Array.Empty<Guid>(), false);

            var pending = false;
            if (!string.IsNullOrEmpty(tmdbId))
            {
                var key = AliasKey(isSeries, tmdbId);
                pending = scope.State.PendingTmdb.ContainsKey(key);
                tokens = new List<string>(tokens) { "tmdb:" + tmdbId };
                if (_aliases.TryGetValue(key, out var aliases)) tokens.AddRange(aliases);
            }

            GuardMatch? match = isSeries ? MatchSeries(scope, tokens) : MatchMovie(scope, tokens);
            if (match != null) return match;
            if (pending) return new GuardMatch(Array.Empty<Guid>(), false);
            return !string.IsNullOrEmpty(tmdbId) && IsUnresolved(scope, isSeries, tmdbId)
                ? new GuardMatch(Array.Empty<Guid>(), false)
                : null;
        }

        private static GuardMatch? MatchSeries(GuardScope scope, List<string> tokens)
        {
            var ids = new List<Guid>();
            foreach (var token in tokens)
            {
                if (!scope.Index.Series.TryGetValue(token, out var matched)) continue;
                foreach (var id in matched)
                {
                    if (!ids.Contains(id)) ids.Add(id);
                }
            }

            return ids.Count > 0 ? new GuardMatch(ids, false) : null;
        }

        // A played movie has nothing left to spoil, as in StripItem's Movie arm.
        private GuardMatch? MatchMovie(GuardScope scope, List<string> tokens)
        {
            var found = false;
            var direct = false;
            foreach (var token in tokens)
            {
                if (!scope.Index.Movies.TryGetValue(token, out var movies)) continue;
                foreach (var movie in movies)
                {
                    if (IsPlayed(scope.UserId, movie.Id)) continue;
                    found = true;
                    direct |= movie.Direct;
                }
            }

            return found ? new GuardMatch(Array.Empty<Guid>(), !direct) : null;
        }

        // A bare TMDB id for a title whose other ids aren't known yet, from a user with a
        // guarded item the library has no TMDB id for: that item could be this title. A
        // library item with this TMDB id settles it, because it would have matched above.
        private bool IsUnresolved(GuardScope scope, bool isSeries, string tmdbId)
        {
            if (!(isSeries ? scope.Index.SeriesWithoutTmdb : scope.Index.MoviesWithoutTmdb)) return false;
            if (_aliases.ContainsKey(AliasKey(isSeries, tmdbId))) return false;
            try
            {
                var items = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { isSeries ? BaseItemKind.Series : BaseItemKind.Movie },
                    HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { "Tmdb", tmdbId } },
                    Recursive = true,
                    Limit = 1,
                });
                return items == null || items.Count == 0;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "seerr-redact-unresolved:" + ex.GetType().FullName,
                    $"Spoiler Guard: TMDB lookup failed for {tmdbId}: {ex.Message}");
                return true;
            }
        }

        // The episodes this caller has played, by season. Empty after a failure, which
        // leaves everything stripped.
        private Dictionary<int, HashSet<int>> LoadProgress(GuardScope scope, IReadOnlyList<Guid> seriesIds)
        {
            var progress = new Dictionary<int, HashSet<int>>();
            if (seriesIds.Count == 0) return progress;
            try
            {
                var user = _userManager.GetUserById(scope.UserId);
                if (user == null) return progress;
                foreach (var seriesId in seriesIds)
                {
                    var played = _libraryManager.GetItemList(new InternalItemsQuery(user)
                    {
                        ParentId = seriesId,
                        IncludeItemTypes = new[] { BaseItemKind.Episode },
                        Recursive = true,
                        IsPlayed = true,
                        IsVirtualItem = false,
                    });
                    if (played == null) continue;
                    foreach (var item in played)
                    {
                        if (item is not Episode episode || episode.ParentIndexNumber is not int season || episode.IndexNumber is not int number) continue;
                        if (!progress.TryGetValue(season, out var numbers))
                        {
                            numbers = new HashSet<int>();
                            progress[season] = numbers;
                        }

                        numbers.Add(number);
                    }
                }
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "seerr-redact-progress:" + ex.GetType().FullName,
                    $"Spoiler Guard: played-episode lookup failed: {ex.Message}");
            }

            return progress;
        }

        private bool IsPlayed(Guid userId, Guid itemId)
        {
            try
            {
                var user = _userManager.GetUserById(userId);
                var item = _libraryManager.GetItemById(itemId);
                if (user == null || item == null) return false;
                return _userDataManager.GetUserData(user, item)?.Played == true;
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "seerr-redact-played:" + ex.GetType().FullName,
                    $"Spoiler Guard: played lookup failed for {itemId}: {ex.Message}");
                // Unknown isn't "played": keep the protection.
                return false;
            }
        }

        private static Policy BuildPolicy(GuardScope scope, bool isSeries)
        {
            var cfg = scope.Config;
            var prefs = scope.State.Prefs;
            var cast = SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerStripCast, prefs?.HideCast);
            return new Policy(
                Overview: SpoilerFieldStripFilter.ShouldStripOverview(isSeries, scope.State, cfg),
                SeasonOverview: SpoilerFieldStripFilter.ShouldStripOverview(false, scope.State, cfg),
                ReplaceTitle: SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerReplaceTitle, prefs?.ReplaceEpisodeTitles),
                Tags: SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerStripTags, prefs?.HideTags),
                Taglines: SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerStripTaglines, prefs?.HideTaglines),
                Ratings: SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerStripRatings, prefs?.HideRatings),
                Dates: SpoilerFieldStripFilter.ShouldStrip(cfg.SpoilerStripPremiereDate, prefs?.HideAirDate),
                CastAll: cast && string.Equals(cfg.SpoilerStripCastMode, "All", StringComparison.OrdinalIgnoreCase),
                // Series art passes the image filter. Movie art follows these two settings.
                Poster: !isSeries && !cfg.SpoilerKeepMoviePosters,
                Backdrop: !isSeries && cfg.SpoilerBlurArtwork,
                Placeholder: SpoilerFieldStripFilter.SanitizePlaceholder(cfg.SpoilerOverviewPlaceholder));
        }

        private bool RedactSeerrRoot(JsonNode? root, string path, GuardScope scope)
        {
            var title = SeerrTitle.Match(path);
            if (title.Success && root is JsonObject detail)
            {
                var isSeries = title.Groups[1].Value == "tv";
                var tvdbId = Scalar((detail["externalIds"] as JsonObject)?["tvdbId"]);
                var match = Match(scope, isSeries, title.Groups[2].Value, detail["mediaInfo"] as JsonObject, tvdbId, details: true);
                if (match == null) return false;
                RedactDetail(detail, BuildPolicy(scope, isSeries), SeerrKeys, isSeries, LoadProgress(scope, match.SeriesIds), match.Inherited);
                return true;
            }

            var season = SeerrSeason.Match(path);
            if (season.Success && root is JsonObject seasonRoot)
            {
                var match = Match(scope, true, season.Groups[1].Value, null, null);
                if (match == null) return false;
                RedactSeasonDetail(seasonRoot, BuildPolicy(scope, true), SeerrKeys, ParseNumber(season.Groups[2].Value), LoadProgress(scope, match.SeriesIds));
                return true;
            }

            var ratings = SeerrRatings.Match(path);
            if (ratings.Success && root is JsonObject ratingsRoot)
            {
                var isSeries = ratings.Groups[3].Success;
                var id = isSeries ? ratings.Groups[4].Value : ratings.Groups[2].Value;
                if (!BuildPolicy(scope, isSeries).Ratings || Match(scope, isSeries, id, null, null) == null) return false;
                ratingsRoot.Clear();
                return true;
            }

            var lookup = SeerrSonarrLookup.Match(path);
            if (lookup.Success && root is JsonArray candidates)
            {
                var policy = BuildPolicy(scope, true);
                if (!policy.Overview || Match(scope, true, lookup.Groups[1].Value, null, null) == null) return false;
                foreach (var candidate in candidates)
                {
                    (candidate as JsonObject)?.Remove("overview");
                }

                return true;
            }

            if (root is not JsonObject list) return false;
            if (SeerrCollection.IsMatch(path)) return RedactList(list["parts"] as JsonArray, scope, false);
            if (SeerrPersonCredits.IsMatch(path))
            {
                var changed = RedactList(list["cast"] as JsonArray, scope, null);
                return RedactList(list["crew"] as JsonArray, scope, null) || changed;
            }

            return RedactList(list["results"] as JsonArray, scope, ListKind(path));
        }

        // Discover and similar responses can omit mediaType, but their path says.
        private static bool? ListKind(string path)
        {
            if (path.StartsWith("/api/v1/discover/movies", StringComparison.Ordinal)
                || path.StartsWith("/api/v1/movie/", StringComparison.Ordinal))
            {
                return false;
            }

            if (path.StartsWith("/api/v1/discover/tv", StringComparison.Ordinal)
                || path.StartsWith("/api/v1/tv/", StringComparison.Ordinal))
            {
                return true;
            }

            return null;
        }

        private bool RedactList(JsonArray? items, GuardScope scope, bool? listIsSeries)
        {
            if (items == null) return false;
            var changed = false;
            foreach (var node in items)
            {
                if (node is not JsonObject item) continue;
                var kind = Scalar(item["mediaType"]);
                bool isSeries;
                if (kind == "tv") isSeries = true;
                else if (kind == "movie") isSeries = false;
                else if (kind == null && listIsSeries.HasValue) isSeries = listIsSeries.Value;
                else continue;

                var tmdbId = Scalar(item["id"]);
                if (tmdbId == null || Match(scope, isSeries, tmdbId, item["mediaInfo"] as JsonObject, null) == null) continue;
                RedactTitleFields(item, BuildPolicy(scope, isSeries), SeerrKeys);
                changed = true;
            }

            return changed;
        }

        private bool RedactTmdbRoot(JsonObject root, string path, GuardScope scope)
        {
            var title = TmdbTitle.Match(path);
            if (title.Success)
            {
                var isSeries = title.Groups[1].Value == "tv";
                var match = Match(scope, isSeries, title.Groups[2].Value, null, null);
                if (match == null) return false;
                RedactDetail(root, BuildPolicy(scope, isSeries), TmdbKeys, isSeries, LoadProgress(scope, match.SeriesIds), match.Inherited);
                return true;
            }

            var season = TmdbSeason.Match(path);
            if (season.Success)
            {
                var match = Match(scope, true, season.Groups[1].Value, null, null);
                if (match == null) return false;
                RedactSeasonDetail(root, BuildPolicy(scope, true), TmdbKeys, ParseNumber(season.Groups[2].Value), LoadProgress(scope, match.SeriesIds));
                return true;
            }

            var episode = TmdbEpisode.Match(path);
            if (episode.Success)
            {
                var match = Match(scope, true, episode.Groups[1].Value, null, null);
                if (match == null) return false;
                var progress = LoadProgress(scope, match.SeriesIds);
                if (progress.TryGetValue(ParseNumber(episode.Groups[2].Value), out var played)
                    && played.Contains(ParseNumber(episode.Groups[3].Value)))
                {
                    return false;
                }

                RedactEpisode(root, BuildPolicy(scope, true), TmdbKeys);
                return true;
            }

            var releases = TmdbReleaseDates.Match(path);
            if (releases.Success)
            {
                if (!BuildPolicy(scope, false).Dates || Match(scope, false, releases.Groups[1].Value, null, null) == null) return false;
                root["results"] = new JsonArray();
                return true;
            }

            return false;
        }

        // What a card shows: lists keep their dates, which only ever appear as a year
        // and which sorting reads, as ProductionYear stays on a stripped item.
        private static void RedactTitleFields(JsonObject title, Policy policy, Dialect keys)
        {
            if (policy.Overview && !string.IsNullOrEmpty(Scalar(title["overview"])))
            {
                title["overview"] = policy.Placeholder;
            }

            if (policy.Ratings)
            {
                title.Remove(keys.VoteAverage);
                title.Remove(keys.VoteCount);
            }

            if (policy.Poster) title.Remove(keys.Poster);
            if (policy.Backdrop) title.Remove(keys.Backdrop);
        }

        private static void RedactDetail(JsonObject detail, Policy policy, Dialect keys, bool isSeries, Dictionary<int, HashSet<int>> progress, bool inherited)
        {
            RedactTitleFields(detail, policy, keys);
            detail["jeSpoilerGuard"] = true;
            if (inherited) detail["jeSpoilerGuardInherited"] = true;

            if (policy.Taglines) detail.Remove("tagline");
            if (policy.Tags) RedactKeywords(detail);

            if (policy.Auxiliary)
            {
                detail.Remove(keys.Videos);
            }

            // A date opt-out keeps these two, because the date chip reads them, without
            // their text.
            foreach (var key in new[] { keys.LastEpisode, keys.NextEpisode })
            {
                if (policy.Dates) detail.Remove(key);
                else if (policy.Auxiliary && detail[key] is JsonObject episode) RedactEpisode(episode, policy, keys);
            }

            if (policy.Dates) RedactDates(detail, keys, isSeries);
            RedactCredits(detail, policy);

            if (detail["seasons"] is JsonArray seasons)
            {
                foreach (var node in seasons)
                {
                    if (node is not JsonObject season) continue;
                    if (int.TryParse(Scalar(season[keys.SeasonNumber]), out var number)) RedactSeason(season, policy, keys, number, progress);
                }
            }
        }

        // Request override rules match on keywords, and they treat a missing list and
        // an empty one differently, so the client keeps them out of sight of anything
        // that renders. TMDB's shape has no such reader.
        private static void RedactKeywords(JsonObject detail)
        {
            if (detail["keywords"] is JsonArray keywords)
            {
                detail.Remove("keywords");
                detail["jeRuleKeywords"] = keywords;
            }
            else
            {
                detail.Remove("keywords");
            }
        }

        // The year stays visible, as ProductionYear does on a stripped item.
        private static void RedactDates(JsonObject detail, Dialect keys, bool isSeries)
        {
            var date = Scalar(detail[isSeries ? keys.FirstAirDate : keys.ReleaseDate]);
            if (date is { Length: >= 4 }) detail["jeYear"] = date.Substring(0, 4);
            detail.Remove(keys.ReleaseDate);
            detail.Remove(keys.FirstAirDate);
            detail.Remove(keys.LastAirDate);

            // Certifications sit beside these dates and the age badge reads them.
            if (detail["releases"] is JsonObject releases && releases["results"] is JsonArray results)
            {
                foreach (var region in results)
                {
                    if ((region as JsonObject)?["release_dates"] is not JsonArray dates) continue;
                    foreach (var entry in dates)
                    {
                        (entry as JsonObject)?.Remove("release_date");
                    }
                }
            }
        }

        private static void RedactCredits(JsonObject detail, Policy policy)
        {
            if (detail["credits"] is not JsonObject credits) return;
            if (policy.CastAll)
            {
                credits.Remove("cast");
                credits.Remove("crew");
                return;
            }

            if (policy.Auxiliary && credits["cast"] is JsonArray cast)
            {
                foreach (var person in cast)
                {
                    (person as JsonObject)?.Remove("character");
                }
            }
        }

        // Season 0 and season 1 stay as the way in, and so does a season this caller has
        // started, as in StripItem's Season arm.
        private static void RedactSeason(JsonObject season, Policy policy, Dialect keys, int number, Dictionary<int, HashSet<int>> progress)
        {
            if (number <= 1 || progress.ContainsKey(number)) return;
            if (policy.SeasonOverview) season.Remove("overview");
            if (policy.ReplaceTitle) season["name"] = $"Season {number}";
            if (policy.Dates) season.Remove(keys.AirDate);
            season.Remove(keys.Poster);
        }

        private static void RedactSeasonDetail(JsonObject season, Policy policy, Dialect keys, int number, Dictionary<int, HashSet<int>> progress)
        {
            RedactSeason(season, policy, keys, number, progress);
            if (season["episodes"] is not JsonArray episodes) return;
            progress.TryGetValue(number, out var played);
            foreach (var episode in episodes)
            {
                if (episode is not JsonObject item) continue;
                if (played != null && int.TryParse(Scalar(item[keys.EpisodeNumber]), out var episodeNumber) && played.Contains(episodeNumber)) continue;
                RedactEpisode(item, policy, keys);
            }
        }

        private static void RedactEpisode(JsonObject episode, Policy policy, Dialect keys)
        {
            if (policy.ReplaceTitle)
            {
                var number = Scalar(episode[keys.EpisodeNumber]);
                if (number != null) episode["name"] = $"Episode {number}";
                else episode.Remove("name");
            }

            if (policy.SeasonOverview) episode.Remove("overview");
            if (policy.Dates) episode.Remove(keys.AirDate);
            if (policy.Ratings)
            {
                episode.Remove(keys.VoteAverage);
                episode.Remove(keys.VoteCount);
            }

            if (policy.Auxiliary)
            {
                episode.Remove(keys.GuestStars);
                episode.Remove("crew");
            }

            episode.Remove(keys.Still);
        }

        private static int ParseNumber(string digits) => int.Parse(digits, System.Globalization.CultureInfo.InvariantCulture);

        // Seerr sends ids as numbers in some shapes and strings in others.
        private static string? Scalar(JsonNode? node)
        {
            if (node is not JsonValue value) return null;
            if (value.TryGetValue<string>(out var text)) return text;
            return value.TryGetValue<long>(out var number)
                ? number.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : null;
        }
    }
}
