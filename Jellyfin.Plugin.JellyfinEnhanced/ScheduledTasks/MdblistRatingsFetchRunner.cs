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
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    /// <summary>
    /// Core for MdblistRatingsFetchTask: keeps mdblist-ratings.json warm by
    /// batch-fetching MDBList data for every title whose cached entry is
    /// missing or stale (MdblistService.NeedsFetch), then writing the full
    /// response into the cache. Doesn't touch Jellyfin's own
    /// CommunityRating/CriticRating fields; that's MdblistRatingsSyncTask's
    /// job, with no network calls of its own.
    ///
    /// ChunkSize was found empirically, not from MDBList's docs: a live test
    /// sending 244 tv ids in one call got back exactly 200 matched items with
    /// no error or truncation indicator, while a follow-up call for the 99
    /// remaining ids matched all 99 cleanly. That points to a silent per-call
    /// response cap around 200, not 18% of a real library genuinely lacking
    /// data, so a single call for the whole library isn't safe. ChunkSize
    /// keeps a margin under that observed ceiling.
    /// </summary>
    internal static class MdblistRatingsFetchRunner
    {
        // See the class doc comment for how this number was derived.
        private const int ChunkSize = 150;

        // Modest pacing between actual MDBList API calls so a large library
        // doesn't burst many chunk calls against MDBList's rate limits.
        private static readonly TimeSpan RequestPacing = TimeSpan.FromMilliseconds(250);

        public static async Task RunAsync(
            ILibraryManager libraryManager,
            MdblistService mdblistService,
            Logger logger,
            int reserve,
            IProgress<double>? progress,
            CancellationToken cancellationToken)
        {
            var status = await mdblistService.GetAccountStatusAsync(cancellationToken).ConfigureAwait(false);
            if (status == null)
            {
                logger.Warning("MDBList Ratings Fetch: could not reach MDBList to check account status (bad API key, or network issue). Skipping this run.");
                progress?.Report(100);
                return;
            }

            var resetTime = DateTimeOffset.FromUnixTimeSeconds(status.RateLimitResetUnixSeconds);
            logger.Info($"Starting MDBList Ratings Fetch task ({status.RateLimitRemaining} of {status.RateLimit} requests remaining, will stop when only {reserve} are left, resets {resetTime:u})");
            progress?.Report(0);

            var allItems = libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                IsVirtualItem = false,
                Recursive = true,
            }).ToList();

            logger.Info($"Found {allItems.Count} movies/series in Jellyfin library");

            var candidates = new List<(string MediaType, string TmdbId)>();
            var alreadyFreshCount = 0;
            foreach (var item in allItems)
            {
                string? mediaType = item switch
                {
                    Movie => "movie",
                    Series => "tv",
                    _ => null,
                };
                if (mediaType == null) continue;

                var tmdbId = item.GetProviderId(MetadataProvider.Tmdb);
                if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit)) continue;

                // Cache freshness only; unlike the sync task, this doesn't care
                // whether Jellyfin's own CommunityRating/CriticRating are
                // already set, just whether MDBList's data needs (re)fetching.
                if (!mdblistService.NeedsFetch(mediaType, tmdbId))
                {
                    alreadyFreshCount++;
                    continue;
                }

                candidates.Add((mediaType, tmdbId));
            }

            logger.Info(alreadyFreshCount > 0
                ? $"MDBList Ratings Fetch: {candidates.Count} of {allItems.Count} items need a fresh MDBList lookup ({alreadyFreshCount} already cached within TTL (7 days for a found title, 3 days for a confirmed no-match) and skipped)."
                : $"MDBList Ratings Fetch: {candidates.Count} of {allItems.Count} items need a fresh MDBList lookup.");

            var fetchedCount = 0;
            var totalCandidates = candidates.Count;
            var stopped = false;

            foreach (var mediaTypeGroup in candidates.GroupBy(c => c.MediaType))
            {
                if (stopped) break;

                var mediaType = mediaTypeGroup.Key;
                var groupIds = mediaTypeGroup.Select(c => c.TmdbId).Distinct().ToList();
                var chunkNumber = 0;

                for (var i = 0; i < groupIds.Count; i += ChunkSize)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    chunkNumber++;

                    var remaining = mdblistService.RemainingQuota() ?? 0;
                    if (remaining <= reserve)
                    {
                        logger.Info($"MDBList Ratings Fetch: Only {remaining} requests remaining (stopping at {reserve}) after fetching {fetchedCount}/{totalCandidates} candidates. Remaining items will be picked up on the next run.");
                        stopped = true;
                        break;
                    }

                    var chunkIds = groupIds.Skip(i).Take(ChunkSize).ToList();

                    var results = await mdblistService.GetMediaBatchAsync(mediaType, chunkIds, cancellationToken).ConfigureAwait(false);
                    await Task.Delay(RequestPacing, cancellationToken).ConfigureAwait(false);

                    if (results == null)
                    {
                        // Network hiccup, bad key, or a race against the reserve
                        // check above. Skip this chunk rather than aborting the
                        // whole run; NeedsFetch will pick these ids up again
                        // next run. See GetMediaBatchAsync's own warning for why.
                        logger.Warning($"MDBList Ratings Fetch: media batch {mediaType} [{chunkNumber}] failed for {chunkIds.Count} id(s), skipping this chunk.");
                        continue;
                    }

                    logger.Info($"MDBList Ratings Fetch: media batch {mediaType} [{chunkNumber}] matched {results.Count}/{chunkIds.Count}");

                    mdblistService.MergeMediaBatchIntoCache(mediaType, chunkIds, results);
                    fetchedCount += chunkIds.Count;

                    if (totalCandidates > 0)
                    {
                        progress?.Report((double)fetchedCount / totalCandidates * 100);
                    }
                }
            }

            logger.Info($"MDBList Ratings Fetch complete: fetched {fetchedCount}/{totalCandidates} candidates.");
            progress?.Report(100);
        }
    }
}
