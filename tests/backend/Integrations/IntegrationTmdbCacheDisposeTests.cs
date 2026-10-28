using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>
/// Dispose cancels the raw TMDB cache's background check of the server-side cache instead of waiting for it (CCR4-1,
/// ported from the review clone): a check blocked on the folder's preparation ends with Dispose and never saves or
/// migrates afterwards, and the final dirty save never waits on that preparation. The review fixture waited for the
/// snapshot's migration when draining; a disposed cache never migrates, so draining here waits only for the counters.
/// </summary>
[Collection("Plugin singleton")]
public sealed class IntegrationTmdbCacheDisposeTests
{
    private static object Field(object owner, string name) => owner.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(owner)!;
    private static int Number(object owner, string name) => (int)Field(owner, name);
    private static async Task Until(Func<bool> done) => await IntegrationTmdbDiskCacheTests.Until(done);

    private sealed class Fixture : IAsyncDisposable
    {
        public readonly string Root = Path.Combine(Path.GetTempPath(), "je-ccr4-" + Guid.NewGuid().ToString("N"));
        public readonly IntegrationTmdbDiskCacheTests.Clock Clock = new() { Now = DateTimeOffset.UtcNow };
        public ServerCacheSettings Settings = new(false, string.Empty, 0, 0);
        public readonly IntegrationTransport Net = new((_, _) => Task.FromResult(IntegrationTransport.Response("{\"id\":603}")));
        public readonly ServerBlobCache Disk;
        public readonly TmdbResponseCache Raw;
        public readonly string Legacy;
        public int ReadyCalls;
        public Fixture()
        {
            Directory.CreateDirectory(Root);
            Legacy = Path.Combine(Root, "tmdb-cache.json");
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")), 0, 8);
            File.WriteAllText(Legacy, JsonSerializer.Serialize(new { V = 1, Entries = new[] { new {
                K = hash + "|https://api.themoviedb.org/3/movie/603", S = 200, C = "{\"id\":603}",
                E = (Clock.Now + TimeSpan.FromHours(6)).ToUnixTimeMilliseconds(), F = Clock.Now.UtcTicks } } }));
            Disk = new(() => {
                if (new StackTrace().GetFrames().Any(f => f.GetMethod()?.Name == "DiskReady")) Interlocked.Increment(ref ReadyCalls);
                return Volatile.Read(ref Settings);
            }, new ServerCacheLocation(Root, Array.Empty<string>()), null, () => Clock.Now.UtcDateTime) { SweepDebounce = TimeSpan.Zero };
            Raw = new(Net, Clock, null, Disk, Legacy, null);
        }
        public int Blobs => Directory.EnumerateFiles(Root, "*.blob", SearchOption.AllDirectories).Count();
        public Task<TmdbResponseCache.TmdbResponse> Hit() => Raw.GetAsync("movie/603", "", "key", default);
        public async Task DueHit(int expectedCalls = 0)
        {
            Clock.Now += TimeSpan.FromSeconds(31);
            var response = await Task.Run(Hit).WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Equal(200, response.StatusCode);
            Assert.Equal(expectedCalls, Net.Calls);
        }
        public async Task Drain()
        {
            await Until(() => Number(Raw, "_checking") == 0 && Number(Raw, "_promoting") == 0 && Number(Disk, "_pendingIo") == 0);
            await Disk.PendingSweep.WaitAsync(TimeSpan.FromSeconds(5));
        }
        public async ValueTask DisposeAsync()
        {
            Raw.Dispose();
            await Drain();
            Net.Dispose();
            Directory.Delete(Root, true);
        }
    }

    // No timeout in the holder: preparation cannot resume until the test explicitly releases it.
    private sealed class PreparationHold : IDisposable
    {
        private readonly ManualResetEventSlim held = new();
        private readonly ManualResetEventSlim release = new();
        private readonly Thread thread;
        public PreparationHold(ServerBlobCache disk)
        {
            thread = new(() => { lock (Field(disk, "_prepareLock")) { held.Set(); release.Wait(); } });
            thread.Start();
            Assert.True(held.Wait(TimeSpan.FromSeconds(3)));
        }
        public void Dispose() { release.Set(); thread.Join(); held.Dispose(); release.Dispose(); }
    }

    [Fact]
    public async Task DisposeMustNotLeaveAHungBackgroundCheckToWriteAfterItReturns()
    {
        await using var f = new Fixture();
        await f.Disk.PendingSweep;
        var afterDispose = -1;
        long elapsed = 0;
        using (new PreparationHold(f.Disk))
        {
            f.Settings = f.Settings with { Enabled = true };
            await f.DueHit();
            await Until(() => Volatile.Read(ref f.ReadyCalls) == 1);
            var watch = Stopwatch.StartNew();
            await Task.Run(f.Raw.Dispose).WaitAsync(TimeSpan.FromSeconds(7));
            elapsed = watch.ElapsedMilliseconds;
            afterDispose = Number(f.Raw, "_checking");
            Assert.Equal(0, f.Blobs);
            Assert.True(File.Exists(f.Legacy));
        }
        await f.Drain();
        Assert.Equal(0, afterDispose);
        Assert.True(elapsed < 1000, $"Dispose waited {elapsed} ms for a check it should have cancelled");
        // Nothing the check would have started runs once preparation resumes after Dispose.
        await Task.Delay(300);
        await f.Drain();
        Assert.Equal(0, f.Blobs);
        Assert.True(File.Exists(f.Legacy));
        Assert.False(File.Exists(f.Legacy + ".migrated"));
    }

    [Fact]
    public async Task DisposeWithADirtySnapshotMustStayBoundedWhilePreparationHangs()
    {
        await using var f = new Fixture();
        await f.Disk.PendingSweep;
        await f.Raw.GetAsync("movie/604", "", "key", default); // a real off-cache fetch makes the legacy snapshot dirty
        // Remove the timer's independent deadline from this shutdown probe; Dispose still owes its final dirty save.
        ((Timer)Field(f.Raw, "_debounceSaveTimer")).Dispose();
        typeof(TmdbResponseCache).GetField("_debounceSaveTimer", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(f.Raw, null);
        var completedWithinBound = false;
        Task? dispose = null;
        using (new PreparationHold(f.Disk))
        {
            f.Settings = f.Settings with { Enabled = true };
            var before = Volatile.Read(ref f.ReadyCalls);
            await f.DueHit(1);
            await Until(() => Volatile.Read(ref f.ReadyCalls) > before);
            dispose = Task.Run(f.Raw.Dispose);
            await Task.WhenAny(dispose, Task.Delay(TimeSpan.FromSeconds(6)));
            completedWithinBound = dispose.IsCompleted;
        }
        await dispose.WaitAsync(TimeSpan.FromSeconds(6));
        await f.Drain();
        Assert.True(completedWithinBound, "Dispose entered synchronous SaveToDisk after its five-second wait and remained blocked on preparation");
    }

    [Fact]
    public async Task DisposeWithTheServerCacheOffStillSavesADirtySnapshot()
    {
        await using var f = new Fixture();
        await f.Disk.PendingSweep;
        await f.Raw.GetAsync("movie/604", "", "key", default);
        f.Raw.Dispose();
        Assert.Contains("movie/604", File.ReadAllText(f.Legacy));
    }

    // Hardening-pack review (HPR-1), ported from the review clone: a write queued on the disk, a fetch already under way
    // and a timer save already waiting on the folder all observe the same disposal.
 [Fact] public async Task PromotionQueuedOnBlobIoMustNotCommitAfterDispose() {
  await using var f=new Fixture(); await f.Disk.PendingSweep;
  f.Settings=f.Settings with {Enabled=true}; Assert.True(f.Disk.Enabled); await f.Disk.PendingSweep;
  var io=(SemaphoreSlim)Field(f.Disk,"_io");
  for(var i=0;i<ServerBlobCache.MaxConcurrentIo;i++) await io.WaitAsync();
  var promotion=f.Raw.PromoteAsync();
  try {
   await Until(()=>Number(f.Disk,"_pendingIo")>0);
   await Task.Run(f.Raw.Dispose).WaitAsync(TimeSpan.FromSeconds(3));
   Assert.Equal(0,f.Blobs);
  } finally { io.Release(ServerBlobCache.MaxConcurrentIo); }
  await promotion; await f.Drain();
  Assert.Equal(0,f.Blobs);
  Assert.True(File.Exists(f.Legacy));
  Assert.False(File.Exists(f.Legacy+".migrated"));
 }

 [Theory]
 [InlineData(false)]
 [InlineData(true)]
 public async Task RequestAlreadyFetchingMustNotStartSavingAfterDispose(bool dispose) {
  var root=Path.Combine(Path.GetTempPath(),"hpr-dispose-fetch-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
  var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
  using var net=new IntegrationTransport(async (_,ct)=> { await release.Task.WaitAsync(ct); return IntegrationTransport.Response("{\"id\":604}"); });
  var clock=new IntegrationTmdbDiskCacheTests.Clock {Now=DateTimeOffset.UtcNow};
  var disk=new ServerBlobCache(()=>new(true,"",0,0),new ServerCacheLocation(root,Array.Empty<string>()),null,()=>clock.Now.UtcDateTime) {SweepDebounce=TimeSpan.Zero};
  var raw=new TmdbResponseCache(net,clock,null,disk,null,null);
  try {
   var request=raw.GetAsync("movie/604","","key",default);
   await Until(()=>net.Calls==1);
   if(dispose) await Task.Run(raw.Dispose).WaitAsync(TimeSpan.FromSeconds(3));
   release.SetResult(); await request;
   await Until(()=>Number(disk,"_pendingIo")==0);
   await disk.PendingSweep;
   Assert.Equal(dispose ? 0 : 1,Directory.EnumerateFiles(root,"*.blob",SearchOption.AllDirectories).Count());
  } finally { release.TrySetResult(); raw.Dispose(); await disk.PendingSweep; Directory.Delete(root,true); }
 }

 [Fact] public async Task DirtyTimerAlreadyWaitingOnPreparationMustNotKeepDisposeWaiting() {
  await using var f=new Fixture(); await f.Disk.PendingSweep;
  await f.Raw.GetAsync("movie/604","","key",default);
  var timer=(Timer)Field(f.Raw,"_debounceSaveTimer"); timer.Change(Timeout.Infinite,Timeout.Infinite);
  Task? disposing=null; Task? forgetting=null; var completed=false;
  using(new PreparationHold(f.Disk)) {
   f.Settings=f.Settings with {Enabled=true};
   var before=Volatile.Read(ref f.ReadyCalls);
   timer.Change(0,Timeout.Infinite);
   await Until(()=>Volatile.Read(ref f.ReadyCalls)>before);
   forgetting=Task.Run(()=>f.Raw.Forget("movie/603","","key"));
   await Until(()=>(bool)Field(f.Raw,"_dirty"));
   disposing=Task.Run(f.Raw.Dispose);
   completed=await Task.WhenAny(disposing,Task.Delay(1500))==disposing;
   // Release the holder before asserting so the failing probe also cleans up.
  }
  await forgetting!.WaitAsync(TimeSpan.FromSeconds(4));
  await disposing!.WaitAsync(TimeSpan.FromSeconds(4));
  await Task.Run(()=> { lock(Field(f.Raw,"_saveLock")) { } }).WaitAsync(TimeSpan.FromSeconds(4));
  await f.Drain();
  Assert.True(completed,"Dispose still waits on _saveLock held by the timer's uncancellable DiskReady");
 }
}
