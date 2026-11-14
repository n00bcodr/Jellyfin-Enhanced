using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks
{
    // Scheduled task that deletes Seerr requests once the user who made them has watched the media.
    // Only the request record is deleted; see RequestRemovalPlanner for the rules.
    public class AutoRequestRemovalTask : IScheduledTask, IConfigurableScheduledTask
    {
        private const string Tag = "[Auto-Request-Removal]";
        private const int PageSize = 100;
        private const int MaxRequests = 100000;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;

        public AutoRequestRemovalTask(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            Logger logger)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public string Name => "Remove watched requests from Seerr";

        public string Key => "JellyfinEnhancedAutoRequestRemoval";

        public string Description => "Deletes a Seerr request once the user who made it has watched it (Seerr > Auto Request Removal).\n\nOnly the request is deleted. The media stays available in Seerr and in the library.";

        public string Category => "Jellyfin Enhanced";

        internal static bool IsFeatureEnabled([NotNullWhen(true)] PluginConfiguration? config) => RequestRemovalPlanner.IsActive(config);

        public bool IsHidden => !IsFeatureEnabled(JellyfinEnhanced.Instance?.Configuration);

        public bool IsEnabled => true;

        public bool IsLogged => true;

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
        {
            return new[]
            {
                new TaskTriggerInfo
                {
                    Type = TaskTriggerInfoType.DailyTrigger,
                    TimeOfDayTicks = TimeSpan.FromHours(4.5).Ticks
                }
            };
        }

        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            if (!IsFeatureEnabled(config))
            {
                _logger.Info($"{Tag} Automatic request removal is disabled in plugin configuration.");
                progress?.Report(100);
                return;
            }

            if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning($"{Tag} Seerr URL or API key not configured.");
                progress?.Report(100);
                return;
            }

            var seerrUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/')).FirstOrDefault(u => u.Length > 0);
            if (seerrUrl == null)
            {
                _logger.Warning($"{Tag} No valid Seerr URL found.");
                progress?.Report(100);
                return;
            }

            _logger.Info($"{Tag} Starting...");
            progress?.Report(0);

            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            // Read every request before acting: a list that could only be read in part is never acted on.
            var requests = await ReadAllRequests(httpClient, seerrUrl, config.JellyseerrApiKey, cancellationToken);
            if (requests == null)
            {
                _logger.Warning($"{Tag} Unable to read the Seerr request list; nothing removed.");
                progress?.Report(100);
                return;
            }

            var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            var usersById = new Dictionary<string, Jellyfin.Database.Implementations.Entities.User>(StringComparer.OrdinalIgnoreCase);
            foreach (var user in _userManager.GetAllUsers())
            {
                var id = user.Id.ToString("N");
                if (blockedIds.Contains(id, StringComparer.OrdinalIgnoreCase)) continue;
                usersById[id] = user;
            }

            var byKey = BuildLibraryIndex();
            var episodeCache = new Dictionary<(Guid UserId, string LibraryKey), Dictionary<int, IReadOnlyCollection<bool>>>();
            var processed = 0;
            var removed = 0;

            foreach (var request in requests)
            {
                cancellationToken.ThrowIfCancellationRequested();
                processed++;
                try
                {
                    // Cheapest checks first: a pending, declined or failed request is never removed, so
                    // it must not cost a library query.
                    if (!RequestRemovalPlanner.IsRemovableStatus(request.Candidate.RequestStatus)) continue;
                    if (!usersById.TryGetValue(request.RequesterJellyfinId, out var user)) continue;
                    var libraryKey = LibraryKey(request.Candidate.IsTv, request.TmdbId);
                    if (!byKey.TryGetValue(libraryKey, out var items)) continue;

                    RequestRemovalPlanner.Decision decision;
                    if (!request.Candidate.IsTv)
                    {
                        decision = RequestRemovalPlanner.Decide(request.Candidate, CollectMoviesPlayed(user, items), null);
                    }
                    else
                    {
                        // Several requests for one series by one user share the same episode scan.
                        if (!episodeCache.TryGetValue((user.Id, libraryKey), out var episodes))
                        {
                            episodes = CollectEpisodesPlayed(user, items);
                            episodeCache[(user.Id, libraryKey)] = episodes;
                        }
                        var candidate = request.Candidate;
                        if (candidate.SeasonStatuses.Count == 0)
                        {
                            // Seerr's request list leaves out the per-season statuses. Read them from
                            // the request itself, but only once the requester has watched every
                            // requested season, so unwatched requests cost no extra call.
                            var watched = RequestRemovalPlanner.DecideAssumingSeasonsAvailable(candidate, episodes);
                            if (watched.Remove)
                            {
                                var details = await ReadRequest(httpClient, seerrUrl, config.JellyseerrApiKey, candidate.RequestId, cancellationToken);
                                if (details == null) continue; // already logged; try again next run
                                candidate = details.Candidate;
                            }
                        }

                        decision = RequestRemovalPlanner.Decide(candidate, null, episodes);
                    }

                    if (!decision.Remove)
                    {
                        _logger.Debug($"{Tag} Keeping request {request.Candidate.RequestId} ({items[0].Name}) for {user.Username}: {decision.Reason}");
                        continue;
                    }

                    if (await DeleteRequest(httpClient, seerrUrl, config.JellyseerrApiKey, request.Candidate.RequestId, cancellationToken))
                    {
                        removed++;
                        _logger.Info($"{Tag} ✓ Removed request {request.Candidate.RequestId} ({items[0].Name}) for {user.Username}: {decision.Reason}");
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Error($"{Tag} Error processing request {request.Candidate.RequestId}: {ex.Message}");
                }
                finally
                {
                    progress?.Report((double)processed / Math.Max(requests.Count, 1) * 100);
                }
            }

            _logger.Info($"{Tag} Completed. Removed {removed} of {requests.Count} requests");
            progress?.Report(100);
        }

        internal sealed record ParsedRequest(RequestRemovalPlanner.Candidate Candidate, int TmdbId, string RequesterJellyfinId);

        private static string LibraryKey(bool isTv, int tmdbId) => $"{(isTv ? "tv" : "movie")}:{tmdbId}";

        // Movies and series by TMDB id. Several versions of one title share a key.
        private Dictionary<string, List<BaseItem>> BuildLibraryIndex()
        {
            var libraryItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                HasTmdbId = true,
                Recursive = true
            });

            var byKey = new Dictionary<string, List<BaseItem>>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in libraryItems)
            {
                if (item.ProviderIds == null || !item.ProviderIds.TryGetValue("Tmdb", out var tmdbStr)
                    || !int.TryParse(tmdbStr, out var tmdbId) || tmdbId <= 0) continue;
                var key = LibraryKey(item.GetBaseItemKind() == BaseItemKind.Series, tmdbId);
                if (!byKey.TryGetValue(key, out var versions)) byKey[key] = versions = new List<BaseItem>();
                versions.Add(item);
            }

            return byKey;
        }

        private List<bool> CollectMoviesPlayed(Jellyfin.Database.Implementations.Entities.User user, List<BaseItem> versions)
        {
            return versions.Select(v => _userDataManager.GetUserData(user, v)?.Played == true).ToList();
        }

        // Episodes per season. When a series exists more than once, an episode counts as watched if
        // any copy of it was watched, so a duplicate library never blocks the removal.
        private Dictionary<int, IReadOnlyCollection<bool>> CollectEpisodesPlayed(Jellyfin.Database.Implementations.Entities.User user, List<BaseItem> seriesVersions)
        {
            var episodes = _libraryManager.GetItemList(new InternalItemsQuery
            {
                AncestorIds = seriesVersions.Select(s => s.Id).ToArray(),
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                IsVirtualItem = false,
                Recursive = true
            });

            var grouped = new Dictionary<(int Season, string Episode), bool>();
            foreach (var episode in episodes)
            {
                if (episode.ParentIndexNumber is not int season || season <= 0) continue;
                var episodeKey = episode.IndexNumber?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? episode.Id.ToString("N");
                var played = _userDataManager.GetUserData(user, episode)?.Played == true;
                grouped[(season, episodeKey)] = played || (grouped.TryGetValue((season, episodeKey), out var other) && other);
            }

            return grouped
                .GroupBy(g => g.Key.Season)
                .ToDictionary(g => g.Key, g => (IReadOnlyCollection<bool>)g.Select(x => x.Value).ToList());
        }

        private async Task<List<ParsedRequest>?> ReadAllRequests(HttpClient httpClient, string seerrUrl, string apiKey, CancellationToken cancellationToken)
        {
            var result = new List<ParsedRequest>();
            var skip = 0;
            try
            {
                while (skip < MaxRequests)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var uri = $"{seerrUrl}/api/v1/request?take={PageSize}&skip={skip}&sort=added&filter=all";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey);
                    using var response = await httpClient.SendAsync(request, cancellationToken);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, uri, cancellationToken);
                    if (error != null)
                    {
                        _logger.Warning($"{Tag} ✗ Failed to read Seerr requests: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        return null;
                    }

                    using var doc = JsonDocument.Parse(content!);
                    if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return null;

                    var count = 0;
                    foreach (var row in results.EnumerateArray())
                    {
                        count++;
                        var parsed = Parse(row);
                        if (parsed != null) result.Add(parsed);
                    }

                    skip += count;
                    if (count < PageSize) break;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"{Tag} Error reading Seerr requests: {ex.Message}");
                return null;
            }

            return result;
        }

        // Reads one request, which unlike the list includes media.seasons with each season's status.
        private async Task<ParsedRequest?> ReadRequest(HttpClient httpClient, string seerrUrl, string apiKey, int requestId, CancellationToken cancellationToken)
        {
            try
            {
                var uri = $"{seerrUrl}/api/v1/request/{requestId}";
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey);
                using var response = await httpClient.SendAsync(request, cancellationToken);
                var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, uri, cancellationToken);
                if (error != null)
                {
                    _logger.Warning($"{Tag} ✗ Failed to read request {requestId}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}; will retry next run");
                    return null;
                }

                using var doc = JsonDocument.Parse(content!);
                return Parse(doc.RootElement);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"{Tag} ✗ Error reading request {requestId}: {ex.Message}");
                return null;
            }
        }

        // Turns one Seerr request row into a planner candidate. Rows that cannot be matched to a
        // requester or a TMDB id are skipped.
        internal static ParsedRequest? Parse(JsonElement row)
        {
            if (!TryInt(row, "id", out var requestId)) return null;
            var type = row.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            if (type != "movie" && type != "tv") return null;
            var isTv = type == "tv";
            var is4k = row.TryGetProperty("is4k", out var k) && k.ValueKind == JsonValueKind.True;

            if (!row.TryGetProperty("media", out var media) || media.ValueKind != JsonValueKind.Object) return null;
            if (!TryInt(media, "tmdbId", out var tmdbId) || tmdbId <= 0) return null;

            if (!row.TryGetProperty("requestedBy", out var requestedBy) || requestedBy.ValueKind != JsonValueKind.Object) return null;
            var jellyfinUserId = requestedBy.TryGetProperty("jellyfinUserId", out var jf) && jf.ValueKind == JsonValueKind.String
                ? (jf.GetString() ?? string.Empty).Replace("-", string.Empty)
                : string.Empty;
            if (jellyfinUserId.Length == 0) return null;

            TryInt(row, "status", out var requestStatus);
            var statusField = is4k ? "status4k" : "status";
            TryInt(media, statusField, out var mediaStatus);

            var requestedSeasons = new List<int>();
            if (row.TryGetProperty("seasons", out var seasons) && seasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in seasons.EnumerateArray())
                {
                    if (TryInt(season, "seasonNumber", out var n)) requestedSeasons.Add(n);
                }
            }

            var seasonStatuses = new Dictionary<int, int>();
            if (media.TryGetProperty("seasons", out var mediaSeasons) && mediaSeasons.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in mediaSeasons.EnumerateArray())
                {
                    if (TryInt(season, "seasonNumber", out var n) && TryInt(season, statusField, out var s)) seasonStatuses[n] = s;
                }
            }

            var candidate = new RequestRemovalPlanner.Candidate(requestId, isTv, requestStatus, mediaStatus, requestedSeasons, seasonStatuses);
            return new ParsedRequest(candidate, tmdbId, jellyfinUserId);
        }

        private static bool TryInt(JsonElement element, string property, out int value)
        {
            value = 0;
            return element.TryGetProperty(property, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out value);
        }

        // A successful DELETE has an empty body, so the status code is checked directly.
        // Sent with the API key alone: the task acts as the Seerr admin, not as the requester.
        private async Task<bool> DeleteRequest(HttpClient httpClient, string seerrUrl, string apiKey, int requestId, CancellationToken cancellationToken)
        {
            try
            {
                var uri = $"{seerrUrl}/api/v1/request/{requestId}";
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Delete, uri, apiKey);
                using var response = await httpClient.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode || (int)response.StatusCode == 404) return true;
                _logger.Warning($"{Tag} ✗ Failed to remove request {requestId}: HTTP {(int)response.StatusCode}; will retry next run");
                return false;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Error($"{Tag} ✗ Error removing request {requestId}: {ex.Message}");
                return false;
            }
        }
    }
}
