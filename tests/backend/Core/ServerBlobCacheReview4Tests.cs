using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;

namespace JE.Tests;

/// <summary>Controls from the artwork delta review (ACR4): an undeletable orphan stays counted; mixed first-use reads and writes finish.</summary>
public sealed class ServerBlobCacheReview4Tests : IDisposable
{
    readonly string root = Path.Combine(Path.GetTempPath(), "je-acr4-store-" + Guid.NewGuid().ToString("N"));
    readonly ServerCacheSettings settings = new(true, "", 0, 0);
    string Folder => Path.Combine(root, "server-cache");
    ServerBlobCache Make() { var c = new ServerBlobCache(() => settings, new ServerCacheLocation(root, Array.Empty<string>()), null) { SweepDebounce = TimeSpan.Zero }; c.Register(new("artwork")); return c; }
    static string Hash(string key) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("artwork\n" + key)));
    string Blob(string key) => Path.Combine(Folder, "artwork", Hash(key)[..2], Hash(key) + ".blob");
    static Task<bool> Put(ServerBlobCache c, string key = "a") => c.PutAsync("artwork", key, new byte[10], "image/jpeg", CancellationToken.None);
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    // Original ACR2-4 permission-denied orphan probe; explicit block totals added.
    [Fact]
    public async Task OrphanThatCannotBeRemovedMustRemainInCapacityAccounting()
    {
        if (OperatingSystem.IsWindows()) return;
        var c = Make(); Assert.True(await Put(c)); await c.PendingSweep;
        var dir = Path.GetDirectoryName(Blob("a"))!;
        var temp = Path.Combine(dir, Hash("a") + ".0123456789abcdef.tmp"); File.WriteAllBytes(temp, new byte[8192]);
        var mode = File.GetUnixFileMode(dir); File.SetUnixFileMode(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        try
        {
            await c.SweepAsync(false, CancellationToken.None);
            Assert.True(File.Exists(temp)); Assert.Equal(12288, c.Usage().Bytes); Assert.Equal(12288, c.CountedBytes);
            await c.SweepAsync(true, CancellationToken.None);
            Assert.True(File.Exists(temp)); Assert.Equal(12288, c.CountedBytes);
            await c.ClearAsync("other", CancellationToken.None);
            Assert.True(File.Exists(temp)); Assert.Equal(12288, c.CountedBytes);
        }
        finally { File.SetUnixFileMode(dir, mode); }
    }

    [Fact]
    public async Task ConcurrentFirstUseReadersAndWritersCompleteAndReadyReadsKeepProgressing()
    {
        var c = Make();
        var operations = Enumerable.Range(0, 128).Select(i => Task.Run(async () => {
            if (i % 2 == 0) await Put(c, "entry" + i);
            else await c.TryGetAsync("artwork", "entry" + (i - 1), CancellationToken.None);
        })).ToArray();
        await Task.WhenAll(operations).WaitAsync(TimeSpan.FromSeconds(20));
        await c.PendingSweep.WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Null(c.Usage().FolderError);
        Assert.True(await Put(c, "ready"));
        for (int i = 0; i < 64; i++) Assert.NotNull(await c.TryGetAsync("artwork", "ready", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)));
    }
}
