using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The item inputs of a privacy verdict, with revisions: the viewer's watched state (every user-data save) and the
/// library's ownership facts (an item's owner and extra kind, its series and season, a season's number, its TMDB key, a
/// collection's members, the item's presence). One process-wide log of their changes, each stamped with a tick: an answer marks the tick
/// before it reads anything, and the delivery gate asks whether an input of an item it judged changed since. A change is
/// logged with the ids whose verdicts it can move (the item, its season, series and owner, a collection's members), and an
/// answer judges the items it holds and their owners, so the gate only looks up ids. Memos of verdict inputs (whether an entry is an
/// extra) are invalidated by the same events (<see cref="LibraryChanged"/>), never by content timestamps.
/// </summary>
public static class PrivacyInputs
{
    /// <summary>How many changes the log keeps; an answer older than that many changes counts every input as changed.</summary>
    internal const int Capacity = 1 << 14;

    private const int MaxFacts = 250_000;

    /// <summary>The ownership facts of one item that a verdict reads (its owner and extra kind, series, season, number, TMDB key, members).</summary>
    private readonly record struct Facts(Guid Owner, int Extra, Guid Series, Guid Season, int Index, string? Tmdb, int Members);

    private readonly record struct Change(long Tick, Guid User, Guid[] Items);

    private static readonly Change[] _log = new Change[Capacity];
    private static readonly object _lock = new();
    private static long _tick;
    private static readonly ConcurrentDictionary<Guid, Facts> _facts = new();
    private static readonly ConditionalWeakTable<object, object> _observed = new();

    /// <summary>Raised after a library change is logged, with the ids it can move: memos of ownership drop them.</summary>
    public static event Action<IReadOnlyCollection<Guid>>? LibraryChanged;

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

    /// <summary>
    /// Whether an input of an item the answer judged changed after <paramref name="since"/>: one of the viewer's user-data
    /// saves, or a library change of its ownership facts. When the log no longer reaches back that far, every input counts
    /// as changed. Without a viewer (an answer for several possible viewers) every user's saves count.
    /// </summary>
    public static bool ChangedSince(long since, Guid viewer, Func<Guid, bool> judged)
    {
        lock (_lock)
        {
            if (_tick == since) return false;
            if (_tick - since >= Capacity) return true;
            for (var tick = since + 1; tick <= _tick; tick++)
            {
                var change = _log[tick % Capacity];
                if (viewer != Guid.Empty && change.User != Guid.Empty && change.User != viewer) continue;
                foreach (var id in change.Items)
                    if (judged(id)) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// The ids whose ownership facts changed after <paramref name="since"/> (library changes only), or null when the log no
    /// longer reaches back that far (nothing resolved since then may be memoized).
    /// </summary>
    public static HashSet<Guid>? LibraryChangesSince(long since)
    {
        var ids = new HashSet<Guid>();
        lock (_lock)
        {
            if (_tick - since >= Capacity) return null;
            for (var tick = since + 1; tick <= _tick; tick++)
                if (_log[tick % Capacity] is { User: var user, Items: var items } && user == Guid.Empty) ids.UnionWith(items);
        }
        return ids;
    }

    /// <summary>Logs a change (also what the host's events log, for an input the plugin changes itself).</summary>
    internal static void Record(Guid user, IEnumerable<Guid> ids)
    {
        var items = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        if (items.Length == 0) return;
        lock (_lock)
        {
            _tick++;
            _log[_tick % Capacity] = new Change(_tick, user, items);
        }
        if (user == Guid.Empty) LibraryChanged?.Invoke(items);
    }

    private static Facts Of(BaseItem item) => new(
        item.OwnerId,
        item.ExtraType is { } extra ? (int)extra : -1,
        item is Episode episode ? episode.SeriesId : item is Season season ? season.SeriesId : Guid.Empty,
        item is Episode inSeason ? inSeason.SeasonId : Guid.Empty,
        item is Season numbered ? numbered.IndexNumber ?? -1 : -1,
        item.GetProviderId(MetadataProvider.Tmdb),
        item is Folder { LinkedChildren: { Length: > 0 } links } ? Members(links) : 0
#if JF10
            // 10.11 records an owner's extras on the owner (and can attach one without saving the extra's own row).
            ^ (item.ExtraIds is { Length: > 0 } extras ? Members(extras) : 0)
#endif
        );

#if JF10
    private static int Members(Guid[] ids)
    {
        var hash = new HashCode();
        foreach (var id in ids) hash.Add(id);
        return hash.ToHashCode();
    }
#endif

    private static int Members(LinkedChild[] links)
    {
        var hash = new HashCode();
        foreach (var link in links) hash.Add(link?.ItemId);
        return hash.ToHashCode();
    }

    /// <summary>
    /// The ids an item's change can move: itself, its season, series and owner (before and after), a collection's members
    /// (on 10.11, an owner's extras too).
    /// (An extra's verdict follows its owner: the answers that judge an extra judge its owner too.)
    /// </summary>
    private static IEnumerable<Guid> Moved(BaseItem item, Facts facts, Facts? before)
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

    private static void Remember(Guid id, Facts facts)
    {
        if (_facts.Count >= MaxFacts) _facts.Clear();
        _facts[id] = facts;
    }

    private static void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        // A new item moves no verdict an answer already holds (nothing judged it before); its facts are remembered so a
        // later change of them is logged.
        if (e?.Item is { } item) Remember(item.Id, Of(item));
    }

    private static void OnItemUpdated(object? sender, ItemChangeEventArgs e)
    {
        if (e?.Item is not { } item) return;
        var facts = Of(item);
        // A metadata refresh that leaves the ownership facts as they were moves no verdict (a scan refreshes thousands).
        Facts? before = _facts.TryGetValue(item.Id, out var known) ? known : null;
        if (before == facts) return;
        Remember(item.Id, facts);
        // An item first seen since the start (no facts remembered) is logged when it carries ownership (an owner, an extra
        // kind, a collection's members): it may have just been attached; any other first refresh changes nothing known.
        if (before == null && facts.Owner == Guid.Empty && facts.Extra < 0 && facts.Members == 0) return;
        Record(Guid.Empty, Moved(item, facts, before));
    }

    private static void OnItemRemoved(object? sender, ItemChangeEventArgs e)
    {
        if (e?.Item is not { } item) return;
        Facts? before = _facts.TryRemove(item.Id, out var known) ? known : null;
        Record(Guid.Empty, Moved(item, Of(item), before));
    }

    private static void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        if (e?.Item is not { } item || e.UserId == Guid.Empty) return;
        Record(e.UserId, Moved(item, Of(item), null));
    }
}

/// <summary>What one attempt built: the answer, the policy revision it was built under, and the items it judged.</summary>
/// <param name="Answer">The answer.</param>
/// <param name="Policy">The revision of the viewer's policies the build read.</param>
/// <param name="Judged">Whether the answer judged an item (its watched state and ownership are the answer's inputs).</param>
public readonly record struct DeliveryBuild<T>(T Answer, string Policy, Func<Guid, bool> Judged);

/// <summary>
/// The one delivery gate of every protected answer (tag cache, tag data, poster tags, native item answers, search, activity,
/// sessions, reviews and ratings, JE's JSON feeds): the gate is called after the answer's last blocking step and
/// re-validates the full verdict identity the answer was built under — the viewer's policy revisions (Hidden Content, Spoiler
/// Guard) and the input revisions of every item it judged (the viewer's watched state, the library's ownership facts,
/// <see cref="PrivacyInputs"/>). An answer whose identity changed is built again under the new one, a bounded number of times;
/// one whose identity keeps changing is withheld (the caller answers without it) rather than delivered under a verdict that
/// no longer applies.
/// </summary>
public static class PrivacyDelivery
{
    /// <summary>How many times an answer is built before it is withheld.</summary>
    public const int Attempts = 3;

    /// <summary>Builds the answer until the verdict identity it was built under is still current; null when it never was.</summary>
    /// <param name="viewer">The viewer the answer is for.</param>
    /// <param name="build">Builds the answer: everything that blocks (lookups, waits, locks) happens inside.</param>
    /// <param name="policy">Re-reads the viewer's policy revision.</param>
    public static T? Deliver<T>(Guid viewer, Func<DeliveryBuild<T>> build, Func<string> policy) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            var inputs = PrivacyInputs.Now;
            var built = build();
            if (Current(viewer, built.Policy, inputs, policy, built.Judged)) return built.Answer;
        }
        return null;
    }

    /// <summary>The asynchronous <see cref="Deliver{T}"/>: the gate runs after the build's last await.</summary>
    public static async Task<T?> DeliverAsync<T>(Guid viewer, Func<Task<DeliveryBuild<T>>> build, Func<string> policy) where T : class
    {
        for (var attempt = 0; attempt < Attempts; attempt++)
        {
            var inputs = PrivacyInputs.Now;
            var built = await build().ConfigureAwait(false);
            if (Current(viewer, built.Policy, inputs, policy, built.Judged)) return built.Answer;
        }
        return null;
    }

    /// <summary>The items an answer judged from their resolved identities: each item and its owner (an extra's verdict is its owner's).</summary>
    public static Func<Guid, bool> Judges(IReadOnlyDictionary<Guid, PrivacyIdentity> identities)
    {
        var owners = identities.Values.Select(i => i.OwnerId).ToHashSet();
        return id => identities.ContainsKey(id) || owners.Contains(id);
    }

    /// <summary>
    /// The gate's check alone, for an answer projected in place (a native answer, sessions): whether the verdict identity an
    /// answer was built under (<paramref name="revision"/> read after the input tick <paramref name="inputs"/>) still holds.
    /// </summary>
    public static bool Current(Guid viewer, string revision, long inputs, Func<string> policy, Func<Guid, bool> judged)
        => string.Equals(policy(), revision, StringComparison.Ordinal) && !PrivacyInputs.ChangedSince(inputs, viewer, judged);
}
