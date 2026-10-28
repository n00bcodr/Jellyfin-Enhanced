using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Xunit.Abstractions;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1CompletionPropertyTests(ITestOutputHelper output)
{
    [Fact]
    public void SeededEvidenceAndFillSubsetsCannotEraseKnownAiredObligations()
    {
        using var h = new ListsHarness();
        var random = new Random(531002);
        var today = new DateTime(2026, 10, 24);
        var failures = new List<int>();
        var completeCount = 0;
        const int cases = 3000;
        for (var i = 0; i < cases; i++)
        {
            var series = random.Next(2) == 0;
            var explicitScope = i >= 2400;
            var ongoing = random.Next(5) == 0;
            var s = series ? 1 : random.Next(3) == 0 ? 0 : 1;
            var count = random.Next(2, 7);
            var last = random.Next(1, count + 2);
            var mode = random.Next(12);
            string? lastDate = mode == 0 ? null : mode == 1 ? "2099-01-01" : "2011-04-24";
            string? premiere = mode == 2 ? null : mode == 3 ? "2099-01-01" : "2011-04-17";
            var later = mode is 4 or 5;
            var next = mode is 0 or 6 or 7;
            var nextS = mode == 0 ? 2 : s;
            var nextE = mode == 7 ? last : Math.Min(last + 1, count);
            string? nextDate = mode == 6 ? null : mode == 0 ? "2012-04-01" : "2099-01-01";
            var rows = Enumerable.Range(1, count).Select(e => new PlaceholderEpisode
            {
                S = s, E = e, AirDate = e <= last ? "2011-04-24" : "2099-01-01",
            }).ToList();
            if (mode == 8) rows.RemoveAt(rows.Count - 1);
            if (mode == 9) rows.Add(new PlaceholderEpisode { S = s, E = count + 1, AirDate = "2011-04-24" });
            if (mode == 10) rows[0].E = count + 2;
            if (mode == 11) rows[random.Next(rows.Count)].AirDate = null;
            var seasons = new List<object> { new { seasonNumber = s, episodeCount = count, airDate = premiere } };
            if (later || nextS == 2 && next) seasons.Add(new { seasonNumber = 2, episodeCount = 2, airDate = (string?)"2012-04-01" });
            var show = JsonSerializer.SerializeToElement(new
            {
                id = 1399, name = "Show", status = ongoing ? "Returning Series" : "Ended", inProduction = ongoing,
                posterPath = (string?)null, overview = "Show.", externalIds = new { imdbId = "tt0944947", tvdbId = 121361 },
                firstAirDate = "2011-04-17", seasons = mode == 2 ? null : seasons,
                numberOfSeasons = seasons.Count - (s == 0 ? 1 : 0) + (i % 29 == 0 ? 1 : 0),
                lastEpisodeToAir = new { seasonNumber = s, episodeNumber = last, airDate = lastDate },
                nextEpisodeToAir = next ? new { seasonNumber = nextS, episodeNumber = nextE, airDate = nextDate } : null,
            });
            var detail = JsonSerializer.SerializeToElement(new
            {
                id = 100, seasonNumber = s, airDate = premiere, posterPath = (string?)null,
                episodes = rows.Select(e => new { showId = 1399, seasonNumber = e.S, episodeNumber = e.E, airDate = e.AirDate }).ToArray(),
            });
            var p = new Placeholder { MediaType = "tv", Kind = series ? "series" : "season", TmdbId = 1399, SeasonNumber = series ? null : s };
            if (explicitScope)
            {
                var selected = Enumerable.Range(1, random.Next(1, count + 1)).Select(e => new PlaceholderEpisode { S = s, E = e }).ToList();
                Assert.True(ListRules.TryNormalize(new NewPlaceholderDto { Kind = "episodes", TmdbId = 1399, Title = "Show", SeasonNumber = s, Episodes = selected },
                    false, out p, out _));
            }
            var facts = ListMetadataService.FromTv(p, show, detail, today, today);
            ListMetadataService.Apply(p, facts);
            // Independent oracle: explicit named last is aired even without a date, prefixes below it exist,
            // a past premiere proves E1, and detailed past rows remain obligations even if another source is shorter.
            var obligations = new HashSet<EpisodeCoord>();
            for (var e = 1; e <= last; e++) obligations.Add(new EpisodeCoord(s, e));
            if (later || next && nextS == 2) obligations.Add(new EpisodeCoord(2, 1));
            foreach (var row in rows.Where(e => e.AirDate == "2011-04-24")) obligations.Add(new EpisodeCoord(s, row.E));
            if (!series || explicitScope) obligations.RemoveWhere(c => c.S != s); // season scopes never require another season
            if (explicitScope) obligations = p.Episodes.Select(e => new EpisodeCoord(e.S, e.E)).ToHashSet();
            var fillAll = random.Next(3) == 0;
            foreach (var c in obligations.Concat(Enumerable.Range(1, count).Select(e => new EpisodeCoord(s, e))).Distinct())
                if (fillAll || random.Next(2) == 0) p.Filled.Add(new FilledEpisode { S = c.S, E = c.E, ItemId = Guid.NewGuid().ToString("N") });
            var contradiction = i % 29 == 0 || last > count || lastDate == "2099-01-01" || premiere == "2099-01-01"
                || next && nextS == s && nextE <= last
                || (rows.Count != count || rows.Where((e, n) => e.E != n + 1).Any()
                    || rows.Any(e => e.E == last && e.AirDate != lastDate && lastDate != null));
            var filled = PlaceholderProgress.FilledCoords(p);
            if (PlaceholderProgress.IsComplete(p, today))
            {
                completeCount++;
                if (contradiction || (!explicitScope && series && ongoing) || obligations.Any(c => !filled.Contains(c)))
                {
                    failures.Add(i);
                    if (failures.Count <= 12) output.WriteLine($"case={i} series={series} explicit={explicitScope} ongoing={ongoing} season={s} mode={mode} count={count} last={last} next={next} nextS={nextS} nextE={nextE} countMismatch={i % 29 == 0} contradiction={contradiction} missing={string.Join(',', obligations.Where(c => !filled.Contains(c)))}");
                }
            }
        }
        output.WriteLine($"seed=531002 cases={cases} complete={completeCount} soundnessViolations={failures.Count}; first={string.Join(',', failures.Take(20))}");
        Assert.True(failures.Count == 0, $"{failures.Count}/{cases} generated cases falsely Complete; first={string.Join(',', failures.Take(20))}");
        Assert.True(completeCount > 0, "Generator must exercise coherent Complete controls too.");
    }
}
