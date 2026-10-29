using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// F83 (review round 3, EI-R3-5): what a switched episode request was switched from (<c>MutationInput.From</c>) is the
/// server's own provenance. A request body's <c>From</c> is ignored on every route that takes an input: create, approve.
/// </summary>
[Collection("Plugin singleton")]
public class ApiArrEpisodeIdentityTests
{
    private static RequestOutcome Outcome(IActionResult result) => Assert.IsType<RequestOutcome>(Assert.IsType<ObjectResult>(result).Value);

    [Fact]
    public async Task ACallerSuppliedFromIsIgnoredOnCreateAndApprove()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var body = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) }, From = new[] { new RequestEpisode(1, 1) } };
        // A Kid's ask waits for an OK: created through the route with a forged From.
        var created = Outcome(await rig.Controller(rig.Kid).Create(new CreateRequest("from-create", body), default));
        Assert.True(created.HttpStatus < 300, created.Reason);
        var want = rig.Ledger.Find(created.RequestId!)!;
        Assert.Null(want.Input.From);
        Assert.Null(want.Input.Numbering);
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, want.Input.Episodes);
        // An approval edit naming the same episodes with a forged From: the request has no provenance of its own, so none.
        var approved = Outcome(await rig.Controller(rig.Admin).Approve(want.Id, new ApproveRequest(body), default));
        Assert.True(approved.HttpStatus < 300, approved.Reason);
        Assert.Null(rig.Ledger.Find(want.Id)!.Input.From);
        Assert.All(rig.Ledger.ForWant(want.Id), j => Assert.Null(j.Input.From));
    }

    [Fact]
    public async Task AnApprovalEditKeepsAStoredFromOnlyForTheSameEpisodes()
    {
        using var rig = new IntegrationRequestLedgerTests.Rig();
        var asked = await rig.Create(rig.Kid, new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } });
        // As the server would leave a switched request: Sonarr's E2, switched from TMDB's E1.
        var switched = rig.Ledger.Find(asked.RequestId!)!.Input with { From = new[] { new RequestEpisode(1, 1) } };
        rig.Db.Write((c, t) => RequestLedger.Exec(c, t, "UPDATE wants SET mutation_input=$i WHERE id=$w", ("$i", switched.Canonical), ("$w", asked.RequestId!)));
        // An edit to other episodes, whatever From it carries, has no provenance.
        var other = new MutationInput { Key = "tv:tvdb:78874", Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 3) }, From = new[] { new RequestEpisode(1, 1) } };
        var approved = Outcome(await rig.Controller(rig.Admin).Approve(asked.RequestId!, new ApproveRequest(other), default));
        Assert.True(approved.HttpStatus < 300, approved.Reason);
        var want = rig.Ledger.Find(asked.RequestId!)!;
        Assert.Equal(new[] { new RequestEpisode(1, 3) }, want.Input.Episodes);
        Assert.Null(want.Input.From);
    }
}
