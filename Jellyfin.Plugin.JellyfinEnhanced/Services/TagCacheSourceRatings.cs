using System;
using System.Threading;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>MDBList enrichment, isolated from the media stream and status cache builders.</summary>
    public partial class TagCacheService
    {
        private readonly MdblistService? _mdblistService;

        /// <summary>Availability only; the configured key never enters client metadata or cache keys.</summary>
        internal static bool SourceRatingsConfigured => !string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration.MdblistApiKey);

        /// <summary>Drop stale source facts after a key is removed, without mutating shared metadata.</summary>
        internal static TagCacheEntry ApplySourceRatingAvailability(TagCacheEntry entry)
        {
            if (SourceRatingsConfigured || entry.Ratings == null) return entry;
            var copy = entry.Clone();
            copy.Ratings = null;
            return copy;
        }

        /// <summary>Publish a key-availability transition using existing MDBList data, without network I/O.</summary>
        internal void RefreshRatingSourceAvailability() => RefreshSourceRatings();

        /// <summary>Cache-only projection for batch DTOs, cache builds and native posters. Children use the series.</summary>
        public TagSourceRatings? GetSourceRatings(BaseItem item)
        {
            if (_mdblistService == null || string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration.MdblistApiKey)) return null;
            if (item is MediaBrowser.Controller.Entities.TV.Season or MediaBrowser.Controller.Entities.TV.Episode)
                item = GetParentSeries(item) ?? item;
            if (item is not (MediaBrowser.Controller.Entities.Movies.Movie or MediaBrowser.Controller.Entities.TV.Series)) return null;
            var id = item.ProviderIds?.TryGetValue("Tmdb", out var tmdb) == true ? tmdb : null;
            return id == null ? null : TagSourceRatings.FromMdblist(_mdblistService.GetCachedEntry(item is MediaBrowser.Controller.Entities.TV.Series ? "tv" : "movie", id));
        }

        /// <summary>Only named-source consumers may trigger upstream enrichment; legacy scores remain cache-only.</summary>
        private bool HasSourceRatingDemand()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !SourceRatingsConfigured) return false;
            static bool Named(string[]? sources) => RatingSourceSettings.NormalizeSources(sources)?.Any(id => id is not ("community" or "critic")) == true;
            if (config.RatingTagsEnabled && Named(config.RatingTagsSources)) return true;
            var users = new UserConfigurationManager(_applicationPaths, _logger);
            return users.GetAllUserIds().Any(id =>
            {
                var settings = users.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
                return settings.RatingTagsEnabled && Named(settings.RatingTagsSources);
            });
        }

        /// <summary>Warm only accessible request items, deduplicating children by series. Used without the bulk cache too.</summary>
        public void WarmSourceRatingsForItems(IEnumerable<BaseItem> items, CancellationToken cancellationToken)
        {
            if (_mdblistService == null || !HasSourceRatingDemand()) return;
            var titles = items.Select(item => item is MediaBrowser.Controller.Entities.TV.Season or MediaBrowser.Controller.Entities.TV.Episode ? GetParentSeries(item) ?? item : item)
                .Where(item => item is MediaBrowser.Controller.Entities.Movies.Movie or MediaBrowser.Controller.Entities.TV.Series)
                .Select(item => (MediaType: item is MediaBrowser.Controller.Entities.TV.Series ? "tv" : "movie",
                    Id: item.ProviderIds?.TryGetValue("Tmdb", out var id) == true ? id : null))
                .Where(title => title.Id != null && title.Id.Length > 0 && title.Id.All(char.IsAsciiDigit))
                .Select(title => (title.MediaType, Id: title.Id!)).Distinct().ToArray();
            _mdblistService.WarmTagRatingsAsync(titles, cancellationToken, JellyfinEnhanced.Instance!.Configuration.MdblistFetchReserve).GetAwaiter().GetResult();
        }

        /// <summary>Reuse MDBList's bounded batches, seven-day TTL, pacing and quota reserve before a build.</summary>
        private void WarmSourceRatings(CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_mdblistService == null || config == null || !HasSourceRatingDemand()) return;
            MdblistRatingsFetchRunner.RunAsync(_libraryManager, _mdblistService, _logger,
                Math.Max(MdblistService.SafetyMargin, config.MdblistFetchReserve), null, cancellationToken).GetAwaiter().GetResult();
        }

        /// <summary>Publish changed source facts even when the library metadata itself has not changed.</summary>
        private void RefreshSourceRatings()
        {
            var changed = false;
            foreach (var pair in _cache)
            {
                var entry = pair.Value;
                var id = entry.Type is "Season" or "Episode" ? entry.SeriesTmdbId : entry.TmdbId;
                var ratings = entry.Type is not ("Movie" or "Series" or "Season" or "Episode")
                    || !SourceRatingsConfigured || id == null || _mdblistService == null
                    ? null : TagSourceRatings.FromMdblist(_mdblistService.GetCachedEntry(entry.Type == "Movie" ? "movie" : "tv", id));
                if (ratings == entry.Ratings) continue;
                var updated = entry.Clone();
                updated.Ratings = ratings;
                updated.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                RaiseMaxLastUpdated(updated.LastUpdated);
                StoreEntry(pair.Key, updated);
                changed = true;
            }
            if (!changed) return;
            Interlocked.Increment(ref _version);
            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            ScheduleDebouncedSave();
        }
    }
}
