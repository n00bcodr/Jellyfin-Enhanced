namespace JE.Tests;

public class ReadyAwaitArchitectureTests
{
    [Theory]
    [InlineData("NotifyDispatcher.cs", "RunOnceAsync", "private async Task<int> RunOnceAsyncFactsCore(CancellationToken cancellationToken)\n        {")]
    [InlineData("NotificationService.cs", "TickAsync", "private async Task TickAsyncFactsCore(CancellationToken cancellationToken, bool force = false)\n        {")]
    public void ScopedBodiesKeepEveryNewAwaitVisibleToTheAlertModel(string file, string owner, string declaration)
    {
        var planted = NotifyGateWalk.Plugin.With(file, source => source.Replace(declaration,
            declaration + "\n            await Task.Yield();", StringComparison.Ordinal));
        Assert.Contains(owner + ":Yield", planted.AwaitSites());

        // A raw caller invalidates the scoped-owner proof. It must not silently acquire the
        // trusted wrapper's model identity; the existing complete-site assertion then rejects it.
        var bypass = planted.With(file, source => source.Replace(declaration,
            (owner == "RunOnceAsync"
                ? "private Task<int> PlantedUnscoped(CancellationToken ct) => RunOnceAsyncFactsCore(ct);\n        "
                : "private Task PlantedUnscoped(CancellationToken ct) => TickAsyncFactsCore(ct);\n        ") + declaration,
            StringComparison.Ordinal));
        Assert.DoesNotContain(owner + ":Yield", bypass.AwaitSites());
    }
}
