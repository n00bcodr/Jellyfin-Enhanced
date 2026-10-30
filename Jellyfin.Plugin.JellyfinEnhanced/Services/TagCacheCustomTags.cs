using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Custom tag group: which of the administrator's rules (<see cref="CustomTagRuleSet"/>)
    /// each cache entry matches (<see cref="TagCacheEntry.CustomTags"/>).
    /// </summary>
    /// <remarks>
    /// Tags come from the item (a Season/Episode adds its Series'); collection membership
    /// comes from one library pass over the collections a rule names (child id to
    /// collection names), kept here between passes. What keeps entries current:
    /// <list type="bullet">
    /// <item>A full build re-reads the collections first, so every entry it builds is current.</item>
    /// <item>An item change (the monitor's incremental flush) rebuilds the item's entry with its
    /// own and its Series' tags; a Series whose matches changed patches its Seasons and Episodes.</item>
    /// <item>A collection change in a flush (added, renamed, members changed, removed) re-reads the
    /// collections and patches every item whose collections changed, and their Seasons/Episodes.</item>
    /// <item>The daily reconcile re-reads the collections the same way, which covers changes made
    /// while the monitor was not listening.</item>
    /// <item>A configuration save that changes what the rules match (a rule added, removed or
    /// re-targeted) re-matches the whole cache in the background without reading media streams;
    /// label, icon and colour edits need nothing (clients look rules up by id). A snapshot
    /// loaded from disk with other rules is re-matched the same way.</item>
    /// </list>
    /// Not covered until the next full build or reconcile: a collection whose membership changes
    /// without Jellyfin raising an item event for it.
    /// </remarks>
    public partial class TagCacheService
    {
        /// <summary>The ids of the collections the map came from and their members' collection names.</summary>
        private sealed record CollectionMembership(string Fingerprint, IReadOnlySet<Guid> CollectionIds, IReadOnlyDictionary<Guid, string[]> NamesByItem)
        {
            public static readonly CollectionMembership Empty = new(string.Empty, new HashSet<Guid>(), new Dictionary<Guid, string[]>());
        }

        private volatile CollectionMembership? _collections;
        private readonly object _collectionsLock = new();

        /// <summary>
        /// The match fingerprint (<see cref="CustomTagRuleSet.MatchFingerprint"/>) the cache's
        /// CustomTags were computed under; persisted with the snapshot.
        /// </summary>
        private volatile string _customTagsFingerprint = string.Empty;
        private int _customRefreshQueued;

        /// <summary>The matcher for the current configuration.</summary>
        private static CustomTagMatcher CurrentCustomTagMatcher() => CustomTagMatcher.For(JellyfinEnhanced.Instance?.Configuration?.CustomTagRules);

        /// <summary>
        /// The rule ids an item matches: its own tags plus its Series' (Seasons/Episodes),
        /// and the collections holding it or its Series. Null when none (or no rules).
        /// Collections only count while the server tag cache is on: its library events are
        /// what keep the membership current (on-demand entries and /tag-data with the cache
        /// off match tags only).
        /// </summary>
        /// <param name="item">The item.</param>
        /// <param name="series">Its parent Series for a Season/Episode, else null.</param>
        /// <returns>The rule ids, or null.</returns>
        internal string[]? CustomTagsFor(BaseItem item, BaseItem? series)
        {
            var matcher = CurrentCustomTagMatcher();
            if (matcher.IsEmpty) return null;
            IEnumerable<string> tags = item.Tags ?? Array.Empty<string>();
            if (series?.Tags is { Length: > 0 } inherited) tags = tags.Concat(inherited);
            IEnumerable<string>? collections = null;
            if (matcher.HasCollectionRules && ServerModeEnabled)
            {
                var names = Collections(matcher).NamesByItem;
                var own = names.TryGetValue(item.Id, out var a) ? a : Array.Empty<string>();
                var parent = series != null && names.TryGetValue(series.Id, out var b) ? b : Array.Empty<string>();
                collections = own.Concat(parent);
            }

            return matcher.Match(tags, collections);
        }

        /// <summary>
        /// The rule ids for the batch endpoint (<c>/tag-data</c>): as the cache computes them
        /// (see <see cref="CustomTagsFor"/>), with the parent Series looked up once per request.
        /// </summary>
        /// <param name="item">The item.</param>
        /// <param name="seriesMemo">Parent Series looked up so far in this request, by id.</param>
        /// <returns>The rule ids, or null.</returns>
        public string[]? GetCustomTags(BaseItem item, Dictionary<Guid, BaseItem?>? seriesMemo = null)
        {
            var matcher = CurrentCustomTagMatcher();
            if (matcher.IsEmpty) return null;
            var seriesId = item switch
            {
                MediaBrowser.Controller.Entities.TV.Episode e => e.SeriesId,
                MediaBrowser.Controller.Entities.TV.Season s => s.SeriesId,
                _ => Guid.Empty,
            };
            BaseItem? series = null;
            if (seriesId != Guid.Empty && (seriesMemo == null || !seriesMemo.TryGetValue(seriesId, out series)))
            {
                series = GetParentSeries(item);
                if (seriesMemo != null) seriesMemo[seriesId] = series;
            }

            return CustomTagsFor(item, series);
        }

        /// <summary>The collection membership for the current rules, read once and then kept.</summary>
        private CollectionMembership Collections(CustomTagMatcher matcher)
        {
            var current = _collections;
            var fingerprint = CollectionFingerprint(matcher);
            if (current != null && current.Fingerprint == fingerprint) return current;
            lock (_collectionsLock)
            {
                current = _collections;
                if (current != null && current.Fingerprint == fingerprint) return current;
                current = ReadCollections(matcher);
                _collections = current;
                return current;
            }
        }

        /// <summary>What the membership map depends on: the collection rules' values.</summary>
        private static string CollectionFingerprint(CustomTagMatcher matcher) => string.Join("\n", matcher.Rules
            .Where(r => r.Match == CustomTagRuleSet.MatchCollection)
            .Select(r => r.Value.ToLowerInvariant())
            .Order(StringComparer.Ordinal));

        /// <summary>
        /// One pass over the library's collections: the members (by id) of every collection
        /// a rule names, with the names of those collections.
        /// </summary>
        private CollectionMembership ReadCollections(CustomTagMatcher matcher)
        {
            var fingerprint = CollectionFingerprint(matcher);
            if (!matcher.HasCollectionRules) return CollectionMembership.Empty with { Fingerprint = fingerprint };
            var ids = new HashSet<Guid>();
            var names = new Dictionary<Guid, List<string>>();
            try
            {
                var boxSets = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = new[] { BaseItemKind.BoxSet },
                    Recursive = true,
                    DtoOptions = HydrationOptions,
                });
                foreach (var boxSet in boxSets)
                {
                    if (boxSet is not Folder folder || !matcher.IsRuleCollection(boxSet.Name)) continue;
                    ids.Add(boxSet.Id);
                    foreach (var child in folder.GetLinkedChildren())
                    {
                        if (child == null) continue;
                        if (!names.TryGetValue(child.Id, out var list)) names[child.Id] = list = new List<string>(1);
                        if (!list.Contains(boxSet.Name, StringComparer.OrdinalIgnoreCase)) list.Add(boxSet.Name);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to read collections for Custom tags: {ex.Message}");
            }

            return new CollectionMembership(fingerprint, ids, names.ToDictionary(p => p.Key, p => p.Value.ToArray()));
        }

        /// <summary>
        /// Re-read the collections and return the items whose collection names changed
        /// (added to, removed from or renamed collections). Before the first read (a snapshot
        /// just loaded) the earlier members are unknown: every cached entry with a collection
        /// match counts as changed too. Callers hold the rebuild lock.
        /// </summary>
        private HashSet<Guid> RefreshCollectionMembership()
        {
            var matcher = CurrentCustomTagMatcher();
            var unknown = _collections == null;
            var before = _collections ?? CollectionMembership.Empty;
            CollectionMembership after;
            lock (_collectionsLock)
            {
                after = ReadCollections(matcher);
                _collections = after;
            }

            var changed = new HashSet<Guid>();
            foreach (var id in before.NamesByItem.Keys.Concat(after.NamesByItem.Keys))
            {
                var a = before.NamesByItem.TryGetValue(id, out var x) ? x : Array.Empty<string>();
                var b = after.NamesByItem.TryGetValue(id, out var y) ? y : Array.Empty<string>();
                if (!a.SequenceEqual(b, StringComparer.Ordinal)) changed.Add(id);
            }

            if (unknown)
            {
                foreach (var (key, entry) in _cache)
                {
                    if (entry.CustomTags?.Any(t => t.StartsWith(CustomTagRuleSet.MatchCollection + ":", StringComparison.Ordinal)) == true
                        && Guid.TryParse(key, out var id)) changed.Add(id);
                }
            }

            return changed;
        }

        /// <summary>
        /// Before a full build: read the collections for the current rules. Returns the
        /// rules' match fingerprint, which the build records when it publishes.
        /// </summary>
        private string PrepareCustomTagsForBuild()
        {
            var matcher = CurrentCustomTagMatcher();
            lock (_collectionsLock)
            {
                _collections = ReadCollections(matcher);
            }

            return CustomTagRuleSet.MatchFingerprint(matcher.Rules);
        }

        /// <summary>
        /// After an incremental batch (rebuild lock held): a changed collection re-reads the
        /// collections and patches the items whose membership changed; a Series whose own
        /// matches changed patches its Seasons and Episodes.
        /// </summary>
        /// <param name="batch">The drained batch.</param>
        /// <param name="seriesBefore">CustomTags of the batch's Series entries before the batch, by cache key.</param>
        /// <returns>True when an entry changed.</returns>
        private bool ApplyCustomTagFollowUps(IReadOnlyList<(Guid Id, bool Removed)> batch, IReadOnlyDictionary<string, string[]?> seriesBefore)
        {
            var matcher = CurrentCustomTagMatcher();
            if (matcher.IsEmpty) return false;
            var roots = new HashSet<Guid>();
            // Collections not read yet (a snapshot just loaded): any removal may have been one of them.
            var current = _collections;
            var known = (current ?? CollectionMembership.Empty).CollectionIds;
            var collectionChanged = matcher.HasCollectionRules && batch.Any(change => known.Contains(change.Id)
                || (change.Removed && current == null)
                || (_cache.TryGetValue(change.Id.ToString("N"), out var entry) && entry.Type == nameof(BaseItemKind.BoxSet)));
            if (collectionChanged) roots.UnionWith(RefreshCollectionMembership());
            foreach (var (key, before) in seriesBefore)
            {
                var after = _cache.TryGetValue(key, out var entry) ? entry.CustomTags : null;
                if (!SameIds(before, after) && Guid.TryParse(key, out var id)) roots.Add(id);
            }

            return roots.Count > 0 && PatchCustomTags(roots, includeRoots: collectionChanged, CancellationToken.None);
        }

        /// <summary>The CustomTags of the batch's Series entries, to compare after the batch (see <see cref="ApplyCustomTagFollowUps"/>).</summary>
        private Dictionary<string, string[]?> CustomTagsOfSeries(IReadOnlyList<(Guid Id, bool Removed)> batch)
        {
            var result = new Dictionary<string, string[]?>(StringComparer.Ordinal);
            if (CurrentCustomTagMatcher().IsEmpty) return result;
            foreach (var (id, removed) in batch)
            {
                var key = id.ToString("N");
                if (!removed && _cache.TryGetValue(key, out var entry) && entry.Type == nameof(BaseItemKind.Series)) result[key] = entry.CustomTags;
            }

            return result;
        }

        /// <summary>After a reconcile's rebuilds (rebuild lock held): re-read the collections and patch what changed.</summary>
        private bool ReconcileCustomTags(CancellationToken cancellationToken)
        {
            var matcher = CurrentCustomTagMatcher();
            if (!matcher.HasCollectionRules && (_collections?.NamesByItem.Count ?? 0) == 0) return false;
            var changed = RefreshCollectionMembership();
            return changed.Count > 0 && PatchCustomTags(changed, includeRoots: true, cancellationToken);
        }

        /// <summary>
        /// Recompute CustomTags in place for some items (rebuild lock held): the roots
        /// themselves when <paramref name="includeRoots"/> is set, and every cached Season
        /// and Episode of a root that is a Series. Only the metadata is read, never streams.
        /// </summary>
        private bool PatchCustomTags(IEnumerable<Guid> roots, bool includeRoots, CancellationToken cancellationToken)
        {
            var rootKeys = roots.Select(id => id.ToString("N")).ToHashSet(StringComparer.Ordinal);
            var ids = new List<Guid>();
            foreach (var (key, entry) in _cache)
            {
                var hit = (includeRoots && rootKeys.Contains(key)) || (entry.SeriesId != null && rootKeys.Contains(entry.SeriesId));
                if (hit && Guid.TryParse(key, out var id)) ids.Add(id);
            }

            return PatchCustomTagsOf(ids, cancellationToken);
        }

        /// <summary>Recompute and store CustomTags for cached items, reading their metadata in pages.</summary>
        private bool PatchCustomTagsOf(IReadOnlyList<Guid> ids, CancellationToken cancellationToken)
        {
            if (ids.Count == 0) return false;
            using var writes = BeginInPlaceWrites();
            var changed = false;
            var seriesMemo = new Dictionary<Guid, BaseItem?>();
            foreach (var page in HydrateInPages(ids, cancellationToken))
            {
                if (ShouldAbortCacheWork) break;
                foreach (var item in page)
                {
                    var key = item.Id.ToString("N");
                    if (!_cache.TryGetValue(key, out var entry)) continue;
                    var seriesId = item switch
                    {
                        MediaBrowser.Controller.Entities.TV.Episode e => e.SeriesId,
                        MediaBrowser.Controller.Entities.TV.Season s => s.SeriesId,
                        _ => Guid.Empty,
                    };
                    BaseItem? series = null;
                    if (seriesId != Guid.Empty && !seriesMemo.TryGetValue(seriesId, out series))
                    {
                        series = GetParentSeries(item);
                        seriesMemo[seriesId] = series;
                    }

                    var tags = CustomTagsFor(item, series);
                    if (SameIds(tags, entry.CustomTags)) continue;
                    var updated = entry.Clone();
                    updated.CustomTags = tags;
                    updated.LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    RaiseMaxLastUpdated(updated.LastUpdated);
                    StoreEntry(key, updated);
                    changed = true;
                }
            }

            if (!changed) return false;
            Interlocked.Increment(ref _version);
            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            ScheduleDebouncedSave();
            return true;
        }

        /// <summary>
        /// After a configuration save or a snapshot load: when what the rules match differs
        /// from what the cache was computed under, re-match every entry in the background
        /// (once queued, later calls wait for it).
        /// </summary>
        internal void QueueCustomTagRefreshIfStale()
        {
            if (!ServerModeEnabled) return;
            var wanted = CustomTagRuleSet.MatchFingerprint(JellyfinEnhanced.Instance?.Configuration?.CustomTagRules);
            if (wanted == _customTagsFingerprint || Interlocked.CompareExchange(ref _customRefreshQueued, 1, 0) != 0) return;
            _ = Task.Run(() =>
            {
                try
                {
                    _rebuildLock.Wait();
                    try
                    {
                        Interlocked.Exchange(ref _customRefreshQueued, 0);
                        RefreshAllCustomTags();
                    }
                    finally
                    {
                        _rebuildLock.Release();
                    }
                }
                catch (Exception ex)
                {
                    Interlocked.Exchange(ref _customRefreshQueued, 0);
                    _logger.Error($"[TagCache] Custom tag refresh failed: {ex.Message}");
                }
            });
        }

        /// <summary>Re-match every cached entry against the current rules (rebuild lock held).</summary>
        private void RefreshAllCustomTags()
        {
            if (ShouldAbortCacheWork || _cacheReleased) return;
            var matcher = CurrentCustomTagMatcher();
            var fingerprint = CustomTagRuleSet.MatchFingerprint(matcher.Rules);
            if (fingerprint == _customTagsFingerprint) return;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            lock (_collectionsLock)
            {
                _collections = ReadCollections(matcher);
            }

            var ids = _cache.Keys.Select(key => Guid.TryParse(key, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).ToList();
            PatchCustomTagsOf(ids, CancellationToken.None);
            if (ShouldAbortCacheWork) return;
            _customTagsFingerprint = fingerprint;
            ScheduleDebouncedSave();
            _logger.Info($"[TagCache] Custom tag rules re-matched over {ids.Count} entries in {sw.Elapsed.TotalSeconds:F1}s");
        }

        private static bool SameIds(string[]? a, string[]? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return (a?.Length ?? 0) == 0 && (b?.Length ?? 0) == 0;
            return a.SequenceEqual(b, StringComparer.Ordinal);
        }
    }
}
