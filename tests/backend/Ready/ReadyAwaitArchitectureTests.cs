namespace JE.Tests;

public class ReadyAwaitArchitectureTests
{
    [Theory]
    [InlineData("NotifyDispatcher.cs", "RunOnceAsync", "private async Task<int> RunOnceAsyncFactsCore(CancellationToken cancellationToken)\n        {")]
    public void ScopedBodiesKeepEveryNewAwaitVisibleToTheAlertModel(string file, string owner, string declaration)
    {
        var planted = NotifyGateWalk.Plugin.With(file, source => source.Replace(declaration,
            declaration + "\n            await Task.Yield();", StringComparison.Ordinal));
        Assert.Contains(owner + ":Yield", planted.AwaitSites());

        // A raw caller invalidates the scoped-owner proof. It must not silently acquire the
        // trusted wrapper's model identity; the existing complete-site assertion then rejects it.
        var bypass = planted.With(file, source => source.Replace(declaration,
            "private Task<int> PlantedUnscoped(CancellationToken ct) => RunOnceAsyncFactsCore(ct);\n        " + declaration,
            StringComparison.Ordinal));
        Assert.DoesNotContain(owner + ":Yield", bypass.AwaitSites());
    }

    // The notification round's entry is the admitted background scope around its ordered core (EvidenceOrder): the
    // model follows the ordering delegate's exact forwarded core, so an await added there is visible under that core's
    // own name, as every other ordered core is (ReadyAwaitPointModelTests).
    [Fact]
    public void AnAwaitAddedToTheOrderedRoundIsVisibleToTheAlertModel()
    {
        const string declaration = "private async Task TickCoreAsync(CancellationToken cancellationToken, bool force)\n        {";
        var planted = NotifyGateWalk.Plugin.With("NotificationService.cs", source => source.Replace(declaration,
            declaration + "\n            await Task.Yield();", StringComparison.Ordinal));
        Assert.Contains("TickCoreAsync:Yield", planted.AwaitSites());
        Assert.DoesNotContain("TickCoreAsync:Yield", NotifyGateWalk.Plugin.AwaitSites());
    }
}
