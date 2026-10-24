namespace JE.Tests;

public class FactsRegistryConditionalStoreTests
{
    [Theory]
    [InlineData(false)][InlineData(true)]
    public void SourceProducerScanFindsConditionalAndOrdinaryStores(bool conditional)
    {
        var access = conditional ? "?." : ".";
        var planted = WriteGateWalk.Plugin.With("Services/TmdbResponseCache.cs", text => text.Replace(
            "public sealed class TmdbResponseCache : IDisposable\n    {",
            "public sealed class TmdbResponseCache : IDisposable\n    {\n        internal void ReviewR6ConditionalWriter() { _inFlight" + access + "Add(\"r6\", System.Threading.Tasks.Task.FromResult(new TmdbResponse(200, global::Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.ReadSeerrCached(() => \"Seerr\", \"\"), \"\"))); }",
            StringComparison.Ordinal));
        var caches = UserCacheScan.Caches(planted);
        var roots = FactsRegistryScan.Producers(planted, caches);
        Assert.Contains("TmdbResponseCache.ReviewR6ConditionalWriter#0", roots["TmdbResponseCache._inFlight"]);
    }

}
