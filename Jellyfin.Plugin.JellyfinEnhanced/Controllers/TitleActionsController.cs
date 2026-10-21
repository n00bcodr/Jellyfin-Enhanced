using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers;

/// <summary>Fresh, viewer-owned admission for provider action menus and shared links on both hosts.</summary>
[ApiController]
[Route("JellyfinEnhanced/title-actions")]
public sealed class TitleActionsController : ControllerBase
{
    private readonly NativeDetailsFeeds _feeds;
    private readonly NativeDetailsPolicy _policy;
    private readonly IUserManager _users;
    private readonly ArrStatusService? _status;

    /// <summary>Creates the action admission boundary from the existing title policy and projection owners.</summary>
    public TitleActionsController(NativeDetailsFeeds feeds, NativeDetailsPolicy policy, IUserManager users, ArrStatusService? status = null)
    {
        _feeds = feeds;
        _policy = policy;
        _users = users;
        _status = status;
    }

    /// <summary>
    /// Admits a stable TMDB key and exact child scope under the receiving viewer's current access.
    /// Contains no sender identity, artwork, title text or saved state. Action writes still use their
    /// existing authorized endpoints. Rechecks the live caller and scoped policy after metadata awaits.
    /// </summary>
    [HttpGet("{type}/{tmdbId}")]
    [Authorize]
    public async Task<IActionResult> Read(string type, int tmdbId, [FromQuery] int? season = null,
        [FromQuery] int? episode = null, CancellationToken ct = default)
    {
        Response.Headers["Cache-Control"] = "private, no-store";
        if (!NativeDetailsPolicy.PublicDetailsEnabled(JellyfinEnhanced.Instance?.Configuration))
            return StatusCode(403, new { code = "feature_disabled" });
        if (type is not ("movie" or "tv") || tmdbId <= 0 || season is < 0 or > 65535 ||
            episode is < 0 or > 65535 || (episode != null && season == null) || (type == "movie" && season != null))
            return BadRequest(new { code = "invalid_scope" });
        if (ArrCaller.Human(User, _users) is not { } viewer) return StatusCode(403, new { code = "user_required" });
        var title = type == "movie" ? SyntheticId.Movie(tmdbId) : episode is int e && season is int s
            ? SyntheticId.EpisodeOf(tmdbId, s, e) : season is int sn ? SyntheticId.SeasonOf(tmdbId, sn) : SyntheticId.Series(tmdbId);
        var key = TitleKey.Parse(type + ":tmdb:" + tmdbId.ToString(CultureInfo.InvariantCulture))!;
        // An accessible real copy uses native authorization even when the person has no Seerr account.
        if (ActualCopy(viewer, key, season, episode) is { } existing)
            return Ok(new { allowed = true, itemId = existing.ToString("N", CultureInfo.InvariantCulture) });
        var answer = season is int n
            ? await _feeds.SeasonAsync(viewer, tmdbId, n, ct).ConfigureAwait(false)
            : await _feeds.TitleAsync(viewer, type == "movie", tmdbId, ct).ConfigureAwait(false);
        if (answer.Outcome != FeedOutcome.Ok)
            return StatusCode(answer.Outcome == FeedOutcome.Refused || answer.Outcome == FeedOutcome.NotFound ? 404 : 503, new { code = "unavailable" });
        if (episode is int requested)
        {
            using var document = JsonDocument.Parse(answer.Json ?? "{}");
            var found = false;
            if (document.RootElement.TryGetProperty("episodes", out var episodes) && episodes.ValueKind == JsonValueKind.Array)
                foreach (var row in episodes.EnumerateArray())
                    if (row.TryGetProperty("episodeNumber", out var number) && number.TryGetInt32(out var value) && value == requested) found = true;
            if (!found) return NotFound(new { code = "not_found" });
        }
        // User objects and permissions can be replaced during an upstream await. Never publish the old view.
        if (ArrCaller.Human(User, _users) is not { } live || live.Id != viewer.Id)
            return StatusCode(403, new { code = "user_required" });
        if (await _policy.SeeDetailsAsync(live, title, ct).ConfigureAwait(false) != NativeDetailsPolicy.Access.Allowed)
            return NotFound(new { code = "not_found" });
        if (!NativeDetailsPolicy.PublicDetailsEnabled(JellyfinEnhanced.Instance?.Configuration) ||
            ArrCaller.Human(User, _users) is not { } final || final.Id != live.Id)
            return StatusCode(403, new { code = "feature_disabled" });
        var itemId = ActualCopy(final, key, season, episode);
        return Ok(new { allowed = true, itemId = itemId?.ToString("N", CultureInfo.InvariantCulture) });
    }

    /// <summary>Delegates real-copy and exact scope classification to the existing copy/source owner.</summary>
    private Guid? ActualCopy(Jellyfin.Database.Implementations.Entities.User viewer, TitleKey key, int? season, int? episode)
    {
        if (_status == null || _status.View.Viewer(viewer.Id) is not { } statusViewer) return null;
        if (season is int requestedSeason)
        {
            var scope = episode is int requestedEpisode ? key.WithEpisode(requestedSeason, requestedEpisode) : key.WithSeason(requestedSeason);
            return _status.ScopeItem(statusViewer, scope) is { } copy && !(episode != null && copy.Virtual) ? copy.ItemId : null;
        }
        return _status.CopiesOf(key, statusViewer).SeenOpenable?.ItemId;
    }

}
