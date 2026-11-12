using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The decision logic of the automatic request removal, free of any I/O so it can be tested.
    ///
    /// A Seerr request is removed on the first run after the user who made it has watched what
    /// they asked for. Only the request record goes: the media stays available in Seerr and on
    /// disk. Everything uncertain (still pending, not downloaded yet, an unwatched episode) keeps
    /// the request.
    /// </summary>
    public static class RequestRemovalPlanner
    {
        // Seerr request statuses (MediaRequestStatus).
        public const int RequestPending = 1;
        public const int RequestApproved = 2;
        public const int RequestDeclined = 3;
        public const int RequestFailed = 4;
        public const int RequestCompleted = 5;

        // Seerr media status meaning every requested file is in the library (MediaStatus.AVAILABLE).
        public const int MediaAvailable = 5;

        /// <summary>Whether the feature has anything to do with this configuration.</summary>
        public static bool IsActive(PluginConfiguration? config)
            => config != null && config.JellyseerrEnabled && config.AutoRequestRemovalEnabled;

        /// <summary>
        /// A Seerr request as the planner sees it.
        /// </summary>
        /// <param name="RequestId">Seerr request id.</param>
        /// <param name="IsTv">True for a series request, false for a movie.</param>
        /// <param name="RequestStatus">Raw Seerr request status (1 pending … 5 completed).</param>
        /// <param name="MediaStatus">Seerr media status for the request's quality (4K or not).</param>
        /// <param name="RequestedSeasons">Season numbers the request asked for (TV only).</param>
        /// <param name="SeasonStatuses">Seerr status per season number, for the request's quality (TV only).</param>
        public sealed record Candidate(
            int RequestId,
            bool IsTv,
            int RequestStatus,
            int MediaStatus,
            IReadOnlyCollection<int> RequestedSeasons,
            IReadOnlyDictionary<int, int> SeasonStatuses);

        public sealed record Decision(bool Remove, string Reason)
        {
            public static Decision Keep(string reason) => new(false, reason);
            public static Decision RemoveIt(string reason) => new(true, reason);
        }

        /// <param name="candidate">The request.</param>
        /// <param name="movieVersionsPlayed">Whether the requester played each library version of the movie.</param>
        /// <param name="episodesPlayedBySeason">Whether the requester played each library episode, by season number.</param>
        public static Decision Decide(
            Candidate candidate,
            IReadOnlyCollection<bool>? movieVersionsPlayed,
            IReadOnlyDictionary<int, IReadOnlyCollection<bool>>? episodesPlayedBySeason)
        {
            if (candidate.RequestStatus != RequestApproved && candidate.RequestStatus != RequestCompleted)
            {
                return Decision.Keep($"request status {candidate.RequestStatus} is not approved or completed");
            }

            if (!candidate.IsTv)
            {
                if (candidate.MediaStatus != MediaAvailable) return Decision.Keep("movie is not available yet");

                // Any watched version is enough.
                return movieVersionsPlayed?.Any(played => played) == true
                    ? Decision.RemoveIt("requester watched the movie")
                    : Decision.Keep("requester has not watched the movie");
            }

            if (candidate.RequestedSeasons.Count == 0) return Decision.Keep("request names no seasons");

            foreach (var season in candidate.RequestedSeasons)
            {
                if (!candidate.SeasonStatuses.TryGetValue(season, out var status) || status != MediaAvailable)
                {
                    return Decision.Keep($"season {season} is not available yet");
                }

                IReadOnlyCollection<bool>? episodes = null;
                if (episodesPlayedBySeason == null || !episodesPlayedBySeason.TryGetValue(season, out episodes) || episodes.Count == 0)
                {
                    return Decision.Keep($"season {season} has no episodes in the library");
                }

                if (episodes.Any(played => !played)) return Decision.Keep($"season {season} is not fully watched");
            }

            return Decision.RemoveIt("requester watched every requested season");
        }

        /// <summary>
        /// Decides a series request as if every requested season were available in Seerr. Seerr's
        /// request list leaves out the per-season statuses, so this tells whether a request has
        /// been watched far enough to be worth reading its details for them.
        /// </summary>
        public static Decision DecideAssumingSeasonsAvailable(
            Candidate candidate,
            IReadOnlyDictionary<int, IReadOnlyCollection<bool>>? episodesPlayedBySeason)
        {
            var assumed = candidate with
            {
                SeasonStatuses = candidate.RequestedSeasons.Distinct().ToDictionary(season => season, _ => MediaAvailable)
            };
            return Decide(assumed, null, episodesPlayedBySeason);
        }
    }
}
