using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;

/// <summary>Shares TMDB caches with the web; parent aggregates are resolved as the image's viewer and spoiler-stripped.</summary>
public sealed class PosterTagStatusProvider
{
    private readonly NativeStatusRefreshService _remote;
    private readonly PosterTagDataProvider _data;
    private readonly ILibraryManager _library;

    public PosterTagStatusProvider(NativeStatusRefreshService remote, PosterTagDataProvider data, ILibraryManager library)
    {
        _remote = remote;
        _data = data;
        _library = library;
    }

    /// <summary>Resolve only the live sources this user's enabled status families can consume.</summary>
    public async Task<PosterStatusContext> GetAsync(HttpContext http, BaseItem item, JUser user, TagCacheEntry entry, PosterTagSettings settings, CancellationToken cancellationToken, DateTimeOffset? statusInstant = null)
    {
        var config = JellyfinEnhanced.Instance!.Configuration;
        int? rank = null;
        var weekly = false;
        if (settings.StatusTrending && entry.Type is "Movie" or "Series" && entry.TmdbId != null)
        {
            var list = _remote.GetTrending(config);
            var ranks = entry.Type == "Movie" ? list.Movies : list.Series;
            if (ranks.TryGetValue(entry.TmdbId, out var found)) rank = found;
            // Seerr's weekly list reads "#N This Week", as on the web.
            weekly = list.Source == "seerr-week";
        }

        var tmdb = entry.Type == "Series" ? entry.TmdbId : entry.SeriesTmdbId;
        var needsSchedule = settings.StatusRemoteEnabled && tmdb is { Length: > 0 and <= 9 } && tmdb.All(char.IsAsciiDigit) && (entry.Type == "Series"
            ? settings.StatusSchedule || settings.StatusMilestones || settings.StatusSeriesStatus
            : entry.Type is "Season" or "Episode" && settings.StatusMilestones);
        SeriesSchedule? schedule = null;
        TagCacheEntry? parent = null;
        if (needsSchedule)
        {
            schedule = _remote.GetSeries(config, tmdb!);
            if (entry.Type == "Series") parent = entry;
            else if (schedule?.Status is "Ended" or "Canceled" && Guid.TryParse(entry.SeriesId, out var seriesId)
                && _library.GetItemById<BaseItem>(seriesId, user) is { } seriesItem)
            {
                parent = (await _data.GetRenderDataAsync(http, seriesItem, user, null, cancellationToken, includeStatus: true).ConfigureAwait(false))?.Entry;
            }
        }

        // A stable five-minute instant keeps equal requests in the composite cache.
        var now = statusInstant ?? DateTimeOffset.UtcNow;
        return new PosterStatusContext(DateTimeOffset.FromUnixTimeSeconds(now.ToUnixTimeSeconds() / 300 * 300), schedule, rank, parent, weekly);
    }
}
