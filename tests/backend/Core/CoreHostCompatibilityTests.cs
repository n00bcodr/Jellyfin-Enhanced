using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller;
using Moq;

namespace JE.Tests;

public class CoreHostCompatibilityTests
{
    private static HostCompatibilityService Service(bool mismatch)
    {
        var matchingMajor = HostCompatibilityService.BuiltFor == "jf12" ? 12 : 10;
        var version = new Version(mismatch ? (matchingMajor == 12 ? 10 : 12) : matchingMajor, 0);
        var host = new Mock<IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersion).Returns(version);
        host.SetupGet(h => h.ApplicationVersionString).Returns(version.ToString());
        return new HostCompatibilityService(host.Object);
    }

    private static void WriteModule(string path, Guid mvid)
    {
        // Tiny managed PE files let us replace the disk image without loading assemblies.
        var metadata = new MetadataBuilder();
        metadata.AddModule(0, metadata.GetOrAddString("plugin.dll"), metadata.GetOrAddGuid(mvid), default, default);
        var pe = new ManagedPEBuilder(new PEHeaderBuilder(), new MetadataRootBuilder(metadata), new BlobBuilder());
        var image = new BlobBuilder();
        pe.Serialize(image);
        File.WriteAllBytes(path, image.ToArray());
    }

    [Fact]
    public void RunningModuleMatchesItsUnchangedFile()
        => Assert.False(Service(false).IsStale);

    [Fact]
    public void MvidCheckDetectsReplacementAndRechecksTheSamePath()
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.Root, "plugin.dll");
        var loadedMvid = Guid.NewGuid();
        WriteModule(path, loadedMvid);
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));

        var replacement = Path.Combine(f.Root, "replacement.dll");
        WriteModule(replacement, Guid.NewGuid());
        File.Move(replacement, path, true);
        Assert.True(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));

        WriteModule(path, loadedMvid);
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("\0")]
    public void UnavailableLocationIsNotStale(string? location)
        => Assert.False(HostCompatibilityService.IsAssemblyStale(location, Guid.NewGuid()));

    [Fact]
    public void MissingOrLockedFileIsNotStale()
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.Root, "plugin.dll");
        var loadedMvid = Guid.NewGuid();
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));
        WriteModule(path, Guid.NewGuid());
        using var locked = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not a PE file")]
    [InlineData("MZ")]
    public void InvalidPeIsNotStale(string contents)
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.Root, "plugin.dll");
        File.WriteAllText(path, contents);
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, Guid.NewGuid()));
    }

    [Fact]
    public void MissingMvidIsNotStale()
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.Root, "plugin.dll");
        WriteModule(path, Guid.Empty);
        Assert.False(HostCompatibilityService.IsAssemblyStale(path, Guid.NewGuid()));
    }

    [Fact]
    public void SharedWriterDoesNotPreventMetadataCheck()
    {
        using var f = new CoreFixture();
        var path = Path.Combine(f.Root, "plugin.dll");
        var loadedMvid = Guid.NewGuid();
        WriteModule(path, Guid.NewGuid());
        using var writer = File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
        Assert.True(HostCompatibilityService.IsAssemblyStale(path, loadedMvid));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void GuidanceDistinguishesInstallFromProcessRestart(bool mismatch, bool stale)
    {
        var service = Service(mismatch);
        var message = service.GetCompatibilityMessage(stale);
        if (!mismatch && !stale)
        {
            Assert.Null(message);
            return;
        }

        Assert.NotNull(message);
        Assert.Contains("a dashboard restart keeps", message);
        Assert.Contains("systemctl restart jellyfin", message);
        Assert.Contains("docker restart <container>", message);
        Assert.DoesNotContain("Install ", message);
        Assert.Equal(mismatch, message.Contains("This copy of Jellyfin Enhanced was built for", StringComparison.Ordinal));
        Assert.Equal(stale, message.Contains("still running the old copy from memory", StringComparison.Ordinal));
        Assert.Equal(!stale, message.Contains("Both builds share one version number", StringComparison.Ordinal));

        var logged = service.GetCompatibilityMessage(stale, includeInstallAdvice: true)!;
        Assert.Equal(!stale, logged.Contains($"Install {service.ExpectedAssetName} from {HostCompatibilityService.ManifestUrl}.", StringComparison.Ordinal));
    }
}
