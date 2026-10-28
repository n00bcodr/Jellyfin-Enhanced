using System.Reflection;

namespace JE.Tests;

public class SeerrFreeStaticInitializerTests
{
    // None of these bodies is executed: reflection/IL inspection alone must discover the edge.
    private static class Forbidden
    {
        internal static int Read() => throw new InvalidOperationException("The proof executed an initializer");
    }

    // E1S-R7-PROOF-TYPEINIT: an ordinary helper has no callback field or forbidden Read body.
    private static class ReviewR7Initializer
    {
        static ReviewR7Initializer() { _ = Forbidden.Read(); }
        internal static int Read() => 603;
    }

    private static class FieldInitializer
    {
        internal static readonly int Value = Forbidden.Read();
        internal static int Read() => 603;
    }

    private static class PropertyInitializer
    {
        internal static int Value { get; } = Forbidden.Read();
    }

    private sealed class InstanceInitializer
    {
        static InstanceInitializer() { _ = Forbidden.Read(); }
        internal int Read() => 603;
    }

    private static class TransitiveInitializer
    {
        internal static readonly int Value = ReviewR7Initializer.Read();
    }

    private static class Independent
    {
        internal static readonly int Value = 603;
        static Independent() { _ = Cycle.Read(); }
        internal static int Read() => Value;
    }

    private static class Cycle
    {
        static Cycle() { _ = Independent.Read(); }
        internal static int Read() => 603;
    }

    private static int OrdinaryCall() => ReviewR7Initializer.Read();
    private static int StaticFieldRead() => FieldInitializer.Value;
    private static int StaticPropertyRead() => PropertyInitializer.Value;
    private static int TransitiveFieldRead() => TransitiveInitializer.Value;
    private static int InstanceCall() => new InstanceInitializer().Read();
    private static int IndependentRead() => Independent.Read();

    [Theory]
    [InlineData(nameof(OrdinaryCall))]
    [InlineData(nameof(StaticFieldRead))]
    [InlineData(nameof(StaticPropertyRead))]
    [InlineData(nameof(TransitiveFieldRead))]
    [InlineData(nameof(InstanceCall))]
    public void ProducerProofFollowsOrdinaryTypeInitialization(string name)
    {
        var root = typeof(SeerrFreeStaticInitializerTests).GetMethod(name, SeerrFreeProducerProof.Declared)!;
        var path = Assert.Single(SeerrFreeProducerProof.Violations([root], t => t == typeof(Forbidden)));
        Assert.Contains(".cctor", path);
        Assert.Contains("Forbidden.Read", path);
    }

    [Theory]
    [InlineData(typeof(ReviewR7Initializer), false)]
    [InlineData(typeof(ReviewR7Initializer), true)]
    [InlineData(typeof(FieldInitializer), false)]
    [InlineData(typeof(FieldInitializer), true)]
    public void ProducerRootIncludesItsOwnOrdinaryInitializer(Type type, bool initializerRoot)
    {
        MethodBase root = initializerRoot ? type.TypeInitializer! : type.GetMethod("Read", SeerrFreeProducerProof.Declared)!;
        Assert.Contains(SeerrFreeProducerProof.Violations([root], t => t == typeof(Forbidden)), path => path.Contains("Forbidden.Read", StringComparison.Ordinal));
    }

    [Fact]
    public void IndependentInitializersAndCyclesRemainSeerrFree()
    {
        var root = typeof(SeerrFreeStaticInitializerTests).GetMethod(nameof(IndependentRead), SeerrFreeProducerProof.Declared)!;
        Assert.Empty(SeerrFreeProducerProof.Violations([root], t => t == typeof(Forbidden)));
    }

    [Fact]
    public void InitializingATypeDoesNotMakeEveryMemberAProducerOfItsStaticConstants()
    {
        var type = PrivacyOutputPathScan.Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps.AcquisitionStampFeeder")!;
        var initializer = type.TypeInitializer!;
        Assert.Equal(initializer, Assert.Single(SeerrFreeProducerProof.Producers([initializer])));
    }
}
