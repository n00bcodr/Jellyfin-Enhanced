using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class CoreUsageTests
{
    [Theory]
    [InlineData(false, false)][InlineData(false, true)][InlineData(true, false)]
    public void ConsentMustEnableAnalyticsAndUsageBeforeAnyDataIsCollected(bool analytics, bool usage)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AnalyticsEnabled = analytics;
        f.Plugin.Configuration.AnalyticsShareUsageCounts = usage;
        using (var service = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger))
        {
            service.Increment("seerr.request_submitted");
            Assert.Empty(service.GetSnapshot().Counters);
        }
        Assert.False(File.Exists(Path.Combine(f.Core.ConfigRoot, "usage-counters.json")));
    }

    [Fact]
    public void ResetSubtractsOnlyAcknowledgedSnapshotAndRestartPreservesConcurrentIncrements()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AnalyticsEnabled = true;
        f.Plugin.Configuration.AnalyticsShareUsageCounts = true;
        using (var service = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger))
        {
            Parallel.For(0, 100, _ => service.Increment("seerr.request_submitted"));
            var sent = service.GetSnapshot();
            service.Increment("seerr.request_submitted");
            Assert.Equal(100, sent.Counters["seerr.request_submitted"]);
            service.ResetForNewPeriod("2026-10-05", sent.Counters);
            Assert.Equal(1, service.GetSnapshot().Counters["seerr.request_submitted"]);
        }
        using var restarted = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        Assert.Equal("2026-10-05", restarted.GetSnapshot().PeriodStart);
        Assert.Equal(1, restarted.GetSnapshot().Counters["seerr.request_submitted"]);
        restarted.ResetForNewPeriod("2026-10-06");
        Assert.Empty(restarted.GetSnapshot().Counters);
    }

    [Fact]
    public void PersistedUnknownAndNonpositiveCountersAreFiltered()
    {
        using var f = new CoreFixture();
        File.WriteAllText(Path.Combine(f.ConfigRoot, "usage-counters.json"), "{\"SchemaVersion\":1,\"PeriodStart\":\"2026-10-01\",\"Counters\":{\"seerr.request_submitted\":3,\"continue_watching.auto_removed\":-1,\"total.users\":9999,\"private-user-id\":5}}");
        using var service = new UsageEventCounterService(f.Paths.Object, f.Logger);
        Assert.Equal(3, Assert.Single(service.GetSnapshot().Counters).Value);
    }

    [Theory]
    [InlineData("broken")][InlineData("null")][InlineData("{\"SchemaVersion\":2}")]
    [InlineData("{\"SchemaVersion\":1,\"Counters\":null}")]
    public void CorruptOrUnsupportedDiskStateCannotPreventStartup(string content)
    {
        using var f = new CoreFixture();
        File.WriteAllText(Path.Combine(f.ConfigRoot, "usage-counters.json"), content);
        using var service = new UsageEventCounterService(f.Paths.Object, f.Logger);
        Assert.Empty(service.GetSnapshot().Counters);
    }

    [Fact]
    public void PeriodUsesGregorianCalendarUnderNonGregorianCulture()
    {
        using var f = new CoreFixture();
        var old = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("th-TH");
            using var service = new UsageEventCounterService(f.Paths.Object, f.Logger);
            Assert.Equal(DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), service.GetSnapshot().PeriodStart);
        }
        finally { CultureInfo.CurrentCulture = old; }
    }

    [Theory]
    [InlineData("secret.user")][InlineData("total.users")][InlineData("private-user-id")]
    public void UnknownKeysCannotEnterPublicUsageSnapshot(string key)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AnalyticsEnabled = true;
        f.Plugin.Configuration.AnalyticsShareUsageCounts = true;
        using var service = new UsageEventCounterService(f.Core.Paths.Object, f.Core.Logger);
        service.Increment(key);
        Assert.Empty(service.GetSnapshot().Counters);
    }
}
