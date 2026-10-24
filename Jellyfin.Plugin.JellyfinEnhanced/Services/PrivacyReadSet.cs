using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The administrator's privacy settings as one verdict input: every Spoiler Guard, Hidden Content and continue-watching
/// setting (strip, advanced, next-episode, artwork and blur settings among them), read by name so a new setting joins
/// without being listed.
/// </summary>
public static class PrivacySettings
{
    private static readonly PropertyInfo[] _properties = typeof(PluginConfiguration).GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(p => p.CanRead && p.GetIndexParameters().Length == 0 && IsPrivacySetting(p.Name))
        .OrderBy(p => p.Name, StringComparer.Ordinal).ToArray();

    /// <summary>Whether a configuration property is a privacy setting (a verdict input of every protected answer).</summary>
    public static bool IsPrivacySetting(string name)
        => name.StartsWith("Spoiler", StringComparison.Ordinal) || name.StartsWith("HiddenContent", StringComparison.Ordinal)
            || name.StartsWith("RemoveContinueWatching", StringComparison.Ordinal);

    /// <summary>The names of the settings the revision covers.</summary>
    public static IReadOnlyList<string> Names => _properties.Select(p => p.Name).ToArray();

    /// <summary>The settings' current values as one comparable revision (cheap enough to check before every write).</summary>
    public static string Revision(PluginConfiguration? config)
    {
        if (config == null) return "none";
        var text = new StringBuilder(1024);
        foreach (var property in _properties)
        {
            text.Append(property.Name).Append('=');
            Append(text, property.GetValue(config));
            text.Append(';');
        }
        return text.ToString();
    }

    private static void Append(StringBuilder text, object? value)
    {
        switch (value)
        {
            case null: text.Append('~'); break;
            case string s: text.Append(s.Length).Append(':').Append(s); break;
            case IFormattable f: text.Append(f.ToString(null, CultureInfo.InvariantCulture)); break;
            case IEnumerable list:
                text.Append('[');
                foreach (var item in list) { Append(text, item); text.Append(','); }
                text.Append(']');
                break;
            default: text.Append(value); break;
        }
    }
}

/// <summary>
/// What one attempt at a protected answer consumed: every verdict input as an immutable fact, the value the decision used
/// together with how to read that value again from the same live source — the privacy settings, each viewer's policy
/// documents (by content), the host inputs a decision reads (a chapter's start, a trickplay interval, the host's season
/// settings), the result of each query a decision used (the next unwatched episode, a season's watched evidence, a
/// collection's membership of a title, the watched state of what a batch asked), each user-data value it used, and the
/// ownership facts of every item it judged (or that an item it looked for is absent). Inputs are recorded by the one
/// accessor that reads them (<see cref="PrivacyReads"/>, the policy readers, the identity resolver), and a remembered
/// answer replays its facts; nothing is assembled by the answer. The gate's check (<see cref="Valid"/>, the same at the end
/// of an attempt and at the commit) compares EVERY fact's value with its live source: an input that was read and changed
/// always invalidates the answer, an event that changes no consumed value never does. Each attempt starts a new set
/// (<see cref="Begin"/>); a nested attempt's facts are also its parent's.
/// </summary>
public sealed class PrivacyReadSet
{
    private static readonly AsyncLocal<PrivacyReadSet?> _current = new();

    /// <summary>The set of the attempt running on this flow (null outside one).</summary>
    public static PrivacyReadSet? Current => _current.Value;

    private static readonly AsyncLocal<bool> _checking = new();

    /// <summary>Whether this flow is inside a check (its live re-reads), not building an answer (diagnostics and tests).</summary>
    internal static bool Checking => _checking.Value;

    /// <summary>One consumed input other than an item's ownership: its value and how to read it again.</summary>
    /// <param name="Value">The value the decision used.</param>
    /// <param name="Live">Reads the value again from the same live source (null: the source could not answer).</param>
    /// <param name="Stale">Drops the memo the value came from, when the live value differs (the rebuild recomputes it).</param>
    internal sealed record Input(string Value, Func<PrivacyCheck, string?> Live, Action? Stale);

    /// <summary>A user-data value a decision used (an item's watched state; with a position predicate, how far it was watched).</summary>
    internal sealed record UserFact(string Value, JUser User, IUserDataManager Store, Func<UserItemData?, string> Of, BaseItem? Item);

    private readonly object _lock = new();
    private readonly PrivacyReadSet? _parent;
    private readonly Dictionary<string, Input> _facts = new(StringComparer.Ordinal);
    private readonly Dictionary<(Guid User, Guid Item, string Kind), UserFact> _userFacts = new();
    // The ownership facts each judged item was judged by; null: the item was looked for and the library did not have it.
    private readonly Dictionary<Guid, PrivacyFacts?> _items = new();
    private ILibraryManager? _host;
    private string? _inconsistent;

    private PrivacyReadSet(PrivacyReadSet? parent)
    {
        _parent = parent;
        // The settings are an input of every answer: recorded before anything reads them.
        Revision("settings", PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration),
            static () => PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration));
    }

    /// <summary>The attempt's scope: <see cref="Reads"/> is current until it is disposed.</summary>
    public readonly struct Scope : IDisposable
    {
        private readonly PrivacyReadSet? _previous;

        internal Scope(PrivacyReadSet reads, PrivacyReadSet? previous)
        {
            Reads = reads;
            _previous = previous;
        }

        /// <summary>The attempt's read-set.</summary>
        public PrivacyReadSet Reads { get; }

        /// <inheritdoc />
        public void Dispose() => _current.Value = _previous;
    }

    /// <summary>Starts an attempt: a new, empty set that records every input read on this flow until the scope ends.</summary>
    public static Scope Begin()
    {
        var previous = _current.Value;
        var reads = new PrivacyReadSet(previous);
        _current.Value = reads;
        return new Scope(reads, previous);
    }

    /// <summary>Runs <paramref name="read"/> without recording (the gate's own re-reads).</summary>
    internal static T Unrecorded<T>(Func<T> read)
    {
        var previous = _current.Value;
        _current.Value = null;
        try { return read(); }
        finally { _current.Value = previous; }
    }

    /// <summary>
    /// The decision judged <paramref name="item"/> by its ownership facts (compared with the host's live item at every check).
    /// <paramref name="owner"/> is the owner the judgment normalised it to (10.11's listed owner of an extra whose row names
    /// none), when it differs from the row's own.
    /// </summary>
    internal void Item(ILibraryManager? library, BaseItem item, Guid? owner = null)
    {
        if (item.Id == Guid.Empty) return;
        Item(library, item.Id, PrivacyFacts.Of(item, owner));
    }

    /// <summary>A judgment of item <paramref name="id"/> by <paramref name="facts"/> (a remembered judgment replays its facts).</summary>
    internal void Item(ILibraryManager? library, Guid id, PrivacyFacts facts) => Observe(library, id, facts);

    /// <summary>The decision looked for item <paramref name="id"/> and the library did not have it: absence is a fact too.</summary>
    internal void Absent(ILibraryManager? library, Guid id) => Observe(library, id, null);

    private void Observe(ILibraryManager? library, Guid id, PrivacyFacts? facts)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                // Two observations of one input must agree (else the attempt saw it change, and is built again).
                if (set._items.TryGetValue(id, out var known))
                {
                    if (!Same(known, facts)) set._inconsistent ??= "the library facts of " + id.ToString("N") + " were read twice with different values";
                }
                else set._items[id] = facts;
                set._host ??= library;
            }
    }

    private static bool Same(PrivacyFacts? a, PrivacyFacts? b) => a is { } x ? b is { } y && x.SameOwnership(y) : b == null;

    /// <summary>
    /// A consumed input with <paramref name="value"/> (a policy document's content, the settings, a host input such as a
    /// chapter's start, a query result); every check compares it with <paramref name="live"/>, the same source read again
    /// (null: the source could not answer, which counts as changed). <paramref name="stale"/> drops the memo the value came
    /// from when the live value differs. Two reads of one input with different values make the set invalid.
    /// </summary>
    internal void Fact(string key, string value, Func<PrivacyCheck, string?> live, Action? stale = null)
    {
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                if (set._facts.TryGetValue(key, out var known))
                {
                    if (!string.Equals(known.Value, value, StringComparison.Ordinal)) set._inconsistent ??= key + " was read twice with different values";
                }
                else set._facts[key] = new Input(value, live, stale);
            }
    }

    /// <summary>A named input read with <paramref name="value"/>; every check reads it again with <paramref name="reread"/>.</summary>
    internal void Revision(string key, string value, Func<string> reread) => Fact(key, value, _ => reread());

    /// <summary>
    /// A user-data value a decision used: <paramref name="of"/> turns the user's data for the item into the value the
    /// decision consumed (its watched state, or a predicate of its position); every check reads the data again from the
    /// host's store for the item as the host serves it now.
    /// </summary>
    internal void UserValue(IUserDataManager store, JUser user, Guid item, string kind, UserItemData? data, Func<UserItemData?, string> of,
        BaseItem? instance = null, ILibraryManager? library = null)
    {
        if (item == Guid.Empty) return;
        var value = of(data);
        var key = (user.Id, item, kind);
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                if (set._userFacts.TryGetValue(key, out var known))
                {
                    if (!string.Equals(known.Value, value, StringComparison.Ordinal)) set._inconsistent ??= "a user's " + kind + " was read twice with different values";
                }
                else set._userFacts[key] = new UserFact(value, user, store, of, instance);
                set._host ??= library;
            }
    }

    /// <summary>
    /// Whether every input the set consumed still has the value the decision used: each fact read again from its live
    /// source, each user-data value read again, every judged item compared with the host's live item (present or absent).
    /// The gate's one check, with no exemption by answer size, response stage or save epoch: at the end of an attempt and at
    /// the commit alike.
    /// </summary>
    public bool Valid()
    {
        string? inconsistent;
        KeyValuePair<string, Input>[] facts;
        KeyValuePair<(Guid User, Guid Item, string Kind), UserFact>[] users;
        KeyValuePair<Guid, PrivacyFacts?>[] items;
        ILibraryManager? library;
        lock (_lock)
        {
            inconsistent = _inconsistent;
            facts = _facts.ToArray();
            users = _userFacts.ToArray();
            items = _items.ToArray();
            library = _host;
        }
        if (inconsistent != null) { Failure = inconsistent; return false; }
        var check = new PrivacyCheck(library);
        var outer = _checking.Value;
        _checking.Value = true;
        try
        {
            return Unrecorded(() =>
            {
                // The items every reader needs, as the host serves them now: one batched read.
                check.Prepare(items.Select(p => p.Key).Concat(users.Where(u => u.Value.Item == null).Select(u => u.Key.Item)));
                foreach (var (key, fact) in facts)
                {
                    string? now;
                    try { now = fact.Live(check); }
                    catch (Exception) { now = null; }
                    if (now == null) { Failure = key + " could not be read again"; fact.Stale?.Invoke(); return false; }
                    if (!string.Equals(now, fact.Value, StringComparison.Ordinal))
                    {
                        Failure = key.StartsWith("file:", StringComparison.Ordinal) ? "a policy document changed" : key + " changed";
                        fact.Stale?.Invoke();
                        return false;
                    }
                }
                foreach (var ((_, id, kind), fact) in users)
                {
                    // The user's data for the item it was read for (the store keys it by the item), else the host's item now.
                    if ((fact.Item ?? check.Item(id)) is not { } item) { Failure = "an item whose " + kind + " was read left the library"; return false; }
                    if (!string.Equals(fact.Of(fact.Store.GetUserData(fact.User, item)), fact.Value, StringComparison.Ordinal)) { Failure = "a user's " + kind + " changed"; return false; }
                }
                return ItemsHold(check, items);
            });
        }
        catch (Exception) { Failure = "the inputs could not be read again"; return false; }
        finally { _checking.Value = outer; }
    }

    /// <summary>The commit's check of an answer validated before: the same complete check (<see cref="Valid"/>).</summary>
    public bool StillValid() => Valid();

    /// <summary>
    /// Whether every judged item still has the facts it was judged by, in the host's view of it now (its stored row, or the
    /// item it holds in memory when that is at least as new; 10.11's listed owner normalised by the rule the judgment used),
    /// and every item judged absent is still absent.
    /// </summary>
    private bool ItemsHold(PrivacyCheck check, KeyValuePair<Guid, PrivacyFacts?>[] judged)
    {
        if (judged.Length == 0) return true;
        if (check.Library is not { } library) return true;
        foreach (var (id, facts) in judged)
        {
            var item = check.Item(id);
            if (facts is not { } was)
            {
                if (item != null) { Failure = "an item it judged absent is in the library"; Stale(id); return false; }
                continue;
            }
            if (item == null) { Failure = "an item it judged left the library"; Stale(id); return false; }
            if (!PrivacyFacts.Live(library, item, was, check.Folders).SameOwnership(was)) { Failure = "library change of " + id.ToString("N"); Stale(id); return false; }
        }
        return true;
    }

    /// <summary>
    /// The facts a computation consumed, kept with its remembered result: reusing the result replays them into the reusing
    /// answer (<see cref="Replay"/>), so a memo hit carries the complete proof its cold computation recorded (presence and
    /// absence, every owner hop, the query results and user data it used).
    /// </summary>
    public sealed class Evidence
    {
        internal Evidence(KeyValuePair<string, Input>[] facts, KeyValuePair<(Guid User, Guid Item, string Kind), UserFact>[] users,
            KeyValuePair<Guid, PrivacyFacts?>[] items, ILibraryManager? host, bool consistent)
        {
            Facts = facts; Users = users; Items = items; Host = host; Consistent = consistent;
        }

        internal KeyValuePair<string, Input>[] Facts { get; }
        internal KeyValuePair<(Guid User, Guid Item, string Kind), UserFact>[] Users { get; }
        internal KeyValuePair<Guid, PrivacyFacts?>[] Items { get; }
        internal ILibraryManager? Host { get; }

        /// <summary>Whether the computation read every input consistently (only then may its result be remembered).</summary>
        public bool Consistent { get; }
    }

    /// <summary>
    /// Runs <paramref name="compute"/> recording what it consumed (also into the current attempt, as any read) and gives
    /// that as <paramref name="evidence"/>, for a memo of its result to replay.
    /// </summary>
    public static T Capture<T>(Func<T> compute, out Evidence evidence)
    {
        using var scope = Begin();
        var result = compute();
        evidence = scope.Reads.Snapshot();
        return result;
    }

    private Evidence Snapshot()
    {
        lock (_lock)
            return new Evidence(_facts.Where(p => p.Key != "settings").ToArray(), _userFacts.ToArray(), _items.ToArray(), _host, _inconsistent == null);
    }

    /// <summary>
    /// A remembered result is reused: the facts its computation consumed become facts of this answer.
    /// <paramref name="stale"/> drops the memo when any of them no longer holds at a check.
    /// </summary>
    internal void Replay(Evidence evidence, Action? stale = null)
    {
        foreach (var (key, fact) in evidence.Facts) Fact(key, fact.Value, fact.Live, stale + fact.Stale);
        foreach (var ((user, item, kind), fact) in evidence.Users)
            for (var set = this; set != null; set = set._parent)
                lock (set._lock)
                {
                    if (set._userFacts.TryGetValue((user, item, kind), out var known))
                    {
                        if (!string.Equals(known.Value, fact.Value, StringComparison.Ordinal)) set._inconsistent ??= "a user's " + kind + " was read twice with different values";
                    }
                    else set._userFacts[(user, item, kind)] = fact;
                }
        foreach (var (id, facts) in evidence.Items)
        {
            Observe(evidence.Host, id, facts);
            if (stale != null) OnStale(id, stale);
        }
    }

    /// <summary>Replays <paramref name="evidence"/> into the current attempt, when there is one.</summary>
    public static void ReplayCurrent(Evidence evidence, Action? stale = null) => Current?.Replay(evidence, stale);

    private readonly Dictionary<Guid, Action?> _itemStale = new();

    /// <summary>Drops a memo when the judged item <paramref name="id"/> it consumed no longer holds at a check.</summary>
    internal void OnStale(Guid id, Action stale)
    {
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) set._itemStale[id] = set._itemStale.GetValueOrDefault(id) + stale;
    }

    private void Stale(Guid id)
    {
        Action? stale;
        lock (_lock) stale = _itemStale.GetValueOrDefault(id);
        stale?.Invoke();
    }

    /// <summary>Why the last check of this set failed (diagnostics: the kind of input that changed; no private values).</summary>
    public string? Failure { get; private set; }

    /// <summary>The failure of the last attempt a gate gave up after (what the caller logs when it withholds an answer).</summary>
    [ThreadStatic] private static string? _lastWithheld;

    /// <summary>Records why a gate withheld an answer, and returns it.</summary>
    internal static string Withheld(PrivacyReadSet reads) => _lastWithheld = reads.Failure ?? "inputs kept changing";

    /// <summary>Why the last answer a gate on this thread withheld was withheld.</summary>
    internal static string? LastWithheld => _lastWithheld;

    /// <summary>
    /// What this attempt looked up of an owner by folder (10.11's owner-list fallback): one lookup per distinct folder per
    /// answer, shared by the identity resolver, naming and the vocabulary owner. Each listing an extra's owner was taken from
    /// is a fact of the answer (<see cref="PrivacyIdentities"/>).
    /// </summary>
    internal Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?> FolderOwners { get; } = new(StringComparer.Ordinal);

    /// <summary>Whether the set judged an item by its library facts, or found it absent (diagnostics and tests).</summary>
    internal bool HoldsLibrary(Guid id)
    {
        lock (_lock) return _items.ContainsKey(id);
    }

    /// <summary>Whether the set consumed a user's watched state of an item, or a fact of what it holds (diagnostics and tests).</summary>
    internal bool HoldsWatched(Guid user, Guid item)
    {
        var n = item.ToString("N");
        lock (_lock)
            return _userFacts.ContainsKey((user, item, PrivacyReads.WatchedKind))
                || _facts.Keys.Any(k => k.Contains(n, StringComparison.Ordinal) && k.Contains(user.ToString("N"), StringComparison.Ordinal));
    }

    /// <summary>Whether the set consumed how far a user watched an item (diagnostics and tests).</summary>
    internal bool HoldsProgress(Guid user, Guid item)
    {
        lock (_lock) return _userFacts.Keys.Any(k => k.User == user && k.Item == item && k.Kind != PrivacyReads.WatchedKind);
    }

    /// <summary>The named facts the set consumed (diagnostics and tests).</summary>
    internal IReadOnlyCollection<string> Named
    {
        get { lock (_lock) return _facts.Keys.ToArray(); }
    }
}

/// <summary>
/// One check of a read-set: the host's live view every reader of the check shares (the judged items in one batched read,
/// 10.11's folder listings, the memo of a query several facts ask), so a check costs a bounded number of host reads.
/// </summary>
internal sealed class PrivacyCheck
{
    private readonly Dictionary<Guid, BaseItem?> _items = new();
    private readonly Dictionary<string, object?> _memo = new(StringComparer.Ordinal);

    internal PrivacyCheck(ILibraryManager? library) => Library = library;

    /// <summary>The library the answer's items were judged in (null: the answer judged none).</summary>
    public ILibraryManager? Library { get; }

    /// <summary>The 10.11 folder listings this check looked up (one lookup per distinct folder).</summary>
    public Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?> Folders { get; } = new(StringComparer.Ordinal);

    /// <summary>Reads the host's current view of <paramref name="ids"/> in one batched read (those not read yet).</summary>
    public void Prepare(IEnumerable<Guid> ids)
    {
        if (Library is not { } library) return;
        var wanted = ids.Where(id => id != Guid.Empty && !_items.ContainsKey(id)).Distinct().ToArray();
        if (wanted.Length == 0) return;
        var view = PrivacyHostView.Items(library, wanted);
        foreach (var id in wanted) _items[id] = view.GetValueOrDefault(id);
    }

    /// <summary>The host's current view of item <paramref name="id"/> (null: the library does not have it).</summary>
    public BaseItem? Item(Guid id)
    {
        if (_items.TryGetValue(id, out var known)) return known;
        Prepare([id]);
        return _items.GetValueOrDefault(id);
    }

    /// <summary>A value several facts of the check read (a collection's members, a user's played series): read once.</summary>
    public T Memo<T>(string key, Func<T> read)
    {
        if (_memo.TryGetValue(key, out var known)) return (T)known!;
        var value = read();
        _memo[key] = value;
        return value;
    }
}

/// <summary>
/// The host's view of a library item, the same at observation and at every check: its stored row, unless the item the host
/// holds in memory (what the host itself serves by id, and changes before it saves the row) is at least as new. An older
/// cached instance than the stored row is not the item. Reads are batched: the rows in one query per
/// <see cref="Batch"/> items, the memory view from the host's item cache without loading anything.
/// </summary>
internal static class PrivacyHostView
{
    /// <summary>The largest batch of rows one host query reads.</summary>
    internal const int Batch = 2000;

    /// <summary>The host's current view of one item (null: the library does not have it).</summary>
    public static BaseItem? Item(ILibraryManager library, Guid id)
        => id == Guid.Empty ? null : Items(library, [id]).GetValueOrDefault(id);

    /// <summary>The host's current view of several items (absent ones are missing from the answer).</summary>
    public static Dictionary<Guid, BaseItem> Items(ILibraryManager library, IReadOnlyCollection<Guid> ids)
    {
        var answer = new Dictionary<Guid, BaseItem>();
        foreach (var batch in ids.Where(id => id != Guid.Empty).Distinct().Chunk(Batch))
        {
            var rows = new Dictionary<Guid, BaseItem>();
            foreach (var row in library.GetItemList(new InternalItemsQuery { ItemIds = batch, DtoOptions = PrivacyFacts.Options }) ?? [])
                if (row != null) rows[row.Id] = row;
            foreach (var id in batch)
                if (Newer(rows.GetValueOrDefault(id), PrivacyItemMemory.Of(library, id)) is { } item) answer[id] = item;
        }
        return answer;
    }

    /// <summary>The newer of a stored row and the host's in-memory item (the in-memory one when they are as new).</summary>
    private static BaseItem? Newer(BaseItem? row, BaseItem? memory)
        => memory == null ? row : row == null || memory.DateLastSaved >= row.DateLastSaved ? memory : row;
}

/// <summary>
/// The host's item cache, read without loading anything: the instance the host serves by id when it holds one. A host
/// whose cache is reachable (Jellyfin 10.11 and 12 keep it as the library manager's item cache, the one
/// <c>GetItemById</c> answers from) is read directly, one lookup per item with no database read; for any other host, the
/// host's own lookup by id is asked (which also loads a row it does not hold, the same view).
/// </summary>
internal static class PrivacyItemMemory
{
    internal delegate bool Peek(Guid id, out BaseItem item);

    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<object, PeekBox> _peeks = new();

    private sealed class PeekBox(Peek? peek)
    {
        public Peek? Peek { get; } = peek;
    }

    /// <summary>Whether the host's item cache is read directly (diagnostics and tests).</summary>
    internal static bool Direct(ILibraryManager library) => library is IPrivacyItemMemory || PeekOf(library) != null;

    /// <summary>The host's in-memory item <paramref name="id"/>, or null when it holds none.</summary>
    public static BaseItem? Of(ILibraryManager library, Guid id)
    {
        if (library is IPrivacyItemMemory memory) return memory.Peek(id);
        if (PeekOf(library) is { } peek) return peek(id, out var cached) ? cached : null;
        try { return library.GetItemById(id) ?? library.GetItemById<BaseItem>(id); }
        catch (Exception) { return null; }
    }

    private static Peek? PeekOf(ILibraryManager library)
        => _peeks.GetValue(library, static host => new PeekBox(Find(host))).Peek;

    /// <summary>The direct read of <paramref name="host"/>'s item cache (its <c>_cache</c> with <c>TryGet</c>), or null.</summary>
    internal static Peek? Find(object host)
    {
        try
        {
            var cache = host.GetType().GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(host);
            var tryGet = cache?.GetType().GetMethod("TryGet", BindingFlags.Instance | BindingFlags.Public, null, [typeof(Guid), typeof(BaseItem).MakeByRefType()], null);
            return tryGet == null ? null : (Peek?)Delegate.CreateDelegate(typeof(Peek), cache, tryGet, false);
        }
        catch (Exception) { return null; }
    }
}

/// <summary>A host that offers its item cache to the privacy checks directly (a test host models the host's cache with it).</summary>
public interface IPrivacyItemMemory
{
    /// <summary>The in-memory item, or null when the host holds none.</summary>
    BaseItem? Peek(Guid id);
}

/// <summary>
/// The one accessor of the verdict inputs a privacy decision reads from the host: an item by id (as the host serves it
/// now, <see cref="PrivacyHostView"/>), a viewer's user data, the result of a query a decision used. Each read is recorded
/// in the current attempt's read-set as a fact with the value the decision used and how to read it again; the host's
/// answer is also remembered by the input log (whose events refresh memos).
/// </summary>
public static class PrivacyReads
{
    /// <summary>The kind of a user-data fact that is the item's watched state.</summary>
    internal const string WatchedKind = "watched";

    /// <summary>An item by id, as the host serves it now: its ownership facts are recorded (or that the library lacks it).</summary>
    public static BaseItem? Item(ILibraryManager library, Guid id)
    {
        if (id == Guid.Empty) return null;
        var item = PrivacyHostView.Item(library, id);
        Judged(library, id, item);
        return item;
    }

    /// <summary>Several items by id, as the host serves them now (one batched read): each found item's facts, or its absence, recorded.</summary>
    public static Dictionary<Guid, BaseItem> Items(ILibraryManager library, IEnumerable<Guid> ids)
    {
        var wanted = ids.Where(id => id != Guid.Empty).Distinct().ToArray();
        var found = PrivacyHostView.Items(library, wanted);
        foreach (var id in wanted) Judged(library, id, found.GetValueOrDefault(id));
        return found;
    }

    /// <summary>An item by id and kind, as the host serves it now (its facts are recorded whatever its kind).</summary>
    public static T? Item<T>(ILibraryManager library, Guid id) where T : BaseItem => Item(library, id) as T;

    /// <summary>Records that a decision judged item <paramref name="id"/> as <paramref name="item"/> (null: absent).</summary>
    internal static void Judged(ILibraryManager library, Guid id, BaseItem? item)
    {
        if (PrivacyReadSet.Current is not { } reads || id == Guid.Empty) return;
        if (item == null) reads.Absent(library, id);
        else reads.Item(library, item, item is MediaBrowser.Controller.Entities.TV.Episode or MediaBrowser.Controller.Entities.TV.Season ? null : PrivacyIdentities.ExtraOwner(library, item));
    }

    private static string Played(UserItemData? data) => data?.Played == true ? "1" : "0";

    /// <summary>A user's data for an item: the watched state it holds is the value recorded.</summary>
    public static UserItemData? UserData(IUserDataManager data, JUser user, BaseItem item)
    {
        var answer = data.GetUserData(user, item);
        PrivacyInputs.KnowWatched(data, user.Id, item.Id, answer);
        PrivacyReadSet.Current?.UserValue(data, user, item.Id, WatchedKind, answer, Played, item);
        return answer;
    }

    /// <summary>
    /// A user's data for an item, of which a decision uses what <paramref name="consumed"/> derives (how far it was
    /// watched, as a predicate the decision tested): that derived value is recorded, so a progress save that leaves it as
    /// it was changes nothing.
    /// </summary>
    public static UserItemData? UserData(IUserDataManager data, JUser user, BaseItem item, string kind, Func<UserItemData?, string> consumed)
    {
        var answer = data.GetUserData(user, item);
        PrivacyInputs.KnowWatched(data, user.Id, item.Id, answer);
        PrivacyReadSet.Current?.UserValue(data, user, item.Id, kind, answer, consumed, item);
        return answer;
    }

    /// <summary>
    /// A user-data value an answer already carried (the host built it into the answer's item), consumed by a decision:
    /// recorded as <paramref name="consumed"/> derives it, compared with the host's store at every check.
    /// </summary>
    public static void Carried(ILibraryManager library, IUserDataManager store, JUser user, Guid item, string kind, UserItemData? data, Func<UserItemData?, string> consumed)
        => PrivacyReadSet.Current?.UserValue(store, user, item, kind, data, consumed, null, library);

    /// <summary>The watched state an answer's item carried (from the host), consumed by a decision.</summary>
    public static void CarriedWatched(ILibraryManager library, IUserDataManager store, JUser user, Guid item, bool played)
        => Carried(library, store, user, item, WatchedKind, new UserItemData { Key = "carried", Played = played }, Played);

    /// <summary>
    /// The result of a query a decision used (the next unwatched episode, a season's watched evidence, the watched state of
    /// what a batch asked, a collection's membership of a title), recorded as <paramref name="value"/> with how to run the
    /// query again (<paramref name="live"/>, unrecorded) and the memo to drop when it changed.
    /// </summary>
    public static void Query(string key, string value, Func<string?> live, Action? stale = null)
        => PrivacyReadSet.Current?.Fact(key, value, _ => live(), stale);

    /// <summary>As <see cref="Query(string, string, Func{string?}, Action?)"/>, the reader sharing the check's reads.</summary>
    internal static void Query(string key, string value, Func<PrivacyCheck, string?> live, Action? stale = null)
        => PrivacyReadSet.Current?.Fact(key, value, live, stale);

    /// <summary>A canonical, order-free fingerprint of a set of ids (an exact set comparison by a collision-resistant hash).</summary>
    public static string SetOf(IEnumerable<Guid> ids)
    {
        var sorted = ids.Where(id => id != Guid.Empty).Distinct().Select(id => id.ToString("N")).OrderBy(id => id, StringComparer.Ordinal);
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(",", sorted))));
    }

    /// <summary>
    /// Which of <paramref name="candidates"/> <paramref name="user"/> has played, by one batched host query; the set it
    /// answered is a fact (the same query asked again at every check). Null when the query failed (fail closed).
    /// </summary>
    public static HashSet<Guid>? PlayedOf(ILibraryManager library, IUserDataManager? store, JUser user, IReadOnlyCollection<Guid> candidates)
    {
        var asked = candidates.Where(id => id != Guid.Empty).Distinct().ToArray();
        var played = new HashSet<Guid>();
        if (asked.Length == 0) return played;
        HashSet<Guid> Ask()
        {
            var answer = new HashSet<Guid>();
            foreach (var batch in asked.Chunk(PrivacyHostView.Batch))
                foreach (var id in library.GetItemIds(new InternalItemsQuery(user) { ItemIds = batch, IsPlayed = true, GroupByPresentationUniqueKey = false }) ?? [])
                    answer.Add(id);
            return answer;
        }
        try { played = PrivacyReadSet.Unrecorded(Ask); }
        catch (Exception) { return null; }
        PrivacyInputs.KnowWatched(store, user.Id, asked, played);
        Query("played:" + user.Id.ToString("N") + ":" + SetOf(asked), SetOf(played), () => SetOf(Ask()));
        return played;
    }

    /// <summary>The key of the host setting that decides which episodes a season holds (its specials).</summary>
    internal const string SpecialsInSeasons = "host:specials-in-seasons";

    private static string SpecialsSetting()
        => (BaseItem.ConfigurationManager?.Configuration?.DisplaySpecialsWithinSeasons ?? false) ? "1" : "0";

    /// <summary>
    /// The episodes a season holds for a user, as the host lists them (with the host's specials setting and every
    /// special's placement). Callers record what they consume of it (<see cref="SeasonWatched"/>).
    /// </summary>
    internal static IEnumerable<BaseItem> SeasonEpisodes(MediaBrowser.Controller.Entities.TV.Season season, JUser user)
        => season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false);

    /// <summary>The host's specials-in-seasons setting was read (a season's episodes depend on it); returns its value.</summary>
    public static string HostSpecials()
    {
        var value = SpecialsSetting();
        PrivacyReadSet.Current?.Revision(SpecialsInSeasons, value, SpecialsSetting);
        return value;
    }

    /// <summary>
    /// Whether <paramref name="user"/> has watched any episode the host lists in <paramref name="season"/> (its specials
    /// placed by the host's setting and each special's placement): the season's watched evidence, a fact compared with the
    /// same query at every check. Fail closed: a failed read is "nothing watched" (and is not a value: the check fails).
    /// </summary>
    public static bool SeasonWatched(ILibraryManager library, IUserDataManager store, JUser user, MediaBrowser.Controller.Entities.TV.Season season)
        => SeasonWatchedOrUnknown(library, store, user, season) == true;

    /// <summary>As <see cref="SeasonWatched"/>; null when it could not be read (nothing is recorded: the caller protects).</summary>
    public static bool? SeasonWatchedOrUnknown(ILibraryManager library, IUserDataManager store, JUser user, MediaBrowser.Controller.Entities.TV.Season season)
    {
        HostSpecials();
        // The query's parts are read unrecorded: its result is the one fact.
        var watched = PrivacyReadSet.Unrecorded(() => AnyWatched(library, store, user, season.Id));
        if (watched is not { } known) return null;
        Query("season-watched:" + user.Id.ToString("N") + ":" + season.Id.ToString("N"), known ? "1" : "0",
            () => AnyWatched(library, store, user, season.Id) switch { true => "1", false => "0", null => null });
        return known;
    }

    /// <summary>The season's watched evidence read now (null: it could not be read).</summary>
    internal static bool? AnyWatched(ILibraryManager library, IUserDataManager store, JUser user, Guid seasonId)
    {
        try
        {
            if (PrivacyHostView.Item(library, seasonId) is not MediaBrowser.Controller.Entities.TV.Season season) return false;
            foreach (var episode in SeasonEpisodes(season, user))
                if (episode != null && store.GetUserData(user, episode)?.Played == true) return true;
            return false;
        }
        catch (Exception) { return null; }
    }

    /// <summary>A chapter's start (the host's chapter timeline), recorded with how to read it again.</summary>
    public static MediaBrowser.Model.Entities.ChapterInfo? Chapter(MediaBrowser.Controller.Chapters.IChapterManager chapters, Guid item, int index)
    {
        string Read() => chapters.GetChapter(item, index)?.StartPositionTicks.ToString(CultureInfo.InvariantCulture) ?? "-";
        var chapter = chapters.GetChapter(item, index);
        PrivacyReadSet.Current?.Revision("chapter:" + item.ToString("N") + ":" + index.ToString(CultureInfo.InvariantCulture),
            chapter?.StartPositionTicks.ToString(CultureInfo.InvariantCulture) ?? "-", Read);
        return chapter;
    }

    /// <summary>
    /// A trickplay sheet's timing (tiles per sheet and interval at a width), recorded with how to read it again; null
    /// without one.
    /// </summary>
    public static async System.Threading.Tasks.Task<(long PerSheet, long Interval)?> Trickplay(MediaBrowser.Controller.Trickplay.ITrickplayManager manager, Guid item, int width)
    {
        static (long, long)? Of(Dictionary<int, Jellyfin.Database.Implementations.Entities.TrickplayInfo>? resolutions, int width)
            => resolutions != null && resolutions.TryGetValue(width, out var info) ? ((long)info.TileWidth * info.TileHeight, info.Interval) : null;
        static string Text((long, long)? timing) => timing is { } t ? t.Item1.ToString(CultureInfo.InvariantCulture) + "x" + t.Item2.ToString(CultureInfo.InvariantCulture) : "-";
        var timing = Of(await manager.GetTrickplayResolutions(item).ConfigureAwait(false), width);
        PrivacyReadSet.Current?.Revision("trickplay:" + item.ToString("N") + ":" + width.ToString(CultureInfo.InvariantCulture), Text(timing),
            () => Text(Of(manager.GetTrickplayResolutions(item).ConfigureAwait(false).GetAwaiter().GetResult(), width)));
        return timing;
    }
}
