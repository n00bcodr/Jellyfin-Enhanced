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
        Assert.Equal(mismatch && stale, message.Contains("the file on disk is the wrong build too", StringComparison.Ordinal));
        Assert.Equal(mismatch, message.Contains("This copy of Jellyfin Enhanced was built for", StringComparison.Ordinal));
        Assert.Equal(stale, message.Contains("still running the old copy from memory", StringComparison.Ordinal));
        Assert.Equal(!stale, message.Contains("Both builds share one version number", StringComparison.Ordinal));

        var logged = service.GetCompatibilityMessage(stale, includeInstallAdvice: true)!;
        // Stale and mismatched: the replacement may be the wrong build too, so the log still names the right one.
        Assert.Equal(mismatch, logged.Contains($"{service.ExpectedAssetName} from {HostCompatibilityService.ManifestUrl}.", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("10.11.0", "jf10", "Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip")]
    [InlineData("10.11.11", "jf10", "Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip")]
    [InlineData("11.0.0", "jf10", "Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip")]
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
    [InlineData("13.0.0", false)]
    [InlineData("13.0.0", true)]
    [InlineData("13.0.0-rc1", false)]
    public void UnsupportedHostNamesTheLinesAndOffersNoAsset(string version, bool stale)
    {
        var service = Service(version);
        Assert.True(service.IsMismatch);

        var message = service.GetCompatibilityMessage(stale)!;
        Assert.Contains("does not support Jellyfin 13.x yet", message);
        Assert.Contains($"the server is Jellyfin {version}", message);
        Assert.Contains("Stay on Jellyfin 12.x", message);
        Assert.Contains("lists Jellyfin 13 support.", message);
        Assert.DoesNotContain(".zip", message);
        Assert.DoesNotContain("Install ", message);
        Assert.DoesNotContain(HostCompatibilityService.ManifestUrl, message);
        // Swapping builds cannot help here, so the build-swap restart advice is not repeated.
        Assert.DoesNotContain("Both builds share one version number", message);
        Assert.Equal(stale, message.Contains("plugin file on disk was also replaced", StringComparison.Ordinal));

        var logged = service.GetCompatibilityMessage(stale, includeInstallAdvice: true)!;
        Assert.Contains($"lists Jellyfin 13 support from {HostCompatibilityService.ManifestUrl}.", logged);
        Assert.DoesNotContain(".zip", logged);
    }
}
