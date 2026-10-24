using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
namespace JE.Tests;

[Collection("Plugin singleton")]
public class ApiPersistedFactsGenerationTests
{
    private const string Imdb = "movie:imdb:tt0133093", Tmdb = "movie:tmdb:603";
    private static void Learn(IntegrationRequestArrivalsTests.Lab lab, bool seerr)
    {
        using var source = SeerrFacts.BeginEffect();
        var keys = new[] { Imdb, Tmdb };
        if (seerr) keys = SeerrFacts.ReadSeerrCached(() => keys, Array.Empty<string>());
        lab.Ledger.Unify(keys, lab.Policy, lab.Arr.Now);
    }
    private static long PhysicalAliases(IntegrationRequestArrivalsTests.Lab lab) => lab.Db.Read(c =>
    {
        using var q = c.CreateCommand(); q.CommandText = "SELECT COUNT(*) FROM title_aliases WHERE alias='movie:imdb:tt0133093'";
        return (long)q.ExecuteScalar()!;
    });

    [Fact]
    public async Task ExplicitImportKeepsTheAcceptedCurrentAssociationAsDurableJeHistory()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Learn(lab, seerr: true);
        var result = lab.Ledger.ImportSeerr("fixture-source", "fixture-digest",
            [new ImportCandidate(lab.Emma.UserId, 7, new MutationInput { Key = Imdb, Scope = "movie" }, true, lab.Arr.Now)],
            new Dictionary<string, int>(), lab.Admin.UserId, "seerr", _ => "[\"je\",\"r1\",\"g1\",null]", lab.Arr.Now, TimeSpan.FromDays(14));
        Assert.Equal(1, result.Imported);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.Equal(1, PhysicalAliases(lab));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AdoptionWithholdsOnlyIncidentalSeerrAliasesAndNeverDeletesThePhysicalHistory(bool durable)
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        Learn(lab, seerr: true);
        if (durable) await lab.Ask(lab.Emma, new MutationInput { Key = Imdb, Scope = "movie" });
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb)); Assert.Equal(1, PhysicalAliases(lab));
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(durable ? Tmdb : Imdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.Equal(durable, lab.Ledger.AliasesFor(TitleKey.Parse(Imdb)!).Any(k => k.ToString() == Tmdb));
        Assert.Equal(1, PhysicalAliases(lab));
    }

    [Fact]
    public async Task IndependentlyEstablishedJeAliasesSurviveAdoption()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab(); lab.Config.ArrBackendIsolationVersion = 0;
        Learn(lab, seerr: false);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb)); Assert.Equal(1, PhysicalAliases(lab));
    }

    [Fact]
    public async Task AnExistingCanonicalRequestDoesNotCertifyAnAliasLearnedLaterFromSeerr()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrBackendIsolationVersion = 0;
        lab.Ledger.Create(lab.Emma.UserId, new CreateRequest("accepted-before-learning",
            new MutationInput { Key = Tmdb, Scope = "movie" }), lab.Policy, lab.Arr.Now);
        Learn(lab, seerr: true);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Imdb, lab.Ledger.CanonicalKey(Imdb));
        Assert.NotEmpty(lab.Ledger.ForTitle(Tmdb));
        Assert.Equal(1, PhysicalAliases(lab));
    }

    [Fact]
    public async Task ExplicitAcceptancePromotesOnlyCurrentProofAndANewAskCannotReviveAStaleAssociation()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab(); lab.Config.ArrBackendIsolationVersion = 0;
        Learn(lab, seerr: true);
        await lab.Ask(lab.Emma, new MutationInput { Key = Imdb, Scope = "movie" });
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Tmdb, lab.Ledger.CanonicalKey(Imdb));
    }

    [Fact]
    public async Task AskingUnderAnOldAliasDoesNotTurnItsHiddenSeerrAssociationIntoProof()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab(); lab.Config.ArrBackendIsolationVersion = 0;
        Learn(lab, seerr: true);
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.Equal(Imdb, lab.Ledger.CanonicalKey(Imdb));
        await lab.Ask(lab.Emma, new MutationInput { Key = Imdb, Scope = "movie" });
        Assert.Equal(Imdb, lab.Ledger.CanonicalKey(Imdb)); Assert.Equal(1, PhysicalAliases(lab));
    }
}
