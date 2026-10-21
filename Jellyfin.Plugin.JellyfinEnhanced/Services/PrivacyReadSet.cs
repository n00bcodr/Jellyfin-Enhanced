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
/// What one attempt at a protected answer read: every verdict input with the revision it was read at — the privacy
/// settings, each viewer's policy files (by content), and the library and user-data facts of each item it judged (their
/// revisions are the input log's ticks, <see cref="PrivacyInputs"/>). Inputs are recorded by the one accessor that reads
/// them (<see cref="PrivacyReads"/>, the policy readers, the identity resolver), never assembled by the answer, and the
/// delivery gate validates exactly this set: an input not read cannot invalidate the answer, an input read and changed
/// always does. Each attempt starts a new set (<see cref="Begin"/>); a nested attempt's reads are also its parent's.
/// </summary>
public sealed class PrivacyReadSet
{
    private static readonly AsyncLocal<PrivacyReadSet?> _current = new();

    /// <summary>The set of the attempt running on this flow (null outside one).</summary>
    public static PrivacyReadSet? Current => _current.Value;

    private readonly object _lock = new();
    private readonly PrivacyReadSet? _parent;
    private readonly HashSet<Guid> _library = new();
    private readonly HashSet<(Guid User, Guid Item)> _watched = new();
    private readonly HashSet<(Guid User, Guid Item)> _progress = new();
    private readonly HashSet<Guid> _scopes = new();
    private readonly Dictionary<string, (string Value, Func<string> Reread)> _revisions = new(StringComparer.Ordinal);
    private bool _inconsistent;
    private long _mark;
    private long _checked;
    private long _epoch;

    private PrivacyReadSet(long mark, PrivacyReadSet? parent)
    {
        _mark = mark;
        _checked = mark;
        _parent = parent;
        _epoch = UserConfigurationManager.SaveEpoch;
        // The settings are an input of every answer: recorded before anything reads them.
        Revision("settings", PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration),
            static () => PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration));
    }

    /// <summary>The input tick the set's facts are compared from (the earliest revision any of them was read at).</summary>
    public long Mark
    {
        get { lock (_lock) return _mark; }
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

    /// <summary>
    /// Starts an attempt: a new, empty set that records every input read on this flow until the scope ends.
    /// <paramref name="mark"/> is the tick its facts were first read at (the host's own reads, when it built the answer
    /// earlier in the request); now by default.
    /// </summary>
    public static Scope Begin(long? mark = null)
    {
        var previous = _current.Value;
        var reads = new PrivacyReadSet(mark ?? PrivacyInputs.Now, previous);
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

    /// <summary>An item's library facts were read (its identity, owner, kind, series and season, TMDB key, members).</summary>
    internal void Library(Guid id)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent) lock (set._lock) set._library.Add(id);
    }

    /// <summary>The library facts of several items were read.</summary>
    internal void Library(IEnumerable<Guid> ids)
    {
        foreach (var id in ids) Library(id);
    }

    /// <summary>
    /// A user's watched state of an item was read (for a series or season: of the episodes it holds; a save of an
    /// episode is logged with its season and series).
    /// </summary>
    internal void Watched(Guid user, Guid item)
    {
        if (item == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent) lock (set._lock) set._watched.Add((user, item));
    }

    /// <summary>
    /// The set of items under a series or season was read (which episodes it holds, their order): an episode added, moved
    /// or renumbered under it moves the read.
    /// </summary>
    internal void ChildrenOf(Guid id)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent) lock (set._lock) set._scopes.Add(id);
    }

    /// <summary>A user's watched state was read over the whole library (a query of everything the user has played).</summary>
    internal void WatchedAll(Guid user)
    {
        for (var set = this; set != null; set = set._parent) lock (set._lock) set._watched.Add((user, Guid.Empty));
    }

    /// <summary>A user's playback position of an item was read (the decisions that use how far it was watched).</summary>
    internal void Progress(Guid user, Guid item)
    {
        if (item == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent) lock (set._lock) set._progress.Add((user, item));
    }

    /// <summary>
    /// A fact remembered at an earlier tick was used (a request's earlier resolution): the set compares from there.
    /// </summary>
    internal void Since(long tick)
    {
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) if (tick < set._mark) set._mark = set._checked = tick;
    }

    /// <summary>
    /// A named input was read with <paramref name="value"/> (a policy file's content, the settings); the gate calls
    /// <paramref name="reread"/> to compare. Two reads of one input with different values make the set invalid.
    /// </summary>
    internal void Revision(string key, string value, Func<string> reread)
    {
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                if (set._revisions.TryGetValue(key, out var known)) { if (!string.Equals(known.Value, value, StringComparison.Ordinal)) set._inconsistent = true; }
                else set._revisions[key] = (value, reread);
            }
    }

    /// <summary>Whether a logged change moves an input this set read.</summary>
    internal bool Reads(PrivacyInputKind kind, Guid user, Guid[] items)
    {
        lock (_lock)
        {
            foreach (var id in items)
                switch (kind)
                {
                    case PrivacyInputKind.Library when _library.Contains(id) || _scopes.Contains(id):
                        return true;
                    case PrivacyInputKind.Added when _scopes.Contains(id):
                        return true;
                    case PrivacyInputKind.Watched when _watched.Contains((user, id)) || _progress.Contains((user, id)) || _watched.Contains((user, Guid.Empty)):
                        return true;
                    case PrivacyInputKind.Progress when _progress.Contains((user, id)):
                        return true;
                }
        }
        return false;
    }

    /// <summary>
    /// Whether every input the set read is unchanged: each named input re-read and equal, and no logged change since the
    /// set's mark moves a fact it read. The gate's full check, at the end of an attempt.
    /// </summary>
    public bool Valid()
    {
        long now;
        lock (_lock)
        {
            if (_inconsistent) { Failure = "one input read twice with different values"; return false; }
            now = PrivacyInputs.Now;
        }
        if (!RevisionsHold()) return false;
        if (PrivacyInputs.ChangedSince(Mark, this, out var which)) { Failure = which; return false; }
        lock (_lock)
        {
            if (now > _checked) _checked = now;
            _epoch = UserConfigurationManager.SaveEpoch;
        }
        return true;
    }

    /// <summary>
    /// The byte boundary's check (before every write of an answer already validated): the named inputs are re-read only
    /// when a policy file was saved since the last check or the settings changed, and only the changes logged since then
    /// are compared.
    /// </summary>
    public bool StillValid()
    {
        long from, now; bool reread;
        lock (_lock)
        {
            if (_inconsistent) return false;
            now = PrivacyInputs.Now;
            from = _checked;
            reread = UserConfigurationManager.SaveEpoch != _epoch;
        }
        if (!reread && !string.Equals(Settings(), PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration), StringComparison.Ordinal)) return false;
        if (reread && !RevisionsHold()) return false;
        if (now != from && PrivacyInputs.ChangedSince(from, this)) return false;
        lock (_lock)
        {
            if (now > _checked) _checked = now;
            if (reread) _epoch = UserConfigurationManager.SaveEpoch;
        }
        return true;
    }

    private string Settings()
    {
        lock (_lock) return _revisions.TryGetValue("settings", out var settings) ? settings.Value : string.Empty;
    }

    private bool RevisionsHold()
    {
        KeyValuePair<string, (string Value, Func<string> Reread)>[] revisions;
        lock (_lock) revisions = _revisions.ToArray();
        foreach (var (key, (value, reread)) in revisions)
        {
            string now;
            try { now = Unrecorded(reread); }
            catch (Exception) { Failure = key + " could not be read again"; return false; }
            if (!string.Equals(now, value, StringComparison.Ordinal)) { Failure = key.StartsWith("file:", StringComparison.Ordinal) ? "a policy document changed" : key + " changed"; return false; }
        }
        return true;
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
    /// answer, shared by the identity resolver, naming and the vocabulary owner.
    /// </summary>
    internal Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?> FolderOwners { get; } = new(StringComparer.Ordinal);

    /// <summary>Whether the set read an item's library facts (diagnostics and tests).</summary>
    internal bool HoldsLibrary(Guid id)
    {
        lock (_lock) return _library.Contains(id);
    }

    /// <summary>Whether the set read a user's watched state of an item (diagnostics and tests).</summary>
    internal bool HoldsWatched(Guid user, Guid item)
    {
        lock (_lock) return _watched.Contains((user, item));
    }

    /// <summary>The named inputs the set read (diagnostics and tests).</summary>
    internal IReadOnlyCollection<string> Named
    {
        get { lock (_lock) return _revisions.Keys.ToArray(); }
    }
}

/// <summary>
/// The one accessor of the verdict inputs a privacy decision reads from the host: an item by id, a viewer's user data
/// (watched state, and where a decision uses it the playback position), a user's watched state over a series or season.
/// Each read is recorded in the current attempt's read-set with its revision before the host is asked, and the host's
/// answer is remembered by the input log (so a later save that changes nothing a verdict reads moves no answer).
/// </summary>
public static class PrivacyReads
{
    /// <summary>An item by id (its library facts are recorded).</summary>
    public static BaseItem? Item(ILibraryManager library, Guid id)
    {
        PrivacyReadSet.Current?.Library(id);
        return id == Guid.Empty ? null : library.GetItemById(id);
    }

    /// <summary>
    /// A user's data for an item: its watched state is recorded (with <paramref name="progress"/>, also its playback
    /// position: a decision that uses how far it was watched).
    /// </summary>
    public static UserItemData? UserData(IUserDataManager data, JUser user, BaseItem item, bool progress = false)
    {
        var reads = PrivacyReadSet.Current;
        reads?.Watched(user.Id, item.Id);
        if (progress) reads?.Progress(user.Id, item.Id);
        var answer = data.GetUserData(user, item);
        PrivacyInputs.KnowWatched(data, user.Id, item.Id, answer);
        return answer;
    }

    /// <summary>An item by id, by the host's typed lookup (its library facts are recorded).</summary>
    public static T? Item<T>(ILibraryManager library, Guid id) where T : BaseItem
    {
        PrivacyReadSet.Current?.Library(id);
        return id == Guid.Empty ? null : library.GetItemById<T>(id);
    }

    /// <summary>A user's watched state over the episodes of a series or season was read (by a query).</summary>
    public static void WatchedIn(Guid user, Guid scope)
    {
        PrivacyReadSet.Current?.Watched(user, scope);
        PrivacyReadSet.Current?.ChildrenOf(scope);
    }

    /// <summary>A user's watched state over the whole library was read (by a query).</summary>
    public static void WatchedAll(Guid user) => PrivacyReadSet.Current?.WatchedAll(user);

    /// <summary>The watched state of several items was read (by one query).</summary>
    public static void WatchedOf(Guid user, IEnumerable<Guid> items)
    {
        if (PrivacyReadSet.Current is not { } reads) return;
        foreach (var item in items) reads.Watched(user, item);
    }
}
