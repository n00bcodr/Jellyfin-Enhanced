using System.Diagnostics;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
namespace JE.Tests;
/// <summary>
/// Shutdown review round 2 (HPR2-1, HPR2-2), ported from the review clone: a commit paused before its rename, or a
/// migration waiting on the snapshot lock, never lands after Dispose returns, and the store's Dispose stays bounded
/// while a sweep or a commit holds its accounting lock inside a stuck file-system call.
/// </summary>
[Collection("Server cache native hooks")]
public sealed class ServerBlobCacheShutdownReviewTests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "je-hpr-" + Guid.NewGuid().ToString("N"));
    DateTime now = DateTime.UtcNow;
    ServerCacheSettings settings = new(true, "", 0, 0);
    string Own => Path.Combine(root, "plugins", "own");
    string Folder => Path.Combine(Own, "server-cache");
    string Marker => Path.Combine(Folder, ServerCacheLocation.MarkerName);
    ServerCacheLocation Location => new(Own, new[] { Path.Combine(root, "data"), Path.Combine(root, "plugins") }, Path.Combine(root, "cache"));
    ServerBlobCache Make(Func<DateTime>? clock = null) { var c = new ServerBlobCache(() => settings, Location, null, clock ?? (() => now)) { SweepDebounce = TimeSpan.Zero }; c.Register(new("artwork")); return c; }
    static string Hash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("artwork\n" + key)));
    string Blob(string key) => Path.Combine(Folder, "artwork", Hash(key)[..2], Hash(key) + ".blob");
    static Task<bool> Put(ServerBlobCache c, string key = "a", int size = 10) => c.PutAsync("artwork", key, new byte[size], "image/jpeg", CancellationToken.None);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    sealed class NativeWrap : IDisposable
    {
        readonly object lib; readonly FieldInfo field; readonly Delegate original;
        public NativeWrap(string name, Func<object?[], Func<object?>, object?> invoke)
        {
            var t = typeof(ServerBlobCache).Assembly.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache.LinuxFolderAccess")!;
            lib = t.GetField("Lib", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
            field = lib.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
            original = (Delegate)field.GetValue(lib)!;
            Func<object?[], object?> call = args => invoke(args, () => original.DynamicInvoke(args));
            var method = field.FieldType.GetMethod("Invoke")!;
            var pars = method.GetParameters().Select(p => Expression.Parameter(p.ParameterType)).ToArray();
            var array = Expression.NewArrayInit(typeof(object), pars.Select(p => Expression.Convert(p, typeof(object))));
            var body = Expression.Convert(Expression.Invoke(Expression.Constant(call), array), method.ReturnType);
            field.SetValue(lib, Expression.Lambda(field.FieldType, body, pars).Compile());
        }
        public void Dispose() => field.SetValue(lib, original);
    }

    static object Field(object owner,string name) => owner.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(owner)!;
    static async Task Until(Func<bool> done) => await IntegrationTmdbDiskCacheTests.Until(done);
    string[] Blobs() => Directory.Exists(Folder) ? Directory.GetFiles(Folder,"*.blob",SearchOption.AllDirectories) : [];

    // Resume a real bound statx before or after the native call returns. Both windows are after the token fence.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PromotionMidCommitMustNotLandAfterRawDispose(bool afterSyscall)
    {
        Directory.CreateDirectory(Own);
        var legacy=Path.Combine(Own,"tmdb-cache.json");
        var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")),0,8);
        File.WriteAllText(legacy,JsonSerializer.Serialize(new {V=1,Entries=new[] {new {
            K=hash+"|https://api.themoviedb.org/3/movie/603",S=200,C="{\"id\":603}",
            E=new DateTimeOffset(now.AddHours(6)).ToUnixTimeMilliseconds(),F=now.Ticks}}}));
        using var c=Make(); Assert.True(c.Enabled); await c.PendingSweep;
        using var net=new IntegrationTransport((_,_)=>Task.FromResult(IntegrationTransport.Response("{}")));
        var clock=new IntegrationTmdbDiskCacheTests.Clock {Now=new DateTimeOffset(now)};
        using var raw=new TmdbResponseCache(net,clock,null,c,legacy,null);
        using var entered=new ManualResetEventSlim(); using var release=new ManualResetEventSlim();
        int intercepted=0; bool bounded=false; int before=-1;
        using(new NativeWrap("_statx",(args,next)=> {
            if(!((string)args[1]!).EndsWith(".blob",StringComparison.Ordinal) || Interlocked.Exchange(ref intercepted,1)!=0) return next();
            if(afterSyscall) { var result=next(); var error=Marshal.GetLastPInvokeError(); entered.Set(); release.Wait(); Marshal.SetLastPInvokeError(error); return result; }
            entered.Set(); release.Wait(); return next();
        })) {
            var promotion=Task.Run(raw.PromoteAsync);
            try {
                Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
                var disposing=Task.Run(raw.Dispose);
                await Until(()=>((CancellationTokenSource)Field(raw,"_disposing")).IsCancellationRequested);
                bounded=await Task.WhenAny(disposing,Task.Delay(1800))==disposing;
                before=Blobs().Length;
            } finally { release.Set(); }
            await promotion.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.True(bounded); Assert.Equal(0,before);
        Assert.True(File.Exists(legacy)); Assert.False(File.Exists(legacy+".migrated"));
        Assert.Empty(Blobs());
    }

    [Fact]
    public async Task StoreDisposeIsBoundedWhileSweepHoldsAccountingLockInUnlink()
    {
        var c=Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var temp=Path.Combine(Path.GetDirectoryName(Blob("a"))!,new string('b',64)+".0123456789abcdef.tmp");
        File.WriteAllBytes(temp,new byte[1]);
        using var entered=new ManualResetEventSlim(); using var release=new ManualResetEventSlim();
        Task? disposing=null; bool bounded=false;
        using(new NativeWrap("_unlinkAt",(args,next)=> {
            if((string)args[1]! == Path.GetFileName(temp)) { entered.Set(); release.Wait(); }
            return next();
        })) {
            settings=settings with {MaxBytes=8192}; c.SettingsChanged();
            try {
                Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
                disposing=Task.Run(c.Dispose);
                await Until(()=>((CancellationTokenSource)Field(c,"_closing")).IsCancellationRequested);
                bounded=await Task.WhenAny(disposing,Task.Delay(1800))==disposing;
            } finally { release.Set(); }
            await disposing!.WaitAsync(TimeSpan.FromSeconds(5)); await c.PendingSweep;
        }
        Assert.True(bounded,"Dispose's lock(_lock) waited beyond its stated one-second bound while the sweep was in unlink");
    }

    [Fact]
    public async Task StoreDisposeIsBoundedWhileCommitStatxIsStuck()
    {
        var c=Make(); Assert.True(c.Enabled); await c.PendingSweep;
        using var entered=new ManualResetEventSlim(); using var release=new ManualResetEventSlim();
        Task? disposing=null; bool bounded=false; Task<bool>? write=null;
        using(new NativeWrap("_statx",(args,next)=> {
            if(((string)args[1]!).EndsWith(".blob",StringComparison.Ordinal)) { entered.Set(); release.Wait(); }
            return next();
        })) {
            write=Task.Run(()=>Put(c));
            try {
                Assert.True(entered.Wait(TimeSpan.FromSeconds(5))); disposing=Task.Run(c.Dispose);
                await Until(()=>((CancellationTokenSource)Field(c,"_closing")).IsCancellationRequested);
                bounded=await Task.WhenAny(disposing,Task.Delay(1800))==disposing;
            } finally { release.Set(); }
            await disposing!.WaitAsync(TimeSpan.FromSeconds(5)); await write.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.True(bounded,"Dispose cannot reach its bounded wait because a stalled commit holds _lock");
        Assert.Empty(Blobs());
    }

    [Fact]
    public async Task MigrationWaitingOnLegacyLockMustNotRetireSnapshotAfterDispose()
    {
        Directory.CreateDirectory(Own);
        var legacy=Path.Combine(Own,"tmdb-cache.json");
        var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("key")),0,8);
        File.WriteAllText(legacy,JsonSerializer.Serialize(new {V=1,Entries=new[] {new {
            K=hash+"|https://api.themoviedb.org/3/movie/603",S=200,C="{\"id\":603}",
            E=new DateTimeOffset(now.AddHours(6)).ToUnixTimeMilliseconds(),F=now.Ticks}}}));
        using var c=Make(); Assert.True(c.Enabled); await c.PendingSweep;
        using var net=new IntegrationTransport((_,_)=>Task.FromResult(IntegrationTransport.Response("{}")));
        var clock=new IntegrationTmdbDiskCacheTests.Clock {Now=new DateTimeOffset(now)};
        using var raw=new TmdbResponseCache(net,clock,null,c,legacy,null);
        // Save the memory entry first, without retiring its legacy snapshot; the next promotion needs only migration.
        var field=typeof(TmdbResponseCache).GetField("_legacy",BindingFlags.Instance|BindingFlags.NonPublic)!;
        var records=field.GetValue(raw); Assert.NotNull(records); field.SetValue(raw,null);
        await raw.PromoteAsync(); Assert.Single(Blobs()); field.SetValue(raw,records);
        using var held=new ManualResetEventSlim(); using var release=new ManualResetEventSlim();
        var holder=new Thread(()=> { lock(Field(raw,"_legacyFileLock")) { held.Set(); release.Wait(); } });
        holder.Start(); Assert.True(held.Wait(TimeSpan.FromSeconds(5)));
        Exception? error=null;
        var worker=new Thread(()=> { try { raw.PromoteAsync().GetAwaiter().GetResult(); } catch(Exception ex) { error=ex; } });
        worker.Start(); bool bounded=false; bool existed=false;
        try {
            await Until(()=>(int)Field(raw,"_promoting")==1 && worker.ThreadState.HasFlag(System.Threading.ThreadState.WaitSleepJoin));
            var disposing=Task.Run(raw.Dispose);
            bounded=await Task.WhenAny(disposing,Task.Delay(1800))==disposing;
            existed=File.Exists(legacy);
        } finally { release.Set(); holder.Join(); worker.Join(); }
        Assert.Null(error); Assert.True(bounded); Assert.True(existed);
        Assert.True(File.Exists(legacy),"A migration abandoned at a managed monitor wait retired the snapshot after Dispose returned");
        Assert.False(File.Exists(legacy+".migrated"));
    }
}
