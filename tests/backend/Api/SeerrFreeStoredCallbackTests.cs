namespace JE.Tests;

public class SeerrFreeStoredCallbackTests
{
    private static class Forbidden { internal static int Read() => 603; }
    private static class Indirect
    {
        private static readonly Func<int> Callback = () => Forbidden.Read();
        internal static int Read() => Callback();
    }
    private static class Safe
    {
        private static readonly Func<int> Callback = () => 603;
        internal static int Read() => Callback();
    }
    private sealed class Reassigned
    {
        private Func<int> _callback = () => 603;
        internal void Replace() => _callback = Forbidden.Read;
        internal int Read() => _callback();
    }

    private static class InitializerSideEffect
    {
        private static readonly Func<int> Callback;
        static InitializerSideEffect()
        {
            _ = Forbidden.Read();
            Callback = () => 603;
        }
        internal static int Read() => Callback();
    }

    [Fact]
    public void ProducerProofFollowsStaticInitializerSideEffectsEvenForAnIndependentCallback()
    {
        var root = typeof(InitializerSideEffect).GetMethod("Read", SeerrFreeProducerProof.Declared)!;
        Assert.NotEmpty(SeerrFreeProducerProof.Violations([root], t => t == typeof(Forbidden)));
    }

    private static int MethodGroupEntry()
    {
        Func<int> callback = Indirect.Read;
        return callback();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ProducerProofFollowsStoredCallbackInitializersAndAssignments(bool reassigned)
    {
        var root = reassigned
            ? typeof(Reassigned).GetMethod("Read", SeerrFreeProducerProof.Declared)!
            : typeof(SeerrFreeStoredCallbackTests).GetMethod(nameof(MethodGroupEntry), SeerrFreeProducerProof.Declared)!;
        Assert.NotEmpty(SeerrFreeProducerProof.Violations([root], t => t == typeof(Forbidden)));
        var safe = typeof(Safe).GetMethod("Read", SeerrFreeProducerProof.Declared)!;
        Assert.Empty(SeerrFreeProducerProof.Violations([safe], t => t == typeof(Forbidden)));
    }
}
