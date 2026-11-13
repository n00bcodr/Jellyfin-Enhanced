using System;
using Jellyfin.Data.Enums;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    /// <summary>Awards projection shared by cache builds, fallback DTOs and native data reads.</summary>
    public partial class TagCacheService
    {
        private readonly AwardTagsService? _awardTagsService;

        /// <summary>Only exact Movie/Series works receive awards; never inherit wins onto episodes.</summary>
        public TagAwards? GetAwards(BaseItem item)
        {
            if (item is not (Movie or Series)) return null;
            var id = item.ProviderIds?.TryGetValue("Tmdb", out var tmdb) == true ? tmdb : null;
            return id == null ? null : _awardTagsService?.GetCached(item is Series ? "tv" : "movie", id, JellyfinEnhanced.Instance?.Configuration);
        }

        /// <summary>On-demand or scheduled daily refresh; the shared cache publication uses the normal mutation boundary.</summary>
        public async Task RefreshAwardsAsync(IProgress<double> progress, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_awardTagsService == null || config?.AwardsTagsEnabled != true) { progress.Report(100); return; }
            var titles = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                Recursive = true,
                IsVirtualItem = false,
            }).Select(item => (Type: item is Series ? "tv" : "movie", Id: item.GetProviderId(MetadataProvider.Tmdb)))
                .Where(title => !string.IsNullOrWhiteSpace(title.Id)).Select(title => (title.Type, title.Id!)).ToArray();
            await _awardTagsService.RefreshAsync(titles, config, progress, token).ConfigureAwait(false);
            await _rebuildLock.WaitAsync(token).ConfigureAwait(false);
            try
            {
                PublishAwards();
            }
            finally { _rebuildLock.Release(); }
        }

        private int _awardsFirstRefreshQueued;

        /// <summary>
        /// Fetch the Awards facts in the background when Awards is on and nothing has been fetched yet under the current
        /// configuration (it was just turned on, or its providers changed, or this is the first start with it on), instead of
        /// leaving every tag missing until the nightly task. Does nothing when facts already exist or a run is queued.
        /// </summary>
        internal void QueueAwardsFirstRefresh()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (_awardTagsService == null || config?.AwardsTagsEnabled != true || _awardTagsService.HasFacts(config)) return;
            if (Interlocked.Exchange(ref _awardsFirstRefreshQueued, 1) == 1) return;
            _ = Task.Run(async () =>
            {
                try { await RefreshAwardsAsync(new Progress<double>(), CancellationToken.None).ConfigureAwait(false); }
                catch (Exception ex) { _logger.Warning($"[AwardTags] The first refresh failed: {ex.Message}. The daily task will retry."); }
                finally { Interlocked.Exchange(ref _awardsFirstRefreshQueued, 0); }
            });
        }

        /// <summary>Republish cached facts after configuration changes, without provider calls.</summary>
        internal void RefreshAwardAvailability()
        {
            _rebuildLock.Wait();
            try { PublishAwards(); }
            finally { _rebuildLock.Release(); }
        }

        private void PublishAwards()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            using var writes = BeginInPlaceWrites();
            var changed = false;
            foreach (var pair in _cache)
            {
                var entry = pair.Value;
                var facts = entry.Type is "Movie" or "Series" && entry.TmdbId != null
                    ? _awardTagsService?.GetCached(entry.Type == "Movie" ? "movie" : "tv", entry.TmdbId, config) : null;
                if (facts == entry.Awards) continue;
                var copy = entry.Clone();
                copy.Awards = facts;
                copy.LastUpdated = NextStamp();
                RaiseMaxLastUpdated(copy.LastUpdated);
                StoreEntry(pair.Key, copy);
                changed = true;
            }
            if (changed)
            {
                // Changed entries reach clients as a delta (their LastUpdated); only removals and rebuild swaps change the version.
                TouchLastModified();
                ScheduleDebouncedSave();
            }
        }
    }
}
