using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class FactsRegistryTests
{
    [Fact]
    public void AContainerOfDerivedValuesIsNotARegistryOwnedHandle()
    {
        var registry = UserCacheRegistryTests.Registry().Select(row => row.Member == "SeerrFacts.Cache._entries"
            ? row with { Rules = row.Rules.Replace("facts:fenced=storage", "facts:fenced=helper", StringComparison.Ordinal) }
            : row).ToArray();
        var problems = FactsRegistryScan.Problems(WriteGateWalk.Plugin, registry);
        Assert.Contains(problems, p => p == "SeerrFacts.Cache._entries: not a registry cache handle");
    }

    [Fact]
    public void AStateHandleDoesNotOwnAnUnrelatedPrivatePayload()
    {
        var registry = UserCacheRegistryTests.Registry().Select(row => row.Member == "ArrInstanceLibraries.State.Stamp"
            ? row with { Rules = row.Rules.Replace("parent:ArrInstanceLibraries._state", "parent:ArrStatusCache._mapFactsOwner", StringComparison.Ordinal) }
            : row).ToArray();
        var problems = FactsRegistryScan.Problems(WriteGateWalk.Plugin, registry);
        Assert.Contains(problems, p => p == "ArrInstanceLibraries.State.Stamp: parent does not own this private payload");
    }

    [Fact]
    public void ACommentedReadDoesNotFenceARawGetter()
    {
        var planted = WriteGateWalk.Plugin.With("Services/Acquire/ArrStatusCache.cs", text => text.Replace(
            "get => _mapFactsOwner.Read(ref _map, () => new(StringComparer.Ordinal));",
            "get { /* _mapFactsOwner.Read(ref _map, () => new(StringComparer.Ordinal)) */ return _map; }",
            StringComparison.Ordinal));
        var problems = FactsRegistryScan.Problems(planted, UserCacheRegistryTests.Registry());
        Assert.Contains(problems, p => p == "ArrStatusCache._map: accessor bypasses registry lookup");
    }

    [Fact]
    public void FactsGenerationHasOneEffectiveBackendTransitionOwner()
    {
        var writers = FactsRegistryScan.CompiledMethods(PrivacyOutputPathScan.Plugin).Values.SelectMany(m => m)
            .Where(m => PrivacyOutputPathScan.Referenced(m).Any(r =>
                r.DeclaringType == typeof(UserCacheRegistry) && r.Name == "AdvanceFactsGeneration"))
            .ToArray();
        Assert.Equal(typeof(EffectiveRequestsBackend), Assert.Single(writers).DeclaringType);
    }

    [Fact]
    public void EveryRegisteredAnswerHasAFenceOrACompiledProducerProof()
    {
        var problems = FactsRegistryScan.Problems(WriteGateWalk.Plugin, UserCacheRegistryTests.Registry());
        Assert.True(problems.Count == 0, string.Join(Environment.NewLine, problems));
    }

    public static IEnumerable<object[]> RegisteredFences()
        => UserCacheRegistryTests.Registry().Where(r => r.Rule("facts").Any(p => p.StartsWith("fenced=", StringComparison.Ordinal)))
            .Select(r => new object[] { r.Member, r.Rule("facts").Single() });

    // The source/IL guard above proves each descriptor's real storage reaches this seam. Exercise the common
    // store/lookup contract for EVERY descriptor, including helper internals and payloads owned by fenced parents.
    [Theory]
    [MemberData(nameof(RegisteredFences))]
    public async Task EveryRegisteredFencedCacheMissesAndEvictsAcrossAdoption(string member, string disposition)
    {
        Assert.NotEmpty(member); Assert.StartsWith("fenced=", disposition);
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0;
        var cache = new RegisteredCache<string, SeerrFacts.Derived<int>>();
        var original = cache.Begin();
        cache.Set(member, original, SeerrFacts.Remember(603));
        Assert.True(cache.TryGetValue(member, out var warm)); Assert.Equal(603, warm.Publish());
        await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
        Assert.False(cache.TryGetValue(member, out _)); Assert.Equal(0, cache.Count);
        cache.Set(member, original, SeerrFacts.Remember(604)); // the store cannot mint a fresh ticket
        Assert.False(cache.TryGetValue(member, out _)); Assert.Equal(0, cache.Count);
    }

    [Fact]
    public async Task WholeCacheEnvelopeEvictsAnOrdinaryMemoAndKeepsItsTaintAcrossOperations()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrRequestBackend = "je"; lab.Config.ArrBackendIsolationVersion = 0;
        var prior = UserCacheRegistry.TaintMode;
        UserCacheRegistry.TaintMode = true;
        try
        {
            var state = new UserCacheRegistry.State<Dictionary<string, int>>();
            var store = new Dictionary<string, int>();
            using (UserCacheRegistry.BeginOperation())
            {
                var entries = state.Read(ref store, () => new());
                entries["identity"] = SeerrFacts.ReadSeerrCached(() => 603, 0) + 1;
            }
            using (UserCacheRegistry.BeginOperation())
            {
                var value = state.Read(ref store, () => new())["identity"];
                var target = new RegisteredCache<string, int>();
                Assert.Throws<InvalidOperationException>(() => target.Set("lost-provenance", target.Begin(), value));
            }
            await EffectiveRequestsBackend.Shared.TransitionAsync(() => lab.Config.ArrBackendIsolationVersion = 1, default);
            using (UserCacheRegistry.BeginOperation()) Assert.Empty(state.Read(ref store, () => new()));
            Assert.Empty(store);
        }
        finally { UserCacheRegistry.TaintMode = prior; }
    }
}
