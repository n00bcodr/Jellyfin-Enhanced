using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationEvidenceGenerationTests
{
    [Theory]
    [InlineData(0)] [InlineData(1)] [InlineData(17)] [InlineData(531)]
    public void AnyPositiveNumberOfAdvancesWithholdsEvenWhenInputsReturn(int seed)
    {
        var random = new Random(seed);
        for (var sample = 0; sample < 64; sample++)
        {
            var input = "US";
            var publication = new EvidencePublication(() => input);
            var count = sample == 0 ? 0 : random.Next(1, 32);
            for (var change = 0; change < count; change++)
                EvidenceRevision.Advance(() => input = random.Next(2) == 0 ? "AU" : "US");
            // Restoration is itself an input writer. Equal inputs can never restore the generation.
            if (count != 0) EvidenceRevision.Advance(() => input = "US");
            Assert.Equal("US", input);
            Assert.Equal(count == 0, publication.Current);
            Assert.Equal(count == 0, publication.Publish(() => new object()) != null);
        }
    }

    [Fact]
    public void EqualAndNestedAdvancesEachHaveADistinctGeneration()
    {
        var before = EvidenceRevision.EvidenceGeneration;
        EvidenceRevision.Advance(() => EvidenceRevision.Advance(() => { }));
        Assert.Equal(before + 2, EvidenceRevision.EvidenceGeneration);
    }
}
