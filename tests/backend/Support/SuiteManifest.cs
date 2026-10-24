using System.Text.Json;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace JE.Tests;

/// <summary>Discover real xUnit cases and collection identities without running test bodies.</summary>
internal sealed class SuiteManifest : LongLivedMarshalByRefObject, IMessageSink, ISourceInformationProvider, ITestFrameworkDiscoveryOptions
{
    private readonly ManualResetEventSlim _done = new();
    private readonly List<object> _cases = new();
    private readonly List<string> _errors = new();

    public bool OnMessage(IMessageSinkMessage message)
    {
        lock (_cases)
        {
            if (message is ITestCaseDiscoveryMessage found)
            {
                var test = found.TestCase;
                if (test is XunitTheoryTestCase theory && theory.SkipReason is null)
                    _errors.Add("Deferred theory cannot provide a complete case inventory: " + test.DisplayName);
                _cases.Add(new
                {
                    id = test.UniqueID,
                    name = test.DisplayName,
                    method = test.TestMethod.TestClass.Class.Name + "." + test.TestMethod.Method.Name,
                    collection = test.TestMethod.TestClass.TestCollection.DisplayName,
                    serial = test.TestMethod.TestClass.TestCollection.CollectionDefinition?
                        .GetCustomAttributes(typeof(CollectionDefinitionAttribute).AssemblyQualifiedName!).Any(a => a.GetNamedArgument<bool>("DisableParallelization")) == true,
                });
            }
            if (message is IErrorMessage error) _errors.AddRange(error.Messages);
            if (message is IDiscoveryCompleteMessage) _done.Set();
        }
        return true;
    }

    public ISourceInformation GetSourceInformation(ITestCase testCase) => new SourceInformation();
    public void Dispose() => _done.Dispose();
    public T GetValue<T>(string name) => name == "xunit.discovery.PreEnumerateTheories" ? (T)(object)true : default!;
    public void SetValue<T>(string name, T value) => throw new NotSupportedException();

    internal static int Write(string output)
    {
        using var sink = new SuiteManifest();
        using var discoverer = new XunitTestFrameworkDiscoverer(
            new ReflectionAssemblyInfo(typeof(SuiteManifest).Assembly), sink, sink);
        discoverer.Find(false, sink, sink);
        if (!sink._done.Wait(TimeSpan.FromMinutes(5))) throw new TimeoutException("xUnit discovery did not complete");
        if (sink._errors.Count != 0)
        {
            Console.Error.WriteLine(string.Join("; ", sink._errors));
            return 1;
        }
        File.WriteAllText(output, JsonSerializer.Serialize(sink._cases, new JsonSerializerOptions { WriteIndented = true }));
        return sink._cases.Count == 0 ? 1 : 0;
    }
}
