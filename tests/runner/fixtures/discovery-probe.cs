using JE.Tests;
using Xunit;

public static class Program
{
    public static int Main(string[] args) => SuiteManifest.Write(args[0]);
}

[CollectionDefinition("serial probe", DisableParallelization = true)]
public class SerialDefinition { }

[Collection("serial probe")]
public class SerialCases
{
    [Fact] public void Fact() { }
    [Theory] [InlineData(1)] [InlineData(2)] public void Inline(int number) { }
}

public class DeferredValue { }
public class DefaultCases
{
#if DEFERRED_DATA
    public static System.Collections.Generic.IEnumerable<object[]> Rows()
    {
        yield return new object[] { new DeferredValue() };
        yield return new object[] { new DeferredValue() };
    }
    [Theory] [MemberData(nameof(Rows))] public void RowsExecute(DeferredValue value) { }
#else
    [Theory] [InlineData("one")] [InlineData("two")] public void RowsExecute(string value) { }
#endif
}
