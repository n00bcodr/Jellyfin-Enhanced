using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>The tag data one poster is drawn from, already Spoiler Guard–stripped for its viewer.</summary>
    /// <param name="Entry">The (possibly stripped) tag-cache entry.</param>
    /// <param name="DataKey">Hash of everything here that can change the drawing (entry content and review data).</param>
    /// <param name="SpoilerStripped">True when Spoiler Guard removed something for this viewer.</param>
    /// <param name="Reviews">The viewer's user-review chip data.</param>
    public sealed record PosterTagRenderData(TagCacheEntry Entry, string DataKey, bool SpoilerStripped, PosterTagReviewSummary Reviews);

    /// <summary>
    /// The live tag data a variant token's data hash is checked against, kept so the composite is drawn from
    /// exactly the data that was validated (not from a re-read that may already have changed).
    /// </summary>
    /// <param name="Entry">The live, unstripped tag-cache entry.</param>
    /// <param name="Reviews">The viewer's user-review chip data for it.</param>
    /// <param name="PinnedHash">The 6-hex data hash a token pins for this data (never <see cref="PosterTagVariantToken.WeakDataHash"/>).</param>
    public sealed record PosterTagDataSnapshot(TagCacheEntry Entry, PosterTagReviewSummary Reviews, string PinnedHash);

    // Where native poster tags gets an item's tag data — the same data the web
    // overlays draw from with the server tag cache on (renderFromServerCache):
    //
    //   1. the live TagCacheService entry (one dictionary read), else
    //   2. an on-demand build with the cache's own derivation (cache off, or a
    //      new item the cache has not flushed yet), memoized because a
    //      Series/Season build scans every episode. Concurrency is bounded and
    //      identical builds are coalesced. Item events evict the memo for the
    //      item and its season/series.
    //
    // then Spoiler Guard's per-user strip (SpoilerTagDataStripper, the code
    // GET /tag-cache uses) and the user-review chip numbers.
    //
    // Visibility (library access, parental rating) is NOT decided here: callers
    // must only pass items they resolved with GetItemById<BaseItem>(id, user).
    public sealed class PosterTagDataProvider : IDisposable
    {
        private const int MaxMemoEntries = 4096;
        private static readonly TimeSpan MemoTtl = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan BuildWait = TimeSpan.FromSeconds(20);

        // Entries are replaced, never mutated (TagCacheEntry contract), so the
        // instance is a valid memo key for its content hash.
        private static readonly ConditionalWeakTable<TagCacheEntry, string> ContentHashes = new();

        private sealed record MemoEntry(TagCacheEntry? Entry, DateTime BuiltAt);

        private readonly TagCacheService _tagCache;
        private readonly ILibraryManager _libraryManager;
        private readonly SpoilerTagDataStripper _stripper;
        private readonly SpoilerUserResolver _spoilerResolver;
        private readonly PosterTagReviewRatings _reviews;
        private readonly Logger _logger;

        private readonly ConcurrentDictionary<Guid, MemoEntry> _memo = new();
        private readonly ConcurrentDictionary<Guid, Lazy<Task<TagCacheEntry?>>> _building = new();
        private readonly SemaphoreSlim _buildSlots = new(Math.Max(1, Environment.ProcessorCount / 2));

        // Bumped by every item event; a build that started before an event
        // (and may have read pre-change data) is returned but not memoized.
        // The bump + evictions and the check + publication each run under
        // _memoLock (short sections, never around a build), so an event can't
        // slip between a build's generation check and its write.
        private readonly object _memoLock = new();
        private long _memoGeneration;

        public PosterTagDataProvider(
            TagCacheService tagCache,
            ILibraryManager libraryManager,
            SpoilerTagDataStripper stripper,
            SpoilerUserResolver spoilerResolver,
            PosterTagReviewRatings reviews,
            Logger logger)
        {
            _tagCache = tagCache;
            _libraryManager = libraryManager;
            _stripper = stripper;
            _spoilerResolver = spoilerResolver;
            _reviews = reviews;
            _logger = logger;

            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemChanged;
        }

        /// <summary>
        /// The 6-hex data hash a variant token pins for an image owner, from the live tag cache entry
        /// (unstripped) and the viewer's review chip data; <see cref="PosterTagVariantToken.WeakDataHash"/>
        /// when the cache has no entry (cache off or not yet built). Cheap: no I/O.
        /// </summary>
        public string GetPinnedDataHash(Guid ownerId, JUser viewer)
            => GetPinnedSnapshot(ownerId, viewer)?.PinnedHash ?? PosterTagVariantToken.WeakDataHash;

        /// <summary>
        /// The live tag data (and the hash a token pins for it) for an image owner as <paramref name="viewer"/>
        /// sees it, or null when the tag cache has no entry (cache off or not yet built). Cheap: no I/O.
        /// </summary>
        public PosterTagDataSnapshot? GetPinnedSnapshot(Guid ownerId, JUser viewer)
        {
            if (!_tagCache.TryGetEntry(ownerId, out var entry)) return null;
            var reviews = _reviews.Get(entry, viewer);
            var hash = DataKey(entry, reviews).Substring(0, 6);
            // Never collide with the "not pinned" value.
            return new PosterTagDataSnapshot(entry, reviews, hash == PosterTagVariantToken.WeakDataHash ? "000001" : hash);
        }

        /// <summary>The live tag cache entry for an item, if any (no build).</summary>
        public bool TryGetCachedEntry(Guid itemId, out TagCacheEntry entry) => _tagCache.TryGetEntry(itemId, out entry);

        /// <summary>
        /// The render data for <paramref name="item"/> as <paramref name="user"/> sees it, or null when no
        /// entry exists or can be built. <paramref name="item"/> must come from a user-scoped lookup. With a
        /// <paramref name="snapshot"/> the entry and review data are taken from it (only the Spoiler Guard
        /// strip is applied), so the drawing matches the data a token was validated against.
        /// </summary>
        public async Task<PosterTagRenderData?> GetRenderDataAsync(HttpContext httpContext, BaseItem item, JUser user, PosterTagDataSnapshot? snapshot, CancellationToken cancellationToken)
        {
            TagCacheEntry entry;
            if (snapshot != null)
            {
                entry = snapshot.Entry;
            }
            else if (!_tagCache.TryGetEntry(item.Id, out entry))
            {
                var built = await GetOrBuildAsync(item, cancellationToken).ConfigureAwait(false);
                if (built == null) return null;
                entry = built;
            }

            var stripped = false;
            var policy = CreateSpoilerPolicy(httpContext, user);
            if (policy != null)
            {
                entry = _stripper.StripEntry(policy, user, item, entry, out stripped);
            }

            // Reviews key on TmdbId and Type, which the strip never touches, so
            // the snapshot's chip (computed on the unstripped entry) is the same.
            var reviews = snapshot?.Reviews ?? _reviews.Get(entry, user);
            return new PosterTagRenderData(entry, DataKey(entry, reviews), stripped, reviews);
        }

        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemChanged;
        }

        /// <summary>SHA-256 (hex) of an entry's content, ignoring its build timestamp. Memoized per instance.</summary>
        public static string ContentHash(TagCacheEntry entry)
            => ContentHashes.GetValue(entry, static e =>
            {
                var copy = e.Clone();
                copy.LastUpdated = 0;
                return Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(copy))).ToLowerInvariant();
            });

        private static string DataKey(TagCacheEntry entry, PosterTagReviewSummary reviews)
        {
            var input = ContentHash(entry) + "|r:"
                + (reviews.Count?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-") + ":"
                + (reviews.Average?.ToString("R", System.Globalization.CultureInfo.InvariantCulture) ?? "-");
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
        }

        // Spoiler state comes from SpoilerUserResolver's cached lenient read (the
        // image filters' source), not the controller's strict read: the image
        // path must never quarantine files. A corrupt file reads as empty state,
        // i.e. no strip — the same outcome the endpoints reach.
        private SpoilerTagStripPolicy? CreateSpoilerPolicy(HttpContext httpContext, JUser user)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (!SpoilerTagDataStripper.IsConfigured(cfg)) return null;
            return SpoilerTagDataStripper.CreatePolicy(cfg, _spoilerResolver.LoadUserState(httpContext, user.Id));
        }

        private async Task<TagCacheEntry?> GetOrBuildAsync(BaseItem item, CancellationToken cancellationToken)
        {
            var now = DateTime.UtcNow;
            if (_memo.TryGetValue(item.Id, out var memo) && now - memo.BuiltAt < MemoTtl) return memo.Entry;

            var mine = new Lazy<Task<TagCacheEntry?>>(() => BuildAsync(item), LazyThreadSafetyMode.ExecutionAndPublication);
            var leader = _building.GetOrAdd(item.Id, mine);
            var task = leader.Value;
            if (ReferenceEquals(leader, mine))
            {
                _ = task.ContinueWith(
                    _ => _building.TryRemove(new KeyValuePair<Guid, Lazy<Task<TagCacheEntry?>>>(item.Id, mine)),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }

            return await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        // Runs detached from any one request (a waiter leaving must not cancel
        // the build the others are waiting for).
        private async Task<TagCacheEntry?> BuildAsync(BaseItem item)
        {
            if (!await _buildSlots.WaitAsync(BuildWait).ConfigureAwait(false))
            {
                _logger.Debug($"Native poster tags: tag data build for {item.Id} timed out waiting for a slot.");
                return null;
            }

            try
            {
                var generation = Interlocked.Read(ref _memoGeneration);
                var entry = await Task.Run(() => _tagCache.BuildEntryOnDemand(item)).ConfigureAwait(false);
                lock (_memoLock)
                {
                    if (generation == _memoGeneration)
                    {
                        if (_memo.Count >= MaxMemoEntries) TrimMemo();
                        _memo[item.Id] = new MemoEntry(entry, DateTime.UtcNow);
                    }
                }

                return entry;
            }
            catch (Exception ex)
            {
                _logger.Warning($"Native poster tags: tag data build failed for {item.Id}: {ex.Message}");
                return null;
            }
            finally
            {
                _buildSlots.Release();
            }
        }

        private void TrimMemo()
        {
            // Oldest quarter out; rare (only on a full memo).
            foreach (var key in _memo.OrderBy(kvp => kvp.Value.BuiltAt).Take(MaxMemoEntries / 4).Select(kvp => kvp.Key).ToList())
            {
                _memo.TryRemove(key, out _);
            }
        }

        // An episode change can change its season's and series' entries (quality
        // source, language union), mirroring TagCacheMonitor.
        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item == null || (_memo.IsEmpty && _building.IsEmpty)) return;
            lock (_memoLock)
            {
                _memoGeneration++;
                _memo.TryRemove(e.Item.Id, out _);
                switch (e.Item)
                {
                    case Episode episode:
                        if (episode.SeasonId != Guid.Empty) _memo.TryRemove(episode.SeasonId, out _);
                        if (episode.SeriesId != Guid.Empty) _memo.TryRemove(episode.SeriesId, out _);
                        break;
                    case Season season:
                        if (season.SeriesId != Guid.Empty) _memo.TryRemove(season.SeriesId, out _);
                        break;
                }
            }
        }
    }
}
