using System.Net;
using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace JE.Tests;

public class UrlPolicyTests
{
    // Supply resolved addresses directly to exercise the real policy without
    // changing machine DNS or relying on external resolver responses.
    private static readonly Func<string, IPAddress[], bool> ResolvedPolicy =
        typeof(ArrUrlGuard).GetMethod("AreResolvedAddressesAllowed", BindingFlags.Static | BindingFlags.NonPublic)!
            .CreateDelegate<Func<string, IPAddress[], bool>>();

    [Theory]
    [InlineData("host.containers.internal", "169.254.1.2", true)]
    [InlineData("host.docker.internal", "169.254.1.2", true)]
    [InlineData("HOST.CONTAINERS.INTERNAL", "169.254.1.2", true)]
    [InlineData("ordinary.internal", "169.254.1.2", false)]
    [InlineData("host.containers.internal.attacker.invalid", "169.254.1.2", false)]
    [InlineData("host.containers.internal", "169.254.169.254", false)]
    [InlineData("host.containers.internal", "169.254.169.1", false)]
    [InlineData("host.docker.internal", "169.254.170.9", false)]
    [InlineData("host.containers.internal", "::ffff:169.254.169.254", false)]
    [InlineData("host.containers.internal", "fd00:ec2::254", false)]
    [InlineData("ordinary.internal", "10.0.0.2", true)]
    [InlineData("ordinary.internal", "127.0.0.1", true)]
    public void ContainerAliasesPermitPodmanLinkLocalWithoutPermittingCloudMetadata(string host, string address, bool expected)
    {
        Assert.Equal(expected, ResolvedPolicy(host, [IPAddress.Parse(address)]));
    }

    [Fact]
    public void EveryResolvedAddressMustBeSafeRegardlessOfOrdering()
    {
        var safe = IPAddress.Parse("10.0.0.2");
        var unsafeAddress = IPAddress.Parse("100.100.100.200");
        Assert.False(ResolvedPolicy("host.docker.internal", [safe, unsafeAddress]));
        Assert.False(ResolvedPolicy("host.docker.internal", [unsafeAddress, safe]));
    }

    [Theory]
    [InlineData("http://[::ffff:169.254.169.254]/latest", false)]
    [InlineData("http://[fd00:ec2::254]/", false)]
    [InlineData("http://metadata.google.internal./latest", false)]
    [InlineData("http://METADATA.GOOG/latest", false)]
    [InlineData("http://169.254.169.254/latest", false)]
    [InlineData("http://169.254.1.2/", false)]
    [InlineData("http://0.0.0.0", false)]
    [InlineData("http://[::]", false)]
    [InlineData("ftp://127.0.0.1/", false)]
    [InlineData("gopher://127.0.0.1/", false)]
    [InlineData("file://server/share", false)]
    [InlineData("http://127.0.0.1/", true)]
    [InlineData("http://[::1]:8989/base", true)]
    [InlineData("https://192.168.1.2/base", true)]
    public async Task LiteralAndKnownHostRulesMatchInSyncAndAsyncEntryPoints(string url, bool expected)
    {
        Assert.Equal(expected, ArrUrlGuard.IsAllowedUrl(url));
        Assert.Equal(expected, await ArrUrlGuard.IsAllowedUrlAsync(url));
    }

    // The metadata host names must be refused by name, before any DNS lookup: offline, or with a
    // resolver that doesn't map them to a blocked address, a DNS fallback would let them through.
    [Theory]
    [InlineData("http://metadata.goog/", false)]
    [InlineData("http://METADATA.GOOGLE.INTERNAL./latest", false)]
    [InlineData("http://ordinary.internal/", null)]
    public void MetadataHostNamesAreRefusedWithoutDns(string url, bool? expected)
    {
        var syncChecks = typeof(ArrUrlGuard).GetMethod("TrySyncChecks", BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.Equal(expected, (bool?)syncChecks.Invoke(null, [url, null]));
    }
}
