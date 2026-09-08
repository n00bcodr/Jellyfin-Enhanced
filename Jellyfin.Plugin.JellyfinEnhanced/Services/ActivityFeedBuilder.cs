using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>A merged activity row; preserves the existing activity endpoint's JSON shape.</summary>
internal sealed class ActivityFeedItem
{
    public string ActivityType { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string UserName { get; set; } = string.Empty;
    public long Timestamp { get; set; }
    public object Item { get; set; } = new { };
    public double? Rating { get; set; }
    public string? Content { get; set; }
    public bool Completed { get; set; }
    public double Progress { get; set; }
}

/// <summary>
/// Selects the newest permitted activity before hydrating card metadata. All lookup
/// caches live inside Build so permission, author and media changes are observed on
/// the next request, and no result can be reused across viewers.
/// </summary>
internal sealed class ActivityFeedBuilder(
    ILibraryManager libraryManager,
    IUserManager userManager,
    IItemRepository itemRepository,
    Logger logger)
{
    private const int CandidatePageSize = 64;

    private sealed record Candidate(ActivityFeedItem Row, Guid ItemId, Guid AuthorId, string? TmdbId = null);

    /// <summary>
    /// Merges lightweight records in stable timestamp order, checking access in
    /// bounded pages and continuing past filtered/deleted records until limit is met.
    /// </summary>
    public List<ActivityFeedItem> Build(
        IEnumerable<ActivityEntry> activity,
        IEnumerable<UserReview> reviews,
        JUser viewer,
        bool viewerIsAdmin,
        PluginConfiguration config,
        int limit,
        CancellationToken cancellationToken = default)
    {
        limit = Math.Clamp(limit, 1, 200);
        var candidates = new List<Candidate>();
        foreach (var entry in activity)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (entry == null) continue;
            var enabled = entry.ActivityType switch
            {
                ActivityService.ActivityTypeWatched => config.ActivityFeedShowWatched,
                ActivityService.ActivityTypeFavorited => config.ActivityFeedShowFavorited,
                _ => false
            };
            if (!enabled || !Guid.TryParseExact(entry.ItemId, "N", out var itemId)
                || !Guid.TryParseExact(entry.UserId, "N", out var authorId) || authorId == Guid.Empty
                || !DateTimeOffset.TryParse(entry.OccurredAt, out var occurred)) continue;

            candidates.Add(new Candidate(new ActivityFeedItem
            {
                ActivityType = entry.ActivityType,
                UserId = entry.UserId,
                Timestamp = occurred.ToUnixTimeMilliseconds(),
                Completed = entry.Completed,
                Progress = entry.Progress
            }, itemId, authorId));
        }

        if (config.ActivityFeedShowReviewed)
        {
            foreach (var review in reviews)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (review == null || string.IsNullOrEmpty(review.TmdbId)) continue;
                var timestamp = string.IsNullOrEmpty(review.UpdatedAt) ? review.CreatedAt : review.UpdatedAt;
                if (!DateTimeOffset.TryParse(timestamp, out var occurred)) continue;
                Guid.TryParseExact(review.UserId, "N", out var authorId);
                candidates.Add(new Candidate(new ActivityFeedItem
                {
                    ActivityType = "Reviewed",
                    UserId = review.UserId,
                    Timestamp = occurred.ToUnixTimeMilliseconds(),
                    Rating = review.Rating,
                    Content = review.Content
                }, Guid.Empty, authorId, review.TmdbId.Split(':')[0]));
            }
        }

        // OrderBy is stable: equal timestamps retain activity-before-review and
        // store enumeration order, matching the previous merged feed.
        var ordered = candidates.OrderByDescending(c => c.Row.Timestamp).ToArray();
        var authors = new Dictionary<Guid, JUser?> { [viewer.Id] = viewer };
        var providerItems = new Dictionary<string, Guid>(StringComparer.Ordinal);
        var items = new Dictionary<Guid, BaseItem?>();
        var summaries = new Dictionary<Guid, object>();
        var results = new List<ActivityFeedItem>(limit);
#if !JF12
        HashSet<Guid>? accessibleIds = null;
#endif

        JUser? GetAuthor(Guid id)
        {
            if (id == Guid.Empty) return null;
            if (!authors.TryGetValue(id, out var author))
                authors[id] = author = userManager.GetUserById(id);
            return author;
        }

        BaseItem? GetItem(Guid id)
        {
            if (!items.TryGetValue(id, out var item))
                items[id] = item = libraryManager.GetItemById(id);
            return item;
        }

        var next = 0;
        while (next < ordered.Length && results.Count < limit)
        {
            var page = new List<(Candidate Candidate, Guid ItemId, JUser? Author)>(CandidatePageSize);
            while (next < ordered.Length && page.Count < CandidatePageSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var candidate = ordered[next++];
                try
                {
                    var author = GetAuthor(candidate.AuthorId);
                    if (!viewerIsAdmin && author?.Id != viewer.Id
                        && ((config.HideReviewsFromHiddenUsers && (author == null || author.HasPermission(PermissionKind.IsHidden)))
                            || (config.HideReviewsFromDisabledUsers && (author == null || author.HasPermission(PermissionKind.IsDisabled)))))
                        continue;

                    var itemId = candidate.ItemId;
                    if (candidate.TmdbId != null && !providerItems.TryGetValue(candidate.TmdbId, out itemId))
                    {
                        // Keep existing provider resolution: episode/season reviews
                        // use the parent TMDB id and the first repository match.
                        var matches = itemRepository.GetItemIdsByProviders(new Dictionary<string, string>
                        {
                            ["Tmdb"] = candidate.TmdbId
                        });
                        providerItems[candidate.TmdbId] = itemId = matches?.FirstOrDefault() ?? Guid.Empty;
                    }
                    if (itemId != Guid.Empty) page.Add((candidate, itemId, author));
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.Warning($"Skipping activity candidate for {candidate.Row.UserId}: {ex.Message}");
                }
            }

            // Empty/invalid/hidden-author-only feeds never enumerate the library.
            if (page.Count == 0) continue;
            cancellationToken.ThrowIfCancellationRequested();
#if JF12
            var query = new InternalItemsQuery(viewer) { Recursive = true };
            // Setting ItemIds first makes Jellyfin skip default library scoping.
            // Establish its supported user scope BEFORE narrowing to this page;
            // InternalItemsQuery(viewer) also retains parental/tag restrictions.
            libraryManager.ConfigureUserAccess(query, viewer);
            query.ItemIds = page.Select(p => p.ItemId).Distinct().ToArray();
            var permitted = new HashSet<Guid>(libraryManager.GetItemIds(query));
#else
            // 10.11 has no ConfigureUserAccess API. Preserve its original safe
            // recursive user query, lazily once per request; a naked ItemIds query
            // would bypass allowed-library restrictions on that host.
            accessibleIds ??= new HashSet<Guid>(libraryManager.GetItemIds(new InternalItemsQuery(viewer) { Recursive = true }));
            var permitted = accessibleIds;
#endif
            foreach (var (candidate, itemId, author) in page)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!permitted.Contains(itemId)) continue;
                try
                {
                    if (!summaries.TryGetValue(itemId, out var summary))
                    {
                        var item = GetItem(itemId);
                        if (item == null) continue;
                        summaries[itemId] = summary = BuildSummary(item, GetItem);
                    }
                    candidate.Row.UserName = author?.Username ?? candidate.Row.UserId;
                    candidate.Row.Item = summary;
                    results.Add(candidate.Row);
                    if (results.Count == limit) break;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.Warning($"Skipping activity item {itemId:N}: {ex.Message}");
                }
            }
        }
        return results;
    }

    /// <summary>Hydrates only emitted cards; episode series lookups share the request's item cache.</summary>
    private static object BuildSummary(BaseItem item, Func<Guid, BaseItem?> getItem)
    {
        var episode = item as MediaBrowser.Controller.Entities.TV.Episode;
        var series = episode != null && episode.SeriesId != Guid.Empty ? getItem(episode.SeriesId) : null;
        return new
        {
            Id = item.Id.ToString("N"),
            Name = item.Name,
            Type = item.GetBaseItemKind().ToString(),
            ProductionYear = item.ProductionYear,
            SeriesName = episode?.SeriesName,
            SeriesId = episode != null && episode.SeriesId != Guid.Empty ? episode.SeriesId.ToString("N") : null,
            SeasonNumber = episode?.ParentIndexNumber,
            EpisodeNumber = episode?.IndexNumber,
            HasPrimaryImage = item.HasImage(ImageType.Primary, 0),
            HasThumbImage = item.HasImage(ImageType.Thumb, 0),
            SeriesHasPrimaryImage = series?.HasImage(ImageType.Primary, 0) == true,
            SeriesHasThumbImage = series?.HasImage(ImageType.Thumb, 0) == true
        };
    }
}
