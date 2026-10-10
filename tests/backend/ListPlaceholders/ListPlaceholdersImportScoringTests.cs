using System.Diagnostics;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using static Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import.ImportScoring;

namespace JE.Tests;

// The pure scoring rules (research/seerr-api.md §9, design E2) and the shared Seerr call limiter (E4).
public class ListPlaceholdersImportScoringTests
{
    [Theory]
    [InlineData("The Suicide Squad", "suicide squad")]
    [InlineData("Batman & Robin", "batman and robin")]
    [InlineData("Shazam!", "shazam")]
    [InlineData("Zack Snyder's Justice League", "zack snyders justice league")]
    [InlineData("Amélie", "amelie")]
    [InlineData("Batman: The Long Halloween, Part One", "batman the long halloween part 1")]
    [InlineData("  Wonder   Woman 1984 ", "wonder woman 1984")]
    public void NormalizeFoldsCaseAccentsPunctuationArticlesAndNumberWords(string input, string expected)
    {
        Assert.Equal(expected, Normalize(input));
    }

    [Fact]
    public void TitleScoreRanksExactArticleAwareExactPrefixAndSubstring()
    {
        Assert.Equal((105, true), TitleScore("Suicide Squad", null, "Suicide Squad"));
        Assert.Equal((100, true), TitleScore("The Suicide Squad", null, "Suicide Squad"));
        Assert.Equal((60, false), TitleScore("Birds of Prey (and the Fantabulous Emancipation of One Harley Quinn)", null, "Birds of Prey"));
        Assert.Equal((30, false), TitleScore("DC Spotlight: Shazam!", null, "Shazam!"));
        Assert.Equal((20, false), TitleScore("Justice League", null, "either Justice League version"));
        Assert.Equal((0, false), TitleScore("Aquaman", null, "Black Adam"));
        // The original title counts too (foreign titles).
        Assert.Equal((105, true), TitleScore("Parasite", "기생충", "기생충"));
    }

    [Theory]
    [InlineData(2016, 2016, 50)]
    [InlineData(2017, 2016, 25)]
    [InlineData(2021, 2016, -40)]
    [InlineData(null, 2016, -30)]
    [InlineData(2016, null, 0)]
    [InlineData(null, null, 0)]
    public void YearScoreAllowsOneYearOfDriftAndPenalisesUndatedStubs(int? candidate, int? wanted, double expected)
    {
        Assert.Equal(expected, YearScore(candidate, wanted));
    }

    [Fact]
    public void TiebreakIsCapped()
    {
        Assert.Equal(15, Tiebreak(1_000_000, 10_000));
        Assert.Equal(0, Tiebreak(0, 0));
        Assert.Equal(1.5, Tiebreak(500, 10));
    }

    [Fact]
    public void ConfidenceNeedsScoreMarginAndAYearForHigh()
    {
        Assert.Equal(Levels.None, Confidence(null, null, false, true));
        Assert.Equal(Levels.High, Confidence(165, 60, false, true));
        Assert.Equal(Levels.Medium, Confidence(165, 60, false, false)); // no year: never high
        Assert.Equal(Levels.Medium, Confidence(165, 130, false, true)); // margin 35 < 40
        Assert.Equal(Levels.Low, Confidence(165, 155, false, true)); // margin 10 < 20
        Assert.Equal(Levels.Low, Confidence(90, null, false, true)); // weak
        Assert.Equal(Levels.Low, Confidence(165, 60, true, true)); // two exact matches
        Assert.Equal(Levels.High, Confidence(150, null, false, true)); // single candidate: margin = score
    }

    [Fact]
    public void CapAndDominanceHelpers()
    {
        Assert.Equal(Levels.Low, Cap(Levels.High, Levels.Low));
        Assert.Equal(Levels.None, Cap(Levels.None, Levels.Low));
        Assert.Equal(Levels.Medium, Cap(Levels.Medium, Levels.High));
        Assert.True(Dominates(16_680, 12));
        Assert.True(Dominates(800, null));
        Assert.False(Dominates(400, 1)); // too obscure itself
        Assert.False(Dominates(5000, 300)); // runner-up is well known too
    }

    [Fact]
    public async Task TheLimiterHoldsConcurrencyAndSpacesStarts()
    {
        var limiter = new SeerrCallLimiter(4, TimeSpan.FromMilliseconds(20), TimeProvider.System);
        var running = 0;
        var peak = 0;
        var starts = new List<long>();
        var clock = Stopwatch.StartNew();
        await Task.WhenAll(Enumerable.Range(0, 20).Select(async i =>
        {
            using (await limiter.AcquireAsync("user-" + (i % 3), false, CancellationToken.None))
            {
                lock (starts)
                {
                    starts.Add(clock.ElapsedMilliseconds);
                    peak = Math.Max(peak, ++running);
                }

                await Task.Delay(30);
                lock (starts)
                {
                    running--;
                }
            }
        }));

        Assert.True(peak <= 4, $"peak {peak}");
        Assert.Equal(20, starts.Count);
        // 20 starts spaced >= 20 ms apart take at least ~19 × 20 ms (small timer slack allowed).
        Assert.True(starts.Max() - starts.Min() >= 19 * 20 - 40, $"spread {starts.Max() - starts.Min()} ms");
        var (total, statsPeak, _) = limiter.Stats();
        Assert.Equal(20, total);
        Assert.True(statsPeak <= 4);
    }

    [Fact]
    public async Task InteractiveCallersGoFirstAndOwnersTakeTurns()
    {
        var limiter = new SeerrCallLimiter(1, TimeSpan.Zero, TimeProvider.System);
        var gate = await limiter.AcquireAsync("holder", false, CancellationToken.None);
        var order = new List<string>();

        // AcquireAsync queues the waiter synchronously, so the queue order is exactly the call order (no reliance on
        // thread-pool timing); each lease is recorded and released on the pool.
        async Task Run(string owner, bool background, string label)
        {
            var acquire = limiter.AcquireAsync(owner, background, CancellationToken.None);
            using (await acquire.ConfigureAwait(false))
            {
                lock (order)
                {
                    order.Add(label);
                }
            }
        }

        var tasks = new List<Task>
        {
            Run("sync", true, "sync-1"),
            Run("a", false, "a-1"),
            Run("a", false, "a-2"),
            Run("b", false, "b-1"),
        };
        Assert.All(tasks, task => Assert.False(task.IsCompleted));
        gate.Dispose();
        await Task.WhenAll(tasks);

        // Background waits for every interactive caller; "a" and "b" alternate even though "a" queued twice first.
        Assert.Equal(new[] { "a-1", "b-1", "a-2", "sync-1" }, order);
    }

    [Fact]
    public async Task CancellingAQueuedCallFreesNothingAndLeavesNoGhost()
    {
        var limiter = new SeerrCallLimiter(1, TimeSpan.Zero, TimeProvider.System);
        var held = await limiter.AcquireAsync("a", false, CancellationToken.None);
        using var cts = new CancellationTokenSource();
        var cancelled = limiter.AcquireAsync("b", false, cts.Token);
        var next = limiter.AcquireAsync("c", false, CancellationToken.None);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.False(next.IsCompleted);
        held.Dispose();
        using var lease = await next.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, limiter.Stats().Total);
    }
}
