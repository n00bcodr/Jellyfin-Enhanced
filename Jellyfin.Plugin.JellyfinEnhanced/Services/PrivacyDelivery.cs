using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>The kind of a logged input change: an item's library facts, a user's watched state, a user's playback position.</summary>
internal enum PrivacyInputKind : byte
{
    Library,
    Watched,
    Progress,

    /// <summary>An item joined the library: it moves only answers that read the set of items under its series or season.</summary>
    Added,

    /// <summary>
    /// The first update of an item whose facts were never known since the start (no event or judgment read them): it
    /// moves an answer that read the item's facts only by the event log; an answer that recorded the facts it judged the
    /// item by compares them with the live item instead.
    /// </summary>
    FirstSeen,
}

/// <summary>
/// The item inputs of a privacy verdict, with revisions: a user's watched state and playback position, and the library's
/// ownership facts (an item's owner and extra kind, its series and season, a season's number, its TMDB key, a collection's
/// members, the item's presence). One process-wide log of their changes, each stamped with a tick; an attempt's read-set
/// (<see cref="PrivacyReadSet"/>) holds the inputs it read and is invalid when a change after its mark moves one of them. A
/// change is logged only when it changes a fact a verdict reads, compared with the fact as last known (remembered when an
/// event or a judgment read it); a fact never known before is unknown, so its first change is logged. Memos of verdict
/// inputs are invalidated by the same events (<see cref="LibraryChanged"/>, <see cref="CollectionChanged"/>).
/// </summary>
public static class PrivacyInputs
{
    /// <summary>How many changes the log keeps; an answer older than that many changes counts every input as changed.</summary>
    internal const int Capacity = 1 << 15;

    private const int MaxFacts = 250_000;

    /// <summary>The user-data fields a verdict reads: the watched state, and the playback position (null: not known).</summary>
    private readonly record struct Watch(bool Played, long? Position);

    private readonly record struct Change(long Tick, Guid User, Guid[] Items, PrivacyInputKind Kind);

    private static readonly Change[] _log = new Change[Capacity];
    private static readonly object _lock = new();
    private static long _tick;
    private static readonly ConditionalWeakTable<object, object> _observed = new();

    /// <summary>What the log knows of one host store's facts (the library's item facts, the user-data store's verdict fields).</summary>
    private sealed class Memory
    {
        public ConcurrentDictionary<Guid, PrivacyFacts> Facts { get; } = new();
        public ConcurrentDictionary<(Guid User, Guid Item), Watch> Watch { get; } = new();
    }

    private static readonly ConditionalWeakTable<object, Memory> _memory = new();
    private static readonly Memory _unhosted = new();

    /// <summary>The facts remembered of one host store (the instance whose events report them).</summary>
    private static Memory MemoryOf(object? host) => host == null ? _unhosted : _memory.GetValue(host, static _ => new Memory());

    /// <summary>Raised after a library change is logged, with the ids it can move: memos of ownership drop them.</summary>
    public static event Action<IReadOnlyCollection<Guid>>? LibraryChanged;

    /// <summary>Raised after a collection's members changed (or it left the library), with its id: membership memos drop it.</summary>
    public static event Action<Guid>? CollectionChanged;

    /// <summary>The tick of the latest logged change (an answer marks it before reading its inputs).</summary>
    public static long Now
    {
        get { lock (_lock) return _tick; }
    }

    /// <summary>Starts logging the host's input changes (once per manager instance; the services that judge items call it). Returns true.</summary>
    public static bool Observe(ILibraryManager? library, IUserDataManager? userData)
    {
        lock (_observed)
        {
            if (library != null && !_observed.TryGetValue(library, out _))
            {
                _observed.Add(library, library);
                library.ItemAdded += OnItemAdded;
                library.ItemUpdated += OnItemUpdated;
                library.ItemRemoved += OnItemRemoved;
            }
            if (userData != null && !_observed.TryGetValue(userData, out _))
            {
                _observed.Add(userData, userData);
                userData.UserDataSaved += OnUserDataSaved;
            }
        }
        return true;
    }

    private static Change[]? Since(long since)
    {
        lock (_lock)
        {
            if (_tick == since) return [];
            if (_tick - since >= Capacity) return null;
            var changes = new Change[_tick - since];
            for (var tick = since + 1; tick <= _tick; tick++) changes[tick - since - 1] = _log[tick % Capacity];
            return changes;
        }
    }

    /// <summary>
    /// Whether an input of an item <paramref name="judged"/> names changed after <paramref name="since"/>: one of the
    /// viewer's user-data changes, or a library change of its facts. When the log no longer reaches back that far, every
    /// input counts as changed. Without a viewer every user's changes count.
    /// </summary>
    public static bool ChangedSince(long since, Guid viewer, Func<Guid, bool> judged)
    {
        if (Since(since) is not { } changes) return true;
        foreach (var change in changes)
        {
            if (viewer != Guid.Empty && change.User != Guid.Empty && change.User != viewer) continue;
            foreach (var id in change.Items)
                if (judged(id)) return true;
        }
        return false;
    }

    /// <summary>Whether a change logged after <paramref name="since"/> moves an input <paramref name="reads"/> read.</summary>
    internal static bool ChangedSince(long since, PrivacyReadSet reads) => ChangedSince(since, reads, out _);

    /// <summary>As <see cref="ChangedSince(long, PrivacyReadSet)"/>, naming the change (diagnostics).</summary>
    internal static bool ChangedSince(long since, PrivacyReadSet reads, out string? which)
    {
        which = null;
        if (Since(since) is not { } changes) { which = "the input log no longer reaches back to the answer's start"; return true; }
        foreach (var change in changes)
            if (reads.Reads(change.Kind, change.User, change.Items, change.Tick))
            {
                which = change.Kind.ToString().ToLowerInvariant() + " change of " + string.Join(",", change.Items.Take(4).Select(i => i.ToString("N")));
                return true;
            }
        return false;
    }

    /// <summary>
    /// The ids whose ownership facts changed after <paramref name="since"/> (library changes only), or null when the log no
    /// longer reaches back that far (nothing resolved since then may be memoized).
    /// </summary>
    public static HashSet<Guid>? LibraryChangesSince(long since)
    {
        if (Since(since) is not { } changes) return null;
        var ids = new HashSet<Guid>();
        foreach (var change in changes)
            if (change.Kind is PrivacyInputKind.Library or PrivacyInputKind.FirstSeen) ids.UnionWith(change.Items);
        return ids;
    }

    /// <summary>Logs a change (also what the host's events log, for an input the plugin changes itself): a user's watched state, or with no user a library change.</summary>
    internal static void Record(Guid user, IEnumerable<Guid> ids) => Record(user == Guid.Empty ? PrivacyInputKind.Library : PrivacyInputKind.Watched, user, ids);

    private static void Record(PrivacyInputKind kind, Guid user, IEnumerable<Guid> ids)
    {
        var items = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        if (items.Length == 0) return;
        lock (_lock)
        {
            _tick++;
            _log[_tick % Capacity] = new Change(_tick, user, items, kind);
        }
        if (kind is PrivacyInputKind.Library or PrivacyInputKind.FirstSeen) LibraryChanged?.Invoke(items);
    }

    /// <summary>
    /// Remembers an item's facts as a judgment is about to read them (called BEFORE the judgment reads the item), when the
    /// log knows none yet: a later event compares with them, so a change the judgment may have missed is logged. Facts
    /// already known stay (the host's events keep them; a judgment holding another view of the same item, its stored row
    /// beside its live one, never overwrites them).
    /// </summary>
    internal static void Know(ILibraryManager? library, BaseItem item)
    {
        var facts = MemoryOf(library).Facts;
        if (facts.ContainsKey(item.Id)) return;
        if (facts.Count >= MaxFacts) facts.Clear();
        facts.TryAdd(item.Id, PrivacyFacts.Of(item));
    }

    /// <summary>
    /// The series the library last reported an episode or season under (its events and judgments keep it), or null when
    /// none is known: a derived copy of the item (a tag-cache entry) names the series it was built under, which a move
    /// since then leaves behind.
    /// </summary>
    internal static Guid? KnownSeries(ILibraryManager? library, Guid id)
        => MemoryOf(library).Facts.TryGetValue(id, out var facts) && facts.Series != Guid.Empty ? facts.Series : null;

    /// <summary>Remembers a user's data for an item as a judgment read it, when the log knows none yet (as <see cref="Know"/>).</summary>
    internal static void KnowWatched(IUserDataManager? store, Guid user, Guid item, UserItemData? data)
    {
        if (data == null || user == Guid.Empty) return;
        var watch = MemoryOf(store).Watch;
        if (watch.ContainsKey((user, item))) return;
        if (watch.Count >= MaxFacts) watch.Clear();
        watch.TryAdd((user, item), new Watch(data.Played, data.PlaybackPositionTicks));
    }

    /// <summary>
    /// Remembers the watched state a batch query established for each of <paramref name="items"/> (in
    /// <paramref name="played"/> or not; its position unknown), when the log knows none yet: the first save after it that
    /// leaves the watched state as it was is a progress save, not a watched change.
    /// </summary>
    internal static void KnowWatched(IUserDataManager? store, Guid user, IEnumerable<Guid> items, ISet<Guid> played)
    {
        if (user == Guid.Empty) return;
        var watch = MemoryOf(store).Watch;
        foreach (var item in items)
        {
            if (item == Guid.Empty || watch.ContainsKey((user, item))) continue;
            if (watch.Count >= MaxFacts) watch.Clear();
            watch.TryAdd((user, item), new Watch(played.Contains(item), null));
        }
    }

    /// <summary>
    /// Reconciles a watched state the host read for an answer it built (a DTO's user data): never known, it is remembered;
    /// different from what was remembered, it changed without the log seeing it, so the change is logged (with
    /// <paramref name="related"/>, the item's season and series) and every answer that read it is invalid.
    /// </summary>
    internal static void HostRead(IUserDataManager? store, Guid user, Guid item, bool played, IEnumerable<Guid> related)
    {
        if (user == Guid.Empty || item == Guid.Empty) return;
        var watch = MemoryOf(store).Watch;
        if (!watch.TryGetValue((user, item), out var known))
        {
            if (watch.Count >= MaxFacts) watch.Clear();
            watch.TryAdd((user, item), new Watch(played, null));
            return;
        }
        if (known.Played != played) Record(PrivacyInputKind.Watched, user, related.Prepend(item));
    }

    /// <summary>
    /// The ids an item's change can move: itself, its season, series and owner (before and after), a collection's members
    /// (on 10.11, an owner's extras too).
    /// (An extra's verdict follows its owner: the answers that judge an extra judge its owner too.)
    /// </summary>
    private static IEnumerable<Guid> Moved(BaseItem item, PrivacyFacts facts, PrivacyFacts? before)
    {
        yield return item.Id;
        yield return facts.Owner;
        yield return facts.Series;
        yield return facts.Season;
        if (before is { } old)
        {
            yield return old.Owner;
            yield return old.Series;
            yield return old.Season;
        }
        if (item is Folder { LinkedChildren: { } links })
            foreach (var link in links)
                if (link?.ItemId is { } member) yield return member;
#if JF10
        if (item.ExtraIds is { } extras)
            foreach (var extra in extras) yield return extra;
#endif
    }

    private static void Remember(object? host, Guid id, PrivacyFacts facts)
    {
        var known = MemoryOf(host).Facts;
        if (known.Count >= MaxFacts) known.Clear();
        known[id] = facts;
    }

    private static void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        // A new item moves no verdict of the items an answer judged; its facts are remembered so a later change of them is
        // logged. It does move what an answer read of the set it joins (the next unwatched episode of its series).
        if (e?.Item is not { } item) return;
        var facts = PrivacyFacts.Of(item);
        Remember(sender, item.Id, facts);
        Record(PrivacyInputKind.Added, Guid.Empty, Moved(item, facts, null));
    }

    /// <summary>
    /// Whether a change after <paramref name="since"/> moves what was read of a series' or season's episodes for
    /// <paramref name="user"/>: an episode added, moved, renumbered or removed, or one of the user's watched-state changes
    /// in it (an overflowed log counts as changed). What a memo of such a read (the advanced next-episode boundary) asks.
    /// </summary>
    internal static bool ScopeChangedSince(long since, Guid user, Guid scope)
    {
        if (Since(since) is not { } changes) return true;
        foreach (var change in changes)
        {
            if (change.Kind == PrivacyInputKind.Progress || change.Kind == PrivacyInputKind.Watched && change.User != user) continue;
            if (Array.IndexOf(change.Items, scope) >= 0) return true;
        }
        return false;
    }

    private static void OnItemUpdated(object? sender, ItemChangeEventArgs e)
    {
        if (e?.Item is not { } item) return;
        var facts = PrivacyFacts.Of(item);
        // A refresh that leaves the facts as they were known moves no verdict (a scan refreshes thousands). A fact never
        // known (no event or judgment read it since the start) is unknown: its update is logged.
        PrivacyFacts? before = MemoryOf(sender).Facts.TryGetValue(item.Id, out var known) ? known : null;
        if (before == facts) return;
        Remember(sender, item.Id, facts);
        Record(before == null ? PrivacyInputKind.FirstSeen : PrivacyInputKind.Library, Guid.Empty, Moved(item, facts, before));
        if (item is Folder { LinkedChildren: not null } && (before == null || before.Value.Members != facts.Members)) CollectionChanged?.Invoke(item.Id);
    }

    private static void OnItemRemoved(object? sender, ItemChangeEventArgs e)
    {
        if (e?.Item is not { } item) return;
        PrivacyFacts? before = MemoryOf(sender).Facts.TryRemove(item.Id, out var known) ? known : null;
        Record(PrivacyInputKind.Library, Guid.Empty, Moved(item, PrivacyFacts.Of(item), before));
        if (item is Folder { LinkedChildren: not null }) CollectionChanged?.Invoke(item.Id);
    }

    private static void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        if (e?.Item is not { } item || e.UserId == Guid.Empty) return;
        // Only what a verdict reads moves one: the watched state (any verdict), the position (decisions that use how far
        // the item was watched). A routine progress save that leaves the watched state as it was moves no watched verdict.
        var key = (e.UserId, item.Id);
        var watch = MemoryOf(sender).Watch;
        Watch? now = e.UserData is { } data ? new Watch(data.Played, data.PlaybackPositionTicks) : null;
        Watch? before = watch.TryGetValue(key, out var known) ? known : null;
        if (now is { } saved)
        {
            if (watch.Count >= MaxFacts) watch.Clear();
            watch[key] = saved;
        }
        else watch.TryRemove(key, out _);
        PrivacyInputKind kind;
        if (before is not { } old || now is not { } current || old.Played != current.Played) kind = PrivacyInputKind.Watched;
        else if (old.Position != current.Position || old.Position == null) kind = PrivacyInputKind.Progress;
        else return;
        Record(kind, e.UserId, Moved(item, PrivacyFacts.Of(item), null));
    }
}

/// <summary>
/// The ownership facts of one item a verdict reads: its owner and extra kind, its series and season, its numbering (a
/// season's number; an episode's season and episode numbers, which order a series' episodes), its TMDB key and a
/// collection's members (on 10.11 an owner's extras too). What the input log remembers and what the gate compares with the
/// host's live item.
/// </summary>
public readonly record struct PrivacyFacts(Guid Owner, int Extra, Guid Series, Guid Season, int Index, int ParentIndex, string? Tmdb, int Members)
{
    /// <summary>What a live lookup asks of each item (its provider ids; no images or people).</summary>
    internal static readonly MediaBrowser.Controller.Dto.DtoOptions Options = new(false) { Fields = new[] { MediaBrowser.Model.Querying.ItemFields.ProviderIds }, EnableImages = false };

    /// <summary>The facts of <paramref name="item"/> as it is now (<paramref name="owner"/>: the owner a judgment normalised it to).</summary>
    public static PrivacyFacts Of(BaseItem item, Guid? owner = null) => new(
        owner is { } normalised && normalised != Guid.Empty ? normalised : item.OwnerId,
        PrivacyIdentities.ExtraKind(item) is { } extra ? (int)extra : -1,
        item is MediaBrowser.Controller.Entities.TV.Episode episode ? episode.SeriesId : item is MediaBrowser.Controller.Entities.TV.Season season ? season.SeriesId : Guid.Empty,
        item is MediaBrowser.Controller.Entities.TV.Episode inSeason ? inSeason.SeasonId : Guid.Empty,
        item is MediaBrowser.Controller.Entities.TV.Season or MediaBrowser.Controller.Entities.TV.Episode ? item.IndexNumber ?? -1 : -1,
        item is MediaBrowser.Controller.Entities.TV.Episode ? item.ParentIndexNumber ?? -1 : -1,
        item.GetProviderId(MetadataProvider.Tmdb),
        item is Folder { LinkedChildren: { Length: > 0 } links } ? Hash(links) : 0
#if JF10
            // 10.11 records an owner's extras on the owner (and can attach one without saving the extra's own row).
            ^ (item.ExtraIds is { Length: > 0 } extras ? Hash(extras) : 0)
#endif
        );

    /// <summary>
    /// Whether <paramref name="other"/> names the same ownership (owner, extra kind, series, season, numbering, TMDB key):
    /// what an in-memory item is compared by (its members may be loaded differently from a stored row's).
    /// </summary>
    internal bool SameOwnership(PrivacyFacts other) => this with { Members = 0 } == other with { Members = 0 };

    /// <summary>
    /// The facts of the host's live <paramref name="item"/> compared with <paramref name="judged"/>: a row that names no owner
    /// where the judgment saw one (10.11's extra attached in memory, listed by its owner) is normalised by the same ownership
    /// rule the judgment used (<paramref name="folders"/>: one folder lookup per distinct folder of the check).
    /// </summary>
    internal static PrivacyFacts Live(ILibraryManager library, BaseItem item, PrivacyFacts judged, Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?> folders)
    {
        var facts = Of(item);
        if (facts == judged || item.OwnerId != Guid.Empty || judged.Owner == Guid.Empty) return facts;
        return facts with { Owner = PrivacyIdentities.ExtraOwner(library, item, folders) };
    }

#if JF10
    private static int Hash(Guid[] ids)
    {
        var hash = new HashCode();
        foreach (var id in ids) hash.Add(id);
        return hash.ToHashCode();
    }
#endif

    private static int Hash(LinkedChild[] links)
    {
        var hash = new HashCode();
        foreach (var link in links) hash.Add(link?.ItemId);
        return hash.ToHashCode();
    }
}

/// <summary>
/// The one delivery gate of every protected answer (tag cache, tag data, poster tags, native item answers, search, activity,
/// sessions, reviews and ratings, JE's JSON feeds, images): each attempt builds the answer inside its own read-set
/// (<see cref="PrivacyReadSet"/>), which records every verdict input the build reads with its revision, and the gate, after
/// the build's last blocking step, validates exactly that set. An answer whose set no longer holds is built again from
/// scratch (a new set, the request's cached identities and policies discarded), a bounded number of times; one whose inputs
/// keep changing is withheld. A delivered answer's set guards its bytes (<see cref="PrivacyResponseGuard"/>): every later
/// write re-checks it.
/// </summary>
public static class PrivacyDelivery
{
    /// <summary>How many times an answer is built before it is withheld.</summary>
    public const int Attempts = 3;

    /// <summary>
    /// Builds the answer until the read-set of an attempt still holds after it; null when none did. A delivered answer's
    /// read-set guards <paramref name="http"/>'s response bytes.
    /// </summary>
    /// <param name="viewer">The viewer the answer is for.</param>
    /// <param name="build">Builds the answer: everything that blocks (lookups, waits, locks) happens inside.</param>
    /// <param name="http">The request (its cached identities and policies are discarded before a rebuild).</param>
    public static T? Deliver<T>(Guid viewer, Func<T> build, HttpContext? http = null) where T : class
        => Deliver(viewer, build, http, out _);

    /// <summary>As <see cref="Deliver{T}(Guid, Func{T}, HttpContext?)"/>, also giving the delivered answer's read-set.</summary>
    public static T? Deliver<T>(Guid viewer, Func<T> build, HttpContext? http, out PrivacyReadSet? reads) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            if (attempt > 0) Discard(http, viewer);
            using var scope = PrivacyReadSet.Begin();
            var answer = build();
            if (!scope.Reads.Valid()) { PrivacyReadSet.Withheld(scope.Reads); continue; }
            PrivacyResponseGuard.Install(http, scope.Reads);
            reads = scope.Reads;
            return answer;
        }
        reads = null;
        return null;
    }

    /// <summary>The asynchronous <see cref="Deliver{T}(Guid, Func{T}, HttpContext?)"/>: the gate runs after the build's last await.</summary>
    public static async Task<T?> DeliverAsync<T>(Guid viewer, Func<Task<T>> build, HttpContext? http = null) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            if (attempt > 0) Discard(http, viewer);
            using var scope = PrivacyReadSet.Begin();
            var answer = await build().ConfigureAwait(false);
            if (!scope.Reads.Valid()) { PrivacyReadSet.Withheld(scope.Reads); continue; }
            PrivacyResponseGuard.Install(http, scope.Reads);
            return answer;
        }
        return null;
    }

    /// <summary>
    /// Drops what a request cached of the viewer's verdict inputs (resolved identities, loaded policies, the viewer's
    /// remembered Spoiler Guard state), so a rebuild reads every input again.
    /// </summary>
    public static void Discard(HttpContext? http, Guid viewer)
    {
        var n = viewer.ToString("N");
        if (viewer != Guid.Empty) SpoilerUserResolver.InvalidateUser(n);
        if (http == null) return;
        PrivacyIdentities.Discard(http);
        http.Items.Remove("__JE_TITLE_HIDES_" + n);
        http.Items.Remove("__JE_SPOILER_PRESENTATION_" + n);
        http.Items.Remove(SpoilerUserResolver.ContextKeyUserState + ":" + n);
    }
}
