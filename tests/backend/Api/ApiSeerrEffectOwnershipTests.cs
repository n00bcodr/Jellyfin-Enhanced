using System.Collections;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiSeerrEffectOwnershipTests
{
    private const string Imdb = "movie:imdb:tt0133093";
    private const string Tmdb = "movie:tmdb:603";
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(10);
    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static SemaphoreSlim Writer(AcquireDatabase db) => (SemaphoreSlim)typeof(AcquireDatabase).GetField("_writer", Private)!.GetValue(db)!;
    private static async Task Waiting(SemaphoreSlim writer)
    {
        var count = typeof(SemaphoreSlim).GetField("m_waitCount", Private)!;
        using var timeout = new CancellationTokenSource(Limit);
        while ((int)count.GetValue(writer)! == 0) await Task.Delay(5, timeout.Token);
    }
    private sealed class Rig : IDisposable
    {
        internal readonly IntegrationRequestArrivalsTests.Lab Lab = new();
        internal readonly SeerrFacts Facts;
        internal readonly TitleAliases Aliases;
        internal Rig()
        {
            Lab.Config.ArrRequestBackend = "seerr"; Lab.Config.ArrBackendIsolationVersion = 1;
            Lab.Config.JellyseerrEnabled = true; Lab.Config.JellyseerrUrls = FakeSeerr.Url; Lab.Config.JellyseerrApiKey = FakeSeerr.Key;
            Lab.Radarr.Movies.Clear(); Lab.Radarr.Queue.Clear();
            var request = FakeSeerr.Request(1, "movie", 603, 2, Lab.Emma.UserId, Lab.Arr.Now.UtcDateTime);
            request["media"]!["imdbId"] = "tt0133093"; Lab.Seerr.Requests.Add(request);
            // Public production constructor, deliberately the real Shared owner, not an explicit-config substitute.
            Facts = new SeerrFacts(Lab.Seerr.Transport, Lab.Feed, Lab.Arr.Plugin.Core.Logger, new RequestOutboxEvents());
            Aliases = new TitleAliases(Lab.Store, Facts);
        }
        internal async Task Warm()
        {
            Assert.True(await Facts.RefreshAsync(default));
            await Lab.Ask(Lab.Emma, new MutationInput { Key = Imdb, Scope = "movie" });
            Assert.Equal(Imdb, Lab.Ledger.CanonicalKey(Imdb));
        }
        internal object? Run(string root)
        {
            return root switch
            {
                "learn" => RequestTitleIdentity.Learn(Lab.Ledger, Lab.Policy, Aliases, Lab.Feed, Imdb, Lab.Arr.Now),
                "entry" => RequestTitleIdentity.Entry(Lab.Ledger, Lab.Policy, Aliases, Lab.Feed, new MutationInput { Key = Imdb, Scope = "movie" }, Lab.Arr.Now),
                "hosted" => Reconcile(),
                // Deliberately missing the effect owner: a real consequence proves why a temporary read scope is insufficient.
                "planted" => Lab.Ledger.Unify(RequestTitleIdentity.Keys(Aliases, TitleKey.Parse(Imdb)!), Lab.Policy, Lab.Arr.Now),
                _ => throw new ArgumentException(root)
            };
        }
        private int Reconcile()
        {
            using var identity = new RequestTitleIdentity(Lab.Ledger, Lab.Policy, Aliases, Lab.Feed, null, () => Lab.Arr.Now);
            return identity.Reconcile();
        }
        public void Dispose() { Facts.Dispose(); Lab.Dispose(); }
    }

    [Theory]
    [InlineData("learn")][InlineData("entry")][InlineData("hosted")]
    public async Task RealIdentityEffectDrainsBeforeAdoptionIncludingTheBlockedWriterAndFeed(string root)
    {
        using var r = new Rig(); await r.Warm();
        var writer = Writer(r.Lab.Db); await writer.WaitAsync();
        var feedAt = r.Lab.Feed.Cursor;
        Task<object?> work = Task.FromResult<object?>(null);
        Task transition = Task.CompletedTask;
        bool committedWhileBlocked = false, feedAfterAdoption = false, committed = false;
        r.Lab.Db.Committed += () => { if (committed) feedAfterAdoption = true; };
        try
        {
            work = Task.Run(() => r.Run(root));
            await Waiting(writer);
            transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { committed = true; r.Lab.Config.ArrRequestBackend = "je"; }, default);
            committedWhileBlocked = committed;
            // Backend monitor remains usable while the writer is blocked and transition is draining.
            await Task.Run(() => EffectiveRequestsBackend.Shared.Current).WaitAsync(Limit);
            Assert.Equal(Imdb, r.Lab.Ledger.CanonicalKey(Imdb));
            Assert.Equal(feedAt, r.Lab.Feed.Cursor);
        }
        finally { writer.Release(); }
        await work.WaitAsync(Limit); await transition.WaitAsync(Limit);
        Assert.False(committedWhileBlocked, "adoption committed before the consumed alias reached its actual SQLite/feed sink");
        Assert.False(feedAfterAdoption);
        Assert.Equal(Tmdb, r.Lab.Ledger.CanonicalKey(Imdb));
        Assert.True(r.Lab.Feed.Cursor > feedAt);
        Assert.Empty(r.Facts.All);
        // Previously accepted aliases remain durable, and Held reads them without reviving Seerr.
        Assert.Equal(Tmdb, RequestTitleIdentity.Held(r.Lab.Ledger, r.Aliases, TitleKey.Parse(Imdb)!).ToString());
    }

    [Fact]
    public async Task IdentityOwnsTheFeedTailAfterItsDatabaseCommit()
    {
        using var r = new Rig(); await r.Warm();
        var cursor = r.Lab.Feed.Cursor;
        var gate = typeof(ArrChangeFeed).GetField("_lock", Private)!.GetValue(r.Lab.Feed)!;
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var written = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Run(() => { lock (gate) { held.TrySetResult(); if (!release.Wait(Limit)) throw new TimeoutException(); } });
        await held.Task.WaitAsync(Limit);
        r.Lab.Db.Committed += () => written.TrySetResult();
        var work = Task.Run(() => r.Run("learn"));
        Task transition = Task.CompletedTask;
        var early = false;
        try
        {
            await written.Task.WaitAsync(Limit);
            Assert.Equal(Tmdb, r.Lab.Ledger.CanonicalKey(Imdb));
            transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default);
            early = await Task.WhenAny(transition, Task.Delay(1000)) == transition;
        }
        finally { release.Set(); }
        await holder.WaitAsync(Limit); await work.WaitAsync(Limit); await transition.WaitAsync(Limit);
        Assert.False(early, "adoption committed after SQLite but before the blocked feed publication");
        Assert.True(r.Lab.Feed.Cursor > cursor);
    }

    [Fact]
    public async Task PlantedMissingEffectOwnerActuallyLetsTheLateAliasCommit()
    {
        using var r = new Rig(); await r.Warm();
        var writer = Writer(r.Lab.Db); await writer.WaitAsync();
        Task<object?> work = Task.FromResult<object?>(null);
        try
        {
            work = Task.Run(() => r.Run("planted")); await Waiting(writer);
            await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default).WaitAsync(Limit);
            Assert.Equal(Imdb, r.Lab.Ledger.CanonicalKey(Imdb));
        }
        finally { writer.Release(); }
        Assert.IsType<TitleMerge>(await work.WaitAsync(Limit));
        Assert.Equal(Tmdb, r.Lab.Ledger.CanonicalKey(Imdb));
    }

    [Theory]
    [InlineData("learn", true)][InlineData("entry", true)][InlineData("hosted", true)]
    [InlineData("learn", false)][InlineData("entry", false)][InlineData("hosted", false)]
    public async Task IdentityControlsAdoptBeforeConsumptionOrAcceptWithoutAdoption(string root, bool adopt)
    {
        using var r = new Rig(); await r.Warm();
        if (adopt) await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default);
        r.Run(root);
        Assert.Equal(adopt ? Imdb : Tmdb, r.Lab.Ledger.CanonicalKey(Imdb));
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task CancelledOrFailedAdoptionKeepsOldConfigurationAndReleasesItsFence(bool failCommit)
    {
        using var r = new Rig(); await r.Warm();
        var writer = Writer(r.Lab.Db); await writer.WaitAsync();
        using var cancel = new CancellationTokenSource();
        var work = Task.Run(() => r.Run("learn"));
        Task transition = Task.CompletedTask;
        Exception? failure = null;
        bool completedWhileBlocked = false;
        try
        {
            await Waiting(writer);
            transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => throw new InvalidOperationException("failed commit"), cancel.Token);
            completedWhileBlocked = transition.IsCompleted;
            if (!failCommit)
            {
                cancel.Cancel();
                failure = await Record.ExceptionAsync(() => transition.WaitAsync(Limit));
            }
        }
        finally { writer.Release(); }
        await work.WaitAsync(Limit);
        if (failCommit) failure = await Record.ExceptionAsync(() => transition.WaitAsync(Limit));
        Assert.False(completedWhileBlocked);
        if (failCommit) Assert.IsType<InvalidOperationException>(failure);
        else Assert.IsAssignableFrom<OperationCanceledException>(failure);
        Assert.Equal("seerr", r.Lab.Config.ArrRequestBackend);
        Assert.True(EffectiveRequestsBackend.Shared.CheckSeerr(SeerrUse.RequestRead).Allowed);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default).WaitAsync(Limit);
    }

    [Fact]
    public async Task StrictJeArrOnlyIdentityWriteDoesNotRetainSeerrAdmission()
    {
        using var r = new Rig(); await r.Warm();
        r.Lab.Config.ArrRequestBackend = "je";
        var movie = FakeArr.Movie(7, 603, "The Matrix"); movie["imdbId"] = "tt0133093"; r.Lab.Radarr.Movies.Add(movie);
        await r.Lab.Warm();
        var writer = Writer(r.Lab.Db); await writer.WaitAsync();
        var work = Task.Run(() => r.Run("learn"));
        try
        {
            await Waiting(writer);
            await EffectiveRequestsBackend.Shared.TransitionAsync(() => { }, default).WaitAsync(Limit);
        }
        finally { writer.Release(); }
        Assert.IsType<TitleMerge>(await work.WaitAsync(Limit));
        Assert.Equal(Tmdb, r.Lab.Ledger.CanonicalKey(Imdb));
    }

    [Fact]
    public async Task WatchedAliasCacheDoesNotRestampOldSeerrDataAfterAdoptionOrRenewal()
    {
        using var r = new Rig(); await r.Warm();
        await r.Lab.Outbox.TickAsync(default);
        Assert.NotEmpty(r.Lab.Ledger.Unfulfilled(10));
        using var fulfilment = new RequestFulfilment(r.Lab.Ledger, r.Lab.Status, r.Lab.View, r.Lab.Feed, r.Aliases, null, () => r.Lab.Config, () => r.Lab.Arr.Now);
        var watched = typeof(RequestFulfilment).GetMethod("Watched", Private)!;
        Dictionary<string, HashSet<string>> Read() => (Dictionary<string, HashSet<string>>)watched.Invoke(fulfilment, null)!;
        Assert.Contains(Tmdb, Read().Keys);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default);
        Assert.DoesNotContain(Tmdb, Read().Keys);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "seerr", default);
        // No refreshed model: an old cache cannot mint the new epoch.
        Assert.DoesNotContain(Tmdb, Read().Keys);
    }

    [Fact]
    public async Task FulfilmentOwnsStatusThroughItsFinalViewerAndDurableEffect()
    {
        using var r = new Rig(); await r.Warm();
        await r.Lab.Outbox.TickAsync(default);
        Assert.NotEmpty(r.Lab.Ledger.Unfulfilled(10));
        await r.Lab.Warm();
        // A real Jellyfin copy is playable only under the alias supplied by Seerr.
        r.Lab.View.AddCopy(TitleKey.Parse(Tmdb)!, new JfCopy { ItemId = Guid.NewGuid(), Visible = true, Path = "/movies/matrix.mkv" });
        var status = new ArrStatusService(r.Lab.Store, r.Lab.View, r.Facts, () => r.Lab.Config, () => r.Lab.Arr.Now);
        using var fulfilment = new RequestFulfilment(r.Lab.Ledger, status, r.Lab.View, r.Lab.Feed, r.Aliases, null, () => r.Lab.Config, () => r.Lab.Arr.Now);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var views = 0;
        r.Lab.View.OnViewer = _ =>
        {
            var caller = new System.Diagnostics.StackTrace().GetFrames()
                .Select(f => f.GetMethod()?.DeclaringType).FirstOrDefault(t => t?.Assembly == typeof(RequestFulfilment).Assembly);
            if (caller?.Name.StartsWith("<ArrivedAsync>", StringComparison.Ordinal) != true || Interlocked.Increment(ref views) < 2) return;
            entered.TrySetResult(); if (!release.Wait(Limit)) throw new TimeoutException();
        };
        var work = Task.Run(() => fulfilment.CheckAsync(null, default));
        await entered.Task.WaitAsync(Limit);
        var committed = false;
        var transition = EffectiveRequestsBackend.Shared.TransitionAsync(() => { committed = true; r.Lab.Config.ArrRequestBackend = "je"; }, default);
        var early = committed;
        release.Set();
        Assert.Equal(1, await work.WaitAsync(Limit)); await transition.WaitAsync(Limit);
        Assert.False(early, "fulfilment lost ownership after its status composition");
    }
    [Fact]
    public async Task AdmittedEffectWaitingForTheRealWriterDoesNotHoldTheBackendMonitor()
    {
        using var r = new Rig(); await r.Warm();
        var writer = Writer(r.Lab.Db); await writer.WaitAsync();
        var operation = EffectiveRequestsBackend.Shared.AdmitSeerr(SeerrUse.RequestRead, default);
        var work = Task.Run(() => { using (operation) operation.Publish(() => r.Lab.Ledger.Unify([Imdb, Tmdb], r.Lab.Policy, r.Lab.Arr.Now)); });
        Task transition = Task.CompletedTask;
        var accessible = false;
        try
        {
            await Waiting(writer);
            transition = Task.Run(() => EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default));
            var read = Task.Run(() => EffectiveRequestsBackend.Shared.Current);
            accessible = await Task.WhenAny(read, Task.Delay(1000)) == read;
        }
        finally { writer.Release(); }
        await work.WaitAsync(Limit); await transition.WaitAsync(Limit);
        Assert.True(accessible, "the admitted SQLite wait held the backend monitor");
    }

    [Fact]
    public async Task AtomicAdoptionWriterMayWaitForItsConfigurationLockOutsideTheBackendMonitor()
    {
        using var r = new Rig(); await r.Warm();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var transition = Task.Run(() => EffectiveRequestsBackend.Shared.TransitionAsync(() =>
        {
            entered.TrySetResult(); if (!release.Wait(Limit)) throw new TimeoutException();
            r.Lab.Config.ArrRequestBackend = "je";
        }, default));
        var accessible = false;
        try
        {
            await entered.Task.WaitAsync(Limit);
            var read = Task.Run(() => EffectiveRequestsBackend.Shared.CheckSeerr(SeerrUse.RequestRead));
            accessible = await Task.WhenAny(read, Task.Delay(1000)) == read;
            if (accessible) Assert.False((await read).Allowed);
        }
        finally { release.Set(); }
        await transition.WaitAsync(Limit);
        Assert.True(accessible, "configuration commit held the backend monitor while waiting");
    }

    private sealed class BetweenReads<T>(T first, T second, Action between) : IReadOnlyList<T>
    {
        public int Count => 2;
        public T this[int index] => index == 0 ? first : second;
        public IEnumerator<T> GetEnumerator() { yield return first; between(); yield return second; }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    [Theory]
    [InlineData("season", true)][InlineData("part", true)]
    [InlineData("season", false)][InlineData("part", false)]
    public async Task RealListAdapterOwnsTheResultAcrossLaterIndependentReads(string kind, bool adopt)
    {
        using var r = new Rig(); await r.Warm();
        r.Lab.Seerr.Requests.Add(FakeSeerr.Request(2, "tv", 1437, 2, r.Lab.Emma.UserId, r.Lab.Arr.Now.UtcDateTime));
        Assert.True(await r.Facts.RefreshAsync(default));
        var status = new ArrStatusService(r.Lab.Store, r.Lab.View, r.Facts, () => r.Lab.Config, () => r.Lab.Arr.Now);
        var source = new ArrListStatusSource(status, r.Lab.View, r.Aliases);
        var betweenReached = false;
        void Between()
        {
            betweenReached = true;
            if (adopt) EffectiveRequestsBackend.Shared.TransitionAsync(() => r.Lab.Config.ArrRequestBackend = "je", default).GetAwaiter().GetResult();
        }
        Task<IReadOnlyDictionary<string, System.Text.Json.JsonElement>> Work()
        {
            if (kind == "part") return source.PartStatusesAsync(r.Lab.Emma.UserId,
                new BetweenReads<ListStatusPart>(new(TitleKey.Parse(Tmdb)!, null, false), new(TitleKey.Parse("movie:tmdb:604")!, null, false), Between), default);
            return source.SeasonStatusesAsync(r.Lab.Emma.UserId,
                new BetweenReads<ListStatusSeason>(new(TitleKey.Parse("tv:tmdb:1437")!, 1437, 1, [], true), new(TitleKey.Parse("tv:tmdb:1437")!, 1437, 2, [], true), Between), default);
        }
        if (adopt) await Assert.ThrowsAsync<BackendDisabledException>(Work);
        else Assert.NotEmpty(await Work());
        Assert.True(betweenReached, "the adapter must have materialized its first result before the transition");
    }

}
