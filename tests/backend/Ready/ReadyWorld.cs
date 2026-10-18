using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;

namespace JE.Tests;

/// <summary>
/// Jellyfin's playlists in memory, the way 12.2 and 10.11 keep them: an owner, public or not, shares, a folder named from the
/// name it was made with (renames keep it), raw linked item ids in order. Every call is logged; faults can be injected
/// before or after a call's effect, an add can be ignored (Jellyfin skipping an item it won't hold), and every call checks
/// that no database write is in progress on another thread waiting on it (a native call inside a transaction deadlocks).
/// </summary>
internal sealed class FakeReadyPlaylistHost : IReadyPlaylistHost
{
    internal sealed class Native
    {
        public Guid Id { get; init; }
        public Guid Owner { get; set; }
        public bool Public { get; set; }
        public int Shares { get; set; }
        public string Folder { get; init; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public DateTimeOffset Created { get; init; }

        /// <summary>JE's nonce in the playlist's provider ids (a field only JE or an administrator's editor sets), or null.</summary>
        public string? Nonce { get; set; }

        public List<Guid> Entries { get; } = new();
    }

    public Dictionary<Guid, Native> Playlists { get; } = new();
    public List<string> Calls { get; } = new();

    /// <summary>Runs inside each native call (tests check no database write is held, delete the playlist, restore …).</summary>
    public Action<string>? During { get; set; }

    /// <summary>The next call of this kind throws before doing anything.</summary>
    public string? FailBefore { get; set; }

    /// <summary>The next call of this kind does its work, then throws (a crash after the side effect).</summary>
    public string? FailAfter { get; set; }

    /// <summary>Items Jellyfin silently won't add (unsupported for playlists).</summary>
    public HashSet<Guid> Refuses { get; } = new();

    public int Creates => Calls.Count(c => c == "create");

    /// <summary>The clock a playlist's creation time comes from (Jellyfin: its folder's creation time).</summary>
    public Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

    /// <summary>
    /// Jellyfin's id of a new playlist: derived from its folder path, the folder named from the name it is made with ("1"
    /// appended while that folder exists). So a playlist made again under the same name, once the first is gone, gets the
    /// same id.
    /// </summary>
    public static Guid IdFor(string folder) => new(System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes("playlists/" + folder.ToLowerInvariant())));

    private string TargetFolder(string name)
    {
        var folder = name;
        while (Playlists.Values.Any(p => string.Equals(p.Folder, folder, StringComparison.OrdinalIgnoreCase))) folder += "1";
        return folder;
    }

    /// <summary>A playlist a person made themselves (through Jellyfin: its id from its folder, created now).</summary>
    public Native AddOwn(Guid owner, string name, params Guid[] entries)
    {
        var folder = TargetFolder(name);
        var p = new Native { Id = IdFor(folder), Owner = owner, Folder = folder, Name = name, Created = Now() };
        p.Entries.AddRange(entries);
        Playlists[p.Id] = p;
        return p;
    }

    private void Enter(string call)
    {
        Calls.Add(call);
        During?.Invoke(call);
        if (FailBefore == call)
        {
            FailBefore = null;
            throw new InvalidOperationException("native " + call + " failed");
        }
    }

    /// <summary>A crash between Jellyfin emptying the list and adding the items (a fault named "set-cleared").</summary>
    private void Leave(string call)
    {
        if (FailAfter == call)
        {
            FailAfter = null;
            throw new InvalidOperationException("native " + call + " failed after its effect");
        }
    }

    private static ReadyPlaylistInfo Info(Native p) => new(p.Id, p.Owner, p.Public, p.Shares, p.Folder, p.Name, p.Created, p.Nonce);

    public ReadyPlaylistInfo? Get(Guid playlistId) => Playlists.TryGetValue(playlistId, out var p) ? Info(p) : null;

    public Guid? NewPlaylistId(string name) => IdFor(TargetFolder(name));

    public IReadOnlyList<Guid> Entries(Guid playlistId) => Playlists.TryGetValue(playlistId, out var p) ? p.Entries.ToList() : Array.Empty<Guid>();

    /// <summary>The gates each change was asked through and what they said (null: allowed).</summary>
    public List<(string Call, string? Refused)> Gates { get; } = new();

    /// <summary>Every membership Jellyfin was asked to set (after the gate allowed it), in order.</summary>
    public List<(Guid Playlist, Guid[] Items)> Sets { get; } = new();

    // Like the production host: the hook and faults first, then the gate on the playlist as stored now, then the change.
    private string? Gate(string call, Guid? playlistId, ReadyGate gate)
    {
        var refused = gate(playlistId is Guid id ? Get(id) : null);
        Gates.Add((call, refused));
        return refused;
    }

    public Task<(Guid? Id, string? Refused)> CreateAsync(Guid ownerId, string name, ReadyGate gate)
    {
        Enter("create");
        if (Gate("create", null, gate) is { } refused) return Task.FromResult<(Guid?, string?)>((null, refused));
        var folder = TargetFolder(name);
        var p = new Native { Id = IdFor(folder), Owner = ownerId, Folder = folder, Name = name, Created = Now() };
        Playlists[p.Id] = p;
        Leave("create");
        return Task.FromResult<(Guid?, string?)>((p.Id, null));
    }

    public Task<string?> RenameAsync(Guid playlistId, Guid ownerId, string name, ReadyGate gate)
    {
        Enter("rename");
        if (Gate("rename", playlistId, gate) is { } refused) return Task.FromResult<string?>(refused);
        Playlists[playlistId].Name = name;
        Leave("rename");
        return Task.FromResult<string?>(null);
    }

    public Task<string?> SetAsync(Guid playlistId, IReadOnlyList<Guid> itemIds, Guid ownerId, ReadyGate gate)
    {
        Enter("set");
        if (Gate("set", playlistId, gate) is { } refused) return Task.FromResult<string?>(refused);
        if (!Playlists.TryGetValue(playlistId, out var p)) throw new ArgumentException("No Playlist exists with Id " + playlistId);
        Sets.Add((playlistId, itemIds.ToArray()));
        // Like Jellyfin: empty the list, then add what it will hold (once each), in order.
        p.Entries.Clear();
        Leave("set-cleared");
        foreach (var id in itemIds.Where(i => !Refuses.Contains(i)).Distinct()) p.Entries.Add(id);
        Leave("set");
        return Task.FromResult<string?>(null);
    }

    public Task<string?> StampAsync(Guid playlistId, string nonce, ReadyGate gate)
    {
        Enter("stamp");
        if (Gate("stamp", playlistId, gate) is { } refused) return Task.FromResult<string?>(refused);
        Playlists[playlistId].Nonce = nonce;
        Leave("stamp");
        return Task.FromResult<string?>(null);
    }

    public Task<string?> DeleteAsync(Guid playlistId, ReadyGate gate)
    {
        Enter("delete");
        if (Gate("delete", playlistId, gate) is { } refused) return Task.FromResult<string?>(refused);
        Playlists.Remove(playlistId);
        Leave("delete");
        return Task.FromResult<string?>(null);
    }
}

/// <summary>Jellyfin's per-person checks of exact versions: who can open what, real files, watched state.</summary>
internal sealed class FakeReadyLibrary : IReadyLibrary
{
    public Dictionary<Guid, HashSet<Guid>> OpenTo { get; } = new();
    public HashSet<Guid> NotPhysical { get; } = new();
    public HashSet<Guid> NotInsertable { get; } = new();
    public HashSet<(Guid User, Guid Item)> Watched { get; } = new();

    /// <summary>Runs inside each final version check (selection), so a test can change things mid-selection.</summary>
    public Action<Guid, Guid>? OnCheck { get; set; }

    public ReadyVersionCheck Check(Guid userId, Guid playableItemId)
    {
        OnCheck?.Invoke(userId, playableItemId);
        if (OpenTo.TryGetValue(playableItemId, out var users) && !users.Contains(userId)) return ReadyVersionCheck.NoAccess;
        if (NotPhysical.Contains(playableItemId)) return ReadyVersionCheck.NotPhysical;
        if (NotInsertable.Contains(playableItemId)) return ReadyVersionCheck.NotInsertable;
        return ReadyVersionCheck.Ok;
    }

    public bool Played(Guid userId, Guid itemId) => Watched.Contains((userId, itemId));
}

/// <summary>Each person's Hidden Content rules (null = unreadable).</summary>
internal sealed class FakeReadyPrivacy : IReadyPrivacy
{
    public Dictionary<Guid, ReadyHides?> Rules { get; } = new();

    /// <summary>Runs as the rules are loaded, so a test can change things while they are read.</summary>
    public Action<Guid>? OnLoad { get; set; }

    public ReadyHides? Load(Guid userId)
    {
        OnLoad?.Invoke(userId);
        return Rules.TryGetValue(userId, out var hides) ? hides : ReadyHides.None;
    }
}

/// <summary>Each person's interests (null = can't be read now).</summary>
internal sealed class FakeReadyInterests : IReadyInterestSource
{
    public Dictionary<Guid, List<ReadyInterest>?> Of { get; } = new();

    public IReadOnlyList<ReadyInterest>? For(Guid user) => Of.TryGetValue(user, out var list) ? list : new List<ReadyInterest>();

    public IReadOnlyCollection<Guid> Interested(IReadOnlyList<TitleKey> keys)
        => Of.Where(p => p.Value?.Any(i => keys.Any(k => k.Title.ToString() == i.Title.ToString())) == true).Select(p => p.Key).ToList();

    public ReadyInterest Add(Guid user, string id, string kind, TitleKey title, bool fourK = false, bool any = false, bool whole = true, int[]? seasons = null, (int, int)[]? episodes = null, DateTime? since = null)
    {
        var interest = new ReadyInterest(id, user, kind, title, fourK, any, whole, seasons ?? Array.Empty<int>(), episodes ?? Array.Empty<(int, int)>(), since ?? ReadyWorld.Since);
        if (!Of.TryGetValue(user, out var list) || list == null) Of[user] = list = new List<ReadyInterest>();
        list.Add(interest);
        return interest;
    }
}

/// <summary>Jellyfin's sessions in memory, with a log of every DisplayMessage sent.</summary>
internal sealed class FakeReadySessionHost : IReadySessionHost
{
    public List<ReadySessionSnapshot> All { get; } = new();
    public List<(string Session, string Header, string Text, long Timeout)> Sent { get; } = new();
    public Func<string, Task>? OnSend { get; set; }

    /// <summary>Runs when a session is read by id (the final recheck), so a test can change it at the last moment.</summary>
    public Action<string>? OnReread { get; set; }

    public IReadOnlyList<ReadySessionSnapshot> Sessions() => All.ToList();

    public ReadySessionSnapshot? Session(string id)
    {
        OnReread?.Invoke(id);
        return All.FirstOrDefault(s => s.Id == id);
    }

    public async Task SendAsync(string sessionId, string header, string text, long timeoutMs, CancellationToken cancellationToken)
    {
        if (OnSend != null) await OnSend(sessionId);
        lock (Sent) Sent.Add((sessionId, header, text, timeoutMs));
    }

    public ReadySessionSnapshot Add(Guid user, string id, DateTime now, bool supports = true, bool playing = false, bool paused = false, bool known = true, int additional = 0, bool transport = true, DateTime? lastPlayback = null, DateTime? lastActivity = null)
    {
        var s = new ReadySessionSnapshot
        {
            Id = id, UserId = user, SupportsDisplayMessage = supports, Playing = playing, Paused = paused, PlayStateKnown = known,
            AdditionalUsers = additional, ActiveTransport = transport, LastPlaybackEvent = lastPlayback, LastActivity = lastActivity ?? now,
        };
        All.RemoveAll(x => x.Id == id);
        All.Add(s);
        return s;
    }
}

/// <summary>
/// A Ready world: Jellyfin (view, playlists, library checks, sessions), the database, the store, interests, privacy and the
/// service, all over one temporary folder; <see cref="Reopen"/> is a restart over the same database.
/// </summary>
internal sealed class ReadyWorld : IDisposable
{
    public static readonly DateTime Since = new(2026, 10, 1, 9, 0, 0, DateTimeKind.Utc);
    public const string Server = "server-a";

    public CoreFixture Core { get; } = new();
    public FakeJellyfinView View { get; } = new() { ResolveAnyItem = true };
    public PluginConfiguration Config { get; } = new()
    {
        ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrPhase4Enabled = true, ArrPhase4ReadyPlaylistEnabled = true,
        ArrRequestBackend = "je",
    };
    public FakeReadyPlaylistHost Host { get; } = new();
    public FakeReadyLibrary Library { get; } = new();
    public FakeReadyPrivacy Privacy { get; } = new();
    public FakeReadyInterests Interests { get; } = new();
    public EditionAvailability Editions { get; }
    public DateTimeOffset Now { get; set; } = new(2026, 10, 18, 9, 0, 0, TimeSpan.Zero);
    public AcquireDatabase Db { get; private set; } = null!;
    public ReadyPlaylistStore Store { get; private set; } = null!;
    public ReadyCopySelector Selector { get; private set; } = null!;
    public ReadyPlaylistService Service { get; private set; } = null!;
    public string DbPath => Path.Combine(Core.Root, AcquireDatabase.FileName);

    public ReadyWorld()
    {
        Editions = new EditionAvailability(View, () => Config, (key, viewer) => View.Copies(key, viewer));
        Host.Now = () => Now;
        Reopen();
    }

    public void Reopen(string server = Server)
    {
        Service?.Dispose();
        Db?.Dispose();
        Db = new AcquireDatabase(DbPath);
        Store = new ReadyPlaylistStore(Db);
        Selector = new ReadyCopySelector(Editions, Library, null);
        Service = new ReadyPlaylistService(Store, Host, Interests, Selector, Privacy, View, () => Config, () => Now, server, null);
    }

    public StatusViewer User() => View.AddUser(admin: false);

    /// <summary>A movie copy in a library with one source per (width, height), the first being the item's own file.</summary>
    public (Guid Item, List<Guid> Versions) Movie(TitleKey key, DateTime created, Guid[]? visibleTo = null, params (int? W, int? H)[] sources)
    {
        var id = Guid.NewGuid();
        View.AddItem(new JfItemRef { ItemId = id, Kind = "movie", Key = key, Path = "/media/" + id.ToString("N"), DateCreated = created }, visibleTo ?? Array.Empty<Guid>());
        View.AddCopy(key, new JfCopy { ItemId = id, Path = "/media/" + id.ToString("N"), DateCreated = created }, visibleTo ?? Array.Empty<Guid>());
        var versions = new List<Guid>();
        foreach (var (w, h) in sources.Length == 0 ? new (int?, int?)[] { (1920, 1080) } : sources) versions.Add(View.AddSource(id, w, h, "/media/" + Guid.NewGuid().ToString("N") + ".mkv", created).BackingItemId);
        return (id, versions);
    }

    /// <summary>A series copy with no episodes yet.</summary>
    public Guid Series(TitleKey key, DateTime created, params Guid[] visibleTo)
    {
        var id = Guid.NewGuid();
        View.AddCopy(key, new JfCopy { ItemId = id, Path = "/tv/" + id.ToString("N"), DateCreated = created }, visibleTo);
        return id;
    }

    public void Dispose()
    {
        Service?.Dispose();
        Db?.Dispose();
        Core.Dispose();
    }
}
