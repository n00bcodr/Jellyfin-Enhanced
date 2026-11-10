using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services
{
    // Collection language flags follow their members. A BoxSet has no streams of its own: its
    // languages are the union of its linked Movie and Series members', and Jellyfin raises no
    // event for the BoxSet when only a member's file changes or a member is deleted. So each
    // collection records the members its languages were built from (saved with the snapshot),
    // and a member whose languages change, or which is removed, queues the collections built
    // from it. TagCacheService.cs keeps only the call sites.
    public partial class TagCacheService
    {
        // Keys of Movie and Series entries whose language facts changed (false), or which
        // were removed (true), since the collections linking to them were last queued (see
        // QueueCollectionsOfChangedMembers). A BoxSet's languages are its members'
        // (GetCollectionLanguages), and Jellyfin raises no event for the BoxSet when
        // only a member's file changes.
        private readonly ConcurrentDictionary<string, bool> _collectionMemberChanges = new(StringComparer.Ordinal);

        // The Movie and Series members each collection's languages were last built from
        // (GetCollectionLanguages), by collection key, saved with the snapshot. Matching a
        // member change against it needs no collection lookup, and still finds a member
        // Jellyfin has already unlinked: Jellyfin 12 deletes a removed item's link rows, so
        // a collection reloaded afterwards no longer names it.
        private readonly ConcurrentDictionary<string, Guid[]> _collectionMembers = new(StringComparer.Ordinal);
        // 1 when _collectionMembers changed since the last save: a flush whose collections
        // rebuilt to the same languages still has to save what they are built from.
        private int _collectionMembersDirty;
        // Per collection, the language fingerprints of the members without an entry of their own
        // (in an excluded library) it was built from: their re-saves are frequent, and only a
        // change from what a collection was built with counts. Kept per collection, so a member
        // shared by several collections is compared with what each of them read.
        private readonly ConcurrentDictionary<string, IReadOnlyDictionary<Guid, string>> _collectionEntrylessLanguages = new(StringComparer.Ordinal);
        // The reverse of _collectionMembers: member id → keys of the collections built from it.
        // Written only through SetCollectionMembers/ForgetCollection, under _collectionIndexLock.
        // Values are replaced, never changed in place, so readers outside the lock see a whole array.
        private readonly ConcurrentDictionary<Guid, string[]> _memberCollections = new();
        private readonly object _collectionIndexLock = new();
        // Collections not built since a snapshot without CollectionMembers was loaded. Until
        // they are, the snapshot is saved without the index, so a restart repeats the repair.
        private readonly ConcurrentDictionary<string, byte> _collectionsAwaitingBuild = new(StringComparer.Ordinal);
        // While a full build runs its collection pass, the series entries it has just built.
        private volatile ConcurrentDictionary<string, TagCacheEntry>? _buildingCache;

        /// <summary>
        /// The BoxSets of a full build, built after everything else: their languages include
        /// their series members', read from this build, and a member changed after its own
        /// entry was built then differs from it, so its next rebuild queues the collection.
        /// </summary>
        private IReadOnlyList<Guid> CollectionIdsForFullBuild() => TaggableTypes.Contains(BaseItemKind.BoxSet)
            ? _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.BoxSet },
                TopParentIds = IncludedLibraryIds(),
                IsVirtualItem = false,
                Recursive = true
            })
            : new List<Guid>();

        /// <summary>
        /// After a full build is published: drop the collections it no longer has (deleted while
        /// nothing listened) from the member index and from the one-time repair still waiting
        /// for them. Collections the build kept stay waiting until one of their builds records them.
        /// </summary>
        private void ForgetCollectionsMissingFrom(ConcurrentDictionary<string, TagCacheEntry> newCache)
        {
            foreach (var collectionKey in _collectionMembers.Keys)
            {
                if (!newCache.TryGetValue(collectionKey, out var kept) || kept.Type != nameof(BaseItemKind.BoxSet)) ForgetCollection(collectionKey);
            }

            foreach (var collectionKey in _collectionsAwaitingBuild.Keys)
            {
                if ((!newCache.TryGetValue(collectionKey, out var kept) || kept.Type != nameof(BaseItemKind.BoxSet))
                    && _collectionsAwaitingBuild.TryRemove(collectionKey, out _) && _collectionsAwaitingBuild.IsEmpty)
                {
                    Interlocked.Exchange(ref _collectionMembersDirty, 1);
                }
            }
        }

        /// <summary>
        /// After a reconcile: a collection's own save time does not move when only a member
        /// changes, so queue the collections of the members it rebuilt, swept or repaired.
        /// Members with no entry of their own (in an excluded library) are not among the items a
        /// reconcile reads: each is checked against what its collections were built from, which
        /// also catches one deleted or changed while nothing was listening.
        /// </summary>
        private void QueueCollectionsAfterReconcile()
        {
            var entryless = _collectionMembers.Values.SelectMany(members => members)
                .Where(member => !_cache.ContainsKey(member.ToString("N").ToLowerInvariant()))
                .ToHashSet();
            foreach (var member in entryless)
            {
                try
                {
                    if (_libraryManager.GetItemById<BaseItem>(member) is { } item) RecordEntrylessMember(item);
                    else _collectionMemberChanges[member.ToString("N").ToLowerInvariant()] = true;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to check collection member {member}: {ex.Message}");
                    _collectionMemberChanges.TryAdd(member.ToString("N").ToLowerInvariant(), false);
                }
            }

            QueueCollectionsOfChangedMembers();
        }

        /// <summary>
        /// A rebuilt item in a library excluded from the tag cache has no entry of its own, but
        /// its collections still take its languages (<see cref="GetCollectionLanguages"/> reads
        /// every member): record a real change only. Drops an entry it had before the exclusion;
        /// the item itself still exists, so this is not the deleted-member path of RemoveEntry.
        /// </summary>
        private bool RemoveExcludedEntry(BaseItem item, BaseItemKind kind, Guid id)
        {
            if (kind is BaseItemKind.Movie or BaseItemKind.Series) RecordEntrylessMember(item);
            return TryRemoveEntry(id.ToString("N").ToLowerInvariant(), out _);
        }

        /// <summary>An entry left the cache: a member's collections must follow, and a collection leaves the index.</summary>
        private void NoteRemovedEntry(string key, TagCacheEntry? removed)
        {
            if (IsCollectionMemberType(removed?.Type)) _collectionMemberChanges[key] = true;
            else if (removed?.Type == nameof(BaseItemKind.BoxSet))
            {
                ForgetCollection(key);
                _collectionsAwaitingBuild.TryRemove(key, out _);
            }
        }

        /// <summary>
        /// Restore the member index from a loaded snapshot and queue the collections whose
        /// members changed before the last shutdown. A snapshot without the index was written
        /// before collections followed their members (or before that one-time repair finished):
        /// every collection is rebuilt once, which repairs any left stale and records what it is
        /// built from.
        /// </summary>
        private void LoadCollectionMembers(Dictionary<string, string[]>? savedMembers, Dictionary<string, bool>? savedChanges)
        {
            lock (_collectionIndexLock)
            {
                _collectionMembers.Clear();
                _memberCollections.Clear();
                _collectionEntrylessLanguages.Clear();
            }

            _collectionsAwaitingBuild.Clear();
            if (savedMembers != null)
            {
                foreach (var (key, ids) in savedMembers)
                {
                    SetCollectionMembers(key, (ids ?? Array.Empty<string>())
                        .Select(id => Guid.TryParse(id, out var member) ? member : Guid.Empty)
                        .Where(member => member != Guid.Empty).ToArray());
                }
            }
            else
            {
                foreach (var collectionId in CachedCollectionIds())
                {
                    _collectionsAwaitingBuild[collectionId.ToString("N")] = 0;
                    EnqueueUpdate(collectionId);
                }
            }

            // Members recorded before the last shutdown whose collections were not rebuilt.
            foreach (var (key, removed) in savedChanges ?? new Dictionary<string, bool>())
            {
                if (removed) _collectionMemberChanges[key] = true;
                else _collectionMemberChanges.TryAdd(key, false);
            }

            QueueCollectionsOfChangedMembers();
        }

        /// <summary>
        /// The member index as a snapshot saves it. Left out (null) until the one-time repair
        /// after an older snapshot has rebuilt every collection, so a restart before then repeats it.
        /// </summary>
        private Dictionary<string, string[]>? CollectionMembersToSave() => !_collectionsAwaitingBuild.IsEmpty ? null : _collectionMembers
            .Where(pair => _cache.TryGetValue(pair.Key, out var entry) && entry.Type == nameof(BaseItemKind.BoxSet))
            .ToDictionary(pair => pair.Key, pair => pair.Value.Select(id => id.ToString("N")).ToArray(), StringComparer.Ordinal);

        /// <summary>Whether entries of this type feed a BoxSet's language union (see <see cref="GetCollectionLanguages"/>).</summary>
        /// <param name="type">A cache entry's Type.</param>
        private static bool IsCollectionMemberType(string? type) =>
            type == nameof(BaseItemKind.Movie) || type == nameof(BaseItemKind.Series);

        /// <summary>Whether two entries carry the same facts a collection's language union reads.</summary>
        private static bool SameLanguageFacts(TagCacheEntry a, TagCacheEntry b) =>
            SameStrings(a.AudioLanguages, b.AudioLanguages)
            && SameStrings(a.SubtitleLanguages, b.SubtitleLanguages)
            && SameStrings(a.SdhSubtitleLanguages, b.SdhSubtitleLanguages);

        /// <summary>Ordinal sequence equality, a missing array counting as empty.</summary>
        private static bool SameStrings(string[]? a, string[]? b) =>
            ReferenceEquals(a, b) || (a ?? Array.Empty<string>()).SequenceEqual(b ?? Array.Empty<string>(), StringComparer.Ordinal);

        /// <summary>Ids of the BoxSets in the cache (collections in excluded libraries have no entry).</summary>
        private List<Guid> CachedCollectionIds()
        {
            var ids = new List<Guid>();
            foreach (var (key, entry) in _cache)
            {
                if (entry.Type == nameof(BaseItemKind.BoxSet) && Guid.TryParse(key, out var id)) ids.Add(id);
            }

            return ids;
        }

        /// <summary>
        /// Queue the cached collections built from a Movie or Series recorded in
        /// <see cref="_collectionMemberChanges"/>, so a collection's language union follows
        /// a member's file change or removal. Called after a batch has been applied, so the
        /// queued collections rebuild from their members' new entries in the next flush.
        /// </summary>
        private void QueueCollectionsOfChangedMembers()
        {
            foreach (var collectionId in TakeCollectionsOfChangedMembers() ?? new List<Guid>()) EnqueueUpdate(collectionId);
        }

        /// <summary>
        /// Drain <see cref="_collectionMemberChanges"/> and return the cached collections built
        /// from one of those members (see <see cref="_collectionMembers"/>), or null when none
        /// was recorded. A collection that can't be checked counts as one of them.
        /// </summary>
        private List<Guid>? TakeCollectionsOfChangedMembers()
        {
            if (_collectionMemberChanges.IsEmpty) return null;
            var members = new HashSet<Guid>();
            var anyRemoved = false;
            foreach (var key in _collectionMemberChanges.Keys)
            {
                // Removed one by one: a member recorded meanwhile stays for the next call.
                if (!_collectionMemberChanges.TryRemove(key, out var removed) || !Guid.TryParse(key, out var id)) continue;
                members.Add(id);
                anyRemoved |= removed;
            }

            if (members.Count == 0) return null;
            var found = new List<Guid>();
            foreach (var member in members)
            {
                if (!_memberCollections.TryGetValue(member, out var collections)) continue;
                foreach (var collectionKey in collections)
                {
                    if (_cache.TryGetValue(collectionKey, out var entry) && entry.Type == nameof(BaseItemKind.BoxSet)
                        && Guid.TryParse(collectionKey, out var collectionId) && !found.Contains(collectionId))
                    {
                        found.Add(collectionId);
                    }
                }
            }

            foreach (var collectionId in CachedCollectionIds())
            {
                if (_collectionMembers.ContainsKey(collectionId.ToString("N"))) continue;

                // Not built since its members were recorded: check its links.
                try
                {
                    if (_libraryManager.GetItemById<BaseItem>(collectionId) is Folder folder && LinksAny(folder, members, anyRemoved)) found.Add(collectionId);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to check collection {collectionId} for changed members: {ex.Message}");
                    found.Add(collectionId);
                }
            }

            return found;
        }

        /// <summary>
        /// Whether a collection may link to any of <paramref name="members"/>. A link naming a
        /// member's id matches, including one whose item has been deleted. A link without an id
        /// is either by path, resolved here, or one Jellyfin could not resolve (it clears the id
        /// of a link whose item is gone), which may be a removed member when
        /// <paramref name="anyRemoved"/> is set.
        /// </summary>
        private static bool LinksAny(Folder folder, HashSet<Guid> members, bool anyRemoved)
        {
            var unresolved = false;
            foreach (var link in folder.LinkedChildren ?? Array.Empty<LinkedChild>())
            {
                if (link == null) continue;
                if (link.ItemId is { } id && id != Guid.Empty)
                {
                    if (members.Contains(id)) return true;
                }
                else
                {
                    unresolved = true;
                }
            }

            if (!unresolved) return false;
            return anyRemoved || folder.GetLinkedChildren().Any(child => child != null && members.Contains(child.Id));
        }

        /// <summary>Whether a cached collection's languages were built from <paramref name="id"/>.</summary>
        private bool IsCollectionMember(Guid id) =>
            _memberCollections.TryGetValue(id, out var collections) && collections.Length > 0;

        /// <summary>
        /// Set what a collection was built from, keeping <see cref="_memberCollections"/> in step.
        /// Returns whether the members differ from those recorded before.
        /// </summary>
        private bool SetCollectionMembers(string collectionKey, Guid[] members)
        {
            lock (_collectionIndexLock)
            {
                var before = _collectionMembers.TryGetValue(collectionKey, out var previous) ? previous : null;
                if (before != null && before.SequenceEqual(members)) return false;
                foreach (var member in before ?? Array.Empty<Guid>())
                {
                    if (Array.IndexOf(members, member) < 0) UnlinkMember(member, collectionKey);
                }

                foreach (var member in members)
                {
                    var current = _memberCollections.TryGetValue(member, out var keys) ? keys : Array.Empty<string>();
                    if (Array.IndexOf(current, collectionKey) < 0) _memberCollections[member] = [.. current, collectionKey];
                }

                _collectionMembers[collectionKey] = members;
                return true;
            }
        }

        /// <summary>Remove one collection from a member's reverse-index entry. Under _collectionIndexLock.</summary>
        private void UnlinkMember(Guid member, string collectionKey)
        {
            if (!_memberCollections.TryGetValue(member, out var keys) || Array.IndexOf(keys, collectionKey) < 0) return;
            var rest = Array.FindAll(keys, key => key != collectionKey);
            if (rest.Length == 0) _memberCollections.TryRemove(member, out _);
            else _memberCollections[member] = rest;
        }

        /// <summary>Drop a collection from the member index (it was removed from the cache).</summary>
        private void ForgetCollection(string collectionKey)
        {
            lock (_collectionIndexLock)
            {
                if (_collectionMembers.TryRemove(collectionKey, out var members))
                {
                    foreach (var member in members) UnlinkMember(member, collectionKey);
                }

                _collectionEntrylessLanguages.TryRemove(collectionKey, out _);
            }
        }

        /// <summary>
        /// Queued work discarded while the cache is off: a queued collection rebuild has no
        /// save time of its own for the re-enable reconcile to find, so its members are
        /// recorded again (<see cref="_collectionMemberChanges"/> outlives the release, and
        /// the reconcile queues their collections).
        /// </summary>
        private void KeepCollectionRebuilds(IReadOnlyList<(Guid Id, bool Removed)> discarded)
        {
            foreach (var (id, removed) in discarded)
            {
                if (removed || !_collectionMembers.TryGetValue(id.ToString("N").ToLowerInvariant(), out var members)) continue;
                foreach (var member in members) _collectionMemberChanges.TryAdd(member.ToString("N").ToLowerInvariant(), false);
            }
        }

        /// <summary>
        /// Union of audio languages, and of subtitle languages, across a BoxSet's
        /// linked movie and series members.
        /// LinkedChildren is a manual join (not a parent pointer), so this is
        /// resolved live rather than tracked per member. Membership edits re-enqueue
        /// the BoxSet itself (see TagCacheMonitor); a member whose languages change or
        /// which is removed queues the collections built from it (see
        /// QueueCollectionsOfChangedMembers and <see cref="_collectionMembers"/>, which
        /// this records).
        /// </summary>
        private (string[] Audio, string[] Subtitles, string[] SdhSubtitles) GetCollectionLanguages(BaseItem collection, bool record = true)
        {
            try
            {
                if (collection is not Folder folder) return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());

                var languages = new HashSet<string>();
                var subtitles = new HashSet<string>();
                var sdh = new HashSet<string>();
                var members = new List<Guid>();
                var entryless = new Dictionary<Guid, string>();
                foreach (var member in folder.GetLinkedChildren())
                {
                    if (member.GetBaseItemKind() is not (BaseItemKind.Movie or BaseItemKind.Series)) continue;
                    members.Add(member.Id);
                    var (memberAudio, memberSubtitles, memberSdh, hasEntry) = MemberLanguages(member);
                    languages.UnionWith(memberAudio);
                    subtitles.UnionWith(memberSubtitles);
                    sdh.UnionWith(memberSdh);
                    if (!hasEntry) entryless[member.Id] = LanguageFingerprint(memberAudio, memberSubtitles, memberSdh);
                }

                // Only a build whose entry the cache stores records what it read: an on-demand
                // build (a native poster) racing a load or a rebuild must not stand for it.
                if (!record) return (languages.ToArray(), subtitles.ToArray(), sdh.ToArray());
                var collectionKey = collection.Id.ToString("N").ToLowerInvariant();
                _collectionEntrylessLanguages[collectionKey] = entryless;
                if (SetCollectionMembers(collectionKey, members.ToArray()))
                {
                    Interlocked.Exchange(ref _collectionMembersDirty, 1);
                }

                if (_collectionsAwaitingBuild.TryRemove(collectionKey, out _) && _collectionsAwaitingBuild.IsEmpty)
                {
                    // The last collection of the one-time repair: the index can be saved now.
                    Interlocked.Exchange(ref _collectionMembersDirty, 1);
                }

                return (languages.ToArray(), subtitles.ToArray(), sdh.ToArray());
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to get collection languages for {collection.Id}: {ex.Message}");
                return (Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>());
            }
        }

        /// <summary>
        /// The audio, subtitle and SDH languages one Movie or Series member adds to a
        /// collection: a movie's own streams; a series' cache entry (from the full build in
        /// progress, else the published cache), or its episodes' streams when it has none
        /// (a series in an excluded library, or not built yet). <c>HasEntry</c> is false
        /// when the member has no cache entry of its own.
        /// </summary>
        private (IEnumerable<string> Audio, IEnumerable<string> Subtitles, IEnumerable<string> Sdh, bool HasEntry) MemberLanguages(BaseItem member)
        {
            var key = member.Id.ToString("N").ToLowerInvariant();
            if (member.GetBaseItemKind() == BaseItemKind.Movie)
            {
                var (streams, _, audio, _, subtitles) = ExtractMediaData(member);
                return (audio, subtitles, SubtitleAccessibility.Languages(streams), (_buildingCache ?? _cache).ContainsKey(key));
            }

            if ((_buildingCache ?? _cache).TryGetValue(key, out var seriesEntry) && seriesEntry.AudioLanguages != null)
            {
                return (seriesEntry.AudioLanguages, seriesEntry.SubtitleLanguages ?? Array.Empty<string>(), seriesEntry.SdhSubtitleLanguages ?? Array.Empty<string>(), true);
            }

            var audioSet = new HashSet<string>();
            var subtitleSet = new HashSet<string>();
            var sdhSet = new HashSet<string>();
            var episodes = _libraryManager.GetItemList(new InternalItemsQuery
            {
                ParentId = member.Id,
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                IsVirtualItem = false,
                Recursive = true
            });
            foreach (var episode in episodes)
            {
                var (episodeStreams, _, episodeLanguages, _, episodeSubtitles) = ExtractMediaData(episode);
                sdhSet.UnionWith(SubtitleAccessibility.Languages(episodeStreams));
                audioSet.UnionWith(episodeLanguages ?? Array.Empty<string>());
                subtitleSet.UnionWith(episodeSubtitles);
            }

            return (audioSet, subtitleSet, sdhSet, (_buildingCache ?? _cache).ContainsKey(key));
        }

        /// <summary>An order-independent key for a member's language facts.</summary>
        private static string LanguageFingerprint(IEnumerable<string> audio, IEnumerable<string> subtitles, IEnumerable<string> sdh) =>
            string.Join(",", audio.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)) + "|"
            + string.Join(",", subtitles.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)) + "|"
            + string.Join(",", sdh.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));

        /// <summary>
        /// Record a collection member that has no entry of its own when its languages differ
        /// from those any of its collections was last built with (or that collection did not
        /// read it as entry-less). Only for an item some cached collection was built from;
        /// reads its streams.
        /// </summary>
        private void RecordEntrylessMember(BaseItem item)
        {
            if (!_memberCollections.TryGetValue(item.Id, out var collections) || collections.Length == 0) return;
            var (audio, subtitles, sdh, _) = MemberLanguages(item);
            var fingerprint = LanguageFingerprint(audio, subtitles, sdh);
            foreach (var collectionKey in collections)
            {
                if (!_collectionEntrylessLanguages.TryGetValue(collectionKey, out var builtWith)
                    || !builtWith.TryGetValue(item.Id, out var before) || before != fingerprint)
                {
                    _collectionMemberChanges.TryAdd(item.Id.ToString("N").ToLowerInvariant(), false);
                    return;
                }
            }
        }
    }
}
