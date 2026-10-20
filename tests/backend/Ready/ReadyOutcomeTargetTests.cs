using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace JE.Tests;

/// <summary>
/// An outcome alert (declined, OK'd) of a stored Jellyfin Enhanced request is judged where the request actually goes, its
/// persisted target, as every other check of a stored request is (<see cref="IRequestPolicy.Evaluate(Guid, MutationInput, string)"/>):
/// never where a new request would go now. Through the real NotificationService, RequestLedger, RequestService and NotifyDispatcher
/// over a real acquire.db, at every send and in the bell.
/// </summary>
[Collection("Plugin singleton")]
public class ReadyOutcomeTargetTests
{
    private const string Dune = "movie:tmdb:693134";

    // After the ask, new requests of the kid's go to another instance ("moved"); the stored request keeps its own ("inst").
    // The kid may see an absent title only at the instance named visible (the libraries it lands in).
    private static void MoveDefault(ReadyProvenanceAndWaitsTests.World w, string visibleAt)
    {
        var kid = w.Rig.Kid.UserId;
        w.Policy.People[kid] = w.Policy.People[kid] with { InstanceId = "moved" };
        w.Policy.Adjust = (user, input, facts) => user == kid && input.Key == Dune && (input.InstanceId ?? facts.InstanceId) != visibleAt
            ? facts with { Visible = false }
            : facts;
    }

    [Theory]
    [InlineData(NotifyKind.Declined)]
    [InlineData(NotifyKind.Approved)]
    public async Task AnOutcomeVisibleWhereTheRequestGoesIsToldThoughANewRequestWouldLandWhereItIsHidden(string outcome)
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        Assert.Contains("\"inst\"", w.Ledger!.Find(id)!.TargetKey, StringComparison.Ordinal);
        await w.Decide(id, outcome);
        MoveDefault(w, visibleAt: "inst");
        await w.Step(true);
        Assert.Equal(1, w.Rows(kid, outcome));
        Assert.True(w.Told(outcome == NotifyKind.Declined ? "said no to Dune" : "OK'd Dune"));
        Assert.Equal(Dune, Assert.Single(w.Bell(kid.UserId).EnumerateArray(), r => r.GetProperty("kind").GetString() == outcome).GetProperty("key").GetString());
    }

    [Theory]
    [InlineData(NotifyKind.Declined)]
    [InlineData(NotifyKind.Approved)]
    public async Task AnOutcomeHiddenWhereTheRequestGoesIsToldOnNoChannelThoughANewRequestWouldLandWhereItIsVisible(string outcome)
    {
        using var w = await ReadyProvenanceAndWaitsTests.JeWorld();
        var kid = w.Rig.Kid;
        var id = await w.Ask(kid, Dune, "kid-dune");
        await w.Decide(id, outcome);
        MoveDefault(w, visibleAt: "moved");
        await w.Step(true);
        await w.Step(true);
        Assert.Equal(0, w.Rows(kid, outcome));
        Assert.False(w.Told("Dune"));
    }
}
