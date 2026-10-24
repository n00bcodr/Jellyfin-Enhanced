using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Discover rows and the free-text search row for the JE request backend (titles not in the
    /// library yet, with Request / Notify me). Every route resolves a real person who may ask for
    /// titles (Members and up; Kids get only titles within their parental limits); in Seerr mode
    /// Seerr's own discovery and search stay and these routes answer 403 <c>feature_disabled</c>.
    /// </summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireDiscoverController : ControllerBase
    {
        private readonly DiscoverService _discover;

        /// <summary>Creates the controller.</summary>
        public AcquireDiscoverController(DiscoverService discover) { _discover = discover; }

        private IActionResult Reply(RequestOutcome outcome) { Response.Headers["Cache-Control"] = "private, no-store"; return StatusCode(outcome.HttpStatus, outcome); }

        /// <summary>The caller (or a refusal): a person, the JE backend on, and a role that may ask.</summary>
        private (StatusViewer? Viewer, RequestOutcome? Refusal, string Role) Gate()
        {
            var viewer = ArrCaller.Human(User, _discover.Requests.View);
            if (viewer == null) return (null, RequestOutcome.Refused("user_required"), string.Empty);
            if (!_discover.Enabled) return (null, RequestOutcome.Refused("feature_disabled"), string.Empty);
            var facts = _discover.Requests.Identity(viewer.UserId);
            if (facts.Refusal == "user_required") return (null, RequestOutcome.Refused("user_required"), string.Empty);
            if (facts.Role == "Watcher") return (null, RequestOutcome.Refused("requests_create_required"), facts.Role);
            return (viewer, null, facts.Role);
        }

        /// <summary>
        /// One page of a Discover row: trending, upcoming (Coming soon), popular, or because ("Because
        /// you watched …", groups for up to three titles the caller watched lately; type and page are
        /// not used).
        /// </summary>
        [Authorize]
        [HttpGet("acquire/discover")]
        public async Task<IActionResult> Discover([FromQuery] string? list = null, [FromQuery] string? type = null, [FromQuery] int page = 1, [FromQuery] string? language = null, CancellationToken ct = default)
        {
            var (viewer, refusal, _) = Gate();
            if (refusal != null) return Reply(refusal);
            var kind = string.IsNullOrEmpty(type) ? "movie" : type;
            if (list == null || !DiscoverService.Lists.Contains(list) || kind is not ("movie" or "tv") || page < 1 || page > DiscoverService.MaxPage)
                return Reply(RequestOutcome.Refused("invalid_input", 400));
            var answer = await _discover.DiscoverAsync(viewer!, list, kind, list == "because" ? 1 : page, language, ct).ConfigureAwait(false);
            return Send(viewer!, answer, "discover");
        }

        /// <summary>One page of free-text search over movies and series (no people); the query is at most 100 characters.</summary>
        [Authorize]
        [HttpGet("acquire/search")]
        public async Task<IActionResult> Search([FromQuery] string? q = null, [FromQuery] int page = 1, [FromQuery] string? language = null, CancellationToken ct = default)
        {
            var (viewer, refusal, role) = Gate();
            if (refusal != null) return Reply(refusal);
            if (role == "Kid" && _discover.Requests.Policy.Configuration.ArrKidsHideSearch) return Reply(RequestOutcome.Refused("search_hidden"));
            var query = (q ?? string.Empty).Trim();
            if (query.Length > DiscoverService.MaxQuery) return Reply(RequestOutcome.Refused("query_too_long", 400));
            if (query.Length == 0 || page < 1 || page > DiscoverService.MaxPage) return Reply(RequestOutcome.Refused("invalid_input", 400));
            var answer = await _discover.SearchAsync(viewer!, query, page, language, ct).ConfigureAwait(false);
            return Send(viewer!, answer, "search");
        }

        /// <summary>The answer as a private, ETag-checked body; 503 when TMDB couldn't answer.</summary>
        private IActionResult Send(StatusViewer viewer, DiscoverAnswer? answer, string reason)
        {
            if (answer == null) return Reply(RequestOutcome.Refused("discover_unavailable", 503, "unavailable"));
            answer = _discover.Present(viewer, answer);
            if (!answer.Complete)
            {
                Response.Headers["Cache-Control"] = "private, no-store";
                Response.Headers["Retry-After"] = answer.RetryAfterSeconds!.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                // As with complete pages, serialize this contract here: the controller's result filter
                // reserves error ObjectResults for model-binding refusals and would replace this body.
                return new ContentResult
                {
                    StatusCode = 503, ContentType = "application/json; charset=utf-8",
                    Content = JsonSerializer.Serialize(new { outcome = "partial", reason = "evidence_unavailable", certainty = "Unknown", message = "Some results couldn't be checked. Try again shortly.", answer }),
                };
            }
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason, certainty = "Succeeded", message = "Discover", answer });
            var etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(viewer.UserId.ToString("N") + "|").Concat(bytes).ToArray()), 0, 16) + "\"";
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag)) return StatusCode(304);
            return File(bytes, "application/json; charset=utf-8");
        }
    }
}
