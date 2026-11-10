using System.IO.Compression;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;
using JE.Tests.Architecture;

namespace JE.Tests;

// canopy K1 bundle-size gate (also `scripts/restructure-gates.sh size`): the served GET /JellyfinEnhanced/bundle.js
// identity body must stay within client/bundle-budget.json, raw and gzip-9. The budget is a ratchet: a history entry
// may lower the limits freely, but one that raises either limit must say why.
public class BundleBudgetTests
{
    private static JsonElement Budget()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(Arch.RepoRoot, "client", "bundle-budget.json")));
        return json.RootElement.Clone();
    }

    private static (long Raw, long Gzip) Limits(JsonElement limits)
        => (limits.GetProperty("rawBytes").GetInt64(), limits.GetProperty("gzipBytes").GetInt64());

    internal static long Gzip9(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true)) gzip.Write(bytes);
        return output.Length;
    }

    [Fact]
    public void ServedBundleIsWithinTheCheckedInBudget()
    {
        using var fixture = new CoreFixture();
        var script = ClientScriptBundle.BuildUncached("budget-check", fixture.Logger).Script;
        var (raw, gzip) = Limits(Budget().GetProperty("limits"));
        var gzipped = Gzip9(script);
        Assert.True(script.Length <= raw,
            $"bundle.js is {script.Length:N0} bytes raw, over the {raw:N0} budget in client/bundle-budget.json. Make it smaller, or raise the budget in a new history entry with a reason.");
        Assert.True(gzipped <= gzip,
            $"bundle.js is {gzipped:N0} bytes gzip-9, over the {gzip:N0} budget in client/bundle-budget.json. Make it smaller, or raise the budget in a new history entry with a reason.");
    }

    [Fact]
    public void BudgetOnlyRisesWithADocumentedReason()
    {
        var budget = Budget();
        var history = budget.GetProperty("history").EnumerateArray().ToArray();
        Assert.NotEmpty(history);
        Assert.Equal(Limits(history[^1].GetProperty("limits")), Limits(budget.GetProperty("limits")));
        for (var i = 0; i < history.Length; i++)
        {
            var entry = history[i];
            Assert.Matches(@"^\d{4}-\d{2}-\d{2}$", entry.GetProperty("date").GetString());
            var (raw, gzip) = Limits(entry.GetProperty("limits"));
            Assert.True(raw > 0 && gzip > 0 && gzip < raw, $"history[{i}]: implausible limits");
            var rises = i == 0 || raw > Limits(history[i - 1].GetProperty("limits")).Raw || gzip > Limits(history[i - 1].GetProperty("limits")).Gzip;
            var reason = entry.TryGetProperty("reason", out var r) ? r.GetString() ?? "" : "";
            Assert.True(!rises || reason.Trim().Length >= 20,
                $"history[{i}] ({entry.GetProperty("date").GetString()}) sets or raises the budget, so it needs a \"reason\" (at least 20 characters).");
        }
    }
}
