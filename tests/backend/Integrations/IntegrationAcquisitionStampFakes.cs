using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.DependencyInjection;

namespace JE.Tests;

/// <summary>An in-memory <see cref="IStampLibrary"/>: items, access and user data per (user, item), and events to raise.</summary>
internal sealed class FakeStampLibrary : IStampLibrary
{
    public Dictionary<Guid, StampItem> Items { get; } = new();

    /// <summary>(user, item) pairs that may not open the item (everything else may).</summary>
    public HashSet<(Guid User, Guid Item)> Denied { get; } = new();

    public Dictionary<(Guid User, Guid Item), (bool Played, DateTime? LastPlayed)> Data { get; } = new();

    public int FourKCalls { get; private set; }

    public int CanOpenCalls { get; private set; }

    /// <summary>Thrown from every read when set.</summary>
    public Exception? Fail { get; set; }

    public event Action<StampItem>? Added;

    public event Action<StampItem>? Updated;

    public event Action<StampItem>? Removed;

    public StampItem Put(StampItem item)
    {
        Items[item.Id] = item;
        return item;
    }

    public void Deny(Guid user, Guid item) => Denied.Add((user, item));

    public void Played(Guid user, Guid item, bool played, DateTime? lastPlayed) => Data[(user, item)] = (played, lastPlayed);

    public void RaiseAdded(StampItem item)
    {
        Put(item);
        Added?.Invoke(item);
    }

    public void RaiseUpdated(StampItem item)
    {
        Put(item);
        Updated?.Invoke(item);
    }

    public void RaiseRemoved(StampItem item)
    {
        Items.Remove(item.Id);
        Removed?.Invoke(item);
    }

    private void Check()
    {
        if (Fail != null) throw Fail;
    }

    public StampItem? Item(Guid id)
    {
        Check();
        return Items.TryGetValue(id, out var item) ? item : null;
    }

    public bool CanOpen(Guid userId, Guid itemId)
    {
        Check();
        CanOpenCalls++;
        return Items.ContainsKey(itemId) && !Denied.Contains((userId, itemId));
    }

    public (bool Played, DateTime? LastPlayed)? UserData(Guid userId, Guid itemId)
    {
        Check();
        return Data.TryGetValue((userId, itemId), out var data) ? data : null;
    }

    public IReadOnlyList<StampItem> FourKVideos()
    {
        Check();
        FourKCalls++;
        return Items.Values.Where(i => i.IsVideo && i.FourK && !i.Virtual).ToList();
    }

    public IReadOnlyList<StampItem> AddedSince(DateTime since)
    {
        Check();
        return Items.Values.Where(i => i.IsVideo && !i.Virtual && i.DateCreated >= since).ToList();
    }

    public IReadOnlyList<StampItem> OtherCopies(StampItem item)
    {
        Check();
        var keys = item.Keys.Select(k => k.ToString()).ToHashSet(StringComparer.Ordinal);
        bool SameTitle(StampItem other) => other.Keys.Any(k => keys.Contains(k.ToString()));
        var last = item.EpisodeEnd is int end && end >= (item.Episode ?? 0) ? end : item.Episode;
        return Items.Values.Where(o => o.Id != item.Id && o.Kind == item.Kind && SameTitle(o) && (item.Kind == "movie"
            || (o.Season == item.Season && o.Episode is int e && e <= last && (o.EpisodeEnd is int oe && oe >= e ? oe : e) >= item.Episode))).ToList();
    }

    public Guid? ItemAtPath(string path)
    {
        Check();
        return Items.Values.FirstOrDefault(i => i.Path == path)?.Id;
    }
}

/// <summary>Interests by title key.</summary>
internal sealed class FakeStampInterests : IStampInterests
{
    public Action? AfterRead { get; set; }

    public List<(TitleKey Key, StampInterest Interest)> All { get; } = new();

    public void Add(TitleKey key, StampInterest interest) => All.Add((key, interest));

    public IReadOnlyList<StampInterest> For(IReadOnlyList<TitleKey> keys)
    {
        var wanted = keys.Select(k => k.ToString()).ToHashSet(StringComparer.Ordinal);
        var result = All.Where(x => wanted.Contains(x.Key.ToString())).Select(x => x.Interest).ToList();
        AfterRead?.Invoke();
        return result;
    }
}

/// <summary>Upgrade imports: a fixed list, or the pairing of arr history records (as the production reader does).</summary>
internal sealed class FakeStampUpgrades : IStampUpgrades
{
    public List<StampUpgradeImport> Imports { get; } = new();

    public List<ArrHistoryEntry> History { get; } = new();

    public int Calls { get; private set; }

    public IReadOnlyList<StampUpgradeImport> Since(DateTime since)
    {
        Calls++;
        var paired = ArrHistoryStampUpgrades.Pair(History, since)
            .Select(r => new StampUpgradeImport("radarr:" + r.Id, r.ImportedPath!, r.Date!.Value));
        return Imports.Where(i => i.At >= since).Concat(paired).ToList();
    }
}

/// <summary>One acquire.db with the stamp store, resolver and feeder over the fakes, a clock and a configuration.</summary>
internal sealed class StampWorld : IDisposable
{
    public static readonly DateTime T0 = new(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);

    public CoreFixture Core { get; } = new();
    public AcquireDatabase Db { get; }
    public FakeStampLibrary Library { get; } = new();
    public FakeStampInterests Interests { get; } = new();
    public FakeStampUpgrades Upgrades { get; } = new();
    public PluginConfiguration Config { get; set; } = On();
    public DateTime Now { get; set; } = T0;
    public AcquisitionStampStore Store { get; }
    public AcquisitionStampResolver Resolver { get; }
    public AcquisitionStampFeeder Feeder { get; }

    public ArrChangeFeed Feed { get; } = new();

    public StampWorld(string? dbPath = null, bool live = false)
    {
        Db = new AcquireDatabase(dbPath ?? Path.Combine(Core.Root, "acquire.db"));
        Store = live
            ? ActivatorUtilities.CreateInstance<AcquisitionStampStore>(new ServiceCollection().AddSingleton(Db).AddSingleton(Feed).BuildServiceProvider())
            : new AcquisitionStampStore(Db, Clock);
        Resolver = new AcquisitionStampResolver(Library, Store, () => Config, Clock);
        Feeder = new AcquisitionStampFeeder(Library, Interests, Upgrades, Store, Resolver, null, () => Config, Clock);
    }

    public DateTimeOffset Clock() => new(Now, TimeSpan.Zero);

    /// <summary>Acquisition badges on (and native stamps when asked).</summary>
    public static PluginConfiguration On(bool native = false) => new()
    {
        ArrIntegrationEnabled = true,
        ArrPhase1Enabled = true,
        ArrPhase4Enabled = true,
        ArrPhase4AcquisitionBadgesEnabled = true,
        ArrPhase4NativeStampsEnabled = native,
        NativePosterTagsEnabled = native,
    };

    public static TitleKey Movie(int tmdb) => TitleKey.ForMovie(tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture), null)!;

    public static TitleKey Show(int tvdb) => TitleKey.ForSeries(tvdb.ToString(System.Globalization.CultureInfo.InvariantCulture), null, null)!;

    public StampItem AddMovie(TitleKey key, DateTime created, bool fourK = false, string? path = null, Guid? id = null)
        => Library.Put(new StampItem { Id = id ?? Guid.NewGuid(), Kind = "movie", Keys = new[] { key }, Width = fourK ? 3840 : 1920, Height = fourK ? 2160 : 1080, DateCreated = created, Path = path });

    public StampItem AddSeries(TitleKey key, Guid? id = null)
        => Library.Put(new StampItem { Id = id ?? Guid.NewGuid(), Kind = "series", Keys = new[] { key }, DateCreated = T0.AddDays(-100) });

    public StampItem AddSeason(StampItem series, int season)
        => Library.Put(new StampItem { Id = Guid.NewGuid(), Kind = "season", Keys = series.Keys, SeriesId = series.Id, Season = season, DateCreated = T0.AddDays(-100) });

    public StampItem AddEpisode(StampItem series, StampItem? season, int s, int e, DateTime created, bool fourK = false, int? end = null, string? path = null)
        => Library.Put(new StampItem
        {
            Id = Guid.NewGuid(), Kind = "episode", Keys = series.Keys, SeriesId = series.Id, SeasonId = season?.Id, Season = s, Episode = e, EpisodeEnd = end,
            Width = fourK ? 3840 : 1920, Height = fourK ? 2160 : 1080, DateCreated = created, Path = path,
        });

    public static StampInterest Interest(Guid user, DateTime since, bool fourKOnly = false, bool allSeasons = false, int[]? seasons = null, (int, int)[]? episodes = null, string source = "request")
        => new(user, since, fourKOnly, allSeasons, seasons ?? Array.Empty<int>(), episodes ?? Array.Empty<(int, int)>(), source);

    /// <summary>Rows in an acquire.db table.</summary>
    public long Rows(string table) => Db.Read(c =>
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM " + table;
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    });

    public void Dispose()
    {
        Feeder.Dispose();
        Resolver.Dispose();
        Db.Dispose();
        Core.Dispose();
    }
}
