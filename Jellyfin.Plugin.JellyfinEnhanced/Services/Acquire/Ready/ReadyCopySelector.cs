using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready
{
    /// <summary>The final check of one exact version for one person.</summary>
    public enum ReadyVersionCheck
    {
        /// <summary>The person can open it, it is a real file and a playlist can hold it.</summary>
        Ok,

        /// <summary>The person can't open it (library access, parental limits, a deleted or disabled account).</summary>
        NoAccess,

        /// <summary>Not a real file (virtual, a placeholder, a missing path).</summary>
        NotPhysical,

        /// <summary>Jellyfin can't put it in a playlist (an extra, a folder).</summary>
        NotInsertable,
    }

    /// <summary>Jellyfin's side of the final per-person checks (tests fake it).</summary>
    public interface IReadyLibrary
    {
        /// <summary>The final check of an exact version item for a person (a user-scoped Jellyfin lookup).</summary>
        /// <param name="userId">The person.</param>
        /// <param name="playableItemId">The exact version item.</param>
        /// <returns>The outcome.</returns>
        ReadyVersionCheck Check(Guid userId, Guid playableItemId);

        /// <summary>True when the person has watched the item (Jellyfin's Played; resume progress is not watched).</summary>
        /// <param name="userId">The person.</param>
        /// <param name="itemId">Item.</param>
        /// <returns>Watched.</returns>
        bool Played(Guid userId, Guid itemId);
    }

    /// <summary>
    /// A person's Hidden Content rules as the Ready playlist applies them (the library surface, as Hidden Content does on
    /// library pages, D46). A title-level rule (a typed TMDB rule, or a rule on a movie's or series' own item: Hidden Content
    /// keys those to the title) hides every copy of the title; a rule on one exact item (an episode, a version, another
    /// item) or on one physical series hides only what it names, so another copy can still be chosen.
    /// </summary>
    public sealed class ReadyHides
    {
        private readonly HashSet<string> _items;
        private readonly HashSet<string> _series;
        private readonly HashSet<string> _titles;
        private readonly HashSet<string> _titleItems;

        /// <summary>
        /// Rules: hidden item ids (that item only), hidden series item ids (that series' episodes), hidden typed TMDB title
        /// keys (<c>movie:tmdb:N</c>, <c>tv:tmdb:N</c>) and the item ids of movie or series rules (their whole title).
        /// </summary>
        public ReadyHides(IEnumerable<Guid> items, IEnumerable<Guid> series, IEnumerable<string> titles, IEnumerable<Guid>? titleItems = null)
        {
            _items = items.Select(ReadyPlaylistStore.Id).ToHashSet(StringComparer.Ordinal);
            _series = series.Select(ReadyPlaylistStore.Id).ToHashSet(StringComparer.Ordinal);
            _titles = titles.ToHashSet(StringComparer.Ordinal);
            _titleItems = (titleItems ?? Array.Empty<Guid>()).Select(ReadyPlaylistStore.Id).ToHashSet(StringComparer.Ordinal);
        }

        /// <summary>No rules (Hidden Content off, or nothing hidden).</summary>
        public static ReadyHides None { get; } = new(Array.Empty<Guid>(), Array.Empty<Guid>(), Array.Empty<string>());

        /// <summary>
        /// True when a title-level rule hides the title: a TMDB rule on any of its keys, or a movie or series rule on any of
        /// its copies (the copy's item or its series).
        /// </summary>
        public bool TitleHidden(IEnumerable<TitleKey> titleKeys, IEnumerable<(Guid ItemId, Guid? SeriesId)> copies)
        {
            foreach (var key in titleKeys)
            {
                if (key.Provider == "tmdb" && key.NumericId is int id && _titles.Contains((key.IsMovie ? "movie" : "tv") + ":tmdb:" + id.ToString(CultureInfo.InvariantCulture))) return true;
            }

            if (_titleItems.Count == 0) return false;
            foreach (var (item, series) in copies)
            {
                if (_titleItems.Contains(ReadyPlaylistStore.Id(item)) || (series is Guid s && _titleItems.Contains(ReadyPlaylistStore.Id(s)))) return true;
            }

            return false;
        }

        /// <summary>True when a rule hides this copy itself: its item, its exact version, or its series.</summary>
        public bool CopyHidden(Guid itemId, Guid playableItemId, Guid? seriesId)
        {
            if (_items.Contains(ReadyPlaylistStore.Id(itemId)) || _items.Contains(ReadyPlaylistStore.Id(playableItemId))) return true;
            return seriesId is Guid series && (_series.Contains(ReadyPlaylistStore.Id(series)) || _items.Contains(ReadyPlaylistStore.Id(series)));
        }

        /// <summary>True when a rule hides the title (any of its keys), the item or its series (one item, as a message names it).</summary>
        public bool Hidden(IEnumerable<TitleKey> titleKeys, Guid itemId, Guid? seriesId)
            => TitleHidden(titleKeys, new[] { (itemId, seriesId) }) || CopyHidden(itemId, itemId, seriesId);
    }

    /// <summary>A person's Hidden Content rules (tests fake it).</summary>
    public interface IReadyPrivacy
    {
        /// <summary>The person's rules for the library surface, or null when they can't be read now (nothing changes until they can).</summary>
        /// <param name="userId">The person.</param>
        /// <returns>Rules, or null.</returns>
        ReadyHides? Load(Guid userId);
    }

    /// <summary>One reconciliation's selection.</summary>
    /// <param name="Candidates">The chosen entries, in playlist order (one per interest and content coordinate).</param>
    /// <param name="Desired">The distinct exact versions to hold, in playlist order (capped).</param>
    /// <param name="Rows">Entry rows to write.</param>
    /// <param name="Removed">Entry rows to delete (their interest is gone).</param>
    public sealed record ReadySelection(IReadOnlyList<ReadyCandidate> Candidates, IReadOnlyList<Guid> Desired, IReadOnlyList<ReadyEntryRow> Rows, IReadOnlyList<(string Interest, string Part)> Removed);

    /// <summary>
    /// Picks what a person's Ready playlist holds, from their own interests:
    /// <list type="bullet">
    /// <item><description>Through <see cref="EditionAvailability"/>, per person (never the library context): the copies they can
    /// open, per source, each episode in its own physical series; a 4K interest waits for a 4K source, a standard one takes any
    /// playable copy (a known non-4K first; only non-4K with the administrator's switch), a generic follow takes a known
    /// standard copy, then 4K.</description></item>
    /// <item><description>Then a final check of the EXACT version: the person can open that item, it is a real file and a
    /// playlist can hold it; else the next equivalent is tried (never the logical item instead of its failed version).</description></item>
    /// <item><description>Never a series, season, virtual episode or placeholder. Content that arrived before the interest began
    /// isn't ready for it; an entry leaves when watched (any copy) or after the retention, for good for that interest; a
    /// Hidden Content rule leaves it out while the rule exists (a title-level rule every copy, a rule on one copy only that
    /// copy).</description></item>
    /// <item><description>Equivalents in a stable order (fit, then the version's id), independent of Jellyfin's enumeration;
    /// several interests may point at one version, the playlist holds it once, and standard and 4K stay separate.</description></item>
    /// </list>
    /// </summary>
    public sealed class ReadyCopySelector
    {
        /// <summary>The most versions a Ready playlist holds (the newest are kept).</summary>
        public const int MaxEntries = 500;

        private readonly EditionAvailability _editions;
        private readonly IReadyLibrary _library;
        private readonly TitleAliases? _aliases;

        /// <summary>Creates the selector.</summary>
        public ReadyCopySelector(EditionAvailability editions, IReadyLibrary library, TitleAliases? aliases)
        {
            _editions = editions;
            _library = library;
            _aliases = aliases;
        }

        /// <summary>Selects the person's entries now.</summary>
        /// <param name="viewer">The person (never the library context).</param>
        /// <param name="interests">Their own interests.</param>
        /// <param name="hides">Their Hidden Content rules.</param>
        /// <param name="existing">Their stored entries.</param>
        /// <param name="now">Now.</param>
        /// <param name="retentionDays">Days an entry stays.</param>
        /// <returns>The selection.</returns>
        public ReadySelection Select(StatusViewer viewer, IReadOnlyList<ReadyInterest> interests, ReadyHides hides, IReadOnlyList<ReadyEntryRow> existing, DateTimeOffset now, int retentionDays)
        {
            if (viewer.IsLibraryContext) throw new ArgumentException("The Ready playlist is chosen per person.", nameof(viewer));
            var stored = existing.ToDictionary(e => (e.Interest, e.Part));
            var scopes = new Dictionary<(string, Edition), IReadOnlyList<EditionHit>>();
            var candidates = new List<ReadyCandidate>();
            var rows = new List<ReadyEntryRow>();
            var retention = (long)TimeSpan.FromDays(retentionDays).TotalMilliseconds;
            var nowMs = now.ToUnixTimeMilliseconds();

            foreach (var interest in interests.Where(i => i.UserId == viewer.UserId))
            {
                var keys = Keys(interest.Title);
                foreach (var group in Hits(viewer, interest, scopes).GroupBy(h => ReadyCandidate.PartOf(h.Season, h.Episode)))
                {
                    var part = group.Key;
                    stored.TryGetValue((interest.Id, part), out var row);
                    if (row != null && ReadyDisposition.Terminal(row.Disposition)) continue;
                    var ordered = group.DistinctBy(h => (h.ItemId, h.PlayableItemId)).OrderBy(h => Rank(interest, h)).ThenBy(h => ReadyPlaylistStore.Id(h.PlayableItemId), StringComparer.Ordinal).ToList();
                    var first = ordered[0];

                    // Ready from the content's first arrival (a generic follow: any version) or the edition's own source.
                    var arrival = interest.AnyEdition ? ordered.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Min() : first.Source.DateCreated;
                    var arrivedMs = arrival.HasValue ? Ms(arrival.Value) : nowMs;
                    if (row == null && arrivedMs < Ms(interest.Since)) continue;
                    var readyAt = row?.ReadyAt ?? arrivedMs;
                    var expiresAt = readyAt + retention;
                    var logical = ordered.Select(h => h.ItemId).Distinct().ToList();

                    string disposition = ReadyDisposition.Ready;
                    if (nowMs >= expiresAt) disposition = ReadyDisposition.Expired;
                    else if (logical.Any(id => _library.Played(viewer.UserId, id)) || ordered.Any(h => h.PlayableItemId != h.ItemId && _library.Played(viewer.UserId, h.PlayableItemId))) disposition = ReadyDisposition.Watched;
                    if (disposition != ReadyDisposition.Ready)
                    {
                        rows.Add(new ReadyEntryRow(interest.Id, part, interest.Title.ToString(), interest.EditionName, first.ItemId, first.SeriesId, row?.PlayableItemId, readyAt, expiresAt, disposition));
                        continue;
                    }

                    // A title-level rule hides every copy; a rule on one copy leaves the others (as on library pages).
                    if (hides.TitleHidden(keys, ordered.Select(h => (h.ItemId, h.SeriesId)))) continue;
                    var chosen = ordered.FirstOrDefault(h => !hides.CopyHidden(h.ItemId, h.PlayableItemId, h.SeriesId) && _library.Check(viewer.UserId, h.PlayableItemId) == ReadyVersionCheck.Ok);
                    if (chosen == null) continue;
                    rows.Add(new ReadyEntryRow(interest.Id, part, interest.Title.ToString(), interest.EditionName, chosen.ItemId, chosen.SeriesId, chosen.PlayableItemId, readyAt, expiresAt, ReadyDisposition.Ready));
                    candidates.Add(new ReadyCandidate(interest, part, chosen.ItemId, chosen.SeriesId, chosen.PlayableItemId, chosen.Season, chosen.Episode, DateTimeOffset.FromUnixTimeMilliseconds(readyAt).UtcDateTime));
                }
            }

            var live = interests.Select(i => i.Id).ToHashSet(StringComparer.Ordinal);
            var removed = existing.Where(e => !live.Contains(e.Interest)).Select(e => (e.Interest, e.Part)).ToList();
            var ordered2 = Order(candidates);
            var desired = ordered2.Select(c => c.PlayableItemId).Distinct().ToList();
            if (desired.Count > MaxEntries)
            {
                var keep = ordered2.GroupBy(c => c.PlayableItemId).OrderByDescending(g => g.Max(c => c.ReadyAt)).ThenBy(g => ReadyPlaylistStore.Id(g.Key), StringComparer.Ordinal).Take(MaxEntries).Select(g => g.Key).ToHashSet();
                desired = desired.Where(keep.Contains).ToList();
                ordered2 = ordered2.Where(c => keep.Contains(c.PlayableItemId)).ToList();
            }

            return new ReadySelection(ordered2, desired, rows, removed);
        }

        // Playlist order: titles with the newest arrival first; a series' episodes in season and episode order.
        private static List<ReadyCandidate> Order(List<ReadyCandidate> candidates)
            => candidates.GroupBy(c => c.Interest.Title.ToString())
                .OrderByDescending(g => g.Max(c => c.ReadyAt)).ThenBy(g => g.Key, StringComparer.Ordinal)
                .SelectMany(g => g.OrderBy(c => c.Season ?? -1).ThenBy(c => c.Episode ?? -1).ThenBy(c => ReadyPlaylistStore.Id(c.PlayableItemId), StringComparer.Ordinal))
                .ToList();

        // The interest's qualifying sources (memoized per scope and edition within one selection).
        private IEnumerable<EditionHit> Hits(StatusViewer viewer, ReadyInterest interest, Dictionary<(string, Edition), IReadOnlyList<EditionHit>> scopes)
        {
            var editions = interest.AnyEdition
                ? (_editions.StandardNeedsNonFourK ? new[] { Edition.Standard, Edition.FourK } : new[] { Edition.Standard })
                : new[] { interest.FourK ? Edition.FourK : Edition.Standard };
            var keys = new List<TitleKey>();
            if (interest.Title.IsMovie || interest.WholeTitle) keys.Add(interest.Title);
            else
            {
                keys.AddRange(interest.Seasons.Distinct().Select(s => interest.Title.WithSeason(s)));
                keys.AddRange(interest.Episodes.Distinct().Select(e => interest.Title.WithEpisode(e.Season, e.Episode)));
            }

            foreach (var key in keys)
            {
                foreach (var edition in editions)
                {
                    var id = (key.ToString(), edition);
                    if (!scopes.TryGetValue(id, out var hits)) scopes[id] = hits = _editions.Scope(viewer, key, edition);
                    foreach (var hit in hits) yield return hit;
                }
            }
        }

        // Fit: a 4K interest takes 4K sources only (all equal); a standard one prefers a known non-4K source; a generic follow
        // prefers a known standard source, then 4K, then a source Jellyfin hasn't read yet.
        private static int Rank(ReadyInterest interest, EditionHit hit)
        {
            if (interest.FourK && !interest.AnyEdition) return 0;
            var known = hit.Source.Width is > 0 || hit.Source.Height is > 0;
            var fourK = EditionAvailability.IsFourK(hit.Source.Width, hit.Source.Height);
            if (!known) return 2;
            return fourK ? 1 : 0;
        }

        private IReadOnlyList<TitleKey> Keys(TitleKey title) => new[] { title }.Concat(_aliases?.Of(title) ?? (IReadOnlyList<TitleKey>)Array.Empty<TitleKey>()).ToList();

        private static long Ms(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
    }
}
