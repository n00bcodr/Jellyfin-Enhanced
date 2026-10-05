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
    [InlineData("http://0.0.0.0", false)]
    [InlineData("http://[::]", false)]
    [InlineData("http://[::1]:8989/base", true)]
    [InlineData("https://192.168.1.2/base", true)]
    public async Task LiteralAndKnownHostRulesMatchInSyncAndAsyncEntryPoints(string url, bool expected)
    {
        Assert.Equal(expected, ArrUrlGuard.IsAllowedUrl(url));
        Assert.Equal(expected, await ArrUrlGuard.IsAllowedUrlAsync(url));
    }
}
