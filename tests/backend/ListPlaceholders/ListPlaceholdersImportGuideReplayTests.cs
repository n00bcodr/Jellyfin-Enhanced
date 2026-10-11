using System.Collections.Concurrent;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;

namespace JE.Tests;

// The import resolver against a recorded Seerr: every line of the user's DC watch guide (51 tracks, 225 lines, parsed by
// the current parser) with the Seerr answers recorded for its lookups (Fixtures/dc-guide-import.json). Each line has its
// expected confidence and match: the 184 lines that were high before the QA round stay high with the same match, and the
// QA-round lines (recall, ties, dateless titles, TBA) resolve as fixed.
[Collection("Plugin singleton")]
public class ListPlaceholdersImportGuideReplayTests
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    [Fact]
    public async Task EveryGuideLineResolvesAsExpected()
    {
        var fixture = GuideFixture.Load();
        using var h = new ListPlaceholdersHarness();
        var user = h.NewUser("u");
        var lookup = new ReplayImportLookup(fixture);
        var resolver = new ListImportResolver(lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger);

        for (var i = 0; i < fixture.Entries.Count; i++)
        {
            fixture.Entries[i].Entry.Index = i; // the parser numbers per track; the replay sends all tracks in chunks
        }

        var results = new List<ResolvedEntryDto>();
        foreach (var chunk in fixture.Entries.Chunk(ListImportResolver.MaxEntriesPerCall))
        {
            var outcome = await resolver.ResolveAsync(chunk.Select(c => c.Entry).ToList(), new ImportResolveOptions
            {
                Caller = user,
                LibraryUsers = new[] { user },
                Context = new ImportCallContext("replay", false),
                EmptyRetryDelay = TimeSpan.Zero,
                Deadline = TimeSpan.FromMinutes(2),
            }, CancellationToken.None);
            results.AddRange(outcome.Response.Results.OrderBy(r => r.Index));
        }

        lookup.WriteMisses();
        Assert.Empty(lookup.Misses);
        Assert.Equal(fixture.Entries.Count, results.Count);

        var report = new List<string>();
        var failures = new List<string>();
        for (var i = 0; i < results.Count; i++)
        {
            var line = fixture.Entries[i];
            var result = results[i];
            var match = result.Match == null ? null : result.Match.MediaType + "#" + result.Match.TmdbId;
            report.Add($"{line.Track}\t{line.Line}\t{result.Confidence}\t{match}\t{string.Join('+', result.Reasons)}\t"
                + string.Join(" ; ", result.Candidates.Select(c => $"{c.Title} ({c.Year}) {c.MediaType}#{c.TmdbId} s={c.Score}")));
            if (line.Expect != null && (line.Expect.Confidence != result.Confidence || line.Expect.Match != match))
            {
                failures.Add($"{line.Track} line {line.Line}: expected {line.Expect.Confidence} {line.Expect.Match}, got {result.Confidence} {match} [{string.Join('+', result.Reasons)}]");
            }
        }

        var reportPath = Environment.GetEnvironmentVariable("JE_GUIDE_REPLAY_REPORT");
        if (!string.IsNullOrEmpty(reportPath))
        {
            File.WriteAllLines(reportPath, report);
        }

        Assert.True(failures.Count == 0, string.Join('\n', failures));
    }

    internal sealed class GuideFixture
    {
        public List<GuideLine> Entries { get; set; } = new();

        // Normalized query → hits: [mediaType, tmdbId, title, originalTitle, date, popularity, votes].
        public Dictionary<string, List<JsonElement[]>> Searches { get; set; } = new(StringComparer.Ordinal);

        // "tv|id" / "movie|id" → [hit, imdbId, tvdbId, status, inProduction, seasons: [[number, episodeCount, airDate, name]]].
        public Dictionary<string, JsonElement[]> Details { get; set; } = new(StringComparer.Ordinal);

        // "id|season" → [[season, episode, title, airDate]].
        public Dictionary<string, List<JsonElement[]>> Seasons { get; set; } = new(StringComparer.Ordinal);

        public static GuideFixture Load() =>
            JsonSerializer.Deserialize<GuideFixture>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "ListPlaceholders", "Fixtures", "dc-guide-import.json")), Json)!;
    }

    internal sealed class GuideLine
    {
        public string Track { get; set; } = string.Empty;

        public int Line { get; set; }

        public ImportEntryDto Entry { get; set; } = new();

        public GuideExpect? Expect { get; set; }
    }

    internal sealed class GuideExpect
    {
        public string Confidence { get; set; } = string.Empty;

        public string? Match { get; set; }
    }

    /// <summary>Seerr answers from the recording; unrecorded lookups are collected (and written for the recorder).</summary>
    private sealed class ReplayImportLookup(GuideFixture fixture) : IImportLookup
    {
        public ConcurrentDictionary<string, bool> Misses { get; } = new(StringComparer.Ordinal);

        public ConcurrentDictionary<string, bool> Used { get; } = new(StringComparer.Ordinal);

        public bool IsConfigured => true;

        public bool CanFindImdbEpisodes => false;

        public void WriteMisses()
        {
            // Recording aids (unset in CI): what to fetch from Seerr next, and what the fixture needs.
            var path = Environment.GetEnvironmentVariable("JE_GUIDE_REPLAY_MISSES");
            if (!string.IsNullOrEmpty(path))
            {
                File.WriteAllLines(path, Misses.Keys.OrderBy(k => k, StringComparer.Ordinal));
            }

            var used = Environment.GetEnvironmentVariable("JE_GUIDE_REPLAY_USED");
            if (!string.IsNullOrEmpty(used))
            {
                File.WriteAllLines(used, Used.Keys.OrderBy(k => k, StringComparer.Ordinal));
            }
        }

        public Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken)
        {
            context.CountCall();
            var key = string.Join(' ', query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
            Used.TryAdd("search\t" + key, true);
            if (!fixture.Searches.TryGetValue(key, out var hits))
            {
                Misses.TryAdd("search\t" + key, true);
                return Task.FromResult(new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, Array.Empty<TitleHit>()));
            }

            return Task.FromResult(new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, hits.Select(Hit).ToList()));
        }

        public Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            context.CountCall();
            Used.TryAdd($"details\t{mediaType}|{tmdbId}", true);
            if (!fixture.Details.TryGetValue(mediaType + "|" + tmdbId, out var d))
            {
                Misses.TryAdd($"details\t{mediaType}|{tmdbId}", true);
                return Task.FromResult(LookupResult<TitleDetails>.Transient);
            }

            var seasons = d[5].EnumerateArray().Select(s => s.EnumerateArray().ToArray())
                .Select(s => new SeasonFacts(s[0].GetInt32(), Int(s[1]), Str(s[2]), Str(s[3]))).ToList();
            var details = new TitleDetails(Hit(d[0].EnumerateArray().ToArray()), Str(d[1]), Int(d[2]), Str(d[3]), d[4].ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null }, seasons);
            return Task.FromResult(new LookupResult<TitleDetails>(LookupStatus.Ok, details));
        }

        public Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
        {
            context.CountCall();
            Used.TryAdd($"season\t{tvTmdbId}|{season}", true);
            if (!fixture.Seasons.TryGetValue(tvTmdbId + "|" + season, out var episodes))
            {
                Misses.TryAdd($"season\t{tvTmdbId}|{season}", true);
                return Task.FromResult(LookupResult<IReadOnlyList<EpisodeFacts>>.Transient);
            }

            return Task.FromResult(new LookupResult<IReadOnlyList<EpisodeFacts>>(LookupStatus.Ok, episodes.Select(e => new EpisodeFacts(e[0].GetInt32(), e[1].GetInt32(), Str(e[2]), Str(e[3]))).ToList()));
        }

        public Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, CancellationToken cancellationToken) =>
            Task.FromResult(LookupResult<ImdbEpisodeFind>.NotFound);

        private static TitleHit Hit(JsonElement[] h) =>
            new(h[0].GetString()!, h[1].GetInt32(), h[2].GetString()!, Str(h[3]), Str(h[4]), null, null, h[5].GetDouble(), h[6].GetInt32());

        private static string? Str(JsonElement e) => e.ValueKind == JsonValueKind.String ? e.GetString() : null;

        private static int? Int(JsonElement e) => e.ValueKind == JsonValueKind.Number ? e.GetInt32() : null;
    }
}
