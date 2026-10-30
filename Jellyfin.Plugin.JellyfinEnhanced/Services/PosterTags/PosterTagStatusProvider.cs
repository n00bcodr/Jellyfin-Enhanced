using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

/// <summary>Shares TMDB caches with the web; parent aggregates are resolved as the image's viewer and spoiler-stripped.</summary>
public sealed class PosterTagStatusProvider
{
    private readonly StatusTagsTrendingService _trending;
    private readonly StatusTagsSeriesService _series;
    private readonly PosterTagDataProvider _data;
    private readonly ILibraryManager _library;

    public PosterTagStatusProvider(StatusTagsTrendingService trending, StatusTagsSeriesService series, PosterTagDataProvider data, ILibraryManager library)
    {
        _trending = trending;
        _series = series;
        _data = data;
        _library = library;
    }

    /// <summary>Resolve only the live sources this user's enabled status families can consume.</summary>
    public async Task<PosterStatusContext> GetAsync(HttpContext http, BaseItem item, JUser user, TagCacheEntry entry, PosterTagSettings settings, CancellationToken cancellationToken)
    {
        var config = JellyfinEnhanced.Instance!.Configuration;
        int? rank = null;
        if (settings.StatusTrending && entry.Type is "Movie" or "Series" && entry.TmdbId != null)
        {
            var list = await _trending.GetNativeAsync(config, cancellationToken).ConfigureAwait(false);
            var ranks = entry.Type == "Movie" ? list.Movies : list.Series;
            if (ranks.TryGetValue(entry.TmdbId, out var found)) rank = found;
        }

        var tmdb = entry.Type == "Series" ? entry.TmdbId : entry.SeriesTmdbId;
        var needsSchedule = settings.StatusRemoteEnabled && tmdb is { Length: > 0 and <= 9 } && tmdb.All(char.IsAsciiDigit) && (entry.Type == "Series"
            ? settings.StatusSchedule || settings.StatusMilestones || settings.StatusSeriesStatus
            : entry.Type is "Season" or "Episode" && settings.StatusMilestones);
        SeriesSchedule? schedule = null;
        TagCacheEntry? parent = null;
        if (needsSchedule)
        {
            var schedules = await _series.GetAsync(config.TMDB_API_KEY, new Dictionary<string, string> { ["series"] = tmdb! }, cancellationToken).ConfigureAwait(false);
            schedules.TryGetValue("series", out schedule);
            if (entry.Type == "Series") parent = entry;
            else if (schedule?.Status is "Ended" or "Canceled" && Guid.TryParse(entry.SeriesId, out var seriesId)
                && _library.GetItemById<BaseItem>(seriesId, user) is { } seriesItem)
            {
                parent = (await _data.GetRenderDataAsync(http, seriesItem, user, null, cancellationToken, includeStatus: true).ConfigureAwait(false))?.Entry;
            }
        }

        // A stable five-minute instant keeps equal requests in the composite cache.
        var now = DateTimeOffset.UtcNow;
        return new PosterStatusContext(DateTimeOffset.FromUnixTimeSeconds(now.ToUnixTimeSeconds() / 300 * 300), schedule, rank, parent);
    }
}
