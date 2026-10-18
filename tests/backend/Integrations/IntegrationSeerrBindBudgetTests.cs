using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace JE.Tests;

// Found during 4a review round 6: a Seerr send whose bind (recording what goes out, before the POST) fails sent nothing,
// but kept the POST's budget reservation, which then counted against the day's Seerr POST budget.
[Collection("Plugin singleton")]
public class IntegrationSeerrBindBudgetTests
{
    [Fact]
    public async Task ASeerrBindThatRefusesBeforeTransportReleasesThePostReservation()
    {
        using var e = new IntegrationAutomationTests.Engine();
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var job = lab.Job(IntegrationRequestLedgerTests.Movie(22596));
        var want = new RequestWant(job.WantId, "a", job.Authorization.Requester, "c", "f", job.Input, "queued", "queued_outage", 1, "null",
            e.R.Now, e.R.Now, OriginKind: "automation", OriginSource: AutomationRecipes.AutoMovie);
        var backend = new SeerrBackend(lab.Seerr.Transport, lab.Model, null, () => lab.Config, () => lab.Now, bind: (_, _, _) => false);
        var result = await backend.SendAsync(job, () => null, e.Guard.Admission(job, want), default);
        Assert.Equal("backend_unavailable", result.Outcome.Reason);
        Assert.Empty(lab.Seerr.Posts);
        Assert.Equal(0, e.Budgets.Usage(BudgetCategories.SeerrPost, AutomationFlags.SeerrTarget).Single().Used);
        Assert.Equal(1, e.Count("SELECT count(*) FROM automation_budget WHERE state='released'"));
    }
}
