using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Fills in Jellyfin's own CommunityRating/CriticRating fields from
    /// whatever MDBList data MdblistRatingsFetchTask has already cached. Makes
    /// no network calls of its own; writes via UpdateToRepositoryAsync rather
    /// than Jellyfin's UpdateItem REST endpoint (avoids the Trickplay
    /// deserialization bug that endpoint has), so it's cheap enough to
    /// schedule as often as you'd like, independent of the Fetch task.
    ///
    /// By default only ever FILLS a missing rating; an existing
    /// CommunityRating or CriticRating (from TMDB/OMDb/a manual edit) is left
    /// alone. PluginConfiguration.MdblistRatingsOverwriteExisting flips this:
    /// when on, every item is reconsidered every run and its rating is always
    /// set to MDBList's current cached value. An item whose MDBList data was
    /// never fetched, or is missing that specific source, is simply skipped
    /// until the Fetch task populates it.
    /// </summary>
    public class MdblistRatingsSyncTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly MdblistService _mdblistService;
        private readonly Logger _logger;

        public MdblistRatingsSyncTask(
            ILibraryManager libraryManager,
            MdblistService mdblistService,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _mdblistService = mdblistService;
            _logger = logger;
        }

        public string Name => "Sync Ratings from MDBList to Jellyfin";

        public string Key => "JellyfinEnhancedMdblistRatingsSync";

        public string Description =>
            "Sets Community/Critic Ratings on movies and series from already-cached MDBList data (see the Fetch task above).\n\n" +
            "• Fills empty ratings only, by default; turn on \"Overwrite Existing Ratings\" (config page) to always match MDBList's current cached value instead.\n" +
            "• An item whose MDBList data hasn't been fetched yet (or lacks that specific source) is skipped, not treated as an error.\n" +
            "• Configure the trigger below to run this periodically so newly fetched items get synced automatically.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default triggers - run on demand only
            return Array.Empty<TaskTriggerInfo>();
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.MdblistRatingsEnabled || !config.MdblistRatingsAutoSyncEnabled)
            {
                _logger.Info("MDBList Ratings Sync is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            _logger.Info("Starting MDBList Ratings Sync task");
            progress?.Report(0);

            var allItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true,
            }).ToList();

            _logger.Info($"Found {allItems.Count} movies/series in Jellyfin library");

            var overwrite = config.MdblistRatingsOverwriteExisting;

            var candidates = new List<(BaseItem Item, string MediaType, string TmdbId, bool NeedCommunity, bool NeedCritic)>();
            foreach (var item in allItems)
            {
                var needCommunity = overwrite || item.CommunityRating == null;
                var needCritic = overwrite || item.CriticRating == null;
                if (!needCommunity && !needCritic) continue;

                string? mediaType = item switch
                {
                    Movie => "movie",
                    Series => "tv",
                    _ => null,
                };
                if (mediaType == null) continue;

                var tmdbId = item.GetProviderId(MetadataProvider.Tmdb);
                if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit)) continue;

                candidates.Add((item, mediaType, tmdbId, needCommunity, needCritic));
            }

            _logger.Info($"MDBList Ratings Sync: {candidates.Count} of {allItems.Count} items are candidates for a rating sync.");

            var updatedCount = 0;
            var checkedCount = 0;
            var noCacheCount = 0;
            var noSourceDataCount = 0;
            var totalCandidates = candidates.Count;

            foreach (var candidate in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                checkedCount++;

                var entry = _mdblistService.GetCachedEntry(candidate.MediaType, candidate.TmdbId);
                if (entry == null || !entry.Found)
                {
                    // Never fetched yet, or MDBList confirmed no match; nothing
                    // to sync from. Not an error, the Fetch task will populate
                    // this on its own schedule.
                    noCacheCount++;
                }
                else
                {
                    var modified = false;

                    if (candidate.NeedCommunity)
                    {
                        var communityRating = MdblistService.GetCommunityRating(entry);
                        if (communityRating.HasValue && (float)communityRating.Value != candidate.Item.CommunityRating)
                        {
                            candidate.Item.CommunityRating = (float)communityRating.Value;
                            modified = true;
                        }
                    }

                    if (candidate.NeedCritic)
                    {
                        var criticRating = MdblistService.GetCriticRating(entry);
                        if (criticRating.HasValue && (float)criticRating.Value != candidate.Item.CriticRating)
                        {
                            candidate.Item.CriticRating = (float)criticRating.Value;
                            modified = true;
                        }
                    }

                    if (modified)
                    {
                        await candidate.Item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken).ConfigureAwait(false);
                        updatedCount++;
                    }
                    else
                    {
                        // Cached, but MDBList simply doesn't have the specific
                        // source (tmdb/tomatoes) this candidate still needs.
                        noSourceDataCount++;
                    }
                }

                if (totalCandidates > 0)
                {
                    progress?.Report((double)checkedCount / totalCandidates * 100);
                }
            }

            _logger.Info($"MDBList Ratings Sync complete: checked {checkedCount} candidates, updated {updatedCount} Jellyfin ratings ({noCacheCount} not yet fetched, {noSourceDataCount} cached but missing the needed source).");
            progress?.Report(100);
        }
    }
}
