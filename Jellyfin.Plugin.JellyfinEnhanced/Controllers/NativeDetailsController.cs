#if JF12
using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Where a title opens (native details for titles that aren't in the library, Jellyfin 12 web):
    /// the library copy the caller can open when there is one (the title, or the season or episode
    /// asked for), otherwise the synthetic page id of the native details page. Every entry point that
    /// knows a title only by provider key (requests, notifications, calendar) asks here first, so a
    /// title is never opened as absent while the caller can open a copy, and never as a copy the
    /// caller can't see. The page itself applies its viewer rules when it loads.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class NativeDetailsController : ControllerBase
    {
        private readonly ArrStatusService _status;
        private readonly IServerApplicationHost _host;
        private readonly TitleAliases _aliases;
        private readonly TmdbResponseCache _tmdb;

        /// <summary>Creates the controller.</summary>
        public NativeDetailsController(ArrStatusService status, IServerApplicationHost host, TitleAliases aliases, TmdbResponseCache tmdb)
        {
            _status = status;
            _host = host;
            _aliases = aliases;
            _tmdb = tmdb;
        }

        /// <summary>
        /// Resolves a title (by <paramref name="key"/> such as <c>movie:tmdb:603</c> or <c>tv:tvdb:81189</c>,
        /// optionally with <paramref name="season"/>/<paramref name="episode"/>; or by a synthetic page
        /// <paramref name="id"/>) to <c>{ itemId }</c>, a library item the caller can open, or
        /// <c>{ id }</c>, the native details page. 404 when the title can't be named by TMDB; 403 for API
        /// keys and when native details are off.
        /// </summary>
        [HttpGet("native-details/resolve")]
        [Authorize]
        public async Task<IActionResult> Resolve([FromQuery] string? key, [FromQuery] string? id, [FromQuery] int? season, [FromQuery] int? episode, CancellationToken ct)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            if (!NativeDetailsPolicy.FeatureEnabled(JellyfinEnhanced.Instance?.Configuration)) return StatusCode(403, new { code = "feature_disabled" });
            if (ArrCaller.Human(User, _status.View) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            var serverId = _host.SystemId;
            TitleKey? title;
            int? tmdb = null;
            if (!string.IsNullOrWhiteSpace(id))
            {
                if (!SyntheticId.TryParse(id, serverId, out var page) || page.Kind == SyntheticKind.Person) return BadRequest(new { code = "invalid_id" });
                title = TitleKey.Parse((page.IsMovie ? "movie" : "tv") + ":tmdb:" + page.TmdbId.ToString(CultureInfo.InvariantCulture));
                tmdb = page.TmdbId;
                season = page.Kind is SyntheticKind.Season or SyntheticKind.Episode ? page.Season : null;
                episode = page.Kind == SyntheticKind.Episode ? page.Episode : null;
            }
            else
            {
                title = TitleKey.Parse(key);
                if (title == null) return BadRequest(new { code = "invalid_key" });
                season ??= title.Season;
                episode ??= title.Episode;
                title = title.Title;
            }

            if (title == null) return BadRequest(new { code = "invalid_key" });
            if (season is < 0 or > 0xffff || episode is < 0 or > 0xffff || (episode != null && season == null) || (title.IsMovie && season != null))
            {
                return BadRequest(new { code = "invalid_scope" });
            }

            // A copy the caller can open wins: the scope asked for when it is there, else the title. An
            // episode counts only with a file: a missing (virtual) episode the library lists is not a copy,
            // as for the arrival hand-off, so it opens the native page with its Get it / Search instead.
            var copies = _status.CopiesOf(title, viewer).Display;
            if (copies.FirstOrDefault(x => x.Visible) is { } shown)
            {
                if (season is int s)
                {
                    var scopeKey = episode is int e ? title.WithEpisode(s, e) : title.WithSeason(s);
                    if (_status.ScopeItem(viewer, scopeKey) is { } scope && !(episode != null && scope.Virtual)) return Ok(new { itemId = scope.ItemId.ToString("N", CultureInfo.InvariantCulture) });
                }
                else
                {
                    return Ok(new { itemId = shown.ItemId.ToString("N", CultureInfo.InvariantCulture) });
                }
            }

            tmdb ??= title.Provider == "tmdb" ? title.NumericId : null;
            tmdb ??= _aliases.Of(title).FirstOrDefault(k => k.Provider == "tmdb" && k.IsMovie == title.IsMovie)?.NumericId;
            tmdb ??= await TmdbOfAsync(title, ct).ConfigureAwait(false);
            if (tmdb is not int t || t <= 0) return NotFound(new { code = "not_found" });
            var synthetic = title.IsMovie ? SyntheticId.Movie(t)
                : season is int sn && episode is int en ? SyntheticId.EpisodeOf(t, sn, en)
                : season is int only ? SyntheticId.SeasonOf(t, only)
                : SyntheticId.Series(t);
            return Ok(new { id = synthetic.Format(serverId) });
        }

        /// <summary>The TMDB id of a title known by another provider (TMDB's find, with JE's TMDB key), or null.</summary>
        private async Task<int?> TmdbOfAsync(TitleKey title, CancellationToken ct)
        {
            var apiKey = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            var source = title.Provider switch { "tvdb" => "tvdb_id", "imdb" => "imdb_id", _ => null };
            if (source == null || string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(title.Id)) return null;
            if (title.Provider == "tvdb" && title.NumericId == null) return null;
            if (title.Provider == "imdb" && !System.Text.RegularExpressions.Regex.IsMatch(title.Id, "^tt[0-9]{1,10}$")) return null;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(8));
                var response = await _tmdb.GetAsync("find/" + Uri.EscapeDataString(title.Id), "?external_source=" + source, apiKey, timeout.Token).ConfigureAwait(false);
                if (!response.IsSuccess) return null;
                using var doc = JsonDocument.Parse(response.Content);
                var list = title.IsMovie ? "movie_results" : "tv_results";
                if (!doc.RootElement.TryGetProperty(list, out var results) || results.ValueKind != JsonValueKind.Array) return null;
                foreach (var r in results.EnumerateArray())
                {
                    if (r.TryGetProperty("id", out var idEl) && idEl.TryGetInt32(out var found) && found > 0) return found;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                return null;
            }

            return null;
        }
    }
}
#endif
