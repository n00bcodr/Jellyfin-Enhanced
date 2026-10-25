using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiAliasProvenanceTests
{
    private const string Imdb = "tv:imdb:tt0303461", Tvdb = "tv:tvdb:78874", Tmdb = "tv:tmdb:1437";

    private static void Join(IntegrationRequestArrivalsTests.Lab lab, bool seerr, params string[] ids)
    {
        using var effect = SeerrFacts.BeginEffect();
        if (seerr) Assert.True(SeerrFacts.ReadSeerrCached(() => true, false));
        Assert.NotNull(lab.Ledger.Unify(ids, lab.Policy, lab.Arr.Now));
    }

    // Both arrival orders are important: accepting the two-provider group before the extra
    // alias, and accepting while the extra alias already exists as a separate group.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ThreeProviderJoinPreservesAcceptedAssociationAndHistory(bool aliasBeforeAcceptance)
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        if (aliasBeforeAcceptance) Join(lab, true, Tmdb, Tvdb);
        // A separate accepted IMDb identity is joined through the incidental TVDB group later.
        if (!aliasBeforeAcceptance) Join(lab, true, Imdb, Tvdb);
        var accepted = lab.Ledger.Create(lab.Emma.UserId,
            new CreateRequest("accepted-three-providers", new MutationInput { Key = aliasBeforeAcceptance ? Imdb : Tvdb, Scope = "seasons", Seasons = [2] }),
            lab.Policy, lab.Arr.Now);
        Assert.True(accepted.HttpStatus < 300, accepted.Reason);
        Join(lab, true, aliasBeforeAcceptance ? Imdb : Tmdb, Tvdb);
        var before = Assert.Single(lab.Ledger.ForTitle(Imdb));
        Assert.Equal(accepted.RequestId, before.Id);
        // Open the same SQLite file again; provenance must survive beyond the original ledger object.
        using var reopened = new AcquireDatabase(lab.Db.FilePath);
        var ledger = new RequestLedger(reopened);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        var after = Assert.Single(ledger.ForTitle(Imdb));
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(before), System.Text.Json.JsonSerializer.Serialize(after));
        Assert.Equal(before.Id, Assert.Single(ledger.ForTitle(before.Input.Key)).Id);
    }

    [Fact]
    public async Task DroppingIncidentalAliasCannotDropAnAcceptedAssociation()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Join(lab, true, Imdb, Tvdb);
        var accepted = lab.Ledger.Create(lab.Emma.UserId, new CreateRequest("accepted", new MutationInput { Key = Tvdb, Scope = "seasons", Seasons = [2] }), lab.Policy, lab.Arr.Now);
        Assert.True(accepted.HttpStatus < 300, accepted.Reason);
        Join(lab, true, Tmdb, Tvdb);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Empty(lab.Ledger.ForTitle(Tmdb));
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Tmdb));
        Assert.Equal(Tvdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.Equal(accepted.RequestId, Assert.Single(lab.Ledger.ForTitle(Imdb)).Id);
    }

    [Fact]
    public async Task IncidentalJoinCannotDemoteIndependentJeAssociation()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Join(lab, false, Imdb, Tmdb);
        Join(lab, true, Tmdb, Tvdb);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.Equal(Tvdb, lab.Ledger.CanonicalKey(Tvdb));
    }

    [Fact]
    public async Task IndependentProofCannotPromoteOtherIncidentalMembersOfItsGroup()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Join(lab, true, Imdb, Tvdb);
        Join(lab, false, Tmdb, Tvdb);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tvdb, lab.Ledger.CanonicalKey(Tmdb));
        Assert.Equal(Imdb, lab.Ledger.CanonicalKey(Imdb));
    }

    [Fact]
    public async Task IdentityWriterRanksArrProofReachedThroughAnIncidentalSeerrAliasIndependently()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        lab.Config.JellyseerrEnabled = true;
        lab.Config.JellyseerrUrls = "http://seerr.lan";
        lab.Config.JellyseerrApiKey = "fixture";
        var remote = FakeSeerr.Request(3, "tv", 1437, 1, Guid.NewGuid(), lab.Arr.Now.UtcDateTime, tvdb: 78874, seasons: [2]);
        remote["media"]!["imdbId"] = "tt0303461";
        lab.Seerr.Requests.Add(remote);
        Assert.True(await lab.Model.RefreshAsync(default));
        var sonarr = lab.Store.Instances(Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.ArrKind.Sonarr).First(i => i.Usable);
        Assert.True((await lab.Store.RefreshLibraryNowAsync(sonarr, default)).Ok);
        var aliases = new TitleAliases(lab.Store, lab.Model);
        Assert.NotNull(RequestTitleIdentity.Learn(lab.Ledger, lab.Policy, aliases, lab.Feed, Imdb, lab.Arr.Now));
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tvdb, lab.Ledger.CanonicalKey(Tmdb));
        Assert.Equal(Imdb, lab.Ledger.CanonicalKey(Imdb));
    }

    [Fact]
    public void RefusedIncidentalJoinCannotFenceIndependentRequestTitleChoices()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Join(lab, false, Imdb, Tmdb);
        var accepted = lab.Ledger.Create(lab.Emma.UserId,
            new CreateRequest("independent-tvdb", new MutationInput { Key = Tvdb, Scope = "seasons", Seasons = [2] }), lab.Policy, lab.Arr.Now);
        Assert.True(accepted.HttpStatus < 300, accepted.Reason);
        using (var effect = SeerrFacts.BeginEffect())
        {
            Assert.True(SeerrFacts.ReadSeerrCached(() => true, false));
            Assert.Null(lab.Ledger.Unify([Tmdb, Tvdb], lab.Policy, lab.Arr.Now));
        }
        foreach (var id in new[] { Imdb, Tmdb, Tvdb }) Assert.False(lab.Ledger.Choices.IdentityFenced(id));
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.Equal(Tvdb, lab.Ledger.CanonicalKey(Tvdb));
        Assert.Equal(accepted.RequestId, Assert.Single(lab.Ledger.ForTitle(Tvdb)).Id);
    }

    [Fact]
    public async Task AllThreeAliasesLearnedBeforeAcceptanceStayAccepted()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Join(lab, true, Imdb, Tvdb);
        Join(lab, true, Tmdb, Tvdb);
        var accepted = lab.Ledger.Create(lab.Emma.UserId,
            new CreateRequest("all-before", new MutationInput { Key = Imdb, Scope = "seasons", Seasons = [2] }), lab.Policy, lab.Arr.Now);
        Assert.True(accepted.HttpStatus < 300, accepted.Reason);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        foreach (var id in new[] { Imdb, Tvdb, Tmdb })
            Assert.Equal(accepted.RequestId, Assert.Single(lab.Ledger.ForTitle(id)).Id);
    }

    [Fact]
    public void SeerrModeControlKeepsEveryAliasAndTheAcceptedHistory()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "seerr";
        lab.Config.ArrBackendIsolationVersion = 1;
        Join(lab, true, Imdb, Tvdb);
        var accepted = lab.Ledger.Create(lab.Emma.UserId, new CreateRequest("seerr-control", new MutationInput { Key = Tvdb, Scope = "seasons", Seasons = [2] }), lab.Policy, lab.Arr.Now);
        Assert.True(accepted.HttpStatus < 300, accepted.Reason);
        Join(lab, true, Tmdb, Tvdb);
        foreach (var id in new[] { Imdb, Tvdb, Tmdb })
            Assert.Equal(accepted.RequestId, Assert.Single(lab.Ledger.ForTitle(id)).Id);
    }
}
