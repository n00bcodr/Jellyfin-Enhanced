using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
namespace JE.Tests;
/// <summary>
/// The hardening-pack review probes (HPR-2 and its controls, ported from the review clone): a replacement after the
/// ownership proof stays on the proven handle, and a statx call that fails is never taken for "no file": an
/// unavailable statx refuses the cache, an unreadable entry keeps its previous total.
/// </summary>
[Collection("Server cache native hooks")]
public sealed class ServerBlobCacheHardeningReviewTests : IDisposable
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

    string Foreign(string path)
    {
        Directory.CreateDirectory(Path.Combine(path, "artwork", "ab"));
        File.WriteAllText(Path.Combine(path, "unrelated.txt"), "not owned by the store");
        var file = Path.Combine(path, "artwork", "ab", new string('a', 64) + ".blob");
        File.WriteAllText(file, "foreign shaped data");
        return Path.GetRelativePath(path, file);
    }


    [Theory]
    [InlineData("create")]
    [InlineData("commit")]
    public async Task RootAndMarkerReplacementAfterProofStaysOnProvenHandle(string point)
    {
        var c=Make(); Assert.True(c.Enabled); await c.PendingSweep;
        var swapped=false; var moved=Path.Combine(root,"proven");
        using (new NativeWrap("_openAt",(args,next)=> {
            var name=(string)args[1]!;
            var isMarker=name==ServerCacheLocation.MarkerName;
            // Namespace open occurs only after marker proof. For commit use its existing test seam below.
            if(point=="create" && !swapped && name=="artwork" && new FileInfo("/proc/self/fd/"+args[0]).LinkTarget==Folder) Swap();
            return next();
        }))
        {
            if(point=="commit") c.Hook=p=> { if(p=="commit" && !swapped) Swap(); };
            var stored=await Put(c);
            Assert.True(swapped);
            Assert.False(File.Exists(Blob("a")));
            Assert.True(File.Exists(Path.Combine(Folder,"unrelated.txt")));
            Assert.Equal("foreign-marker",File.ReadAllText(Marker));
            if(point=="commit") Assert.True(stored);
        }
        void Swap() { swapped=true; Directory.Move(Folder,moved); Foreign(Folder); File.WriteAllText(Marker,"foreign-marker"); }
    }

    [Fact]
    public async Task MarkerReplacedByLinkAfterProofNeverWritesThroughLinkAndNextOperationRefuses()
    {
        var c=Make(); Assert.True(c.Enabled); await c.PendingSweep;
        var outside=Path.Combine(root,"outside-marker"); File.WriteAllText(outside,"untouched");
        var swapped=false;
        using(new NativeWrap("_openAt",(args,next)=> {
            if(!swapped && (string)args[1]! == "artwork" && new FileInfo("/proc/self/fd/"+args[0]).LinkTarget==Folder) { swapped=true; File.Delete(Marker); File.CreateSymbolicLink(Marker,outside); }
            return next();
        })) Assert.False(await Put(c));
        Assert.True(swapped); Assert.Equal("untouched",File.ReadAllText(outside)); Assert.False(File.Exists(Blob("a")));
        Assert.False(await Put(c,"b"));
    }

    [Theory]
    [InlineData("sweep", 38)]
    [InlineData("clear", 38)]
    [InlineData("sweep", 1)]
    [InlineData("clear", 1)]
    public async Task StatxRefusalMustNotAllowAnUnaccountableOverwrite(string operation, int errno)
    {
        var c=Make(); Assert.True(await Put(c)); await c.PendingSweep;
        using(new NativeWrap("_statx",(args,next)=> {
            if(new FileInfo("/proc/self/fd/"+args[0]).LinkTarget?.StartsWith(Folder+"/",StringComparison.Ordinal)!=true) return next();
            Marshal.SetLastPInvokeError(errno); return -1;
        }))
        {
            if(operation=="sweep") await c.SweepAsync(true,CancellationToken.None); else await c.ClearAsync(null,CancellationToken.None);
            Assert.Equal(4096,c.CountedBytes); // incomplete count must preserve totals
            var stored=await Put(c); var usage=c.Usage();
            Assert.False(stored,$"unavailable statx still allowed overwrite; running={c.CountedBytes}, shown={usage.Bytes}, error={usage.FolderError ?? "<none>"}");
            Assert.Equal(ServerCacheLocation.Unsupported,usage.FolderError);
        }
    }

    [Theory]
    [InlineData("sweep")]
    [InlineData("clear")]
    public async Task StatFailureAfterListingMustKeepTheUnreadableFilesPreviousTotal(string operation)
    {
        var c=Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var file=Blob("a"); var mode=File.GetUnixFileMode(file); File.SetUnixFileMode(file,UnixFileMode.UserWrite);
        var calls=0;
        try {
            using(new NativeWrap("_statx",(args,next)=> {
                if((string)args[1]! == Path.GetFileName(file) && new FileInfo("/proc/self/fd/"+args[0]).LinkTarget?.StartsWith(Folder+"/",StringComparison.Ordinal)==true && ++calls>1) { Marshal.SetLastPInvokeError(5); return -1; }
                return next();
            })) {
                if(operation=="sweep") await c.SweepAsync(true,CancellationToken.None); else await c.ClearAsync(null,CancellationToken.None);
                Assert.True(calls>1);
                Assert.True(File.Exists(file));
                Assert.Equal(4096,c.CountedBytes);
            }
        } finally { File.SetUnixFileMode(file,mode); }
    }

    // Fix round 2: the store's own shutdown. A read and a write queued on the disk give up, nothing lands, no temporary
    // file is left, and a later settings change starts no sweep.
    [Fact]
    public async Task DisposingTheStoreStopsQueuedDiskWorkAndSweeps()
    {
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var io = (SemaphoreSlim)typeof(ServerBlobCache).GetField("_io", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(c)!;
        for (var i = 0; i < ServerBlobCache.MaxConcurrentIo; i++) await io.WaitAsync();
        var write = Put(c, "queued");
        var read = c.TryGetAsync("artwork", "a", CancellationToken.None);
        try
        {
            c.Dispose();
            Assert.False(await write.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Null(await read.WaitAsync(TimeSpan.FromSeconds(5)));
        }
        finally { io.Release(ServerBlobCache.MaxConcurrentIo); }
        Assert.False(File.Exists(Blob("queued")));
        Assert.Empty(Directory.EnumerateFiles(Folder, "*.tmp", SearchOption.AllDirectories));
        Assert.False(await Put(c, "after"));
        Assert.False(File.Exists(Blob("after")));
        var before = c.PendingSweep;
        settings = settings with { MaxBytes = 4096 };
        c.SettingsChanged();
        Assert.Same(before, c.PendingSweep);
        Assert.True(File.Exists(Blob("a")));
    }
}
