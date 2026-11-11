using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Activity.Services;

/// <summary>A merged activity row; preserves the existing activity endpoint's JSON shape.</summary>
internal sealed class ActivityFeedItem
{
    public string ActivityType { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string UserName { get; set; } = string.Empty;
    public bool UserHasPrimaryImage { get; set; }
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
        var ownOnly = config.ActivityFeedOwnOnlyForNonAdmins && !viewerIsAdmin;
        var ordered = candidates
            .Where(c => !ownOnly || c.AuthorId == viewer.Id)
            .OrderByDescending(c => c.Row.Timestamp).ToArray();
        var authors = new Dictionary<Guid, JUser?> { [viewer.Id] = viewer };
        var providerItems = new Dictionary<string, Guid>(StringComparer.Ordinal);
        var items = new Dictionary<Guid, BaseItem?>();
        var summaries = new Dictionary<Guid, object>();
        var results = new List<ActivityFeedItem>(limit);
        // One Watched/Favorited row per person and title: two versions of one title
        // resolve to the same card (see the merge below).
        var shownRows = new Dictionary<(Guid Author, Guid Item, string Type), ActivityFeedItem>();

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
                    if (ShouldHideAuthor(author, viewer.Id, viewerIsAdmin, config))
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
            var pageIds = page.Select(p => p.ItemId).Distinct().ToArray();
            var permitted = PermittedIds(viewer, pageIds);
            // Jellyfin 12 hides alternate versions from every user query and gives by-name
            // items no library, so entries stored against them never pass the query above,
            // even for their author. Only those are resolved again, each with the rule
            // Jellyfin itself applies to them; the stored id stays what was played or
            // favorited (#1013).
            var shownAsOwner = ResolveHiddenVersions(viewer, pageIds.Where(id => !permitted.Contains(id)).ToArray(), GetItem);
            var byNameFavorites = PermittedByNameIds(viewer, page
                .Where(p => p.Candidate.Row.ActivityType == ActivityService.ActivityTypeFavorited
                    && !permitted.Contains(p.ItemId) && !shownAsOwner.ContainsKey(p.ItemId))
                .Select(p => p.ItemId).Distinct().ToArray(), GetItem);
            foreach (var (candidate, itemId, author) in page)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Guid shownId;
                if (permitted.Contains(itemId)) shownId = itemId;
                else if (shownAsOwner.TryGetValue(itemId, out var owner)) shownId = owner;
                else if (candidate.Row.ActivityType == ActivityService.ActivityTypeFavorited && byNameFavorites.Contains(itemId)) shownId = itemId;
                else continue;
                // Reviews keep one row each (per-season reviews share their series' card).
                // Other rows for one person and title merge into the newest, which keeps
                // the highest progress and any completion, as a rewatch of one item does.
                var rowKey = (candidate.AuthorId, shownId, candidate.Row.ActivityType);
                if (candidate.TmdbId == null && shownRows.TryGetValue(rowKey, out var newer))
                {
                    newer.Completed |= candidate.Row.Completed;
                    newer.Progress = Math.Max(newer.Progress, candidate.Row.Progress);
                    continue;
                }
                // Once the feed is full, the rest of this page only merges into shown rows.
                if (results.Count == limit) continue;
                try
                {
                    if (!summaries.TryGetValue(shownId, out var summary))
                    {
                        var item = GetItem(shownId);
                        if (item == null) continue;
                        summaries[shownId] = summary = BuildSummary(item, GetItem);
                    }
                    candidate.Row.UserName = author?.Username ?? candidate.Row.UserId;
                    candidate.Row.UserHasPrimaryImage = author?.ProfileImage != null;
                    candidate.Row.Item = summary;
                    results.Add(candidate.Row);
                    if (candidate.TmdbId == null) shownRows[rowKey] = candidate.Row;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.Warning($"Skipping activity item {itemId:N}: {ex.Message}");
                }
            }
        }
        MergeLaterVersionPlays(ordered[next..], shownRows, viewer, GetItem, cancellationToken);
        return results;
    }

    // Jellyfin's by-name kinds: items with no library of their own (its
    // BaseItemRepository and SimilarItemsAccessFilter use the same list).
    private static readonly Jellyfin.Data.Enums.BaseItemKind[] ItemByNameKinds =
    [
        Jellyfin.Data.Enums.BaseItemKind.Person,
        Jellyfin.Data.Enums.BaseItemKind.Genre,
        Jellyfin.Data.Enums.BaseItemKind.MusicGenre,
        Jellyfin.Data.Enums.BaseItemKind.MusicArtist,
        Jellyfin.Data.Enums.BaseItemKind.Studio
    ];

    /// <summary>
    /// Returns the ids in <paramref name="ids"/> the viewer may reach. The query is scoped the
    /// way Jellyfin scopes a user's own: ConfigureUserAccess first (library roots; the
    /// constructor already carries parental and tag rules), then the ids, because setting
    /// ItemIds first makes Jellyfin skip the library scope. <paramref name="widen"/> may switch
    /// on one of Jellyfin's own access modes before the scope is set.
    /// </summary>
    private HashSet<Guid> PermittedIds(JUser viewer, Guid[] ids, Action<InternalItemsQuery>? widen = null)
    {
        var permitted = new HashSet<Guid>();
        if (ids.Length == 0) return permitted;
        // A user query collapses items sharing a presentation key to one id, and every version
        // of a title shares its primary's key. Grouping runs after the access filters, so
        // turning it off only stops reachable ids from being dropped.
        var query = new InternalItemsQuery(viewer) { Recursive = true, GroupByPresentationUniqueKey = false };
        widen?.Invoke(query);
        libraryManager.ConfigureUserAccess(query, viewer);
        query.ItemIds = ids;
        var requested = new HashSet<Guid>(ids);
        foreach (var id in libraryManager.GetItemIds(query))
        {
            if (requested.Contains(id)) permitted.Add(id);
        }
        return permitted;
    }

    /// <summary>
    /// Returns the favorited people, genres, studios and music artists or genres in
    /// <paramref name="ids"/> the viewer may reach. Naming their kinds in IncludeItemTypes makes
    /// Jellyfin apply its by-name rule instead of the library one: no restriction for users
    /// without content restrictions, otherwise an item behind the name the user can reach (as
    /// /Persons does). Jellyfin exempts those kinds by type, so only items that really have no
    /// library are kept: a music artist can also be a folder in a music library
    /// (MusicArtist.IsAccessedByName is ParentId.IsEmpty()), and that one stays under the
    /// library rule the page query already applied.
    /// </summary>
    private HashSet<Guid> PermittedByNameIds(JUser viewer, Guid[] ids, Func<Guid, BaseItem?> getItem)
    {
        HashSet<Guid> permitted;
        try
        {
            permitted = PermittedIds(viewer, ids, query => query.IncludeItemTypes = ItemByNameKinds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Optional rows: on failure they stay hidden and the rest of the feed still loads.
            logger.Warning($"Skipping favorited people, genres and studios: {ex.Message}");
            return [];
        }
        permitted.RemoveWhere(id =>
        {
            try
            {
                return getItem(id) is not { } item || !item.ParentId.Equals(Guid.Empty);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.Warning($"Skipping activity item {id:N}: {ex.Message}");
                return true;
            }
        });
        return permitted;
    }

    /// <summary>
    /// Maps each denied id that is a hidden version of a title the viewer may reach to the item
    /// Jellyfin lists in its place: its primary version, or the owner of a local version or
    /// part. The version must pass the user query with Jellyfin's IncludeOwnedItems switch,
    /// which still applies library roots and parental and tag rules to the version itself
    /// (Jellyfin's own by-name access filter counts versions this way), and the item shown on
    /// the card must pass the ordinary query too. Anything else stays denied.
    /// </summary>
    private Dictionary<Guid, Guid> ResolveHiddenVersions(JUser viewer, Guid[] denied, Func<Guid, BaseItem?> getItem)
    {
        try
        {
            var owners = new Dictionary<Guid, Guid>();
            var reachable = PermittedIds(viewer, denied, query => query.IncludeOwnedItems = true);
            foreach (var id in denied)
            {
                if (!reachable.Contains(id)) continue;
                try
                {
                    if (getItem(id) is not Video video) continue;
                    var owner = video.PrimaryVersionId ?? video.OwnerId;
                    if (owner != Guid.Empty && owner != id) owners[id] = owner;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.Warning($"Skipping activity item {id:N}: {ex.Message}");
                }
            }
            if (owners.Count == 0) return owners;

            var shown = PermittedIds(viewer, owners.Values.Distinct().ToArray());
            foreach (var id in owners.Where(o => !shown.Contains(o.Value)).Select(o => o.Key).ToList())
            {
                owners.Remove(id);
            }
            return owners;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Optional rows: on failure they stay hidden and the rest of the feed still loads.
            logger.Warning($"Skipping activity for alternate versions: {ex.Message}");
            return [];
        }
    }

    /// <summary>
    /// Merges watches the feed did not read (past the page that filled it) into the shown rows
    /// they belong to, so a row's progress and completion never depend on the limit or on how
    /// many rows the viewer may see. Only people whose shown watch is still partial can gain
    /// anything; their later entries resolve through the same access queries as the feed's own
    /// rows and can only update a shown row, never add one.
    /// </summary>
    private void MergeLaterVersionPlays(
        Candidate[] later,
        Dictionary<(Guid Author, Guid Item, string Type), ActivityFeedItem> shownRows,
        JUser viewer,
        Func<Guid, BaseItem?> getItem,
        CancellationToken cancellationToken)
    {
        var partial = new HashSet<Guid>(shownRows
            .Where(r => r.Key.Type == ActivityService.ActivityTypeWatched && !r.Value.Completed)
            .Select(r => r.Key.Author));
        if (partial.Count == 0) return;
        var pending = later
            .Where(c => c.TmdbId == null && c.Row.ActivityType == ActivityService.ActivityTypeWatched
                && partial.Contains(c.AuthorId) && (c.Row.Completed || c.Row.Progress > 0))
            .ToList();
        for (var start = 0; start < pending.Count; start += CandidatePageSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var chunk = pending.GetRange(start, Math.Min(CandidatePageSize, pending.Count - start));
            var ids = chunk.Select(c => c.ItemId).Distinct().ToArray();
            HashSet<Guid> permitted;
            try
            {
                permitted = PermittedIds(viewer, ids);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.Warning($"Skipping older activity merges: {ex.Message}");
                return;
            }
            var owners = ResolveHiddenVersions(viewer, ids.Where(id => !permitted.Contains(id)).ToArray(), getItem);
            foreach (var candidate in chunk)
            {
                var shownId = permitted.Contains(candidate.ItemId) ? candidate.ItemId
                    : owners.TryGetValue(candidate.ItemId, out var owner) ? owner : Guid.Empty;
                if (shownId == Guid.Empty
                    || !shownRows.TryGetValue((candidate.AuthorId, shownId, candidate.Row.ActivityType), out var row)) continue;
                row.Completed |= candidate.Row.Completed;
                row.Progress = Math.Max(row.Progress, candidate.Row.Progress);
            }
        }
    }

    /// <summary>Preserves admin/self exceptions and the configured missing-author fallback.</summary>
    private static bool ShouldHideAuthor(JUser? author, Guid viewerId, bool viewerIsAdmin, PluginConfiguration config)
    {
        if (viewerIsAdmin || author?.Id == viewerId) return false;
        if (author == null)
            return config.HideReviewsFromHiddenUsers || config.HideReviewsFromDisabledUsers;
        if (config.HideReviewsFromHiddenUsers && author.HasPermission(PermissionKind.IsHidden)) return true;
        return config.HideReviewsFromDisabledUsers && author.HasPermission(PermissionKind.IsDisabled);
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
