using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
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
    /// <para>
    /// Per user: a collection match is only served to a user who can access a collection that
    /// produced it (<see cref="VisibleCustomTags"/>, applied by the tag cache projection, /tag-data
    /// and native posters); the rule collections a user cannot access are part of their
    /// accessRevision (<see cref="CollectionAccessSuffix"/>), so a stored copy is replaced when
    /// that changes. Tag matches need no filtering: the tags are on the item itself.
    /// </para>
    /// </remarks>
    public partial class TagCacheService
    {
        /// <summary>One collection an item belongs to: its id (for access checks) and name (for matching).</summary>
        private readonly record struct CollectionRef(Guid Id, string Name);

        /// <summary>The ids of the collections the map came from and, per member, those collections.</summary>
        private sealed record CollectionMembership(string Fingerprint, IReadOnlySet<Guid> CollectionIds, IReadOnlyDictionary<Guid, CollectionRef[]> ByItem)
        {
            public static readonly CollectionMembership Empty = new(string.Empty, new HashSet<Guid>(), new Dictionary<Guid, CollectionRef[]>());
        }

        private volatile CollectionMembership? _collections;
        private readonly object _collectionsLock = new();

        /// <summary>
        /// True from a snapshot load until a collection pass has reconciled the cached collection
        /// matches: the snapshot does not record which collections they came from, so until then
        /// a removal may have been one of them and the earlier members count as unknown. A read
        /// of the membership in between (an on-demand entry, a rebuild in the same batch) installs
        /// <see cref="_collections"/> but leaves this set.
        /// </summary>
        private volatile bool _collectionMatchesUnreconciled;

        /// <summary>What a flush needs from before its batch is applied (see <see cref="ApplyCustomTagFollowUps"/>).</summary>
        /// <param name="SeriesBefore">CustomTags of the batch's Series entries, by cache key.</param>
        /// <param name="CollectionTouched">A batch item was a collection: a known rule collection, a cached BoxSet, or a removal while matches are unreconciled.</param>
        private sealed record CustomTagBatchState(IReadOnlyDictionary<string, string[]?> SeriesBefore, bool CollectionTouched);

        /// <summary>
        /// The match fingerprint (<see cref="CustomTagRuleSet.MatchFingerprint"/>) the cache's
        /// CustomTags were computed under; persisted with the snapshot.
        /// </summary>
        private volatile string _customTagsFingerprint = string.Empty;
        private int _customRefreshQueued;

        /// <summary>The matcher for the current configuration.</summary>
        private static CustomTagMatcher CurrentCustomTagMatcher() => CustomTagMatcher.For(JellyfinEnhanced.Instance?.Configuration);

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
                collections = CollectionsOf(Collections(matcher), item.Id, series?.Id).Select(c => c.Name);
            }

            return matcher.Match(tags, collections);
        }

        /// <summary>The collections holding an item or its Series.</summary>
        private static IEnumerable<CollectionRef> CollectionsOf(CollectionMembership membership, Guid itemId, Guid? seriesId)
        {
            var own = membership.ByItem.TryGetValue(itemId, out var a) ? a : Array.Empty<CollectionRef>();
            var parent = seriesId is { } sid && sid != Guid.Empty && membership.ByItem.TryGetValue(sid, out var b) ? b : Array.Empty<CollectionRef>();
            return own.Concat(parent);
        }

        /// <summary>
        /// The rule ids for the batch endpoint (<c>/tag-data</c>): as the cache computes them
        /// (see <see cref="CustomTagsFor"/>), with the parent Series looked up once per request,
        /// and collection matches only for collections <paramref name="user"/> can access.
        /// </summary>
        /// <param name="item">The item.</param>
        /// <param name="user">The requesting user.</param>
        /// <param name="seriesMemo">Parent Series looked up so far in this request, by id.</param>
        /// <returns>The rule ids, or null.</returns>
        public string[]? GetCustomTags(BaseItem item, JUser user, Dictionary<Guid, BaseItem?>? seriesMemo = null)
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

            var ids = CustomTagsFor(item, series);
            if (ids == null || !Array.Exists(ids, CustomTagRuleSet.IsCollectionId)) return ids;
            return VisibleCustomTags(ids, item.Id, series?.Id, ResolveUserAccess(user).Ids);
        }

        /// <summary>
        /// A cache entry as one user may see it: its collection matches only for collections the
        /// user can access (see <see cref="VisibleCustomTags"/>). The shared entry is never
        /// changed; a clone is returned when something is dropped.
        /// </summary>
        /// <param name="entry">A cache entry (or an on-demand build).</param>
        /// <param name="itemId">The entry's item id.</param>
        /// <param name="user">The viewer.</param>
        /// <returns>The entry or a filtered clone.</returns>
        public TagCacheEntry FilterCustomTagsForUser(TagCacheEntry entry, Guid itemId, JUser user)
        {
            if (entry.CustomTags is not { } ids || !Array.Exists(ids, CustomTagRuleSet.IsCollectionId)) return entry;
            return WithVisibleCustomTags(entry, itemId, ResolveUserAccess(user).Ids);
        }

        /// <summary>The entry with only the collection matches <paramref name="access"/> admits (a clone when any is dropped).</summary>
        private TagCacheEntry WithVisibleCustomTags(TagCacheEntry entry, Guid itemId, HashSet<string> access)
        {
            if (entry.CustomTags is not { } ids || !Array.Exists(ids, CustomTagRuleSet.IsCollectionId)) return entry;
            var seriesId = Guid.TryParse(entry.SeriesId, out var sid) ? sid : (Guid?)null;
            var visible = VisibleCustomTags(ids, itemId, seriesId, access);
            if (SameIds(visible, ids)) return entry;
            var filtered = entry.Clone();
            filtered.CustomTags = visible;
            return filtered;
        }

        /// <summary>
        /// The matched rule ids one user may see: tag matches as they are, a collection match
        /// only while a collection that produced it (holding the item or its Series, with the
        /// rule's name) is in the user's access set. Null when nothing is left.
        /// </summary>
        private string[]? VisibleCustomTags(string[] ids, Guid itemId, Guid? seriesId, HashSet<string> access)
        {
            var matcher = CurrentCustomTagMatcher();
            var names = matcher.HasCollectionRules && ServerModeEnabled
                ? CollectionsOf(Collections(matcher), itemId, seriesId).Where(c => access.Contains(c.Id.ToString("N"))).Select(c => c.Name)
                : Enumerable.Empty<string>();
            var allowed = matcher.Match(null, names) ?? Array.Empty<string>();
            var visible = ids.Where(id => !CustomTagRuleSet.IsCollectionId(id) || Array.IndexOf(allowed, id) >= 0).ToArray();
            return visible.Length == 0 ? null : visible;
        }

        /// <summary>
        /// The part of a user's accessRevision that covers collection matches: a digest of the
        /// rule collections the user cannot access ("" when none), so a stored copy is replaced
        /// when a collection's access changes even if no cache entry did.
        /// </summary>
        private string CollectionAccessSuffix(HashSet<string> access)
        {
            var matcher = CurrentCustomTagMatcher();
            if (!matcher.HasCollectionRules || !ServerModeEnabled) return string.Empty;
            ulong sum = 0;
            var count = 0;
            foreach (var id in Collections(matcher).CollectionIds)
            {
                var key = id.ToString("N");
                if (access.Contains(key)) continue;
                sum = unchecked(sum + StableKeyHash(key));
                count++;
            }

            return count == 0 ? string.Empty : ";c" + count.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + sum.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
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
            var byItem = new Dictionary<Guid, List<CollectionRef>>();
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
                        if (!byItem.TryGetValue(child.Id, out var list)) byItem[child.Id] = list = new List<CollectionRef>(1);
                        if (!list.Exists(c => c.Id == boxSet.Id)) list.Add(new CollectionRef(boxSet.Id, boxSet.Name));
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to read collections for Custom tags: {ex.Message}");
            }

            return new CollectionMembership(fingerprint, ids, byItem.ToDictionary(p => p.Key, p => p.Value.OrderBy(c => c.Id).ToArray()));
        }

        /// <summary>
        /// Re-read the collections and return the items whose collections changed (added to,
        /// removed from or renamed collections, or another collection of the same name). While
        /// the cached matches are unreconciled (a snapshot just loaded, see
        /// <see cref="_collectionMatchesUnreconciled"/>) the earlier members are unknown, even if
        /// something has read the membership since: every cached entry with a collection match
        /// counts as changed too, and <paramref name="wasUnknown"/> tells the caller to mark the
        /// matches reconciled once it has patched them. Callers hold the rebuild lock.
        /// </summary>
        private HashSet<Guid> RefreshCollectionMembership(out bool wasUnknown)
        {
            var matcher = CurrentCustomTagMatcher();
            var unknown = wasUnknown = _collectionMatchesUnreconciled || _collections == null;
            var before = unknown ? CollectionMembership.Empty : _collections!;
            CollectionMembership after;
            lock (_collectionsLock)
            {
                after = ReadCollections(matcher);
                _collections = after;
            }

            var changed = new HashSet<Guid>();
            foreach (var id in before.ByItem.Keys.Concat(after.ByItem.Keys))
            {
                var a = before.ByItem.TryGetValue(id, out var x) ? x : Array.Empty<CollectionRef>();
                var b = after.ByItem.TryGetValue(id, out var y) ? y : Array.Empty<CollectionRef>();
                if (!a.SequenceEqual(b)) changed.Add(id);
            }

            if (unknown)
            {
                foreach (var (key, entry) in _cache)
                {
                    if (entry.CustomTags is { } tags && Array.Exists(tags, CustomTagRuleSet.IsCollectionId)
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

            return matcher.Fingerprint;
        }

        /// <summary>
        /// After an incremental batch (rebuild lock held): a changed collection re-reads the
        /// collections and patches the items whose membership changed; a Series whose own
        /// matches changed patches its Seasons and Episodes.
        /// </summary>
        /// <param name="batch">The drained batch.</param>
        /// <param name="before">What <see cref="CaptureCustomTagsBefore"/> recorded before the batch was applied.</param>
        /// <returns>True when an entry changed.</returns>
        private bool ApplyCustomTagFollowUps(IReadOnlyList<(Guid Id, bool Removed)> batch, CustomTagBatchState before)
        {
            var matcher = CurrentCustomTagMatcher();
            if (matcher.IsEmpty) return false;
            var roots = new HashSet<Guid>();
            // Read before the batch, and again now: the batch's rebuilds may have read the
            // membership (a collection added by this batch is only known now).
            var collectionChanged = matcher.HasCollectionRules && (before.CollectionTouched || IsCollectionChange(batch));
            var wasUnknown = false;
            if (collectionChanged) roots.UnionWith(RefreshCollectionMembership(out wasUnknown));
            foreach (var (key, series) in before.SeriesBefore)
            {
                var after = _cache.TryGetValue(key, out var entry) ? entry.CustomTags : null;
                if (!SameIds(series, after) && Guid.TryParse(key, out var id)) roots.Add(id);
            }

            var changed = roots.Count > 0 && PatchCustomTags(roots, includeRoots: collectionChanged, touchCollectionMatches: collectionChanged, CancellationToken.None);
            if (wasUnknown && !ShouldAbortCacheWork) _collectionMatchesUnreconciled = false;
            return changed;
        }

        /// <summary>
        /// Whether a batch touches a collection: a rule collection the membership knows, a cached
        /// BoxSet, or (while the cached matches are unreconciled) any removal, which may have
        /// been a collection nothing has read yet.
        /// </summary>
        private bool IsCollectionChange(IReadOnlyList<(Guid Id, bool Removed)> batch)
        {
            var known = (_collections ?? CollectionMembership.Empty).CollectionIds;
            var unreconciled = _collectionMatchesUnreconciled || _collections == null;
            return batch.Any(change => known.Contains(change.Id)
                || (change.Removed && unreconciled)
                || (_cache.TryGetValue(change.Id.ToString("N"), out var entry) && entry.Type == nameof(BaseItemKind.BoxSet)));
        }

        /// <summary>
        /// Before a batch is applied (rebuild lock held): the CustomTags of its Series entries, to
        /// compare afterwards, and whether it touches a collection, judged before the batch can
        /// remove a BoxSet entry or read the membership (see <see cref="ApplyCustomTagFollowUps"/>).
        /// </summary>
        private CustomTagBatchState CaptureCustomTagsBefore(IReadOnlyList<(Guid Id, bool Removed)> batch)
        {
            var series = new Dictionary<string, string[]?>(StringComparer.Ordinal);
            var matcher = CurrentCustomTagMatcher();
            if (matcher.IsEmpty) return new CustomTagBatchState(series, false);
            foreach (var (id, removed) in batch)
            {
                var key = id.ToString("N");
                if (!removed && _cache.TryGetValue(key, out var entry) && entry.Type == nameof(BaseItemKind.Series)) series[key] = entry.CustomTags;
            }

            return new CustomTagBatchState(series, matcher.HasCollectionRules && IsCollectionChange(batch));
        }

        /// <summary>After a reconcile's rebuilds (rebuild lock held): re-read the collections and patch what changed.</summary>
        private bool ReconcileCustomTags(CancellationToken cancellationToken)
        {
            var matcher = CurrentCustomTagMatcher();
            if (!matcher.HasCollectionRules && (_collections?.ByItem.Count ?? 0) == 0) return false;
            var changed = RefreshCollectionMembership(out var wasUnknown);
            var patched = changed.Count > 0 && PatchCustomTags(changed, includeRoots: true, touchCollectionMatches: true, cancellationToken);
            if (wasUnknown && !ShouldAbortCacheWork && !cancellationToken.IsCancellationRequested) _collectionMatchesUnreconciled = false;
            return patched;
        }

        /// <summary>
        /// Recompute CustomTags in place for some items (rebuild lock held): the roots
        /// themselves when <paramref name="includeRoots"/> is set, and every cached Season
        /// and Episode of a root that is a Series. Only the metadata is read, never streams.
        /// With <paramref name="touchCollectionMatches"/> (their collections changed) an entry
        /// with a collection match is re-stamped even when its ids stay the same: which users
        /// may see the match can have changed, and a delta must carry it again.
        /// </summary>
        private bool PatchCustomTags(IEnumerable<Guid> roots, bool includeRoots, bool touchCollectionMatches, CancellationToken cancellationToken)
        {
            var rootKeys = roots.Select(id => id.ToString("N")).ToHashSet(StringComparer.Ordinal);
            var ids = new List<Guid>();
            foreach (var (key, entry) in _cache)
            {
                var hit = (includeRoots && rootKeys.Contains(key)) || (entry.SeriesId != null && rootKeys.Contains(entry.SeriesId));
                if (hit && Guid.TryParse(key, out var id)) ids.Add(id);
            }

            return PatchCustomTagsOf(ids, touchCollectionMatches, cancellationToken);
        }

        /// <summary>Recompute and store CustomTags for cached items, reading their metadata in pages (see <see cref="PatchCustomTags"/>).</summary>
        private bool PatchCustomTagsOf(IReadOnlyList<Guid> ids, bool touchCollectionMatches, CancellationToken cancellationToken)
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
                    if (SameIds(tags, entry.CustomTags) && !(touchCollectionMatches && tags != null && Array.Exists(tags, CustomTagRuleSet.IsCollectionId))) continue;
                    var updated = entry.Clone();
                    updated.CustomTags = tags;
                    updated.LastUpdated = NextStamp();
                    RaiseMaxLastUpdated(updated.LastUpdated);
                    StoreEntry(key, updated);
                    changed = true;
                }
            }

            if (!changed) return false;
            // Changed entries reach clients as a delta (their LastUpdated); only removals and rebuild swaps change the version.
            TouchLastModified();
            ScheduleDebouncedSave();
            return true;
        }

        /// <summary>
        /// What decides an on-demand entry's Custom matches: the rules' match fingerprint
        /// (labels and icons excluded) and whether collections count (cache on).
        /// </summary>
        internal string CustomTagMatchFingerprint => (ServerModeEnabled ? "c|" : "t|") + CurrentCustomTagMatcher().Fingerprint;

        /// <summary>
        /// An on-demand entry matched again under the current Custom rules (tags and
        /// collections only, no media reads): the same instance when its matches are unchanged.
        /// </summary>
        internal TagCacheEntry RematchCustomTags(BaseItem item, TagCacheEntry entry)
        {
            var series = item is MediaBrowser.Controller.Entities.TV.Season or MediaBrowser.Controller.Entities.TV.Episode ? GetParentSeries(item) : null;
            var tags = CustomTagsFor(item, series);
            if (SameIds(tags, entry.CustomTags)) return entry;
            var copy = entry.Clone();
            copy.CustomTags = tags;
            return copy;
        }

        /// <summary>
        /// After a configuration save or a snapshot load: when what the rules match differs
        /// from what the cache was computed under, re-match every entry in the background
        /// (once queued, later calls wait for it).
        /// </summary>
        internal void QueueCustomTagRefreshIfStale()
        {
            if (!ServerModeEnabled) return;
            var wanted = CurrentCustomTagMatcher().Fingerprint;
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
            var fingerprint = matcher.Fingerprint;
            if (fingerprint == _customTagsFingerprint) return;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            lock (_collectionsLock)
            {
                _collections = ReadCollections(matcher);
            }

            var ids = _cache.Keys.Select(key => Guid.TryParse(key, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).ToList();
            PatchCustomTagsOf(ids, touchCollectionMatches: false, CancellationToken.None);
            if (ShouldAbortCacheWork) return;
            _customTagsFingerprint = fingerprint;
            // Every entry was matched against a fresh read.
            _collectionMatchesUnreconciled = false;
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
