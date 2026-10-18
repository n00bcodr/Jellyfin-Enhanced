using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// 4a review round 7 (4a-behaviour-r7-1): a budget refused because a window is full waits for the LATEST next free slot
/// among its full windows. The hourly window can free up long before the daily one: retrying at the hourly slot can't
/// work, and the time shown would be wrong. The same at admission, in the gate's check before any transport, and at the
/// transport.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationAutomationBudgetSlotTests
{
    public static IEnumerable<object[]> Windows() => new[]
    {
        // Hourly and daily both full: the daily window frees up last (in 4 h), so that is the wait.
        new object[] { "both", 1, 2, 240 },
        new object[] { "daily_only", 5, 2, 240 },
        new object[] { "hourly_only", 1, 10, 50 },
    };

    // Two searches counted on instance r1: one 20 h ago (in the day only) and one 10 min ago (in both windows). The
    // limits then make the hour, the day or both full.
    private static (IntegrationAutomationTests.Engine E, DateTimeOffset Start) Searches()
    {
        var e = new IntegrationAutomationTests.Engine();
        e.Mode(AutomationRecipes.AutoMovie, AutomationMode.Auto);
        var start = e.R.Now;
        e.R.Now = start - TimeSpan.FromHours(20);
        Assert.True(e.Budgets.Admit(BudgetCategories.Search, "r1", "old").Admitted);
        e.R.Now = start - TimeSpan.FromMinutes(10);
        Assert.True(e.Budgets.Admit(BudgetCategories.Search, "r1", "recent").Admitted);
        e.R.Now = start;
        return (e, start);
    }

    [Theory]
    [MemberData(nameof(Windows))]
    public void AFullBudgetWaitsForTheLatestNextSlotAtAdmission(string full, int perHour, int perDay, int minutes)
    {
        var (e, start) = Searches();
        using (e)
        {
            e.C.ArrAutomationSearchesPerHour = perHour;
            e.C.ArrAutomationSearchesPerDay = perDay;
            var refused = e.Budgets.Admit(BudgetCategories.Search, "r1", "new");
            Assert.Equal(("budget_exhausted", start + TimeSpan.FromMinutes(minutes)), (refused.Reason, refused.RetryAt));
            Assert.Equal(start + TimeSpan.FromMinutes(minutes), e.Budgets.Exhausted(BudgetCategories.Search, "r1")!.NextSlotAt);
            Assert.False(string.IsNullOrEmpty(full));
        }
    }

    [Theory]
    [MemberData(nameof(Windows))]
    public async Task AFullBudgetWaitsForTheLatestNextSlotInTheGate(string full, int perHour, int perDay, int minutes)
    {
        var (e, _) = Searches();
        using (e)
        {
            var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
            var want = e.R.Ledger.Find(asked.WantId!)!;
            var job = e.R.Ledger.ForWant(want.Id).Single();
            Assert.Equal("r1", AutomationSendGuard.Target(job));
            e.C.ArrAutomationSearchesPerHour = perHour;
            e.C.ArrAutomationSearchesPerDay = perDay;
            var hold = e.Guard.Hold(job, want);
            Assert.Equal(AutomationHolds.BudgetExhausted, hold?.Reason);
            // The gate's wait: until the slot, plus a second.
            Assert.Equal(TimeSpan.FromMinutes(minutes) + TimeSpan.FromSeconds(1), hold!.Wait);
            Assert.Contains(full == "hourly_only" ? "(1h)" : "(24h)", hold.Message, StringComparison.Ordinal);
        }
    }

    [Theory]
    [MemberData(nameof(Windows))]
    public async Task AFullBudgetWaitsForTheLatestNextSlotAtTheTransport(string full, int perHour, int perDay, int minutes)
    {
        var (e, _) = Searches();
        using (e)
        {
            var asked = await e.Auto(e.R.Admin, IntegrationRequestLedgerTests.Movie(961));
            var want = e.R.Ledger.Find(asked.WantId!)!;
            var job = e.R.Ledger.ForWant(want.Id).Single();
            // Admitted under the limits as they were, lowered before the transport (as in the finding).
            var admission = e.Guard.Admission(job, want)!;
            Assert.Null(admission.Admit(SendWriteKind.Search, "MoviesSearch"));
            e.C.ArrAutomationSearchesPerHour = perHour;
            e.C.ArrAutomationSearchesPerDay = perDay;
            using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
            using var client = transport.CreateClient(ArrHttp.ClientName);
            using (AutomationTransportContext.Enter(e.Guard.Gate, AutomationWrite.ForJob(job, want, true), admission))
            {
                var refused = await Assert.ThrowsAsync<AutomationTransportRefusedException>(() => client.PostAsync("http://radarr.test/api/v3/command", new StringContent("{}")));
                Assert.Equal(AutomationHolds.BudgetExhausted, refused.Hold.Reason);
                Assert.Equal(TimeSpan.FromMinutes(minutes), refused.Hold.Wait);
            }
            Assert.Equal(0, transport.Calls);
            Assert.False(string.IsNullOrEmpty(full));
        }
    }
}
