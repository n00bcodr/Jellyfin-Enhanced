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
using Jellyfin.Plugin.JellyfinEnhanced.Model;
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

        // A 429 with Retry-After pauses the run for that long and then retries
        // the same chunk. MDBList's per-account windows are 5 minutes, so a
        // longer wait (the daily quota) ends the run instead, as does a chunk
        // refused this many times in a row; the next run picks the rest up.
        private static readonly TimeSpan MaxInRunPause = TimeSpan.FromMinutes(10);
        private const int MaxPausesPerChunk = 3;

        public static async Task RunAsync(
            ILibraryManager libraryManager,
            MdblistService mdblistService,
            Logger logger,
            int reserve,
            IProgress<double>? progress,
            CancellationToken cancellationToken)
            => await RunAsync(libraryManager, mdblistService, logger, reserve, progress, Task.Delay, cancellationToken).ConfigureAwait(false);

        internal static async Task RunAsync(
            ILibraryManager libraryManager,
            MdblistService mdblistService,
            Logger logger,
            int reserve,
            IProgress<double>? progress,
            Func<TimeSpan, CancellationToken, Task> pause,
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
                var pausesThisChunk = 0;

                for (var i = 0; i < groupIds.Count; i += ChunkSize)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    chunkNumber++;

                    var chunkIds = groupIds.Skip(i).Take(ChunkSize).ToList();

                    // The reserve check and the request share one gate with the
                    // incremental tag-rating warmers, so overlapping runs can't
                    // both spend the last request above the reserve.
                    var batch = await mdblistService.GetMediaBatchWithinReserveAsync(mediaType, chunkIds, reserve, cancellationToken).ConfigureAwait(false);
                    if (batch.Status == MdblistReservedBatchStatus.ReserveReached)
                    {
                        logger.Info($"MDBList Ratings Fetch: Only {batch.Remaining} requests remaining (stopping at {reserve}) after fetching {fetchedCount}/{totalCandidates} candidates. Remaining items will be picked up on the next run.");
                        stopped = true;
                        break;
                    }
                    if (batch.Status == MdblistReservedBatchStatus.QuotaUnknown)
                    {
                        logger.Warning($"MDBList Ratings Fetch: account status became unavailable after fetching {fetchedCount}/{totalCandidates} candidates; stopping. Remaining items will be picked up on the next run.");
                        stopped = true;
                        break;
                    }
                    if (batch.Status == MdblistReservedBatchStatus.RateLimited)
                    {
                        // The service already logged the one warning for this pause and sends nothing until it ends.
                        var wait = batch.RetryAfter ?? TimeSpan.Zero;
                        if (wait > MaxInRunPause || ++pausesThisChunk > MaxPausesPerChunk)
                        {
                            logger.Info($"MDBList Ratings Fetch: MDBList asked to wait {Math.Ceiling(wait.TotalSeconds)}s after fetching {fetchedCount}/{totalCandidates} candidates; stopping. Remaining items will be picked up on the next run.");
                            stopped = true;
                            break;
                        }

                        logger.Info($"MDBList Ratings Fetch: pausing {Math.Ceiling(wait.TotalSeconds)}s for MDBList's rate limit, then retrying media batch {mediaType} [{chunkNumber}].");
                        await pause(wait, cancellationToken).ConfigureAwait(false);
                        // Same chunk again once the pause has passed.
                        i -= ChunkSize;
                        chunkNumber--;
                        continue;
                    }

                    pausesThisChunk = 0;

                    await Task.Delay(RequestPacing, cancellationToken).ConfigureAwait(false);

                    var results = batch.Results;
                    if (results == null)
                    {
                        // Network hiccup or bad key. Skip this chunk rather than
                        // aborting the whole run; NeedsFetch will pick these ids
                        // up again next run.
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
