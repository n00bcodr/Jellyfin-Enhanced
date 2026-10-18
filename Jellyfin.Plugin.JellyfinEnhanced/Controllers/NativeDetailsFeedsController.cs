using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The title lists of the pages a not-in-library title links to (native details, Jellyfin 12 web):
    /// a person's filmography and the genre, studio and network discovery feeds. Answered for the
    /// caller only (no other user's view), filtered server-side for them (see <see cref="NativeDetailsFeeds"/>),
    /// and never kept by the browser's or a proxy's cache.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class NativeDetailsFeedsController : ControllerBase
    {
        private readonly NativeDetailsFeeds _feeds;
        private readonly IUserManager _users;

        /// <summary>Creates the controller.</summary>
        /// <param name="feeds">The feeds.</param>
        /// <param name="users">User manager.</param>
        public NativeDetailsFeedsController(NativeDetailsFeeds feeds, IUserManager users)
        {
            _feeds = feeds;
            _users = users;
        }

        /// <summary>
        /// A person's filmography (<c>{ results }</c> in Seerr's result shape): library copies the caller
        /// can open carry their Jellyfin id; titles the library hides from them are left out; absent
        /// titles are listed when their own page would open for them. 404 when refused or unknown, 503
        /// when the source can't answer, 504 <c>parental_pending</c> while parental checks still run,
        /// 429 <c>busy</c> when the list isn't cached and the caller has started too many upstream
        /// reads (or the server has too many queued) to start another now.
        /// </summary>
        /// <param name="tmdbId">TMDB person id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The filmography.</returns>
        [HttpGet("native-details/person/{tmdbId}/filmography")]
        [Authorize]
        public async Task<IActionResult> Filmography([FromRoute] int tmdbId, CancellationToken ct)
        {
            if (Caller(out var refusal) is not { } viewer) return refusal!;
            return Answer(await _feeds.FilmographyAsync(viewer, tmdbId, ct).ConfigureAwait(false));
        }

        /// <summary>
        /// One page of a discovery feed (<c>{ page, totalPages, results }</c>): <paramref name="type"/>
        /// <c>movie</c> by <c>genre</c>, <c>studio</c> or <c>keyword</c>, or <c>tv</c> by <c>genre</c>,
        /// <c>network</c>, <c>company</c> or <c>keyword</c>, filtered for the caller and admitted like
        /// <see cref="Filmography"/>.
        /// </summary>
        /// <param name="type">movie or tv.</param>
        /// <param name="source">genre, studio, network, company or keyword.</param>
        /// <param name="feedId">The TMDB genre, company, network or keyword id.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="sortBy">Sort (e.g. popularity.desc), or none.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The page.</returns>
        [HttpGet("native-details/discover/{type}/{source}/{feedId}")]
        [Authorize]
        public async Task<IActionResult> Discover([FromRoute] string type, [FromRoute] string source, [FromRoute] int feedId, [FromQuery] int page = 1, [FromQuery] string? sortBy = null, CancellationToken ct = default)
        {
            if (Caller(out var refusal) is not { } viewer) return refusal!;
            if (type is not ("movie" or "tv")) return BadRequest(new { code = "invalid_feed" });
            return Answer(await _feeds.DiscoverAsync(viewer, type == "movie", source, feedId, page, sortBy, ct).ConfigureAwait(false));
        }

        /// <summary>
        /// A movie's or series' public details for the extras of its native page (information panel,
        /// trailers, collection) and for Seerr's more-info window of a viewer without a Seerr account,
        /// without Seerr's per-account part, for any viewer the page opens for (no Seerr account needed).
        /// Answered while native pages are on or the request feature runs in Jellyfin Enhanced mode. 404
        /// when refused or unknown, 503 when the source can't answer.
        /// </summary>
        /// <param name="type">movie or tv.</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The details.</returns>
        [HttpGet("native-details/title/{type}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> Title([FromRoute] string type, [FromRoute] int tmdbId, CancellationToken ct)
        {
            if (Caller(out var refusal, details: true) is not { } viewer) return refusal!;
            if (type is not ("movie" or "tv")) return BadRequest(new { code = "invalid_feed" });
            return Answer(await _feeds.TitleAsync(viewer, type == "movie", tmdbId, ct).ConfigureAwait(false));
        }

        /// <summary>A title's ratings for its native page, under <see cref="Title"/>'s rule, admitted like <see cref="Filmography"/>; <c>null</c> when the title has none.</summary>
        /// <param name="type">movie or tv.</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The ratings.</returns>
        [HttpGet("native-details/title/{type}/{tmdbId}/ratings")]
        [Authorize]
        public async Task<IActionResult> Ratings([FromRoute] string type, [FromRoute] int tmdbId, CancellationToken ct)
        {
            if (Caller(out var refusal, details: true) is not { } viewer) return refusal!;
            if (type is not ("movie" or "tv")) return BadRequest(new { code = "invalid_feed" });
            return Answer(await _feeds.RatingsAsync(viewer, type == "movie", tmdbId, ct).ConfigureAwait(false));
        }

        /// <summary>Public season/episode metadata for the More Info host on either Jellyfin version.</summary>
        [HttpGet("native-details/title/tv/{tmdbId}/season/{season}")]
        [Authorize]
        public async Task<IActionResult> Season([FromRoute] int tmdbId, [FromRoute] int season, CancellationToken ct)
        {
            if (Caller(out var refusal, details: true) is not { } viewer) return refusal!;
            return Answer(await _feeds.SeasonAsync(viewer, tmdbId, season, ct).ConfigureAwait(false));
        }

        /// <summary>
        /// One page of a title's similar or recommended titles as the caller may see them (<c>{ page,
        /// totalPages, results }</c>, see <see cref="NativeDetailsFeeds.RelatedAsync"/>), for the rows under a
        /// title's page when the caller has no Seerr account; answered like <see cref="Title"/>, 429 and 504
        /// like <see cref="Filmography"/>.
        /// </summary>
        /// <param name="type">movie or tv.</param>
        /// <param name="tmdbId">The title's TMDB id.</param>
        /// <param name="relation">similar or recommendations.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The page.</returns>
        [HttpGet("native-details/title/{type}/{tmdbId}/related/{relation}")]
        [Authorize]
        public async Task<IActionResult> Related([FromRoute] string type, [FromRoute] int tmdbId, [FromRoute] string relation, [FromQuery] int page = 1, CancellationToken ct = default)
        {
            if (Caller(out var refusal, details: true) is not { } viewer) return refusal!;
            if (type is not ("movie" or "tv")) return BadRequest(new { code = "invalid_feed" });
            return Answer(await _feeds.RelatedAsync(viewer, type == "movie", tmdbId, relation, page, ct).ConfigureAwait(false));
        }

        /// <summary>
        /// A movie collection's public details and its movies as the caller may see them (<c>{ id, name,
        /// overview, posterPath, backdropPath, parts }</c>, see <see cref="NativeDetailsFeeds.CollectionAsync"/>),
        /// for the collection request of a viewer without a Seerr account; answered like <see cref="Title"/>.
        /// </summary>
        /// <param name="collectionId">TMDB collection id.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The collection.</returns>
        [HttpGet("native-details/collection/{collectionId}")]
        [Authorize]
        public async Task<IActionResult> Collection([FromRoute] int collectionId, CancellationToken ct)
        {
            if (Caller(out var refusal, details: true) is not { } viewer) return refusal!;
            return Answer(await _feeds.CollectionAsync(viewer, collectionId, ct).ConfigureAwait(false));
        }

        /// <summary>The TMDB keywords matching a tag (<c>{ results: [{ id, name }] }</c>), admitted like <see cref="Filmography"/>.</summary>
        /// <param name="query">The tag.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The keywords.</returns>
        [HttpGet("native-details/keywords")]
        [Authorize]
        public async Task<IActionResult> Keywords([FromQuery] string? query, CancellationToken ct)
        {
            if (Caller(out var refusal) is not { } viewer) return refusal!;
            return Answer(await _feeds.KeywordsAsync(viewer, query, ct).ConfigureAwait(false));
        }

        /// <summary>TMDB's movie or series genres (<c>[{ id, name }]</c>), under the viewer-level rule (no Seerr account needed).</summary>
        /// <param name="type">movie or tv.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>The genres.</returns>
        [HttpGet("native-details/genres/{type}")]
        [Authorize]
        public async Task<IActionResult> Genres([FromRoute] string type, CancellationToken ct)
        {
            if (Caller(out var refusal) is not { } viewer) return refusal!;
            if (type is not ("movie" or "tv")) return BadRequest(new { code = "invalid_feed" });
            return Answer(await _feeds.GenresAsync(viewer, type == "movie", ct).ConfigureAwait(false));
        }

        /// <summary>
        /// The caller (a real, enabled user; never an API key), or the refusal when the feature is off or there
        /// is none. A title's public details (<paramref name="details"/>) are on while <see
        /// cref="NativeDetailsPolicy.PublicDetailsEnabled"/> holds; everything else needs native pages.
        /// </summary>
        private Jellyfin.Database.Implementations.Entities.User? Caller(out IActionResult? refusal, bool details = false)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            refusal = null;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!(details ? NativeDetailsPolicy.PublicDetailsEnabled(config) : NativeDetailsPolicy.FeatureEnabled(config)))
            {
                refusal = StatusCode(403, new { code = "feature_disabled" });
                return null;
            }

            var viewer = ArrCaller.Human(User, _users);
            if (viewer == null) refusal = StatusCode(403, new { code = "user_required" });
            return viewer;
        }

        private IActionResult Answer(FeedAnswer answer)
        {
            switch (answer.Outcome)
            {
                case FeedOutcome.Ok:
                    return Content(answer.Json ?? "{}", "application/json");
                case FeedOutcome.Refused:
                case FeedOutcome.NotFound:
                    return NotFound(new { code = "not_found" });
                case FeedOutcome.Pending:
                    Response.Headers["Retry-After"] = "2";
                    return StatusCode(504, new { code = "parental_pending" });
                case FeedOutcome.Busy:
                    Response.Headers["Retry-After"] = "2";
                    return StatusCode(429, new { code = "busy" });
                case FeedOutcome.Invalid:
                    return BadRequest(new { code = "invalid_feed" });
                default:
                    return StatusCode(503, new { code = "unavailable" });
            }
        }
    }
}
