using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using MediaBrowser.Controller;
using Moq;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Host;

namespace JE.Tests;

public class CoreHostCompatibilityTests
{
    private static HostCompatibilityService Service(bool mismatch)
    {
        var version = new Version(mismatch ? 10 : 12, 0);
        var host = new Mock<IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersion).Returns(version);
        host.SetupGet(h => h.ApplicationVersionString).Returns(version.ToString());
        return new HostCompatibilityService(host.Object);
    }

    private static HostCompatibilityService Service(string versionString)
    {
        var host = new Mock<IServerApplicationHost>();
        // Prerelease builds report their numeric assembly version, e.g. 13.0.0-rc1 as 13.0.0.0.
        host.SetupGet(h => h.ApplicationVersion).Returns(new Version(versionString.Split('-')[0]));
        host.SetupGet(h => h.ApplicationVersionString).Returns(versionString);
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
    public void GuidanceDistinguishesUnsupportedHostFromProcessRestart(bool mismatch, bool stale)
    {
        var service = Service(mismatch);
        var message = service.GetCompatibilityMessage(stale);
        if (!mismatch && !stale)
        {
            Assert.Null(message);
            return;
        }

        Assert.NotNull(message);
        Assert.Equal(stale, message.Contains("a dashboard restart keeps", StringComparison.Ordinal));
        Assert.Equal(stale, message.Contains("systemctl restart jellyfin", StringComparison.Ordinal));
        Assert.Equal(stale, message.Contains("docker restart <container>", StringComparison.Ordinal));
        Assert.Equal(stale, message.Contains("still running the old copy from memory", StringComparison.Ordinal));
        Assert.Equal(mismatch, message.Contains("Upgrade the server to Jellyfin 12.x", StringComparison.Ordinal));
        Assert.DoesNotContain(".zip", message);
        Assert.DoesNotContain("Both builds", message);
    }

    [Theory]
    [InlineData("0.0.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("9.0.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("10.10.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("10.11.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("10.11.11", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("11.0.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("12.0.0", "jf12", "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip")]
    [InlineData("12.0.0-rc1", "jf12", "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip")]
    [InlineData("12.4.0", "jf12", "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip")]
    [InlineData("13.0.0", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("13.0.0-rc1", HostCompatibilityService.UnsupportedTarget, null)]
    [InlineData("14.1.0", HostCompatibilityService.UnsupportedTarget, null)]
    public void HostLinesMapToExactTargets(string version, string target, string? asset)
    {
        var service = Service(version);
        Assert.Equal(target, service.HostTarget);
        Assert.Equal(asset, service.ExpectedAssetName);
        Assert.Equal(target == HostCompatibilityService.UnsupportedTarget, service.IsHostUnsupported);
        Assert.Equal(target != HostCompatibilityService.BuiltFor, service.IsMismatch);
        Assert.Equal(service.IsMismatch, service.GetCompatibilityMessage(false) is not null);
    }

    [Theory]
    [InlineData("10.11.0", false)]
    [InlineData("10.11.0", true)]
    [InlineData("11.0.0", false)]
    [InlineData("11.0.0", true)]
    [InlineData("13.0.0", false)]
    [InlineData("13.0.0", true)]
    [InlineData("13.0.0-rc1", false)]
    [InlineData("14.1.0", true)]
    public void UnsupportedHostNamesTheLinesAndOffersNoAsset(string version, bool stale)
    {
        var service = Service(version);
        Assert.True(service.IsMismatch);
        Assert.True(service.IsHostUnsupported);
        Assert.Null(service.ExpectedAssetName);

        var message = service.GetCompatibilityMessage(stale)!;
        Assert.Contains("supports Jellyfin 12.x only", message);
        Assert.Contains($"the server is Jellyfin {version}", message);
        Assert.DoesNotContain("yet", message);
        Assert.DoesNotContain(".zip", message);
        Assert.DoesNotContain(HostCompatibilityService.ManifestUrl, message);
        Assert.DoesNotContain(HostCompatibilityService.ReleasesUrl, message);
        Assert.Equal(stale, message.Contains("plugin file on disk was replaced", StringComparison.Ordinal));
        if (service.HostVersion.Major < 12)
            Assert.Contains("Upgrade the server to Jellyfin 12.x", message);
        else
            Assert.Contains("explicitly supports this server's major version", message);

        var logged = service.GetCompatibilityMessage(stale, includeInstallAdvice: true)!;
        Assert.Contains(HostCompatibilityService.ReleasesUrl, logged);
        Assert.DoesNotContain(HostCompatibilityService.ManifestUrl, logged);
        Assert.DoesNotContain(".zip", logged);
    }
}
