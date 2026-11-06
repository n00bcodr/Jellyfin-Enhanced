using System.Diagnostics;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Moq;
using Xunit;
using Xunit.Abstractions;

namespace JellyfinEnhanced.Tests;

/// <summary>
/// Opt-in server benchmark of paged full loads (GET tag-cache?limit=2000&amp;after=): set JE_BENCH_TAG_CACHE=1 and run
/// <c>dotnet test tests/backend -p:JellyfinTarget=jf12 --filter PrivacyCachePagingBenchmark --logger "console;verbosity=detailed"</c>.
/// Without the variable it does nothing, so the regular suite stays fast. Reports, per library size, the time and
/// bytes allocated to page through the whole cache for a user who sees everything, for one who sees a third, and
/// for four readers at once, next to the per-page scan-and-sort the paging replaced (timed on the same keys).
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyCachePagingBenchmark
{
    private readonly ITestOutputHelper _output;

    public PrivacyCachePagingBenchmark(ITestOutputHelper output) => _output = output;

    [Fact]
    public void Paged_full_loads_at_50k_and_200k_entries()
    {
        if (Environment.GetEnvironmentVariable("JE_BENCH_TAG_CACHE") != "1") return;
        foreach (var size in new[] { 50_000, 200_000 }) Run(size);
    }

    private void Run(int size)
    {
        using var f = new JE.Tests.ApiPluginFixture(); f.Plugin.Configuration.TagCacheServerMode = true;
        var ids = Enumerable.Range(0, size).Select(_ => Guid.NewGuid()).ToArray();
        var third = ids.Where((_, i) => i % 3 == 0).ToArray();
        var everyone = new User("everyone", "default", "default") { Id = Guid.NewGuid() };
        var restricted = new User("restricted", "default", "default") { Id = Guid.NewGuid() };
        var library = new Mock<ILibraryManager>();
        library.Setup(x => x.GetItemIds(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.User == restricted ? third : ids);
        Directory.CreateDirectory(f.Core.ConfigRoot);
        File.WriteAllText(Path.Combine(f.Core.ConfigRoot, "tag-cache.json"), JsonSerializer.Serialize(new { SchemaVersion = TagCacheService.CurrentCacheSchemaVersion, Version = 1, LastModified = 200, LastReconciledUtcTicks = new DateTime(2026, 1, 1).Ticks, Items = ids.ToDictionary(id => id.ToString("N"), _ => new TagCacheEntry { Type = "Movie", Genres = ["Drama"], LastUpdated = 100 }) }));
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        cache.LoadFromDisk();
        // Warm the access sets (their library query is not what is measured).
        cache.GetCachePageForUser(everyone, null, 1, out _, out _, out _, out _);
        cache.GetCachePageForUser(restricted, null, 1, out _, out _, out _, out _);
        var builds = cache.SortedKeyBuilds;
        var (all, allMs, allBytes) = Measure(() => Load(cache, everyone));
        var (some, someMs, someBytes) = Measure(() => Load(cache, restricted));
        var (_, fourMs, _) = Measure(() => { Parallel.For(0, 4, _ => Load(cache, everyone)); return 0; });
        _output.WriteLine($"{size:N0} entries, pages of 2,000: everything {all} pages {allMs} ms {allBytes / 1048576.0:F1} MiB; a third {some} pages {someMs} ms {someBytes / 1048576.0:F1} MiB; four readers {fourMs} ms; sorted indexes built {cache.SortedKeyBuilds - builds}");
        // The replaced approach, on the same keys: every page scans the keys and sorts the rest.
        var keys = ids.Select(id => id.ToString("N")).ToArray();
        var (oldPages, oldMs, oldBytes) = Measure(() => OldLoad(keys));
        _output.WriteLine($"{size:N0} entries, the per-page scan and sort it replaced: {oldPages} pages {oldMs} ms {oldBytes / 1048576.0:F1} MiB (keys only, no projection)");
    }

    private static int Load(TagCacheService cache, User user)
    {
        string? after = null; var pages = 0;
        do { cache.GetCachePageForUser(user, after, 2000, out _, out _, out _, out after); pages++; } while (after != null);
        return pages;
    }

    private static int OldLoad(string[] keys)
    {
        string? after = null; var pages = 0;
        do
        {
            var candidates = new List<string>();
            foreach (var key in keys) if (after == null || string.CompareOrdinal(key, after) > 0) candidates.Add(key);
            candidates.Sort(StringComparer.Ordinal);
            after = candidates.Count > 2000 ? candidates[1999] : null;
            pages++;
        }
        while (after != null);
        return pages;
    }

    private static (int Result, long Ms, long Bytes) Measure(Func<int> run)
    {
        GC.Collect(); GC.WaitForPendingFinalizers();
        var bytes = GC.GetTotalAllocatedBytes(true);
        var watch = Stopwatch.StartNew();
        var result = run();
        return (result, watch.ElapsedMilliseconds, GC.GetTotalAllocatedBytes(true) - bytes);
    }
}
