using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Keeps mdblist-ratings.json warm: batch-fetches MDBList data for any
    /// movie/series whose cached entry is missing or stale and saves it,
    /// without touching Jellyfin's own CommunityRating/CriticRating fields.
    /// See MdblistRatingsSyncTask for that half. Safe to schedule frequently,
    /// since an already-fresh title costs nothing on a re-run (see
    /// MdblistService.NeedsFetch).
    ///
    /// Stops for the day once the account's LIVE remaining MDBList quota
    /// (from MDBList's own GET /user endpoint) drops to MdblistFetchReserve,
    /// reserving the rest for live item-details page lookups.
    /// </summary>
    public class MdblistRatingsFetchTask : IScheduledTask
    {
        private readonly ILibraryManager _libraryManager;
        private readonly MdblistService _mdblistService;
        private readonly Logger _logger;

        public MdblistRatingsFetchTask(
            ILibraryManager libraryManager,
            MdblistService mdblistService,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _mdblistService = mdblistService;
            _logger = logger;
        }

        public string Name => "Fetch Ratings from MDBList";

        public string Key => "JellyfinEnhancedMdblistRatingsFetch";

        public string Description =>
            "Keeps MDBList ratings data fresh in the background for the item-details row and the sync task below.\n\n" +
            "• Looks up any movie/series whose cached MDBList data is missing or stale, and saves it; doesn't touch Jellyfin's own Community/Critic Rating fields.\n" +
            "• A found title stays cached for 7 days before being refetched (3 days for a confirmed \"no match\"); already-fresh titles are skipped entirely, so re-running this often, even daily, mostly costs nothing once the library's cache is warm.\n" +
            "• Stops once today's live remaining quota drops to the Fetch Task Reserve (config page), leaving that much for people browsing.\n" +
            "• Configure the trigger below to run this periodically so newly added items get picked up automatically.";

        public string Category => "Jellyfin Enhanced";

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            // No default triggers - run on demand only
            return Array.Empty<TaskTriggerInfo>();
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (config == null || !config.MdblistRatingsEnabled || !config.MdblistRatingsFetchEnabled)
            {
                _logger.Info("MDBList Ratings Fetch is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrWhiteSpace(config.MdblistApiKey))
            {
                _logger.Warning("MDBList Ratings Fetch is enabled but no MDBList API key is configured.");
                progress?.Report(100);
                return;
            }

            var reserve = config.MdblistFetchReserve > 0 ? config.MdblistFetchReserve : 400;
            await MdblistRatingsFetchRunner.RunAsync(
                _libraryManager, _mdblistService, _logger, reserve, progress, cancellationToken)
                .ConfigureAwait(false);
        }
    }
}
