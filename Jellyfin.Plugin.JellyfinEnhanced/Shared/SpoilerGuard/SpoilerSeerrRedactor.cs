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

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.SpoilerGuard
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
        /// <summary>
        /// Sent on the requests that follow a details response marked protected. They carry
        /// only a TMDB id, which may be all the library lacks. The value lists the items those
        /// details named, or is "1". It needs no trust: it can only ever hide more, because an
        /// item that isn't one of the caller's guards is ignored and an exemption still needs
        /// the episode's or season's own id.
        /// </summary>
        public const string GuardedFollowUpHeader = "X-JE-Spoiler-Guarded";

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

        private readonly SpoilerUserResolver _resolver;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly SpoilerNextUnwatchedService _nextUnwatched;

        public SpoilerSeerrRedactor(
            SpoilerUserResolver resolver,
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            SpoilerNextUnwatchedService nextUnwatched)
        {
            _resolver = resolver;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _nextUnwatched = nextUnwatched;
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
            bool Cast,
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

            // A failed lookup leaves that kind's guarded set unknown, which isn't a "no".
            public bool SeriesFailed { get; set; }

            public bool MoviesFailed { get; set; }
        }

        // One caller's progress through a guarded series, keyed by each episode's own ids.
        internal sealed class SeriesProgress
        {
            private readonly Dictionary<string, Episode> _episodes = new(StringComparer.OrdinalIgnoreCase);

            public HashSet<Guid> Played { get; } = new();

            // The seasons with a played episode, as "tmdb:{id}" and "tvdb:{id}".
            public HashSet<string> StartedSeasons { get; } = new(StringComparer.Ordinal);

            public void Add(Episode episode)
            {
                _episodes["id:" + episode.Id.ToString("N")] = episode;
                foreach (var provider in new[] { "Tvdb", "Tmdb" })
                {
                    if (episode.ProviderIds != null && episode.ProviderIds.TryGetValue(provider, out var value) && !string.IsNullOrEmpty(value))
                    {
                        _episodes[provider.ToLowerInvariant() + ":" + value] = episode;
                    }
                }
            }

            public Episode? Find(string? token)
                => token != null && _episodes.TryGetValue(token, out var episode) ? episode : null;
        }

        internal sealed record GuardedMovie(Guid Id, bool Direct);

        internal sealed record GuardScope(PluginConfiguration Config, UserSpoilerBlur State, GuardIndex Index, Guid UserId, bool GuardedFollowUp, List<Guid> FollowUpItems);

        // Why a title is protected. Inherited means only through a collection, so
        // the guard can't be switched off from the title itself.
        private sealed record GuardMatch(IReadOnlyList<Guid> ItemIds, bool Inherited);

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
            private readonly ConcurrentDictionary<string, SeriesProgress> _progress = new();

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
            /// <param name="jellyfinId4k">The Jellyfin id of the 4K copy, when known.</param>
            /// <returns>What to hide, or null.</returns>
            public RowPolicy? ForTitle(bool isSeries, string? tmdbId, string? tvdbId, string? jellyfinId, string? jellyfinId4k = null)
            {
                var tokens = RowTokens(tvdbId, null, jellyfinId);
                tokens.AddRange(RowTokens(null, null, jellyfinId4k));
                if (_owner.MatchTokens(_scope, isSeries, tmdbId, tokens) == null) return null;
                var policy = BuildPolicy(_scope, isSeries);
                return new RowPolicy(policy.Overview, policy.Dates, policy.Poster, policy.Backdrop);
            }

            /// <summary>Whether an episode's title is hidden from this caller.</summary>
            /// <param name="tmdbId">The series' TMDB id, when known.</param>
            /// <param name="tvdbId">The series' TVDB id, when known.</param>
            /// <param name="shokoSeriesId">The Shoko series id, when known.</param>
            /// <param name="itemEpisodeId">The episode's library item, when known.</param>
            /// <param name="episodeTvdbId">The episode's own TVDB id, when known.</param>
            /// <returns>True when the title must not be shown.</returns>
            public bool HidesEpisodeTitle(string? tmdbId, string? tvdbId, string? shokoSeriesId, Guid? itemEpisodeId, string? episodeTvdbId)
                => BuildPolicy(_scope, true).ReplaceTitle
                    && IsHidden(tmdbId, tvdbId, shokoSeriesId, itemEpisodeId, episodeTvdbId, reveal => reveal.Title);

            /// <summary>Whether an episode's description is hidden from this caller.</summary>
            /// <param name="tmdbId">The series' TMDB id, when known.</param>
            /// <param name="tvdbId">The series' TVDB id, when known.</param>
            /// <param name="shokoSeriesId">The Shoko series id, when known.</param>
            /// <param name="itemEpisodeId">The episode's library item, when known.</param>
            /// <param name="episodeTvdbId">The episode's own TVDB id, when known.</param>
            /// <returns>True when the description must not be shown.</returns>
            public bool HidesEpisodeOverview(string? tmdbId, string? tvdbId, string? shokoSeriesId, Guid? itemEpisodeId, string? episodeTvdbId)
                => BuildPolicy(_scope, true).SeasonOverview
                    && IsHidden(tmdbId, tvdbId, shokoSeriesId, itemEpisodeId, episodeTvdbId, reveal => reveal.Overview);

            private bool IsHidden(string? tmdbId, string? tvdbId, string? shokoSeriesId, Guid? itemEpisodeId, string? episodeTvdbId, Func<SpoilerFieldStripFilter.CategoryReveal, bool> revealed)
            {
                var match = _owner.MatchTokens(_scope, true, tmdbId, RowTokens(tvdbId, shokoSeriesId, null));
                if (match == null) return false;

                var progress = _progress.GetOrAdd(string.Join(',', match.ItemIds), _ => _owner.LoadProgress(_scope, match.ItemIds));
                var episode = progress.Find(itemEpisodeId.HasValue ? "id:" + itemEpisodeId.Value.ToString("N") : null)
                    ?? progress.Find(string.IsNullOrEmpty(episodeTvdbId) ? null : "tvdb:" + episodeTvdbId);

                // Nothing ties this row to a library episode, so nothing can exempt it.
                if (episode == null) return true;
                if (progress.Played.Contains(episode.Id)) return false;
                return !revealed(_owner.EpisodeReveal(_scope, episode));
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

            var followUp = httpContext.Request.Headers.TryGetValue(GuardedFollowUpHeader, out var named);
            return new GuardScope(config, state, GetIndex(userId, state), userId, followUp, ParseItems(named.ToString()));
        }

        private static List<Guid> ParseItems(string header)
        {
            var items = new List<Guid>();
            foreach (var part in header.Split(','))
            {
                if (Guid.TryParse(part.Trim(), out var id)) items.Add(id);
            }

            return items;
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
            // A failed lookup is retried on the next request rather than kept.
            if (index.SeriesFailed || index.MoviesFailed)
            {
                _indexes.TryRemove(key, out _);
                return index;
            }

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
                var series = Lookup(id, () => index.SeriesFailed = true) as Series;
                AddProviderToken(index.Series, series, MetadataProvider.Tmdb.ToString(), "tmdb:", id);
                AddProviderToken(index.Series, series, MetadataProvider.Tvdb.ToString(), "tvdb:", id);
                AddProviderToken(index.Series, series, "Shoko Series", "shoko:", id);
            }

            foreach (var key in state.Movies.Keys)
            {
                if (!Guid.TryParse(key, out var id)) continue;
                AddMovie(index, id, Lookup(id, () => index.MoviesFailed = true) as Movie, true);
            }

            foreach (var key in state.Collections.Keys)
            {
                if (!Guid.TryParse(key, out var id)) continue;
                if (Lookup(id, () => index.MoviesFailed = true) is not BoxSet collection) continue;
                try
                {
                    foreach (var child in collection.GetLinkedChildren())
                    {
                        if (child is Movie movie) AddMovie(index, movie.Id, movie, false);
                    }
                }
                catch (Exception ex)
                {
                    index.MoviesFailed = true;
                    _resolver.WarnRateLimited(
                        "seerr-redact-collection:" + ex.GetType().FullName,
                        $"Spoiler Guard: collection lookup failed for {id}: {ex.Message}");
                }
            }

            return index;
        }

        private BaseItem? Lookup(Guid id, Action onFailure)
        {
            try
            {
                return _libraryManager.GetItemById(id);
            }
            catch (Exception ex)
            {
                onFailure();
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

        private static void AddProviderToken(Dictionary<string, List<Guid>> tokens, Series? series, string provider, string prefix, Guid id)
        {
            if (series?.ProviderIds != null
                && series.ProviderIds.TryGetValue(provider, out var value)
                && !string.IsNullOrEmpty(value))
            {
                AddToken(tokens, prefix + value, id);
            }
        }

        private static string JellyfinToken(Guid id) => "jf:" + id.ToString("N");

        // mediaInfo and externalIds carry the other ids Seerr knows for a title. A follow-up
        // carries only the TMDB id, so the verdict on its details comes with it, along with
        // the items that lead to the caller's progress: nothing here remembers an identity
        // between requests.
        private GuardMatch? Match(GuardScope scope, bool isSeries, string tmdbId, JsonObject? mediaInfo, string? tvdbId)
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

            var match = MatchTokens(scope, isSeries, tmdbId, tokens);
            if (!scope.GuardedFollowUp || mediaInfo != null || tvdbId != null) return match;

            var items = scope.FollowUpItems.FindAll(id => scope.Index.Series.ContainsKey(JellyfinToken(id)));
            foreach (var id in match?.ItemIds ?? Array.Empty<Guid>())
            {
                if (!items.Contains(id)) items.Add(id);
            }

            return new GuardMatch(items, match?.Inherited == true);
        }

        // Only evidence decides: a title nothing ties to a guarded item is open, however
        // little is known about it. A failed lookup is different, because then the answer
        // is unknown, so titles of that kind keep their protection until one succeeds.
        private GuardMatch? MatchTokens(GuardScope scope, bool isSeries, string? tmdbId, List<string> tokens)
        {
            var all = new List<string>(tokens);
            if (!string.IsNullOrEmpty(tmdbId)) all.Add("tmdb:" + tmdbId);
            var match = isSeries ? MatchSeries(scope, all) : MatchMovie(scope, all);
            if (match != null) return match;

            var pending = !string.IsNullOrEmpty(tmdbId) && scope.State.PendingTmdb.ContainsKey((isSeries ? "tv:" : "movie:") + tmdbId);
            var unknown = isSeries ? scope.Index.SeriesFailed : scope.Index.MoviesFailed;
            return pending || unknown ? new GuardMatch(Array.Empty<Guid>(), false) : null;
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
            var ids = new List<Guid>();
            var direct = false;
            foreach (var token in tokens)
            {
                if (!scope.Index.Movies.TryGetValue(token, out var movies)) continue;
                foreach (var movie in movies)
                {
                    if (IsPlayed(scope.UserId, movie.Id)) continue;
                    if (!ids.Contains(movie.Id)) ids.Add(movie.Id);
                    direct |= movie.Direct;
                }
            }

            return ids.Count > 0 ? new GuardMatch(ids, !direct) : null;
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

        // The advanced-mode reveal for a library episode. Only an episode identified by
        // its own id gets here, so a shared number can't earn one.
        private SpoilerFieldStripFilter.CategoryReveal EpisodeReveal(GuardScope scope, Episode episode)
        {
            if (!scope.Config.SpoilerAdvancedMode || scope.State.Prefs?.UseAdvancedCategories == false)
            {
                return SpoilerFieldStripFilter.CategoryReveal.None;
            }

            var boundary = _nextUnwatched.GetBoundary(scope.UserId, episode.SeriesId);
            var category = SpoilerNextUnwatchedService.Categorize(boundary, episode.Id, episode.ParentIndexNumber, episode.IndexNumber);
            return SpoilerFieldStripFilter.RevealFor(category, scope.Config);
        }

        // The caller's library episodes and what they've played. Numbers aren't compared,
        // because the library and the outside source can order episodes differently: an
        // outside episode is matched by id or not at all. Empty after a failure, which
        // leaves everything stripped.
        private SeriesProgress LoadProgress(GuardScope scope, IReadOnlyList<Guid> seriesIds)
        {
            var progress = new SeriesProgress();
            if (seriesIds.Count == 0) return progress;
            try
            {
                var user = _userManager.GetUserById(scope.UserId);
                if (user == null) return progress;
                foreach (var seriesId in seriesIds)
                {
                    var query = new InternalItemsQuery(user)
                    {
                        ParentId = seriesId,
                        IncludeItemTypes = new[] { BaseItemKind.Episode },
                        Recursive = true,
                        IsVirtualItem = false,
                    };
                    var all = _libraryManager.GetItemList(query);
                    if (all != null)
                    {
                        foreach (var item in all)
                        {
                            if (item is Episode episode) progress.Add(episode);
                        }
                    }

                    query.IsPlayed = true;
                    var played = _libraryManager.GetItemList(query);
                    if (played == null) continue;
                    foreach (var item in played)
                    {
                        if (item is not Episode episode) continue;
                        progress.Add(episode);
                        progress.Played.Add(episode.Id);
                        var seasonIds = _libraryManager.GetItemById(episode.SeasonId)?.ProviderIds;
                        foreach (var provider in new[] { MetadataProvider.Tmdb, MetadataProvider.Tvdb })
                        {
                            if (seasonIds != null && seasonIds.TryGetValue(provider.ToString(), out var seasonId) && !string.IsNullOrEmpty(seasonId))
                            {
                                progress.StartedSeasons.Add(provider.ToString().ToLowerInvariant() + ":" + seasonId);
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _resolver.WarnRateLimited(
                    "seerr-redact-progress:" + ex.GetType().FullName,
                    $"Spoiler Guard: played-episode lookup failed: {ex.Message}");
                return new SeriesProgress();
            }

            return progress;
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
                Cast: cast,
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
                var match = Match(scope, isSeries, title.Groups[2].Value, detail["mediaInfo"] as JsonObject, tvdbId);
                if (match == null) return false;
                RedactDetail(scope, detail, BuildPolicy(scope, isSeries), SeerrKeys, isSeries, ProgressFor(scope, isSeries, match), match);
                return true;
            }

            var season = SeerrSeason.Match(path);
            if (season.Success && root is JsonObject seasonRoot)
            {
                var match = Match(scope, true, season.Groups[1].Value, null, null);
                if (match == null) return false;
                RedactSeasonDetail(scope, seasonRoot, BuildPolicy(scope, true), SeerrKeys, ParseNumber(season.Groups[2].Value), ProgressFor(scope, true, match));
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
                var policy = BuildPolicy(scope, isSeries);
                // Top Rated sorts on the client, where a missing score would sink the title.
                if (policy.Ratings && item[SeerrKeys.VoteAverage] is { } score) item["jeSortRating"] = score.DeepClone();
                RedactTitleFields(item, policy, SeerrKeys);
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
                RedactDetail(scope, root, BuildPolicy(scope, isSeries), TmdbKeys, isSeries, ProgressFor(scope, isSeries, match), match);
                return true;
            }

            var season = TmdbSeason.Match(path);
            if (season.Success)
            {
                var match = Match(scope, true, season.Groups[1].Value, null, null);
                if (match == null) return false;
                RedactSeasonDetail(scope, root, BuildPolicy(scope, true), TmdbKeys, ParseNumber(season.Groups[2].Value), ProgressFor(scope, true, match));
                return true;
            }

            var episode = TmdbEpisode.Match(path);
            if (episode.Success)
            {
                var match = Match(scope, true, episode.Groups[1].Value, null, null);
                if (match == null) return false;
                return RedactUnplayedEpisode(scope, root, BuildPolicy(scope, true), TmdbKeys, ProgressFor(scope, true, match));
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

        private SeriesProgress ProgressFor(GuardScope scope, bool isSeries, GuardMatch match)
            => isSeries ? LoadProgress(scope, match.ItemIds) : new SeriesProgress();

        // Applies a series' policy to one outside episode, identified by its own TMDB id,
        // unless that episode is one this caller has played.
        private bool RedactUnplayedEpisode(GuardScope scope, JsonObject episode, Policy policy, Dialect keys, SeriesProgress progress)
        {
            var id = Scalar(episode["id"]);
            var library = progress.Find(id == null ? null : "tmdb:" + id);
            if (library != null && progress.Played.Contains(library.Id)) return false;
            var reveal = library == null ? SpoilerFieldStripFilter.CategoryReveal.None : EpisodeReveal(scope, library);
            RedactEpisode(episode, policy, keys, reveal);
            return true;
        }

        private void RedactDetail(
            GuardScope scope,
            JsonObject detail,
            Policy policy,
            Dialect keys,
            bool isSeries,
            SeriesProgress progress,
            GuardMatch match)
        {
            RedactTitleFields(detail, policy, keys);
            detail["jeSpoilerGuard"] = true;
            if (match.Inherited) detail["jeSpoilerGuardInherited"] = true;
            if (match.ItemIds.Count > 0)
            {
                // Follow-ups echo these, and the Seerr toggle switches the guard off through them.
                var items = new JsonArray();
                foreach (var id in match.ItemIds) items.Add(id.ToString("N"));
                detail["jeSpoilerGuardItems"] = items;
            }

            if (policy.Taglines) detail.Remove("tagline");
            if (policy.Tags) RedactKeywords(detail);

            if (policy.Auxiliary)
            {
                detail.Remove(keys.Videos);
            }

            // A date opt-out keeps these two, because the date chip reads them, without
            // their text. They are episodes, so episode policy applies, not the series'.
            foreach (var key in new[] { keys.LastEpisode, keys.NextEpisode })
            {
                if (detail[key] is not JsonObject episode) continue;
                if (RedactUnplayedEpisode(scope, episode, policy, keys, progress) && policy.Dates) detail.Remove(key);
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
        private static void RemoveDateKeepingYear(JsonObject node, string key)
        {
            if (Scalar(node[key]) is { Length: >= 4 } date) node["jeYear"] = date.Substring(0, 4);
            node.Remove(key);
        }

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
            if (policy.CastAll)
            {
                detail.Remove("createdBy");
                detail.Remove("created_by");
            }

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
        // started, as in StripItem's Season arm. That's matched on the season's own ids,
        // because the same number can be a different season elsewhere. A season's own
        // response also has its TVDB id, which is all some libraries hold, so it can come
        // back whole when the list on the title's details can't say.
        private static void RedactSeason(JsonObject season, Policy policy, Dialect keys, int number, SeriesProgress progress)
        {
            if (number <= 1) return;
            if (!HasForeignIds(season))
            {
                if (Scalar(season["id"]) is { } id && progress.StartedSeasons.Contains("tmdb:" + id)) return;
                if (Scalar((season["externalIds"] as JsonObject)?["tvdbId"]) is { } tvdb && progress.StartedSeasons.Contains("tvdb:" + tvdb)) return;
            }

            if (policy.SeasonOverview) season.Remove("overview");
            if (policy.ReplaceTitle) season["name"] = $"Season {number}";
            if (policy.Dates) RemoveDateKeepingYear(season, keys.AirDate);
            season.Remove(keys.Poster);
        }

        // Seerr's TVDB mode fills these fields differently: a season's id is a TVDB id or the
        // series', externalIds holds the series', and its episodes have TVDB ids, so none of
        // them can be read as that item's own id. It gives seasons a bare number or no name
        // at all, which is how to tell. They have only a date to keep, and the year stays.
        private static bool HasForeignIds(JsonObject season)
            => Scalar(season["name"]) is { } name && (name.Length == 0 || int.TryParse(name, out _));

        private void RedactSeasonDetail(GuardScope scope, JsonObject season, Policy policy, Dialect keys, int number, SeriesProgress progress)
        {
            // Read first: this season's name is about to change.
            var episodeProgress = HasForeignIds(season) ? new SeriesProgress() : progress;
            RedactSeason(season, policy, keys, number, progress);
            if (season["episodes"] is not JsonArray episodes) return;
            foreach (var episode in episodes)
            {
                if (episode is JsonObject item) RedactUnplayedEpisode(scope, item, policy, keys, episodeProgress);
            }
        }

        private static void RedactEpisode(JsonObject episode, Policy policy, Dialect keys, SpoilerFieldStripFilter.CategoryReveal reveal)
        {
            if (policy.ReplaceTitle && !reveal.Title)
            {
                var number = Scalar(episode[keys.EpisodeNumber]);
                if (number != null) episode["name"] = $"Episode {number}";
                else episode.Remove("name");
            }

            if (policy.SeasonOverview && !reveal.Overview) episode.Remove("overview");
            if (policy.Dates) RemoveDateKeepingYear(episode, keys.AirDate);
            if (policy.Ratings && !reveal.Ratings)
            {
                episode.Remove(keys.VoteAverage);
                episode.Remove(keys.VoteCount);
            }

            // As in ApplyStripping: the cast setting decides who is listed, and title or
            // description protection only clears the names of the characters they play.
            var titleBearing = (policy.ReplaceTitle && !reveal.Title) || (policy.SeasonOverview && !reveal.Overview);
            if (policy.Cast)
            {
                episode.Remove(keys.GuestStars);
            }
            else if (titleBearing && episode[keys.GuestStars] is JsonArray guests)
            {
                foreach (var guest in guests)
                {
                    (guest as JsonObject)?.Remove("character");
                }
            }

            if (policy.CastAll) episode.Remove("crew");
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
