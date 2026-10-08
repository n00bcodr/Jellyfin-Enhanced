using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationAnalyticsTests
{
    private static AnalyticsReportingService Service(ApiPluginFixture f, UsageEventCounterService counters, IHttpClientFactory transport)
    {
        var host = new Mock<IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersionString).Returns("12.0.0-test");
        return new(transport, f.Core.Paths.Object, host.Object, counters, f.Core.Manager, f.Core.Logger);
    }

    [Theory]
    [InlineData("none", 1, 7, false)]
    [InlineData("plugin", 1, 7, true)]
    [InlineData("target", 1, 7, true)]
    [InlineData("host", 1, 7, true)]
    [InlineData("none", 8, 1, true)]
    [InlineData("none", 2, 1, false)]
    [InlineData("none", 31, 99, true)]
    [InlineData("none", 29, 99, false)]
    public async Task ReportingCadenceDetectsEnvironmentChangesAndClampsInterval(string changed, int ageDays, int interval, bool expectedSend)
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.AnalyticsEnabled = true;
        c.AnalyticsInstallId = "server-id"; c.AnalyticsInstallSecret = "server-secret";
        c.AnalyticsLastReportedAt = DateTimeOffset.UtcNow.AddDays(-ageDays).ToUnixTimeMilliseconds();
        c.AnalyticsLastReportedPluginVersion = changed == "plugin" ? "older" : f.Plugin.Version.ToString();
        c.AnalyticsLastReportedJellyfinTarget = changed == "target" ? "older-target" : HostCompatibilityService.BuiltFor;
        c.AnalyticsLastReportedJellyfinVersion = changed == "host" ? "older-host" : "12.0.0-test";
        c.AnalyticsReportIntervalDays = interval;
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        await Service(f, counters, transport).ReportIfDueAsync(default);
        Assert.Equal(expectedSend ? 1 : 0, transport.Calls);
        if (expectedSend)
        {
            Assert.Equal(f.Plugin.Version.ToString(), c.AnalyticsLastReportedPluginVersion);
            Assert.Equal(HostCompatibilityService.BuiltFor, c.AnalyticsLastReportedJellyfinTarget);
            Assert.Equal("12.0.0-test", c.AnalyticsLastReportedJellyfinVersion);
        }
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 2)]
    public async Task OnlyConsentLetsAnOverdueOrForcedReportReachTheNetwork(bool consent, int expectedCalls)
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.AnalyticsEnabled = consent;
        c.AnalyticsInstallId = "server-id"; c.AnalyticsInstallSecret = "server-secret";
        // Overdue and every version changed: only consent can stop the scheduled report.
        c.AnalyticsLastReportedAt = DateTimeOffset.UtcNow.AddDays(-60).ToUnixTimeMilliseconds();
        c.AnalyticsLastReportedPluginVersion = "older";
        c.AnalyticsLastReportedJellyfinTarget = "older-target";
        c.AnalyticsLastReportedJellyfinVersion = "older-host";
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        var service = Service(f, counters, transport);
        await service.ReportIfDueAsync(default);
        Assert.Equal(consent ? 1 : 0, transport.Calls);
        await service.ForceSendAsync(default);
        Assert.Equal(expectedCalls, transport.Calls);
    }

    [Theory]
    [InlineData(200)][InlineData(403)][InlineData(429)][InlineData(500)]
    public async Task OnlyAcknowledgedReportAdvancesCheckpointAndSubtractsExactlySentCounters(int status)
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.AnalyticsEnabled = true; c.AnalyticsShareUsageCounts = true;
        c.AnalyticsInstallId = "server-id"; c.AnalyticsInstallSecret = "server-secret";
        c.AnalyticsLastReportedAt = 123;
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        counters.Increment("seerr.request_submitted");
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            var sent = payload.RootElement.GetProperty("p_events").EnumerateArray().Single(e => e.GetProperty("key").GetString() == "seerr.request_submitted");
            Assert.Equal(1, sent.GetProperty("count").GetInt32());
            counters.Increment("seerr.request_submitted"); // an action completed while HTTP was in flight
            return IntegrationTransport.Response("{}", status);
        });
        await Service(f, counters, transport).ForceSendAsync(default);
        Assert.Equal(status == 200 ? 1 : 2, counters.GetSnapshot().Counters["seerr.request_submitted"]);
        if (status == 200) Assert.True(c.AnalyticsLastReportedAt > 123);
        else Assert.Equal(123, c.AnalyticsLastReportedAt);
        Assert.Equal("server-id", c.AnalyticsInstallId);
    }

    [Theory]
    [InlineData(false, false, false)][InlineData(true, false, false)]
    [InlineData(false, true, false)][InlineData(false, false, true)]
    [InlineData(true, true, true)]
    public void PayloadHonorsIndependentPrivacyCategoriesWithoutSecretsOrUserIds(bool flags, bool usage, bool sizes)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AnalyticsEnabled = true; config.AnalyticsShareUsageCounts = true;
        config.AnalyticsInstallId = "random-install-id";
        config.AnalyticsInstallSecret = "private-install-secret";
        config.TMDB_API_KEY = "private-tmdb-key";
        config.MdblistApiKey = "private-mdblist-key";
        config.ShokoUrl = "http://private-shoko.internal";
        var userId = Guid.NewGuid().ToString();
        config.MaintenanceModeAffectedUsers = "[\"" + userId + "\"]";
        config.LanguageTagsPriority = "English,ja,zh-Hans-CN,private@email.invalid";
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        counters.Increment("seerr.request_submitted");
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Building previews must not make HTTP calls"));
        var payload = Service(f, counters, transport).BuildPayload(config, flags, usage, sizes);
        Assert.Equal(flags, payload.Config != null);
        Assert.Equal(flags, payload.Settings != null);
        Assert.Equal(usage, payload.Events != null);
        Assert.Equal(sizes, payload.DataFileSizes != null);
        Assert.Equal("random-install-id", payload.InstallId);
        if (flags)
        {
            Assert.True(payload.Config!["TmdbEnabled"]);
            Assert.True(payload.Config["MdblistEnabled"]);
            Assert.Equal("ja,zh-hans-cn", payload.Settings!["LanguageTagsPriority"]);
            Assert.DoesNotContain(payload.Config.Keys, k => k.StartsWith("Analytics", StringComparison.Ordinal));
        }
        if (usage) Assert.Equal(1, Assert.Single(payload.Events!, e => e.Key == "seerr.request_submitted").Count);
        var serialized = JsonSerializer.Serialize(payload);
        foreach (var secret in new[] { "private-install-secret", "private-tmdb-key", "private-mdblist-key", "private-shoko.internal", userId, "private@email.invalid" }) Assert.DoesNotContain(secret, serialized);
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData("[]")][InlineData("null")][InlineData("{}")][InlineData("{\"install_id\":1,\"secret\":\"secret\"}")][InlineData("{")]
    public async Task MalformedRegistrationCannotReplaceIdentity(string body)
    {
        using var f = new ApiPluginFixture();
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(body)));
        await Service(f, counters, transport).EnsureRegisteredAsync(f.Plugin.Configuration, default);
        Assert.True(string.IsNullOrEmpty(f.Plugin.Configuration.AnalyticsInstallId));
        Assert.True(string.IsNullOrEmpty(f.Plugin.Configuration.AnalyticsInstallSecret));
    }

    [Fact]
    public async Task RegistrationUsesServerIssuedIdentityAndSubsequentCallsAreIdempotent()
    {
        using var f = new ApiPluginFixture();
        using var counters = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        using var transport = new IntegrationTransport(async (request, _) =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.EndsWith("/register_install", request.RequestUri!.AbsolutePath);
            Assert.Equal("{}", await request.Content!.ReadAsStringAsync());
            return IntegrationTransport.Response("[{\"install_id\":\"server-id\",\"secret\":\"server-secret\"}]");
        });
        var service = Service(f, counters, transport);
        await service.EnsureRegisteredAsync(f.Plugin.Configuration, default);
        await service.EnsureRegisteredAsync(f.Plugin.Configuration, default);
        Assert.Equal("server-id", f.Plugin.Configuration.AnalyticsInstallId);
        Assert.Equal("server-secret", f.Plugin.Configuration.AnalyticsInstallSecret);
        Assert.Equal(1, transport.Calls);
        Assert.DoesNotContain("server-secret", JsonSerializer.Serialize(service.BuildPayload(f.Plugin.Configuration, false, false, false)));
    }
}
