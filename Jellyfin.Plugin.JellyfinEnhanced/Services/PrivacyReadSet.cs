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
/// What one attempt at a protected answer read: every verdict input with the revision it was observed at — the privacy
/// settings, each viewer's policy files (by content), the host inputs a decision reads (a chapter's start, a trickplay
/// interval, the host's season settings), and the library and user-data facts of each item it judged. Each item fact is
/// recorded with its own observation tick (a remembered fact with the tick it was read at, so it never backdates anything
/// else) and, where the decision read the item itself, with the ownership facts it saw: the gate compares those with the
/// host's live items as well as with the input log (<see cref="PrivacyInputs"/>), so a change the host made before announcing
/// it is seen. Inputs are recorded by the one accessor that reads them (<see cref="PrivacyReads"/>, the policy readers, the
/// identity resolver), never assembled by the answer, and the delivery gate validates exactly this set: an input not read
/// cannot invalidate the answer, an input read and changed always does. Each attempt starts a new set (<see cref="Begin"/>);
/// a nested attempt's reads are also its parent's.
/// </summary>
public sealed class PrivacyReadSet
{
    private static readonly AsyncLocal<PrivacyReadSet?> _current = new();

    /// <summary>The set of the attempt running on this flow (null outside one).</summary>
    public static PrivacyReadSet? Current => _current.Value;

    private readonly object _lock = new();
    private readonly PrivacyReadSet? _parent;
    private readonly Dictionary<Guid, long> _library = new();
    private readonly Dictionary<(Guid User, Guid Item), long> _watched = new();
    private readonly Dictionary<(Guid User, Guid Item), long> _progress = new();
    private readonly Dictionary<Guid, long> _scopes = new();
    private readonly Dictionary<string, (string Value, Func<string> Reread)> _revisions = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, PrivacyFacts> _facts = new();
    private ILibraryManager? _host;
    private readonly long _mark;
    private bool _inconsistent;
    private long _earliest;
    private long _checked;
    private long _epoch;

    private PrivacyReadSet(long mark, PrivacyReadSet? parent)
    {
        _mark = mark;
        _earliest = mark;
        _checked = mark;
        _parent = parent;
        _epoch = UserConfigurationManager.SaveEpoch;
        // The settings are an input of every answer: recorded before anything reads them.
        Revision("settings", PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration),
            static () => PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration));
    }

    /// <summary>The input tick the attempt's own reads are observed at (its start, or the host's earlier reads).</summary>
    public long Mark => _mark;

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

    /// <summary>Records <paramref name="key"/> as observed at <paramref name="at"/> (the earliest observation wins).</summary>
    private static void Observe<TKey>(Dictionary<TKey, long> inputs, TKey key, long at) where TKey : notnull
    {
        if (!inputs.TryGetValue(key, out var known) || at < known) inputs[key] = at;
    }

    private void Earliest(long at)
    {
        if (at < _earliest) _earliest = at;
    }

    private long At(long? at) => at ?? _mark;

    /// <summary>
    /// An item's library facts were read (its identity, owner, kind, series and season, numbering, TMDB key, members),
    /// as of <paramref name="at"/> (a remembered fact's tick; the attempt's own reads by default).
    /// </summary>
    internal void Library(Guid id, long? at = null)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) { var tick = set.At(at); Observe(set._library, id, tick); set.Earliest(tick); }
    }

    /// <summary>The library facts of several items were read.</summary>
    internal void Library(IEnumerable<Guid> ids, long? at = null)
    {
        foreach (var id in ids) Library(id, at);
    }

    /// <summary>
    /// The decision read <paramref name="item"/> itself (the facts it saw are compared with the host's live item at the
    /// gate). <paramref name="owner"/> is the owner the judgment normalised it to (10.11's listed owner of an extra whose row
    /// names none), when it differs from the row's own.
    /// </summary>
    internal void Item(ILibraryManager? library, BaseItem item, Guid? owner = null)
    {
        if (item.Id == Guid.Empty) return;
        var facts = PrivacyFacts.Of(item, owner);
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                var tick = set._mark;
                Observe(set._library, item.Id, tick);
                set.Earliest(tick);
                // The first view the attempt judged by is the one compared (a later view of the same item, another
                // instance of it, does not replace it).
                set._facts.TryAdd(item.Id, facts);
                set._host ??= library;
            }
    }

    /// <summary>A reused judgment of item <paramref name="id"/> (its facts as they were judged) is part of this answer.</summary>
    internal void Item(ILibraryManager? library, Guid id, PrivacyFacts facts)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock)
            {
                set._facts.TryAdd(id, facts);
                set._host ??= library;
            }
    }

    /// <summary>
    /// A user's watched state of an item was read (for a series or season: of the episodes it holds; a save of an
    /// episode is logged with its season and series), as of <paramref name="at"/>.
    /// </summary>
    internal void Watched(Guid user, Guid item, long? at = null)
    {
        if (item == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) { var tick = set.At(at); Observe(set._watched, (user, item), tick); set.Earliest(tick); }
    }

    /// <summary>
    /// The set of items under a series or season was read (which episodes it holds, their order): an episode added, moved
    /// or renumbered under it moves the read.
    /// </summary>
    internal void ChildrenOf(Guid id, long? at = null)
    {
        if (id == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) { var tick = set.At(at); Observe(set._scopes, id, tick); set.Earliest(tick); }
    }

    /// <summary>A user's watched state was read over the whole library (a query of everything the user has played).</summary>
    internal void WatchedAll(Guid user, long? at = null)
    {
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) { var tick = set.At(at); Observe(set._watched, (user, Guid.Empty), tick); set.Earliest(tick); }
    }

    /// <summary>A user's playback position of an item was read (only by the decisions that use how far it was watched).</summary>
    internal void Progress(Guid user, Guid item, long? at = null)
    {
        if (item == Guid.Empty) return;
        for (var set = this; set != null; set = set._parent)
            lock (set._lock) { var tick = set.At(at); Observe(set._progress, (user, item), tick); set.Earliest(tick); }
    }

    /// <summary>
    /// A named input was read with <paramref name="value"/> (a policy file's content, the settings, a host input such as a
    /// chapter's start); the gate calls <paramref name="reread"/> to compare. Two reads of one input with different values
    /// make the set invalid.
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

    /// <summary>
    /// Whether a change logged at <paramref name="tick"/> moves an input this set observed before it (each input compared
    /// from its own observation).
    /// </summary>
    internal bool Reads(PrivacyInputKind kind, Guid user, Guid[] items, long tick)
    {
        lock (_lock)
        {
            static bool Before<TKey>(Dictionary<TKey, long> inputs, TKey key, long tick) where TKey : notnull
                => inputs.TryGetValue(key, out var at) && at < tick;
            foreach (var id in items)
                switch (kind)
                {
                    case PrivacyInputKind.Library when Before(_library, id, tick) || Before(_scopes, id, tick):
                        return true;
                    // A first-seen update: what the answer judged the item by is compared with the live item (when it
                    // recorded it); the event log decides only for an item whose facts it did not record.
                    case PrivacyInputKind.FirstSeen when Before(_library, id, tick) && !_facts.ContainsKey(id) || Before(_scopes, id, tick):
                        return true;
                    case PrivacyInputKind.Added when Before(_scopes, id, tick):
                        return true;
                    case PrivacyInputKind.Watched when Before(_watched, (user, id), tick) || Before(_progress, (user, id), tick) || Before(_watched, (user, Guid.Empty), tick):
                        return true;
                    case PrivacyInputKind.Progress when Before(_progress, (user, id), tick):
                        return true;
                }
        }
        return false;
    }

    /// <summary>
    /// Whether every input the set read is unchanged: each named input re-read and equal, every item the decision read
    /// equal to the host's live item, and no logged change after an input's observation moves it. The gate's full check,
    /// at the end of an attempt.
    /// </summary>
    public bool Valid()
    {
        long now, from;
        // Captured before the walk: a save during it leaves the epoch behind, so the next check reads every document again.
        var epoch = UserConfigurationManager.SaveEpoch;
        lock (_lock)
        {
            if (_inconsistent) { Failure = "one input read twice with different values"; return false; }
            now = PrivacyInputs.Now;
            from = _earliest;
        }
        if (!RevisionsHold()) return false;
        if (!LiveHolds()) return false;
        if (PrivacyInputs.ChangedSince(from, this, out var which)) { Failure = which; return false; }
        lock (_lock)
        {
            if (now > _checked) _checked = now;
            _epoch = epoch;
        }
        return true;
    }

    /// <summary>
    /// The commit check of an answer already validated: the named inputs are re-read when a policy file was saved since
    /// the last check or the settings changed, the items the decision read are compared with the host's live items, and
    /// the changes logged since the last check are compared.
    /// </summary>
    public bool StillValid(bool live = true)
    {
        long from, now; bool reread;
        var epoch = UserConfigurationManager.SaveEpoch;
        lock (_lock)
        {
            if (_inconsistent) return false;
            now = PrivacyInputs.Now;
            from = _checked;
            reread = epoch != _epoch;
        }
        if (!reread && !string.Equals(Settings(), PrivacySettings.Revision(JellyfinEnhanced.Instance?.Configuration), StringComparison.Ordinal)) { Failure = "settings changed"; return false; }
        if (reread && !RevisionsHold()) return false;
        if (live && !LiveHolds()) return false;
        if (now != from && PrivacyInputs.ChangedSince(from, this, out var which)) { Failure = which; return false; }
        lock (_lock)
        {
            if (now > _checked) _checked = now;
            if (reread) _epoch = epoch;
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

    /// <summary>The largest batch of live items one host lookup reads.</summary>
    private const int LiveBatch = 2000;

    /// <summary>
    /// Up to this many judged items, each is also compared with the host's in-memory item (the host changes an item in
    /// memory before it saves it and announces the change); larger answers compare with the stored rows only.
    /// </summary>
    internal const int InMemoryCheck = 256;

    /// <summary>
    /// Whether every item the decision read still has the facts it was judged by, read from the host's live items (one
    /// batched lookup per <see cref="LiveBatch"/> items; 10.11's listed owner normalised by the same rule the judgment used).
    /// An item the host no longer has counts as changed.
    /// </summary>
    private bool LiveHolds()
    {
        KeyValuePair<Guid, PrivacyFacts>[] judged;
        ILibraryManager? library;
        lock (_lock) { judged = _facts.ToArray(); library = _host; }
        if (judged.Length == 0 || library == null) return true;
        try
        {
            return Unrecorded(() =>
            {
                var folders = new Dictionary<string, (BaseItem Owner, HashSet<Guid> Extras)?>(StringComparer.Ordinal);
                foreach (var batch in judged.Chunk(LiveBatch))
                {
                    var live = new Dictionary<Guid, BaseItem>();
                    foreach (var item in library.GetItemList(new InternalItemsQuery { ItemIds = batch.Select(p => p.Key).ToArray(), DtoOptions = PrivacyFacts.Options }) ?? [])
                        if (item != null) live[item.Id] = item;
                    foreach (var (id, facts) in batch)
                    {
                        // An item the batched query did not list is looked up by itself (the host's direct lookup).
                        if (!live.TryGetValue(id, out var item) && (item = library.GetItemById(id)) == null) { Failure = "an item it judged left the library"; return false; }
                        if (PrivacyFacts.Live(library, item, facts, folders) != facts) { Failure = "library change of " + id.ToString("N") + " not announced yet"; return false; }
                        // The host's in-memory item when it is newer than the stored row (the host stamps an item it is about
                        // to save before it writes the row): a change in progress reaches it first. An older cached instance
                        // is not the live item (the row is).
                        if (judged.Length <= InMemoryCheck && library.GetItemById(id) is { } current && !ReferenceEquals(current, item)
                            && current.DateLastSaved > item.DateLastSaved
                            && !PrivacyFacts.Live(library, current, facts, folders).SameOwnership(facts))
                        { Failure = "library change of " + id.ToString("N") + " not saved yet"; return false; }
                    }
                }
                return true;
            });
        }
        catch (Exception) { Failure = "the library could not be read again"; return false; }
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
        lock (_lock) return _library.ContainsKey(id);
    }

    /// <summary>Whether the set read a user's watched state of an item (diagnostics and tests).</summary>
    internal bool HoldsWatched(Guid user, Guid item)
    {
        lock (_lock) return _watched.ContainsKey((user, item));
    }

    /// <summary>Whether the set read a user's playback position of an item (diagnostics and tests).</summary>
    internal bool HoldsProgress(Guid user, Guid item)
    {
        lock (_lock) return _progress.ContainsKey((user, item));
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
    /// <summary>An item by id (its library facts are recorded, and the facts the decision sees are compared with the live item at the gate).</summary>
    public static BaseItem? Item(ILibraryManager library, Guid id)
    {
        var reads = PrivacyReadSet.Current;
        reads?.Library(id);
        if (id == Guid.Empty) return null;
        var item = library.GetItemById(id);
        if (item != null) reads?.Item(library, item, item is MediaBrowser.Controller.Entities.TV.Episode or MediaBrowser.Controller.Entities.TV.Season ? null : PrivacyIdentities.ExtraOwner(library, item));
        return item;
    }

    /// <summary>
    /// A user's data for an item: its watched state is recorded (with <paramref name="progress"/>, also its playback
    /// position: only a decision that uses how far it was watched asks for it).
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

    /// <summary>A decision used how far <paramref name="user"/> watched <paramref name="item"/> (a position it already read).</summary>
    public static void Progress(Guid user, Guid item) => PrivacyReadSet.Current?.Progress(user, item);

    /// <summary>An item by id, by the host's typed lookup (its library facts are recorded).</summary>
    public static T? Item<T>(ILibraryManager library, Guid id) where T : BaseItem
    {
        var reads = PrivacyReadSet.Current;
        reads?.Library(id);
        if (id == Guid.Empty) return null;
        var item = library.GetItemById<T>(id);
        if (item != null) reads?.Item(library, item, item is MediaBrowser.Controller.Entities.TV.Episode or MediaBrowser.Controller.Entities.TV.Season ? null : PrivacyIdentities.ExtraOwner(library, item));
        return item;
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

    /// <summary>
    /// What a batch query established of several items' watched state (<paramref name="played"/> holds the watched ones):
    /// remembered by the input log, so a later save that leaves it as it was is a progress save, not a watched change.
    /// </summary>
    public static void Established(IUserDataManager? store, Guid user, IEnumerable<Guid> items, ISet<Guid> played)
        => PrivacyInputs.KnowWatched(store, user, items, played);

    /// <summary>The key of the host setting that decides which episodes a season holds (its specials).</summary>
    internal const string SpecialsInSeasons = "host:specials-in-seasons";

    private static string SpecialsSetting()
        => (BaseItem.ConfigurationManager?.Configuration?.DisplaySpecialsWithinSeasons ?? false) ? "1" : "0";

    /// <summary>
    /// The episodes a season holds for a user, as the host lists them: the season's episode set, the user's watched state
    /// over it and the host's specials setting (which moves specials into or out of the season) are recorded.
    /// </summary>
    public static IEnumerable<BaseItem> SeasonEpisodes(MediaBrowser.Controller.Entities.TV.Season season, JUser user)
    {
        WatchedIn(user.Id, season.Id);
        HostSpecials();
        return season.GetEpisodes(user, new MediaBrowser.Controller.Dto.DtoOptions(false), shouldIncludeMissingEpisodes: false);
    }

    /// <summary>The host's specials-in-seasons setting was read (a season's episodes depend on it); returns its value.</summary>
    public static string HostSpecials()
    {
        var value = SpecialsSetting();
        PrivacyReadSet.Current?.Revision(SpecialsInSeasons, value, SpecialsSetting);
        return value;
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
